/**
 * Slice U2 — PATCH /v1/account/organization, the Settings page's Organization
 * card, end to end against the real app.
 *
 * Everything is real: a real signup provisions the org and its environments, a
 * real second user is added as a plain member through the real repo, and the
 * assertion that a rename "worked" is made against /auth/me — the SAME payload
 * the dashboard's environment switcher renders ("{org} — {env}"), not the
 * route's own echo. That is the property the slice actually promises.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { pool } from '../../src/db/pool';
import { redis } from '../../src/shared/redis';
import { addMember, createUser } from '../../src/db/accounts.repo';
import { mintSessionTokens } from '../../src/api/routes/auth';

let app: FastifyInstance;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const emailFor = (who: string) => `orgrename-${who}-${suffix}@itest.local`;

const json = (res: { body: string }) => JSON.parse(res.body);

/** The owner's session, their org, and the Development environment id. */
let ownerToken = '';
let orgId = '';
let devEnvId = '';
/** A second user in the SAME org, role `member`. */
let memberToken = '';

async function clearBrake(name: string): Promise<void> {
  const keys = await redis.keys(`${name}-rl:*`);
  if (keys.length) await redis.del(...keys);
}

/** Rename as a given caller. `envId` names the org, exactly as the dashboard's
 *  api client does on every request. */
function rename(
  accessToken: string | null,
  body: unknown,
  envId: string | null = devEnvId,
) {
  return app.inject({
    method: 'PATCH',
    url: '/v1/account/organization',
    headers: {
      ...(accessToken ? { authorization: `Bearer ${accessToken}` } : {}),
      ...(envId ? { 'x-environment-id': envId } : {}),
    },
    payload: body as Record<string, unknown>,
  });
}

/** The org name as the SWITCHER would render it — straight out of /auth/me. */
async function orgNameInEnvironmentsListing(accessToken: string): Promise<string> {
  const res = await app.inject({
    method: 'GET',
    url: '/auth/me',
    headers: { authorization: `Bearer ${accessToken}` },
  });
  expect(res.statusCode).toBe(200);
  const org = json(res).organizations.find((o: { id: string }) => o.id === orgId);
  return org.name;
}

beforeAll(async () => {
  app = await buildApp();

  await clearBrake('signup');
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Org Rename Owner',
      email: emailFor('owner'),
      password: 'integration-pw-1',
      organizationName: 'Original Org Name',
    },
  });
  expect(signup.statusCode).toBe(201);
  ownerToken = json(signup).accessToken;
  devEnvId = json(signup).environments.find((e: { name: string }) => e.name === 'Development').id;

  const { rows } = await pool.query(
    'select organization_id from tenants where id = $1',
    [devEnvId],
  );
  orgId = rows[0].organization_id;

  // A colleague in the same organization with the lowest role. Built through
  // the repo (createUser + addMember) because there is no invite endpoint yet —
  // the ROW is what the authorization gate reads, and this is the row a future
  // invite would write.
  const member = await createUser(emailFor('member'), 'Org Rename Member', 'not-a-real-hash');
  expect(member).toBeTruthy();
  await addMember(orgId, member!.id, 'member');
  memberToken = mintSessionTokens(app, member!.id).accessToken;
});

beforeEach(async () => {
  const keys = await redis.keys('*-rl:*');
  if (keys.length) await redis.del(...keys);
  // Every test starts from the same known name.
  await pool.query('update organizations set name = $2 where id = $1', [orgId, 'Original Org Name']);
});

afterAll(async () => {
  const { rows: users } = await pool.query('select id from users where email like $1', [
    `orgrename-%-${suffix}@itest.local`,
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

describe('an owner renames the organization', () => {
  test('200, and the environments listing the switcher reads shows the new name', async () => {
    expect(await orgNameInEnvironmentsListing(ownerToken)).toBe('Original Org Name');

    const res = await rename(ownerToken, { name: 'Renamed By Owner' });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ organization: { id: orgId, name: 'Renamed By Owner' } });

    // The property that matters: the sidebar's source of truth moved with it,
    // for every member of the org, with no schema or cache of its own.
    expect(await orgNameInEnvironmentsListing(ownerToken)).toBe('Renamed By Owner');
    expect(await orgNameInEnvironmentsListing(memberToken)).toBe('Renamed By Owner');

    // ...and nothing else did: the environments are untouched.
    const me = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${ownerToken}` },
    });
    const org = json(me).organizations.find((o: { id: string }) => o.id === orgId);
    expect(org.environments.map((e: { name: string }) => e.name).sort()).toEqual([
      'Development',
      'Production',
    ]);
  });

  test('surrounding whitespace is trimmed, not stored', async () => {
    const res = await rename(ownerToken, { name: '   Padded Name   ' });
    expect(res.statusCode).toBe(200);
    expect(json(res).organization.name).toBe('Padded Name');
    expect(await orgNameInEnvironmentsListing(ownerToken)).toBe('Padded Name');
  });

  test('the org resolves from a sole membership when no environment is named', async () => {
    const res = await rename(ownerToken, { name: 'No Header Name' }, null);
    expect(res.statusCode).toBe(200);
    expect(json(res).organization.name).toBe('No Header Name');
  });
});

describe('a plain member cannot rename it', () => {
  test('403 with the reason, and the name is unchanged', async () => {
    const res = await rename(memberToken, { name: 'Renamed By A Member' });
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('only an owner or admin can rename the organization');
    expect(await orgNameInEnvironmentsListing(ownerToken)).toBe('Original Org Name');
  });
});

describe('the name is validated before anything is written', () => {
  test('an empty name is a 400', async () => {
    const res = await rename(ownerToken, { name: '' });
    expect(res.statusCode).toBe(400);
    expect(await orgNameInEnvironmentsListing(ownerToken)).toBe('Original Org Name');
  });

  test('a whitespace-only name is a 400 — it trims to empty', async () => {
    const res = await rename(ownerToken, { name: '     ' });
    expect(res.statusCode).toBe(400);
    expect(await orgNameInEnvironmentsListing(ownerToken)).toBe('Original Org Name');
  });

  test('a missing name field is a 400', async () => {
    const res = await rename(ownerToken, {});
    expect(res.statusCode).toBe(400);
  });

  test('121 characters is a 400; 120 is accepted', async () => {
    const tooLong = await rename(ownerToken, { name: 'x'.repeat(121) });
    expect(tooLong.statusCode).toBe(400);
    expect(await orgNameInEnvironmentsListing(ownerToken)).toBe('Original Org Name');

    const atTheLimit = await rename(ownerToken, { name: 'y'.repeat(120) });
    expect(atTheLimit.statusCode).toBe(200);
    expect(json(atTheLimit).organization.name).toBe('y'.repeat(120));
  });
});

describe('authentication', () => {
  test('no access token is a 401', async () => {
    const res = await rename(null, { name: 'Stranger Chosen Name' });
    expect(res.statusCode).toBe(401);
    expect(await orgNameInEnvironmentsListing(ownerToken)).toBe('Original Org Name');
  });

  test('a garbage bearer token is a 401', async () => {
    const res = await rename('not-a-real-jwt', { name: 'Stranger Chosen Name' });
    expect(res.statusCode).toBe(401);
  });
});

describe('a non-member cannot rename someone else’s organization', () => {
  test('naming an environment they are not a member of is a 403', async () => {
    await clearBrake('signup');
    const outsider = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: {
        name: 'Org Rename Outsider',
        email: emailFor('outsider'),
        password: 'integration-pw-1',
        organizationName: 'Outsider Org',
      },
    });
    expect(outsider.statusCode).toBe(201);

    const res = await rename(json(outsider).accessToken, { name: 'Hijacked' }, devEnvId);
    expect(res.statusCode).toBe(403);
    expect(json(res).error).toBe('not a member of this organization');
    expect(await orgNameInEnvironmentsListing(ownerToken)).toBe('Original Org Name');
  });
});
