/**
 * Phase 22 guardrails, end to end: the real Fastify app + the real managed brain
 * (@anthropic-ai/sdk pointed at a stub Messages API) + a real, signed HTTP tool
 * endpoint. Only the model server and the customer's tool server are local
 * stubs; every hop between them is production.
 *
 * Covers the four deterministic executor guards from slice A:
 *  - G1 REPEAT-ACTION: an auto tool armed with {maxAutoCalls, windowDays} flips
 *    to the approval path once this subscriber's EXECUTED calls in the window
 *    hit the ceiling; the paused row carries the ⚠ history line; an executed row
 *    OUTSIDE the window does NOT count toward the flip.
 *  - G2 DAILY TOKEN BUDGET: an over-budget agent skips the model call entirely,
 *    ships the deterministic note, breadcrumbs raw.budgetExhausted, and fires the
 *    reserved ops alert ONLY when the tenant opted in (lookup-first, debounced to
 *    once per agent per UTC day) — never minting a phantom subscriber.
 *  - G3 RATE CAP: an over-cap tool call returns an is_error result and records
 *    NOTHING (no tool-call row, no POST).
 *  - G4 duration_ms: the executor wall-clocks the signed POST onto executed rows,
 *    making Phase 21's per-tool avgMs real in /health.
 * Plus health-field surfacing (usedTodayTokens/maxDailyTokens) and the
 * conversation-detail agent block.
 *
 * Redis note: these guardrail counters live on the SHARED redis client (db 15).
 * Every agent/tool id is a fresh UUID, so keys never collide across tests; the
 * afterAll deletes every counter key this file created.
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
import { incrDayTokens } from '../../src/shared/agent-counters';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';

/** The deterministic reply an over-budget agent ships (G2). Must match src. */
const BUDGET_NOTE =
  "I'm temporarily unavailable right now — the team has been notified. Please try again later.";

const json = (res: { body: string }) => JSON.parse(res.body);

// ---- stub Anthropic-compatible model server ----
let llmStub: Server;
let llmBaseUrl = '';
const llmSeen: Array<{ messages: Array<{ role: string; content: unknown }> }> = [];
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
  return new Promise((r) => llmStub.listen(0, () => r()));
}

// ---- stub customer tool endpoint ----
let toolStub: Server;
let toolUrl = '';
const toolSeen: Array<{ tool?: string }> = [];
const OK_BODY = JSON.stringify({ status: 'ok', ref: 'ref_1' });

function startToolStub(): Promise<void> {
  toolStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      let body: { tool?: string } = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* leave empty */
      }
      toolSeen.push(body);
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(OK_BODY);
    });
  });
  return new Promise((r) => toolStub.listen(0, () => r()));
}

// ---- helpers ----
async function send(identifier: string, subscriberId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  return json(res) as { conversationId: string; messageId: string };
}

async function runWorker(conversationId: string, messageId: string) {
  await processConversation({
    data: { tenantId, conversationId, messageId },
  } as Job<ConversationJobData>);
}

/** Create a managed agent via the API; returns its DB id. */
async function createManagedAgent(identifier: string, name: string): Promise<string> {
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
  const { rows } = await pool.query('select id from agents where tenant_id = $1 and identifier = $2', [
    tenantId,
    identifier,
  ]);
  return rows[0].id as string;
}

/** Create an auto/required custom tool on an agent; returns its tool_def id. */
async function createTool(
  identifier: string,
  name: string,
  approval: 'auto' | 'required' = 'auto',
): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/tools`,
    headers: { 'x-api-key': apiKey },
    payload: {
      name,
      description: `Custom ${name}`,
      parameters: { type: 'object', properties: { orderId: { type: 'string' } } },
      endpointUrl: toolUrl,
      approval,
    },
  });
  expect(res.statusCode, `create tool ${name}`).toBe(201);
  const { rows } = await pool.query('select id from agent_tool_defs where name = $1 and tenant_id = $2', [
    name,
    tenantId,
  ]);
  return rows[0].id as string;
}

/** Arm a tool's guard directly (the guard shape is frozen, not yet API-settable). */
async function setGuard(
  toolDefId: string,
  guard: { maxAutoCalls?: number; windowDays?: number; maxCallsPerHour?: number },
): Promise<void> {
  await pool.query('update agent_tool_defs set guard = $2::jsonb where id = $1', [
    toolDefId,
    JSON.stringify(guard),
  ]);
}

/** The most recent tool-call row for a conversation. */
async function latestCall(conversationId: string): Promise<{
  id: string;
  status: string;
  result: string | null;
  note: string | null;
  duration_ms: number | null;
}> {
  const { rows } = await pool.query(
    `select id, status, result, note, duration_ms from agent_tool_calls
      where conversation_id = $1 order by requested_at desc limit 1`,
    [conversationId],
  );
  return rows[0];
}

async function latestAgentContent(conversationId: string): Promise<string | undefined> {
  const { rows } = await pool.query(
    `select content from conversation_messages where conversation_id = $1 and role = 'agent'
      order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0]?.content;
}

async function health(identifier: string, days = 7) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/agents/${identifier}/health?days=${days}`,
    headers: { 'x-api-key': apiKey },
  });
  return json(res);
}

const createdAgentIds: string[] = [];
const createdToolIds: string[] = [];

beforeAll(async () => {
  await startLlmStub();
  await startToolStub();
  llmBaseUrl = `http://localhost:${(llmStub.address() as AddressInfo).port}`;
  toolUrl = `http://localhost:${(toolStub.address() as AddressInfo).port}/tool`;

  app = await buildApp();
  const email = `guardrails-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Guardrails IT', email, password: 'integration-pw-1', organizationName: 'Guardrails Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  // The reserved ops-notification workflow (budget + approval alerts route here).
  await app.inject({
    method: 'PUT',
    url: '/v1/workflows',
    headers: { 'x-api-key': apiKey },
    payload: {
      key: 'agent-approvals',
      name: 'Approvals',
      steps: [{ channel: 'inapp', subject: 'Ops', body: 'Agent {{agentIdentifier}} needs attention' }],
    },
  });
});

afterAll(async () => {
  try {
    // Delete every guardrail counter key this file minted (shared redis, db 15).
    const patterns = [
      ...createdAgentIds.flatMap((id) => [`agent:${id}:tokens:*`, `budget-notified:${id}:*`]),
      ...createdToolIds.map((id) => `toolcap:${id}:*`),
    ];
    for (const p of patterns) {
      const keys = await redis.keys(p);
      if (keys.length > 0) await redis.del(...keys);
    }
    await pool.query('delete from agent_tool_calls where tenant_id = $1', [tenantId]);
    await pool.query('delete from agent_tool_defs where tenant_id = $1', [tenantId]);
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await pool.query('delete from events where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
    const txnKeys = await redis.keys(`txn:${tenantId}:*`);
    if (txnKeys.length > 0) await redis.del(...txnKeys);
  } catch {
    /* best-effort cleanup */
  }
  toolStub?.close();
  llmStub?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

// ===================================================================
// G1 — repeat-action rule: flip to approval at the threshold
// ===================================================================
describe('G1 repeat-action rule', () => {
  let guardAgentId = '';
  let refundToolId = '';
  // Reused by the conversation-detail agent-block test at the end.
  let flipConversationId = '';

  test('setup: managed agent + refund tool guarded {maxAutoCalls:1, windowDays:30}', async () => {
    guardAgentId = await createManagedAgent('g1-agent', 'G1 Agent');
    createdAgentIds.push(guardAgentId);
    refundToolId = await createTool('g1-agent', 'g1_refund', 'auto');
    createdToolIds.push(refundToolId);
    await setGuard(refundToolId, { maxAutoCalls: 1, windowDays: 30 });
  });

  test('1st auto call executes (under the ceiling)', async () => {
    toolSeen.length = 0;
    llmQueue = [
      llmToolUse([{ id: 'g1-1', name: 'g1_refund', input: { orderId: '#1' } }]),
      llmText('Refund done!'),
    ];
    const turn = await send('g1-agent', 'g1-user', 'refund my order', 'g1-msg-1');
    flipConversationId = turn.conversationId;
    await runWorker(turn.conversationId, turn.messageId);

    expect(toolSeen).toHaveLength(1); // one signed POST fired
    const row = await latestCall(turn.conversationId);
    expect(row.status).toBe('executed');
    expect(row.result).toBe(OK_BODY);
  });

  test('2nd auto call flips to a pending approval with the ⚠ history line + prior date', async () => {
    // The date the 1st call executed (UTC), which the history line echoes.
    const { rows: dateRows } = await pool.query<{ d: string }>(
      `select to_char(requested_at at time zone 'UTC', 'YYYY-MM-DD') as d
         from agent_tool_calls where conversation_id = $1 and status = 'executed'
        order by requested_at desc limit 1`,
      [flipConversationId],
    );
    const priorDate = dateRows[0].d;

    toolSeen.length = 0;
    llmQueue = [llmToolUse([{ id: 'g1-2', name: 'g1_refund', input: { orderId: '#2' } }])];
    const turn = await send('g1-agent', 'g1-user', 'another refund', 'g1-msg-2');
    await runWorker(turn.conversationId, turn.messageId);

    // No POST — the second attempt paused behind a human decision.
    expect(toolSeen).toHaveLength(0);

    const row = await latestCall(turn.conversationId);
    expect(row.status).toBe('pending');

    // The paused row carries the frozen guard-history note.
    expect(row.note).toContain('⚠');
    expect(row.note).toContain('2nd g1_refund in 30d');
    expect(row.note).toContain(`prior: ${priorDate}`);

    // The user-facing reply is the deterministic "asked a teammate" note.
    expect(await latestAgentContent(turn.conversationId)).toBe(
      "I've asked a teammate to approve g1_refund — I'll follow up here as soon as it's decided.",
    );
  });

  test('window respected: an executed row OUTSIDE the window does NOT count', async () => {
    // Fresh subscriber → its own execution history. First call executes.
    toolSeen.length = 0;
    llmQueue = [
      llmToolUse([{ id: 'g1-w1', name: 'g1_refund', input: { orderId: '#w1' } }]),
      llmText('Refund done!'),
    ];
    const t1 = await send('g1-agent', 'g1-win-user', 'refund', 'g1-win-1');
    await runWorker(t1.conversationId, t1.messageId);
    expect((await latestCall(t1.conversationId)).status).toBe('executed');

    // Age that executed row to 40 days ago — now outside the 30-day window.
    await pool.query(
      "update agent_tool_calls set requested_at = now() - interval '40 days' where conversation_id = $1",
      [t1.conversationId],
    );

    // Second call: the only prior execution is out-of-window → count 0 → stays
    // auto and EXECUTES (does not flip to pending).
    toolSeen.length = 0;
    llmQueue = [
      llmToolUse([{ id: 'g1-w2', name: 'g1_refund', input: { orderId: '#w2' } }]),
      llmText('Refund done!'),
    ];
    const t2 = await send('g1-agent', 'g1-win-user', 'refund again', 'g1-win-2');
    await runWorker(t2.conversationId, t2.messageId);

    expect(toolSeen).toHaveLength(1); // it executed — the old row didn't trip the guard
    const row = await latestCall(t2.conversationId);
    expect(row.status).toBe('executed');
    const pending = await pool.query(
      "select count(*)::int as n from agent_tool_calls where conversation_id = $1 and status = 'pending'",
      [t2.conversationId],
    );
    expect(pending.rows[0].n).toBe(0);
  });

  test('conversation detail returns the owning agent block {identifier, name}', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/conversations/${flipConversationId}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent).toEqual({ identifier: 'g1-agent', name: 'G1 Agent' });
  });
});

// ===================================================================
// G3 — per-tool hourly rate cap
// ===================================================================
describe('G3 rate cap', () => {
  let rateToolId = '';

  test('setup: agent + tool guarded {maxCallsPerHour:1}', async () => {
    const agentId = await createManagedAgent('g3-agent', 'G3 Agent');
    createdAgentIds.push(agentId);
    rateToolId = await createTool('g3-agent', 'rate_tool', 'auto');
    createdToolIds.push(rateToolId);
    await setGuard(rateToolId, { maxCallsPerHour: 1 });
  });

  test('1st call executes; 2nd (same subscriber, same hour) is is_error with no row', async () => {
    // First call: within the cap → executes.
    toolSeen.length = 0;
    llmQueue = [
      llmToolUse([{ id: 'g3-1', name: 'rate_tool', input: { orderId: '#1' } }]),
      llmText('Done.'),
    ];
    const t1 = await send('g3-agent', 'g3-user', 'do it', 'g3-msg-1');
    await runWorker(t1.conversationId, t1.messageId);
    expect(toolSeen).toHaveLength(1);
    expect((await latestCall(t1.conversationId)).status).toBe('executed');

    // Second call same hour: over the cap → is_error, NOTHING recorded, no POST.
    toolSeen.length = 0;
    llmSeen.length = 0;
    llmQueue = [
      llmToolUse([{ id: 'g3-2', name: 'rate_tool', input: { orderId: '#2' } }]),
      llmText('Sorry, please try again later.'),
    ];
    const t2 = await send('g3-agent', 'g3-user', 'do it again', 'g3-msg-2');
    await runWorker(t2.conversationId, t2.messageId);

    expect(toolSeen).toHaveLength(0); // no POST for the capped call

    // The model's round-2 request carried the rate-limit is_error tool_result.
    const round2 = llmSeen.at(-1)!.messages;
    const last = round2.at(-1) as { role: string; content: Array<{ is_error?: boolean; content: string }> };
    expect(last.role).toBe('user');
    expect(last.content[0].is_error).toBe(true);
    expect(last.content[0].content).toContain('rate limit reached');

    // No tool-call row was recorded for the whole rate_tool history: 1 (only the
    // first, executed) — the capped attempt never touched agent_tool_calls.
    const rows = await pool.query(
      "select count(*)::int as n from agent_tool_calls where tool_name = 'rate_tool' and tenant_id = $1",
      [tenantId],
    );
    expect(rows.rows[0].n).toBe(1);
  });
});

// ===================================================================
// G4 — duration_ms on executed rows + real per-tool avgMs in /health
// ===================================================================
describe('G4 duration_ms', () => {
  test('an executed auto tool stamps duration_ms; health surfaces a real avgMs', async () => {
    const agentId = await createManagedAgent('g4-agent', 'G4 Agent');
    createdAgentIds.push(agentId);
    const toolId = await createTool('g4-agent', 'timed_tool', 'auto');
    createdToolIds.push(toolId);

    toolSeen.length = 0;
    llmQueue = [
      llmToolUse([{ id: 'g4-1', name: 'timed_tool', input: { orderId: '#t' } }]),
      llmText('Done.'),
    ];
    const turn = await send('g4-agent', 'g4-user', 'run it', 'g4-msg-1');
    await runWorker(turn.conversationId, turn.messageId);

    const row = await latestCall(turn.conversationId);
    expect(row.status).toBe('executed');
    // The executor wall-clocked the signed POST onto the row.
    expect(row.duration_ms).not.toBeNull();
    expect(row.duration_ms as number).toBeGreaterThanOrEqual(0);

    // Phase 21's per-tool avgMs is now real (not null) because a duration exists.
    const h = await health('g4-agent', 7);
    const stat = (h.tools as Array<{ name: string; avgMs: number | null }>).find(
      (t) => t.name === 'timed_tool',
    );
    expect(stat).toBeTruthy();
    expect(stat!.avgMs).not.toBeNull();
    expect(typeof stat!.avgMs).toBe('number');
  });
});

// ===================================================================
// G2 — per-agent daily token budget (breaker before the model call)
// ===================================================================
describe('G2 daily token budget', () => {
  let basicAgentId = '';

  test('setup: agent with a tiny budget, day-counter already over it', async () => {
    basicAgentId = await createManagedAgent('g2-agent', 'G2 Agent');
    createdAgentIds.push(basicAgentId);
    await pool.query('update agents set max_daily_tokens = 30 where id = $1', [basicAgentId]);
    // Push today's spend to 50 (>= 30) so the very next turn trips the breaker.
    await incrDayTokens(basicAgentId, 50);
  });

  test('budget trips: no model call, exact note, breadcrumb raw.budgetExhausted; no pair → 0 events + no phantom', async () => {
    const modelCallsBefore = llmSeen.length;
    const turn = await send('g2-agent', 'g2-user', 'hello?', 'g2-msg-1');
    await runWorker(turn.conversationId, turn.messageId);

    // The breaker skipped the brain entirely — zero model calls happened.
    expect(llmSeen.length).toBe(modelCallsBefore);

    // The deterministic note is the delivered reply (exact text).
    expect(await latestAgentContent(turn.conversationId)).toBe(BUDGET_NOTE);

    // The skip breadcrumb carries used/limit in raw.budgetExhausted.
    const bc = await pool.query<{ content: string; raw: { budgetExhausted: { used: number; limit: number } } }>(
      `select content, raw from conversation_messages
        where conversation_id = $1 and role = 'system' and raw ? 'budgetExhausted'
        order by created_at desc limit 1`,
      [turn.conversationId],
    );
    expect(bc.rowCount).toBe(1);
    expect(bc.rows[0].raw.budgetExhausted).toEqual({ used: 50, limit: 30 });

    // No 'approvals' subscriber exists → no ops alert, no phantom subscriber.
    const evt = await pool.query(
      "select 1 from events where tenant_id = $1 and transaction_id like 'budget-alert-%'",
      [tenantId],
    );
    expect(evt.rowCount).toBe(0);
    const subs = await pool.query(
      "select 1 from subscribers where tenant_id = $1 and external_id = 'approvals'",
      [tenantId],
    );
    expect(subs.rowCount).toBe(0);
  });

  test('health surfaces usedTodayTokens/maxDailyTokens', async () => {
    const h = await health('g2-agent', 7);
    expect(h.usedTodayTokens).toBe(50);
    expect(h.maxDailyTokens).toBe(30);
  });

  test('platform budget-note is NOT replayed to the model (lesson §13 fold)', async () => {
    // The budget note is PLATFORM-authored, not the model's words. If it replays
    // as an assistant turn, GLM parrots it verbatim on later turns even after the
    // budget clears (observed live). It must be tagged and folded out of replay.
    const foldAgentId = await createManagedAgent('g2-fold-agent', 'G2 Fold Agent');
    createdAgentIds.push(foldAgentId);
    await pool.query('update agents set max_daily_tokens = 30 where id = $1', [foldAgentId]);
    await incrDayTokens(foldAgentId, 50);

    // Turn 1: budget trips → the note is stored, tagged raw.platformNote, no call.
    const before = llmSeen.length;
    const t1 = await send('g2-fold-agent', 'fold-user', 'first message', 'fold-1');
    await runWorker(t1.conversationId, t1.messageId);
    expect(llmSeen.length).toBe(before);
    expect(await latestAgentContent(t1.conversationId)).toBe(BUDGET_NOTE);
    const noteRow = await pool.query<{ raw: { platformNote?: boolean } }>(
      `select raw from conversation_messages
         where conversation_id = $1 and role = 'agent' and content = $2
         order by created_at desc limit 1`,
      [t1.conversationId, BUDGET_NOTE],
    );
    expect(noteRow.rows[0].raw.platformNote).toBe(true);

    // Clear the budget → the next turn is answered by the model.
    await pool.query('update agents set max_daily_tokens = null where id = $1', [foldAgentId]);
    llmQueue = [llmText('Sure, how can I help?')];
    const t2 = await send('g2-fold-agent', 'fold-user', 'second message', 'fold-2');
    await runWorker(t2.conversationId, t2.messageId);

    // The model WAS called, and the history it received carries NO copy of the
    // platform note (the fold kept it out), while the real user turns DID replay.
    expect(llmSeen.length).toBeGreaterThan(before);
    const sent = JSON.stringify(llmSeen.at(-1)!.messages);
    expect(sent).not.toContain(BUDGET_NOTE);
    expect(sent).toContain('first message');
    expect(sent).toContain('second message');
    // And the turn produced a normal, model-authored reply.
    expect(await latestAgentContent(t2.conversationId)).toBe('Sure, how can I help?');
  });

  test('with the reserved pair: exactly 1 ops event; a 2nd trip same day stays 1 (debounced)', async () => {
    // Opt in: the tenant wires an 'approvals' ops subscriber (the 'agent-approvals'
    // workflow already exists from beforeAll). Use a FRESH agent so its
    // once-per-day debounce claim is clean.
    await pool.query(
      "insert into subscribers (tenant_id, external_id, email) values ($1, 'approvals', 'ops@example.com')",
      [tenantId],
    );
    const pairAgentId = await createManagedAgent('g2-pair-agent', 'G2 Pair Agent');
    createdAgentIds.push(pairAgentId);
    await pool.query('update agents set max_daily_tokens = 30 where id = $1', [pairAgentId]);
    await incrDayTokens(pairAgentId, 50);

    // First trip → fires the reserved alert at the 'approvals' audience.
    const t1 = await send('g2-pair-agent', 'pair-user-1', 'hi', 'g2-pair-1');
    await runWorker(t1.conversationId, t1.messageId);

    const evt1 = await pool.query<{ recipients: Array<{ subscriberId: string }> }>(
      'select recipients from events where tenant_id = $1 and transaction_id = $2',
      [tenantId, `budget-alert-${t1.messageId}`],
    );
    expect(evt1.rowCount).toBe(1);
    expect(evt1.rows[0].recipients.map((r) => r.subscriberId)).toEqual(['approvals']);
    // The end customer is never told the agent went quiet.
    expect(evt1.rows[0].recipients.some((r) => r.subscriberId === 'pair-user-1')).toBe(false);

    // Second trip same UTC day (different message) → debounced, NO new event.
    const t2 = await send('g2-pair-agent', 'pair-user-2', 'hi again', 'g2-pair-2');
    await runWorker(t2.conversationId, t2.messageId);
    const evt2 = await pool.query(
      'select 1 from events where tenant_id = $1 and transaction_id = $2',
      [tenantId, `budget-alert-${t2.messageId}`],
    );
    expect(evt2.rowCount).toBe(0);

    // Across the whole day for this agent: exactly one budget alert fired.
    const total = await pool.query(
      "select count(*)::int as n from events where tenant_id = $1 and transaction_id like 'budget-alert-%'",
      [tenantId],
    );
    expect(total.rows[0].n).toBe(1);
  });
});
