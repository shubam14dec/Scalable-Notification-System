import { redis } from '../shared/redis';
import { env } from './env';
import { logger } from '../shared/logger';

/**
 * The public base URL is a RUNTIME setting, not a frozen env const, so a tunnel
 * restart or domain move can be rotated with zero downtime — `asyncify dev` (or
 * PUT /v1/ops/public-url) writes the new value to Redis and every webhook URL
 * and open-tracking pixel picks it up. No process restart, no redeploy.
 *
 * Convergence: each process caches the value for up to TTL_MS, so a rotation
 * reaches all API/worker replicas within 5 seconds. The write-through cache in
 * setPublicUrl makes the rotating process itself see the new value instantly.
 *
 * Env fallback: PUBLIC_URL (env.publicUrl) is the value used until the Redis
 * key is set, and the value fallen back to on any Redis error — so a Redis blip
 * degrades to the boot-time URL rather than breaking webhook listing/delivery.
 * The key is set WITHOUT a TTL: a rotation deliberately persists across restarts.
 */
const KEY = 'config:public-url';
const TTL_MS = 5_000;

let cache: { value: string; at: number } | null = null;
// Latched so a persistent Redis outage warns once, not on every hot-path call.
let warned = false;

function stripTrailingSlash(url: string): string {
  return url.replace(/\/$/, '');
}

/**
 * The current public base URL. Serves a fresh (<TTL_MS) cache without touching
 * Redis; otherwise reads the runtime key, falling back to env.publicUrl when it
 * is unset or Redis is unreachable.
 */
export async function getPublicUrl(): Promise<string> {
  if (cache && Date.now() - cache.at < TTL_MS) {
    return cache.value;
  }
  try {
    const raw = await redis.get(KEY);
    const value = raw ? stripTrailingSlash(raw) : env.publicUrl;
    cache = { value, at: Date.now() };
    return value;
  } catch (err) {
    if (!warned) {
      warned = true;
      logger.warn(
        { err: (err as Error).message },
        'public-url: redis read failed, falling back to env.publicUrl',
      );
    }
    return env.publicUrl;
  }
}

/**
 * Rotate the public base URL. Persists to Redis without a TTL (survives
 * restarts) and write-through updates this process's cache so the rotating
 * caller sees it immediately. Returns the normalized value that was stored.
 */
export async function setPublicUrl(url: string): Promise<string> {
  const normalized = stripTrailingSlash(url);
  await redis.set(KEY, normalized);
  cache = { value: normalized, at: Date.now() };
  return normalized;
}

/** Test hook: drop the in-process cache and reset the one-shot warn latch. */
export function clearPublicUrlCache(): void {
  cache = null;
  warned = false;
}
