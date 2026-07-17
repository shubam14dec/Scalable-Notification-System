/**
 * Phase 20 Slice E — device-token repo + registration routes (api-key and
 * subscriber-token sides), the legacy push_token write-mirror, and the two
 * push-workflow schema gates not already covered by push-multidevice.test.ts.
 *
 * Boots the real Fastify app in-process against the docker Postgres + Redis
 * (REDIS_DB 15). A fresh random org per run keeps it isolated; everything this
 * suite writes is scoped to its tenant and deleted in afterAll (R1).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { upsertSubscriber } from '../../src/db/repositories';
import {
  upsertDeviceToken,
  listDeviceTokens,
  deleteDeviceToken,
} from '../../src/db/device-tokens.repo';

let app: FastifyInstance;
let devKey = '';
let tenantId = '';
const email = `devtok-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;

const json = (res: { body: string }) => JSON.parse(res.body);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Create/return a subscriber row id for an external id. */
async function subRowId(subscriberId: string): Promise<string> {
  const sub = await upsertSubscriber(tenantId, { subscriberId });
  return sub.id;
}

async function mintSubscriberToken(subscriberId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/subscriber-tokens',
    headers: { 'x-api-key': devKey },
    payload: { subscriberId, ttlSeconds: 3600 },
  });
  return json(res).token as string;
}

beforeAll(async () => {
  app = await buildApp();
  const signup = json(
    await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { name: 'DevTok IT', email, password: 'integration-pw-1', organizationName: 'DevTok Org' },
    }),
  );
  devKey = signup.environments.find((e: { name: string }) => e.name === 'Development').apiKey;
  // The dev environment IS the tenant; confirm via a subscriber's tenant_id.
  const probe = await app.inject({
    method: 'PUT',
    url: '/v1/subscribers',
    headers: { 'x-api-key': devKey },
    payload: { subscriberId: 'tenant-probe' },
  });
  const { rows } = await pool.query('select tenant_id from subscribers where id = $1', [json(probe).id]);
  tenantId = rows[0].tenant_id;
});

afterAll(async () => {
  if (tenantId) {
    await pool.query('delete from device_tokens where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
  }
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('device-tokens repo', () => {
  test('upserting the same token twice returns the same row id and bumps last_seen', async () => {
    const sid = await subRowId('repo-same-token');
    const first = await upsertDeviceToken(tenantId, sid, 'tok-same', 'android');
    await sleep(5); // make the last_seen bump observably monotonic
    const second = await upsertDeviceToken(tenantId, sid, 'tok-same', 'android');

    expect(second.id).toBe(first.id);
    expect(new Date(second.last_seen_at).getTime()).toBeGreaterThanOrEqual(
      new Date(first.last_seen_at).getTime(),
    );
    expect(await listDeviceTokens(tenantId, sid)).toHaveLength(1);
  });

  test('a token re-points to a new subscriber on upsert (login-switch semantics)', async () => {
    const a = await subRowId('repo-login-a');
    const b = await subRowId('repo-login-b');
    const shared = 'tok-shared-device';

    const firstRow = await upsertDeviceToken(tenantId, a, shared, 'ios');
    expect((await listDeviceTokens(tenantId, a)).some((d) => d.token === shared)).toBe(true);

    // Same physical device, different login: the row moves to B, keeps its id.
    const movedRow = await upsertDeviceToken(tenantId, b, shared, 'ios');
    expect(movedRow.id).toBe(firstRow.id);
    expect((await listDeviceTokens(tenantId, a)).some((d) => d.token === shared)).toBe(false);
    expect((await listDeviceTokens(tenantId, b)).some((d) => d.token === shared)).toBe(true);
  });

  test('the 11th device evicts the oldest by last_seen (cap 10)', async () => {
    const sid = await subRowId('repo-cap');
    for (let i = 0; i < 11; i++) {
      await upsertDeviceToken(tenantId, sid, `cap-tok-${i}`, 'web');
      await sleep(2); // keep last_seen strictly increasing so eviction is deterministic
    }
    const tokens = (await listDeviceTokens(tenantId, sid)).map((d) => d.token);
    expect(tokens).toHaveLength(10);
    expect(tokens).not.toContain('cap-tok-0'); // oldest evicted
    expect(tokens).toContain('cap-tok-10'); // newest kept
  });

  test('deleteDeviceToken also nulls a matching legacy subscribers.push_token', async () => {
    // upsertSubscriber write-mirrors pushToken into device_tokens AND stores it
    // in the legacy column. Deleting the device must null the column too, so the
    // schema backfill can never resurrect an explicitly-removed device.
    const sub = await upsertSubscriber(tenantId, { subscriberId: 'repo-legacy', pushToken: 'legacy-tok' });
    const before = await pool.query('select push_token from subscribers where id = $1', [sub.id]);
    expect(before.rows[0].push_token).toBe('legacy-tok');

    const deleted = await deleteDeviceToken(tenantId, 'legacy-tok');
    expect(deleted).toBe(true);
    expect((await listDeviceTokens(tenantId, sub.id)).some((d) => d.token === 'legacy-tok')).toBe(false);
    const after = await pool.query('select push_token from subscribers where id = $1', [sub.id]);
    expect(after.rows[0].push_token).toBeNull();
  });
});

describe('device registration routes (api-key side)', () => {
  test('POST registers, GET lists, DELETE removes — the happy path', async () => {
    const reg = await app.inject({
      method: 'POST',
      url: '/v1/subscribers/route-happy/devices',
      headers: { 'x-api-key': devKey },
      payload: { token: 'route-tok-1', platform: 'android' },
    });
    expect(reg.statusCode).toBe(201);
    expect(json(reg).platform).toBe('android');

    const list = await app.inject({
      method: 'GET',
      url: '/v1/subscribers/route-happy/devices',
      headers: { 'x-api-key': devKey },
    });
    expect(list.statusCode).toBe(200);
    expect(json(list).devices.map((d: { token: string }) => d.token)).toEqual(['route-tok-1']);

    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/subscribers/route-happy/devices',
      headers: { 'x-api-key': devKey },
      payload: { token: 'route-tok-1' },
    });
    expect(del.statusCode).toBe(200);
    expect(json(del).deleted).toBe(true);
  });

  test('GET on an unknown subscriber yields no devices (never materializes a row)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/subscribers/route-ghost/devices',
      headers: { 'x-api-key': devKey },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).devices).toEqual([]);
  });

  test('DELETE of a token owned by ANOTHER subscriber is not an oracle: {deleted:false}, token survives', async () => {
    await app.inject({
      method: 'POST',
      url: '/v1/subscribers/route-owner/devices',
      headers: { 'x-api-key': devKey },
      payload: { token: 'route-owned-tok' },
    });
    // A different subscriber tries to delete owner's token.
    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/subscribers/route-other/devices',
      headers: { 'x-api-key': devKey },
      payload: { token: 'route-owned-tok' },
    });
    expect(del.statusCode).toBe(200);
    expect(json(del).deleted).toBe(false);
    // Owner still has it.
    const ownerRowId = await subRowId('route-owner');
    expect((await listDeviceTokens(tenantId, ownerRowId)).some((d) => d.token === 'route-owned-tok')).toBe(true);
  });
});

describe('device registration routes (subscriber-token side, /v1/me/devices)', () => {
  test('a minted subscriber token registers then unregisters its own device', async () => {
    const token = await mintSubscriberToken('me-dev-1');

    const reg = await app.inject({
      method: 'POST',
      url: '/v1/me/devices',
      headers: { 'x-subscriber-token': token },
      payload: { token: 'me-tok-1', platform: 'web' },
    });
    expect(reg.statusCode).toBe(201);
    expect(json(reg).platform).toBe('web');

    // The device landed on the token's own subscriber.
    const rowId = await subRowId('me-dev-1');
    expect((await listDeviceTokens(tenantId, rowId)).some((d) => d.token === 'me-tok-1')).toBe(true);

    const del = await app.inject({
      method: 'DELETE',
      url: '/v1/me/devices',
      headers: { 'x-subscriber-token': token },
      payload: { token: 'me-tok-1' },
    });
    expect(del.statusCode).toBe(200);
    expect(json(del).deleted).toBe(true);
  });

  test('/v1/me/devices without a subscriber token is 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/me/devices',
      payload: { token: 'me-tok-unauth' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('PUT /v1/subscribers: push_token mirror + phone normalization', () => {
  test('a pushToken is write-mirrored into a device_tokens row', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/subscribers',
      headers: { 'x-api-key': devKey },
      payload: { subscriberId: 'put-push', pushToken: 'put-mirror-tok' },
    });
    expect(res.statusCode).toBe(200);
    const rowId = json(res).id;
    expect((await listDeviceTokens(tenantId, rowId)).some((d) => d.token === 'put-mirror-tok')).toBe(true);
  });

  test('an invalid phone is rejected with an E.164 hint', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/subscribers',
      headers: { 'x-api-key': devKey },
      payload: { subscriberId: 'put-badphone', phone: '9901489187' },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(json(res))).toMatch(/E\.164/);
  });

  test('a messy but valid phone is stored normalized', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/subscribers',
      headers: { 'x-api-key': devKey },
      payload: { subscriberId: 'put-okphone', phone: '0091 99014-89187' },
    });
    expect(res.statusCode).toBe(200);
    const { rows } = await pool.query('select phone from subscribers where id = $1', [json(res).id]);
    expect(rows[0].phone).toBe('+919901489187');
  });
});

describe('push-workflow schema gates (not covered by push-multidevice)', () => {
  test('push.data with 11 keys is rejected', async () => {
    const data: Record<string, string> = {};
    for (let i = 0; i < 11; i++) data[`k${i}`] = 'v';
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workflows',
      headers: { 'x-api-key': devKey },
      payload: {
        key: 'push-toomanykeys',
        name: 'too many keys',
        steps: [{ channel: 'push', body: 'hi', push: { data } }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(json(res))).toMatch(/at most 10 keys/);
  });

  test('a literal internal clickUrl is rejected (SSRF gate on clickUrl)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workflows',
      headers: { 'x-api-key': devKey },
      payload: {
        key: 'push-clickurl-ssrf',
        name: 'clickurl ssrf',
        steps: [{ channel: 'push', body: 'hi', push: { clickUrl: 'http://169.254.169.254/x' } }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(json(res))).toMatch(/clickUrl/);
  });
});
