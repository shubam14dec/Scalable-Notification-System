/**
 * Phase 20 Slice E — Twilio SMS delivery receipts + StatusCallback attachment.
 *
 * The webhook (POST /webhooks/sms/twilio/:messageId) is signature-authed:
 * base64(HMAC-SHA1(authToken, url + sorted key+value concat)). We stand up a
 * real twilio integration with a KNOWN authToken (sealed correctly through the
 * integrations API), insert a real sms message row, and drive the webhook with
 * a signature we compute the same way — controlling the signed url by setting
 * host + x-forwarded-proto headers explicitly (the route rebuilds the url from
 * exactly those). The provider half stubs global fetch and toggles the runtime
 * public-url to prove StatusCallback is attached only when a real http base
 * exists. Everything is scoped to a fresh org and cleaned in afterAll (R1).
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'bullmq';
import { buildApp } from '../../src/api/app';
import { closeQueues, getQueue, QUEUE } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import {
  upsertSubscriber,
  insertEvent,
  insertMessage,
  updateMessage,
  isSuppressed,
} from '../../src/db/repositories';
import { processStatus } from '../../src/workers/processors/status.processor';
import { TwilioSmsProvider } from '../../src/providers/sms';
import { setPublicUrl, clearPublicUrlCache } from '../../src/config/public-url';
import { env } from '../../src/config/env';

const PUBLIC_URL_KEY = 'config:public-url'; // mirrors src/config/public-url.ts (KEY not exported)
const HOST = 'sms.itest.local';
const AUTH_TOKEN = 'known-auth-token-abcdef123456';

let app: FastifyInstance;
let devKey = '';
let tenantId = '';
let integrationId = '';
const email = `smsrcpt-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
const envPublicUrl = env.publicUrl;

const json = (res: { body: string }) => JSON.parse(res.body);

/** Twilio's signature over a param object (values as the route decodes them). */
function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/** POST a form-encoded Twilio callback with a signature over the given token. */
async function postCallback(
  messageId: string,
  params: Record<string, string>,
  signingToken = AUTH_TOKEN,
) {
  const url = `https://${HOST}/webhooks/sms/twilio/${messageId}`;
  return app.inject({
    method: 'POST',
    url: `/webhooks/sms/twilio/${messageId}`,
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
      host: HOST,
      'x-forwarded-proto': 'https',
      'x-twilio-signature': twilioSignature(signingToken, url, params),
    },
    payload: new URLSearchParams(params).toString(),
  });
}

/** Insert a real sms message row (sent), returning its id. sid == provider_message_id. */
async function seedSmsMessage(opts: { phone: string; sid: string }): Promise<string> {
  const sub = await upsertSubscriber(tenantId, { subscriberId: `sms-${opts.sid}`, phone: opts.phone });
  const txn = `sms-txn-${opts.sid}`;
  const event = await insertEvent({
    tenantId,
    transactionId: txn,
    workflowKey: 'sms-receipt-test',
    priority: 'p1',
    payload: {},
    recipients: [{ subscriberId: sub.external_id }],
  });
  const msg = await insertMessage({
    tenantId,
    eventId: event!.id,
    subscriberId: sub.id,
    transactionId: txn,
    channel: 'sms',
    stepIndex: 0,
    priority: 'p1',
    content: { body: 'hi', to: { phone: opts.phone } },
    status: 'sent',
  });
  await updateMessage(msg.id, {
    status: 'sent',
    provider: `twilio:${integrationId.slice(0, 8)}`,
    providerMessageId: opts.sid,
  });
  return msg.id;
}

/** The STATUS-queue job carrying a given providerMessageId, if any. */
async function statusJobFor(providerMessageId: string): Promise<Job | undefined> {
  const jobs = await getQueue(QUEUE.STATUS).getJobs(['waiting', 'prioritized', 'delayed', 'active', 'completed']);
  return jobs.find((j) => j.data?.providerMessageId === providerMessageId);
}

beforeAll(async () => {
  app = await buildApp();
  const signup = json(
    await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { name: 'SMS Rcpt', email, password: 'integration-pw-1', organizationName: 'SMS Rcpt Org' },
    }),
  );
  devKey = signup.environments.find((e: { name: string }) => e.name === 'Development').apiKey;
  const probe = await app.inject({
    method: 'PUT',
    url: '/v1/subscribers',
    headers: { 'x-api-key': devKey },
    payload: { subscriberId: 'tenant-probe' },
  });
  const { rows } = await pool.query('select tenant_id from subscribers where id = $1', [json(probe).id]);
  tenantId = rows[0].tenant_id;

  // A twilio integration sealed with a KNOWN authToken (so we can sign like Twilio).
  const created = await app.inject({
    method: 'POST',
    url: '/v1/integrations',
    headers: { 'x-api-key': devKey },
    payload: {
      channel: 'sms',
      provider: 'twilio',
      credentials: { accountSid: 'AC0000000000000000000000000000test', authToken: AUTH_TOKEN, from: '+15005550006' },
    },
  });
  expect(created.statusCode).toBe(201);
  integrationId = json(created).id;
});

afterAll(async () => {
  // Restore runtime public-url state (R1: a leaked config key breaks other suites).
  await redis.del(PUBLIC_URL_KEY);
  env.publicUrl = envPublicUrl;
  clearPublicUrlCache();
  await getQueue(QUEUE.STATUS).obliterate({ force: true });

  if (tenantId) {
    await pool.query('delete from messages where tenant_id = $1', [tenantId]);
    await pool.query('delete from events where tenant_id = $1', [tenantId]);
    await pool.query('delete from suppressions where tenant_id = $1', [tenantId]);
    await pool.query('delete from integrations where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
  }
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('Twilio delivery-receipt webhook', () => {
  test('a valid "delivered" callback → 204, enqueues a status job that flips the row to delivered', async () => {
    const sid = 'SM_delivered_1';
    const messageId = await seedSmsMessage({ phone: '+15005550001', sid });

    const res = await postCallback(messageId, { MessageStatus: 'delivered', MessageSid: sid });
    expect(res.statusCode).toBe(204);

    const job = await statusJobFor(sid);
    expect(job).toBeTruthy();
    expect(job!.data.status).toBe('delivered');

    // Run the shared status processor in-process (no worker fleet under test).
    await processStatus(job as Job<{ provider: string; providerMessageId: string; status: string }>);
    const { rows } = await pool.query('select status from messages where id = $1', [messageId]);
    expect(rows[0].status).toBe('delivered');
  });

  test('a wrong signature is rejected with 403', async () => {
    const sid = 'SM_badsig_1';
    const messageId = await seedSmsMessage({ phone: '+15005550002', sid });
    const res = await postCallback(
      messageId,
      { MessageStatus: 'delivered', MessageSid: sid },
      'the-wrong-auth-token',
    );
    expect(res.statusCode).toBe(403);
  });

  test('an unknown message id is 404 (before any signature work)', async () => {
    const res = await postCallback('00000000-0000-0000-0000-000000000000', {
      MessageStatus: 'delivered',
      MessageSid: 'SM_ghost',
    });
    expect(res.statusCode).toBe(404);
  });

  test('an intermediate "sent" status → 204 and NO status job', async () => {
    const sid = 'SM_intermediate_1';
    const messageId = await seedSmsMessage({ phone: '+15005550003', sid });
    const res = await postCallback(messageId, { MessageStatus: 'sent', MessageSid: sid });
    expect(res.statusCode).toBe(204);
    expect(await statusJobFor(sid)).toBeUndefined();
  });

  test('ErrorCode 21610 (STOP) writes an sms suppression with reason "stop"', async () => {
    const phone = '+15005550004';
    const sid = 'SM_stop_1';
    const messageId = await seedSmsMessage({ phone, sid });
    const res = await postCallback(messageId, {
      MessageStatus: 'failed',
      MessageSid: sid,
      ErrorCode: '21610',
    });
    expect(res.statusCode).toBe(204);
    expect(await isSuppressed(tenantId, 'sms', phone)).toBe(true);
    const { rows } = await pool.query(
      'select reason from suppressions where tenant_id = $1 and channel = $2 and address = $3',
      [tenantId, 'sms', phone],
    );
    expect(rows[0].reason).toBe('stop');
  });
});

describe('TwilioSmsProvider StatusCallback attachment', () => {
  const originalFetch = globalThis.fetch;

  function stubFetch(): { lastBody: URLSearchParams | null } {
    const captured: { lastBody: URLSearchParams | null } = { lastBody: null };
    globalThis.fetch = (async (_url: string, init?: { body?: unknown }) => {
      captured.lastBody = (init?.body as URLSearchParams) ?? null;
      return { ok: true, status: 200, json: async () => ({ sid: 'SMfetchstub' }) };
    }) as unknown as typeof fetch;
    return captured;
  }

  afterAll(() => {
    globalThis.fetch = originalFetch;
  });

  test('attaches StatusCallback when a real http public-url is set', async () => {
    const captured = stubFetch();
    await setPublicUrl(`https://${HOST}`); // write-through: cache updated instantly
    const provider = new TwilioSmsProvider(
      { accountSid: 'AC0000000000000000000000000000test', authToken: AUTH_TOKEN, from: '+15005550006' },
      'twilio:test',
    );
    const res = await provider.send({ messageId: 'm-cb-1', tenantId, to: { phone: '+15005550005' }, body: 'hi' });
    expect(res.providerMessageId).toBe('SMfetchstub');
    expect(captured.lastBody?.get('StatusCallback')).toBe(`https://${HOST}/webhooks/sms/twilio/m-cb-1`);
  });

  test('omits StatusCallback when no real http base is configured', async () => {
    const captured = stubFetch();
    // No redis key + empty env base → getPublicUrl returns '' → guard omits it.
    await redis.del(PUBLIC_URL_KEY);
    env.publicUrl = '';
    clearPublicUrlCache();
    const provider = new TwilioSmsProvider(
      { accountSid: 'AC0000000000000000000000000000test', authToken: AUTH_TOKEN, from: '+15005550006' },
      'twilio:test',
    );
    await provider.send({ messageId: 'm-cb-2', tenantId, to: { phone: '+15005550005' }, body: 'hi' });
    expect(captured.lastBody?.has('StatusCallback')).toBe(false);
  });
});
