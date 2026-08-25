/**
 * Phase A8 — reading a per-customer message limit, and the counter it drives.
 *
 * Two halves, both pure enough to assert exactly:
 *   1. `resolveSubscriberRate` — which stored rows are a policy at all. The
 *      column is jsonb, so "a row can hold anything" is the premise, not an
 *      edge case, and the interesting decision is that an out-of-bounds row
 *      reads as OFF rather than clamped.
 *   2. the fixed-window key + counter in agent-counters.ts — that buckets roll,
 *      that a rolled bucket starts from zero (this is what "the window resets"
 *      MEANS), and that every bucket carries a TTL so nothing needs sweeping.
 *
 * The counter half talks to the real test Redis (db 15), like the other counter
 * suites: the behavior under test IS Redis' behavior, and a fake would only
 * assert that the fake works.
 */
import { afterAll, describe, expect, test } from 'vitest';
import {
  MAX_MESSAGES_MAX,
  MAX_MESSAGES_MIN,
  NOTICE_MAX,
  WINDOW_MINUTES_MAX,
  WINDOW_MINUTES_MIN,
  resolveSubscriberRate,
} from '../../src/core/subscriber-rate';
import {
  claimSubscriberRateNotice,
  incrSubscriberInbound,
  subscriberRateKey,
} from '../../src/shared/agent-counters';
import { redis } from '../../src/shared/redis';

const NOTICE = "You're sending faster than I can answer — I'll catch up shortly.";
const ok = { maxMessages: 20, windowMinutes: 5, notice: NOTICE };

/** Unique per run so a re-run inside the same window can't inherit a count. */
const uniq = () => `a8u-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const minted: string[] = [];
const agentKey = () => {
  const id = uniq();
  minted.push(id);
  return id;
};

afterAll(async () => {
  try {
    for (const id of minted) {
      const keys = await redis.keys(`*${id}*`);
      if (keys.length > 0) await redis.del(...keys);
    }
  } catch {
    /* best-effort cleanup */
  }
  await redis.quit();
});

// ---- 1. what counts as a policy ---------------------------------------------

describe('A8: resolveSubscriberRate — every clause is a real guard', () => {
  test('a complete, in-range policy resolves', () => {
    expect(resolveSubscriberRate(ok)).toEqual(ok);
  });

  test('the notice is trimmed', () => {
    expect(resolveSubscriberRate({ ...ok, notice: `  ${NOTICE}  ` })?.notice).toBe(NOTICE);
  });

  test('a long notice is capped rather than refused', () => {
    const long = 'x'.repeat(NOTICE_MAX + 500);
    expect(resolveSubscriberRate({ ...ok, notice: long })?.notice).toHaveLength(NOTICE_MAX);
  });

  /**
   * Each field's absence disables the whole thing, because each one is load
   * bearing: a cap with no window is not a rate, a window with no cap is not a
   * limit, and a limit with no notice is a customer talking to a wall — they get
   * silence for a message that LOOKS delivered, so they reasonably send more.
   */
  test.each([
    ['no maxMessages', { windowMinutes: 5, notice: NOTICE }],
    ['no windowMinutes', { maxMessages: 20, notice: NOTICE }],
    ['no notice', { maxMessages: 20, windowMinutes: 5 }],
  ])('%s → off', (_label, cfg) => {
    expect(resolveSubscriberRate(cfg)).toBeNull();
  });

  test('a whitespace-only notice is refused, not accepted as a blank one', () => {
    // A lone space is invisible in a text box. A limit that silently switches off
    // because someone hit the spacebar is the worst property a knob can have —
    // the same call A7 slice C made for `redirect` and `fallback`.
    expect(resolveSubscriberRate({ ...ok, notice: '   ' })).toBeNull();
  });

  test.each([null, undefined, 'nope', 42, [], [ok]])('non-object %p → off', (raw) => {
    expect(resolveSubscriberRate(raw)).toBeNull();
  });

  /**
   * THE INTERESTING DECISION: out of range reads as OFF, never clamped.
   * Clamping maxMessages 100000 → 1000 would start throttling real customers at
   * a threshold the operator never chose and cannot see. Reading it as off is
   * the degrade-never-block doctrine: a malformed row behaves exactly like every
   * pre-A8 agent did.
   */
  test.each([
    ['maxMessages below the floor', { ...ok, maxMessages: MAX_MESSAGES_MIN - 1 }],
    ['maxMessages above the ceiling', { ...ok, maxMessages: MAX_MESSAGES_MAX + 1 }],
    ['windowMinutes below the floor', { ...ok, windowMinutes: WINDOW_MINUTES_MIN - 1 }],
    ['windowMinutes above the ceiling', { ...ok, windowMinutes: WINDOW_MINUTES_MAX + 1 }],
    ['a negative cap', { ...ok, maxMessages: -5 }],
  ])('%s → off, NOT clamped', (_label, cfg) => {
    expect(resolveSubscriberRate(cfg)).toBeNull();
  });

  test('the bounds themselves are inclusive', () => {
    expect(resolveSubscriberRate({ ...ok, maxMessages: MAX_MESSAGES_MIN })).not.toBeNull();
    expect(resolveSubscriberRate({ ...ok, maxMessages: MAX_MESSAGES_MAX })).not.toBeNull();
    expect(resolveSubscriberRate({ ...ok, windowMinutes: WINDOW_MINUTES_MIN })).not.toBeNull();
    expect(resolveSubscriberRate({ ...ok, windowMinutes: WINDOW_MINUTES_MAX })).not.toBeNull();
  });

  test.each([
    ['a fractional cap', { ...ok, maxMessages: 20.5 }],
    ['a numeric string', { ...ok, maxMessages: '20' }],
    ['NaN', { ...ok, windowMinutes: Number.NaN }],
    ['Infinity', { ...ok, windowMinutes: Number.POSITIVE_INFINITY }],
  ])('%s → off (jsonb yields these, and half a message is not a thing)', (_label, cfg) => {
    expect(resolveSubscriberRate(cfg)).toBeNull();
  });
});

// ---- 2. the fixed window ----------------------------------------------------

describe('A8: the fixed-window counter', () => {
  test('the window ROLLS: a later bucket is a different key', () => {
    const t0 = new Date('2026-08-25T10:00:00.000Z');
    const sameWindow = new Date('2026-08-25T10:04:59.000Z');
    const nextWindow = new Date('2026-08-25T10:05:00.000Z');
    const k = (d: Date) => subscriberRateKey('agent-1', 'sub-1', 5, d);

    expect(k(sameWindow)).toBe(k(t0));
    expect(k(nextWindow)).not.toBe(k(t0));
  });

  test('windowMinutes is part of the key, so retuning starts a fresh series', () => {
    // An operator moving 60 → 5 must not inherit an hour-sized bucket's count
    // into a five-minute window and throttle everyone in it for the rest of the
    // hour. "From now on" is what changing a setting should mean.
    const d = new Date('2026-08-25T10:00:00.000Z');
    expect(subscriberRateKey('a', 's', 5, d)).not.toBe(subscriberRateKey('a', 's', 60, d));
  });

  test('the key is per (agent, subscriber): neither shares a count', () => {
    const d = new Date('2026-08-25T10:00:00.000Z');
    expect(subscriberRateKey('a1', 's1', 5, d)).not.toBe(subscriberRateKey('a2', 's1', 5, d));
    expect(subscriberRateKey('a1', 's1', 5, d)).not.toBe(subscriberRateKey('a1', 's2', 5, d));
  });

  test('counts climb within a window, and a rolled bucket starts from zero', async () => {
    const agentId = agentKey();

    expect(await incrSubscriberInbound(agentId, 'sub-1', 5)).toBe(1);
    expect(await incrSubscriberInbound(agentId, 'sub-1', 5)).toBe(2);
    expect(await incrSubscriberInbound(agentId, 'sub-1', 5)).toBe(3);

    // A second subscriber is a separate key, so it starts its own count even
    // while the first is mid-flood.
    expect(await incrSubscriberInbound(agentId, 'sub-2', 5)).toBe(1);

    // THE RESET. In production the current bucket self-evicts on its TTL and the
    // next INCR lands on a key that does not exist yet. Asserted here by reading
    // the NEXT bucket's key directly rather than sleeping out a whole window:
    // the roll is a pure function of the clock (proved above), so the only extra
    // thing worth proving is that the rolled-to key carries no inherited count.
    const next = subscriberRateKey(agentId, 'sub-1', 5, new Date(Date.now() + 5 * 60_000));
    expect(await redis.get(next)).toBeNull();
  });

  test('every bucket carries a TTL, so nothing needs sweeping', async () => {
    const agentId = agentKey();
    await incrSubscriberInbound(agentId, 'sub-1', 5);

    const ttl = await redis.ttl(subscriberRateKey(agentId, 'sub-1', 5));
    // Three windows kept (current + previous + slack), so a bucket outlives its
    // own window but self-evicts long before it could be mistaken for a fresh one.
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(5 * 60 * 3);
  });

  test('the notice claim is won exactly ONCE per window', async () => {
    const agentId = agentKey();

    // Whoever gets there first ships the notice; a flood behind them is silent.
    // This must be the atomic claim rather than "count === max + 1": the worker
    // runs at concurrency 10, and a burst arriving together would otherwise race
    // two workers into two notices for the same window.
    expect(await claimSubscriberRateNotice(agentId, 'sub-1', 5)).toBe(true);
    expect(await claimSubscriberRateNotice(agentId, 'sub-1', 5)).toBe(false);
    expect(await claimSubscriberRateNotice(agentId, 'sub-1', 5)).toBe(false);

    // A different subscriber's notice is its own claim — one person's flood must
    // never consume another person's explanation.
    expect(await claimSubscriberRateNotice(agentId, 'sub-2', 5)).toBe(true);
  });
});
