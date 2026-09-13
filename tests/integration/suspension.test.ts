/**
 * Slice B2 — REVOKING AND RESTORING AN ACCOUNT, end to end against the real app.
 *
 * The subject is a lockout, so the tests are written as a lockout: an account is
 * created through the real invite door, an operator revokes it through the real
 * route, and then EVERY door is knocked on — password login, the Google
 * returning branch, the Google link branch, the refresh rotation, the password
 * reset, and the public request-access form — to prove each one is shut, and
 * that restoring opens them again onto the same account (same org, same data).
 *
 * Two seams, both the ones the sibling suites already use: outbound SMTP
 * (`setPlatformEmailSender`) so the invite and reset links are the ones a human
 * would have received, and Google's token endpoint (`globalThis.fetch`) so the
 * id_token is one the test authored. Everything else — rows, budgets, brakes,
 * sessions — is real.
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
import { setSuspended } from '../../src/db/accounts.repo';

const CLIENT_ID = 'suspension-itest-client.apps.googleusercontent.com';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

let app: FastifyInstance;
let restoreSender: () => void;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const emailFor = (who: string) => `sus-${who}-${suffix}@itest.local`;

const OPERATOR = emailFor('operator');
const SECOND_OPERATOR = emailFor('operator-two');
const OUTSIDER = emailFor('outsider');

const PASSWORD = 'suspension-pw-1';

const originalOperators = [...env.operatorEmails];
const originalSignupMode = env.signupMode;
const originalGoogle = { ...env.google };
const originalFetch = globalThis.fetch;

const json = (res: { body: string }) => JSON.parse(res.body);

/** Every platform email the app tried to send, in order. */
const outbox: PlatformEmail[] = [];

let operatorToken = '';
let outsiderToken = '';

// ---- the stubbed Google token endpoint -------------------------------------

const google = { idToken: '' };

function stubGoogleTokenEndpoint(): void {
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    if (!url.startsWith(TOKEN_ENDPOINT)) {
      return (originalFetch as (i: unknown, x?: unknown) => Promise<Response>)(input, init);
    }
    return { ok: true, status: 200, json: async () => ({ id_token: google.idToken }) };
  }) as unknown as typeof fetch;
}

/** A Google id_token whose signature is never checked — see the route's note. */
function makeIdToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', kid: 'itest' })}.${b64(claims)}.signature-is-never-verified`;
}

/** Complete a whole Google sign-in for one address; returns the callback reply. */
async function googleSignIn(email: string, sub: string) {
  const start = await app.inject({ method: 'GET', url: '/auth/google' });
  const cookie = String(start.headers['set-cookie']).split(';')[0];
  const state = new URL(String(start.headers.location)).searchParams.get('state') ?? '';
  google.idToken = makeIdToken({
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub,
    email,
    email_verified: true,
    name: 'Ada Lovelace',
  });
  return app.inject({
    method: 'GET',
    url: `/auth/google/callback?code=auth-code-1&state=${state}`,
    headers: { cookie },
  });
}

// ---- driving the app -------------------------------------------------------

/** Reset one named per-IP budget — the whole file injects from one "IP". */
async function clearBrake(name: string): Promise<void> {
  const keys = await redis.keys(`${name}-rl:*`);
  if (keys.length) await redis.del(...keys);
}

async function openSignup(email: string) {
  await clearBrake('signup');
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'B2 Tester', email, password: PASSWORD, organizationName: `B2 Org ${email}` },
  });
  expect(res.statusCode).toBe(201);
  return json(res);
}

const login = (email: string, password = PASSWORD) =>
  app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } });

const refresh = (refreshToken: string) =>
  app.inject({ method: 'POST', url: '/auth/refresh', payload: { refreshToken } });

const ask = async (email: string, name = 'Ada Lovelace', useCase = 'transactional email') => {
  await clearBrake('request-access');
  return app.inject({ method: 'POST', url: '/auth/request-access', payload: { name, email, useCase } });
};

const listRequests = (token: string, status: string) =>
  app.inject({
    method: 'GET',
    url: `/v1/ops/access-requests?status=${status}`,
    headers: { authorization: `Bearer ${token}` },
  });

const opsPost = (token: string, id: string, action: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/ops/access-requests/${id}/${action}`,
    headers: { authorization: `Bearer ${token}` },
  });

const approve = (id: string) => opsPost(operatorToken, id, 'approve');
const revoke = (id: string, token = operatorToken) => opsPost(token, id, 'revoke');
const restore = (id: string, token = operatorToken) => opsPost(token, id, 'restore');

async function requestRow(email: string) {
  const { rows } = await pool.query('select * from access_requests where email = $1', [email]);
  return rows[0] ?? null;
}

async function userRow(email: string) {
  const { rows } = await pool.query('select * from users where email = $1', [email]);
  return rows[0] ?? null;
}

/** The listed view of one row, as the operator's page sees it. */
async function listedRow(email: string, status = 'approved') {
  const rows = json(await listRequests(operatorToken, status)).requests as Array<{
    email: string;
    accountStatus?: string;
    consumedAt: string | null;
  }>;
  return rows.find((r) => r.email === email);
}

/**
 * A whole beta account, made the way a real one is made: the person asks, the
 * operator approves, the invite email arrives, and they sign up with the code
 * from it while the deployment is in invite mode — so the request row ends up
 * CONSUMED, which is the state the two account actions require.
 */
async function onboard(email: string) {
  await ask(email);
  const requestId = (await requestRow(email)).id;

  outbox.length = 0;
  expect((await approve(requestId)).statusCode).toBe(200);
  const code = /[?&]invite=([0-9a-f]{64})/.exec(outbox[0]?.text ?? '')?.[1] ?? '';
  expect(code).toMatch(/^[0-9a-f]{64}$/);

  env.signupMode = 'invite';
  try {
    await clearBrake('signup');
    const created = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        name: 'B2 Tester',
        email,
        password: PASSWORD,
        organizationName: `B2 Org ${email}`,
        inviteCode: code,
      },
    });
    expect(created.statusCode).toBe(201);
    expect((await requestRow(email)).consumed_at).toBeTruthy();
    const body = json(created);
    return {
      requestId,
      userId: body.user.id as string,
      orgId: body.organization.id as string,
      refreshToken: body.refreshToken as string,
    };
  } finally {
    env.signupMode = originalSignupMode;
  }
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
  env.google.clientSecret = 'suspension-itest-secret';
  env.google.postLoginOrigin = '';

  // Created through the ordinary open door BEFORE the seat is configured.
  operatorToken = (await openSignup(OPERATOR)).accessToken;
  outsiderToken = (await openSignup(OUTSIDER)).accessToken;
  env.operatorEmails = [OPERATOR];
});

beforeEach(async () => {
  const keys = await redis.keys('*-rl:*');
  if (keys.length) await redis.del(...keys);
  outbox.length = 0;
});

afterAll(async () => {
  restoreSender();
  globalThis.fetch = originalFetch;
  Object.assign(env.google, originalGoogle);
  env.operatorEmails = originalOperators;
  env.signupMode = originalSignupMode;

  for (const pattern of ['access-budget:*', 'pwreset-budget:*']) {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  }

  await pool.query('delete from access_requests where email like $1', [`sus-%-${suffix}@itest.local`]);

  const { rows: users } = await pool.query('select id from users where email like $1', [
    `sus-%-${suffix}@itest.local`,
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

// ---- the lifecycle ---------------------------------------------------------

describe('the whole lifecycle: approve -> sign up -> revoke -> restore', () => {
  test('every door shuts on revoke and opens again on restore, onto the SAME account', async () => {
    const email = emailFor('lifecycle');
    const account = await onboard(email);

    // Active: the ordinary door works, and the listing says so.
    expect((await login(email)).statusCode).toBe(200);
    expect((await listedRow(email))?.accountStatus).toBe('active');

    // ---- revoke ----
    const revoked = await revoke(account.requestId);
    expect(revoked.statusCode).toBe(200);
    expect(json(revoked)).toEqual({ accountStatus: 'suspended' });
    expect((await userRow(email)).suspended_at).toBeTruthy();

    // The password door: a 403 that says why, only because the password was
    // right (see the oracle test below for what a wrong one gets).
    const refused = await login(email);
    expect(refused.statusCode).toBe(403);
    expect(json(refused)).toEqual({ error: 'access revoked' });

    // The session door: the token minted at signup buys nothing.
    const rotated = await refresh(account.refreshToken);
    expect(rotated.statusCode).toBe(401);
    expect(json(rotated)).toEqual({ error: 'invalid refresh token' });

    // The operator's own page agrees. (The Google door's two branches get their
    // own describe below — they need a linked sub to be worth asserting.)
    expect((await listedRow(email))?.accountStatus).toBe('suspended');

    // ---- restore ----
    const restored = await restore(account.requestId);
    expect(restored.statusCode).toBe(200);
    expect(json(restored)).toEqual({ accountStatus: 'active' });
    expect((await userRow(email)).suspended_at).toBeNull();

    const back = await login(email);
    expect(back.statusCode).toBe(200);
    // The SAME account, not a new one: the organization it came in with is the
    // organization it comes back to, so every environment, key and message the
    // account owns survived the lockout untouched.
    expect(json(back).organizations[0].id).toBe(account.orgId);
    expect(json(back).user.id).toBe(account.userId);
    expect((await listedRow(email))?.accountStatus).toBe('active');
  });

  test('a wrong password on a suspended account is the ordinary 401, not the 403', async () => {
    // The oracle check. If the suspension were tested before the password, this
    // would be a 403 — and anybody who could type an address would learn which
    // accounts an operator had shut out, faster than a wrong password answers.
    const email = emailFor('oracle');
    const account = await onboard(email);
    expect((await revoke(account.requestId)).statusCode).toBe(200);

    const wrong = await login(email, 'not-the-password');
    expect(wrong.statusCode).toBe(401);
    expect(json(wrong)).toEqual({ error: 'invalid email or password' });

    // And an address that does not exist at all answers identically.
    const nobody = await login(emailFor('never-existed'), 'not-the-password');
    expect(nobody.statusCode).toBe(401);
    expect(json(nobody)).toEqual({ error: 'invalid email or password' });
  });
});

// ---- the refresh rotation --------------------------------------------------

describe('POST /auth/refresh', () => {
  test('a LIVE token belonging to a suspended account mints nothing', async () => {
    /**
     * The revoke route revokes every family alongside the suspension, so a
     * token that has been through it is already dead by the ledger's own rules.
     * This test isolates the OTHER half — the check on the rotation itself,
     * which exists for the token that was minted a millisecond before the
     * operator clicked. The suspension is written through the same repo call
     * the route makes, with the families deliberately left alive, because that
     * in-flight moment cannot be produced through the route.
     */
    const email = emailFor('refresh-race');
    const account = await onboard(email);
    const session = json(await login(email));

    await setSuspended(account.userId, true);

    const rotated = await refresh(session.refreshToken);
    expect(rotated.statusCode).toBe(401);
    expect(json(rotated)).toEqual({ error: 'invalid refresh token' });

    // Restored, the very next rotation works again — the check reads the row,
    // it does not poison the token.
    await setSuspended(account.userId, false);
    const second = json(await login(email));
    expect((await refresh(second.refreshToken)).statusCode).toBe(200);
  });
});

// ---- the Google door -------------------------------------------------------

describe('the Google door', () => {
  test('the RETURNING branch bounces to /login?gate=revoked', async () => {
    const email = emailFor('g-returning');
    const account = await onboard(email);
    const sub = `google-sub-returning-${suffix}`;

    // Link it while the account is active: an ordinary Continue with Google on
    // an existing password account, which is the LINK branch succeeding.
    const linked = await googleSignIn(email, sub);
    expect(linked.statusCode).toBe(302);
    expect(String(linked.headers.location)).toContain('gcode=');
    expect((await userRow(email)).google_sub).toBe(sub);

    expect((await revoke(account.requestId)).statusCode).toBe(200);

    // Now the sub resolves the user, so this is the returning branch.
    const bounced = await googleSignIn(email, sub);
    expect(bounced.statusCode).toBe(302);
    expect(String(bounced.headers.location)).toBe('/login?gate=revoked');

    // Restoring puts the Google door back too.
    expect((await restore(account.requestId)).statusCode).toBe(200);
    const again = await googleSignIn(email, sub);
    expect(String(again.headers.location)).toContain('gcode=');
  });

  test('the LINK branch bounces too, and links nothing on the way out', async () => {
    const email = emailFor('g-link');
    const account = await onboard(email);
    expect((await revoke(account.requestId)).statusCode).toBe(200);

    const bounced = await googleSignIn(email, `google-sub-link-${suffix}`);
    expect(bounced.statusCode).toBe(302);
    expect(String(bounced.headers.location)).toBe('/login?gate=revoked');

    // The refusal happens BEFORE the link write: a revoked account must not
    // quietly gain a second door on its way to being turned away at it.
    expect((await userRow(email)).google_sub).toBeNull();
  });

  test('the CREATE branch is unreachable for a suspended account', async () => {
    // Not a behavior to assert so much as an invariant to pin: suspension is a
    // fact about a USER ROW, and the create branch runs only when no row holds
    // the address. A sign-in for an address with no account is therefore an
    // ordinary new account, suspensions elsewhere notwithstanding.
    const email = emailFor('g-create');
    expect(await userRow(email)).toBeNull();

    const created = await googleSignIn(email, `google-sub-create-${suffix}`);
    expect(created.statusCode).toBe(302);
    expect(String(created.headers.location)).toContain('gcode=');
    expect((await userRow(email)).suspended_at).toBeNull();
  });
});

// ---- the password reset ----------------------------------------------------

describe('POST /auth/reset while suspended', () => {
  test('the reset completes, and the new password still cannot log in', async () => {
    /**
     * Deliberate: a reset proves control of a mailbox and changes one column.
     * Refusing it would leak which accounts are suspended to anyone who owns the
     * address, and letting it through costs nothing — because the door it
     * unlocks is still bolted.
     */
    const email = emailFor('reset');
    const account = await onboard(email);
    expect((await revoke(account.requestId)).statusCode).toBe(200);

    outbox.length = 0;
    await clearBrake('forgot');
    expect((await app.inject({ method: 'POST', url: '/auth/forgot', payload: { email } })).statusCode).toBe(200);
    const token = /[?&]token=([0-9a-f]{64})/.exec(outbox[0]?.text ?? '')?.[1] ?? '';
    expect(token).toMatch(/^[0-9a-f]{64}$/);

    await clearBrake('reset');
    const reset = await app.inject({
      method: 'POST',
      url: '/auth/reset',
      payload: { token, newPassword: 'a-brand-new-password-2' },
    });
    expect(reset.statusCode).toBe(200);

    const refused = await login(email, 'a-brand-new-password-2');
    expect(refused.statusCode).toBe(403);
    expect(json(refused)).toEqual({ error: 'access revoked' });

    // And the new password is genuinely the account's — it works on restore.
    expect((await restore(account.requestId)).statusCode).toBe(200);
    expect((await login(email, 'a-brand-new-password-2')).statusCode).toBe(200);
  });
});

// ---- the public request-access form ----------------------------------------

describe('POST /auth/request-access from a suspended address', () => {
  test('is the same flat 200: no operator email, no path back in, row untouched', async () => {
    const email = emailFor('re-request');
    const account = await onboard(email);
    expect((await revoke(account.requestId)).statusCode).toBe(200);

    const before = await requestRow(email);
    outbox.length = 0;

    const res = await ask(email, 'Please Let Me Back', 'i have learned my lesson');
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true });

    // The address has an account, so the route short-circuits exactly as it
    // does for any other customer — before any row is touched and before any
    // operator is told. A revoked user cannot re-queue themselves, and cannot
    // use the form to bury the operator in mail either.
    expect(outbox).toHaveLength(0);
    const after = await requestRow(email);
    expect(after).toEqual(before);
    expect((await userRow(email)).suspended_at).toBeTruthy();
  });
});

// ---- the operator routes ---------------------------------------------------

describe('POST /v1/ops/access-requests/:id/revoke and /restore', () => {
  test('both are idempotent', async () => {
    const email = emailFor('idempotent');
    const account = await onboard(email);

    expect((await revoke(account.requestId)).statusCode).toBe(200);
    const stamp = (await userRow(email)).suspended_at;
    const twice = await revoke(account.requestId);
    expect(twice.statusCode).toBe(200);
    expect(json(twice)).toEqual({ accountStatus: 'suspended' });
    // The timestamp is the audit fact "when were they shut out" — a second
    // click must not move it.
    expect((await userRow(email)).suspended_at).toEqual(stamp);

    expect((await restore(account.requestId)).statusCode).toBe(200);
    const restoredTwice = await restore(account.requestId);
    expect(restoredTwice.statusCode).toBe(200);
    expect(json(restoredTwice)).toEqual({ accountStatus: 'active' });
    expect((await userRow(email)).suspended_at).toBeNull();
  });

  test('an OPERATOR account cannot be suspended', async () => {
    // The hijacked-session lockout defense: without it, one click (or one
    // stolen operator session) closes the only page that could undo it.
    const account = await onboard(SECOND_OPERATOR);
    env.operatorEmails = [OPERATOR, SECOND_OPERATOR];
    try {
      const res = await revoke(account.requestId);
      expect(res.statusCode).toBe(403);
      expect(json(res)).toEqual({ error: 'operators cannot be suspended' });
      expect((await userRow(SECOND_OPERATOR)).suspended_at).toBeNull();
      // And they can still get in, which is the whole point.
      expect((await login(SECOND_OPERATOR)).statusCode).toBe(200);
    } finally {
      env.operatorEmails = [OPERATOR];
    }
  });

  test('a signed-in NON-operator gets 403 from both', async () => {
    const email = emailFor('guarded');
    const account = await onboard(email);
    for (const res of [
      await revoke(account.requestId, outsiderToken),
      await restore(account.requestId, outsiderToken),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(json(res)).toEqual({ error: 'operator access required' });
    }
    expect((await userRow(email)).suspended_at).toBeNull();
  });

  test('no token at all is a 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/ops/access-requests/11111111-1111-1111-1111-111111111111/revoke',
    });
    expect(res.statusCode).toBe(401);
  });

  test('an UNCONSUMED row is a 409 — there is no account behind it yet', async () => {
    const email = emailFor('unconsumed');
    await ask(email);
    const id = (await requestRow(email)).id;

    const pending = await revoke(id);
    expect(pending.statusCode).toBe(409);
    expect(json(pending)).toEqual({ error: 'no account to revoke' });

    // Approved but not yet signed up: the invite is in an inbox, and there is
    // still nobody to revoke.
    expect((await approve(id)).statusCode).toBe(200);
    expect((await revoke(id)).statusCode).toBe(409);
    expect(json(await restore(id))).toEqual({ error: 'no account to restore' });
  });

  test('an unknown id is a 404, and so is a non-uuid', async () => {
    expect((await revoke('11111111-1111-1111-1111-111111111111')).statusCode).toBe(404);
    expect((await restore('not-a-uuid')).statusCode).toBe(404);
  });
});

// ---- the listing -----------------------------------------------------------

describe('GET /v1/ops/access-requests carries the account state', () => {
  test('consumed rows say active or suspended; unspent rows say nothing at all', async () => {
    const email = emailFor('listing');
    const account = await onboard(email);

    const active = await listedRow(email);
    expect(active?.consumedAt).toBeTruthy();
    expect(active?.accountStatus).toBe('active');

    expect((await revoke(account.requestId)).statusCode).toBe(200);
    expect((await listedRow(email))?.accountStatus).toBe('suspended');

    expect((await restore(account.requestId)).statusCode).toBe(200);
    expect((await listedRow(email))?.accountStatus).toBe('active');

    // A row nobody has signed up against carries no accountStatus — 'active'
    // there would be a claim about an account that does not exist.
    const waiting = emailFor('listing-waiting');
    await ask(waiting);
    const pending = await listedRow(waiting, 'pending');
    expect(pending).toBeTruthy();
    expect(pending).not.toHaveProperty('accountStatus');
  });
});
