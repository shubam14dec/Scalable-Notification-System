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

/**
 * Phase A7 slice B — the REPLY-RULES block tally, one bucket per agent per UTC
 * hour. 3h TTL so the CURRENT hour and the PREVIOUS one are both readable (the
 * alert reports the previous window; see below) with an hour of slack.
 */
const REPLY_BLOCK_TTL_S = 3 * 60 * 60;

/** The Redis key holding an agent's reply-rules blocks for one UTC hour. */
export function replyBlockKey(agentId: string, d = new Date()): string {
  return `replyblocks:${agentId}:${utcHourStamp(d)}`;
}

/**
 * Count one blocked reply and report the neighbourhood: the running total for
 * this UTC hour (including this block) and the FINAL total for the previous one.
 *
 * The previous-hour figure is what makes the ops alert worth reading. The alert
 * fires on the first block of an hour, so its own hour count is always 1 and
 * says nothing; the hour BEFORE it separates "an agent said something it
 * shouldn't have, once" from "a broken prompt has been blocking every turn since
 * midnight". Two reads instead of one, on a path that only runs when a reply was
 * already blocked.
 */
export async function incrReplyBlockCount(
  agentId: string,
): Promise<{ thisHour: number; previousHour: number }> {
  const now = new Date();
  const key = replyBlockKey(agentId, now);
  const thisHour = await redis.incr(key);
  await redis.expire(key, REPLY_BLOCK_TTL_S);
  const prev = await redis.get(replyBlockKey(agentId, new Date(now.getTime() - 60 * 60 * 1000)));
  return { thisHour, previousHour: prev ? Number(prev) : 0 };
}

/**
 * Claim the once-per-UTC-HOUR reply-rules ops alert for an agent. Same atomic
 * SET NX EX debounce as `claimBudgetNotify`, at a DELIBERATELY tighter window,
 * and the difference is the point:
 *
 * A budget alert says the same thing all day — the agent is over its cap and
 * will stay over it until midnight — so once a day is the whole story. A blocked
 * reply is a discrete event, and EACH ONE MATTERS: it is a specific thing an
 * agent tried to say to a specific customer. The honest posture is therefore
 * neither of the two easy answers. Alerting per block invites a storm (a broken
 * prompt can block every turn, and an ops channel that cries wolf a thousand
 * times before lunch is an ops channel nobody reads); alerting once a day would
 * make the second incident of the morning invisible.
 *
 * So: one alert per agent per hour, carrying the previous hour's count so a
 * storm is legible from the alert itself rather than only from the transcript.
 * Nothing is lost by the debounce — EVERY block writes its own durable
 * `raw.replyRules` breadcrumb on the conversation, which is the record; the
 * alert is the nudge to go and read it.
 */
export async function claimReplyRulesNotify(agentId: string): Promise<boolean> {
  const key = `replyrules-notified:${agentId}:${utcHourStamp()}`;
  const res = await redis.set(key, '1', 'EX', REPLY_BLOCK_TTL_S, 'NX');
  return res === 'OK';
}
