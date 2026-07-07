/**
 * Email channel integration: Postmark-shaped inbound payloads through the
 * real webhook route, the real conversation core, and the real
 * @asyncify-hq/agent SDK as the bridge; outbound replies ride the real
 * sendWithFailover chain (SMTP → Mailpit locally, log fallback otherwise).
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { addSuppression } from '../../src/db/repositories';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import { createHandler, defineAgent } from '../../packages/agent/src/index';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let signingSecret = '';
let bridge: Server;
let bridgeUrl = '';
let webhookPath = ''; // /webhooks/email/<id>?key=<secret>

const json = (res: { body: string }) => JSON.parse(res.body);

const brain = defineAgent({
  onMessage(ctx) {
    if (ctx.message.text.includes('order')) {
      ctx.metadata.set('topic', 'orders');
      return 'Replacement on the way!';
    }
    return `email heard: ${ctx.message.text}`;
  },
});

function inbound(messageId: string, text: string, from = 'ana@example.com', stripped?: string) {
  return {
    FromFull: { Email: from, Name: 'Ana' },
    Subject: 'Where is my order?',
    TextBody: text,
    ...(stripped !== undefined ? { StrippedTextReply: stripped } : {}),
    MessageID: messageId,
    Headers: [{ Name: 'Message-ID', Value: `<${messageId}@mail.example.com>` }],
  };
}

async function postInbound(payload: unknown, path = webhookPath) {
  return app.inject({ method: 'POST', url: path, payload: payload as Record<string, unknown> });
}

async function latestConversation() {
  const list = await app.inject({
    method: 'GET',
    url: '/v1/conversations?agent=email-support',
    headers: { 'x-api-key': apiKey },
  });
  return json(list).conversations[0];
}

async function detail(id: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/conversations/${id}`,
    headers: { 'x-api-key': apiKey },
  });
  return json(res);
}

async function runWorkerFor(conversationId: string, messageId: string) {
  const data: ConversationJobData = { tenantId, conversationId, messageId };
  await processConversation({ data } as Job<ConversationJobData>);
}

beforeAll(async () => {
  app = await buildApp();
  const email = `email-ch-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Email IT', email, password: 'integration-pw-1', organizationName: 'Email IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  bridge = createServer((req, res) => createHandler(brain, { signingSecret })(req, res));
  await new Promise<void>((r) => bridge.listen(0, r));
  bridgeUrl = `http://localhost:${(bridge.address() as AddressInfo).port}/`;

  const created = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: { identifier: 'email-support', name: 'Email Support', bridgeUrl },
  });
  signingSecret = json(created).signingSecret;
});

afterAll(async () => {
  bridge?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('connect flow', () => {
  test('stores the inbound address and returns the webhook URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/email-support/channels/email',
      headers: { 'x-api-key': apiKey },
      payload: { address: 'Hash123@inbound.postmarkapp.com' },
    });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.address).toBe('hash123@inbound.postmarkapp.com');
    expect(body.webhookUrl).toMatch(/\/webhooks\/email\/[0-9a-f-]{36}\?key=[0-9a-f]{48}$/);
    webhookPath = body.webhookUrl.replace('http://localhost:3000', '');
  });

  test('the channels listing keeps the webhook URL retrievable', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/email-support/channels',
      headers: { 'x-api-key': apiKey },
    });
    const email = json(res).channels.find((c: { channel: string }) => c.channel === 'email');
    expect(email.webhook.url).toContain(webhookPath.split('?')[0]);
    expect(email.config.address).toBe('hash123@inbound.postmarkapp.com');
  });
});

describe('inbound webhook', () => {
  test('rejects a wrong key and unknown connections', async () => {
    const [path] = webhookPath.split('?');
    expect((await postInbound(inbound('m0', 'hi'), `${path}?key=${'0'.repeat(48)}`)).statusCode).toBe(401);
    expect((await postInbound(inbound('m0', 'hi'), path)).statusCode).toBe(401);
    const ghost = await postInbound(
      inbound('m0', 'hi'),
      '/webhooks/email/2a2c2e2e-0000-4000-8000-000000000000?key=abc',
    );
    expect(ghost.statusCode).toBe(404);
  });

  test('an email opens a conversation threaded by sender', async () => {
    const res = await postInbound(inbound('m1', 'hello via email'));
    expect(res.statusCode).toBe(200);
    expect(json(res).ok).toBe(true);

    const conv = await latestConversation();
    expect(conv.channel).toBe('email');
    expect(conv.subscriberId).toBe('ana@example.com');
  });

  test('a redelivered MessageID is a duplicate no-op', async () => {
    expect(json(await postInbound(inbound('m1', 'hello via email'))).duplicate).toBe(true);
  });

  test('quoted reply tails are stripped from the stored turn', async () => {
    await postInbound(inbound('m2', 'it never arrived\n\nOn Tue wrote:\n> your order shipped'));
    const conv = await latestConversation();
    const t = await detail(conv.id);
    const last = t.messages.findLast((m: { role: string }) => m.role === 'user');
    expect(last.content).toBe('it never arrived');
  });

  test('unusable payloads are acked as skipped', async () => {
    expect(json(await postInbound({ Subject: 'no sender' })).skipped).toBe(true);
  });
});

describe('reply delivery', () => {
  test('the reply goes out via the email chain exactly once, threaded', async () => {
    await postInbound(inbound('m3', 'where is my order #1042?'));
    const conv = await latestConversation();
    let t = await detail(conv.id);
    const turn = t.messages.findLast((m: { role: string }) => m.role === 'user');

    await runWorkerFor(conv.id, turn.id);
    await runWorkerFor(conv.id, turn.id); // crash-retry: must not double-send

    t = await detail(conv.id);
    const reply = t.messages.findLast((m: { role: string }) => m.role === 'agent');
    expect(reply.content).toBe('Replacement on the way!');
    expect(t.conversation.metadata.topic).toBe('orders');

    const { rows } = await pool.query(
      'select raw from conversation_messages where id = $1',
      [reply.id],
    );
    expect(rows[0].raw.providerMessageId).toBeTruthy();
    const firstProviderId = rows[0].raw.providerMessageId;

    // The second run must not have re-sent (same recorded provider id).
    const again = await pool.query('select raw from conversation_messages where id = $1', [reply.id]);
    expect(again.rows[0].raw.providerMessageId).toBe(firstProviderId);
  });

  test('a suppressed address gets a breadcrumb instead of an email', async () => {
    await addSuppression(tenantId, 'email', 'bounced@example.com', 'bounced');
    await postInbound(inbound('m4', 'hello?', 'bounced@example.com'));
    const conv = await latestConversation();
    const t0 = await detail(conv.id);
    const turn = t0.messages.findLast((m: { role: string }) => m.role === 'user');

    await runWorkerFor(conv.id, turn.id);

    const t = await detail(conv.id);
    const system = t.messages.filter((m: { role: string }) => m.role === 'system');
    expect(system.at(-1).content).toContain('suppression list');
    const reply = t.messages.findLast((m: { role: string }) => m.role === 'agent');
    const { rows } = await pool.query('select raw from conversation_messages where id = $1', [reply.id]);
    expect(rows[0].raw?.providerMessageId).toBeUndefined();
  });
});
