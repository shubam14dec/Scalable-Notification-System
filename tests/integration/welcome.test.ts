/**
 * Agent-speaks-first (Phase 17): the welcome message + suggested prompts, from
 * the PATCH validation bounds through the widget conversation payload and the
 * telegram bare-/start greeting. Telegram runs the production path with a stub
 * standing in for api.telegram.org and the real @asyncify-hq/agent SDK as the
 * bridge (whose brain we count, to prove /start greets WITHOUT a brain turn).
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, getQueue, QUEUE } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import { createHandler, defineAgent } from '../../packages/agent/src/index';

// Distinct digit prefixes → distinct botId in the stub → separate connections.
const BOT_TOKEN_WELCOME = '7100001:AAwelcome-tg-token_0123456789ABCDEFG';
const BOT_TOKEN_PLAIN = '7100002:AAplain-tg-token_0123456789ABCDEFGHI';

const WELCOME_TEXT = 'Hi! I am your helper.';
const PROMPTS = [
  { title: 'Track order', message: 'Where is my order?' },
  { title: 'Talk to human', message: 'I need a person' },
];

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';

const json = (res: { body: string }) => JSON.parse(res.body);
const headers = () => ({ 'x-api-key': apiKey });

// ---- bridge brain: counts every onMessage so we can prove /start skips it ----
const brainCalls: string[] = [];
const brain = defineAgent({
  onMessage(ctx) {
    brainCalls.push(ctx.message.text);
    return `echo: ${ctx.message.text}`;
  },
});
let bridge: Server;
let bridgeUrl = '';
const holder = { secret: 'placeholder-until-created' };

// ---- stub Telegram API (per telegram.test.ts precedent) ----
let tgStub: Server;
const tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
const webhookSecrets: Record<string, string> = {};
let messageIdSeq = 9000;
function startTelegramStub(): Promise<void> {
  tgStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const parts = String(req.url).split('/');
      const method = parts.pop() ?? '';
      const token = (parts[1] ?? '').replace(/^bot/, '');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const meta =
        token === BOT_TOKEN_PLAIN
          ? { id: 7100002, is_bot: true, username: 'plain_tg_bot' }
          : { id: 7100001, is_bot: true, username: 'welcome_tg_bot' };
      const results: Record<string, unknown> = {
        getMe: meta,
        setWebhook: true,
        deleteWebhook: true,
        getWebhookInfo: { url: 'https://example.test/hook', pending_update_count: 0 },
        sendMessage: { message_id: method === 'sendMessage' ? ++messageIdSeq : 0 },
        answerCallbackQuery: true,
        editMessageText: true,
        deleteMessage: true,
        sendChatAction: true,
      };
      tgCalls.push({ method, body });
      if (method === 'setWebhook') {
        const connId = String(body.url ?? '').split('/').pop() ?? '';
        webhookSecrets[connId] = String(body.secret_token ?? '');
      }
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ok: method in results,
          result: results[method],
          description: method in results ? undefined : 'unknown method',
        }),
      );
    });
  });
  return new Promise((r) => tgStub.listen(0, () => r()));
}

async function createAgent(payload: Record<string, unknown>): Promise<{ signingSecret: string }> {
  const res = await app.inject({ method: 'POST', url: '/v1/agents', headers: headers(), payload });
  expect(res.statusCode, JSON.stringify(json(res))).toBe(201);
  return json(res);
}

async function connectTelegram(identifier: string, botToken: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/channels/telegram`,
    headers: headers(),
    payload: { botToken },
  });
  expect(res.statusCode).toBe(201);
  return String(json(res).webhookUrl).split('/').pop() as string;
}

function tgMessageUpdate(updateId: number, text: string, userId: number) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1_700_000_000,
      text,
      from: { id: userId, is_bot: false, first_name: 'Ana', username: 'ana_tg' },
      chat: { id: userId, type: 'private' },
    },
  };
}
async function postUpdate(connId: string, update: unknown) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/telegram/${connId}`,
    headers: { 'x-telegram-bot-api-secret-token': webhookSecrets[connId] ?? '' },
    payload: update as Record<string, unknown>,
  });
}

async function convByChat(chatId: number): Promise<{ id: string } | undefined> {
  const { rows } = await pool.query(
    `select id from conversations where tenant_id = $1 and channel = 'telegram' and thread_key = $2`,
    [tenantId, String(chatId)],
  );
  return rows[0];
}
async function agentRows(conversationId: string) {
  const { rows } = await pool.query(
    `select id, content, raw from conversation_messages
      where conversation_id = $1 and role = 'agent' order by created_at asc`,
    [conversationId],
  );
  return rows as Array<{ id: string; content: string; raw: Record<string, unknown> }>;
}
async function latestUserRow(conversationId: string) {
  const { rows } = await pool.query(
    `select id, content from conversation_messages
      where conversation_id = $1 and role = 'user' order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0] as { id: string; content: string } | undefined;
}

beforeAll(async () => {
  await startTelegramStub();
  process.env.TELEGRAM_API_BASE = `http://localhost:${(tgStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `welcome-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Welcome IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Welcome IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  bridge = createServer((req, res) => createHandler(brain, { signingSecret: holder.secret })(req, res));
  await new Promise<void>((r) => bridge.listen(0, r));
  bridgeUrl = `http://localhost:${(bridge.address() as AddressInfo).port}/`;

  // The plain (no-welcome) agent's secret drives the shared bridge — it's the
  // only agent that ever dispatches to the brain in this file.
  const plain = await createAgent({
    identifier: 'welcome-plain-tg',
    name: 'Plain TG',
    bridgeUrl,
  });
  holder.secret = plain.signingSecret;

  await createAgent({
    identifier: 'welcome-tg',
    name: 'Welcome TG',
    bridgeUrl,
    welcomeMessage: WELCOME_TEXT,
    suggestedPrompts: PROMPTS,
  });
  await createAgent({
    identifier: 'welcome-inapp',
    name: 'Welcome Inapp',
    bridgeUrl,
    welcomeMessage: WELCOME_TEXT,
    suggestedPrompts: PROMPTS,
  });
  await createAgent({
    identifier: 'welcome-bounds',
    name: 'Welcome Bounds',
    bridgeUrl,
    welcomeMessage: WELCOME_TEXT,
    suggestedPrompts: PROMPTS,
  });
});

afterAll(async () => {
  delete process.env.TELEGRAM_API_BASE;
  tgStub?.close();
  bridge?.close();
  // Row hygiene: child → parent, scoped to this file's fresh tenant.
  for (const sql of [
    `delete from conversation_messages where tenant_id = $1`,
    `delete from conversations where tenant_id = $1`,
    `delete from agent_connections where tenant_id = $1`,
    `delete from channel_identities where tenant_id = $1`,
    `delete from agents where tenant_id = $1`,
    `delete from subscribers where tenant_id = $1`,
  ]) {
    await pool.query(sql, [tenantId]).catch(() => {});
  }
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('PATCH validation bounds', () => {
  const patch = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'PATCH',
      url: '/v1/agents/welcome-bounds',
      headers: headers(),
      payload,
    });

  test('a 41-char prompt title is a 400', async () => {
    const res = await patch({ suggestedPrompts: [{ title: 'a'.repeat(41), message: 'ok' }] });
    expect(res.statusCode).toBe(400);
  });

  test('7 prompts is a 400 (max 6)', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ title: `t${i}`, message: `m${i}` }));
    const res = await patch({ suggestedPrompts: seven });
    expect(res.statusCode).toBe(400);
  });

  test('a 2001-char welcome message is a 400 (max 2000)', async () => {
    const res = await patch({ welcomeMessage: 'a'.repeat(2001) });
    expect(res.statusCode).toBe(400);
  });

  test('null clears both the welcome and the prompts', async () => {
    const res = await patch({ welcomeMessage: null, suggestedPrompts: null });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.welcomeMessage).toBeNull();
    expect(json(res).agent.suggestedPrompts).toBeNull();
  });
});

describe('conversation payload agent block', () => {
  test('present before any conversation exists (agent-speaks-first branch)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/welcome-inapp/conversation?subscriberId=never-spoke',
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.conversation).toBeNull();
    expect(body.messages).toEqual([]);
    expect(body.agent).toEqual({
      name: 'Welcome Inapp',
      welcomeMessage: WELCOME_TEXT,
      suggestedPrompts: PROMPTS,
    });
  });

  test('present once a conversation exists too', async () => {
    const turn = await app.inject({
      method: 'POST',
      url: '/v1/agents/welcome-inapp/messages',
      headers: headers(),
      payload: { subscriberId: 'welcome-sub', text: 'hello there', messageId: 'w-turn-1' },
    });
    expect(turn.statusCode).toBe(202);

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/welcome-inapp/conversation?subscriberId=welcome-sub',
      headers: headers(),
    });
    const body = json(res);
    expect(body.conversation).not.toBeNull();
    expect(body.agent).toEqual({
      name: 'Welcome Inapp',
      welcomeMessage: WELCOME_TEXT,
      suggestedPrompts: PROMPTS,
    });
  });
});

describe('telegram bare-/start greeting', () => {
  let connId = '';
  const chatId = 561001;

  beforeAll(async () => {
    connId = await connectTelegram('welcome-tg', BOT_TOKEN_WELCOME);
  });

  test('a bare /start posts the welcome once with the prompt buttons and skips the brain', async () => {
    const before = brainCalls.length;
    const res = await postUpdate(connId, tgMessageUpdate(6000, '/start', chatId));
    expect(res.statusCode).toBe(200);
    expect(json(res).welcomed).toBe(true);

    const conv = await convByChat(chatId);
    expect(conv).toBeDefined();
    const rows = await agentRows(conv!.id);
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(WELCOME_TEXT);
    expect(rows[0].raw.buttons).toEqual([
      { id: 'welcome-prompt-0', label: 'Track order' },
      { id: 'welcome-prompt-1', label: 'Talk to human' },
    ]);

    // The greeting went out via the operator 'deliver' lane, NOT the brain lane.
    expect(await getQueue(QUEUE.CONVERSATION).getJob(`conv-deliver-${rows[0].id}`)).toBeTruthy();
    expect(await getQueue(QUEUE.CONVERSATION).getJob(`conv-${rows[0].id}`)).toBeFalsy();
    expect(brainCalls.length).toBe(before); // the brain was never invoked
  });

  test('a second /start is deduped: still exactly one welcome row', async () => {
    const res = await postUpdate(connId, tgMessageUpdate(6001, '/start', chatId));
    expect(json(res).duplicate).toBe(true);

    const conv = await convByChat(chatId);
    expect(await agentRows(conv!.id)).toHaveLength(1);
  });

  test('/start <token-shaped> takes the link handshake, not the welcome', async () => {
    const linkChat = 561002;
    const token = 'a'.repeat(40); // 40 of [A-Za-z0-9_-]: matches the link-token shape
    const res = await postUpdate(connId, tgMessageUpdate(6002, `/start ${token}`, linkChat));
    expect(res.statusCode).toBe(200);
    const body = json(res);
    // Link path answers linked:false (unknown token); it never greets/opens a conv.
    expect(body.linked).toBe(false);
    expect(body.welcomed).toBeUndefined();
    expect(await convByChat(linkChat)).toBeUndefined();
  });
});

describe('an agent without a welcome falls through to the brain', () => {
  test('bare /start on a no-welcome agent becomes a normal brain turn', async () => {
    const connId = await connectTelegram('welcome-plain-tg', BOT_TOKEN_PLAIN);
    const chatId = 562001;
    const before = brainCalls.length;

    const res = await postUpdate(connId, tgMessageUpdate(6100, '/start', chatId));
    expect(res.statusCode).toBe(200);
    expect(json(res).ok).toBe(true);
    expect(json(res).welcomed).toBeUndefined(); // not greeted — it's a turn

    const conv = await convByChat(chatId);
    expect(conv).toBeDefined();
    const userRow = await latestUserRow(conv!.id);
    expect(userRow?.content).toBe('/start');

    // Driving the turn dispatches to the brain (the fall-through behavior).
    const data: ConversationJobData = { tenantId, conversationId: conv!.id, messageId: userRow!.id };
    await processConversation({ data } as Job<ConversationJobData>);
    expect(brainCalls.length).toBe(before + 1);
    expect(brainCalls.at(-1)).toBe('/start');
  });
});
