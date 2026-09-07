/**
 * Slice S1.6 — "Continue with Google", end to end against the real app.
 *
 * Everything except Google itself is real: real routes, real cookie, real
 * Redis one-time code, real Postgres rows. Google's token endpoint is the one
 * seam, stubbed at `globalThis.fetch` (the idiom the SMS suite uses) so the
 * request we actually build — URL, form fields, PKCE verifier — is asserted
 * rather than assumed, and the id_token we get back is one the test authored.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { env } from '../../src/config/env';
import { pool } from '../../src/db/pool';
import { redis } from '../../src/shared/redis';

const CLIENT_ID = 'itest-client-id.apps.googleusercontent.com';
const CLIENT_SECRET = 'itest-client-secret';
const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';

let app: FastifyInstance;
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const emailFor = (who: string) => `${who}-${suffix}@itest.local`;

const json = (res: { body: string }) => JSON.parse(res.body);

const originalGoogle = { ...env.google };
const originalFetch = globalThis.fetch;

// ---- the stubbed Google token endpoint -------------------------------------

/** What the next exchange returns, and what the last one was asked. */
const google = {
  idToken: '' as string,
  status: 200,
  lastUrl: '' as string,
  lastBody: null as URLSearchParams | null,
};

function stubGoogleTokenEndpoint(): void {
  globalThis.fetch = (async (input: unknown, init?: { body?: unknown }) => {
    const url = String(input);
    // Anything that is not Google's token endpoint keeps the real fetch, so a
    // stray outbound call in the app cannot be silently swallowed by this stub.
    if (!url.startsWith(TOKEN_ENDPOINT)) {
      return (originalFetch as (i: unknown, x?: unknown) => Promise<Response>)(input, init);
    }
    google.lastUrl = url;
    google.lastBody = (init?.body as URLSearchParams) ?? null;
    if (google.status !== 200) {
      return { ok: false, status: google.status, json: async () => ({ error: 'invalid_grant' }) };
    }
    return { ok: true, status: 200, json: async () => ({ id_token: google.idToken }) };
  }) as unknown as typeof fetch;
}

/** A Google id_token whose signature is never checked — see the route's note. */
function makeIdToken(claims: Record<string, unknown>): string {
  const b64 = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b64({ alg: 'RS256', kid: 'itest' })}.${b64(claims)}.signature-is-never-verified`;
}

function claimsFor(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://accounts.google.com',
    aud: CLIENT_ID,
    exp: Math.floor(Date.now() / 1000) + 3600,
    sub: `google-sub-${suffix}`,
    email: emailFor('gnew'),
    email_verified: true,
    name: 'Grace Hopper',
    ...overrides,
  };
}

// ---- driving the flow ------------------------------------------------------

/** Start a sign-in; returns the authorize URL and the cookie to send back. */
async function startAuthorize() {
  const res = await app.inject({ method: 'GET', url: '/auth/google' });
  expect(res.statusCode).toBe(302);
  const setCookie = String(res.headers['set-cookie']);
  const cookie = setCookie.split(';')[0]; // g_oauth=<state>.<verifier>
  const url = new URL(String(res.headers.location));
  return { url, cookie, state: url.searchParams.get('state') ?? '' };
}

/** Complete a sign-in with the given claims; returns the callback response. */
async function runCallback(claims: Record<string, unknown> = claimsFor()) {
  const { cookie, state } = await startAuthorize();
  google.idToken = makeIdToken(claims);
  google.status = 200;
  return app.inject({
    method: 'GET',
    url: `/auth/google/callback?code=auth-code-1&state=${state}`,
    headers: { cookie },
  });
}

const gcodeFrom = (location: string) => new URL(location, 'http://x').searchParams.get('gcode') ?? '';

async function userByEmail(email: string) {
  const { rows } = await pool.query('select * from users where email = $1', [email.toLowerCase()]);
  return rows[0] ?? null;
}

async function orgCountFor(userId: string): Promise<number> {
  const { rows } = await pool.query(
    'select count(*)::int as n from org_members where user_id = $1',
    [userId],
  );
  return rows[0].n;
}

// ---- lifecycle -------------------------------------------------------------

beforeAll(async () => {
  app = await buildApp();
  stubGoogleTokenEndpoint();
  env.google.clientId = CLIENT_ID;
  env.google.clientSecret = CLIENT_SECRET;
  env.google.postLoginOrigin = '';
});

beforeEach(async () => {
  // Every surface here is per-IP limited and the whole file injects from one
  // "IP"; a fresh minute bucket per test keeps the limiter honest without
  // making the suite's own volume the thing under test.
  const keys = await redis.keys('*-rl:*');
  if (keys.length) await redis.del(...keys);
});

afterAll(async () => {
  Object.assign(env.google, originalGoogle);
  globalThis.fetch = originalFetch;

  const { rows: users } = await pool.query('select id from users where email like $1', [
    `%-${suffix}@itest.local`,
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

// ---- the feature switch ----------------------------------------------------

describe('with no Google client configured', () => {
  test('the routes are not there at all, and /auth/methods says so', async () => {
    env.google.clientId = '';
    env.google.clientSecret = '';
    try {
      expect((await app.inject({ method: 'GET', url: '/auth/google' })).statusCode).toBe(404);
      expect(
        (await app.inject({ method: 'GET', url: '/auth/google/callback?code=c&state=s' }))
          .statusCode,
      ).toBe(404);
      expect(
        (await app.inject({ method: 'POST', url: '/auth/google/redeem', payload: { code: 'x' } }))
          .statusCode,
      ).toBe(404);

      const methods = await app.inject({ method: 'GET', url: '/auth/methods' });
      expect(methods.statusCode).toBe(200);
      expect(json(methods)).toEqual({ google: false });
    } finally {
      env.google.clientId = CLIENT_ID;
      env.google.clientSecret = CLIENT_SECRET;
    }
  });

  test('half a configuration still reads as off', async () => {
    env.google.clientSecret = '';
    try {
      expect((await app.inject({ method: 'GET', url: '/auth/google' })).statusCode).toBe(404);
    } finally {
      env.google.clientSecret = CLIENT_SECRET;
    }
  });
});

describe('/auth/methods with Google configured', () => {
  test('reports the door as open', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/methods' });
    expect(json(res)).toEqual({ google: true });
  });
});

// ---- step 1: the authorize redirect ---------------------------------------

describe('GET /auth/google', () => {
  test('redirects to Google carrying state, PKCE and our client id', async () => {
    const { url, state } = await startAuthorize();
    expect(`${url.origin}${url.pathname}`).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe('openid email profile');
    expect(url.searchParams.get('prompt')).toBe('select_account');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(state).toMatch(/^[0-9a-f]{64}$/);
    // 43 chars of base64url, the low end of PKCE's legal range.
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Dev/test never uses the (rotating) tunnel URL — the console has this one.
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:3000/auth/google/callback');
  });

  test('parks state and the PKCE verifier in one HttpOnly, Lax, /auth cookie', async () => {
    const res = await app.inject({ method: 'GET', url: '/auth/google' });
    const setCookie = String(res.headers['set-cookie']);
    expect(setCookie).toMatch(/^g_oauth=[0-9a-f]{64}\.[A-Za-z0-9_-]{43};/);
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Lax'); // Strict would kill the callback
    expect(setCookie).toContain('Path=/auth');
    expect(setCookie).toContain('Max-Age=600');
  });

  test('every sign-in gets its own state and verifier', async () => {
    const a = await startAuthorize();
    const b = await startAuthorize();
    expect(a.state).not.toBe(b.state);
    expect(a.cookie).not.toBe(b.cookie);
  });
});

// ---- step 2: the callback --------------------------------------------------

describe('GET /auth/google/callback — the CSRF wall', () => {
  test('a state that does not match the cookie is refused', async () => {
    const { cookie } = await startAuthorize();
    const res = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=c&state=not-the-state-we-issued',
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Sign-in expired');
    // Spent either way: the cookie is cleared even on a refusal.
    expect(String(res.headers['set-cookie'])).toContain('Max-Age=0');
  });

  test('no cookie at all is refused (a forged callback from another site)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/auth/google/callback?code=c&state=whatever',
    });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('Sign-in expired');
  });

  test('a missing code is refused even with a good state', async () => {
    const { cookie, state } = await startAuthorize();
    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?state=${state}`,
      headers: { cookie },
    });
    expect(res.statusCode).toBe(400);
  });

  test('a rejected exchange fails closed', async () => {
    const { cookie, state } = await startAuthorize();
    google.status = 400;
    const res = await app.inject({
      method: 'GET',
      url: `/auth/google/callback?code=stale&state=${state}`,
      headers: { cookie },
    });
    google.status = 200;
    expect(res.statusCode).toBe(400);
  });
});

describe('GET /auth/google/callback — the happy path', () => {
  test('creates the user, org, environments and api keys, then hands back a code', async () => {
    const res = await runCallback();
    expect(res.statusCode).toBe(302);
    const location = String(res.headers.location);
    expect(location.startsWith('/login?gcode=')).toBe(true);
    expect(gcodeFrom(location)).toMatch(/^[0-9a-f]{64}$/);

    // The exchange we actually made, not the one we meant to make.
    expect(google.lastUrl).toBe(TOKEN_ENDPOINT);
    expect(google.lastBody?.get('grant_type')).toBe('authorization_code');
    expect(google.lastBody?.get('client_id')).toBe(CLIENT_ID);
    expect(google.lastBody?.get('client_secret')).toBe(CLIENT_SECRET);
    expect(google.lastBody?.get('code')).toBe('auth-code-1');
    expect(google.lastBody?.get('code_verifier')).toMatch(/^[A-Za-z0-9_-]{43}$/);
    // Byte-identical to the authorize step, which is what Google enforces.
    expect(google.lastBody?.get('redirect_uri')).toBe(
      'http://localhost:3000/auth/google/callback',
    );

    const user = await userByEmail(emailFor('gnew'));
    expect(user).toBeTruthy();
    expect(user.google_sub).toBe(`google-sub-${suffix}`);
    expect(user.password_hash).toBeNull(); // no password was ever set
    expect(user.name).toBe('Grace Hopper');

    // Provisioned exactly like a password signup: one org, two environments,
    // one api key each.
    const { rows: envs } = await pool.query(
      `select t.name from tenants t
         join org_members m on m.organization_id = t.organization_id
        where m.user_id = $1 order by t.name`,
      [user.id],
    );
    expect(envs.map((e: { name: string }) => e.name)).toEqual(['Development', 'Production']);
    const { rows: keys } = await pool.query(
      `select count(*)::int as n from api_keys k
         join tenants t on t.id = k.tenant_id
         join org_members m on m.organization_id = t.organization_id
        where m.user_id = $1`,
      [user.id],
    );
    expect(keys[0].n).toBe(2);
  });

  test('a second sign-in is the SAME user — no duplicate org', async () => {
    const before = await userByEmail(emailFor('gnew'));
    const res = await runCallback();
    expect(res.statusCode).toBe(302);
    const after = await userByEmail(emailFor('gnew'));
    expect(after.id).toBe(before.id);
    expect(await orgCountFor(after.id)).toBe(1);
  });

  test('GOOGLE_POST_LOGIN_ORIGIN prefixes the bounce (the dev :3000 -> :5173 hop)', async () => {
    env.google.postLoginOrigin = 'http://localhost:5173';
    try {
      const res = await runCallback();
      expect(String(res.headers.location).startsWith('http://localhost:5173/login?gcode=')).toBe(
        true,
      );
    } finally {
      env.google.postLoginOrigin = '';
    }
  });
});

describe('GET /auth/google/callback — claims we refuse', () => {
  test('an unverified email creates nothing', async () => {
    const email = emailFor('unverified');
    const res = await runCallback(
      claimsFor({ email, email_verified: false, sub: `sub-unverified-${suffix}` }),
    );
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('verified');
    expect(await userByEmail(email)).toBeNull();
  });

  test('an id_token minted for a different client is refused', async () => {
    const email = emailFor('wrongaud');
    const res = await runCallback(
      claimsFor({ email, aud: 'someone-elses-client', sub: `sub-wrongaud-${suffix}` }),
    );
    expect(res.statusCode).toBe(400);
    expect(await userByEmail(email)).toBeNull();
  });

  test('an expired id_token is refused', async () => {
    const email = emailFor('expired');
    const res = await runCallback(
      claimsFor({
        email,
        exp: Math.floor(Date.now() / 1000) - 60,
        sub: `sub-expired-${suffix}`,
      }),
    );
    expect(res.statusCode).toBe(400);
    expect(await userByEmail(email)).toBeNull();
  });

  test('a token from the wrong issuer is refused', async () => {
    const email = emailFor('wrongiss');
    const res = await runCallback(
      claimsFor({ email, iss: 'https://evil.example', sub: `sub-wrongiss-${suffix}` }),
    );
    expect(res.statusCode).toBe(400);
    expect(await userByEmail(email)).toBeNull();
  });
});

describe('linking a Google identity onto an existing password account', () => {
  const email = emailFor('linked');
  let passwordUserId = '';

  test('the password account is adopted, not duplicated', async () => {
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        name: 'Ada Lovelace',
        email,
        password: 'integration-pw-1',
        organizationName: 'Linked Org',
      },
    });
    expect(signup.statusCode).toBe(201);
    passwordUserId = json(signup).user.id;

    const res = await runCallback(claimsFor({ email, sub: `sub-linked-${suffix}` }));
    expect(res.statusCode).toBe(302);

    const user = await userByEmail(email);
    expect(user.id).toBe(passwordUserId); // same row, not a second account
    expect(user.google_sub).toBe(`sub-linked-${suffix}`);
    expect(user.password_hash).toBeTruthy(); // the password still works
    expect(await orgCountFor(user.id)).toBe(1); // no second org was provisioned
  });

  test('the password still logs them in afterwards — both doors open', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'integration-pw-1' },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).user.id).toBe(passwordUserId);
  });
});

// ---- step 3: redeeming the one-time code -----------------------------------

describe('POST /auth/google/redeem', () => {
  test('a valid code yields a session that authenticates a protected route', async () => {
    const callback = await runCallback();
    const code = gcodeFrom(String(callback.headers.location));

    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/redeem',
      payload: { code },
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    // The same shape /auth/login returns — the SPA has one code path.
    expect(body.user.email).toBe(emailFor('gnew'));
    expect(body.accessToken).toBeTruthy();
    expect(body.refreshToken).toBeTruthy();
    expect(Array.isArray(body.organizations)).toBe(true);
    expect(body.organizations[0].environments).toHaveLength(2);

    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${body.accessToken}` },
    });
    expect(me.statusCode).toBe(200);
    expect(json(me).user.email).toBe(emailFor('gnew'));
  });

  test('the code is single-use: the second redeem is a 401', async () => {
    const callback = await runCallback();
    const code = gcodeFrom(String(callback.headers.location));

    expect(
      (await app.inject({ method: 'POST', url: '/auth/google/redeem', payload: { code } }))
        .statusCode,
    ).toBe(200);
    const second = await app.inject({
      method: 'POST',
      url: '/auth/google/redeem',
      payload: { code },
    });
    expect(second.statusCode).toBe(401);
    expect(json(second).error).toContain('expired');
  });

  test('an invented code is a 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/google/redeem',
      payload: { code: 'a'.repeat(64) },
    });
    expect(res.statusCode).toBe(401);
  });
});

// ---- the wrong door --------------------------------------------------------

describe('password login against a Google-only account', () => {
  test('is a plain 401, never a 500 on the missing hash', async () => {
    // Created by the happy-path callback above: password_hash is NULL.
    const res = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: emailFor('gnew'), password: 'anything-at-all' },
    });
    expect(res.statusCode).toBe(401);
    expect(json(res).error).toBe('invalid email or password');
  });
});
