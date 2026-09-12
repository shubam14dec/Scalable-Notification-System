/**
 * Slice U5 — the first-run guided tour's SERVER half: who is owed a tour, and
 * the one call that says they are not owed one any more.
 *
 * The interesting property is not "a boolean round-trips". It is WHICH doors
 * arm the flag. A tour is a first impression, and the two ways it can be wrong
 * are both silent: an existing customer ambushed by a walkthrough of a product
 * they already run, or a brand-new account that never gets one. So every door
 * into this system is exercised here — password signup, the Google CREATE
 * branch, the Google LINK branch, and an account minted out of band by a
 * fixture (which is what every pre-U5 row in production looks like) — and each
 * is asserted against the users row itself.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { pool } from '../../src/db/pool';
import { redis } from '../../src/shared/redis';
import { createUser, getUserByEmail } from '../../src/db/accounts.repo';
import { provisionAccount } from '../../src/auth/provisioning';
import { mintSessionTokens } from '../../src/api/routes/auth';
import { findOrCreateGoogleUser } from '../../src/api/routes/google-auth';

let app: FastifyInstance;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const emailFor = (who: string) => `tour-${who}-${suffix}@itest.local`;

const json = (res: { body: string }) => JSON.parse(res.body);

/** The signed-up account whose tour the /auth/tour-done tests spend. */
let signupToken = '';

async function clearBrakes(): Promise<void> {
  const keys = await redis.keys('*-rl:*');
  if (keys.length) await redis.del(...keys);
}

/** `tourPending` exactly as the dashboard reads it, through the real route. */
async function tourPendingOverTheWire(accessToken: string): Promise<unknown> {
  const res = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(res.statusCode).toBe(200);
  return json(res).tourPending;
}

/** ...and the same fact straight out of the row, for the doors that have no
 *  session to ask with. */
async function tourPendingInTheRow(email: string): Promise<boolean> {
  const user = await getUserByEmail(email);
  expect(user, `no user row for ${email}`).toBeTruthy();
  return user!.tour_pending;
}

/**
 * Exactly the request the dashboard makes: POST, no body, but the api client's
 * blanket `content-type: application/json` header on it anyway. That header
 * with an empty body is the shape Fastify's stock JSON parser answers 400 to —
 * this app's custom parser (src/api/app.ts) reads it as `{}` instead, and the
 * whole feature quietly depends on that, since the dashboard swallows the
 * error and the only symptom would be a tour that shows up again tomorrow.
 */
function tourDone(accessToken: string | null) {
  return app.inject({
    method: 'POST',
    url: '/auth/tour-done',
    headers: {
      'content-type': 'application/json',
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
    },
  });
}

beforeAll(async () => {
  app = await buildApp();
  await clearBrakes();

  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Tour Signup',
      email: emailFor('signup'),
      password: 'integration-pw-1',
      organizationName: 'Tour Org',
    },
  });
  expect(signup.statusCode).toBe(201);
  signupToken = json(signup).accessToken;
});

afterAll(async () => {
  const { rows: users } = await pool.query('select id from users where email like $1', [
    `tour-%-${suffix}@itest.local`,
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

describe('1. the password sign-up door arms the tour', () => {
  test('a fresh account reads tourPending: true from /auth/me', async () => {
    expect(await tourPendingOverTheWire(signupToken)).toBe(true);
    expect(await tourPendingInTheRow(emailFor('signup'))).toBe(true);
  });
});

describe('2. POST /auth/tour-done', () => {
  test('a stranger cannot clear anybody’s tour (401)', async () => {
    const res = await tourDone(null);
    expect(res.statusCode).toBe(401);
    // ...and the flag is untouched by the attempt.
    expect(await tourPendingInTheRow(emailFor('signup'))).toBe(true);
  });

  test('clears the flag, and /auth/me agrees', async () => {
    const res = await tourDone(signupToken);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true });

    expect(await tourPendingOverTheWire(signupToken)).toBe(false);
    expect(await tourPendingInTheRow(emailFor('signup'))).toBe(false);
  });

  test('is idempotent — a second call is another 200 and another false', async () => {
    // The dashboard fires this unawaited and never retries, and a Settings
    // replay fires it again on a flag that is already false. Both must be
    // ordinary successes, not 404s or 409s.
    const again = await tourDone(signupToken);
    expect(again.statusCode).toBe(200);
    expect(json(again)).toEqual({ ok: true });
    expect(await tourPendingInTheRow(emailFor('signup'))).toBe(false);
  });
});

describe('3. the Google doors', () => {
  test('the CREATE branch arms the tour', async () => {
    const email = emailFor('gcreate');
    const resolved = await findOrCreateGoogleUser({
      sub: `tour-google-sub-create-${suffix}`,
      email,
      name: 'Tour Google Create',
    });
    expect('user' in resolved).toBe(true);
    expect(await tourPendingInTheRow(email)).toBe(true);

    // And the session that sign-in mints sees it, same as a password signup.
    const token = (await mintSessionTokens(app, (resolved as { user: { id: string } }).user.id))
      .accessToken;
    expect(await tourPendingOverTheWire(token)).toBe(true);
  });

  test('the LINK branch does NOT — that account already existed', async () => {
    // A password account that predates the tour: created through the repo, the
    // way every pre-U5 row was, so its flag is the column default.
    const email = emailFor('glink');
    const existing = await createUser(email, 'Tour Google Link', 'not-a-real-hash');
    expect(existing).toBeTruthy();
    expect(existing!.tour_pending).toBe(false);

    const resolved = await findOrCreateGoogleUser({
      sub: `tour-google-sub-link-${suffix}`,
      email,
      name: 'Tour Google Link',
    });
    // Same row, now carrying the Google identity...
    expect((resolved as { user: { id: string } }).user.id).toBe(existing!.id);
    // ...and no tour: gaining a second way to sign in is not arriving for the
    // first time.
    expect(await tourPendingInTheRow(email)).toBe(false);
  });
});

describe('4. accounts that were never a person walking through a door', () => {
  test('one minted by the provisioning fixture owes nothing', async () => {
    // This is the shape of EVERY row that existed before U5 shipped (the
    // operator's included): provisioned out of band, never through a sign-up
    // handler. The column default is what keeps them all silent, which is why
    // the flag arms in the two doors and not inside provisionAccount().
    const email = emailFor('fixture');
    const user = await createUser(email, 'Tour Fixture', 'not-a-real-hash');
    expect(user).toBeTruthy();
    await provisionAccount(user!, 'Tour Fixture Org');

    expect(await tourPendingInTheRow(email)).toBe(false);
    const token = (await mintSessionTokens(app, user!.id)).accessToken;
    expect(await tourPendingOverTheWire(token)).toBe(false);
  });
});
