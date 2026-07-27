/**
 * Phase 26 slice D — HITL conversation handoff, end to end: the real Fastify app
 * + real conversation core + the @anthropic-ai/sdk pointed at a stub Messages API
 * (only the model + the embeddings/vector backends are fake). Proves the whole
 * agent → human → agent loop:
 *
 *  (a) a stubbed turn calls handoff_to_human → status waiting_human, a breadcrumb
 *      reconstructed as a real tool pair, the reserved 'agent-handoffs' ops alert
 *      fired at the 'approvals' audience (P22 dogfood), had_human still false, and
 *      conversation.changed emitted (redis probe);
 *  (b) a turn whose model calls handoff TWICE is idempotent — one breadcrumb, one
 *      ops event, no double flip;
 *  (c) a customer message while waiting_human persists its user row, runs ZERO
 *      model calls (the D2 brain gate), and still emits the live hint;
 *  (d) an operator reply via a dashboard JWT tags raw.operator={name}, flips
 *      waiting_human → human (+ had_human), and returns status 'human'; an API-key
 *      (SDK) push in an active thread carries NO operator tag (regression);
 *  (e) the widget history endpoint surfaces operatorName on the operator row;
 *  (f) the handback route → active + a FORCED fold job whose input attributes the
 *      human turn, rolling_upto = the operator boundary; the NEXT turn replays NO
 *      operator verbatim, carries the summary in the volatile system block, and
 *      gains the D7 "human teammate" reminder line;
 *  (g) resolve from the human state works and the episodic summarizer input
 *      attributes the operator turn (D10);
 *  (h) the inactivity sweep ignores a stale waiting_human conversation.
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
import { runInactivitySweep } from '../../src/workers/inactivity-sweep';
import {
  startEmbeddingsStub,
  startPineconeStub,
  type EmbeddingsStub,
  type PineconeStub,
} from '../helpers/knowledge-fakes';

const AGENT = 'hitl-support';
const OPERATOR_NAME = 'Sam Rivera';
const OPERATOR_REPLY = 'Hi, this is Sam. I will process your refund today.';
const FOLD_SUMMARY = 'A human teammate (Sam Rivera) promised the customer a full refund by Friday.';

let app: FastifyInstance;
let apiKey = '';
let accessToken = ''; // dashboard JWT — the operator identity
let tenantId = '';
let embeddings: EmbeddingsStub;
let pinecone: PineconeStub;

const json = (res: { body: string }) => JSON.parse(res.body);

// ---- stub Anthropic-compatible model server ----
let llmStub: Server;
let llmBaseUrl = '';
interface SeenRequest {
  system?: unknown;
  messages: Array<{ role: string; content: unknown }>;
}
const llmSeen: SeenRequest[] = [];
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
const toolUseResponse = (uses: Array<{ id: string; name: string; input: unknown }>) =>
  envelope(uses.map((u) => ({ type: 'tool_use', ...u })), 'tool_use');
const textResponse = (text: string) => envelope([{ type: 'text', text }], 'end_turn');

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      llmSeen.push(JSON.parse(raw) as SeenRequest);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(stubQueue.length > 0 ? stubQueue.shift() : textResponse('ok')));
    });
  });
  return new Promise((r) => llmStub.listen(0, '127.0.0.1', () => r()));
}

/** The most recent BRAIN request (system is the cache_control blocks array). */
function lastBrainRequest(): SeenRequest {
  const req = [...llmSeen].reverse().find((r) => Array.isArray(r.system));
  if (!req) throw new Error('no brain request seen');
  return req;
}
function brainSystemText(req: SeenRequest): string {
  return (req.system as Array<{ text?: string }>).map((b) => b.text ?? '').join('\n\n');
}

// ---- Redis SUBSCRIBE probe on the tenant admin channel ----
let probe: Redis;
interface Hint {
  type: string;
  id?: string;
  at: string;
}
const hints: Hint[] = [];
const resetHints = () => {
  hints.length = 0;
};
async function waitForHint(type: string, id?: string, timeoutMs = 4000): Promise<boolean> {
  const start = Date.now();
  for (;;) {
    if (hints.some((h) => h.type === type && (id === undefined || h.id === id))) return true;
    if (Date.now() - start >= timeoutMs) return false;
    await new Promise((r) => setTimeout(r, 25));
  }
}

// ---- turn helpers ----
async function postTurn(
  subscriberId: string,
  text: string,
  messageId: string,
): Promise<{ conversationId: string; messageId: string; status: string }> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${AGENT}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  expect(res.statusCode, `post turn ${messageId}`).toBe(202);
  return json(res);
}
async function runBrain(turn: { conversationId: string; messageId: string }): Promise<void> {
  await processConversation({
    data: { tenantId, conversationId: turn.conversationId, messageId: turn.messageId },
  } as Job<ConversationJobData>);
}
async function runTurn(subscriberId: string, text: string, messageId: string) {
  const turn = await postTurn(subscriberId, text, messageId);
  await runBrain(turn);
  return turn;
}

/** An operator reply through the dashboard-JWT push (raw.operator attribution). */
async function operatorPush(conversationId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${conversationId}/messages`,
    headers: { authorization: `Bearer ${accessToken}`, 'x-environment-id': tenantId },
    payload: { text, messageId },
  });
  return { status: res.statusCode, body: json(res) };
}

async function conversationRow(id: string): Promise<{
  status: string;
  had_human: boolean;
  rolling_summary: string | null;
  rolling_upto: string | null;
}> {
  const { rows } = await pool.query(
    'select status, had_human, rolling_summary, rolling_upto from conversations where id = $1',
    [id],
  );
  return rows[0];
}

async function mintSubscriberToken(subscriberId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/subscriber-tokens',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId },
  });
  return json(res).token as string;
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
  const email = `hitl-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: OPERATOR_NAME, email, password: 'integration-pw-1', organizationName: 'HITL IT Org' },
  });
  const body = json(signup);
  accessToken = body.accessToken;
  const dev = body.environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  const create = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: AGENT,
      name: 'HITL Support',
      runtime: 'managed',
      model: 'glm-4-test',
      systemPrompt: 'You are the Acme support agent.',
      llm: { apiKey: 'hitl-test-key-123456', baseUrl: llmBaseUrl },
    },
  });
  expect(create.statusCode).toBe(201);

  // Episodic backends (step g).
  await addIntegration('embeddings', 'openai-compat', {
    baseUrl: embeddings.baseUrl,
    apiKey: 'embed-key',
    model: 'text-embed-test',
  });
  await addIntegration('vectorstore', 'pinecone', { apiKey: 'pinecone-key', indexName: 'hitl-knowledge' });

  // Ops opt-in (D4): the reserved 'agent-handoffs' workflow + reused 'approvals'
  // subscriber — the exact P22 pattern the handoff alert dogfoods.
  await app.inject({
    method: 'PUT',
    url: '/v1/workflows',
    headers: { 'x-api-key': apiKey },
    payload: {
      key: 'agent-handoffs',
      name: 'Handoffs',
      steps: [{ channel: 'inapp', subject: 'Handoff', body: 'Agent {{agentIdentifier}} handed off' }],
    },
  });
  await pool.query(
    "insert into subscribers (tenant_id, external_id, email) values ($1, 'approvals', 'ops@example.com')",
    [tenantId],
  );

  probe = createRedis();
  await probe.subscribe(tenantEventsChannel(tenantId));
  probe.on('message', (_channel, message) => {
    try {
      hints.push(JSON.parse(message) as Hint);
    } catch {
      /* ignore */
    }
  });
});

afterAll(async () => {
  try {
    await pool.query('delete from conversation_summaries where tenant_id = $1', [tenantId]);
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await pool.query('delete from events where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
    await pool.query('delete from integrations where tenant_id = $1', [tenantId]);
    await getQueue(QUEUE.KNOWLEDGE).obliterate({ force: true });
    await getQueue(QUEUE.CONVERSATION).obliterate({ force: true });
    const keys = await redis.keys(`txn:${tenantId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    /* best-effort */
  }
  await probe?.quit();
  embeddings?.close();
  pinecone?.close();
  llmStub?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

// ===================================================================
// The primary lifecycle: one conversation, agent → human → agent
// ===================================================================
describe('the handoff lifecycle on one conversation', () => {
  let conversationId = '';
  let handoffInboundId = '';
  let operatorMsgId = '';

  test('(a) handoff_to_human → waiting_human + breadcrumb + ops alert + had_human false + hint', async () => {
    resetHints();
    stubQueue = [
      toolUseResponse([{ id: 'h1', name: 'handoff_to_human', input: { reason: 'customer asked for a person' } }]),
      textResponse('Connecting you with a teammate now.'),
    ];
    const turn = await runTurn('cust-main', 'I want to talk to a human', 'main-1');
    conversationId = turn.conversationId;
    handoffInboundId = turn.messageId;

    // Status flipped, had_human NOT yet (it flips only on the first operator reply).
    const row = await conversationRow(conversationId);
    expect(row.status).toBe('waiting_human');
    expect(row.had_human).toBe(false);

    // Breadcrumb: a system row reconstructable as a real handoff tool pair.
    const crumb = await pool.query(
      `select content, raw from conversation_messages
        where conversation_id = $1 and role = 'system' and raw->'action'->>'tool' = 'handoff_to_human'`,
      [conversationId],
    );
    expect(crumb.rowCount).toBe(1);
    expect(crumb.rows[0].content).toBe('handed off to a human teammate');

    // Ops alert (D4): reserved workflow, reused 'approvals' audience, deterministic txn.
    const evt = await pool.query<{ recipients: Array<{ subscriberId: string }> }>(
      'select recipients from events where tenant_id = $1 and transaction_id = $2',
      [tenantId, `handoff-note-${conversationId}-${handoffInboundId}`],
    );
    expect(evt.rowCount).toBe(1);
    expect(evt.rows[0].recipients.map((r) => r.subscriberId)).toEqual(['approvals']);

    // Live hint for the dashboard queue.
    expect(await waitForHint('conversation.changed', conversationId)).toBe(true);
  });

  test('(c) a customer message while waiting_human: user row persists, ZERO model calls, hint fires', async () => {
    const turn = await postTurn('cust-main', 'still there? please hurry', 'main-2');
    // Same thread, still waiting_human (a customer message never steals the pen).
    expect(turn.conversationId).toBe(conversationId);
    expect((await conversationRow(conversationId)).status).toBe('waiting_human');

    const before = llmSeen.length;
    resetHints();
    await runBrain(turn);
    // The D2 gate: no model call at all.
    expect(llmSeen.length).toBe(before);
    // But the user row is durable, and the operator's live view is refreshed.
    const row = await pool.query(
      "select role, content from conversation_messages where id = $1",
      [turn.messageId],
    );
    expect(row.rows[0]).toMatchObject({ role: 'user', content: 'still there? please hurry' });
    expect(await waitForHint('conversation.changed', conversationId)).toBe(true);
  });

  test('(d) operator reply via dashboard JWT → raw.operator{name}, status human, response status human', async () => {
    const { status, body } = await operatorPush(conversationId, OPERATOR_REPLY, 'op-1');
    expect(status).toBe(202);
    expect(body.status).toBe('human');
    operatorMsgId = body.messageId;

    const stored = await pool.query<{ raw: { operator?: { name?: string } } }>(
      'select raw from conversation_messages where id = $1',
      [operatorMsgId],
    );
    expect(stored.rows[0].raw.operator?.name).toBe(OPERATOR_NAME);

    // The FIRST operator reply flipped the pen and stamped had_human.
    const row = await conversationRow(conversationId);
    expect(row.status).toBe('human');
    expect(row.had_human).toBe(true);
  });

  test('(e) the widget history endpoint surfaces operatorName on the operator row', async () => {
    const token = await mintSubscriberToken('cust-main');
    const res = await app.inject({
      method: 'GET',
      url: `/v1/agents/${AGENT}/conversation?subscriberId=cust-main`,
      headers: { 'x-subscriber-token': token },
    });
    expect(res.statusCode).toBe(200);
    const messages = json(res).messages as Array<{ content: string; operatorName?: string }>;
    const opRow = messages.find((mm) => mm.content === OPERATOR_REPLY);
    expect(opRow?.operatorName).toBe(OPERATOR_NAME);
    // The agent's own earlier reply carries no operator label.
    const agentRow = messages.find((mm) => mm.content === 'Connecting you with a teammate now.');
    expect(agentRow?.operatorName).toBeUndefined();
  });

  test('(f) handback → active + forced fold attributes the human turn; next turn is imitation-safe', async () => {
    // Return to agent.
    const hb = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/handback`,
      headers: { 'x-api-key': apiKey },
    });
    expect(hb.statusCode).toBe(200);
    expect(json(hb).status).toBe('active');
    expect((await conversationRow(conversationId)).status).toBe('active');

    // Run the FORCED fold job the route enqueued (proves throughMessageId threading).
    const job = await getQueue(QUEUE.KNOWLEDGE).getJob(`handback-${conversationId}-${operatorMsgId}`);
    expect(job, 'handback fold job enqueued through the operator boundary').toBeTruthy();
    stubQueue = [textResponse(FOLD_SUMMARY)];
    const foldSeenBefore = llmSeen.length;
    await processKnowledge(job as Job<KnowledgeJobData>);

    // The fold INPUT (D6 law) attributed the operator turn to the human teammate.
    const foldReq = llmSeen
      .slice(foldSeenBefore)
      .find((r) => typeof r.system === 'string' && /running summary/i.test(r.system as string));
    expect(foldReq, 'the forced fold called the summarizer').toBeDefined();
    const foldInput = String(foldReq!.messages.at(-1)?.content ?? '');
    expect(foldInput).toContain(
      `A human teammate (${OPERATOR_NAME}) told the customer: "${OPERATOR_REPLY}"`,
    );
    // The operator's words are NEVER folded in under the agent's own voice.
    expect(foldInput).not.toContain(`Agent: ${OPERATOR_REPLY}`);

    // Summary written; boundary = the operator message (inclusive).
    const row = await conversationRow(conversationId);
    expect(row.rolling_summary).toBe(FOLD_SUMMARY);
    expect(row.rolling_summary).toContain('A human teammate');
    expect(row.rolling_upto).toBe(operatorMsgId);

    // The NEXT turn: no operator verbatim replay, the summary rides the volatile
    // system block, and the D7 reminder line is present (had_human is true).
    stubQueue = [textResponse('Sure — your refund is on the way.')];
    await runTurn('cust-main', 'is my refund coming?', 'main-3');
    const req = lastBrainRequest();

    const wire = JSON.stringify(req.messages);
    expect(wire).not.toContain(OPERATOR_REPLY); // D6: the human's words are not replayed as the model's
    expect(wire).not.toContain('this is Sam');

    const system = brainSystemText(req);
    expect(system).toContain('<prior_conversation_summary>');
    expect(system).toContain(FOLD_SUMMARY);
    // Never injected as an assistant turn (imitation lesson §13).
    expect(
      req.messages.some(
        (mm) => mm.role === 'assistant' && typeof mm.content === 'string' && mm.content.includes(FOLD_SUMMARY),
      ),
    ).toBe(false);

    // The D7 advice line rides the current user message (recency lever).
    const lastUser = req.messages.at(-1);
    expect(String(lastUser?.content ?? '')).toContain(
      'A human teammate handled part of this conversation',
    );
  });
});

// ===================================================================
// (b) idempotency — two handoff calls in ONE turn
// ===================================================================
describe('(b) a double handoff call within one turn is idempotent', () => {
  test('one breadcrumb, one ops event, a single flip', async () => {
    stubQueue = [
      toolUseResponse([{ id: 'hb1', name: 'handoff_to_human', input: {} }]),
      toolUseResponse([{ id: 'hb2', name: 'handoff_to_human', input: {} }]),
      textResponse('A teammate will be with you shortly.'),
    ];
    const turn = await runTurn('cust-idem', 'get me a person, twice', 'idem-1');

    expect((await conversationRow(turn.conversationId)).status).toBe('waiting_human');

    const crumbs = await pool.query(
      `select 1 from conversation_messages
        where conversation_id = $1 and role = 'system' and raw->'action'->>'tool' = 'handoff_to_human'`,
      [turn.conversationId],
    );
    expect(crumbs.rowCount).toBe(1);

    const evt = await pool.query(
      'select 1 from events where tenant_id = $1 and transaction_id = $2',
      [tenantId, `handoff-note-${turn.conversationId}-${turn.messageId}`],
    );
    expect(evt.rowCount).toBe(1);
  });
});

// ===================================================================
// (d, regression) an API-key (SDK) push in an ACTIVE thread is NOT tagged
// ===================================================================
describe('(d) an API-key push carries no operator tag (regression)', () => {
  test('raw.operator is absent and the status stays active', async () => {
    const turn = await runTurn('cust-sdk', 'hello', 'sdk-1'); // a plain active thread
    stubQueue = []; // the push must not need the model

    const res = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${turn.conversationId}/messages`,
      headers: { 'x-api-key': apiKey },
      payload: { text: 'SDK follow-up from your integration', messageId: 'sdk-push-1' },
    });
    expect(res.statusCode).toBe(202);
    const pushedId = json(res).messageId;

    const stored = await pool.query<{ raw: unknown }>(
      'select raw from conversation_messages where id = $1',
      [pushedId],
    );
    // No operator attribution at all (buttons/card absent too → raw is null).
    const raw = stored.rows[0].raw as { operator?: unknown } | null;
    expect(raw?.operator).toBeUndefined();
    expect((await conversationRow(turn.conversationId)).status).toBe('active');
  });
});

// ===================================================================
// (g) resolve straight from the human state → episodic input attributes the human
// ===================================================================
describe('(g) resolve from the human state + attributed episodic input', () => {
  test('resolve works from human and the episodic summarizer sees the attributed line', async () => {
    // Two user turns so episodic (>=2 user turns) actually runs.
    const turn0 = await runTurn('cust-res', 'hi there', 'res-0'); // active, user turn 1
    const conversationId = turn0.conversationId;

    stubQueue = [
      toolUseResponse([{ id: 'rh1', name: 'handoff_to_human', input: {} }]),
      textResponse('Let me bring in a teammate.'),
    ];
    await runTurn('cust-res', 'I need a human for my refund', 'res-1'); // user turn 2 → waiting_human

    const op = await operatorPush(conversationId, 'Refund approved — you will see it Friday.', 'res-op-1');
    expect(op.body.status).toBe('human');

    // Resolve directly from 'human'.
    const resolved = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/resolve`,
      headers: { 'x-api-key': apiKey },
    });
    expect(resolved.statusCode).toBe(200);
    expect((await conversationRow(conversationId)).status).toBe('resolved');

    // Drive the episodic summarize job the resolve enqueued.
    stubQueue = [textResponse('Customer needed a refund; a teammate approved it.')];
    const before = llmSeen.length;
    await processKnowledge({
      data: { kind: 'summarize', tenantId, conversationId },
    } as Job<KnowledgeJobData>);

    const epi = llmSeen
      .slice(before)
      .find((r) => typeof r.system === 'string' && /third-person summary/i.test(r.system as string));
    expect(epi, 'episodic summarizer ran').toBeDefined();
    const epiInput = String(epi!.messages.at(-1)?.content ?? '');
    expect(epiInput).toContain(
      `A human teammate (${OPERATOR_NAME}) told the customer: "Refund approved — you will see it Friday."`,
    );
  });
});

// ===================================================================
// (h) the inactivity sweep leaves a stale waiting_human conversation alone
// ===================================================================
describe('(h) the inactivity sweep ignores waiting_human', () => {
  test('a stale waiting_human thread is exempt from auto-resolve', async () => {
    // A dedicated agent WITH the backstop knob (the sweep only touches those).
    const create = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-api-key': apiKey },
      payload: {
        identifier: 'hitl-sweep',
        name: 'HITL Sweep',
        runtime: 'managed',
        model: 'glm-4-test',
        llm: { apiKey: 'hitl-sweep-key-123', baseUrl: llmBaseUrl },
        autoResolveMinutes: 60,
      },
    });
    expect(create.statusCode).toBe(201);

    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/hitl-sweep/messages',
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId: 'cust-sweep', text: 'get me a human', messageId: 'sweep-1' },
    });
    const conversationId = json(res).conversationId as string;

    // Put it in waiting_human and backdate well past the 60m knob (the sweep
    // filters status='active', so this must survive).
    await pool.query(
      `update conversations set status = 'waiting_human', last_message_at = now() - interval '10 hours'
       where id = $1`,
      [conversationId],
    );

    await runInactivitySweep();

    expect((await conversationRow(conversationId)).status).toBe('waiting_human');
  });
});
