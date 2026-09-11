/**
 * Slice B1 — the beta gate's DOOR, end to end against the real app: what
 * happens at /auth/signup and at the Google callback while SIGNUP_MODE=invite.
 *
 * Every invite here is minted the way a real one is — someone asks, an operator
 * approves, and the code is read out of the email that was actually sent — so
 * these tests exercise the same bytes an invited person would paste. The two
 * seams are the SMTP hop (`setPlatformEmailSender`) and Google's token endpoint
 * (`globalThis.fetch`, the idiom S1.6's suite uses).
 *
 * `env.signupMode` is flipped for this file and restored in afterAll: the OPEN
 * mode's behavior is covered by the existing signup tests, which must stay
 * untouched and green.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { env } from '../../src/config/env';
import { pool } from '../../src/db/pool';
import { redis } from '../../src/shared/redis';
import { setPlatformEmailSender, type PlatformEmail } from '../../src/core/platform-email';

const CLIENT_ID = 'invite-itest-client.apps.googleusercontent.com';
const CLIENT_SECRET = 'invite-itest-secret';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

const INVITE_REQUIRED = 'a valid invite for this email is required';

let app: FastifyInstance;
let restoreSender: () => void;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const emailFor = (who: string) => `inv-${who}-${suffix}@itest.local`;
const OPERATOR = `inv-op-${suffix}@itest.local`;

const originalMode = env.signupMode;
const originalOperators = [...env.operatorEmails];
const originalGoogle = { ...env.google };
const originalFetch = globalThis.fetch;

const json = (res: { body: string }) => JSON.parse(res.body);
const outbox: PlatformEmail[] = [];

let operatorToken = '';

// ---- the stubbed Google token endpoint (verbatim from the S1.6 suite) ------

const google = { idToken: '' as string, status: 200 };

function stubGoogleTokenEndpoint(): void {
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (!url.startsWith(TOKEN_ENDPOINT)) {
      return (originalFetch as (i: unknown, x?: unknown) => Promise<Response>)(input, init);
    }
    if (google.status !== 200) {
      return { ok: false, status: google.status, json: async () => ({ error: 'invalid_grant' }) };
    }
    return { ok: true, status: 200, json: async () => ({ id_token: google.idToken }) };
  }) as unknown as typeof fetch;
}

function makeIdToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', kid: 'itest' })}.${b64(claims)}.signature-is-never-verified`;
}

function claimsFor(email: string, sub: string): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub,
    email,
    email_verified: true,
    name: 'Grace Hopper',
  };
}

/** Drive a whole Google sign-in and return the callback's response. */
async function runGoogleCallback(email: string, sub: string) {
  const start = await app.inject({ method: 'GET', url: '/auth/google' });
  const cookie = String(start.headers['set-cookie']).split(';')[0];
  const state = new URL(String(start.headers.location)).searchParams.get('state') ?? '';
  google.idToken = makeIdToken(claimsFor(email, sub));
  google.status = 200;
  return app.inject({
    method: 'GET',
    url: `/auth/google/callback?code=auth-code-1&state=${state}`,
    headers: { cookie },
  });
}

// ---- driving the gate ------------------------------------------------------

async function clearBrake(name: string): Promise<void> {
  const keys = await redis.keys(`${name}-rl:*`);
  if (keys.length) await redis.del(...keys);
}

const signup = (payload: Record<string, unknown>) =>
  app.inject({ method: 'POST', url: '/auth/signup', payload });

async function signupWith(email: string, inviteCode?: string) {
  await clearBrake('signup');
  return signup({
    name: 'Invited Person',
    email,
    password: 'invite-signup-pw-1',
    organizationName: `Invite Org ${email}`,
    ...(inviteCode === undefined ? {} : { inviteCode }),
  });
}

async function userByEmail(email: string) {
  const { rows } = await pool.query('select * from users where email = $1', [email.toLowerCase()]);
  return rows[0] ?? null;
}

async function requestRow(email: string) {
  const { rows } = await pool.query('select * from access_requests where email = $1', [
    email.toLowerCase(),
  ]);
  return rows[0] ?? null;
}

/**
 * A live invite for `email`, minted through the whole product surface: the
 * public request form, then the operator's approve button, then the code read
 * out of the email that was sent. Nothing is written by hand.
 */
async function inviteFor(email: string): Promise<string> {
  await clearBrake('request-access');
  const asked = await app.inject({
    method: 'POST',
    url: '/auth/request-access',
    payload: { name: 'Invited Person', email, useCase: 'notifications for our app' },
  });
  expect(asked.statusCode).toBe(200);

  const id = (await requestRow(email)).id;
  outbox.length = 0;
  const approved = await app.inject({
    method: 'POST',
    url: `/v1/ops/access-requests/${id}/approve`,
    headers: { authorization: `Bearer ${operatorToken}` },
  });
  expect(approved.statusCode).toBe(200);

  const invite = outbox.find((m) => m.to === email);
  const code = /[?&]invite=([0-9a-f]{64})/.exec(invite?.text ?? '')?.[1] ?? '';
  expect(code).toMatch(/^[0-9a-f]{64}$/);
  return code;
}

// ---- lifecycle -------------------------------------------------------------

beforeAll(async () => {
  app = await buildApp();
  restoreSender = setPlatformEmailSender(async (message) => {
    outbox.push(message);
    return true;
  });
  stubGoogleTokenEndpoint();
  env.google.clientId = CLIENT_ID;
  env.google.clientSecret = CLIENT_SECRET;
  env.google.postLoginOrigin = '';

  // The operator account is created through the OPEN door, before the gate
  // comes down — the same order a real deployment has (the operator exists,
  // then SIGNUP_MODE flips).
  await clearBrake('signup');
  const op = await signup({
    name: 'Invite Operator',
    email: OPERATOR,
    password: 'invite-signup-pw-1',
    organizationName: `Invite Ops ${suffix}`,
  });
  expect(op.statusCode).toBe(201);
  operatorToken = json(op).accessToken;

  env.operatorEmails = [OPERATOR];
  env.signupMode = 'invite';
});

beforeEach(async () => {
  const keys = await redis.keys('*-rl:*');
  if (keys.length) await redis.del(...keys);
  outbox.length = 0;
});

afterAll(async () => {
  restoreSender();
  globalThis.fetch = originalFetch;
  env.signupMode = originalMode;
  env.operatorEmails = originalOperators;
  Object.assign(env.google, originalGoogle);

  const keys = await redis.keys('access-budget:*');
  if (keys.length) await redis.del(...keys);

  await pool.query('delete from access_requests where email like $1', [
    `inv-%-${suffix}@itest.local`,
  ]);

  const { rows: users } = await pool.query('select id from users where email like $1', [
    `inv-%-${suffix}@itest.local`,
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

// ---- the door tells everyone the same thing --------------------------------

describe('POST /auth/signup in invite mode — every refusal is the same 403', () => {
  test('no invite code at all', async () => {
    const email = emailFor('nocode');
    const res = await signupWith(email);
    expect(res.statusCode).toBe(403);
    expect(json(res)).toEqual({ error: INVITE_REQUIRED });
    expect(await userByEmail(email)).toBeNull();
  });

  test('an invented code', async () => {
    const email = emailFor('badcode');
    const res = await signupWith(email, 'f'.repeat(64));
    expect(res.statusCode).toBe(403);
    expect(json(res)).toEqual({ error: INVITE_REQUIRED });
    expect(await userByEmail(email)).toBeNull();
  });

  test("someone ELSE's live invite (the address must match)", async () => {
    const invited = emailFor('rightful');
    const impostor = emailFor('impostor');
    const code = await inviteFor(invited);

    const res = await signupWith(impostor, code);
    expect(res.statusCode).toBe(403);
    expect(json(res)).toEqual({ error: INVITE_REQUIRED });
    expect(await userByEmail(impostor)).toBeNull();
    // And the rightful owner's invite is untouched by the attempt.
    expect((await requestRow(invited)).consumed_at).toBeNull();
  });

  test('an EXPIRED invite', async () => {
    const email = emailFor('expired');
    const code = await inviteFor(email);
    // The only thing this suite fakes: the passage of a week. Backdating the
    // expiry is the cheapest honest way to reach a state that otherwise takes
    // seven days, and the code path under test is the same one either way.
    await pool.query(
      "update access_requests set invite_expires_at = now() - interval '1 minute' where email = $1",
      [email],
    );

    const res = await signupWith(email, code);
    expect(res.statusCode).toBe(403);
    expect(json(res)).toEqual({ error: INVITE_REQUIRED });
    expect(await userByEmail(email)).toBeNull();
  });

  test('a malformed body is still a 400 — a developer is not an attacker', async () => {
    await clearBrake('signup');
    const res = await signup({ email: 'nope', inviteCode: 'x' });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /auth/signup in invite mode — the happy path', () => {
  test('a live invite creates the account, the org, the keys, and is then spent', async () => {
    const email = emailFor('happy');
    const code = await inviteFor(email);

    const res = await signupWith(email, code);
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.user.email).toBe(email);
    expect(body.organization).toBeTruthy();
    // Provisioned exactly like an open-mode signup: two environments, a key each.
    expect(body.environments).toHaveLength(2);
    expect(body.accessToken).toBeTruthy();

    // U6 — and revealed exactly like one: an invited account is still a brand
    // new account, so its keys reach the dashboard through the same field.
    expect(body.initialApiKeys).toHaveLength(2);
    expect(
      body.initialApiKeys.map((k: { environmentName: string }) => k.environmentName).sort(),
    ).toEqual(['Development', 'Production']);
    for (const k of body.initialApiKeys) {
      expect(k.apiKey).toMatch(/^ak_/);
      const authed = await app.inject({
        method: 'GET',
        url: '/v1/workflows',
        headers: { 'x-api-key': k.apiKey },
      });
      expect(authed.statusCode).toBe(200);
    }

    const row = await requestRow(email);
    expect(row.consumed_at).toBeTruthy();
    expect(row.status).toBe('approved'); // consumption is a latch, not a status

    // The session works: they are in.
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(json(me).user.email).toBe(email);
  });

  test('the invite is SINGLE-USE: replaying the code is the same 403', async () => {
    const email = emailFor('single-use');
    const code = await inviteFor(email);
    expect((await signupWith(email, code)).statusCode).toBe(201);

    // Same address (already taken) and a second, different one — neither gets in.
    const replay = await signupWith(emailFor('single-use-2'), code);
    expect(replay.statusCode).toBe(403);
    expect(json(replay)).toEqual({ error: INVITE_REQUIRED });
    expect(await userByEmail(emailFor('single-use-2'))).toBeNull();
  });

  test('two browsers racing ONE invite produce exactly one account', async () => {
    const email = emailFor('race');
    const code = await inviteFor(email);
    await clearBrake('signup');

    // Both fired before either is awaited — the conditional UPDATE in
    // consumeAccessRequest is the only thing separating them.
    const [a, b] = await Promise.all([
      signup({
        name: 'Racer A',
        email,
        password: 'invite-signup-pw-1',
        organizationName: `Race Org A ${email}`,
        inviteCode: code,
      }),
      signup({
        name: 'Racer B',
        email,
        password: 'invite-signup-pw-1',
        organizationName: `Race Org B ${email}`,
        inviteCode: code,
      }),
    ]);

    const codes = [a.statusCode, b.statusCode].sort();
    expect(codes).toEqual([201, 403]);

    const { rows } = await pool.query('select count(*)::int as n from users where email = $1', [
      email,
    ]);
    expect(rows[0].n).toBe(1);
    // And exactly one organization was provisioned for them.
    const user = await userByEmail(email);
    const { rows: orgs } = await pool.query(
      'select count(*)::int as n from org_members where user_id = $1',
      [user.id],
    );
    expect(orgs[0].n).toBe(1);
  });
});

// ---- the Google door -------------------------------------------------------

describe('Continue with Google in invite mode', () => {
  test('an unknown address with no invite is bounced to the request form', async () => {
    const email = emailFor('g-nogate');
    const res = await runGoogleCallback(email, `g-sub-nogate-${suffix}`);

    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location)).toBe('/login?gate=request');
    // NOTHING was created — not a user, not an org, not a request row.
    expect(await userByEmail(email)).toBeNull();
    expect(await requestRow(email)).toBeNull();
  });

  test('an approved address signs in, and the invite is consumed', async () => {
    const email = emailFor('g-invited');
    await inviteFor(email);

    const res = await runGoogleCallback(email, `g-sub-invited-${suffix}`);
    expect(res.statusCode).toBe(302);
    const location = String(res.headers.location);
    expect(location.startsWith('/login?gcode=')).toBe(true);

    const user = await userByEmail(email);
    expect(user).toBeTruthy();
    expect(user.password_hash).toBeNull();
    expect((await requestRow(email)).consumed_at).toBeTruthy();

    // The one-time code redeems into a real session, exactly as in open mode.
    const code = new URL(location, 'http://x').searchParams.get('gcode') ?? '';
    const redeemed = await app.inject({
      method: 'POST',
      url: '/auth/google/redeem',
      payload: { code },
    });
    expect(redeemed.statusCode).toBe(200);
    expect(json(redeemed).organizations[0].environments).toHaveLength(2);
    // U6 — an invited Google account is a CREATED account, so its redeem
    // carries the one-time keys just as an open-mode one does.
    expect(json(redeemed).initialApiKeys).toHaveLength(2);
  });

  test('a RETURNING Google user is never re-gated (their invite is long spent)', async () => {
    const email = emailFor('g-invited');
    const before = await userByEmail(email);
    expect(before).toBeTruthy();

    const res = await runGoogleCallback(email, `g-sub-invited-${suffix}`);
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location).startsWith('/login?gcode=')).toBe(true);
    expect((await userByEmail(email)).id).toBe(before.id);
  });

  test('an existing PASSWORD account links Google without needing an invite', async () => {
    // This user got in through the invited signup above; the link branch must
    // not ask them for a second invite they no longer have.
    const email = emailFor('happy');
    const before = await userByEmail(email);
    expect(before).toBeTruthy();

    const res = await runGoogleCallback(email, `g-sub-link-${suffix}`);
    expect(res.statusCode).toBe(302);
    expect(String(res.headers.location).startsWith('/login?gcode=')).toBe(true);

    const after = await userByEmail(email);
    expect(after.id).toBe(before.id); // same row, not a second account
    expect(after.google_sub).toBe(`g-sub-link-${suffix}`);
    expect(after.password_hash).toBeTruthy(); // both doors now open
  });

  test('an existing password user can still LOG IN in invite mode', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailFor('happy'), password: 'invite-signup-pw-1' },
    });
    expect(res.statusCode).toBe(200);
  });
});

// ---- and /auth/methods says which mode this is -----------------------------

describe('GET /auth/methods', () => {
  test('reports the invite mode so one bundle can serve both', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/methods' });
    expect(res.statusCode).toBe(200);
    expect(json(res).signupMode).toBe('invite');
  });
});
