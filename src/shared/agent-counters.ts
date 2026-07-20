import { redis } from './redis';

/**
 * Phase 22 guardrail counters: tiny, approximate Redis tallies over the shared
 * connection. They are deliberately fast and lossy — Postgres (raw.usage on the
 * transcript row, agent_tool_calls rows) stays the auditable truth; these just
 * answer "should the platform pump the brakes right now?" in O(1) before the
 * expensive path (a model call, a signed tool POST) runs.
 *
 * Two families:
 *  - PER-AGENT DAILY TOKENS (G2): a UTC-day counter of tokens spent, checked
 *    before the model call and bumped after each turn. Key rolls at UTC
 *    midnight; a 48h TTL means yesterday's key self-evicts without a sweep.
 *  - PER-TOOL HOURLY CALLS (G3): a UTC-hour counter of a tool's calls for one
 *    subscriber, incremented on every attempt so an over-cap call rejects
 *    before it executes. 2h TTL, same self-eviction.
 *
 * Approximate by design: a job retry re-runs the (nondeterministic) turn and
 * re-increments, so counts can drift high under retries — acceptable for a
 * circuit breaker, never used where an exact number matters.
 */

/** UTC day TTL — long enough to survive clock skew, short enough to self-evict. */
const DAY_TOKENS_TTL_S = 48 * 60 * 60;
/** UTC hour TTL — one extra hour of slack past the counting window. */
const TOOL_HOUR_TTL_S = 2 * 60 * 60;

const pad = (n: number) => String(n).padStart(2, '0');

/** yyyymmdd in UTC — the daily bucket key. */
function utcDayStamp(d = new Date()): string {
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

/** yyyymmddhh in UTC — the hourly bucket key. */
function utcHourStamp(d = new Date()): string {
  return `${utcDayStamp(d)}${pad(d.getUTCHours())}`;
}

/** The Redis key holding an agent's token spend for the current UTC day. */
export function dayTokenKey(agentId: string): string {
  return `agent:${agentId}:tokens:${utcDayStamp()}`;
}

/**
 * Add `n` tokens to the agent's UTC-day counter (INCRBY), refreshing the 48h
 * TTL each time. Returns the new running total. `n <= 0` is a no-op read.
 */
export async function incrDayTokens(agentId: string, n: number): Promise<number> {
  const key = dayTokenKey(agentId);
  if (n <= 0) return getDayTokens(agentId);
  const total = await redis.incrby(key, n);
  await redis.expire(key, DAY_TOKENS_TTL_S);
  return total;
}

/** Tokens spent by the agent so far this UTC day (0 when the key is absent). */
export async function getDayTokens(agentId: string): Promise<number> {
  const v = await redis.get(dayTokenKey(agentId));
  return v ? Number(v) : 0;
}

/**
 * Increment (and return) a tool's call count for one subscriber in the current
 * UTC hour, refreshing the 2h TTL. Called on EVERY attempt of a rate-capped
 * tool; the caller compares the returned count against the cap.
 */
export async function incrToolHourCount(toolDefId: string, subscriberId: string): Promise<number> {
  const key = `toolcap:${toolDefId}:${subscriberId}:${utcHourStamp()}`;
  const count = await redis.incr(key);
  await redis.expire(key, TOOL_HOUR_TTL_S);
  return count;
}

/**
 * Claim the once-per-UTC-day budget-exhaustion ops alert for an agent (Phase 22
 * G2 debounce). Atomic SET NX EX returns true for exactly the first caller each
 * UTC day per agent — the winner fires the ops notification, everyone else
 * no-ops — so a busy over-budget agent alerts staff once, not once per blocked
 * turn. 48h TTL self-evicts, same as the token counter.
 */
export async function claimBudgetNotify(agentId: string): Promise<boolean> {
  const key = `budget-notified:${agentId}:${utcDayStamp()}`;
  const res = await redis.set(key, '1', 'EX', DAY_TOKENS_TTL_S, 'NX');
  return res === 'OK';
}
