/**
 * S1.4 — the scrypt work factor was raised from N=16384 to N=65536 (16 MiB ->
 * 64 MiB per hash). Two things must hold for that to be a safe change:
 *
 *  1. Parameters live INSIDE the stored hash string, so every password created
 *     under the old factor keeps verifying. A raise that logs the whole user
 *     table out is not a security improvement.
 *  2. Node's scrypt defaults to a 32 MiB maxmem ceiling and THROWS above it, so
 *     both the hash and the verify path must pass maxmem explicitly. Without it
 *     every login raises "Invalid scrypt params" instead of returning a boolean
 *     — these tests fail loudly rather than quietly weakening anything.
 */
import { randomBytes, scryptSync } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { hashPassword, verifyDummyPassword, verifyPassword } from '../../src/auth/password';

/** A stored hash exactly as the PREVIOUS parameters would have written it. */
function legacyHash(password: string): string {
  const N = 16384;
  const r = 8;
  const p = 1;
  const salt = randomBytes(16);
  const hash = scryptSync(password, salt, 64, { N, r, p });
  return `scrypt:${N}:${r}:${p}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

describe('password hashing', () => {
  test('a fresh hash carries the current parameters and verifies', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(stored.startsWith('scrypt:65536:8:1:')).toBe(true);
    expect(await verifyPassword('correct horse battery staple', stored)).toBe(true);
  });

  test('a wrong password fails against a current hash', async () => {
    const stored = await hashPassword('correct horse battery staple');
    expect(await verifyPassword('Correct horse battery staple', stored)).toBe(false);
  });

  test('a hash produced under the OLD parameters still verifies', async () => {
    const stored = legacyHash('legacy-password-1');
    expect(stored.startsWith('scrypt:16384:8:1:')).toBe(true);
    // Proof the verify path reads N/r/p from the hash rather than the module
    // constants — this is what keeps existing accounts able to log in.
    expect(await verifyPassword('legacy-password-1', stored)).toBe(true);
    expect(await verifyPassword('legacy-password-2', stored)).toBe(false);
  });

  test('a malformed stored value is rejected, not thrown on', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt:1:2:3:aa:bb')).toBe(false);
  });

  // S1.6: a Google-first account has NO password hash. That row reaching the
  // login path is ordinary, not exceptional — it must answer "no", not throw a
  // TypeError the API would serve as a 500.
  test('an absent stored hash is "no password set", not a crash', async () => {
    expect(await verifyPassword('x', null)).toBe(false);
    expect(await verifyPassword('x', undefined)).toBe(false);
    expect(await verifyPassword('x', '')).toBe(false);
  });
});

describe('login timing equalisation', () => {
  // The dummy verify is what stops response latency from answering "is this
  // email registered?" on the login route. It must do real work and always say
  // no; a version that short-circuits would silently restore the oracle.
  test('verifyDummyPassword always returns false', async () => {
    expect(await verifyDummyPassword('anything at all')).toBe(false);
    expect(await verifyDummyPassword('')).toBe(false);
  });

  test('it costs a real scrypt verify rather than returning instantly', async () => {
    const started = process.hrtime.bigint();
    await verifyDummyPassword('some-password');
    const elapsedMs = Number(process.hrtime.bigint() - started) / 1e6;
    // Not a timing measurement of the login route (that would be flaky) — just
    // a floor proving actual key derivation happened. A 64 MiB scrypt takes
    // tens of milliseconds even on fast hardware; an early return takes ~0.
    expect(elapsedMs).toBeGreaterThan(5);
  });
});
