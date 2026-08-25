/**
 * Phase A8 — PER-CUSTOMER MESSAGE LIMITS: reading the policy.
 *
 * The whole of the decision logic for one flooding end user, kept away from the
 * processor that enforces it for the same reason topic-gate.ts and
 * reply-rules.ts are: the rules are worth reading and testing on their own, and
 * a jsonb column can hold anything, so exactly one function in the codebase gets
 * to say whether a stored row is a policy.
 *
 * WHAT THIS LIMIT IS, precisely, because the neighbours are easy to confuse it
 * with:
 *   - it is NOT the per-agent daily token budget (P22 G2, `max_daily_tokens`).
 *     That one is a circuit breaker for the AGENT: when it trips, the agent goes
 *     quiet for EVERYONE until midnight. Leaning on it as the defense against
 *     one abusive customer means letting that customer mute the agent for every
 *     other customer, which is the failure this phase exists to prevent.
 *   - it is NOT the per-tool hourly cap (P22 G3). That limits what a turn may
 *     DO; this limits how many turns there are.
 *   - it is NOT the tenant API rate limit (api/rate-limit.ts). That protects the
 *     platform from a noisy integrator, per tenant, per second; this protects
 *     one agent's bill from one end user, per subscriber, per configured window.
 *
 * The two together are the honest shape: a budget bounds the worst day, and this
 * bounds any one person's share of it.
 */
import type { SubscriberRateConfig } from './managed-brain';

/** A policy that may actually limit someone — every field present and in range. */
export interface ResolvedSubscriberRate {
  maxMessages: number;
  windowMinutes: number;
  notice: string;
}

// ---- bounds -----------------------------------------------------------------

/**
 * Caps on a stored policy. Slice B's API validates a SUBMITTED policy against
 * these same constants (imported, never retyped — the A7 one-set-of-numbers
 * pattern, so the surface and the enforcement can never drift apart). They exist
 * here rather than only there because the column is jsonb and the row can hold
 * whatever a migration, a hand-run UPDATE, or a future SDK version left in it.
 *
 * The numbers themselves are sanity rails, not product opinions:
 *   • 1..1000 messages — 1 is a real (if brutal) setting an operator may want
 *     for an abusive subscriber; past 1000 in a window the limit stops being a
 *     limit and the day budget is the honest tool.
 *   • 1..1440 minutes — one minute is the tightest burst window worth
 *     expressing, and 1440 is one day, past which the fixed window stops
 *     resembling anything a customer would experience as "slow down".
 *   • the notice shares FALLBACK_MAX's ceiling: it is the same KIND of thing (a
 *     canned sentence an operator writes for a customer to read), and two
 *     different ceilings for two canned sentences would be a number to remember.
 */
export const MAX_MESSAGES_MIN = 1;
export const MAX_MESSAGES_MAX = 1_000;
export const WINDOW_MINUTES_MIN = 1;
export const WINDOW_MINUTES_MAX = 1_440;
export const NOTICE_MAX = 2_000;

/** A finite, whole number inside [min, max] — jsonb yields strings and NaN too. */
function boundedInt(v: unknown, min: number, max: number): number | null {
  if (typeof v !== 'number' || !Number.isInteger(v)) return null;
  if (v < min || v > max) return null;
  return v;
}

// ---- config resolution ------------------------------------------------------

/**
 * Validate the `agents.subscriber_rate` jsonb into a policy the ingress check
 * may act on, or null for "this agent does not limit anyone" — which is every
 * pre-A8 agent and the overwhelming majority of rows.
 *
 * EVERY CLAUSE IS A REAL GUARD, the same doctrine as resolveTopics and
 * resolveModeration:
 *   • maxMessages — without a cap there is no limit, only a window;
 *   • windowMinutes — without a window there is no rate, only a lifetime quota,
 *     which is a different product and not this one;
 *   • notice — without it a throttled customer is talking to a wall. They get
 *     silence for a message that LOOKS delivered (the row lands in the
 *     transcript, by design), so they would reasonably send more. A limit with
 *     no notice is a limit that manufactures the flood it is trying to stop.
 *
 * OUT OF RANGE READS AS OFF, NOT CLAMPED, and that is the one interesting
 * decision here. Clamping `maxMessages: 100000` down to 1000 would start
 * throttling real customers at a number the operator never chose and cannot see
 * — a limiter that silently invents its own threshold is worse than no limiter,
 * because the operator's mental model is now wrong. Reading it as OFF is the
 * degrade-never-block doctrine the gates already follow: the failure mode of a
 * malformed row is the behavior every agent had before A8.
 *
 * A row failing any clause is not an error to raise at a customer. It is an
 * agent with no message limit.
 */
export function resolveSubscriberRate(raw: unknown): ResolvedSubscriberRate | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cfg = raw as Partial<SubscriberRateConfig>;

  const maxMessages = boundedInt(cfg.maxMessages, MAX_MESSAGES_MIN, MAX_MESSAGES_MAX);
  if (maxMessages === null) return null;

  const windowMinutes = boundedInt(cfg.windowMinutes, WINDOW_MINUTES_MIN, WINDOW_MINUTES_MAX);
  if (windowMinutes === null) return null;

  // Trimmed and refused when whitespace-only, exactly like `fallback` and
  // `redirect` (A7 slice C): a lone space is invisible in a text box, and a
  // visible boundary that switches itself off because someone hit the spacebar
  // is the worst property a safety knob can have.
  const notice = typeof cfg.notice === 'string' ? cfg.notice.trim().slice(0, NOTICE_MAX) : '';
  if (notice.length === 0) return null;

  return { maxMessages, windowMinutes, notice };
}
