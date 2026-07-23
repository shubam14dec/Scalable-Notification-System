/**
 * Phase 23 slice E — retrieval tool gating + invocation, and episodic
 * summary-on-resolve, end to end against the real managed brain (an
 * @anthropic-ai/sdk pointed at a stub Messages API) plus the in-process
 * embeddings + Pinecone fakes (tests/helpers/knowledge-fakes.ts).
 *
 * Covers:
 *  - OFFERING matrix: no configs -> neither search tool; configs but no ready
 *    source -> search_knowledge absent; a ready source -> search_knowledge
 *    offered + the D6 grounding scaffold injected into the system prompt; a
 *    subscriber with no summaries -> search_history absent.
 *  - INVOCATION: search_knowledge returns numbered [source: <name>] excerpts, the
 *    turn trace records the tool_call, and an empty result reads
 *    "no relevant knowledge found." (mixed-dim exclusion path).
 *  - EPISODIC (summarizeAndEmbedConversation via the queue processor): a 2+
 *    user-turn conversation -> exactly one summary row + one vector upsert;
 *    re-running is idempotent (no second summary LLM call, no new row/upsert);
 *    a <2 user-turn conversation is skipped; a bridge-runtime agent is skipped;
 *    a crash-left row (embedding_dim NULL) RESUMES the embed without a second
 *    summary. Then search_history is offered for that subscriber and recalls it.
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
const AGENT = 'ret-agent';

const json = (res: { body: string }) => JSON.parse(res.body);

// ---- stub Anthropic-compatible model server ----
let llmStub: Server;
let llmBaseUrl = '';
interface SeenRequest {
  system?: unknown;
  tools?: Array<{ name: string }>;
  messages: any[];
}
const llmSeen: SeenRequest[] = [];
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

const offeredToolNames = () => (llmSeen.at(-1)!.tools ?? []).map((t) => t.name);
const lastSystem = () => String(llmSeen.at(-1)!.system ?? '');
function lastToolResult(): string {
  const msgs = llmSeen.at(-1)!.messages;
  const last = msgs.at(-1) as { role: string; content: Array<{ content: string }> };
  return last.content[0].content;
}
/** How many times the agent's OWN LLM was asked for a summary (episodic path). */
const summaryCallCount = () =>
  llmSeen.filter((r) => typeof r.system === 'string' && r.system.includes('third-person summary')).length;

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

async function createAgent(identifier: string, name: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier,
      name,
      runtime: 'managed',
      model: 'glm-4-test',
      llm: { apiKey: 'managed-test-key', baseUrl: llmBaseUrl },
    },
  });
  expect(res.statusCode, `create agent ${identifier}`).toBe(201);
  const { rows } = await pool.query<{ id: string }>(
    'select id from agents where tenant_id = $1 and identifier = $2',
    [tenantId, identifier],
  );
  return rows[0].id;
}

/** Index a ready text source on an agent; returns its source id. */
async function addReadySource(identifier: string, name: string, text: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/knowledge`,
    headers: { 'x-api-key': apiKey },
    payload: { name, kind: 'text', text },
  });
  expect(res.statusCode, `create source ${name}`).toBe(201);
  const sourceId = json(res).source.id as string;
  const job = await getQueue(QUEUE.KNOWLEDGE).getJob(`knowledge-index-${sourceId}`);
  await processKnowledge(job as Job<KnowledgeJobData>);
  return sourceId;
}

async function runTurn(identifier: string, subscriberId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  const turn = json(res) as { conversationId: string; messageId: string };
  await processConversation({
    data: { tenantId, conversationId: turn.conversationId, messageId: turn.messageId },
  } as Job<ConversationJobData>);
  return turn;
}

async function runSummarize(conversationId: string) {
  await processKnowledge({
    data: { kind: 'summarize', tenantId, conversationId },
  } as Job<KnowledgeJobData>);
}

async function summaryRows(conversationId: string) {
  const { rows } = await pool.query<{
    id: string;
    summary: string;
    embedding_dim: number | null;
    agent_id: string;
    subscriber_id: string;
  }>(
    'select id, summary, embedding_dim, agent_id, subscriber_id from conversation_summaries where conversation_id = $1',
    [conversationId],
  );
  return rows;
}

beforeAll(async () => {
  embeddings = await startEmbeddingsStub(8);
  pinecone = await startPineconeStub();
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `retrieval-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Retrieval IT', email, password: 'integration-pw-1', organizationName: 'Retrieval Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;
  await createAgent(AGENT, 'Retrieval Agent');
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

// ===================================================================
// Tool offering matrix
// ===================================================================
describe('offering matrix', () => {
  test('no configs -> neither search tool is offered', async () => {
    llmSeen.length = 0;
    llmQueue = [llmText('hello')];
    await runTurn(AGENT, 'offer-a', 'hi there', 'off-1');
    const names = offeredToolNames();
    expect(names).not.toContain('search_knowledge');
    expect(names).not.toContain('search_history');
  });

  test('configure embeddings + vector store integrations', async () => {
    embeddingsId = await addIntegration('embeddings', 'openai-compat', {
      baseUrl: embeddings.baseUrl,
      apiKey: 'embed-key',
      model: 'text-embed-test',
    });
    expect((await testIntegration(embeddingsId)).body).toMatchObject({ ok: true, dim: 8 });

    const vectorId = await addIntegration('vectorstore', 'pinecone', {
      apiKey: 'pinecone-key',
      indexName: 'retrieval-knowledge',
    });
    expect((await testIntegration(vectorId)).body).toMatchObject({ ok: true, dim: 8, created: true });
  });

  test('configs but NO ready source -> search_knowledge absent; no summaries -> search_history absent', async () => {
    llmSeen.length = 0;
    llmQueue = [llmText('hello')];
    await runTurn(AGENT, 'offer-b', 'hi again', 'off-2');
    const names = offeredToolNames();
    expect(names).not.toContain('search_knowledge');
    expect(names).not.toContain('search_history');
  });

  test('a ready source -> search_knowledge offered + grounding scaffold injected', async () => {
    await addReadySource(
      AGENT,
      'returns-policy',
      'You may return opened electronics within 14 days for a full refund to the original method.',
    );

    llmSeen.length = 0;
    llmQueue = [llmText('hello')];
    await runTurn(AGENT, 'offer-c', 'a question', 'off-3');

    const names = offeredToolNames();
    expect(names).toContain('search_knowledge');
    // A brand-new subscriber still has no past summaries.
    expect(names).not.toContain('search_history');

    // The D6 grounding scaffold rode into the system prompt.
    const system = lastSystem();
    expect(system).toContain('search_knowledge');
    expect(system).toContain('[source: <name>]');
  });
});

// ===================================================================
// search_knowledge invocation
// ===================================================================
describe('search_knowledge invocation', () => {
  test('returns [source: name] excerpts and the turn trace records the tool_call', async () => {
    llmSeen.length = 0;
    llmQueue = [
      llmToolUse([{ id: 'sk1', name: 'search_knowledge', input: { query: 'return opened electronics refund' } }]),
      llmText('You can return opened electronics within 14 days [source: returns-policy].'),
    ];
    const turn = await runTurn(AGENT, 'invoke-user', 'can I return opened electronics?', 'inv-1');

    // The model's second request carried the retrieval result.
    const result = lastToolResult();
    expect(result).toContain('[source: returns-policy]');
    expect(result.toLowerCase()).toContain('refund');
    // Numbered excerpt format.
    expect(result.startsWith('1. ')).toBe(true);

    // The tool_call is in the persisted turn trace (raw.trace.events).
    const { rows } = await pool.query<{ raw: { trace?: { events: Array<{ t: string; name?: string; ok?: boolean }> } } }>(
      `select raw from conversation_messages
        where conversation_id = $1 and raw ? 'trace' order by created_at desc limit 1`,
      [turn.conversationId],
    );
    const events = rows[0].raw.trace!.events;
    expect(events.some((e) => e.t === 'tool_call' && e.name === 'search_knowledge' && e.ok === true)).toBe(true);
  });
});

// ===================================================================
// Episodic summary on resolve
// ===================================================================
describe('episodic summary', () => {
  let epiConversationId = '';
  let summaryRowId = '';

  test('2+ user turns -> exactly one summary row + one vector upsert', async () => {
    const t1 = await runTurn(AGENT, 'epi-user', 'my order #A1 never arrived', 'epi-1');
    const t2 = await runTurn(AGENT, 'epi-user', 'can you refund it?', 'epi-2');
    expect(t2.conversationId).toBe(t1.conversationId); // one thread, two user turns
    epiConversationId = t1.conversationId;

    pinecone.resetHistory();
    const before = summaryCallCount();
    llmQueue = [llmText('Customer reported order #A1 was undelivered and requested a refund, which was issued.')];
    await runSummarize(epiConversationId);

    // Exactly one completed summary row.
    const rows = await summaryRows(epiConversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].embedding_dim).toBe(8);
    summaryRowId = rows[0].id;

    // Exactly one summary LLM call happened.
    expect(summaryCallCount()).toBe(before + 1);

    // One vector upserted in the tenant namespace, keyed by the row id, with the
    // agent + subscriber metadata search_history filters on.
    const upserts = pinecone.upserts.filter((u) => u.namespace === tenantId);
    expect(upserts.flatMap((u) => u.ids)).toEqual([summaryRowId]);
    const stored = pinecone.namespaces.get(tenantId)!.get(summaryRowId)!;
    expect(stored.meta.agentId).toBe(rows[0].agent_id);
    expect(stored.meta.subscriberId).toBe(rows[0].subscriber_id);
  });

  test('re-running is idempotent: no new row, no new upsert, no second summary call', async () => {
    pinecone.resetHistory();
    const before = summaryCallCount();
    await runSummarize(epiConversationId);

    expect(await summaryRows(epiConversationId)).toHaveLength(1);
    expect(summaryCallCount()).toBe(before); // early-exit on the completed row
    expect(pinecone.upserts.filter((u) => u.namespace === tenantId)).toHaveLength(0);
  });

  test('a <2 user-turn conversation is skipped (no row)', async () => {
    const t = await runTurn(AGENT, 'epi-solo', 'just one message', 'solo-1');
    const before = summaryCallCount();
    await runSummarize(t.conversationId);
    expect(await summaryRows(t.conversationId)).toHaveLength(0);
    expect(summaryCallCount()).toBe(before); // skipped before any LLM summary call
  });

  test('a bridge-runtime agent is skipped (episodic is managed-only)', async () => {
    const bridgeAgentId = await createAgent('epi-bridge', 'Episodic Bridge');
    const t1 = await runTurn('epi-bridge', 'bridge-user', 'first', 'br-1');
    await runTurn('epi-bridge', 'bridge-user', 'second', 'br-2');
    // Flip the runtime AFTER building the transcript: the summarizer must bail at
    // the runtime check regardless of turn count.
    await pool.query("update agents set runtime = 'bridge' where id = $1", [bridgeAgentId]);

    const before = summaryCallCount();
    await runSummarize(t1.conversationId);
    expect(await summaryRows(t1.conversationId)).toHaveLength(0);
    expect(summaryCallCount()).toBe(before);
  });

  test('crash-resume: a NULL embedding_dim row completes the embed without a second summary', async () => {
    // A conversation whose summary INSERT landed but whose vector upsert never
    // did (a crash between the two) — modelled by a hand-inserted null-dim row.
    const t = await runTurn(AGENT, 'epi-crash', 'the widget broke on day two', 'crash-1');
    const { rows: conv } = await pool.query<{ agent_id: string; subscriber_id: string }>(
      'select agent_id, subscriber_id from conversations where id = $1',
      [t.conversationId],
    );
    const CRASH_SUMMARY = 'Customer reported the widget failed on the second day of use.';
    await pool.query(
      `insert into conversation_summaries (tenant_id, conversation_id, agent_id, subscriber_id, summary)
       values ($1, $2, $3, $4, $5)`,
      [tenantId, t.conversationId, conv[0].agent_id, conv[0].subscriber_id, CRASH_SUMMARY],
    );

    pinecone.resetHistory();
    const before = summaryCallCount();
    await runSummarize(t.conversationId);

    const rows = await summaryRows(t.conversationId);
    expect(rows).toHaveLength(1);
    expect(rows[0].embedding_dim).toBe(8); // embed step resumed and completed
    expect(rows[0].summary).toBe(CRASH_SUMMARY); // reused the stored summary
    expect(summaryCallCount()).toBe(before); // NO second summary LLM call
    // The vector was upserted on resume, keyed by the existing row id.
    expect(pinecone.upserts.filter((u) => u.namespace === tenantId).flatMap((u) => u.ids)).toEqual([rows[0].id]);
  });

  test('search_history is now offered for that subscriber and recalls the summary', async () => {
    llmSeen.length = 0;
    llmQueue = [
      llmToolUse([{ id: 'sh1', name: 'search_history', input: { query: 'order refund' } }]),
      llmText('Last time we refunded your undelivered order.'),
    ];
    await runTurn(AGENT, 'epi-user', 'what did we sort out before?', 'hist-1');

    expect(offeredToolNames()).toContain('search_history');
    const result = lastToolResult();
    expect(result).toContain('refund');
    // Dated tag from relativeAge on a just-created summary.
    expect(result).toMatch(/just now|ago/);
  });
});

// ===================================================================
// Empty retrieval — mixed-dim exclusion reads "no relevant knowledge found."
// (run LAST: it flips the embeddings dim for the whole tenant)
// ===================================================================
describe('empty retrieval', () => {
  test('after flipping the embeddings dim, search_knowledge finds nothing', async () => {
    embeddings.setDim(16);
    expect((await testIntegration(embeddingsId)).body).toMatchObject({ ok: true, dim: 16 });

    llmSeen.length = 0;
    llmQueue = [
      llmToolUse([{ id: 'sk9', name: 'search_knowledge', input: { query: 'return policy' } }]),
      llmText('I do not have that on file.'),
    ];
    await runTurn(AGENT, 'empty-user', 'return policy?', 'empty-1');
    expect(lastToolResult()).toBe('no relevant knowledge found.');
  });
});
