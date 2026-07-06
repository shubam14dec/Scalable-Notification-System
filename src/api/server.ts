import { env } from '../config/env';
import { logger } from '../shared/logger';
import { initTracing, shutdownTracing } from '../shared/tracing';
import { redis } from '../shared/redis';
import { closeQueues } from '../shared/queues';
import { pool } from '../db/pool';
import { buildApp } from './app';

async function main() {
  initTracing('notification-api');
  const app = await buildApp();

  await app.listen({ port: env.port, host: '0.0.0.0' });
  logger.info({ port: env.port }, 'api listening');

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'api shutting down');
    await app.close();
    await shutdownTracing();
    await closeQueues();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error(err, 'api failed to start');
  process.exit(1);
});
