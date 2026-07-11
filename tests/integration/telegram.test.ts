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
// Unique per send, like the real API — label recovery for button clicks
// looks replies up by telegramMessageId, so a constant would be ambiguous.
let messageIdSeq = 4242;

function startTelegramStub(): Promise<void> {
  tgStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = String(req.url).split('/').pop() ?? '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const results: Record<string, unknown> = {
        getMe: { id: 7000001, is_bot: true, username: 'itest_bot' },
        setWebhook: true,
        deleteWebhook: true,
        getWebhookInfo: { url: 'https://example.test/hook', pending_update_count: 0 },
        sendMessage: { message_id: method === 'sendMessage' ? ++messageIdSeq : 0 },
        answerCallbackQuery: true,
        editMessageText: true,
        deleteMessage: true,
      };
      tgCalls.push({ method, body, result: results[method] });
      if (method === 'setWebhook') webhookSecretSeen = String(body.secret_token ?? '');
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

beforeAll(async () => {
  await startTelegramStub();
  process.env.TELEGRAM_API_BASE = `http://localhost:${(tgStub.address() as AddressInfo).port}`;

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
