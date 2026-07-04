import type { FastifyReply, FastifyRequest } from 'fastify';
import { redis } from '../shared/redis';
import { env } from '../config/env';
import { triggersTotal } from '../shared/metrics';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set when the tenant is over its soft limit: accept, but divert to overflow. */
    overflowDiverted?: boolean;
  }
}

export function rateLimitWindowKey(tenantId: string, atMs = Date.now()): string {
  return `rl:${tenantId}:${Math.floor(atMs / 1000)}`;
}

/**
 * Two-tier per-tenant limiting (burst QoS):
 *
 *   count <= limit           -> normal path
 *   limit < count <= 5xlimit -> ACCEPTED, but diverted to the overflow queue
 *                               (the burst is isolated and trickled, not dropped)
 *   count > 5xlimit          -> 429 (hard cap: someone is misbehaving)
 *
 * Redis-backed, so both tiers hold across any number of API replicas, and
 * the overflow worker consumes the same window when re-injecting.
 */
export async function tenantRateLimit(req: FastifyRequest, reply: FastifyReply) {
  const tenant = req.tenant;
  const windowKey = rateLimitWindowKey(tenant.id);

  const count = await redis.incr(windowKey);
  if (count === 1) {
    await redis.expire(windowKey, 2);
  }

  const softLimit = tenant.rate_limit_per_sec;
  const hardLimit = softLimit * env.hardLimitMultiplier;

  if (count > hardLimit) {
    triggersTotal.inc({ result: 'throttled' });
    return reply
      .code(429)
      .header('Retry-After', '1')
      .send({ error: 'rate limit exceeded', limitPerSec: softLimit });
  }

  req.overflowDiverted = count > softLimit;
}
