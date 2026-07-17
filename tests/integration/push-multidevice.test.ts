/**
 * Phase 20 Slice B — push multi-device fan-out, SMS segment guard, dead-token
 * cleanup, phone normalization, and push-URL SSRF gating.
 *
 * Boots the real Fastify app in-process and drives fan-out/delivery directly
 * (the same pattern api.test.ts uses), against the real Postgres + Redis from
 * docker-compose. A fresh random org per run keeps it isolated; REDIS_DB=15
 * (tests/setup.ts) keeps enqueued jobs invisible to any dev worker fleet.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'bullmq';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { processFanout } from '../../src/workers/processors/fanout.processor';
import { processDelivery } from '../../src/workers/processors/delivery.processor';
import { upsertDeviceToken, listDeviceTokens } from '../../src/db/device-tokens.repo';
import { FcmPushProvider } from '../../src/providers/push';
import { PermanentError } from '../../src/shared/errors';

let app: FastifyInstance;
let devKey = '';
let tenantId = '';
const email = `push-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;

const json = (res: { body: string }) => JSON.parse(res.body);

/** PUT a subscriber, returning its durable uuid. */
async function putSubscriber(payload: Record<string, unknown>): Promise<{ status: number; id?: string; body: unknown }> {
  const res = await app.inject({
    method: 'PUT',
    url: '/v1/subscribers',
    headers: { 'x-api-key': devKey },
    payload,
  });
  return { status: res.statusCode, id: res.statusCode === 200 ? json(res).id : undefined, body: json(res) };
}

/** Trigger a workflow and return the created eventId. */
async function trigger(workflowKey: string, subscriberId: string, payload: Record<string, unknown> = {}): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/events/trigger',
    headers: { 'x-api-key': devKey },
    payload: { workflowKey, to: [{ subscriberId }], payload },
  });
  expect(res.statusCode).toBe(202);
  return json(res).eventId;
}

/** Run stage-2 fan-out for an event over a single direct recipient. */
async function fanout(eventId: string, subscriberId: string): Promise<void> {
  await processFanout({ data: { eventId, recipients: [{ subscriberId }] } } as Job);
}

async function messagesForEvent(eventId: string) {
  const { rows } = await pool.query(
    `select id, channel, step_index, device_key, status, error, content
       from messages where event_id = $1 order by device_key`,
    [eventId],
  );
  return rows as Array<{
    id: string;
    channel: string;
    step_index: number;
    device_key: string;
    status: string;
    error: string | null;
    content: { to: Record<string, string>; push?: { clickUrl?: string; imageUrl?: string; data?: Record<string, string> } };
  }>;
}

beforeAll(async () => {
  app = await buildApp();
  const signup = json(
    await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { name: 'Push ITest', email, password: 'integration-pw-1', organizationName: 'Push Org' },
    }),
  );
  devKey = signup.environments.find((e: { name: string }) => e.name === 'Development').apiKey;
  // The dev environment IS the tenant; confirm via a subscriber's tenant_id.
  const sub = await putSubscriber({ subscriberId: 'tenant-probe' });
  const { rows } = await pool.query('select tenant_id from subscribers where id = $1', [sub.id]);
  tenantId = rows[0].tenant_id;
});

afterAll(async () => {
  if (tenantId) {
    await pool.query('delete from messages where tenant_id = $1', [tenantId]);
    await pool.query('delete from events where tenant_id = $1', [tenantId]);
    await pool.query('delete from device_tokens where tenant_id = $1', [tenantId]);
    await pool.query('delete from suppressions where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
  }
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('multi-device push fan-out', () => {
  test('a push step produces one row per device, distinct device_key + token, with rendered push extras', async () => {
    const sub = await putSubscriber({ subscriberId: 'push-two-devices' });
    expect(sub.status).toBe(200);
    const dev1 = await upsertDeviceToken(tenantId, sub.id!, 'tok-android-1', 'android');
    const dev2 = await upsertDeviceToken(tenantId, sub.id!, 'tok-web-2', 'web');

    const save = await app.inject({
      method: 'PUT',
      url: '/v1/workflows',
      headers: { 'x-api-key': devKey },
      payload: {
        key: 'push-rich',
        name: 'Push rich',
        steps: [
          {
            channel: 'push',
            subject: 'Order {{orderId}}',
            body: 'Your order {{orderId}} shipped',
            push: {
              clickUrl: 'https://example.com/orders/{{orderId}}', // var-bearing → SSRF skipped
              imageUrl: 'https://example.com/img.png',
              data: { orderId: '{{orderId}}', kind: 'promo', blank: '' }, // blank renders empty → omitted
            },
          },
        ],
      },
    });
    expect(save.statusCode).toBe(200);

    const eventId = await trigger('push-rich', 'push-two-devices', { orderId: 'A123' });
    await fanout(eventId, 'push-two-devices');

    const rows = await messagesForEvent(eventId);
    expect(rows).toHaveLength(2);
    // Distinct device_key = device row ids; distinct tokens in content.to.
    const keys = rows.map((r) => r.device_key).sort();
    expect(keys).toEqual([dev1.id, dev2.id].sort());
    const tokens = rows.map((r) => r.content.to.pushToken).sort();
    expect(tokens).toEqual(['tok-android-1', 'tok-web-2']);
    for (const r of rows) {
      expect(r.status).toBe('queued');
      expect(r.content.to.deviceId).toBe(r.device_key);
      // Rendered extras snapshot: vars resolved, empty ({{missing}}) dropped.
      expect(r.content.push?.clickUrl).toBe('https://example.com/orders/A123');
      expect(r.content.push?.imageUrl).toBe('https://example.com/img.png');
      expect(r.content.push?.data).toEqual({ orderId: 'A123', kind: 'promo' });
    }
  });

  test('a subscriber with no devices gets one skipped row with device_key ""', async () => {
    await putSubscriber({ subscriberId: 'push-no-device' });
    // reuse the push-rich workflow
    const eventId = await trigger('push-rich', 'push-no-device', { orderId: 'B1' });
    await fanout(eventId, 'push-no-device');

    const rows = await messagesForEvent(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe('skipped');
    expect(rows[0].error).toBe('subscriber has no push address');
    expect(rows[0].device_key).toBe('');
  });

  test('non-push channels remain single-row with device_key "" (byte-identical)', async () => {
    await putSubscriber({ subscriberId: 'inapp-user' });
    await app.inject({
      method: 'PUT',
      url: '/v1/workflows',
      headers: { 'x-api-key': devKey },
      payload: { key: 'inapp-flow', name: 'Inapp', steps: [{ channel: 'inapp', body: 'hi {{n}}' }] },
    });
    const eventId = await trigger('inapp-flow', 'inapp-user', { n: 'x' });
    await fanout(eventId, 'inapp-user');
    const rows = await messagesForEvent(eventId);
    expect(rows).toHaveLength(1);
    expect(rows[0].device_key).toBe('');
    expect(rows[0].status).toBe('queued');
  });
});

describe('SMS segment guard', () => {
  test('a body over MAX_SMS_SEGMENTS fails permanently before any provider call', async () => {
    const sub = await putSubscriber({ subscriberId: 'sms-user', phone: '+15005550006' });
    expect(sub.status).toBe(200);
    await app.inject({
      method: 'PUT',
      url: '/v1/workflows',
      headers: { 'x-api-key': devKey },
      payload: {
        key: 'sms-long',
        name: 'SMS long',
        // 1600 GSM-7 septets → ceil(1600/153) = 11 segments > 10.
        steps: [{ channel: 'sms', body: 'A'.repeat(1600) }],
      },
    });
    const eventId = await trigger('sms-long', 'sms-user');
    await fanout(eventId, 'sms-user');

    const [msg] = await messagesForEvent(eventId);
    expect(msg.channel).toBe('sms');
    expect(msg.status).toBe('queued');

    // Delivery must reject (permanent → UnrecoverableError, straight to DLQ).
    // attemptsMade mirrors a real BullMQ job (0 on first attempt).
    await expect(
      processDelivery({ data: { messageId: msg.id }, attemptsMade: 0 } as unknown as Job),
    ).rejects.toThrow();

    const { rows } = await pool.query('select status, error, provider from messages where id = $1', [msg.id]);
    expect(rows[0].status).toBe('failed');
    // Guard fired BEFORE the (mock) provider — no provider recorded, and the
    // error is the segment message, not a provider send result.
    expect(rows[0].provider).toBeNull();
    expect(rows[0].error).toMatch(/11 segments/);
    expect(rows[0].error).toMatch(/maximum is 10/);
  });
});

describe('dead FCM token cleanup', () => {
  test('registration-token-not-registered deletes the device row and suppresses (backstop)', async () => {
    const sub = await putSubscriber({ subscriberId: 'dead-token-user' });
    const token = 'dead-fcm-token-xyz';
    await upsertDeviceToken(tenantId, sub.id!, token, 'ios');
    expect((await listDeviceTokens(tenantId, sub.id!)).some((d) => d.token === token)).toBe(true);

    const provider = new FcmPushProvider({ serviceAccountJson: '{}' }, 'itest-fcm');
    // Stub the lazily-initialised messaging client so no real Firebase init
    // happens; it throws the dead-token code FCM returns for stale tokens.
    (provider as unknown as { messagingPromise: Promise<unknown> }).messagingPromise = Promise.resolve({
      send: async () => {
        throw { code: 'messaging/registration-token-not-registered' };
      },
    });

    await expect(
      provider.send({ messageId: 'm1', tenantId, to: { pushToken: token }, body: 'hi' }),
    ).rejects.toBeInstanceOf(PermanentError);

    // Primary: device row deleted. Backstop: address suppressed.
    expect((await listDeviceTokens(tenantId, sub.id!)).some((d) => d.token === token)).toBe(false);
    const { rows } = await pool.query(
      'select 1 from suppressions where tenant_id = $1 and channel = $2 and address = $3',
      [tenantId, 'push', token],
    );
    expect(rows).toHaveLength(1);
  });
});

describe('phone normalization + push-URL SSRF at authoring', () => {
  test('subscriber phone without + is rejected with an E.164 hint', async () => {
    const res = await putSubscriber({ subscriberId: 'bad-phone', phone: '9901489187' });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toMatch(/E\.164/);
  });

  test('subscriber phone with separators is normalized and stored', async () => {
    const res = await putSubscriber({ subscriberId: 'ok-phone', phone: '+91 99014-89187' });
    expect(res.status).toBe(200);
    const { rows } = await pool.query('select phone from subscribers where id = $1', [res.id]);
    expect(rows[0].phone).toBe('+919901489187');
  });

  test('inline trigger recipient with a bad phone is rejected', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/workflows',
      headers: { 'x-api-key': devKey },
      payload: { key: 'sms-x', name: 'x', steps: [{ channel: 'sms', body: 'hi' }] },
    });
    const res = await app.inject({
      method: 'POST',
      url: '/v1/events/trigger',
      headers: { 'x-api-key': devKey },
      payload: { workflowKey: 'sms-x', to: [{ subscriberId: 'z', phone: '12345' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  test('push imageUrl pointing at internal infrastructure is rejected (SSRF)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workflows',
      headers: { 'x-api-key': devKey },
      payload: {
        key: 'push-ssrf',
        name: 'ssrf',
        steps: [{ channel: 'push', body: 'hi', push: { imageUrl: 'http://169.254.169.254/latest/meta-data/' } }],
      },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(json(res))).toMatch(/imageUrl/);
  });

  test('a var-bearing push URL is allowed through authoring (resolves at fan-out)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workflows',
      headers: { 'x-api-key': devKey },
      payload: {
        key: 'push-var-url',
        name: 'var url',
        steps: [{ channel: 'push', body: 'hi', push: { clickUrl: 'https://{{host}}/x' } }],
      },
    });
    expect(res.statusCode).toBe(200);
  });

  test('push extras on a non-push step are rejected', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workflows',
      headers: { 'x-api-key': devKey },
      payload: {
        key: 'push-wrong-channel',
        name: 'wrong',
        steps: [{ channel: 'email', body: 'hi', push: { clickUrl: 'https://example.com' } }],
      },
    });
    expect(res.statusCode).toBe(400);
  });
});
