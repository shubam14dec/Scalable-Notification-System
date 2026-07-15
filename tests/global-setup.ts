/**
 * Runs ONCE per vitest invocation, before any test file. Flushes the test
 * Redis db so BullMQ job keys can't accumulate across runs — 10k+ stale
 * bull:* keys were slowing getJob/add enough to trip the plan-card tests'
 * 15s timeouts (the "parallel flakiness" we chased for two phases).
 * Test-scoped db 15 only; the dev fleet's db 0 is never touched. Safe to
 * flush ONCE here (unlike per-file in setup.ts, which would race the
 * suite's own in-flight jobs if file parallelism ever returns).
 */
import { Redis } from 'ioredis';

export default async function globalSetup() {
  const redis = new Redis({
    host: process.env.REDIS_HOST ?? '127.0.0.1',
    port: Number(process.env.REDIS_PORT ?? 6379),
    db: Number(process.env.REDIS_DB ?? 15),
    lazyConnect: true,
  });
  await redis.connect();
  await redis.flushdb();
  await redis.quit();
}
