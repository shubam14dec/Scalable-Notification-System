/**
 * REPLY RULES (Phase A7, slice B): the OUTBOUND gate. The topic gate (slice A)
 * decides whether this agent should be answering at all; this one reads what the
 * agent actually wrote, one last time, before it leaves the building.
 *
 * WHY A SECOND GATE. The topic gate is a predicate on the customer's QUESTION,
 * and there are failures it structurally cannot see: an in-lane question whose
 * answer wanders somewhere the operator forbade ("we guarantee your refund"), or
 * a tool result that hands the model a colleague's mobile number and a helpful
 * model that passes it straight along. Both are properties of the REPLY, and the
 * only place to see a reply is after it exists.
 *
 * ZERO LLM CALLS, ZERO LATENCY — the whole reason this is checker-1 word rules
 * and not a moderation model. Every reply of every gated agent runs through this
 * function; it is string work over a few kilobytes, so the gate's cost is
 * indistinguishable from zero and the operator never trades reply speed for it.
 * (The A2b decision, restated: never +2-4s on every reply.)
 *
 * PURE. No I/O, no clock, no database, no config reads. Everything this file
 * needs arrives as an argument, which is what makes it exhaustively testable —
 * and this is a guard whose false negatives are leaks, so exhaustively tested is
 * the bar. The turn path (conversation.processor.ts) owns the consequences:
 * shipping the fallback, the breadcrumb, the ops flag.
 *
 * WHAT THIS GATE IS NOT. It is not a content-safety classifier and must never be
 * described as one. It matches phrases an operator typed and two built-in PII
 * shapes. It cannot catch a paraphrase, and an operator who writes `guarantee`
 * has not thereby blocked "you have my word". That limit is the honest price of
 * a check that costs nothing and cannot be down.
 */
import type { CandidateConfig, ModerationConfig } from './managed-brain';

// ---- public shapes ----------------------------------------------------------

/** A validated, normalized policy — the only form the checker trusts. */
export interface ResolvedModeration {
  /** Non-empty, trimmed, deduped, capped. Original casing kept for reporting. */
  denyPhrases: string[];
  blockPii: boolean;
  /** The canned reply a blocked turn ships instead. Never model freestyle. */
  fallback: string;
}

/**
 * The subscriber's OWN contact details, so the PII rule can tell "here is a
 * stranger's phone number" from "we will text you on your own number".
 */
export interface SubscriberContact {
  email?: string | null;
  phone?: string | null;
}

/**
 * `match` is what actually hit:
 *   phrase — the operator's CONFIGURED phrase (not the text slice). The blocked
 *            text is preserved whole in the breadcrumb, so echoing a slice of it
 *            adds nothing; the phrase names the rule the operator must edit.
 *   pii    — the matched substring exactly as the model wrote it, because there
 *            is no configured value to name and the address itself is the
 *            evidence. It stays in Postgres; see the processor for why it is
 *            deliberately NOT forwarded in the ops alert.
 */
export type ReplyRulesResult =
  | { blocked: false }
  | { blocked: true; rule: 'phrase' | 'pii'; match: string };

// ---- bounds -----------------------------------------------------------------

/**
 * Caps on a stored policy. Slice C's API validates a SUBMITTED policy against
 * the same numbers; these exist because the column is jsonb and the row can hold
 * whatever a migration or a hand-run UPDATE left there. The checker itself
 * handles any array — it just refuses to be made slow or unbounded by one.
 */
export const DENY_PHRASE_LIST_MAX = 100;
export const DENY_PHRASE_MAX = 200;
export const FALLBACK_MAX = 2_000;

// ---- config resolution ------------------------------------------------------

/**
 * Validate the `agents.moderation` jsonb into a policy the gate may act on, or
 * null for "reply rules do not apply to this turn".
 *
 * EVERY CLAUSE IS A REAL GUARD, the same doctrine as resolveTopics:
 *   • a fallback — without it "blocked" has nothing to send, and the gate would
 *     be a mute button rather than a boundary. There is no sentence to invent on
 *     an operator's behalf, so there is no default;
 *   • at least one deny phrase OR blockPii — otherwise the policy matches
 *     nothing, and every reply would pay a scan against the empty set to reach
 *     the same answer it would have reached without the column.
 * A row failing either is not an error to raise at a customer: it is an agent
 * with no reply rules, which is what every agent was before A7.
 */
export function resolveModeration(raw: unknown): ResolvedModeration | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const cfg = raw as Partial<ModerationConfig>;

  const fallback = typeof cfg.fallback === 'string' ? cfg.fallback.trim().slice(0, FALLBACK_MAX) : '';
  if (fallback.length === 0) return null;

  const denyPhrases: string[] = [];
  if (Array.isArray(cfg.denyPhrases)) {
    for (const entry of cfg.denyPhrases) {
      if (typeof entry !== 'string') continue;
      const phrase = entry.trim().slice(0, DENY_PHRASE_MAX);
      if (phrase.length === 0) continue;
      // Dedupe case-INSENSITIVELY: the match is case-insensitive, so "Refund"
      // and "refund" are one rule that would otherwise be scanned twice.
      if (denyPhrases.some((p) => p.toLowerCase() === phrase.toLowerCase())) continue;
      denyPhrases.push(phrase);
      if (denyPhrases.length >= DENY_PHRASE_LIST_MAX) break;
    }
  }
  const blockPii = cfg.blockPii === true;
  if (denyPhrases.length === 0 && !blockPii) return null;

  return { denyPhrases, blockPii, fallback };
}

/**
 * WHICH policy governs this turn — the A7 candidate trichotomy, and it is
 * TOPICS' semantics, not routing's, for the same reason stated once in
 * topicsForTurn: absent = the agent's own rules apply.
 *
 * Moderation changes WHAT MAY SHIP. A pre-save check grading a prompt edit is
 * grading this agent, and if the live rules would replace a scenario's reply
 * with the fallback, the candidate's run has to meet that too — otherwise the
 * check passes an agent that does not exist. Object overrides; null is the only
 * way to say "grade it with the rules off", which is a real thing to ask for.
 */
export function moderationForTurn(
  agentModeration: unknown,
  candidate: CandidateConfig | undefined,
): unknown {
  return candidate && 'moderation' in candidate ? candidate.moderation : agentModeration;
}

// ---- rule 1: deny phrases ---------------------------------------------------

/**
 * SUBSTRING, NOT WORD BOUNDARY, and it is a decision rather than a shortcut.
 *
 * `guarantee` must catch `guaranteed`, `guarantees`, and `guaranteeing` — those
 * are the same promise, and an operator who has to enumerate the inflections of
 * every word will miss one. Word-boundary matching would silently let all three
 * through while looking like it was working, which is the worst property a guard
 * can have.
 *
 * The cost is over-matching on substrings of unrelated words (`cure` inside
 * `secure`, `ass` inside `class`), and it is the right trade HERE because the
 * operator controls the list and can be exact: the fix for an over-broad phrase
 * is a LONGER one — `a cure for` rather than `cure`. A false positive costs one
 * canned reply plus a breadcrumb they can read; a false negative is the thing
 * they turned this on to prevent.
 *
 * Note what is deliberately NOT the escape hatch: padding a phrase with spaces.
 * `resolveModeration` trims, so ` cure ` and `cure` are one rule. Honoring the
 * padding would mean a phrase typed with a stray trailing space in a text box
 * silently stops matching `guarantee.` at the end of a sentence — a safety rule
 * that quietly disarms itself is far worse than one that over-matches, and
 * whitespace is invisible exactly when it matters. Slice C's copy must therefore
 * offer "be more specific", never "add spaces".
 *
 * Case-insensitive on both sides — `Guarantee` at the start of a sentence is the
 * same word, and a rule an operator has to capitalize twice is a rule with a
 * hole in it.
 */
function checkPhrases(text: string, phrases: string[]): ReplyRulesResult {
  const haystack = text.toLowerCase();
  for (const phrase of phrases) {
    if (haystack.includes(phrase.toLowerCase())) return { blocked: true, rule: 'phrase', match: phrase };
  }
  return { blocked: false };
}

// ---- rule 2: PII ------------------------------------------------------------

/**
 * Deliberately ordinary. It is not RFC 5322 (nothing practical is) and it does
 * not try to be: it matches what an email address LOOKS LIKE in prose, which is
 * the only form one appears in inside a support reply.
 */
const EMAIL_RE = /[A-Za-z0-9._%+'-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g;

/**
 * A candidate phone number: a run of digits and phone separators, bounded by
 * non-alphanumerics so digits embedded in an alphanumeric token (a tracking code
 * `1Z999AA10123456784`, a hash, an SKU) are never even considered. The run must
 * begin and end on a digit (or a `+`/`(` marker). Whether a candidate IS a phone
 * number is then decided by `looksLikePhone` below, in code, where the rule can
 * be read and argued with — not inside a regex nobody can review.
 *
 * `,` and `:` are NOT separators: they are what tells `1,234,567.89` and `12:30`
 * apart from a phone number.
 */
const PHONE_CANDIDATE_RE = /(?<![A-Za-z0-9])[+(]?\d[\d\s().-]{4,20}\d(?![A-Za-z0-9])/g;

/** Every digit, in order. */
function digitsOf(s: string): string {
  return s.replace(/\D+/g, '');
}

/**
 * THE FALSE-POSITIVE BOUNDARY, stated exactly, because "conservative" is not a
 * specification and an order number that trips a privacy guard is a support bug.
 *
 * A candidate is a phone number when it carries 7–15 digits (7 = the shortest
 * real local subscriber number, 15 = the E.164 maximum) AND it is arranged in
 * one of four phone SHAPES:
 *
 *   (a) it starts with `+` or `(` — an explicit country/area-code marker that
 *       nothing else in a support reply wears;
 *   (b) it is a single unbroken run of digits (`5551234567`);
 *   (c) it has 10+ digits and every group after the first is 3+ digits
 *       (`555-123-4567`, `020 7946 0958`);
 *   (d) it is exactly 3 digits, a separator, then 4 (`555-1234`) — the classic
 *       local form, and the only reason a 7-digit split shape is admitted.
 *
 * WHAT THIS DELIBERATELY LETS THROUGH (all verified in the unit tests):
 *   `#1042`             — 4 digits, under the floor. The required case.
 *   `1042-2024`         — 8 digits, but 2 groups, no marker, not the 3-4 form:
 *                         a hyphenated invoice/order id is not a phone shape.
 *   `2026-08-24`        — 8 digits, under 10, so (c) cannot admit it; a date is
 *                         not a phone number.
 *   `1,234,567.89`      — `,` is not a separator, so it never forms one run.
 *   `12:30`             — same, for `:`.
 *   `1Z999AA10123456784`— alphanumeric boundary; not a candidate at all.
 *
 * WHAT IT KNOWINGLY OVER-MATCHES: a BARE 7-to-15-digit run that is not a phone
 * number — an order number written `1234567` with no `#` and no separators is
 * indistinguishable from a local phone number by shape alone, and (b) admits it.
 * That is the accepted cost, and the direction is chosen on purpose: `blockPii`
 * is opt-in, a false positive costs one canned fallback plus a breadcrumb the
 * operator can read, and a false negative hands a third party's phone number to
 * a customer. An opt-in privacy guard errs toward blocking.
 */
function looksLikePhone(candidate: string): boolean {
  const digits = digitsOf(candidate);
  if (digits.length < 7 || digits.length > 15) return false;
  const groups = candidate.match(/\d+/g) ?? [];
  if (candidate.startsWith('+') || candidate.startsWith('(')) return true; // (a)
  if (groups.length === 1) return true; // (b)
  if (digits.length >= 10 && groups.slice(1).every((g) => g.length >= 3)) return true; // (c)
  if (groups.length === 2 && groups[0].length === 3 && groups[1].length === 4) return true; // (d)
  return false;
}

/**
 * NORMALIZED comparison against the subscriber's own address. Case and the
 * surrounding punctuation are noise: `Maya@Acme.com` in a reply and
 * `maya@acme.com` on the subscriber row are the same person, and a guard that
 * blocks a reply for naming the recipient's own email is a guard that gets
 * switched off within a day.
 *
 * EXACT address, never the domain. Excluding `@acme.com` wholesale would let
 * `someone-else@acme.com` — a colleague's address, exactly the leak this rule
 * exists for — straight through.
 */
function isOwnEmail(match: string, own: string | null | undefined): boolean {
  if (!own) return false;
  return match.trim().toLowerCase() === own.trim().toLowerCase();
}

/**
 * Phone equality on DIGITS ONLY, because the same number is written six ways
 * (`+1 (555) 123-4567`, `555.123.4567`, `5551234567`) and none of them is more
 * correct than the others.
 *
 * The suffix clause handles the country code, which is the one difference that
 * is genuinely the same number: a subscriber stored as `5551234567` who is told
 * `+1 555 123 4567` is being told their own number. A suffix rule is loose by
 * nature, so it is floored at 7 digits — without that floor a stored `4567`
 * would make every phone number ending in 4567 "their own", which is a hole
 * rather than a convenience.
 */
function isOwnPhone(match: string, own: string | null | undefined): boolean {
  if (!own) return false;
  const a = digitsOf(match);
  const b = digitsOf(own);
  if (a.length === 0 || b.length === 0) return false;
  if (a === b) return true;
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 7 && longer.endsWith(shorter);
}

function checkPii(text: string, own: SubscriberContact): ReplyRulesResult {
  for (const m of text.match(EMAIL_RE) ?? []) {
    if (!isOwnEmail(m, own.email)) return { blocked: true, rule: 'pii', match: m };
  }
  for (const raw of text.match(PHONE_CANDIDATE_RE) ?? []) {
    const candidate = raw.trim();
    if (!looksLikePhone(candidate)) continue;
    if (!isOwnPhone(candidate, own.phone)) return { blocked: true, rule: 'pii', match: candidate };
  }
  return { blocked: false };
}

// ---- the check --------------------------------------------------------------

/**
 * Run the policy over one drafted reply. Deterministic, total, and never throws.
 *
 * PHRASES BEFORE PII, and the order is reported as well as executed: a deny
 * phrase is a rule the operator WROTE, and when both fire, naming theirs is more
 * useful than naming a built-in heuristic they cannot edit. (Blocked is blocked
 * either way — the order only decides which reason is recorded.)
 *
 * An empty or whitespace-only reply passes: there is nothing in it to leak, and
 * the turn path upstream already declines to ship an empty reply.
 */
export function checkReply(
  text: string,
  policy: ResolvedModeration,
  own: SubscriberContact,
): ReplyRulesResult {
  if (text.trim().length === 0) return { blocked: false };
  const phrase = checkPhrases(text, policy.denyPhrases);
  if (phrase.blocked) return phrase;
  if (policy.blockPii) return checkPii(text, own);
  return { blocked: false };
}
