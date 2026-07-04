import { env } from '../config/env';
import { redis } from '../shared/redis';
import { logger } from '../shared/logger';
import { EXEC_LOG_BUFFER_KEY } from '../core/execution-log';
import { insertExecutionLogs, type ExecLogEntry } from '../db/repositories';
import { chEnabled, chInsertLogs } from '../analytics/clickhouse';

/**
 * Drains the Redis execution-log buffer into Postgres in batches. One
 * multi-row insert per interval instead of one write per pipeline step —
 * this is the async-write pattern that saved Razorpay's database.
 */
export function startLogWriter(): () => Promise<void> {
  let draining = false;

  async function drainOnce(): Promise<number> {
    const items = (await redis.lpop(EXEC_LOG_BUFFER_KEY, env.logFlushBatch)) as
      | string[]
      | null;
    if (!items || items.length === 0) return 0;

    const entries: ExecLogEntry[] = [];
    for (const item of items) {
      try {
        entries.push(JSON.parse(item));
      } catch {
        logger.warn({ item }, 'dropping unparseable execution log entry');
      }
    }

    try {
      await insertExecutionLogs(entries);
    } catch (err) {
      // Postgres hiccup: put the batch back so nothing is lost, retry next tick.
      await redis.rpush(EXEC_LOG_BUFFER_KEY, ...items);
      throw err;
    }

    // Dual-write to ClickHouse (analytics store). Postgres already holds the
    // batch, so a ClickHouse hiccup is a warning, never data loss or a stall.
    if (chEnabled()) {
      try {
        await chInsertLogs(entries);
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'clickhouse log insert failed');
      }
    }
    return items.length;
  }

  const timer = setInterval(() => {
    if (draining) return;
    draining = true;
    drainOnce()
      .catch((err) => logger.error({ err }, 'log writer flush failed'))
      .finally(() => {
        draining = false;
      });
  }, env.logFlushIntervalMs);

  // Returns a stop() that flushes whatever is left before shutdown.
  return async function stop() {
    clearInterval(timer);
    try {
      while ((await drainOnce()) > 0) {
        /* keep draining */
      }
    } catch (err) {
      logger.error({ err }, 'final log flush failed');
    }
  };
}
