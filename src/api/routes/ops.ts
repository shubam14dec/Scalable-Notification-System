import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { redis } from '../../shared/redis';
import { queueDepths } from '../../shared/queues';
import { allBreakers } from '../../resilience/circuit-breaker';
import { chEnabled, chQuery, chLogStatsQuery } from '../../analytics/clickhouse';
import { register } from '../../shared/metrics';
import { authenticate, requireOperator, requireOperatorSeat } from '../auth';
import { tenantMessageStats } from '../../db/repositories';
import { env } from '../../config/env';
import { setPublicUrl } from '../../config/public-url';

/**
 * NOTE ON AUTH ASYMMETRY — four tiers here, deliberately:
 *
 *  - `/health` and `/metrics` stay UNAUTHENTICATED: they are hit by liveness
 *    probes and a Prometheus scraper that carry no credential, and `/metrics`
 *    is not exposed through the public proxy.
 *  - `/ops/queues`, `/ops/breakers` and `/ops/logs/stats` carry
 *    `requireOperatorSeat` (see src/api/auth.ts). Every number they return is
 *    PLATFORM-wide — the shared BullMQ queues, the shared dead-letter queue,
 *    provider breakers, total log volume — so a tenant credential is the wrong
 *    key for them: S1.1 took them off the open internet, and this takes them
 *    off every tenant's dashboard. A dashboard operator (JWT) or an ops script
 *    (`x-operator-token`, or an api key outside production) reads them.
 *  - `GET /v1/ops/tenant-stats` carries plain `authenticate`: it is the
 *    tenant-scoped replacement every tenant's Overview reads, and it can only
 *    ever count the caller's own rows.
 *  - `PUT /v1/ops/public-url` carries `requireOperator` (see src/api/auth.ts):
 *    it writes ONE value shared by every tenant, so in production a tenant
 *    credential is not enough — it takes the `x-operator-token`. The matching
 *    GET keeps plain `authenticate`: reading the base URL is a legitimate
 *    tenant/CLI operation.
 */
export function registerOpsRoutes(app: FastifyInstance) {
  app.get('/health', async (_req, reply) => {
    try {
      await pool.query('select 1');
      await redis.ping();
      return { status: 'ok' };
    } catch (err) {
      return reply.code(503).send({ status: 'down', error: (err as Error).message });
    }
  });

  /**
   * Queue depth per queue — feed this to your autoscaler and operator
   * dashboards. PLATFORM-wide (the queues are shared by every tenant), hence
   * operator-only; a tenant wanting its own pipeline health reads
   * /v1/ops/tenant-stats below.
   */
  app.get('/ops/queues', { preHandler: [requireOperatorSeat] }, async () => queueDepths());

  /** Circuit breaker states for every provider seen by this process. */
  app.get('/ops/breakers', { preHandler: [requireOperatorSeat] }, async () => allBreakers());

  /**
   * This TENANT's pipeline health — the tenant-truth answer to the two
   * questions the Overview used to answer with platform gauges:
   *
   *   inFlight  messages still moving (queued or sending)
   *   failed    messages that terminally failed to reach the recipient
   *
   * Scoped to `req.tenant.id` by construction: there is no parameter that could
   * name another tenant. One grouped, index-only query — see the bucket
   * doc in src/db/repositories.ts for why the status lists are explicit.
   */
  app.get('/v1/ops/tenant-stats', { preHandler: [authenticate] }, async (req) =>
    tenantMessageStats(req.tenant.id),
  );

  /** Prometheus scrape endpoint (this API replica). */
  app.get('/metrics', async (_req, reply) => {
    reply.type(register.contentType);
    return register.metrics();
  });

  /** Execution-log stats from ClickHouse (last 24h, grouped by level). */
  app.get('/ops/logs/stats', { preHandler: [requireOperatorSeat] }, async (_req, reply) => {
    if (!chEnabled()) {
      return reply.code(503).send({ error: 'clickhouse disabled' });
    }
    try {
      return { source: 'clickhouse', last24h: await chQuery(chLogStatsQuery()) };
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });

  /**
   * Rotate the public base URL at runtime (tunnel restart, domain move) — every
   * webhook URL and open-tracking pixel picks it up within ~5s, no restart. The
   * URL must be a bare origin: scheme + host (+ optional port), nothing else.
   *
   * OPERATOR-ONLY (production): the value is global, so one tenant's key must
   * not be able to repoint every other tenant's webhooks. See requireOperator.
   */
  app.put('/v1/ops/public-url', { preHandler: [requireOperator] }, async (req, reply) => {
    const parsed = z.object({ url: z.string() }).safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }

    let u: URL;
    try {
      u = new URL(parsed.data.url);
    } catch {
      return reply.code(400).send({ error: 'invalid url' });
    }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') {
      return reply.code(400).send({ error: 'url must be http or https' });
    }
    if (u.pathname !== '/' && u.pathname !== '') {
      return reply.code(400).send({ error: 'url must not contain a path' });
    }
    if (u.search) {
      return reply.code(400).send({ error: 'url must not contain a query string' });
    }
    if (u.hash) {
      return reply.code(400).send({ error: 'url must not contain a fragment' });
    }

    const stored = await setPublicUrl(parsed.data.url);
    return { url: stored };
  });

  /**
   * The public base URL currently in effect: the runtime value from Redis when
   * set, else the PUBLIC_URL env fallback. `source` names which one you got.
   */
  app.get('/v1/ops/public-url', { preHandler: [authenticate] }, async () => {
    const raw = await redis.get('config:public-url');
    return raw
      ? { url: raw.replace(/\/$/, ''), source: 'runtime' as const }
      : { url: env.publicUrl, source: 'env' as const };
  });
}
