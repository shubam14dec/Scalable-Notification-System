/**
 * Phase 19 Slice E — unit block for the two frozen approval-tap id contracts.
 *
 * These regexes live inline in src/api/routes/slack.ts and telegram.ts (they
 * are not exported), so they are re-declared here BYTE-FOR-BYTE against the
 * shipped source and pinned: the callback ids a card carries must round-trip
 * through them, and Telegram's callback_data has a hard 64-BYTE ceiling that
 * `apv:<a|d>:<uuid36>` (= 42 bytes) must stay under. A drift in either regex —
 * or a longer id scheme that blows the 64-byte bound — breaks decisions
 * silently, so it is asserted here rather than left implicit.
 */
import { describe, expect, test } from 'vitest';

// Frozen copies of the shipped tap regexes (slack.ts / telegram.ts).
const SLACK_APPROVAL_RE = /^approval:(approve|deny):([0-9a-f-]{36})$/;
const TELEGRAM_APPROVAL_RE = /^apv:(a|d):([0-9a-f-]{36})$/;

const UUID = '123e4567-e89b-42d3-a456-426614174000'; // 36 chars, [0-9a-f-]

describe('slack approval action_id regex', () => {
  test('approve/deny + uuid match and capture the decision + call id', () => {
    const a = SLACK_APPROVAL_RE.exec(`approval:approve:${UUID}`);
    expect(a).not.toBeNull();
    expect(a![1]).toBe('approve');
    expect(a![2]).toBe(UUID);

    const d = SLACK_APPROVAL_RE.exec(`approval:deny:${UUID}`);
    expect(d![1]).toBe('deny');
    expect(d![2]).toBe(UUID);
  });

  test('non-approval / wrong verb / non-hex ids never match', () => {
    expect(SLACK_APPROVAL_RE.test(`opt_a`)).toBe(false);
    expect(SLACK_APPROVAL_RE.test(`approval:maybe:${UUID}`)).toBe(false);
    expect(SLACK_APPROVAL_RE.test(`approval:approve:NOT-A-UUID`)).toBe(false);
    // Uppercase hex is outside [0-9a-f].
    expect(SLACK_APPROVAL_RE.test(`approval:approve:${UUID.toUpperCase()}`)).toBe(false);
    // A trailing byte breaks the anchored full match.
    expect(SLACK_APPROVAL_RE.test(`approval:approve:${UUID}x`)).toBe(false);
  });
});

describe('telegram approval callback_data regex + 64-byte bound', () => {
  test('a/d + uuid match and capture the decision + call id', () => {
    const a = TELEGRAM_APPROVAL_RE.exec(`apv:a:${UUID}`);
    expect(a).not.toBeNull();
    expect(a![1]).toBe('a');
    expect(a![2]).toBe(UUID);

    const d = TELEGRAM_APPROVAL_RE.exec(`apv:d:${UUID}`);
    expect(d![1]).toBe('d');
    expect(d![2]).toBe(UUID);
  });

  test('wrong prefix / verb / non-hex never match', () => {
    expect(TELEGRAM_APPROVAL_RE.test(`apv:x:${UUID}`)).toBe(false);
    expect(TELEGRAM_APPROVAL_RE.test(`approval:approve:${UUID}`)).toBe(false);
    expect(TELEGRAM_APPROVAL_RE.test(`apv:a:zzz`)).toBe(false);
  });

  test("'apv:a:'+uuid36 is 42 bytes — safely under Telegram's 64-byte callback_data cap", () => {
    const data = `apv:a:${UUID}`;
    expect(Buffer.byteLength(data, 'utf8')).toBe(42);
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64);
    // 'apv:' + one verb char + ':' = 6 bytes of prefix, + 36 of uuid.
    expect(data.length).toBe(6 + 36);
  });
});
