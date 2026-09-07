import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { pool } from '../../db/pool';
import { redis } from '../../shared/redis';
import { queueDepths } from '../../shared/queues';
import { allBreakers } from '../../resilience/circuit-breaker';
import { chEnabled, chQuery, chLogStatsQuery } from '../../analytics/clickhouse';
import { register } from '../../shared/metrics';
import { authenticate, requireOperator } from '../auth';
import { env } from '../../config/env';
import { setPublicUrl } from '../../config/public-url';

/**
 * NOTE ON AUTH ASYMMETRY — three tiers here, deliberately:
 *
 *  - `/health` and `/metrics` stay UNAUTHENTICATED: they are hit by liveness
 *    probes and a Prometheus scraper that carry no credential, and `/metrics`
 *    is not exposed through the public proxy.
 *  - `/ops/queues`, `/ops/breakers` and `/ops/logs/stats` carry `authenticate`.
 *    They were public, which put whole-PLATFORM telemetry (every tenant's
 *    backlog, every provider's breaker state, log volumes) on the open
 *    internet. The dashboard reads them through its authenticated api()
 *    helper; autoscalers and scripts pass an `x-api-key`.
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

  /** Queue depth per queue — feed this to your autoscaler and dashboards. */
  app.get('/ops/queues', { preHandler: [authenticate] }, async () => queueDepths());

  /** Circuit breaker states for every provider seen by this process. */
  app.get('/ops/breakers', { preHandler: [authenticate] }, async () => allBreakers());

  /** Prometheus scrape endpoint (this API replica). */
  app.get('/metrics', async (_req, reply) => {
    reply.type(register.contentType);
    return register.metrics();
  });

  /** Execution-log stats from ClickHouse (last 24h, grouped by level). */
  app.get('/ops/logs/stats', { preHandler: [authenticate] }, async (_req, reply) => {
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
