/**
 * Turn-trace persistence (Phase 21, slice D): the real conversation processor
 * persists a per-turn execution trace wherever it persists usage. Managed turns
 * (stubbed Anthropic Messages API) land a model_call trace on the reply row and
 * on refusal notes; the detail endpoint passes the trace through per message;
 * and a bridge turn lands a single bridge_post event on its reply row.
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

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';

const json = (res: { body: string }) => JSON.parse(res.body);

// ---- stub Anthropic-compatible model server ----
let llmStub: Server;
let llmBaseUrl = '';
let llmQueue: unknown[] = [];
const envelope = (content: unknown[], stopReason: string) => ({
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: 'glm-4-test',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const llmText = (text: string) => envelope([{ type: 'text', text }], 'end_turn');

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(llmQueue.length > 0 ? llmQueue.shift() : llmText('default reply')));
    });
  });
  return new Promise((r) => llmStub.listen(0, () => r()));
}

// ---- stub bridge server (returns a plain reply + no signals) ----
let bridge: Server;
let bridgeUrl = '';
function startBridge(): Promise<void> {
  bridge = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c as Uint8Array)));
    req.on('end', () => {
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ reply: 'bridge reply', signals: [] }));
    });
  });
  return new Promise((r) => bridge.listen(0, () => r()));
}

async function sendManaged(subscriberId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents/ttp-managed/messages',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  return json(res) as { conversationId: string; messageId: string };
}
async function sendBridge(subscriberId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents/ttp-bridge/messages',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  return json(res) as { conversationId: string; messageId: string };
}

async function runWorker(conversationId: string, messageId: string) {
  await processConversation({ data: { tenantId, conversationId, messageId } } as Job<ConversationJobData>);
}

/** Read a role's latest row raw straight from the table (detail hides some raw). */
async function latestRaw(conversationId: string, role: 'agent' | 'system'): Promise<Record<string, unknown>> {
  const { rows } = await pool.query(
    `select raw from conversation_messages
      where conversation_id = $1 and role = $2 order by created_at desc limit 1`,
    [conversationId, role],
  );
  return (rows[0]?.raw ?? {}) as Record<string, unknown>;
}

beforeAll(async () => {
  await startLlmStub();
  await startBridge();
  llmBaseUrl = `http://localhost:${(llmStub.address() as AddressInfo).port}`;
  bridgeUrl = `http://localhost:${(bridge.address() as AddressInfo).port}/`;

  app = await buildApp();
  const email = `ttp-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'TTP IT', email, password: 'integration-pw-1', organizationName: 'TTP IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  const managed = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: 'ttp-managed',
      name: 'TTP Managed',
      runtime: 'managed',
      model: 'glm-4-test',
      llm: { apiKey: 'ttp-key-123456', baseUrl: llmBaseUrl },
    },
  });
  expect(managed.statusCode).toBe(201);

  const bridgeAgent = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: { identifier: 'ttp-bridge', name: 'TTP Bridge', bridgeUrl },
  });
  expect(bridgeAgent.statusCode).toBe(201);
});

afterAll(async () => {
  bridge?.close();
  llmStub?.close();
  await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('managed turn trace persistence', () => {
  test('a reply row carries raw.trace with one end_turn model_call and matching usage', async () => {
    llmQueue = [llmText('managed reply here')];
    const turn = await sendManaged('ttp-sub-1', 'hello', 'ttp-1');
    await runWorker(turn.conversationId, turn.messageId);

    const raw = await latestRaw(turn.conversationId, 'agent');
    const trace = raw.trace as { totalMs: number; events: Array<Record<string, unknown>> };
    expect(trace).toBeDefined();
    expect(trace.totalMs).toBeGreaterThanOrEqual(0);
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0]).toMatchObject({ t: 'model_call', stopReason: 'end_turn', inputTokens: 10, outputTokens: 5 });
    expect(raw.usage).toMatchObject({ inputTokens: 10, outputTokens: 5, modelCalls: 1 });
  });

  test('a refusal note row carries raw.trace with a refusal model_call', async () => {
    llmQueue = [envelope([], 'refusal')];
    const turn = await sendManaged('ttp-sub-2', 'refuse this', 'ttp-2');
    await runWorker(turn.conversationId, turn.messageId);

    const raw = await latestRaw(turn.conversationId, 'system');
    const trace = raw.trace as { events: Array<Record<string, unknown>> };
    expect(trace).toBeDefined();
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0]).toMatchObject({ t: 'model_call', stopReason: 'refusal' });
    // No reply row to carry it — the note is the trace's only home this turn.
    expect(raw.usage).toBeDefined();
  });

  test('the detail endpoint passes the trace through per message', async () => {
    llmQueue = [llmText('traced for the detail view')];
    const turn = await sendManaged('ttp-sub-3', 'trace passthrough', 'ttp-3');
    await runWorker(turn.conversationId, turn.messageId);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${turn.conversationId}`,
      headers: { 'x-api-key': apiKey },
    });
    const reply = json(res).messages.findLast((m: { role: string }) => m.role === 'agent');
    expect(reply.trace).toBeDefined();
    expect(reply.trace.events.some((e: { t: string }) => e.t === 'model_call')).toBe(true);
  });
});

describe('bridge turn trace persistence', () => {
  test('a bridge reply row carries one bridge_post event with status 200 and ok true', async () => {
    const turn = await sendBridge('ttp-bridge-sub', 'hi bridge', 'ttp-b-1');
    await runWorker(turn.conversationId, turn.messageId);

    const raw = await latestRaw(turn.conversationId, 'agent');
    const trace = raw.trace as { totalMs: number; events: Array<Record<string, unknown>> };
    expect(trace).toBeDefined();
    expect(trace.totalMs).toBeGreaterThanOrEqual(0);
    expect(trace.events).toHaveLength(1);
    expect(trace.events[0]).toMatchObject({ t: 'bridge_post', status: 200, ok: true });
    expect(typeof (trace.events[0] as { ms: number }).ms).toBe('number');
  });
});
