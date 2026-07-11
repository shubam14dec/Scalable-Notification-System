/**
 * Phase 10 integration: conversation message edit/delete/typing. Real app +
 * real conversation core + the real @asyncify-hq/agent SDK as the bridge
 * (a stub HTTP server), the conversation processor invoked directly (no
 * worker fleet), and a raw ioredis subscriber to observe the WS pub/sub
 * frames the way the gateway would.
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
import { redis, createRedis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import { createHandler, defineAgent, type HistoryEntry } from '../../packages/agent/src/index';
import { inAppPubSubChannel } from '../../src/providers/inapp';
import { insertConversationMessage } from '../../src/db/conversations.repo';

const AGENT_ID = 'msg-agent';

let app: FastifyInstance;
let bridge: Server;
let bridgeUrl = '';
let apiKey = '';
let tenantId = '';
let signingSecret = '';

const email = `convmsg-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
const json = (res: { body: string }) => JSON.parse(res.body);

/** Every onMessage call, in order — lets bridge-side tests inspect exactly what history rode the wire. */
const capturedHistories: Array<{ text: string; history: HistoryEntry[] }> = [];

const brain = defineAgent({
  onMessage(ctx) {
    capturedHistories.push({ text: ctx.message.text, history: ctx.history });
    return `echo: ${ctx.message.text}`;
  },
});

async function sendTurn(
  text: string,
  messageId: string,
  subscriberId = 'ana',
  headers: Record<string, string> = { 'x-api-key': apiKey },
) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${AGENT_ID}/messages`,
    headers,
    payload: { subscriberId, text, messageId },
  });
  return { status: res.statusCode, body: json(res) };
}

async function runWorkerFor(send: { conversationId: string; messageId: string }) {
  const data: ConversationJobData = { tenantId, ...send };
  await processConversation({ data } as Job<ConversationJobData>);
}

async function dashboardDetail(conversationId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/conversations/${conversationId}`,
    headers: { 'x-api-key': apiKey },
  });
  return json(res);
}

async function widgetTranscript(subscriberId: string, token?: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/agents/${AGENT_ID}/conversation?subscriberId=${subscriberId}`,
    headers: token ? { 'x-subscriber-token': token } : { 'x-api-key': apiKey },
  });
  return { status: res.statusCode, body: json(res) };
}

async function mintToken(subscriberId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/subscriber-tokens',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId },
  });
  return json(res).token as string;
}

/** Raw ioredis SUBSCRIBE, the way the WS gateway consumes these frames. */
async function subscribeCollector(channel: string) {
  const sub = createRedis();
  const events: Array<Record<string, unknown>> = [];
  await sub.subscribe(channel);
  sub.on('message', (_channel: string, raw: string) => {
    events.push(JSON.parse(raw));
  });
  return {
    events,
    close: () => sub.quit(),
  };
}

/** Bounded poll — no long sleeps; used only where there's no promise to await. */
async function waitUntil(pred: () => boolean, timeoutMs = 3000, stepMs = 25): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, stepMs));
  }
  throw new Error('timed out waiting for a condition to become true');
}

beforeAll(async () => {
  app = await buildApp();

  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'ConvMsg IT', email, password: 'integration-pw-1', organizationName: 'ConvMsg IT Org' },
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
    payload: { identifier: AGENT_ID, name: 'Message Edit Agent', bridgeUrl },
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

describe('subscriber edit', () => {
  test('subscriber-token edit of own message updates content and editedAt; widget transcript reflects it', async () => {
    const subscriberId = 'edit-user-1';
    const turn = await sendTurn('original text', 'edit-1', subscriberId);
    const token = await mintToken(subscriberId);

    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${AGENT_ID}/messages/${turn.body.messageId}`,
      headers: { 'x-subscriber-token': token },
      payload: { subscriberId, text: 'edited text' },
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.message.id).toBe(turn.body.messageId);
    expect(body.message.content).toBe('edited text');
    expect(body.message.editedAt).toBeTruthy();

    const widget = await widgetTranscript(subscriberId, token);
    expect(widget.status).toBe(200);
    const row = widget.body.messages.find((m: { id: string }) => m.id === turn.body.messageId);
    expect(row.content).toBe('edited text');
    expect(row.editedAt).toBeTruthy();
  });

  test('editing with a different subscriber token is rejected (403)', async () => {
    const token = await mintToken('edit-owner');
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${AGENT_ID}/messages/does-not-matter`,
      headers: { 'x-subscriber-token': token },
      payload: { subscriberId: 'someone-else', text: 'forged edit' },
    });
    expect(res.statusCode).toBe(403);
  });

  test('editing an agent reply row is 403; editing a message from another conversation is 404', async () => {
    const subscriberId = 'edit-user-2';
    const turn = await sendTurn('trigger a reply', 'edit-2', subscriberId);
    await runWorkerFor(turn.body);
    const detail = await dashboardDetail(turn.body.conversationId);
    const agentRow = detail.messages.find((m: { role: string }) => m.role === 'agent');
    expect(agentRow).toBeDefined();

    const editAgentRow = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${AGENT_ID}/messages/${agentRow.id}`,
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId, text: 'trying to edit the agent' },
    });
    expect(editAgentRow.statusCode).toBe(403);

    // A message that exists, but in a DIFFERENT subscriber's conversation.
    const otherSubscriberId = 'edit-user-3';
    const otherTurn = await sendTurn('a different thread', 'edit-3', otherSubscriberId);

    const crossConversation = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/${AGENT_ID}/messages/${otherTurn.body.messageId}`,
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId, text: 'wrong conversation' },
    });
    expect(crossConversation.statusCode).toBe(404);
  });
});

describe('self delete', () => {
  test('delete own message tombstones the row; repeat delete is idempotent', async () => {
    const subscriberId = 'delete-user-1';
    const turn = await sendTurn('delete me please', 'del-1', subscriberId);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/agents/${AGENT_ID}/messages/${turn.body.messageId}?subscriberId=${subscriberId}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(del.statusCode).toBe(200);
    expect(json(del).deleted).toBe(true);

    const detail = await dashboardDetail(turn.body.conversationId);
    const row = detail.messages.find((m: { id: string }) => m.id === turn.body.messageId);
    expect(row.content).toBe('');
    expect(row.deletedAt).toBeTruthy();
    expect(row.deletedBy).toBe('user');

    const again = await app.inject({
      method: 'DELETE',
      url: `/v1/agents/${AGENT_ID}/messages/${turn.body.messageId}?subscriberId=${subscriberId}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(again.statusCode).toBe(200);
    expect(json(again).deleted).toBe(true);
  });
});

describe('operator delete', () => {
  test('deletes user and agent rows as operator; rejects system rows', async () => {
    const subscriberId = 'operator-user';
    const turn = await sendTurn('operator test message', 'op-del-1', subscriberId);
    const conversationId = turn.body.conversationId;
    await runWorkerFor(turn.body);

    const detail = await dashboardDetail(conversationId);
    const userRow = detail.messages.find((m: { role: string }) => m.role === 'user');
    const agentRow = detail.messages.find((m: { role: string }) => m.role === 'agent');
    expect(userRow).toBeDefined();
    expect(agentRow).toBeDefined();

    const systemRow = await insertConversationMessage({
      conversationId,
      tenantId,
      role: 'system',
      content: 'test breadcrumb for operator-delete rejection',
      dedupeKey: `op-del-system-${Date.now()}`,
    });
    expect(systemRow).not.toBeNull();

    const delUser = await app.inject({
      method: 'DELETE',
      url: `/v1/conversations/${conversationId}/messages/${userRow.id}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(delUser.statusCode).toBe(200);
    expect(json(delUser).deleted).toBe(true);

    const delAgent = await app.inject({
      method: 'DELETE',
      url: `/v1/conversations/${conversationId}/messages/${agentRow.id}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(delAgent.statusCode).toBe(200);
    expect(json(delAgent).deleted).toBe(true);

    const delSystem = await app.inject({
      method: 'DELETE',
      url: `/v1/conversations/${conversationId}/messages/${systemRow!.id}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(delSystem.statusCode).toBe(400);

    const after = await dashboardDetail(conversationId);
    const userAfter = after.messages.find((m: { id: string }) => m.id === userRow.id);
    const agentAfter = after.messages.find((m: { id: string }) => m.id === agentRow.id);
    expect(userAfter.deletedBy).toBe('operator');
    expect(agentAfter.deletedBy).toBe('operator');
    expect(userAfter.content).toBe('');
    expect(agentAfter.content).toBe('');
  });
});

describe('bridge history excludes deleted rows', () => {
  test('a deleted user turn drops out of the history sent to the bridge', async () => {
    const subscriberId = 'history-user-1';
    const t1 = await sendTurn('first message', 'hist-1', subscriberId);
    await runWorkerFor(t1.body);
    const t2 = await sendTurn('second message', 'hist-2', subscriberId);
    await runWorkerFor(t2.body);

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/agents/${AGENT_ID}/messages/${t1.body.messageId}?subscriberId=${subscriberId}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(del.statusCode).toBe(200);

    const t3 = await sendTurn('third message', 'hist-3', subscriberId);
    await runWorkerFor(t3.body);

    const lastCall = capturedHistories.at(-1)!;
    expect(lastCall.text).toBe('third message');
    const historyTexts = lastCall.history.map((h) => h.content);
    // The deleted user turn's own text is gone...
    expect(historyTexts).not.toContain('first message');
    // ...but its still-live agent reply and the untouched second turn remain.
    expect(historyTexts).toContain('echo: first message');
    expect(historyTexts).toContain('second message');
    expect(historyTexts).toContain('echo: second message');
  });
});

describe('deleted-inbound guard', () => {
  test('processConversation no-ops when the inbound row is already deleted', async () => {
    const subscriberId = 'guard-user-1';
    const turn = await sendTurn('to be deleted before processing', 'guard-1', subscriberId);

    const before = await dashboardDetail(turn.body.conversationId);
    expect(before.messages.length).toBe(1); // just the inbound user row so far

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/agents/${AGENT_ID}/messages/${turn.body.messageId}?subscriberId=${subscriberId}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(del.statusCode).toBe(200);

    // Same job data the queue would have carried — enqueue-shaped.
    await runWorkerFor(turn.body);

    const after = await dashboardDetail(turn.body.conversationId);
    expect(after.messages.length).toBe(1); // no new agent reply row
    expect(after.messages.some((m: { role: string }) => m.role === 'agent')).toBe(false);
  });
});

describe('typing indicator', () => {
  test('a conversation.typing pulse precedes the reply on the subscriber channel', async () => {
    const subscriberId = 'typing-user-1';
    const collector = await subscribeCollector(inAppPubSubChannel(tenantId, subscriberId));
    try {
      const turn = await sendTurn('say something', 'typing-1', subscriberId);
      await runWorkerFor(turn.body);
      await waitUntil(() => collector.events.some((e) => e.type === 'conversation.message'));

      const typingIdx = collector.events.findIndex((e) => e.type === 'conversation.typing');
      const messageIdx = collector.events.findIndex((e) => e.type === 'conversation.message');
      expect(typingIdx).toBeGreaterThanOrEqual(0);
      expect(messageIdx).toBeGreaterThan(typingIdx);
    } finally {
      await collector.close();
    }
  });
});

describe('edit/delete WS publications', () => {
  test('editing publishes conversation.message.updated with the right message id', async () => {
    const subscriberId = 'ws-edit-user';
    const turn = await sendTurn('editable text', 'wsedit-1', subscriberId);
    const collector = await subscribeCollector(inAppPubSubChannel(tenantId, subscriberId));
    try {
      const res = await app.inject({
        method: 'PATCH',
        url: `/v1/agents/${AGENT_ID}/messages/${turn.body.messageId}`,
        headers: { 'x-api-key': apiKey },
        payload: { subscriberId, text: 'edited via ws test' },
      });
      expect(res.statusCode).toBe(200);

      await waitUntil(() => collector.events.some((e) => e.type === 'conversation.message.updated'));
      const evt = collector.events.find((e) => e.type === 'conversation.message.updated') as {
        message: { id: string };
      };
      expect(evt.message.id).toBe(turn.body.messageId);
    } finally {
      await collector.close();
    }
  });

  test('deleting publishes conversation.message.deleted with the right message id', async () => {
    const subscriberId = 'ws-delete-user';
    const turn = await sendTurn('to be deleted via ws test', 'wsdel-1', subscriberId);
    const collector = await subscribeCollector(inAppPubSubChannel(tenantId, subscriberId));
    try {
      const res = await app.inject({
        method: 'DELETE',
        url: `/v1/agents/${AGENT_ID}/messages/${turn.body.messageId}?subscriberId=${subscriberId}`,
        headers: { 'x-api-key': apiKey },
      });
      expect(res.statusCode).toBe(200);

      await waitUntil(() => collector.events.some((e) => e.type === 'conversation.message.deleted'));
      const evt = collector.events.find((e) => e.type === 'conversation.message.deleted') as {
        message: { id: string };
      };
      expect(evt.message.id).toBe(turn.body.messageId);
    } finally {
      await collector.close();
    }
  });
});
