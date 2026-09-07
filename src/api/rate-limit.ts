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

/* ------------------------------------------------------------------ *
 * S1.2 — ABUSE BRAKES for the surfaces that have no tenant yet.
 *
 * `tenantRateLimit` above can only run AFTER authentication, so it is
 * useless against the attacks that happen before a caller has an identity:
 * password guessing on /auth/login, signup floods, and the widget's
 * unauthenticated-until-the-handler send route. These brakes key on the
 * client IP (Fastify's `trustProxy` is on, so `req.ip` is the real client
 * behind the tunnel/proxy) and on the subscriber, and they live in Redis
 * so the wall holds across every API replica rather than per process.
 *
 * Fixed one-minute buckets, the same INCR + EXPIRE idiom as every other
 * counter in this codebase: one round trip, self-evicting, and worst case
 * 2x the cap across a bucket seam — bounded, cheap, and it still stops the
 * flood. A sliding window would cost a sorted set per IP for precision
 * nobody needs in a circuit breaker.
 * ------------------------------------------------------------------ */

/** One minute of slack past the bucket, so a key self-evicts without a sweep. */
const MINUTE_BUCKET_TTL_S = 61;

/** The Redis key holding one client's count of `name` for the current minute. */
export function ipRateLimitKey(name: string, ip: string, atMs = Date.now()): string {
  return `${name}-rl:${ip}:${Math.floor(atMs / 60_000)}`;
}

/**
 * Count this request against the (name, ip) minute budget and report whether
 * it is still within it. Exported for the handful of callers that need the
 * verdict inline rather than as a preHandler.
 */
export async function withinIpBudget(
  name: string,
  ip: string,
  maxPerMinute: number,
): Promise<boolean> {
  const key = ipRateLimitKey(name, ip);
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, MINUTE_BUCKET_TTL_S);
  return count <= maxPerMinute;
}

/**
 * A reusable per-IP preHandler: `maxPerMinute` requests per client per minute
 * for the named surface, then 429 until the minute rolls over.
 *
 * `name` namespaces the counter, so two routes sharing a limit still get
 * independent budgets (a user who exhausts login attempts can still refresh).
 * `onLimit` lets a route that answers in something other than JSON — the
 * public handoff paste page renders HTML — keep its own 429 body while still
 * sharing this one counter.
 */
export function ipRateLimit(
  name: string,
  maxPerMinute: number,
  opts: { onLimit?: (req: FastifyRequest, reply: FastifyReply) => unknown } = {},
) {
  return async function ipRateLimitPreHandler(req: FastifyRequest, reply: FastifyReply) {
    if (await withinIpBudget(name, req.ip, maxPerMinute)) return;
    if (opts.onLimit) return opts.onLimit(req, reply);
    return reply.code(429).header('Retry-After', '60').send({ error: 'too many requests' });
  };
}

/**
 * S1.2 — THE WIDGET'S PER-CUSTOMER TURN BUDGET.
 *
 * Every accepted inbound turn enqueues a brain job, and a managed agent's
 * brain job is a paid model call. The per-IP brake above bounds one machine;
 * this bounds one END USER, which is the unit that actually costs money — a
 * scripted loop behind one valid subscriber token would otherwise bill the
 * tenant forever, and NAT means a whole office shares an IP.
 *
 * Deliberately NOT the same thing as `agents.subscriber_rate` (Phase A8):
 * that one is a per-agent PRODUCT knob an operator opts into and tunes, and
 * it is enforced in the conversation worker with a polite in-thread notice.
 * This is a platform floor that always applies, enforced at ingress before
 * anything is written or enqueued. A tenant can set A8 tighter; nobody can
 * set this looser.
 *
 * Counted only for turns we ACCEPT: a duplicate or a rejected request never
 * reaches it, so a retrying client is not punished for our own dedupe.
 *
 * Returns the running count and the seconds left in the bucket, so the 429
 * can tell the widget when to try again.
 */
export const SUBSCRIBER_TURNS_PER_MIN = 20;

export async function countSubscriberTurn(
  tenantId: string,
  subscriberId: string,
): Promise<{ count: number; retryAfterSeconds: number }> {
  const now = Date.now();
  const key = `agent-turns-rl:${tenantId}:${subscriberId}:${Math.floor(now / 60_000)}`;
  const count = await redis.incr(key);
  if (count === 1) await redis.expire(key, MINUTE_BUCKET_TTL_S);
  return { count, retryAfterSeconds: Math.max(1, 60 - Math.floor((now % 60_000) / 1000)) };
}
