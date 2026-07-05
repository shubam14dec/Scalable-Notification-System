import { redis } from '../shared/redis';
import { logger } from '../shared/logger';
import type { ExecLogEntry } from '../db/repositories';

export const EXEC_LOG_BUFFER_KEY = 'exec-log-buffer';

/**
 * Fire-and-forget audit logging. Workers push JSON entries onto a Redis
 * list; the log-writer worker drains it in batches into Postgres. The send
 * path never waits on a DB write for auditing (protecting hot-path DB IOPS),
 * and a logging outage can never take down delivery.
 */
export function logExec(entry: ExecLogEntry): void {
  // RPUSH + LPOP drain = FIFO, so batches insert in true emit order.
  redis
    .rpush(EXEC_LOG_BUFFER_KEY, JSON.stringify({ at: new Date().toISOString(), ...entry }))
    .catch((err) => logger.warn({ err }, 'failed to buffer execution log'));
}
