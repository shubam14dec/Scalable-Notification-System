/**
 * Slice S1.7a — setting, changing, forgetting and resetting a password, end to
 * end against the real app.
 *
 * Everything is real: real routes, real scrypt hashing, real Redis tokens with
 * real TTLs, real Postgres rows, real /auth/login afterwards to prove the new
 * password actually opens the door. The ONE seam is the outbound SMTP hop,
 * swapped at `setPlatformEmailSender` — so the link we assert on is the link a
 * human would have received, not one the test authored.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { pool } from '../../src/db/pool';
import { redis } from '../../src/shared/redis';
import { createGoogleUser } from '../../src/db/accounts.repo';
import { provisionAccount } from '../../src/auth/provisioning';
import { mintSessionTokens } from '../../src/api/routes/auth';
import {
  setPlatformEmailSender,
  type PlatformEmail,
} from '../../src/core/platform-email';

let app: FastifyInstance;
let restoreSender: () => void;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const emailFor = (who: string) => `pw-${who}-${suffix}@itest.local`;

const json = (res: { body: string }) => JSON.parse(res.body);

/** Every platform email the app tried to send, in order. */
const outbox: PlatformEmail[] = [];

/** The reset token out of a link, or '' — the shape the route promises. */
function tokenIn(text: string): string {
  return /[?&]token=([0-9a-f]{64})/.exec(text)?.[1] ?? '';
}

/** How many live reset tokens Redis is holding (db 15 — the suite owns it). */
async function resetTokenCount(): Promise<number> {
  return (await redis.keys('pwreset:*')).length;
}

/** Reset one named per-IP budget — the whole file injects from one "IP". */
async function clearBrake(name: string): Promise<void> {
  const keys = await redis.keys(`${name}-rl:*`);
  if (keys.length) await redis.del(...keys);
}

async function signup(email: string, password: string) {
  // The suite's own signup volume is not what is under test here, and some of
  // these run inside `beforeAll` hooks that fire ahead of the per-test brake
  // reset. Clear the budget explicitly, the way tests/setup.ts does per file.
  await clearBrake('signup');
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'PW Tester', email, password, organizationName: `PW Org ${email}` },
  });
  expect(res.statusCode).toBe(201);
  return json(res);
}

const login = (email: string, password: string) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

const forgot = (email: unknown) =>
  app.inject({ method: 'POST', url: '/auth/forgot', payload: { email } });

const reset = (token: string, newPassword: string) =>
  app.inject({ method: 'POST', url: '/auth/reset', payload: { token, newPassword } });

const setPassword = (accessToken: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: '/auth/password',
    headers: { authorization: `Bearer ${accessToken}` },
    payload,
  });

const me = (accessToken: string) =>
  app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${accessToken}` },
  });

async function userByEmail(email: string) {
  const { rows } = await pool.query('select * from users where email = $1', [email.toLowerCase()]);
  return rows[0] ?? null;
}

/**
 * A Google-first account: `password_hash` NULL, `google_sub` set, provisioned
 * exactly as the Google callback provisions one. Built through the repo rather
 * than by driving the OAuth flow — S1.6's own suite proves that door works;
 * what this file needs is the ROW it produces.
 */
async function createGoogleOnlyUser(email: string) {
  const user = await createGoogleUser(email, 'Google Only', `pw-sub-${suffix}-${email}`);
  expect(user).toBeTruthy();
  await provisionAccount(user!, `Google Org ${email}`);
  return { user: user!, ...mintSessionTokens(app, user!.id) };
}

// ---- lifecycle -------------------------------------------------------------

beforeAll(async () => {
  app = await buildApp();
  restoreSender = setPlatformEmailSender(async (message) => {
    outbox.push(message);
    return true;
  });
});

beforeEach(async () => {
  const keys = await redis.keys('*-rl:*');
  if (keys.length) await redis.del(...keys);
  outbox.length = 0;
});

afterAll(async () => {
  restoreSender();

  for (const pattern of ['pwreset:*', 'pwreset-budget:*']) {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  }

  const { rows: users } = await pool.query('select id from users where email like $1', [
    `pw-%-${suffix}@itest.local`,
  ]);
  const userIds = users.map((u: { id: string }) => u.id);
  if (userIds.length) {
    const { rows: orgs } = await pool.query(
      'select distinct organization_id as id from org_members where user_id = any($1::uuid[])',
      [userIds],
    );
    const orgIds = orgs.map((o: { id: string }) => o.id);
    if (orgIds.length) {
      await pool.query(
        'delete from api_keys where tenant_id in (select id from tenants where organization_id = any($1::uuid[]))',
        [orgIds],
      );
      await pool.query('delete from tenants where organization_id = any($1::uuid[])', [orgIds]);
    }
    await pool.query('delete from org_members where user_id = any($1::uuid[])', [userIds]);
    if (orgIds.length) {
      await pool.query('delete from organizations where id = any($1::uuid[])', [orgIds]);
    }
    await pool.query('delete from users where id = any($1::uuid[])', [userIds]);
  }

  await app.close();
  await redis.quit();
  await pool.end();
});

// ---- /auth/me --------------------------------------------------------------

describe('/auth/me reports whether the account has a password', () => {
  test('a password signup reads hasPassword: true', async () => {
    const email = emailFor('me-yes');
    const session = await signup(email, 'original-pw-1');
    const res = await me(session.accessToken);
    expect(res.statusCode).toBe(200);
    expect(json(res).hasPassword).toBe(true);
  });

  test('a Google-only account reads hasPassword: false', async () => {
    const { accessToken } = await createGoogleOnlyUser(emailFor('me-no'));
    expect(json(await me(accessToken)).hasPassword).toBe(false);
  });
});

// ---- POST /auth/password ---------------------------------------------------

describe('POST /auth/password — a Google-only account setting its first one', () => {
  const email = emailFor('google-set');

  test('needs no current password, and the new one opens the login door', async () => {
    const { accessToken } = await createGoogleOnlyUser(email);
    expect(json(await me(accessToken)).hasPassword).toBe(false);

    // No currentPassword field at all — there is nothing they could send.
    const res = await setPassword(accessToken, { newPassword: 'google-set-pw-1' });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true });

    expect(json(await me(accessToken)).hasPassword).toBe(true);

    const loggedIn = await login(email, 'google-set-pw-1');
    expect(loggedIn.statusCode).toBe(200);
    expect(json(loggedIn).user.email).toBe(email);

    // The Google door is untouched: they now have both.
    expect((await userByEmail(email)).google_sub).toBeTruthy();
  });

  test('a made-up currentPassword is ignored, not a 401', async () => {
    const { accessToken } = await createGoogleOnlyUser(emailFor('google-set-2'));
    const res = await setPassword(accessToken, {
      currentPassword: 'there-was-never-one',
      newPassword: 'google-set-pw-2',
    });
    expect(res.statusCode).toBe(200);
  });
});

describe('POST /auth/password — an account that already has one', () => {
  const email = emailFor('change');
  let accessToken = '';

  beforeAll(async () => {
    accessToken = (await signup(email, 'original-pw-1')).accessToken;
  });

  test('the wrong current password is a 401 and changes nothing', async () => {
    const res = await setPassword(accessToken, {
      currentPassword: 'not-the-current-one',
      newPassword: 'attacker-chosen-pw',
    });
    expect(res.statusCode).toBe(401);
    expect(json(res).error).toBe('current password is incorrect');
    // The original still works, and the attacker's choice does not.
    expect((await login(email, 'original-pw-1')).statusCode).toBe(200);
    expect((await login(email, 'attacker-chosen-pw')).statusCode).toBe(401);
  });

  test('an omitted current password is a 401 too (not an open door)', async () => {
    const res = await setPassword(accessToken, { newPassword: 'no-current-supplied' });
    expect(res.statusCode).toBe(401);
    expect(json(res).error).toBe('current password is incorrect');
  });

  test('a password under 8 characters is refused before anything is written', async () => {
    const res = await setPassword(accessToken, {
      currentPassword: 'original-pw-1',
      newPassword: 'short',
    });
    expect(res.statusCode).toBe(400);
    expect((await login(email, 'original-pw-1')).statusCode).toBe(200);
  });

  test('the right current password swaps them over: new works, old does not', async () => {
    const res = await setPassword(accessToken, {
      currentPassword: 'original-pw-1',
      newPassword: 'changed-pw-2',
    });
    expect(res.statusCode).toBe(200);

    expect((await login(email, 'changed-pw-2')).statusCode).toBe(200);
    expect((await login(email, 'original-pw-1')).statusCode).toBe(401);
  });

  test('an unauthenticated caller cannot reach it at all', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/password',
      payload: { newPassword: 'stranger-chosen-pw' },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---- POST /auth/forgot -----------------------------------------------------

describe('POST /auth/forgot — no account enumeration', () => {
  test('an unknown address is a plain 200 that mints nothing and sends nothing', async () => {
    const before = await resetTokenCount();
    const res = await forgot(emailFor('never-existed'));
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true });
    expect(outbox).toHaveLength(0);
    expect(await resetTokenCount()).toBe(before);
  });

  test('a malformed body gets the same 200 (nothing to learn here either)', async () => {
    const res = await forgot('not-an-email-address');
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true });
    expect(outbox).toHaveLength(0);
  });

  test('a known address gets exactly one email carrying a live token', async () => {
    const email = emailFor('known');
    await signup(email, 'original-pw-1');
    await clearBrake('forgot');

    const res = await forgot(email);
    expect(res.statusCode).toBe(200);
    // Byte-identical to the unknown-address answer above.
    expect(json(res)).toEqual({ ok: true });

    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe(email);
    expect(outbox[0].subject).toContain('password');
    expect(outbox[0].text).toContain('30 minutes');
    expect(outbox[0].text).toContain('once');
    expect(outbox[0].text).toContain('did not request');

    const token = tokenIn(outbox[0].text);
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    // Dev links point at the SPA's origin, not the API's.
    expect(outbox[0].text).toContain(`http://localhost:5173/reset-password?token=${token}`);

    // The token is stored HASHED — the raw value is nowhere in Redis, only its
    // digest, and that digest is what the route will look up.
    const digest = createHash('sha256').update(token).digest('hex');
    expect(await redis.get(`pwreset:${digest}`)).toBeTruthy();
    expect(await redis.get(`pwreset:${token}`)).toBeNull();
    const ttl = await redis.ttl(`pwreset:${digest}`);
    expect(ttl).toBeGreaterThan(1700);
    expect(ttl).toBeLessThanOrEqual(1800);
  });
});

describe('POST /auth/forgot — the per-address mail budget', () => {
  test('the 4th request for one address in an hour sends nothing (and still says 200)', async () => {
    const email = emailFor('bombed');
    await signup(email, 'original-pw-1');

    for (let i = 0; i < 3; i += 1) {
      // The per-IP brake is 3/min and this needs 4 in a row, so the IP budget
      // is cleared each time — the ADDRESS budget is the one under test.
      await clearBrake('forgot');
      expect((await forgot(email)).statusCode).toBe(200);
    }
    expect(outbox).toHaveLength(3);

    await clearBrake('forgot');
    const fourth = await forgot(email);
    expect(fourth.statusCode).toBe(200);
    expect(json(fourth)).toEqual({ ok: true });
    expect(outbox).toHaveLength(3); // no fourth email

    // A DIFFERENT address is unaffected — the budget is per mailbox.
    const bystander = emailFor('bystander');
    await signup(bystander, 'original-pw-1');
    await clearBrake('forgot');
    expect((await forgot(bystander)).statusCode).toBe(200);
    expect(outbox).toHaveLength(4);
    expect(outbox[3].to).toBe(bystander);
  });
});

// ---- POST /auth/reset ------------------------------------------------------

describe('POST /auth/reset — spending the link', () => {
  const email = emailFor('reset');

  async function freshToken(): Promise<string> {
    await clearBrake('forgot');
    outbox.length = 0;
    expect((await forgot(email)).statusCode).toBe(200);
    expect(outbox).toHaveLength(1);
    return tokenIn(outbox[0].text);
  }

  beforeAll(async () => {
    await signup(email, 'original-pw-1');
  });

  test('the captured token sets a new password: the new one works, the old does not', async () => {
    const token = await freshToken();
    const res = await reset(token, 'reset-pw-2');
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true });
    // No session is minted — the user proves the password at the login door.
    expect(json(res).accessToken).toBeUndefined();

    expect((await login(email, 'reset-pw-2')).statusCode).toBe(200);
    expect((await login(email, 'original-pw-1')).statusCode).toBe(401);
  });

  test('the token is single-use: replaying it is a 401', async () => {
    const token = await freshToken();
    expect((await reset(token, 'reset-pw-3')).statusCode).toBe(200);

    const second = await reset(token, 'attacker-pw');
    expect(second.statusCode).toBe(401);
    expect(json(second).error).toBe('reset link expired — request a new one');
    // And the replay changed nothing.
    expect((await login(email, 'reset-pw-3')).statusCode).toBe(200);
    expect((await login(email, 'attacker-pw')).statusCode).toBe(401);
  });

  test('an invented token is a 401', async () => {
    const res = await reset('f'.repeat(64), 'invented-token-pw');
    expect(res.statusCode).toBe(401);
    expect(json(res).error).toBe('reset link expired — request a new one');
  });

  test('a short new password is refused and the token is NOT spent', async () => {
    const token = await freshToken();
    expect((await reset(token, 'short')).statusCode).toBe(400);
    // Still live: a typo in the confirm box must not cost the link.
    expect((await reset(token, 'after-the-typo-pw')).statusCode).toBe(200);
    expect((await login(email, 'after-the-typo-pw')).statusCode).toBe(200);
  });

  test('a reset on a linked account leaves google_sub alone — both doors stay open', async () => {
    const linked = emailFor('linked');
    const { user } = await createGoogleOnlyUser(linked);
    const sub = user.google_sub;
    expect(sub).toBeTruthy();

    await clearBrake('forgot');
    outbox.length = 0;
    expect((await forgot(linked)).statusCode).toBe(200);
    const token = tokenIn(outbox[0].text);

    expect((await reset(token, 'linked-reset-pw')).statusCode).toBe(200);

    const row = await userByEmail(linked);
    expect(row.google_sub).toBe(sub); // untouched
    expect(row.password_hash).toBeTruthy(); // and now they have a password too
    expect((await login(linked, 'linked-reset-pw')).statusCode).toBe(200);
  });
});

// ---- the brakes ------------------------------------------------------------

describe('all three password surfaces are per-IP rate limited', () => {
  test('the 4th /auth/forgot in a minute is a 429', async () => {
    await clearBrake('forgot');
    // Empty bodies: the brake runs BEFORE the handler, so this spends budget
    // without minting tokens or sending mail.
    for (let i = 0; i < 3; i += 1) {
      expect((await app.inject({ method: 'POST', url: '/auth/forgot', payload: {} })).statusCode)
        .toBe(200);
    }
    const over = await app.inject({ method: 'POST', url: '/auth/forgot', payload: {} });
    expect(over.statusCode).toBe(429);
    expect(json(over)).toEqual({ error: 'too many requests' });
    expect(outbox).toHaveLength(0);
  });

  test('the 11th /auth/reset in a minute is a 429', async () => {
    await clearBrake('reset');
    for (let i = 0; i < 10; i += 1) {
      expect((await app.inject({ method: 'POST', url: '/auth/reset', payload: {} })).statusCode)
        .toBe(400);
    }
    expect((await app.inject({ method: 'POST', url: '/auth/reset', payload: {} })).statusCode)
      .toBe(429);
  });

  test('the 11th /auth/password in a minute is a 429', async () => {
    const { accessToken } = await createGoogleOnlyUser(emailFor('brake'));
    await clearBrake('password-change');
    for (let i = 0; i < 10; i += 1) {
      expect((await setPassword(accessToken, {})).statusCode).toBe(400);
    }
    expect((await setPassword(accessToken, {})).statusCode).toBe(429);
  });
});
