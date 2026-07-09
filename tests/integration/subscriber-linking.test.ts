/**
 * Subscriber linking: one human = one subscriber across channels.
 * Telegram deep-link handshake (/start <token>), email auto-match, history
 * repointing, and THE regression this phase exists for: a linked telegram
 * turn's trigger_workflow reaching the real subscriber's email.
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
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import { createHandler, defineAgent } from '../../packages/agent/src/index';

const BOT_TOKEN = '7000002:AAlink-telegram-token_0123456789ABC';
const REAL_EMAIL = 'ana.real@example.com';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let signingSecret = '';
let bridge: Server;

// ---- stub Telegram API (same shape as telegram.test.ts) ----
let tgStub: Server;
const tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
let webhookSecretSeen = '';

function startTelegramStub(): Promise<void> {
  tgStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = String(req.url).split('/').pop() ?? '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      tgCalls.push({ method, body });
      const results: Record<string, unknown> = {
        getMe: { id: 7000002, is_bot: true, username: 'link_test_bot' },
        setWebhook: true,
        deleteWebhook: true,
        getWebhookInfo: { url: 'https://example.test/hook', pending_update_count: 0 },
        sendMessage: { message_id: 1000 + tgCalls.length },
        answerCallbackQuery: true,
        editMessageText: true,
      };
      if (method === 'setWebhook') webhookSecretSeen = String(body.secret_token ?? '');
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: method in results, result: results[method] }));
    });
  });
  return new Promise((r) => tgStub.listen(0, () => r()));
}

const sends = () => tgCalls.filter((c) => c.method === 'sendMessage');

// The brain triggers a workflow with an EMAIL step — the phantom-email probe.
const brain = defineAgent({
  onMessage(ctx) {
    if (ctx.message.text.includes('order')) {
      ctx.trigger('link-wf', { payload: { name: ctx.subscriber.subscriberId } });
      return 'Confirmation sent!';
    }
    return `brain heard: ${ctx.message.text}`;
  },
});

const json = (res: { body: string }) => JSON.parse(res.body);
let connectionId = '';
const TG_USER = 777001;

function tgText(updateId: number, text: string, userId = TG_USER) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1_700_000_000,
      text,
      from: { id: userId, is_bot: false, first_name: 'Ana' },
      chat: { id: userId, type: 'private' },
    },
  };
}

async function postUpdate(update: unknown) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/telegram/${connectionId}`,
    headers: { 'x-telegram-bot-api-secret-token': webhookSecretSeen },
    payload: update as Record<string, unknown>,
  });
}

async function mintLink(subscriberId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/link-agent/subscribers/${subscriberId}/link-token`,
    headers: { 'x-api-key': apiKey },
  });
  return { status: res.statusCode, ...json(res) } as {
    status: number;
    token: string;
    deepLink: string;
  };
}

async function identities(subscriberId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/subscribers/${subscriberId}/identities`,
    headers: { 'x-api-key': apiKey },
  });
  return json(res).identities as Array<{ channel: string; externalKey: string }>;
}

async function lastConversation() {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/conversations?agent=link-agent',
    headers: { 'x-api-key': apiKey },
  });
  return json(res).conversations[0];
}

async function processLastTurn(conversationId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/conversations/${conversationId}`,
    headers: { 'x-api-key': apiKey },
  });
  const turn = json(res).messages.findLast((m: { role: string }) => m.role === 'user');
  const data: ConversationJobData = { tenantId, conversationId, messageId: turn.id };
  await processConversation({ data } as Job<ConversationJobData>);
  return turn;
}

beforeAll(async () => {
  await startTelegramStub();
  process.env.TELEGRAM_API_BASE = `http://localhost:${(tgStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `link-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Link IT', email, password: 'integration-pw-1', organizationName: 'Link IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  // The workflow the brain fires — email + inapp steps.
  await app.inject({
    method: 'PUT',
    url: '/v1/workflows',
    headers: { 'x-api-key': apiKey },
    payload: {
      key: 'link-wf',
      name: 'Link workflow',
      steps: [
        { channel: 'email', subject: 'Order update for {{name}}', body: 'On the way, {{name}}!' },
        { channel: 'inapp', subject: 'Order update', body: 'On the way!' },
      ],
    },
  });

  // The REAL subscriber (has an email — that's the whole point).
  await app.inject({
    method: 'PUT',
    url: '/v1/subscribers',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId: 'ana', email: REAL_EMAIL },
  });

  bridge = createServer((req, res) => createHandler(brain, { signingSecret })(req, res));
  await new Promise<void>((r) => bridge.listen(0, r));

  const created = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: 'link-agent',
      name: 'Link Agent',
      bridgeUrl: `http://localhost:${(bridge.address() as AddressInfo).port}/`,
    },
  });
  signingSecret = json(created).signingSecret;

  const connected = await app.inject({
    method: 'POST',
    url: '/v1/agents/link-agent/channels/telegram',
    headers: { 'x-api-key': apiKey },
    payload: { botToken: BOT_TOKEN },
  });
  connectionId = json(connected).webhookUrl.split('/').pop();
});

afterAll(async () => {
  delete process.env.TELEGRAM_API_BASE;
  tgStub?.close();
  bridge?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('minting', () => {
  test('returns a single-use deep link for the bot', async () => {
    const mint = await mintLink('ana');
    expect(mint.status).toBe(201);
    expect(mint.deepLink).toBe(`https://t.me/link_test_bot?start=${mint.token}`);
    expect(mint.token).toMatch(/^[0-9a-f]{48}$/);
  });

  test('404s without an agent or telegram connection', async () => {
    const noAgent = await app.inject({
      method: 'POST',
      url: '/v1/agents/no-such-agent/subscribers/ana/link-token',
      headers: { 'x-api-key': apiKey },
    });
    expect(noAgent.statusCode).toBe(404);
  });
});

describe('the /start handshake', () => {
  test('pre-link: the telegram user is a channel-local stranger; triggers carry NO email', async () => {
    await postUpdate(tgText(1, 'where is my order? (pre-link)'));
    const conv = await lastConversation();
    expect(conv.subscriberId).toBe(`tg-${TG_USER}`);

    // The phantom-email baseline: the brain triggers, but the recipient
    // has no email — the email step will have nothing to send to.
    const turn = await processLastTurn(conv.id);
    const { rows } = await pool.query(
      'select recipients from events where tenant_id = $1 and transaction_id = $2',
      [tenantId, `conv-${turn.id}-1`], // bridge signal indexes start at 1
    );
    expect(rows[0]).toBeDefined();
    expect(JSON.stringify(rows[0].recipients)).toContain(`tg-${TG_USER}`);
    expect(JSON.stringify(rows[0].recipients)).not.toContain('@');
  });

  test('a valid token links, repoints history, and confirms in-chat', async () => {
    const mint = await mintLink('ana');
    const res = await postUpdate(tgText(2, `/start ${mint.token}`));
    expect(json(res).linked).toBe(true);

    // Mapping recorded.
    expect(await identities('ana')).toEqual([
      expect.objectContaining({ channel: 'telegram', externalKey: String(TG_USER) }),
    ]);
    // The pre-link conversation now belongs to ana — history followed.
    expect((await lastConversation()).subscriberId).toBe('ana');
    // The bot confirmed.
    expect(String(sends().at(-1)?.body.text)).toContain('ana');
  });

  test('the token is single-use: a second tap by another user links nothing', async () => {
    const mint = await mintLink('ana');
    await postUpdate(tgText(3, `/start ${mint.token}`)); // consumed by TG_USER
    const replay = await postUpdate(tgText(4, `/start ${mint.token}`, 888002));
    expect(json(replay).linked).toBe(false);
    // The stranger got the invalid-link notice, and no mapping exists.
    expect(String(sends().at(-1)?.body.text)).toContain('invalid');
    const ids = await identities('ana');
    expect(ids.some((i) => i.externalKey === '888002')).toBe(false);
  });

  test('an expired token is rejected', async () => {
    const mint = await mintLink('ana');
    await pool.query(
      `update subscriber_link_tokens set expires_at = now() - interval '1 hour'
       where tenant_id = $1 and used_at is null`,
      [tenantId],
    );
    const res = await postUpdate(tgText(5, `/start ${mint.token}`, 888003));
    expect(json(res).linked).toBe(false);
  });

  test('bare /start (no token) goes to the brain like any text', async () => {
    const res = await postUpdate(tgText(6, '/start'));
    expect(json(res).ok).toBe(true);
    expect(json(res).linked).toBeUndefined();
  });
});

describe('life after linking', () => {
  test('new turns land under the real subscriber', async () => {
    await postUpdate(tgText(7, 'just checking in'));
    const conv = await lastConversation();
    expect(conv.subscriberId).toBe('ana');
  });

  test('THE REGRESSION: a telegram trigger now carries the real email', async () => {
    await postUpdate(tgText(8, 'where is my order?'));
    const conv = await lastConversation();
    const turn = await processLastTurn(conv.id);

    // Same brain, same tool, same chat — but the recipient is now ana,
    // email included. This is the exact step that silently skipped in the
    // Phase 5 live test ("a confirmation email is incoming" — it wasn't).
    const { rows } = await pool.query(
      'select recipients from events where tenant_id = $1 and transaction_id = $2',
      [tenantId, `conv-${turn.id}-1`], // bridge signal indexes start at 1
    );
    expect(rows[0]).toBeDefined();
    const recipients = JSON.stringify(rows[0].recipients);
    expect(recipients).toContain('"ana"');
    expect(recipients).toContain(REAL_EMAIL);
  });

  test('unlink drops the mapping; re-linking works', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/subscribers/ana/identities',
      headers: { 'x-api-key': apiKey },
      payload: { channel: 'telegram', externalKey: String(TG_USER) },
    });
    expect(json(res).deleted).toBe(true);
    expect(
      (await identities('ana')).some((i) => i.channel === 'telegram'),
    ).toBe(false);

    // The EXISTING thread keeps its owner (one conversation per chat; its
    // history was legitimately granted to ana) — unlink only changes how
    // FRESH identities resolve from here on.
    await postUpdate(tgText(9, 'anyone there?'));
    expect((await lastConversation()).subscriberId).toBe('ana');

    // Re-linking is a plain new handshake.
    const mint = await mintLink('ana');
    const relink = await postUpdate(tgText(10, `/start ${mint.token}`));
    expect(json(relink).linked).toBe(true);
    expect(
      (await identities('ana')).some((i) => i.channel === 'telegram'),
    ).toBe(true);
  });
});

describe('email auto-match', () => {
  let emailConnectionId = '';
  let emailKey = '';

  test('an inbound from a known address auto-links to the real subscriber', async () => {
    const connected = await app.inject({
      method: 'POST',
      url: '/v1/agents/link-agent/channels/email',
      headers: { 'x-api-key': apiKey },
      payload: { address: 'inbound@example.test' },
    });
    const url = new URL(json(connected).webhookUrl);
    emailConnectionId = url.pathname.split('/').pop()!;
    emailKey = url.searchParams.get('key')!;

    const inbound = await app.inject({
      method: 'POST',
      url: `/webhooks/email/${emailConnectionId}?key=${emailKey}`,
      payload: {
        FromFull: { Email: REAL_EMAIL, Name: 'Ana' },
        Subject: 'help',
        TextBody: 'my order is missing',
        MessageID: 'mid-link-1',
      },
    });
    expect(json(inbound).ok).toBe(true);

    // Mapping written automatically; conversation belongs to ana.
    const ids = await identities('ana');
    expect(ids.some((i) => i.channel === 'email' && i.externalKey === REAL_EMAIL)).toBe(true);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/conversations?agent=link-agent',
      headers: { 'x-api-key': apiKey },
    });
    const emailConv = json(list).conversations.find((c: { channel: string }) => c.channel === 'email');
    expect(emailConv.subscriberId).toBe('ana');
  });

  test('an unknown address stays a channel-local identity', async () => {
    const inbound = await app.inject({
      method: 'POST',
      url: `/webhooks/email/${emailConnectionId}?key=${emailKey}`,
      payload: {
        FromFull: { Email: 'stranger@example.net', Name: 'S' },
        Subject: 'hi',
        TextBody: 'who are you?',
        MessageID: 'mid-link-2',
      },
    });
    expect(json(inbound).ok).toBe(true);
    const list = await app.inject({
      method: 'GET',
      url: '/v1/conversations?agent=link-agent',
      headers: { 'x-api-key': apiKey },
    });
    const conv = json(list).conversations.find(
      (c: { subscriberId: string }) => c.subscriberId === 'stranger@example.net',
    );
    expect(conv).toBeDefined();
  });
});
