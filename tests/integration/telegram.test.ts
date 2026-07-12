/**
 * Telegram channel integration: the production path end to end, with a
 * stub standing in for api.telegram.org (TELEGRAM_API_BASE) and the real
 * @asyncify-hq/agent SDK as the bridge. Everything else — connect flow,
 * webhook ingestion, conversation core, processor, reply delivery — is
 * the exact code production runs.
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

// Realistic shape: real bot tokens are <digits>:<35 chars of [A-Za-z0-9_-]>,
// and the connect route validates that shape before calling Telegram.
const BOT_TOKEN = '7000001:AAitest-telegram-token_0123456789AB';
// A second bot identity (distinct botId) → a separate connection, used to wire
// a MANAGED agent onto telegram for the plan-card streaming tests.
const MANAGED_BOT_TOKEN = '7000002:AAitest-managed-token_0123456789ABC';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let signingSecret = '';
let bridge: Server;
let bridgeUrl = '';

// ---- stub Telegram API: records every call, answers like the real one ----
let tgStub: Server;
const tgCalls: Array<{ method: string; body: Record<string, unknown>; result: unknown }> = [];
let webhookSecretSeen = '';
/** Per-connection webhook secret, keyed by connectionId parsed from setWebhook url. */
const webhookSecrets: Record<string, string> = {};
// Unique per send, like the real API — label recovery for button clicks
// looks replies up by telegramMessageId, so a constant would be ambiguous.
let messageIdSeq = 4242;

function startTelegramStub(): Promise<void> {
  tgStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const parts = String(req.url).split('/');
      const method = parts.pop() ?? '';
      const token = (parts[1] ?? '').replace(/^bot/, '');
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      // A distinct botId per token so a second bot token upserts a NEW
      // connection (the on-conflict key is config->>'botId').
      const isManaged = token === MANAGED_BOT_TOKEN;
      const results: Record<string, unknown> = {
        getMe: isManaged
          ? { id: 7000002, is_bot: true, username: 'itest_managed_bot' }
          : { id: 7000001, is_bot: true, username: 'itest_bot' },
        setWebhook: true,
        deleteWebhook: true,
        getWebhookInfo: { url: 'https://example.test/hook', pending_update_count: 0 },
        sendMessage: { message_id: method === 'sendMessage' ? ++messageIdSeq : 0 },
        answerCallbackQuery: true,
        editMessageText: true,
        deleteMessage: true,
      };
      tgCalls.push({ method, body, result: results[method] });
      if (method === 'setWebhook') {
        webhookSecretSeen = String(body.secret_token ?? '');
        const connId = String(body.url ?? '').split('/').pop() ?? '';
        webhookSecrets[connId] = webhookSecretSeen;
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: method in results, result: results[method], description: method in results ? undefined : 'unknown method' }));
    });
  });
  return new Promise((r) => tgStub.listen(0, () => r()));
}

const sends = () => tgCalls.filter((c) => c.method === 'sendMessage');

const brain = defineAgent({
  onMessage(ctx) {
    if (ctx.message.text.includes('order')) {
      ctx.metadata.set('topic', 'orders');
      return 'Replacement on the way!';
    }
    if (ctx.message.text.includes('options')) {
      ctx.reply('Pick one:', {
        buttons: [
          { id: 'resend', label: 'Resend email' },
          { id: 'human', label: 'Talk to human' },
        ],
      });
      return;
    }
    if (ctx.message.text.includes('pick size')) {
      ctx.reply('What size?', {
        card: {
          type: 'select',
          id: 'size',
          options: [
            { id: 's', label: 'Small' },
            { id: 'l', label: 'Large' },
          ],
        },
      });
      return;
    }
    if (ctx.message.text.includes('your email')) {
      ctx.reply('What is your email?', {
        card: { type: 'text_input', id: 'email', placeholder: 'you@example.com' },
      });
      return;
    }
    return `heard on ${ctx.conversation.channel}: ${ctx.message.text}`;
  },
  onAction(ctx) {
    return `clicked:${ctx.action?.id}:${ctx.message.text}`;
  },
});

const json = (res: { body: string }) => JSON.parse(res.body);
let connectionId = '';

function tgUpdate(updateId: number, text: string, userId = 555001) {
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

/** Telegram re-pushes an edited message as `edited_message`, same shape as `message`. */
function tgEditedUpdate(updateId: number, messageId: number, text: string, userId = 555001) {
  return {
    update_id: updateId,
    edited_message: {
      message_id: messageId,
      date: 1_700_000_100,
      text,
      from: { id: userId, is_bot: false, first_name: 'Ana', username: 'ana_tg' },
      chat: { id: userId, type: 'private' },
    },
  };
}

async function postUpdate(update: unknown, secret = webhookSecretSeen) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/telegram/${connectionId}`,
    headers: { 'x-telegram-bot-api-secret-token': secret },
    payload: update as Record<string, unknown>,
  });
}

/** Post to an ARBITRARY connection with its own captured webhook secret. */
async function postUpdateTo(connId: string, update: unknown) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/telegram/${connId}`,
    headers: { 'x-telegram-bot-api-secret-token': webhookSecrets[connId] ?? '' },
    payload: update as Record<string, unknown>,
  });
}

/** A message that replies to another (ForceReply answer to a text_input card). */
function tgReplyUpdate(updateId: number, replyToMessageId: number, text: string, userId = 555001) {
  return {
    update_id: updateId,
    message: {
      message_id: updateId * 10,
      date: 1_700_000_200,
      text,
      from: { id: userId, is_bot: false, first_name: 'Ana', username: 'ana_tg' },
      chat: { id: userId, type: 'private' },
      reply_to_message: { message_id: replyToMessageId },
    },
  };
}

async function latestUserRaw(conversationId: string) {
  const { rows } = await pool.query(
    `select content, raw from conversation_messages
      where conversation_id = $1 and role = 'user' order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0] as { content: string; raw: Record<string, unknown> };
}
async function latestAgentRaw(conversationId: string) {
  const { rows } = await pool.query(
    `select content, raw from conversation_messages
      where conversation_id = $1 and role = 'agent' order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0] as { content: string; raw: Record<string, unknown> };
}
async function convIdForChat(threadKey: string): Promise<string> {
  const { rows } = await pool.query(
    `select id from conversations where channel = 'telegram' and thread_key = $1 order by created_at desc limit 1`,
    [threadKey],
  );
  return rows[0].id as string;
}
async function processLatestTurn(conversationId: string) {
  const { rows } = await pool.query(
    `select id from conversation_messages where conversation_id = $1 and role = 'user' order by created_at desc limit 1`,
    [conversationId],
  );
  const data: ConversationJobData = { tenantId, conversationId, messageId: rows[0].id };
  await processConversation({ data } as Job<ConversationJobData>);
}
const sendsToChat = (chatId: string) =>
  tgCalls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === chatId);
const editsToMessage = (messageId: number) =>
  tgCalls.filter((c) => c.method === 'editMessageText' && c.body.message_id === messageId);

// ---- stub Anthropic-compatible server (for the managed plan-card tests) ----
let llmStub: Server;
let llmBaseUrl = '';
let llmQueue: unknown[] = [];
const llmEnvelope = (content: unknown[], stopReason: string) => ({
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: 'glm-4-test',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const llmToolUse = (uses: Array<{ id: string; name: string; input: unknown }>) =>
  llmEnvelope(uses.map((u) => ({ type: 'tool_use', ...u })), 'tool_use');
const llmText = (text: string) => llmEnvelope([{ type: 'text', text }], 'end_turn');
function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(llmQueue.length > 0 ? llmQueue.shift() : llmText('managed reply')));
    });
  });
  return new Promise((r) => llmStub.listen(0, () => r()));
}

beforeAll(async () => {
  await startTelegramStub();
  process.env.TELEGRAM_API_BASE = `http://localhost:${(tgStub.address() as AddressInfo).port}`;
  await startLlmStub();
  llmBaseUrl = `http://localhost:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `tg-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'TG IT', email, password: 'integration-pw-1', organizationName: 'TG IT Org' },
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
    payload: { identifier: 'tg-support', name: 'TG Support', bridgeUrl },
  });
  signingSecret = json(created).signingSecret;

  // A workflow for the managed brain's trigger_workflow (inapp: no provider).
  await app.inject({
    method: 'PUT',
    url: '/v1/workflows',
    headers: { 'x-api-key': apiKey },
    payload: {
      key: 'tg-wf',
      name: 'TG workflow',
      steps: [{ channel: 'inapp', subject: 'Hi', body: 'Replacement' }],
    },
  });
});

afterAll(async () => {
  delete process.env.TELEGRAM_API_BASE;
  tgStub?.close();
  llmStub?.close();
  bridge?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('connect flow', () => {
  test('validates the token, stores the connection, registers the webhook', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/tg-support/channels/telegram',
      headers: { 'x-api-key': apiKey },
      payload: { botToken: BOT_TOKEN },
    });
    expect(res.statusCode).toBe(201);
    expect(json(res).botUsername).toBe('itest_bot');
    connectionId = json(res).webhookUrl.split('/').pop();

    const setWebhook = tgCalls.find((c) => c.method === 'setWebhook');
    expect(setWebhook?.body.url).toBe(`http://localhost:3000/webhooks/telegram/${connectionId}`);
    // Without callback_query here, inline-keyboard clicks are never delivered.
    expect(setWebhook?.body.allowed_updates).toEqual(['message', 'callback_query', 'edited_message']);
    expect(webhookSecretSeen).toMatch(/^[0-9a-f]{48}$/);
  });

  test('channels listing surfaces live webhook state', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/tg-support/channels',
      headers: { 'x-api-key': apiKey },
    });
    const tg = json(res).channels.find((c: { channel: string }) => c.channel === 'telegram');
    expect(tg.config.botUsername).toBe('itest_bot');
    expect(tg.webhook.url).toBe('https://example.test/hook');
    expect(tg.webhook.expectedUrl).toContain(`/webhooks/telegram/${connectionId}`);
  });

  test('reconnect re-registers against the current PUBLIC_URL', async () => {
    const before = tgCalls.filter((c) => c.method === 'setWebhook').length;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/tg-support/channels/telegram/reconnect',
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(tgCalls.filter((c) => c.method === 'setWebhook').length).toBe(before + 1);
  });
});

describe('inbound webhook', () => {
  test('rejects a wrong or missing secret token', async () => {
    expect((await postUpdate(tgUpdate(1, 'hi'), 'wrong-secret')).statusCode).toBe(401);
    const noHeader = await app.inject({
      method: 'POST',
      url: `/webhooks/telegram/${connectionId}`,
      payload: tgUpdate(1, 'hi'),
    });
    expect(noHeader.statusCode).toBe(401);
  });

  test('unknown connection is a 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/telegram/2a2c2e2e-0000-4000-8000-000000000000',
      payload: tgUpdate(1, 'hi'),
    });
    expect(res.statusCode).toBe(404);
  });

  test('a text message opens a telegram conversation for tg-<userId>', async () => {
    const res = await postUpdate(tgUpdate(100, 'hello from telegram'));
    expect(res.statusCode).toBe(200);
    expect(json(res).ok).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/conversations?agent=tg-support',
      headers: { 'x-api-key': apiKey },
    });
    const conv = json(list).conversations[0];
    expect(conv.channel).toBe('telegram');
    expect(conv.subscriberId).toBe('tg-555001');
  });

  test('a redelivered update_id is acked as duplicate, not re-ingested', async () => {
    const res = await postUpdate(tgUpdate(100, 'hello from telegram'));
    expect(json(res).duplicate).toBe(true);
  });

  test('non-text and group updates are acked but skipped', async () => {
    const sticker = { update_id: 101, message: { message_id: 1, date: 1, from: { id: 555001, is_bot: false }, chat: { id: 555001, type: 'private' } } };
    expect(json(await postUpdate(sticker)).skipped).toBe(true);
    const group = tgUpdate(102, 'in a group');
    group.message.chat.type = 'group';
    expect(json(await postUpdate(group)).skipped).toBe(true);
  });
});

describe('reply delivery', () => {
  test('the brain answers back into the telegram chat, exactly once', async () => {
    await postUpdate(tgUpdate(200, 'where is my order?'));
    const list = await app.inject({
      method: 'GET',
      url: '/v1/conversations?agent=tg-support',
      headers: { 'x-api-key': apiKey },
    });
    const conv = json(list).conversations[0];
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conv.id}`,
      headers: { 'x-api-key': apiKey },
    });
    const turn = json(detail).messages.findLast((m: { role: string }) => m.role === 'user');

    const data: ConversationJobData = { tenantId, conversationId: conv.id, messageId: turn.id };
    await processConversation({ data } as Job<ConversationJobData>);

    expect(sends().length).toBe(1);
    expect(sends()[0].body.chat_id).toBe('555001');
    expect(sends()[0].body.text).toBe('Replacement on the way!');

    // Crash-retry simulation: the send-once guard must hold.
    await processConversation({ data } as Job<ConversationJobData>);
    expect(sends().length).toBe(1);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conv.id}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(json(after).conversation.metadata.topic).toBe('orders');
  });
});

describe('inline keyboards', () => {
  let keyboardMessageId = 0;
  let conversationId = '';

  async function processLastUserTurn(convId: string) {
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${convId}`,
      headers: { 'x-api-key': apiKey },
    });
    const turn = json(detail).messages.findLast((m: { role: string }) => m.role === 'user');
    const data: ConversationJobData = { tenantId, conversationId: convId, messageId: turn.id };
    await processConversation({ data } as Job<ConversationJobData>);
    return turn;
  }

  test('reply buttons go out as an inline keyboard', async () => {
    await postUpdate(tgUpdate(400, 'show me my options'));
    const list = await app.inject({
      method: 'GET',
      url: '/v1/conversations?agent=tg-support',
      headers: { 'x-api-key': apiKey },
    });
    conversationId = json(list).conversations[0].id;
    await processLastUserTurn(conversationId);

    const kb = sends().findLast((c) => c.body.reply_markup);
    expect(kb).toBeDefined();
    expect(kb?.body.text).toBe('Pick one:');
    expect((kb?.body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard).toEqual([
      [{ text: 'Resend email', callback_data: 'resend' }],
      [{ text: 'Talk to human', callback_data: 'human' }],
    ]);
    keyboardMessageId = (kb?.result as { message_id: number }).message_id;
  });

  test('a button press becomes an action event: label recovered, onAction runs, spinner acked', async () => {
    const res = await postUpdate({
      update_id: 401,
      callback_query: {
        id: 'cbq-1',
        from: { id: 555001, is_bot: false, first_name: 'Ana' },
        message: { message_id: keyboardMessageId, chat: { id: 555001, type: 'private' } },
        data: 'resend',
      },
    });
    expect(json(res).ok).toBe(true);
    expect(tgCalls.some((c) => c.method === 'answerCallbackQuery' && c.body.callback_query_id === 'cbq-1')).toBe(true);

    // The keyboard retires: message rewritten with the choice, buttons gone.
    const edit = tgCalls.find((c) => c.method === 'editMessageText');
    expect(edit?.body.message_id).toBe(keyboardMessageId);
    expect(edit?.body.text).toBe('Pick one:\n\n✓ Resend email');
    expect(edit?.body.reply_markup).toBeUndefined();

    const turn = await processLastUserTurn(conversationId);
    // The click was stored as a user row carrying the recovered label.
    expect(turn.content).toBe('Resend email');

    expect(sends().at(-1)?.body.text).toBe('clicked:resend:Resend email');
  });

  test('a redelivered callback is acked as duplicate, not re-ingested', async () => {
    const res = await postUpdate({
      update_id: 402,
      callback_query: {
        id: 'cbq-1',
        from: { id: 555001, is_bot: false },
        message: { message_id: keyboardMessageId, chat: { id: 555001, type: 'private' } },
        data: 'resend',
      },
    });
    expect(json(res).duplicate).toBe(true);
    // Duplicate short-circuits before the keyboard-retire edit.
    expect(tgCalls.filter((c) => c.method === 'editMessageText').length).toBe(1);
  });

  test('a callback without data or message is acked but skipped', async () => {
    const res = await postUpdate({
      update_id: 403,
      callback_query: { id: 'cbq-2', from: { id: 555001, is_bot: false } },
    });
    expect(json(res).skipped).toBe(true);
  });
});

describe('inbound edited_message', () => {
  test('an edited_message update rewrites the stored row content and sets edited_at', async () => {
    const original = await postUpdate(tgUpdate(500, 'please edit me'));
    expect(original.statusCode).toBe(200);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/conversations?agent=tg-support',
      headers: { 'x-api-key': apiKey },
    });
    const conv = json(list).conversations[0];
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conv.id}`,
      headers: { 'x-api-key': apiKey },
    });
    const row = json(detail).messages.find((m: { content: string }) => m.content === 'please edit me');
    expect(row).toBeDefined();
    expect(row.editedAt).toBeFalsy();

    const editRes = await postUpdate(tgEditedUpdate(501, 500 * 10, 'edited: please edit me'));
    expect(editRes.statusCode).toBe(200);
    expect(json(editRes).edited).toBe(true);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conv.id}`,
      headers: { 'x-api-key': apiKey },
    });
    const updatedRow = json(after).messages.find((m: { id: string }) => m.id === row.id);
    expect(updatedRow.content).toBe('edited: please edit me');
    expect(updatedRow.editedAt).toBeTruthy();
  });

  test('edited_message for an unknown chat is acked without creating a conversation', async () => {
    const before = await app.inject({
      method: 'GET',
      url: '/v1/conversations?agent=tg-support',
      headers: { 'x-api-key': apiKey },
    });
    const countBefore = json(before).conversations.length;

    const res = await postUpdate(tgEditedUpdate(502, 99999, 'nobody home', 999999999));
    expect(res.statusCode).toBe(200);
    expect(json(res).ok).toBe(true);

    const after = await app.inject({
      method: 'GET',
      url: '/v1/conversations?agent=tg-support',
      headers: { 'x-api-key': apiKey },
    });
    expect(json(after).conversations.length).toBe(countBefore);
  });
});

describe('operator delete (telegram)', () => {
  async function processLastUserTurn(convId: string) {
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${convId}`,
      headers: { 'x-api-key': apiKey },
    });
    const turn = json(detail).messages.findLast((m: { role: string }) => m.role === 'user');
    const data: ConversationJobData = { tenantId, conversationId: convId, messageId: turn.id };
    await processConversation({ data } as Job<ConversationJobData>);
    return turn;
  }

  test('deleting a telegram agent reply calls Bot API deleteMessage with matching chat/message ids', async () => {
    const sendsBefore = sends().length;
    await postUpdate(tgUpdate(700, 'need help with my order please'));
    const list = await app.inject({
      method: 'GET',
      url: '/v1/conversations?agent=tg-support',
      headers: { 'x-api-key': apiKey },
    });
    const conv = json(list).conversations[0];
    await processLastUserTurn(conv.id);
    expect(sends().length).toBe(sendsBefore + 1);
    const newSend = sends().at(-1)!;

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conv.id}`,
      headers: { 'x-api-key': apiKey },
    });
    const replyRow = json(detail).messages.findLast((m: { role: string }) => m.role === 'agent');
    expect(replyRow).toBeDefined();

    const deleteCallsBefore = tgCalls.filter((c) => c.method === 'deleteMessage').length;
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/conversations/${conv.id}/messages/${replyRow.id}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(del.statusCode).toBe(200);
    expect(json(del).deleted).toBe(true);

    const deleteCalls = tgCalls.filter((c) => c.method === 'deleteMessage');
    expect(deleteCalls.length).toBe(deleteCallsBefore + 1);
    const lastDelete = deleteCalls.at(-1)!;
    expect(lastDelete.body.chat_id).toBe('555001');
    expect(lastDelete.body.message_id).toBe((newSend.result as { message_id: number }).message_id);
  });

  test('a reply older than the 48h delete window is tombstoned but not deleted from telegram', async () => {
    await postUpdate(tgUpdate(701, 'another order question please'));
    const list = await app.inject({
      method: 'GET',
      url: '/v1/conversations?agent=tg-support',
      headers: { 'x-api-key': apiKey },
    });
    const conv = json(list).conversations[0];
    await processLastUserTurn(conv.id);

    const detail = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conv.id}`,
      headers: { 'x-api-key': apiKey },
    });
    const replyRow = json(detail).messages.findLast((m: { role: string }) => m.role === 'agent');
    expect(replyRow).toBeDefined();

    // Backdate past the 48h delete window (direct SQL — no route exists for this).
    await pool.query(
      `update conversation_messages set created_at = now() - interval '49 hours' where id = $1`,
      [replyRow.id],
    );

    const deleteCallsBefore = tgCalls.filter((c) => c.method === 'deleteMessage').length;
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/conversations/${conv.id}/messages/${replyRow.id}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(del.statusCode).toBe(200);
    expect(json(del).deleted).toBe(true);

    // Tombstone written, but the >48h window means no Bot API call was made.
    expect(tgCalls.filter((c) => c.method === 'deleteMessage').length).toBe(deleteCallsBefore);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conv.id}`,
      headers: { 'x-api-key': apiKey },
    });
    const tombstoned = json(after).messages.find((m: { id: string }) => m.id === replyRow.id);
    expect(tombstoned.content).toBe('');
    expect(tombstoned.deletedBy).toBe('operator');
  });
});

describe('typing indicator (telegram)', () => {
  test('processing a telegram turn calls sendChatAction', async () => {
    const callsBefore = tgCalls.filter((c) => c.method === 'sendChatAction').length;
    await postUpdate(tgUpdate(800, 'just checking in on my order'));
    const list = await app.inject({
      method: 'GET',
      url: '/v1/conversations?agent=tg-support',
      headers: { 'x-api-key': apiKey },
    });
    const conv = json(list).conversations[0];
    const detail = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conv.id}`,
      headers: { 'x-api-key': apiKey },
    });
    const turn = json(detail).messages.findLast((m: { role: string }) => m.role === 'user');
    const data: ConversationJobData = { tenantId, conversationId: conv.id, messageId: turn.id };
    await processConversation({ data } as Job<ConversationJobData>);

    const chatActionCalls = tgCalls.filter((c) => c.method === 'sendChatAction');
    expect(chatActionCalls.length).toBe(callsBefore + 1);
    expect(chatActionCalls.at(-1)?.body.chat_id).toBe('555001');
  });
});

describe('cards (bridge)', () => {
  let selectMsgId = 0;
  let selectConvId = '';
  let textInputMsgId = 0;
  let textInputConvId = '';

  test('a select card renders as a one-option-per-row inline keyboard (callback_data = option ids)', async () => {
    await postUpdateTo(connectionId, tgUpdate(4000, 'pick size', 555020));
    selectConvId = await convIdForChat('555020');
    await processLatestTurn(selectConvId);

    const kb = sendsToChat('555020').findLast((c) => c.body.reply_markup);
    expect(kb).toBeDefined();
    expect(kb!.body.text).toBe('What size?');
    expect((kb!.body.reply_markup as { inline_keyboard: unknown[][] }).inline_keyboard).toEqual([
      [{ text: 'Small', callback_data: 's' }],
      [{ text: 'Large', callback_data: 'l' }],
    ]);
    selectMsgId = (kb!.result as { message_id: number }).message_id;
  });

  test('a select-card callback stores {id: cardId, value, kind:select} and retires with the ✓ label', async () => {
    await postUpdateTo(connectionId, {
      update_id: 4001,
      callback_query: {
        id: 'cbq-sel-1',
        from: { id: 555020, is_bot: false, first_name: 'Ana' },
        message: { message_id: selectMsgId, chat: { id: 555020, type: 'private' }, text: 'What size?' },
        data: 'l',
      },
    });
    const row = await latestUserRaw(selectConvId);
    expect(row.content).toBe('Large');
    expect(row.raw.action).toEqual({ id: 'size', value: 'l', kind: 'select' });

    const edit = tgCalls
      .filter((c) => c.method === 'editMessageText' && c.body.message_id === selectMsgId)
      .at(-1);
    expect(edit!.body.text).toBe('What size?\n\n✓ Large');
    expect(edit!.body.reply_markup).toBeUndefined();
  });

  test('a text_input card sends a ForceReply with the placeholder', async () => {
    await postUpdateTo(connectionId, tgUpdate(4002, 'your email', 555021));
    textInputConvId = await convIdForChat('555021');
    await processLatestTurn(textInputConvId);

    const fr = sendsToChat('555021').findLast((c) => c.body.reply_markup);
    expect(fr!.body.text).toBe('What is your email?');
    expect(fr!.body.reply_markup).toEqual({
      force_reply: true,
      input_field_placeholder: 'you@example.com',
    });
    textInputMsgId = (fr!.result as { message_id: number }).message_id;
  });

  test('a reply to the text_input card is ingested as an input action and marks the prompt answered', async () => {
    await postUpdateTo(connectionId, tgReplyUpdate(4003, textInputMsgId, 'ana@example.com', 555021));
    const row = await latestUserRaw(textInputConvId);
    expect(row.content).toBe('ana@example.com');
    expect(row.raw.action).toEqual({ id: 'email', value: 'ana@example.com', kind: 'input' });

    const answered = tgCalls
      .filter((c) => c.method === 'editMessageText' && c.body.message_id === textInputMsgId)
      .at(-1);
    expect(String(answered!.body.text)).toContain('✓ answered');
  });

  test('a plain (non-reply) message is still a normal turn', async () => {
    await postUpdateTo(connectionId, tgUpdate(4004, 'just a normal question', 555022));
    const convId = await convIdForChat('555022');
    await processLatestTurn(convId);
    const reply = await latestAgentRaw(convId);
    expect(reply.content).toBe('heard on telegram: just a normal question');
    expect(reply.raw.card).toBeUndefined();
  });
});

describe('plan-card streaming (managed)', () => {
  let connectionId2 = '';

  beforeAll(async () => {
    const created = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-api-key': apiKey },
      payload: {
        identifier: 'tg-managed',
        name: 'TG Managed',
        runtime: 'managed',
        model: 'glm-4-test',
        llm: { apiKey: 'managed-key', baseUrl: llmBaseUrl },
      },
    });
    expect(created.statusCode).toBe(201);
    const connect = await app.inject({
      method: 'POST',
      url: '/v1/agents/tg-managed/channels/telegram',
      headers: { 'x-api-key': apiKey },
      payload: { botToken: MANAGED_BOT_TOKEN },
    });
    expect(connect.statusCode).toBe(201);
    connectionId2 = json(connect).webhookUrl.split('/').pop();
  });

  test('the plan card posts a ⏳ message then edits it in place, the final edit being the reply', async () => {
    llmQueue = [
      llmToolUse([{ id: 'tu-plan-1', name: 'trigger_workflow', input: { workflowKey: 'tg-wf' } }]),
      llmText('Replacement sent!'),
    ];
    await postUpdateTo(connectionId2, tgUpdate(5000, 'my order is late', 556001));
    const convId = await convIdForChat('556001');
    await processLatestTurn(convId);

    const posts = sendsToChat('556001');
    expect(posts.length).toBe(1); // only the ⏳ card post; progress + final are edits
    expect(String(posts[0].body.text)).toContain('⏳');
    const cardMsgId = (posts[0].result as { message_id: number }).message_id;

    const edits = editsToMessage(cardMsgId);
    expect(edits.length).toBeGreaterThanOrEqual(1);
    expect(edits.at(-1)!.body.text).toBe('Replacement sent!');

    const reply = await latestAgentRaw(convId);
    expect(reply.content).toBe('Replacement sent!');
  });

  test('D14: finalizing a text_input card edits plain text then sends a ForceReply prompt; a reply to it is captured', async () => {
    llmQueue = [
      llmToolUse([{ id: 'tu-plan-2', name: 'trigger_workflow', input: { workflowKey: 'tg-wf' } }]),
      llmToolUse([
        {
          id: 'tu-plan-3',
          name: 'request_input',
          input: { id: 'email', prompt: 'Your email?', placeholder: 'you@x.com' },
        },
      ]),
      llmText('Please share your email.'),
    ];
    await postUpdateTo(connectionId2, tgUpdate(5001, 'need your email address', 556002));
    const convId = await convIdForChat('556002');
    await processLatestTurn(convId);

    const posts = sendsToChat('556002');
    const cardMsgId = (posts[0].result as { message_id: number }).message_id;

    // The ⏳ card was edited to plain reply text (no keyboard).
    const plainEdit = editsToMessage(cardMsgId).at(-1);
    expect(plainEdit!.body.text).toBe('Please share your email.');
    expect(plainEdit!.body.reply_markup).toBeUndefined();

    // A separate ForceReply prompt carries the input field.
    const promptSend = posts.findLast(
      (c) => (c.body.reply_markup as { force_reply?: boolean })?.force_reply,
    );
    expect(promptSend).toBeDefined();
    expect(promptSend!.body.text).toBe('Your email?');
    expect((promptSend!.body.reply_markup as { input_field_placeholder?: string }).input_field_placeholder).toBe(
      'you@x.com',
    );
    const promptId = (promptSend!.result as { message_id: number }).message_id;

    // The reply row records the prompt's message id (findMessageByTelegramId ORs it).
    const reply = await latestAgentRaw(convId);
    expect(reply.raw.cardPromptTelegramMessageId).toBe(promptId);

    // Replying to THAT prompt is captured as the card's input answer.
    await postUpdateTo(connectionId2, tgReplyUpdate(5002, promptId, 'me@x.com', 556002));
    const answer = await latestUserRaw(convId);
    expect(answer.content).toBe('me@x.com');
    expect(answer.raw.action).toEqual({ id: 'email', value: 'me@x.com', kind: 'input' });
  });
});

describe('disconnect', () => {
  test('deletes the webhook and the connection; webhook then 404s', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/v1/agents/tg-support/channels/telegram',
      headers: { 'x-api-key': apiKey },
    });
    expect(json(res).deleted).toBe(true);
    expect(tgCalls.some((c) => c.method === 'deleteWebhook')).toBe(true);
    expect((await postUpdate(tgUpdate(300, 'anyone home?'))).statusCode).toBe(404);
  });
});
