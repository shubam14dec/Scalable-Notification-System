import { Redis } from 'ioredis';
import { env } from '../config/env';

/**
 * BullMQ requires maxRetriesPerRequest: null on its connections.
 * Queues can share one connection; each Worker gets its own (BullMQ
 * duplicates it internally for blocking reads).
 */
export function createRedis(): Redis {
  return new Redis({
    host: env.redisHost,
    port: env.redisPort,
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
  });
}

/** Shared connection for queues, rate limiting, dedupe and the log buffer. */
export const redis = createRedis();
