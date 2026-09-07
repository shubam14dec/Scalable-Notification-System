import { randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keylen: number,
  options: { N: number; r: number; p: number; maxmem: number },
) => Promise<Buffer>;

/**
 * Password hashing with Node's built-in scrypt (memory-hard, no native
 * dependency). Format: scrypt:N:r:p:salt_hex:hash_hex — parameters travel
 * with the hash so they can be raised later without breaking old hashes.
 */
const N = 65536;
const R = 8;
const P = 1;
const KEYLEN = 64;

/**
 * Node's scrypt defaults to a 32 MiB `maxmem` ceiling and THROWS when
 * 128 * N * r exceeds it. Our N=65536, r=8 needs 64 MiB, so every call — hash
 * AND verify — must raise this or logins die outright. It is a ceiling, not an
 * allocation: old hashes replayed at N=16384 still use only their own 16 MiB.
 * Kept generously above the current cost so raising N again is a one-line
 * change; well under the prod box's 8 GB even with concurrent logins, which the
 * 10/min/IP login brake bounds.
 */
const MAXMEM = 128 * 1024 * 1024;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt:${N}:${R}:${P}:${salt.toString('hex')}:${hash.toString('hex')}`;
}

/**
 * `stored` is nullable on purpose (S1.6): a Google-first account has NO
 * password hash at all, and the row reaching this function is the normal way
 * that fact shows up. A null/empty hash is "no password set" — false, not a
 * thrown TypeError that the API would surface as a 500 on an ordinary wrong-
 * door login attempt.
 */
export async function verifyPassword(
  password: string,
  stored: string | null | undefined,
): Promise<boolean> {
  if (!stored) return false;
  const parts = stored.split(':');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  // Parameters come from the STORED hash, never from the constants above, so a
  // password hashed under older/weaker parameters keeps verifying after a raise.
  const [, n, r, p, saltHex, hashHex] = parts;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(password, Buffer.from(saltHex, 'hex'), expected.length, {
    N: Number(n),
    r: Number(r),
    p: Number(p),
    maxmem: MAXMEM,
  });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

/**
 * A hash of a throwaway random password under the CURRENT parameters, computed
 * once at startup. Never matches anything — its only job is to give callers
 * something real to verify against.
 */
const dummyHash = hashPassword(randomBytes(32).toString('hex'));

/**
 * Spend one full password verification and return false.
 *
 * Login calls this when the email is unknown. Without it, a miss returns before
 * scrypt ever runs, so the response comes back in a millisecond instead of the
 * ~100ms a real verify costs — and that gap answers "is this address
 * registered?" just as loudly as a different error message would, defeating the
 * identical 401 body. Verifying against the dummy hash makes both paths cost the
 * same work.
 *
 * This call looks useless and is not. Do not optimize it away.
 */
export async function verifyDummyPassword(password: string): Promise<false> {
  await verifyPassword(password, await dummyHash);
  return false;
}
