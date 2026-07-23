/**
 * Phase 23 slice E — knowledge ingestion lifecycle, end to end against the real
 * Fastify app + the real knowledge queue processor, with the two BYO backends
 * faked in-process (tests/helpers/knowledge-fakes.ts): an OpenAI-shaped
 * embeddings server and a combined Pinecone control+data plane. Every hop
 * between them — routes, sealing, chunker, repo, upsert/cleanup jobs — is
 * production code.
 *
 * Covers: config gating (400 names the MISSING integration), the embeddings
 * probe + Pinecone create-index via /test, POST text source -> index job ->
 * ready with chunk rows and vector ids that match the chunk ids, the GET view
 * shape, 409 duplicate name, url-source SSRF rejection, reindex of a text source
 * (re-embed in place: chunk ROWS preserved, vectors re-upserted), DELETE
 * (rows gone + a cleanup job that deletes EXACTLY those vector ids), and the
 * mixed-dim guard (flip the embeddings dim -> retrieval excludes old-dim chunks).
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
  processKnowledge,
  type KnowledgeJobData,
} from '../../src/workers/processors/knowledge.processor';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import {
  startEmbeddingsStub,
  startPineconeStub,
  type EmbeddingsStub,
  type PineconeStub,
} from '../helpers/knowledge-fakes';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let embeddings: EmbeddingsStub;
let pinecone: PineconeStub;
let embeddingsId = '';

const json = (res: { body: string }) => JSON.parse(res.body);
const AGENT = 'kb-agent';

// ---- stub Anthropic-compatible model server (only used by the mixed-dim test) ----
let llmStub: Server;
let llmBaseUrl = '';
const llmSeen: Array<{ system?: unknown; tools?: Array<{ name: string }>; messages: any[] }> = [];
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
const llmToolUse = (uses: Array<{ id: string; name: string; input: unknown }>) =>
  envelope(uses.map((u) => ({ type: 'tool_use', ...u })), 'tool_use');
const llmText = (text: string) => envelope([{ type: 'text', text }], 'end_turn');

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      llmSeen.push(JSON.parse(raw));
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(llmQueue.length > 0 ? llmQueue.shift() : llmText('default reply')));
    });
  });
  return new Promise((r) => llmStub.listen(0, '127.0.0.1', () => r()));
}

/** The tool_result the model saw on its most recent request (retrieval output). */
function lastToolResult(): string {
  const msgs = llmSeen.at(-1)!.messages;
  const last = msgs.at(-1) as { role: string; content: Array<{ content: string }> };
  return last.content[0].content;
}

// ---- helpers ----
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

async function testIntegration(id: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/integrations/${id}/test`,
    headers: { 'x-api-key': apiKey },
    payload: {},
  });
  return { status: res.statusCode, body: json(res) };
}

async function postSource(payload: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/v1/agents/${AGENT}/knowledge`,
    headers: { 'x-api-key': apiKey },
    payload,
  });
}

async function getJob(jobId: string): Promise<Job<KnowledgeJobData>> {
  const job = await getQueue(QUEUE.KNOWLEDGE).getJob(jobId);
  if (!job) throw new Error(`job ${jobId} not found`);
  return job as Job<KnowledgeJobData>;
}

/** Find the most recent queued knowledge job matching a predicate on its data. */
async function findJob(pred: (d: KnowledgeJobData, id: string) => boolean): Promise<Job<KnowledgeJobData>> {
  const jobs = (await getQueue(QUEUE.KNOWLEDGE).getJobs([
    'waiting',
    'delayed',
    'active',
    'paused',
    'completed',
  ])) as Job<KnowledgeJobData>[];
  const match = jobs.filter((j) => pred(j.data, String(j.id)));
  if (match.length === 0) throw new Error('no matching knowledge job');
  return match.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0))[0];
}

async function chunkIdsFor(sourceId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    'select id from knowledge_chunks where source_id = $1 order by seq asc',
    [sourceId],
  );
  return rows.map((r) => r.id);
}

async function sourceStatus(sourceId: string): Promise<string | null> {
  const { rows } = await pool.query<{ status: string }>(
    'select status from knowledge_sources where id = $1',
    [sourceId],
  );
  return rows[0]?.status ?? null;
}

async function sendMessage(subscriberId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${AGENT}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  return json(res) as { conversationId: string; messageId: string };
}

async function runTurn(subscriberId: string, text: string, messageId: string) {
  const turn = await sendMessage(subscriberId, text, messageId);
  await processConversation({
    data: { tenantId, conversationId: turn.conversationId, messageId: turn.messageId },
  } as Job<ConversationJobData>);
  return turn;
}

beforeAll(async () => {
  embeddings = await startEmbeddingsStub(8);
  pinecone = await startPineconeStub();
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `knowledge-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Knowledge IT', email, password: 'integration-pw-1', organizationName: 'Knowledge Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: AGENT,
      name: 'KB Agent',
      runtime: 'managed',
      model: 'glm-4-test',
      llm: { apiKey: 'managed-test-key', baseUrl: llmBaseUrl },
    },
  });
});

afterAll(async () => {
  try {
    await pool.query('delete from conversation_summaries where tenant_id = $1', [tenantId]);
    await pool.query('delete from knowledge_sources where tenant_id = $1', [tenantId]);
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await pool.query('delete from events where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
    await pool.query('delete from integrations where tenant_id = $1', [tenantId]);
    const txnKeys = await redis.keys(`txn:${tenantId}:*`);
    if (txnKeys.length > 0) await redis.del(...txnKeys);
  } catch {
    /* best-effort cleanup */
  }
  embeddings?.close();
  pinecone?.close();
  llmStub?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

// A multi-paragraph document that chunks into several pieces under the default cap.
const POLICY_TEXT = Array.from({ length: 60 }, (_, i) =>
  `Acme returns policy note ${i}: refunds are issued to the original method within thirty days of delivery.`,
).join('\n\n');

// ===================================================================
// Config gating — the feature requires BOTH integrations, names the gap
// ===================================================================
describe('config gating', () => {
  test('with neither integration, POST source is 400 naming BOTH', async () => {
    const res = await postSource({ name: 'nope', kind: 'text', text: 'hello world' });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toContain('embeddings integration');
    expect(json(res).error).toContain('vector store integration');
  });

  test('add embeddings + /test records the probed dimension (8)', async () => {
    embeddingsId = await addIntegration('embeddings', 'openai-compat', {
      baseUrl: embeddings.baseUrl,
      apiKey: 'embed-key',
      model: 'text-embed-test',
    });
    const { status, body } = await testIntegration(embeddingsId);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, dim: 8 });
  });

  test('with only embeddings, POST source is 400 naming just the vector store', async () => {
    const res = await postSource({ name: 'nope', kind: 'text', text: 'hello world' });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toContain('vector store integration');
    expect(json(res).error).not.toContain('embeddings integration');
  });

  test('add vector store + /test creates the index at the embeddings dim', async () => {
    const vectorId = await addIntegration('vectorstore', 'pinecone', {
      apiKey: 'pinecone-key',
      indexName: 'acme-knowledge',
    });
    const { status, body } = await testIntegration(vectorId);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, dim: 8, created: true });
    expect(body.host).toBe(pinecone.host);
  });
});

// ===================================================================
// Text source lifecycle
// ===================================================================
describe('text source lifecycle', () => {
  let sourceId = '';
  let indexedChunkIds: string[] = [];

  test('POST text source -> 201 pending, and the index job carries the inline text', async () => {
    const res = await postSource({ name: 'returns-policy', kind: 'text', text: POLICY_TEXT });
    expect(res.statusCode).toBe(201);
    const view = json(res).source;
    expect(view).toMatchObject({ name: 'returns-policy', kind: 'text', status: 'pending' });
    sourceId = view.id;

    const job = await getJob(`knowledge-index-${sourceId}`);
    expect(job.data.kind).toBe('index');
    expect(job.data.tenantId).toBe(tenantId);
    expect(job.data.sourceId).toBe(sourceId);
    // Raw text rides inline in the job (never persisted on the source).
    expect(job.data.text).toBe(POLICY_TEXT);
  });

  test('processing the job -> ready; chunk rows exist; upsert ids == chunk ids in the tenant namespace', async () => {
    pinecone.resetHistory();
    const job = await getJob(`knowledge-index-${sourceId}`);
    await processKnowledge(job);

    expect(await sourceStatus(sourceId)).toBe('ready');
    indexedChunkIds = await chunkIdsFor(sourceId);
    expect(indexedChunkIds.length).toBeGreaterThan(1); // the doc chunked into several pieces

    // Every chunk row was stamped with the current embedding dim.
    const { rows: dims } = await pool.query<{ embedding_dim: number }>(
      'select distinct embedding_dim from knowledge_chunks where source_id = $1',
      [sourceId],
    );
    expect(dims).toEqual([{ embedding_dim: 8 }]);

    // The vectors upserted (in the tenant namespace) are EXACTLY the chunk ids.
    const upsertedIds = pinecone.upserts
      .filter((u) => u.namespace === tenantId)
      .flatMap((u) => u.ids);
    expect(new Set(upsertedIds)).toEqual(new Set(indexedChunkIds));
    // And the live namespace holds one vector per chunk.
    expect(pinecone.namespaces.get(tenantId)!.size).toBe(indexedChunkIds.length);
  });

  test('GET returns the source view shape', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/agents/${AGENT}/knowledge`,
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    const src = json(res).sources.find((s: { name: string }) => s.name === 'returns-policy');
    expect(src).toMatchObject({ name: 'returns-policy', kind: 'text', status: 'ready', error: null });
    expect(src.chunkCount).toBe(indexedChunkIds.length);
    expect(typeof src.id).toBe('string');
    expect(typeof src.createdAt).toBe('string');
    expect(typeof src.updatedAt).toBe('string');
  });

  test('duplicate name on the same agent -> 409', async () => {
    const res = await postSource({ name: 'returns-policy', kind: 'text', text: 'different body' });
    expect(res.statusCode).toBe(409);
    expect(json(res).error).toContain('already exists');
  });

  test('reindex re-embeds in place: chunk ROWS preserved, vectors re-upserted', async () => {
    const before = await chunkIdsFor(sourceId);
    pinecone.resetHistory();

    const res = await app.inject({
      method: 'POST',
      url: `/v1/agents/${AGENT}/knowledge/${sourceId}/reindex`,
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(202);
    expect(json(res).status).toBe('pending');

    // The reindex enqueues a nonce-suffixed index job with NO inline text.
    const job = await findJob(
      (d, id) => id.startsWith(`knowledge-index-${sourceId}-`) && d.text === undefined,
    );
    await processKnowledge(job);

    expect(await sourceStatus(sourceId)).toBe('ready');
    // Same chunk row ids (re-embed in place, not re-chunk).
    expect(await chunkIdsFor(sourceId)).toEqual(before);
    // Old vectors dropped then the same ids re-upserted.
    const reupserted = pinecone.upserts.filter((u) => u.namespace === tenantId).flatMap((u) => u.ids);
    expect(new Set(reupserted)).toEqual(new Set(before));
    const deleted = pinecone.deletes.filter((u) => u.namespace === tenantId).flatMap((u) => u.ids);
    expect(new Set(deleted)).toEqual(new Set(before));
  });

  test('DELETE removes rows and enqueues a cleanup job that drops EXACTLY those vectors', async () => {
    const ids = await chunkIdsFor(sourceId);
    pinecone.resetHistory();

    const res = await app.inject({
      method: 'DELETE',
      url: `/v1/agents/${AGENT}/knowledge/${sourceId}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).deleted).toBe(true);

    // Rows are gone (source + chunks via cascade).
    expect(await sourceStatus(sourceId)).toBeNull();
    expect(await chunkIdsFor(sourceId)).toEqual([]);

    // The cleanup job carries exactly the deleted chunk vector ids.
    const cleanup = await getJob(`knowledge-cleanup-${sourceId}`);
    expect(cleanup.data.kind).toBe('cleanup');
    expect(new Set(cleanup.data.ids)).toEqual(new Set(ids));

    // Running it drives the external delete of exactly those ids.
    await processKnowledge(cleanup);
    const deleted = pinecone.deletes.filter((u) => u.namespace === tenantId).flatMap((u) => u.ids);
    expect(new Set(deleted)).toEqual(new Set(ids));
    expect(pinecone.namespaces.get(tenantId)!.size).toBe(0);
  });
});

// ===================================================================
// URL source SSRF gate
// ===================================================================
describe('url source SSRF gate', () => {
  test('a link-local metadata URL is rejected at save time (400)', async () => {
    const res = await postSource({
      name: 'ssrf-attempt',
      kind: 'url',
      url: 'http://169.254.169.254/latest/meta-data/',
    });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toContain('url rejected');
    // Nothing was created.
    const { rows } = await pool.query(
      'select 1 from knowledge_sources where tenant_id = $1 and name = $2',
      [tenantId, 'ssrf-attempt'],
    );
    expect(rows.length).toBe(0);
  });
});

// ===================================================================
// Mixed-dim guard — retrieval excludes chunks embedded at a different dim
// ===================================================================
describe('mixed-dim guard', () => {
  let faqSourceId = '';

  test('setup: index an FAQ source at dim 8 and confirm grounded retrieval', async () => {
    const res = await postSource({
      name: 'faq',
      kind: 'text',
      text: 'Our warranty covers manufacturing defects for one full year from purchase.',
    });
    expect(res.statusCode).toBe(201);
    faqSourceId = json(res).source.id;
    await processKnowledge(await getJob(`knowledge-index-${faqSourceId}`));
    expect(await sourceStatus(faqSourceId)).toBe('ready');

    // A turn where the model calls search_knowledge -> the excerpt comes back
    // tagged [source: faq] with the warranty text.
    llmSeen.length = 0;
    llmQueue = [
      llmToolUse([{ id: 'k1', name: 'search_knowledge', input: { query: 'warranty coverage' } }]),
      llmText('Your warranty covers defects for a year [source: faq].'),
    ];
    await runTurn('mixed-dim-user', 'is there a warranty?', 'mix-1');
    const result = lastToolResult();
    expect(result).toContain('[source: faq]');
    expect(result.toLowerCase()).toContain('warranty');
  });

  test('flip the embeddings dim -> retrieval finds nothing (old-dim chunks excluded)', async () => {
    embeddings.setDim(16);
    const { status, body } = await testIntegration(embeddingsId);
    expect(status).toBe(200);
    expect(body).toMatchObject({ ok: true, dim: 16 });

    // The source is still ready (so the tool is still OFFERED), but its chunks
    // are dim-8 while the config now produces dim-16 vectors -> the executor's
    // embedding_dim filter drops them all.
    llmSeen.length = 0;
    llmQueue = [
      llmToolUse([{ id: 'k2', name: 'search_knowledge', input: { query: 'warranty coverage' } }]),
      llmText('I do not have that information.'),
    ];
    await runTurn('mixed-dim-user', 'warranty again?', 'mix-2');
    expect(lastToolResult()).toBe('no relevant knowledge found.');
  });
});
