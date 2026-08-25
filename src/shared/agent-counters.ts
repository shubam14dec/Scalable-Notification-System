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

/* ---------------- Phase A8: per-subscriber inbound rate ---------------- */

/**
 * Phase A8 — THE INBOUND TALLY for one (agent, subscriber) pair, in a FIXED
 * window whose length the operator chooses.
 *
 * A fixed window rather than a sliding one, deliberately. A sliding window is
 * more precise at the boundary (a fixed window lets 2×max through across the
 * seam of two adjacent buckets) and costs a sorted set per subscriber, a ZADD
 * and a ZREMRANGEBYSCORE per message, and a memory footprint proportional to
 * traffic rather than to subscribers. This is a circuit breaker for a flood, not
 * a billing meter: the number it has to get right is "is this person hammering
 * us", and 2×max in the worst-aligned minute is still bounded, still cheap, and
 * still stops the flood. One INCR and one EXPIRE, the same shape as every other
 * counter in this file, is worth far more than boundary precision here.
 *
 * `windowMinutes` IS PART OF THE KEY. An operator who retunes 60 → 5 starts a
 * fresh series instead of inheriting an hour-sized bucket's count into a
 * five-minute window and throttling everyone in it for the rest of the hour.
 * Changing the setting means what an operator expects it to mean: from now on.
 */
const RATE_WINDOWS_KEPT = 3;

/** The Redis key holding one subscriber's inbound count for the current window. */
export function subscriberRateKey(
  agentId: string,
  subscriberId: string,
  windowMinutes: number,
  d = new Date(),
): string {
  // Epoch-aligned buckets: floor(now / window). Independent of local time and of
  // when the agent was configured, so two processes always agree on the bucket.
  const bucket = Math.floor(d.getTime() / (windowMinutes * 60_000));
  return `subrate:${agentId}:${subscriberId}:${windowMinutes}:${bucket}`;
}

/**
 * Count one inbound message from this subscriber and return the running total
 * for the current window (including this message). The caller compares it
 * against the configured cap: `total > maxMessages` is over the limit, so
 * exactly `maxMessages` messages pass per window.
 *
 * TTL covers three windows so a bucket self-evicts without a sweep, the same
 * self-eviction property as every counter above.
 */
export async function incrSubscriberInbound(
  agentId: string,
  subscriberId: string,
  windowMinutes: number,
): Promise<number> {
  const key = subscriberRateKey(agentId, subscriberId, windowMinutes);
  const total = await redis.incr(key);
  await redis.expire(key, windowMinutes * 60 * RATE_WINDOWS_KEPT);
  return total;
}

/**
 * Claim the ONCE-PER-WINDOW notice for this (agent, subscriber). Atomic SET NX
 * EX returns true for exactly the first over-limit message of a window and false
 * for every one after it, so a customer who sends two hundred messages into a
 * closed window is told once — not two hundred times.
 *
 * This is the difference between a polite limit and a second flood pointed back
 * at the customer, and it MUST be the atomic claim rather than "notice if
 * total === maxMessages + 1": the conversation worker runs at concurrency 10,
 * and a burst arriving together would otherwise race two workers into two
 * notices. Same doctrine as claimBudgetNotify, at the window's own cadence.
 *
 * Keyed on the SAME window bucket as the counter, so the notice and the
 * suppression begin and end together — a customer who waits out the window gets
 * both a fresh allowance and, if they flood again, a fresh explanation.
 */
export async function claimSubscriberRateNotice(
  agentId: string,
  subscriberId: string,
  windowMinutes: number,
): Promise<boolean> {
  const key = `subrate-notice:${subscriberRateKey(agentId, subscriberId, windowMinutes)}`;
  const res = await redis.set(key, '1', 'EX', windowMinutes * 60 * RATE_WINDOWS_KEPT, 'NX');
  return res === 'OK';
}

/**
 * Count one SUPPRESSED turn for this (agent, subscriber) in the current UTC
 * HOUR, and report the final total for the previous one.
 *
 * Why an hour when the operator configured minutes: this counter exists only to
 * fill the ops alert, and the alert is debounced hourly (see below). A count and
 * an alert cadence in different units would be a number ops has to convert
 * before it means anything — "4 suppressed" reads very differently over five
 * minutes than over sixty, and the alert would not say which.
 *
 * The PREVIOUS hour is the figure worth reading, for exactly the reason spelled
 * out in incrReplyBlockCount: the alert fires on the first suppression of an
 * hour, so its own hour count is always 1 and says nothing. The hour before
 * separates "somebody double-tapped send" from "this subscriber has been
 * hammering the agent since midnight" — which are the two cases ops would take
 * completely different actions on.
 */
export async function incrSubscriberSuppressed(
  agentId: string,
  subscriberId: string,
): Promise<{ thisHour: number; previousHour: number }> {
  const now = new Date();
  const key = (d: Date) => `subrate-suppressed:${agentId}:${subscriberId}:${utcHourStamp(d)}`;
  const thisHour = await redis.incr(key(now));
  await redis.expire(key(now), REPLY_BLOCK_TTL_S);
  const prev = await redis.get(key(new Date(now.getTime() - 60 * 60 * 1000)));
  return { thisHour, previousHour: prev ? Number(prev) : 0 };
}

/**
 * Claim the once-per-UTC-HOUR ops alert for ONE (agent, subscriber) pair.
 *
 * PER SUBSCRIBER, not per agent, and that is the one place this deliberately
 * departs from claimReplyRulesNotify. A reply-rules alert is about the AGENT —
 * it said something it shouldn't have, and which customer heard it is a detail
 * ops looks up. This alert names a specific end user as the source of a flood,
 * so an agent-wide debounce would make the second and third offender of the hour
 * invisible behind the first — and "which customer" is the entire actionable
 * content of the notification.
 *
 * HOURLY rather than per-window, even when the window is five minutes: the
 * window is tuned for the CUSTOMER's experience of being slowed down, while this
 * cadence is tuned for an ops channel staying readable. A one-minute window with
 * per-window alerting would post sixty times an hour about one person. Nothing
 * is lost to the debounce — every window's first suppression writes its own
 * durable `raw.rateLimit` breadcrumb on the conversation, which is the record;
 * the alert is only the nudge to go and read it.
 */
export async function claimSubscriberRateNotify(
  agentId: string,
  subscriberId: string,
): Promise<boolean> {
  const key = `subrate-notified:${agentId}:${subscriberId}:${utcHourStamp()}`;
  const res = await redis.set(key, '1', 'EX', REPLY_BLOCK_TTL_S, 'NX');
  return res === 'OK';
}
