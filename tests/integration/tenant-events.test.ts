/**
 * Phase 25 slice D — the admin live-events emitter, end to end. Proves the two
 * halves of the "socket is a hint, Postgres is the truth" pipe from the WRITE
 * side: (1) emitTenantEvent's envelope + channel contract and its never-throws
 * guarantee, and (2) that the real write paths fire the right hint after their
 * Postgres commit.
 *
 * A dedicated Redis client SUBSCRIBEs to `tenant-events:<tenantId>` and records
 * every envelope; each test resets the buffer, drives a real path (a stubbed
 * managed turn, an approval decide via the API route, a knowledge index walk, a
 * memories PUT, an inapp delivery), and asserts the hint(s) landed. Only the
 * model server and the two knowledge backends are faked — every emit site is
 * production code.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Job } from 'bullmq';
import type { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, getQueue, QUEUE } from '../../src/shared/queues';
import { redis, createRedis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { emitTenantEvent, tenantEventsChannel } from '../../src/core/tenant-events';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import {
  processKnowledge,
  type KnowledgeJobData,
} from '../../src/workers/processors/knowledge.processor';
import { processFanout } from '../../src/workers/processors/fanout.processor';
import { processDelivery } from '../../src/workers/processors/delivery.processor';
import {
  startEmbeddingsStub,
  startPineconeStub,
  type EmbeddingsStub,
  type PineconeStub,
} from '../helpers/knowledge-fakes';

const AGENT = 'te-agent';
const GATED_TOOL = 'te_gated_ship';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let toolStub: Server;
let toolUrl = '';
let embeddings: EmbeddingsStub;
let pinecone: PineconeStub;

const json = (res: { body: string }) => JSON.parse(res.body);

// ---- Redis SUBSCRIBE probe on the tenant's admin channel ----
let probe: Redis;
interface Hint {
  type: string;
  id?: string;
  at: string;
}
const seen: Hint[] = [];
const reset = () => {
  seen.length = 0;
};
/** Poll the buffer until >= min hints of `type` arrive (pub/sub is async). */
async function waitFor(type: string, min = 1, timeoutMs = 4000): Promise<Hint[]> {
  const start = Date.now();
  for (;;) {
    const hits = seen.filter((e) => e.type === type);
    if (hits.length >= min || Date.now() - start >= timeoutMs) return hits;
    await new Promise((r) => setTimeout(r, 25));
  }
}

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
const toolUseResponse = (uses: Array<{ id: string; name: string; input: unknown }>) =>
  envelope(uses.map((u) => ({ type: 'tool_use', ...u })), 'tool_use');
const textResponse = (text: string) => envelope([{ type: 'text', text }], 'end_turn');
function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(llmQueue.length > 0 ? llmQueue.shift() : textResponse('ok')));
    });
  });
  return new Promise((r) => llmStub.listen(0, '127.0.0.1', () => r()));
}

// ---- a trivial customer tool endpoint (never dialed here — we deny) ----
function startToolStub(): Promise<void> {
  toolStub = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ ok: true }));
  });
  return new Promise((r) => toolStub.listen(0, '127.0.0.1', () => r()));
}

// ---- helpers ----
async function runTurn(
  subscriberId: string,
  text: string,
  messageId: string,
): Promise<{ conversationId: string; messageId: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${AGENT}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  const turn = json(res) as { conversationId: string; messageId: string };
  await processConversation({
    data: { tenantId, conversationId: turn.conversationId, messageId: turn.messageId },
  } as Job<ConversationJobData>);
  return turn;
}

async function insertSubscriber(externalId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into subscribers (tenant_id, external_id) values ($1, $2)
     on conflict (tenant_id, external_id) do update set updated_at = now()
     returning id`,
    [tenantId, externalId],
  );
  return rows[0].id;
}

async function addIntegration(
  channel: string,
  provider: string,
  credentials: Record<string, unknown>,
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/integrations',
    headers: { 'x-api-key': apiKey },
    payload: { channel, provider, credentials },
  });
  expect(res.statusCode, `create ${channel} integration`).toBe(201);
  return json(res).id as string;
}

const KB_TEXT = Array.from(
  { length: 40 },
  (_, i) => `Acme returns policy note ${i}: refunds go to the original method within thirty days.`,
).join('\n\n');

beforeAll(async () => {
  await Promise.all([startLlmStub(), startToolStub()]);
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;
  toolUrl = `http://127.0.0.1:${(toolStub.address() as AddressInfo).port}/tool`;
  embeddings = await startEmbeddingsStub(8);
  pinecone = await startPineconeStub();

  app = await buildApp();
  const email = `te-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'TE IT', email, password: 'integration-pw-1', organizationName: 'TE Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  const create = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: AGENT,
      name: 'Tenant Events Agent',
      runtime: 'managed',
      model: 'glm-4-test',
      llm: { apiKey: 'managed-test-key', baseUrl: llmBaseUrl },
    },
  });
  expect(create.statusCode).toBe(201);

  const tool = await app.inject({
    method: 'POST',
    url: `/v1/agents/${AGENT}/tools`,
    headers: { 'x-api-key': apiKey },
    payload: {
      name: GATED_TOOL,
      description: 'Ship an order (gated)',
      parameters: { type: 'object', properties: { orderId: { type: 'string' } } },
      endpointUrl: toolUrl,
      approval: 'required',
    },
  });
  expect(tool.statusCode).toBe(201);

  // Knowledge backends: embeddings + vector store, /test to seal dim + create index.
  const embeddingsId = await addIntegration('embeddings', 'openai-compat', {
    baseUrl: embeddings.baseUrl,
    apiKey: 'embed-key',
    model: 'text-embed-test',
  });
  expect((await app.inject({
    method: 'POST',
    url: `/v1/integrations/${embeddingsId}/test`,
    headers: { 'x-api-key': apiKey },
    payload: {},
  })).statusCode).toBe(200);
  const vectorId = await addIntegration('vectorstore', 'pinecone', {
    apiKey: 'pinecone-key',
    indexName: 'te-knowledge',
  });
  expect((await app.inject({
    method: 'POST',
    url: `/v1/integrations/${vectorId}/test`,
    headers: { 'x-api-key': apiKey },
    payload: {},
  })).statusCode).toBe(200);

  probe = createRedis();
  await probe.subscribe(tenantEventsChannel(tenantId));
  probe.on('message', (_channel, message) => {
    try {
      seen.push(JSON.parse(message) as Hint);
    } catch {
      /* ignore non-JSON */
    }
  });
});

afterAll(async () => {
  try {
    await pool.query('delete from subscriber_memories where tenant_id = $1', [tenantId]);
    await pool.query('delete from agent_tool_calls where tenant_id = $1', [tenantId]);
    await pool.query('delete from agent_tool_defs where tenant_id = $1', [tenantId]);
    await pool.query('delete from knowledge_sources where tenant_id = $1', [tenantId]);
    await pool.query('delete from messages where tenant_id = $1', [tenantId]);
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await pool.query('delete from events where tenant_id = $1', [tenantId]);
    await pool.query('delete from integrations where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
    await getQueue(QUEUE.CONVERSATION).obliterate({ force: true });
    await getQueue(QUEUE.KNOWLEDGE).obliterate({ force: true });
    const keys = await redis.keys(`txn:${tenantId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    /* best-effort cleanup */
  }
  await probe?.quit();
  llmStub?.close();
  toolStub?.close();
  embeddings?.close();
  pinecone?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

// ===================================================================
// (a) the envelope + channel contract
// ===================================================================
describe('emitTenantEvent envelope + channel', () => {
  test('publishes {type, id, at-ISO} on tenant-events:<tenantId>', async () => {
    reset();
    await emitTenantEvent(tenantId, 'conversation.changed', 'conv-contract-1');
    const hits = await waitFor('conversation.changed');
    const evt = hits.find((h) => h.id === 'conv-contract-1');
    expect(evt).toBeDefined();
    expect(evt!.type).toBe('conversation.changed');
    expect(evt!.id).toBe('conv-contract-1');
    // `at` is a round-trippable ISO-8601 instant.
    expect(typeof evt!.at).toBe('string');
    expect(new Date(evt!.at).toISOString()).toBe(evt!.at);
  });

  test('omits id when none is passed', async () => {
    reset();
    await emitTenantEvent(tenantId, 'queue.deadletter');
    const hits = await waitFor('queue.deadletter');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits[0]).not.toHaveProperty('id');
    expect(hits[0]).toHaveProperty('at');
  });

  test("another tenant's emit never lands on this channel (cross-tenant isolation)", async () => {
    reset();
    // A sentinel id on a DIFFERENT tenant's channel — must never reach our probe.
    await emitTenantEvent('00000000-0000-4000-8000-0000000000ff', 'conversation.changed', 'ISO-SENTINEL');
    await new Promise((r) => setTimeout(r, 250));
    expect(seen.some((h) => h.id === 'ISO-SENTINEL')).toBe(false);
  });
});

// ===================================================================
// (b) never-throws: a Redis publish failure must not break the write path
// ===================================================================
describe('emitTenantEvent never throws', () => {
  test('a rejecting redis.publish resolves to undefined (hint dropped, not raised)', async () => {
    const original = redis.publish.bind(redis);
    (redis as unknown as { publish: () => Promise<number> }).publish = () =>
      Promise.reject(new Error('redis down'));
    try {
      await expect(emitTenantEvent(tenantId, 'conversation.changed', 'boom')).resolves.toBeUndefined();
    } finally {
      (redis as unknown as { publish: typeof original }).publish = original;
    }
  });
});

// ===================================================================
// (c) emit points fire after their real write commits
// ===================================================================
describe('emit points fire on real writes', () => {
  test('a stubbed managed turn → conversation.changed (>=1: open + reply)', async () => {
    reset();
    llmQueue = [textResponse('hi there')];
    const turn = await runTurn('te-conv-user', 'hello', 'te-conv-1');
    const hits = await waitFor('conversation.changed');
    expect(hits.length).toBeGreaterThanOrEqual(1);
    expect(hits.some((h) => h.id === turn.conversationId)).toBe(true);
  });

  test('an approval flow → approval.changed on CREATE and on DECIDE (via the API route)', async () => {
    // CREATE: a gated tool call pauses the turn and emits approval.changed.
    reset();
    llmQueue = [toolUseResponse([{ id: 'ta1', name: GATED_TOOL, input: { orderId: '#te1' } }])];
    const turn = await runTurn('te-appr-user', 'ship it', 'te-appr-1');
    const created = await waitFor('approval.changed');
    expect(created.length).toBeGreaterThanOrEqual(1);

    const { rows } = await pool.query<{ id: string }>(
      `select id from agent_tool_calls
        where conversation_id = $1 and status = 'pending'
        order by requested_at desc limit 1`,
      [turn.conversationId],
    );
    expect(rows).toHaveLength(1);
    const callId = rows[0].id;
    expect(created.some((h) => h.id === callId)).toBe(true);

    // DECIDE: the API decision route emits approval.changed for the same call id.
    reset();
    const decide = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${callId}/decision`,
      headers: { 'x-api-key': apiKey },
      payload: { decision: 'deny', note: 'not this time' },
    });
    expect(decide.statusCode).toBe(200);
    const decided = await waitFor('approval.changed');
    expect(decided.some((h) => h.id === callId)).toBe(true);
  });

  test('a knowledge text source create→ready walk → knowledge.changed >=2 transitions', async () => {
    reset();
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agents/${AGENT}/knowledge`,
      headers: { 'x-api-key': apiKey },
      payload: { name: 'te-returns-policy', kind: 'text', text: KB_TEXT },
    });
    expect(res.statusCode).toBe(201);
    const sourceId = json(res).source.id as string;

    const job = await getQueue(QUEUE.KNOWLEDGE).getJob(`knowledge-index-${sourceId}`);
    expect(job).toBeTruthy();
    await processKnowledge(job as Job<KnowledgeJobData>);

    const { rows } = await pool.query<{ status: string }>(
      'select status from knowledge_sources where id = $1',
      [sourceId],
    );
    expect(rows[0].status).toBe('ready');

    const hits = await waitFor('knowledge.changed', 2);
    expect(hits.length).toBeGreaterThanOrEqual(2); // create + indexing + ready
    expect(hits.every((h) => h.id === sourceId)).toBe(true);
  });

  test('a memories PUT → memory.changed (id = subscriber external id)', async () => {
    await insertSubscriber('te-mem-cust');
    reset();
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/agents/${AGENT}/memories/te-mem-cust`,
      headers: { 'x-api-key': apiKey },
      payload: { key: 'plan', value: 'Pro' },
    });
    expect(put.statusCode).toBe(200);
    const hits = await waitFor('memory.changed');
    expect(hits.some((h) => h.id === 'te-mem-cust')).toBe(true);
  });

  test('an inapp delivery reaching sent → message.changed (the manager-added emit)', async () => {
    await app.inject({
      method: 'PUT',
      url: '/v1/workflows',
      headers: { 'x-api-key': apiKey },
      payload: { key: 'te-inapp', name: 'TE Inapp', steps: [{ channel: 'inapp', body: 'hi {{n}}' }] },
    });
    await app.inject({
      method: 'PUT',
      url: '/v1/subscribers',
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId: 'te-inapp-user' },
    });
    const trig = await app.inject({
      method: 'POST',
      url: '/v1/events/trigger',
      headers: { 'x-api-key': apiKey },
      payload: { workflowKey: 'te-inapp', to: [{ subscriberId: 'te-inapp-user' }], payload: { n: 'x' } },
    });
    expect(trig.statusCode).toBe(202);
    const eventId = json(trig).eventId as string;

    await processFanout({ data: { eventId, recipients: [{ subscriberId: 'te-inapp-user' }] } } as Job);
    const { rows } = await pool.query<{ id: string }>(
      'select id from messages where event_id = $1',
      [eventId],
    );
    expect(rows).toHaveLength(1);
    const messageId = rows[0].id;

    reset();
    await processDelivery({ data: { messageId }, attemptsMade: 0 } as unknown as Job);

    const after = await pool.query<{ status: string }>('select status from messages where id = $1', [
      messageId,
    ]);
    expect(after.rows[0].status).toBe('sent');

    const hits = await waitFor('message.changed');
    expect(hits.some((h) => h.id === messageId)).toBe(true);
  });
});
