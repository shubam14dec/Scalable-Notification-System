/**
 * Phase 24 slice E — rolling summarization end to end: the real app + real
 * conversation core + the @anthropic-ai/sdk pointed at a stub Messages API, plus
 * the in-process embeddings + Pinecone fakes (for the episodic handoff at the
 * end). Only the model + vector servers are fake.
 *
 * Covers, on an agent whose context knobs are small ({triggerTurns:6,tailTurns:4}):
 *  - seed a conversation past the knobs, run the fold job in-process
 *    (foldRollingSummary with the stubbed client) -> rolling_summary + rolling_upto
 *    are written;
 *  - the fold is idempotent: a re-run against the advanced rolling_upto no-ops
 *    (identical columns, no second summary call);
 *  - the NEXT brain turn replays ONLY the post-fold rows, and its VOLATILE system
 *    block carries <prior_conversation_summary> (never an assistant turn — §13);
 *  - the conversation detail GET surfaces rollingSummary;
 *  - the episodic handoff at resolve feeds the summarizer
 *    "Earlier in this conversation (summary): …" so nothing is lost.
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
import {
  processKnowledge,
  type KnowledgeJobData,
} from '../../src/workers/processors/knowledge.processor';
import { foldRollingSummary } from '../../src/core/rolling';
import {
  startEmbeddingsStub,
  startPineconeStub,
  type EmbeddingsStub,
  type PineconeStub,
} from '../helpers/knowledge-fakes';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
const AGENT = 'roll-support';
let embeddings: EmbeddingsStub;
let pinecone: PineconeStub;

const FOLD_SUMMARY = 'The customer discussed the alpha and bravo orders and asked about their statuses.';

// ---- stub Anthropic-compatible server ----
let llmStub: Server;
let llmBaseUrl = '';
interface SeenRequest {
  system?: unknown;
  messages: Array<{ role: string; content: unknown }>;
}
const seen: SeenRequest[] = [];
let stubQueue: unknown[] = [];

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
const textResponse = (text: string) => envelope([{ type: 'text', text }], 'end_turn');

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push(JSON.parse(raw) as SeenRequest);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(stubQueue.length > 0 ? stubQueue.shift() : textResponse('ok')));
    });
  });
  return new Promise((r) => llmStub.listen(0, '127.0.0.1', () => r()));
}

const json = (res: { body: string }) => JSON.parse(res.body);

/** The most recent BRAIN request (system is the cache_control blocks array). */
function lastBrainRequest(): SeenRequest {
  const req = [...seen].reverse().find((r) => Array.isArray(r.system));
  if (!req) throw new Error('no brain request seen');
  return req;
}
function brainSystemText(req: SeenRequest): string {
  return (req.system as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n\n');
}

async function runTurn(subscriberId: string, text: string, messageId: string) {
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

async function rollingState(conversationId: string) {
  const { rows } = await pool.query<{ rolling_summary: string | null; rolling_upto: string | null }>(
    'select rolling_summary, rolling_upto from conversations where id = $1',
    [conversationId],
  );
  return rows[0];
}

async function addIntegration(channel: string, provider: string, credentials: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/integrations',
    headers: { 'x-api-key': apiKey },
    payload: { channel, provider, credentials },
  });
  expect(res.statusCode, `create ${channel} integration`).toBe(201);
  const id = json(res).id as string;
  // /test seals the config AND (for pinecone) creates the index in the stub —
  // getVectorStore describes it, so the episodic path needs it to exist.
  const tested = await app.inject({
    method: 'POST',
    url: `/v1/integrations/${id}/test`,
    headers: { 'x-api-key': apiKey },
    payload: {},
  });
  expect(tested.statusCode, `test ${channel} integration`).toBe(200);
  return id;
}

beforeAll(async () => {
  embeddings = await startEmbeddingsStub(8);
  pinecone = await startPineconeStub();
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `roll-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Roll IT', email, password: 'integration-pw-1', organizationName: 'Roll IT Org' },
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
      name: 'Rolling Support',
      runtime: 'managed',
      model: 'glm-4-test',
      systemPrompt: 'You are the Acme support agent.',
      llm: { apiKey: 'roll-test-key-123456', baseUrl: llmBaseUrl },
      // D6 small knobs so a short chat folds.
      context: { triggerTurns: 6, tailTurns: 4 },
    },
  });
  expect(create.statusCode).toBe(201);

  // Embeddings + vector store so the episodic handoff (resolve) actually runs.
  await addIntegration('embeddings', 'openai-compat', {
    baseUrl: embeddings.baseUrl,
    apiKey: 'embed-key',
    model: 'text-embed-test',
  });
  await addIntegration('vectorstore', 'pinecone', {
    apiKey: 'pinecone-key',
    indexName: 'rolling-knowledge',
  });
});

afterAll(async () => {
  try {
    await pool.query('delete from conversation_summaries where tenant_id = $1', [tenantId]);
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
    await pool.query('delete from integrations where tenant_id = $1', [tenantId]);
  } catch {
    /* best-effort */
  }
  embeddings?.close();
  pinecone?.close();
  llmStub?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('rolling summarization lifecycle', () => {
  let conversationId = '';

  test('seed a conversation past the small knobs (8 replayable rows)', async () => {
    // Four turns, each a distinct user line + a stub reply = 8 replayable rows.
    const t1 = await runTurn('roll-cust', 'alpha one about my order', 'roll-1');
    conversationId = t1.conversationId;
    await runTurn('roll-cust', 'bravo two more detail', 'roll-2');
    await runTurn('roll-cust', 'charlie three still waiting', 'roll-3');
    await runTurn('roll-cust', 'delta four any update', 'roll-4');

    const { rows } = await pool.query<{ n: number }>(
      `select count(*)::int as n from conversation_messages
        where conversation_id = $1 and role in ('user','agent') and deleted_at is null`,
      [conversationId],
    );
    expect(rows[0].n).toBe(8);
    // Not folded yet.
    expect((await rollingState(conversationId)).rolling_upto).toBeNull();
  });

  test('running the fold job in-process writes rolling_summary + rolling_upto', async () => {
    stubQueue = [textResponse(FOLD_SUMMARY)];
    await foldRollingSummary({ tenantId, conversationId });

    const state = await rollingState(conversationId);
    expect(state.rolling_summary).toBe(FOLD_SUMMARY);
    expect(state.rolling_upto).not.toBeNull();

    // rolling_upto is the boundary row = the newest FOLDED replayable row, i.e.
    // the 4th of 8 (tail 4 kept). With alternating user/agent rows that is the
    // 2nd agent reply — the alpha/bravo turns are folded, charlie/delta kept.
    const { rows } = await pool.query<{ content: string; role: string }>(
      'select content, role from conversation_messages where id = $1',
      [state.rolling_upto],
    );
    expect(rows[0].role).toBe('agent');
  });

  test('the fold is idempotent: a re-run against the advanced upto no-ops', async () => {
    const before = await rollingState(conversationId);
    // Prime a DIFFERENT summary; if the fold wrongly re-ran, the column would change.
    stubQueue = [textResponse('WRONG — this must never be written on a no-op re-run')];
    await foldRollingSummary({ tenantId, conversationId });

    const after = await rollingState(conversationId);
    expect(after.rolling_summary).toBe(before.rolling_summary);
    expect(after.rolling_upto).toBe(before.rolling_upto);
    // The primed response was NOT consumed (no model call on the no-op).
    expect(stubQueue).toHaveLength(1);
    stubQueue = [];
  });

  test('the next brain turn replays ONLY post-fold rows + a <prior_conversation_summary> block', async () => {
    await runTurn('roll-cust', 'echo five checking in', 'roll-5');

    const req = lastBrainRequest();
    // The VOLATILE system block carries the folded summary as a SYSTEM section.
    const system = brainSystemText(req);
    expect(system).toContain('<prior_conversation_summary>');
    expect(system).toContain(FOLD_SUMMARY);

    // The replayed message history excludes the folded (alpha/bravo) turns and
    // includes the kept (charlie/delta) tail + the new message.
    const wire = JSON.stringify(req.messages);
    expect(wire).not.toContain('alpha one');
    expect(wire).not.toContain('bravo two');
    expect(wire).toContain('charlie three');
    expect(wire).toContain('delta four');
    // The summary is NEVER injected as an assistant turn (imitation lesson §13).
    const asAssistant = req.messages.some(
      (m) => m.role === 'assistant' && typeof m.content === 'string' && m.content.includes(FOLD_SUMMARY),
    );
    expect(asAssistant).toBe(false);
  });

  test('the conversation detail GET surfaces rollingSummary', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conversationId}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).conversation.rollingSummary).toBe(FOLD_SUMMARY);
  });

  test('the episodic handoff at resolve feeds the rolling summary into the summarizer', async () => {
    // Prime the episodic summary call's reply; embedding rides the fakes.
    stubQueue = [textResponse('Customer chased alpha/bravo orders; statuses were provided.')];
    await processKnowledge({
      data: { kind: 'summarize', tenantId, conversationId },
    } as Job<KnowledgeJobData>);

    // The episodic summarizer's request (plain-string system) carried the folded
    // context as a preamble so nothing earlier than rolling_upto is lost.
    const epi = [...seen].reverse().find(
      (r) => typeof r.system === 'string' && /third-person summary/i.test(r.system),
    );
    expect(epi).toBeDefined();
    const userMsg = String(epi!.messages.at(-1)?.content ?? '');
    expect(userMsg).toContain('Earlier in this conversation (summary):');
    expect(userMsg).toContain(FOLD_SUMMARY);
  });
});
