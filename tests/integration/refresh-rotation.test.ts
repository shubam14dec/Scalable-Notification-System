/**
 * Slice S1.7 — REFRESH-TOKEN ROTATION, REVOCATION AND REAL LOGOUT, end to end
 * against the real app.
 *
 * Nothing here is stubbed: real routes, real HS256 signing, real Postgres
 * ledger rows, real rate-limit brakes. The one thing the tests do that a
 * browser cannot is BACKDATE a timestamp with SQL — `spent_at` 31 seconds ago
 * to step outside the 30-second race grace, and `expires_at` to a day from now
 * to prove the sliding window actually slides. Sleeping for real would make the
 * suite 30 seconds slower and no more truthful.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { env } from '../../src/config/env';
import { pool } from '../../src/db/pool';
import { redis } from '../../src/shared/redis';
import { sealSecret } from '../../src/auth/secret-box';
import { hashPassword } from '../../src/auth/password';
import { createGoogleUser, createUser } from '../../src/db/accounts.repo';
import { provisionAccount } from '../../src/auth/provisioning';
import { legacyJti, mintSessionTokens } from '../../src/api/routes/auth';
import {
  getRefreshToken,
  purgeDeadRefreshTokens,
  type RefreshTokenRow,
} from '../../src/db/refresh-tokens.repo';

let app: FastifyInstance;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const emailFor = (who: string) => `rot-${who}-${suffix}@itest.local`;
const PASSWORD = 'rotation-password-1';

const json = (res: { body: string }) => JSON.parse(res.body);

/** The claims inside a token, read the way any client would read them. */
function claims(token: string): {
  sub: string;
  type: string;
  jti?: string;
  family?: string;
  exp: number;
} {
  return JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
}

/** The ledger row behind a refresh token. */
function rowFor(token: string): Promise<RefreshTokenRow | null> {
  return getRefreshToken(claims(token).jti ?? legacyJti(token));
}

/** Reset one named per-IP budget — the whole file injects from one "IP". */
async function clearBrake(name: string): Promise<void> {
  const keys = await redis.keys(`${name}-rl:*`);
  if (keys.length) await redis.del(...keys);
}

// ---- the doors -------------------------------------------------------------

async function signup(email: string) {
  await clearBrake('signup');
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Rotation Tester',
      email,
      password: PASSWORD,
      organizationName: `Rotation Org ${email}`,
    },
  });
  expect(res.statusCode).toBe(201);
  return json(res) as { accessToken: string; refreshToken: string };
}

async function login(email: string) {
  await clearBrake('login');
  const res = await app.inject({
    method: 'POST',
    url: '/auth/login',
    payload: { email, password: PASSWORD },
  });
  expect(res.statusCode).toBe(200);
  return json(res) as { accessToken: string; refreshToken: string };
}

const refresh = (refreshToken: unknown) =>
  app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

const logout = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/auth/logout', payload });

const logoutAll = (accessToken: string) =>
  app.inject({
    method: 'POST',
    url: '/auth/logout-all',
    headers: { authorization: `Bearer ${accessToken}` },
  });

const me = (accessToken: string) =>
  app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${accessToken}` },
  });

/** A successful rotation, asserted and unwrapped. */
async function rotate(refreshToken: string) {
  const res = await refresh(refreshToken);
  expect(res.statusCode).toBe(200);
  const body = json(res) as { accessToken: string; refreshToken: string };
  expect(body.accessToken).toBeTruthy();
  expect(body.refreshToken).toBeTruthy();
  return body;
}

// ---- the SQL a browser cannot do -------------------------------------------

/** Push a spent token's `spent_at` back past the 30-second race grace. */
async function ageTheSpend(token: string, seconds: number): Promise<void> {
  const { rowCount } = await pool.query(
    `update refresh_tokens set spent_at = now() - ($2 || ' seconds')::interval where jti = $1`,
    [claims(token).jti ?? legacyJti(token), String(seconds)],
  );
  expect(rowCount).toBe(1);
}

// ---- lifecycle -------------------------------------------------------------

beforeAll(async () => {
  app = await buildApp();
});

beforeEach(async () => {
  const keys = await redis.keys('*-rl:*');
  if (keys.length) await redis.del(...keys);
});

afterAll(async () => {
  await app.close();
});

// ---------------------------------------------------------------------------

describe('1. rotation', () => {
  test('a refresh returns a NEW refresh token, not the one it was given', async () => {
    const session = await login(await userWithPassword('rotate'));

    const rotated = await rotate(session.refreshToken);

    // The whole point: the old client behaviour (keep your refresh token
    // forever) is now a bug, so the response has to carry the successor.
    expect(rotated.refreshToken).not.toBe(session.refreshToken);
    // (Deliberately NOT asserted about the access token: its claims are
    // {sub, type, iat, exp} and nothing else, so two minted in the same second
    // are byte-identical. That is correct — an access token is a statement
    // about a user and a minute, not an identity of its own.)

    // Same session, new hop: the family is inherited, the jti is not.
    expect(claims(rotated.refreshToken).family).toBe(claims(session.refreshToken).family);
    expect(claims(rotated.refreshToken).jti).not.toBe(claims(session.refreshToken).jti);

    // And the ledger agrees: the predecessor is spent, the successor is live.
    expect((await rowFor(session.refreshToken))!.spent_at).not.toBeNull();
    expect((await rowFor(rotated.refreshToken))!.spent_at).toBeNull();
  });

  test('the fresh access token still opens a protected route', async () => {
    const email = await userWithPassword('access');
    const session = await login(email);
    const rotated = await rotate(session.refreshToken);

    const res = await me(rotated.accessToken);
    expect(res.statusCode).toBe(200);
    expect(json(res).user.email).toBe(email);

    // Untouched by all of this: access tokens carry no jti and cost no lookup.
    expect(claims(rotated.accessToken).jti).toBeUndefined();
    expect(claims(rotated.accessToken).type).toBe('access');
  });

  test('the window SLIDES — a rotation buys a full life, not the remainder', async () => {
    const session = await login(await userWithPassword('sliding'));

    // Stand the session near the end of its seven days. (Real clocks would
    // take a week to produce this; the property under test is what the
    // SUCCESSOR gets, and that is decided at rotation time.)
    await pool.query(
      `update refresh_tokens set expires_at = now() + interval '1 day' where jti = $1`,
      [claims(session.refreshToken).jti],
    );

    const rotated = await rotate(session.refreshToken);

    const before = new Date((await rowFor(session.refreshToken))!.expires_at).getTime();
    const after = new Date((await rowFor(rotated.refreshToken))!.expires_at).getTime();
    expect(after).toBeGreaterThan(before);
    // Measured from the rotation, not inherited: ~7 days out, not ~1.
    expect(after - Date.now()).toBeGreaterThan(6 * 24 * 3600 * 1000);
  });

  test('a garbage, an expired and a wrong-type token all get the same 401', async () => {
    const session = await login(await userWithPassword('garbage'));

    for (const token of [
      'not-a-jwt',
      // Correctly signed by us, but it is an ACCESS token.
      session.accessToken,
      // Correctly signed, right type, already dead.
      app.jwt.sign({ sub: claims(session.refreshToken).sub, type: 'refresh' }, { expiresIn: '-1s' }),
    ]) {
      const res = await refresh(token);
      expect(res.statusCode).toBe(401);
      expect(json(res)).toEqual({ error: 'invalid refresh token' });
    }

    // None of that touched the live session.
    await rotate(session.refreshToken);
  });
});

describe('2. reuse: the theft alarm and the race grace', () => {
  test('reuse AFTER the grace window kills the whole family', async () => {
    const session = await login(await userWithPassword('theft'));
    const successor = await rotate(session.refreshToken);

    // Half a minute later, somebody presents the spent token. There is no
    // innocent reading left: its successor has been in use the whole time.
    await ageTheSpend(session.refreshToken, 31);
    const replay = await refresh(session.refreshToken);
    expect(replay.statusCode).toBe(401);
    expect(json(replay)).toEqual({ error: 'invalid refresh token' });

    // The SUCCESSOR — a token nobody has misused — dies with the family. That
    // is the trade: we cannot tell the victim from the thief, so the session
    // ends and the real user signs in again.
    expect((await rowFor(successor.refreshToken))!.revoked_at).not.toBeNull();
    expect((await refresh(successor.refreshToken)).statusCode).toBe(401);
  });

  test('reuse INSIDE the grace window is refused but rings no alarm', async () => {
    const session = await login(await userWithPassword('race'));
    const successor = await rotate(session.refreshToken);

    // The two-tab race: tab B presents the token tab A spent milliseconds ago.
    const raced = await refresh(session.refreshToken);
    expect(raced.statusCode).toBe(401);

    // The family SURVIVES — this is the false-positive rotation is famous for,
    // and the whole reason REUSE_GRACE_MS exists.
    expect((await rowFor(successor.refreshToken))!.revoked_at).toBeNull();
    // And the winning tab's token is still good, so the browser recovers by
    // reading what its sibling stored (see `tryRefresh` in the dashboard).
    await rotate(successor.refreshToken);
  });

  test('the alarm revokes ONLY the reused family, not the account', async () => {
    const email = await userWithPassword('blast');
    const laptop = await login(email);
    const phone = await login(email);

    const laptopNext = await rotate(laptop.refreshToken);
    await ageTheSpend(laptop.refreshToken, 31);
    expect((await refresh(laptop.refreshToken)).statusCode).toBe(401);

    // The laptop's session is gone...
    expect((await refresh(laptopNext.refreshToken)).statusCode).toBe(401);
    // ...and the phone, a different sign-in and therefore a different family,
    // never noticed.
    await rotate(phone.refreshToken);
  });
});

describe('3. logout', () => {
  test('logout revokes the family, so the CURRENT token stops working too', async () => {
    const session = await login(await userWithPassword('logout'));
    // The browser has rotated a couple of times before the person presses
    // Log out, so the token it holds is not the one it signed in with.
    const hop2 = await rotate(session.refreshToken);
    const current = await rotate(hop2.refreshToken);

    const res = await logout({ refreshToken: current.refreshToken });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true });

    expect((await refresh(current.refreshToken)).statusCode).toBe(401);
    // Every hop of the chain, including the ones the browser has moved past —
    // a copy taken three rotations ago is dead as well.
    expect((await rowFor(session.refreshToken))!.revoked_at).not.toBeNull();
  });

  test('logout is 200 for anything at all — it must never fail visibly', async () => {
    for (const payload of [
      { refreshToken: 'not-a-jwt-at-all' },
      { refreshToken: app.jwt.sign({ sub: 'nobody', type: 'refresh' }, { expiresIn: '-1s' }) },
      {},
      { refreshToken: '' },
      { refreshToken: 42 },
    ]) {
      const res = await logout(payload);
      expect(res.statusCode).toBe(200);
      expect(json(res)).toEqual({ ok: true });
    }
  });

  test('logout needs no access token — a dead session can still be ended', async () => {
    const session = await login(await userWithPassword('noaccess'));
    // No authorization header anywhere in this flow; possession of the refresh
    // token IS the credential, which is what makes an expired-access-token
    // session closable at all.
    expect((await logout({ refreshToken: session.refreshToken })).statusCode).toBe(200);
    expect((await refresh(session.refreshToken)).statusCode).toBe(401);
  });
});

describe('4. logout everywhere', () => {
  test('revokes every live session of the account and reports how many', async () => {
    // Built through the repo rather than /auth/signup, because signup hands out
    // a session of its own and the number this endpoint returns is shown to a
    // human — the count has to be exactly the sign-ins this test made.
    const email = await userWithPassword('all');
    const laptop = await login(email);
    const phone = await login(email);

    const res = await logoutAll(laptop.accessToken);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ revoked: 2 });

    expect((await refresh(laptop.refreshToken)).statusCode).toBe(401);
    expect((await refresh(phone.refreshToken)).statusCode).toBe(401);

    // Idempotent, and honest about it: nothing live is left to revoke.
    const again = await logoutAll(laptop.accessToken);
    expect(json(again)).toEqual({ revoked: 0 });
  });

  test('counts LIVE tokens, not the spent trail behind them', async () => {
    const email = await userWithPassword('trail');
    const session = await login(email);
    const hop2 = await rotate(session.refreshToken);
    const hop3 = await rotate(hop2.refreshToken);

    // Three ledger rows, ONE session.
    const res = await logoutAll(hop3.accessToken);
    expect(json(res)).toEqual({ revoked: 1 });
  });

  test('requires an access token — a refresh token is not account-wide proof', async () => {
    const session = await login(await userWithPassword('gate'));
    expect((await logoutAll(session.refreshToken)).statusCode).toBe(401);
    expect(
      (await app.inject({ method: 'POST', url: '/auth/logout-all' })).statusCode,
    ).toBe(401);
    // Still signed in.
    await rotate(session.refreshToken);
  });
});

describe('5. the other sign-in doors mint the same thing', () => {
  test('signup sessions rotate', async () => {
    const session = await signup(emailFor('signup'));
    expect(claims(session.refreshToken).jti).toBeTruthy();
    const rotated = await rotate(session.refreshToken);
    expect(rotated.refreshToken).not.toBe(session.refreshToken);
  });

  test('a Google redeem session rotates identically', async () => {
    // S1.6's own suite proves the OAuth dance; what this needs is the SESSION
    // that dance ends in. The redeem route wants two things — the feature
    // configured, and a sealed one-time code in Redis — so the test provides
    // exactly those and drives the real endpoint.
    const original = { ...env.google };
    env.google.clientId = 'rotation-itest-client.apps.googleusercontent.com';
    env.google.clientSecret = 'rotation-itest-secret';
    try {
      const email = emailFor('google');
      const user = await createGoogleUser(email, 'Rotation Google', `rot-sub-${suffix}`);
      expect(user).toBeTruthy();
      await provisionAccount(user!, `Rotation Google Org ${email}`);

      const code = `rot-code-${suffix}`;
      // The key shape and the sealed payload are google-auth.ts's own.
      await redis.set(
        `google-login:${code}`,
        sealSecret(JSON.stringify({ userId: user!.id })),
        'EX',
        300,
      );

      const res = await app.inject({
        method: 'POST',
        url: '/auth/google/redeem',
        payload: { code },
      });
      expect(res.statusCode).toBe(200);
      const session = json(res) as { accessToken: string; refreshToken: string };

      expect(claims(session.refreshToken).jti).toBeTruthy();
      expect((await rowFor(session.refreshToken))!.user_id).toBe(user!.id);
      const rotated = await rotate(session.refreshToken);
      expect(rotated.refreshToken).not.toBe(session.refreshToken);
    } finally {
      Object.assign(env.google, original);
    }
  });
});

describe('6. grandfathering pre-S1.7 tokens', () => {
  /** A refresh token exactly as this app signed them before the ledger existed. */
  const legacyTokenFor = (userId: string) =>
    app.jwt.sign({ sub: userId, type: 'refresh' }, { expiresIn: env.refreshTokenTtl });

  test('a token with no jti is honoured once, adopted, and rotated', async () => {
    const email = await userWithPassword('legacy');
    const { rows } = await pool.query('select id from users where email = $1', [email]);
    const userId = rows[0].id as string;

    const legacy = legacyTokenFor(userId);
    expect(claims(legacy).jti).toBeUndefined();

    // NOBODY is logged out by the deploy: the session keeps working.
    const rotated = await rotate(legacy);
    expect(claims(rotated.refreshToken).jti).toBeTruthy();

    // It was adopted into the ledger under a handle derived from itself, and
    // that row is now spent — which is what makes the adoption single-use.
    const adopted = await getRefreshToken(legacyJti(legacy));
    expect(adopted).toBeTruthy();
    expect(adopted!.user_id).toBe(userId);
    expect(adopted!.family).toBe(legacyJti(legacy));
    expect(adopted!.spent_at).not.toBeNull();
    // Its expiry is the token's OWN exp — adoption must not extend a life the
    // signer already fixed.
    expect(Math.floor(new Date(adopted!.expires_at).getTime() / 1000)).toBe(claims(legacy).exp);
  });

  test('and it is SINGLE-use — the naive grandfather would be a session minter', async () => {
    const email = await userWithPassword('legacy2');
    const { rows } = await pool.query('select id from users where email = $1', [email]);
    const legacy = legacyTokenFor(rows[0].id as string);

    await rotate(legacy);
    expect((await refresh(legacy)).statusCode).toBe(401);

    // Past the grace window it is judged like any other reuse: the family dies.
    await ageTheSpend(legacy, 31);
    expect((await refresh(legacy)).statusCode).toBe(401);
    expect((await getRefreshToken(legacyJti(legacy)))!.revoked_at).not.toBeNull();
  });

  test('a legacy token for a DELETED account is a 401, not a 500', async () => {
    const email = await userWithPassword('legacy4');
    const { rows } = await pool.query('select id from users where email = $1', [email]);
    const legacy = legacyTokenFor(rows[0].id as string);
    await pool.query('delete from users where email = $1', [email]);

    // The adoption insert hits the users(id) foreign key. A dead account is a
    // dead token, and the caller must not be able to tell it caused an error.
    const res = await refresh(legacy);
    expect(res.statusCode).toBe(401);
    expect(json(res)).toEqual({ error: 'invalid refresh token' });
  });

  test('logout ends a legacy session too', async () => {
    const email = await userWithPassword('legacy3');
    const { rows } = await pool.query('select id from users where email = $1', [email]);
    const legacy = legacyTokenFor(rows[0].id as string);

    const rotated = await rotate(legacy);
    // The logout body carries the LEGACY token (an old tab's localStorage), and
    // it still has to reach the family its adoption created.
    expect((await logout({ refreshToken: legacy })).statusCode).toBe(200);
    expect((await refresh(rotated.refreshToken)).statusCode).toBe(401);
  });
});

describe('7. ledger hygiene', () => {
  test('the sweep purges rows 30 days past expiry and nothing newer', async () => {
    const session = await login(await userWithPassword('purge'));
    const live = claims(session.refreshToken).jti!;

    // Two dead rows the sweep must collect (one spent, one merely expired) and
    // one three weeks dead, which it must leave alone.
    const userId = (await getRefreshToken(live))!.user_id;
    const stale = await mintSessionTokens(app, userId);
    const staleJti = claims(stale.refreshToken).jti!;
    await pool.query(
      `update refresh_tokens set expires_at = now() - interval '31 days', spent_at = now() - interval '31 days'
        where jti = $1`,
      [staleJti],
    );
    const recent = await mintSessionTokens(app, userId);
    const recentJti = claims(recent.refreshToken).jti!;
    await pool.query(
      `update refresh_tokens set expires_at = now() - interval '21 days' where jti = $1`,
      [recentJti],
    );

    await purgeDeadRefreshTokens();

    expect(await getRefreshToken(staleJti)).toBeNull();
    expect(await getRefreshToken(recentJti)).toBeTruthy();
    expect(await getRefreshToken(live)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

/**
 * A password account built through the repos rather than /auth/signup.
 *
 * Signup mints a session of its own, and several tests here assert an exact
 * count of live sessions — so an account that starts with ZERO of them is the
 * only way those counts can mean what they say. (The signup door's own minting
 * is covered in section 5.)
 */
async function userWithPassword(who: string): Promise<string> {
  const email = emailFor(who);
  const user = await createUser(email, `Rotation ${who}`, await hashPassword(PASSWORD));
  expect(user).toBeTruthy();
  return email;
}
