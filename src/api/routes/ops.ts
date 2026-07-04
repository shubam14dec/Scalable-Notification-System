import type { FastifyInstance } from 'fastify';
import { pool } from '../../db/pool';
import { redis } from '../../shared/redis';
import { queueDepths } from '../../shared/queues';
import { allBreakers } from '../../resilience/circuit-breaker';
import { chEnabled, chQuery, chLogStatsQuery } from '../../analytics/clickhouse';
import { register } from '../../shared/metrics';

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
  app.get('/ops/queues', async () => queueDepths());

  /** Circuit breaker states for every provider seen by this process. */
  app.get('/ops/breakers', async () => allBreakers());

  /** Prometheus scrape endpoint (this API replica). */
  app.get('/metrics', async (_req, reply) => {
    reply.type(register.contentType);
    return register.metrics();
  });

  /** Execution-log stats from ClickHouse (last 24h, grouped by level). */
  app.get('/ops/logs/stats', async (_req, reply) => {
    if (!chEnabled()) {
      return reply.code(503).send({ error: 'clickhouse disabled' });
    }
    try {
      return { source: 'clickhouse', last24h: await chQuery(chLogStatsQuery()) };
    } catch (err) {
      return reply.code(503).send({ error: (err as Error).message });
    }
  });
}
