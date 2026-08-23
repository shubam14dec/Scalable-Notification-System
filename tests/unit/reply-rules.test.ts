/**
 * Phase A7 slice B — REPLY RULES, the pure half.
 *
 * The checker has no I/O, no clock and no database, so essentially all of its
 * behavior is testable here and belongs here:
 *   1. resolveModeration — a jsonb column is not a type. Which rows are a policy.
 *   2. deny phrases      — case-insensitive SUBSTRING, and why that is the rule.
 *   3. PII               — the two built-in patterns, the subscriber's own
 *                          details excluded, and THE FALSE-POSITIVE BOUNDARY
 *                          pinned case by case (an order number must not be a
 *                          phone number).
 *   4. precedence        — phrases outrank PII; an empty reply is not a leak.
 *
 * The plumbing (fallback shipping, breadcrumb, suppressed buttons, the ops flag,
 * both reply paths, candidate precedence) is proved end to end in
 * tests/integration/reply-rules.test.ts.
 */
import { describe, expect, test } from 'vitest';
import type { CandidateConfig } from '../../src/core/managed-brain';
import {
  checkReply,
  DENY_PHRASE_LIST_MAX,
  DENY_PHRASE_MAX,
  moderationForTurn,
  resolveModeration,
  type ResolvedModeration,
} from '../../src/core/reply-rules';

const FALLBACK = 'Let me get a teammate to follow up on this.';

/** A policy the way an operator would write one. */
const policy = (extra: Record<string, unknown> = {}): ResolvedModeration =>
  resolveModeration({ denyPhrases: ['guarantee'], fallback: FALLBACK, ...extra })!;

/** Nobody's contact details — the default for "this is a stranger's number". */
const NO_CONTACT = {};

describe('resolveModeration — which rows are a policy', () => {
  test('non-objects are not policies', () => {
    for (const raw of [null, undefined, 'moderation', 42, [], [{ fallback: FALLBACK }]]) {
      expect(resolveModeration(raw)).toBeNull();
    }
  });

  test('no fallback = no policy: a rule that blocks without replying is a mute button', () => {
    expect(resolveModeration({ denyPhrases: ['guarantee'] })).toBeNull();
    expect(resolveModeration({ denyPhrases: ['guarantee'], fallback: '   ' })).toBeNull();
    expect(resolveModeration({ blockPii: true, fallback: '' })).toBeNull();
  });

  test('nothing to match = no policy, however good the fallback is', () => {
    expect(resolveModeration({ fallback: FALLBACK })).toBeNull();
    expect(resolveModeration({ fallback: FALLBACK, denyPhrases: [] })).toBeNull();
    expect(resolveModeration({ fallback: FALLBACK, denyPhrases: ['  ', ''] })).toBeNull();
    expect(resolveModeration({ fallback: FALLBACK, blockPii: false })).toBeNull();
  });

  test('either half alone is enough', () => {
    expect(resolveModeration({ fallback: FALLBACK, denyPhrases: ['guarantee'] })).toEqual({
      denyPhrases: ['guarantee'],
      blockPii: false,
      fallback: FALLBACK,
    });
    expect(resolveModeration({ fallback: FALLBACK, blockPii: true })).toEqual({
      denyPhrases: [],
      blockPii: true,
      fallback: FALLBACK,
    });
  });

  test('blockPii is true only when it is literally true', () => {
    // jsonb can hold anything; a truthy string must not switch on a privacy rule.
    expect(resolveModeration({ fallback: FALLBACK, blockPii: 'true' })).toBeNull();
    expect(resolveModeration({ fallback: FALLBACK, blockPii: 1 })).toBeNull();
  });

  test('phrases are trimmed, non-strings dropped, and deduped case-insensitively', () => {
    const r = resolveModeration({
      fallback: FALLBACK,
      denyPhrases: ['  guarantee  ', 'Guarantee', 'GUARANTEE', 42, null, '', '   ', 'refund'],
    })!;
    expect(r.denyPhrases).toEqual(['guarantee', 'refund']);
  });

  test('caps: the list and each phrase are bounded, and the fallback is clipped', () => {
    const many = Array.from({ length: DENY_PHRASE_LIST_MAX + 40 }, (_, i) => `phrase-${i}`);
    const r = resolveModeration({ fallback: 'x'.repeat(5_000), denyPhrases: [...many, 'y'.repeat(900)] })!;
    expect(r.denyPhrases).toHaveLength(DENY_PHRASE_LIST_MAX);
    expect(r.fallback).toHaveLength(2_000);

    const long = resolveModeration({ fallback: FALLBACK, denyPhrases: ['z'.repeat(900)] })!;
    expect(long.denyPhrases[0]).toHaveLength(DENY_PHRASE_MAX);
  });

  test('a capped-away list still leaves a policy when blockPii carries it', () => {
    const r = resolveModeration({ fallback: FALLBACK, blockPii: true, denyPhrases: [123, ''] })!;
    expect(r).toEqual({ denyPhrases: [], blockPii: true, fallback: FALLBACK });
  });
});

describe('deny phrases — case-insensitive SUBSTRING', () => {
  test('the plain hit', () => {
    expect(checkReply('We guarantee a full refund.', policy(), NO_CONTACT)).toEqual({
      blocked: true,
      rule: 'phrase',
      match: 'guarantee',
    });
  });

  test('SUBSTRING, not word boundary — the inflections are the same promise', () => {
    for (const text of [
      'That is guaranteed.',
      'It guarantees delivery.',
      'We are guaranteeing it.',
      'Consider it a guarantee!',
    ]) {
      expect(checkReply(text, policy(), NO_CONTACT)).toMatchObject({ blocked: true, rule: 'phrase' });
    }
  });

  test('case-insensitive on BOTH sides', () => {
    const p = resolveModeration({ fallback: FALLBACK, denyPhrases: ['GuArAnTeE'] })!;
    expect(checkReply('guarantee', p, NO_CONTACT)).toMatchObject({ blocked: true });
    expect(checkReply('Guarantee at the start of a sentence.', policy(), NO_CONTACT)).toMatchObject({
      blocked: true,
    });
  });

  test('the reported match is the CONFIGURED phrase, not the text slice', () => {
    // The blocked text is preserved whole in the breadcrumb; what the operator
    // needs from the match is the rule they have to edit.
    const r = checkReply('Absolutely GUARANTEED.', policy(), NO_CONTACT);
    expect(r).toEqual({ blocked: true, rule: 'phrase', match: 'guarantee' });
  });

  test('no hit passes, and passing is silent', () => {
    expect(checkReply('Your order shipped this morning.', policy(), NO_CONTACT)).toEqual({
      blocked: false,
    });
  });

  test('list order decides which rule is reported', () => {
    const p = resolveModeration({ fallback: FALLBACK, denyPhrases: ['refund', 'guarantee'] })!;
    expect(checkReply('a guarantee and a refund', p, NO_CONTACT)).toMatchObject({ match: 'refund' });
  });

  test('the mitigation for an over-broad phrase is a LONGER phrase', () => {
    const broad = resolveModeration({ fallback: FALLBACK, denyPhrases: ['cure'] })!;
    expect(checkReply('Your data is secure.', broad, NO_CONTACT)).toMatchObject({ blocked: true });
    const exact = resolveModeration({ fallback: FALLBACK, denyPhrases: ['a cure for'] })!;
    expect(checkReply('Your data is secure.', exact, NO_CONTACT)).toEqual({ blocked: false });
    expect(checkReply('It is a cure for that.', exact, NO_CONTACT)).toMatchObject({ blocked: true });
  });

  test('padding with spaces is NOT an escape hatch — phrases are trimmed', () => {
    // A rule that silently stops matching because of an invisible trailing space
    // is worse than one that over-matches. ' guarantee ' is the SAME rule.
    const padded = resolveModeration({ fallback: FALLBACK, denyPhrases: [' guarantee '] })!;
    expect(padded.denyPhrases).toEqual(['guarantee']);
    expect(checkReply('We guarantee.', padded, NO_CONTACT)).toMatchObject({ blocked: true });
  });
});

describe('PII — email addresses', () => {
  const pii = () => resolveModeration({ fallback: FALLBACK, blockPii: true })!;

  test('a stranger’s address blocks, and the match is the address itself', () => {
    expect(checkReply('Write to priya@acme.com about it.', pii(), NO_CONTACT)).toEqual({
      blocked: true,
      rule: 'pii',
      match: 'priya@acme.com',
    });
  });

  test('the subscriber’s OWN address is fine — that is the legitimate case', () => {
    expect(
      checkReply("We'll email you at maya@acme.com.", pii(), { email: 'maya@acme.com' }),
    ).toEqual({ blocked: false });
  });

  test('own-address comparison normalizes case and surrounding whitespace', () => {
    expect(checkReply('Sent to Maya@Acme.COM.', pii(), { email: '  maya@acme.com ' })).toEqual({
      blocked: false,
    });
  });

  test('EXACT address, never the domain — a colleague at the same company still blocks', () => {
    expect(
      checkReply('Ask priya@acme.com instead.', pii(), { email: 'maya@acme.com' }),
    ).toMatchObject({ blocked: true, match: 'priya@acme.com' });
  });

  test('a stranger among own addresses is still found', () => {
    const r = checkReply('Cc maya@acme.com and ops@internal.example.org.', pii(), {
      email: 'maya@acme.com',
    });
    expect(r).toMatchObject({ blocked: true, match: 'ops@internal.example.org' });
  });

  test('a trailing sentence period is not part of the address', () => {
    expect(checkReply('Mail priya@acme.com.', pii(), NO_CONTACT)).toMatchObject({
      match: 'priya@acme.com',
    });
  });

  test('prose that merely mentions email does not match', () => {
    expect(checkReply('I will send you an email shortly.', pii(), NO_CONTACT)).toEqual({
      blocked: false,
    });
  });
});

describe('PII — phone numbers, and the exact false-positive boundary', () => {
  const pii = () => resolveModeration({ fallback: FALLBACK, blockPii: true })!;
  const check = (text: string, own = NO_CONTACT) => checkReply(text, pii(), own);

  test.each([
    ['(a) explicit country code', 'Call +44 20 7946 0958 today.'],
    ['(a) explicit area code', 'Call (555) 123-4567 today.'],
    ['(b) a bare run of digits', 'Call 5551234567 today.'],
    ['(c) 10+ digits, groups of 3+', 'Call 555-123-4567 today.'],
    ['(c) spaced UK local form', 'Call 020 7946 0958 today.'],
    ['(c) dotted', 'Call 555.123.4567 today.'],
    ['(d) the classic local 3-4 form', 'Call 555-1234 today.'],
  ])('%s is a phone number', (_label, text) => {
    expect(check(text)).toMatchObject({ blocked: true, rule: 'pii' });
  });

  test.each([
    ['an order number — THE required case', 'Your order #1042 shipped.'],
    ['a bare short order number', 'Your order 1042 shipped.'],
    ['a hyphenated invoice id', 'Invoice 1042-2024 is attached.'],
    ['a date', 'It shipped on 2026-08-24.'],
    ['a price with thousands separators', 'The total was 1,234,567.89 today.'],
    ['a time', 'We close at 12:30 today.'],
    ['a tracking code with embedded digits', 'Tracking 1Z999AA10123456784 is live.'],
    ['a version string', 'Running 1.2.3.4 now.'],
    ['two short ids in a row', 'Orders 1042 5678 both shipped.'],
    ['an ISBN', 'See ISBN 978-0-13-235088-4 for that.'],
  ])('%s is NOT a phone number', (_label, text) => {
    expect(check(text)).toEqual({ blocked: false });
  });

  test('under the 7-digit floor and over the E.164 ceiling both fall out', () => {
    expect(check('Ref 123456 here.')).toEqual({ blocked: false });
    expect(check('Ref 12345678901234567890 here.')).toEqual({ blocked: false });
  });

  test('the KNOWN over-match, documented and deliberate: a bare 7-digit id', () => {
    // Indistinguishable from a local subscriber number by shape alone. An opt-in
    // privacy guard errs toward blocking; this test exists so the choice is
    // visible rather than discovered in production.
    expect(check('Your reference is 1234567 for this.')).toMatchObject({ blocked: true });
  });

  test('the subscriber’s OWN number is fine, across separator styles', () => {
    expect(check('We will text 555-123-4567.', { phone: '5551234567' })).toEqual({ blocked: false });
    expect(check('We will text 5551234567.', { phone: '+1 (555) 123-4567' })).toEqual({
      blocked: false,
    });
    expect(check('We will text (555) 123.4567.', { phone: '555 123 4567' })).toEqual({
      blocked: false,
    });
  });

  test('country code differences are the same number', () => {
    expect(check('We will text +1 555 123 4567.', { phone: '5551234567' })).toEqual({
      blocked: false,
    });
  });

  test('the suffix rule is floored at 7 digits, so a short stored value excuses nothing', () => {
    expect(check('Call 555-123-4567.', { phone: '4567' })).toMatchObject({ blocked: true });
  });

  test('a colleague’s number still blocks when the subscriber has their own', () => {
    expect(check('Call Priya on 555-987-6543.', { phone: '5551234567' })).toMatchObject({
      blocked: true,
      match: '555-987-6543',
    });
  });

  test('blockPii off means the patterns are never even consulted', () => {
    const phrasesOnly = policy();
    expect(checkReply('Call 555-123-4567 or mail priya@acme.com.', phrasesOnly, NO_CONTACT)).toEqual({
      blocked: false,
    });
  });
});

describe('precedence and edges', () => {
  test('a phrase outranks PII when both fire', () => {
    const both = resolveModeration({
      fallback: FALLBACK,
      denyPhrases: ['guarantee'],
      blockPii: true,
    })!;
    expect(checkReply('I guarantee it — call 555-123-4567.', both, NO_CONTACT)).toEqual({
      blocked: true,
      rule: 'phrase',
      match: 'guarantee',
    });
  });

  test('PII still fires when no phrase matches', () => {
    const both = resolveModeration({
      fallback: FALLBACK,
      denyPhrases: ['guarantee'],
      blockPii: true,
    })!;
    expect(checkReply('Call 555-123-4567.', both, NO_CONTACT)).toMatchObject({ rule: 'pii' });
  });

  test('an empty or whitespace-only reply is not a leak', () => {
    const both = resolveModeration({ fallback: FALLBACK, denyPhrases: ['a'], blockPii: true })!;
    expect(checkReply('', both, NO_CONTACT)).toEqual({ blocked: false });
    expect(checkReply('   \n  ', both, NO_CONTACT)).toEqual({ blocked: false });
  });

  test('the checker is pure: the same inputs give the same answer', () => {
    const p = policy({ blockPii: true });
    const text = 'Call 555-123-4567.';
    expect(checkReply(text, p, NO_CONTACT)).toEqual(checkReply(text, p, NO_CONTACT));
  });
});

describe('moderationForTurn — the A7 candidate trichotomy', () => {
  const agentModeration = { denyPhrases: ['guarantee'], fallback: FALLBACK };

  test('no candidate at all: the agent’s rules', () => {
    expect(moderationForTurn(agentModeration, undefined)).toEqual(agentModeration);
  });

  test('ABSENT: the agent’s own rules apply — topics’ semantics, not routing’s', () => {
    const promptOnly: CandidateConfig = { systemPrompt: 'You are the draft agent.' };
    expect(moderationForTurn(agentModeration, promptOnly)).toEqual(agentModeration);
    expect(resolveModeration(moderationForTurn(agentModeration, promptOnly))).not.toBeNull();
  });

  test('NULL: explicitly graded with the rules off', () => {
    expect(moderationForTurn(agentModeration, { moderation: null })).toBeNull();
    expect(resolveModeration(moderationForTurn(agentModeration, { moderation: null }))).toBeNull();
  });

  test('an OBJECT overrides the agent’s', () => {
    const candidateModeration = { blockPii: true, fallback: 'A teammate will follow up.' };
    expect(moderationForTurn(agentModeration, { moderation: candidateModeration })).toEqual(
      candidateModeration,
    );
  });

  test('absent on an agent with no rules is still no rules', () => {
    expect(resolveModeration(moderationForTurn(null, { systemPrompt: 'x' }))).toBeNull();
  });
});
