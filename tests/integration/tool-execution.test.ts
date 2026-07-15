/**
 * Phase 18 custom-tool execution lifecycle, end to end: the real Fastify app +
 * the real managed brain (@anthropic-ai/sdk pointed at a stub Messages API) +
 * a real, signature-verifying HTTP tool endpoint. Only the model server and the
 * customer's tool server are local stubs; every hop between them is production.
 *
 * Covers: auto tools (signed one-shot POST, idempotent re-run), the is_error
 * path, 16KB truncation, the approval pause + reserved-audience notification,
 * approve/deny/expire resume via the tool-decision job, and job-retry safety.
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
import { verifyWebhook } from '../../src/api/webhook-signature';
import { runInactivitySweep } from '../../src/workers/inactivity-sweep';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
const NOTE = "I've asked a teammate to approve gated_refund — I'll follow up here as soon as it's decided.";

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

// ---- stub customer tool endpoint (verifies our signature) ----
let toolStub: Server;
let toolUrl = '';
interface ToolHit {
  idem?: string;
  timestamp?: string;
  signature?: string;
  sigValid: boolean;
  body: { toolCallId?: string; tool?: string; arguments?: unknown; agent?: unknown; conversation?: unknown };
  rawBody: string;
}
const toolSeen: ToolHit[] = [];
const toolSecrets: string[] = []; // every created tool's plaintext secret
let toolMode: 'ok' | 'fail' | 'big' = 'ok';
const OK_BODY = JSON.stringify({ status: 'refunded', ref: 'ref_1' });

function startToolStub(): Promise<void> {
  toolStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const timestamp = req.headers['x-asyncify-timestamp'] as string | undefined;
      const signature = req.headers['x-asyncify-signature'] as string | undefined;
      const idem = req.headers['x-asyncify-idempotency-key'] as string | undefined;
      // A real customer verifies the HMAC before trusting the body — do it here
      // against every issued secret so any tool's call verifies.
      const sigValid = toolSecrets.some((s) => verifyWebhook(s, timestamp, signature, raw).ok);
      let body: ToolHit['body'] = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* leave empty */
      }
      toolSeen.push({ idem, timestamp, signature, sigValid, body, rawBody: raw });
      if (toolMode === 'fail') {
        res.statusCode = 500;
        res.end('internal boom');
        return;
      }
      if (toolMode === 'big') {
        res.statusCode = 200;
        res.end('X'.repeat(40 * 1024));
        return;
      }
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(OK_BODY);
    });
  });
  return new Promise((r) => toolStub.listen(0, () => r()));
}

// ---- helpers ----
async function send(subscriberId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents/tool-agent/messages',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  return json(res) as { conversationId: string; messageId: string };
}

async function runWorker(conversationId: string, messageId: string) {
  await processConversation({ data: { tenantId, conversationId, messageId } } as Job<ConversationJobData>);
}

async function runJob(jobId: string): Promise<Job> {
  const job = (await getQueue(QUEUE.CONVERSATION).getJob(jobId)) as Job;
  expect(job, `expected queued job ${jobId}`).toBeTruthy();
  await processConversation(job as Job<ConversationJobData>);
  return job;
}

async function callRow(conversationId: string): Promise<{
  id: string;
  status: string;
  result: string | null;
  expires_at: string | null;
  breadcrumb_message_id: string | null;
}> {
  const { rows } = await pool.query(
    'select id, status, result, expires_at, breadcrumb_message_id from agent_tool_calls where conversation_id = $1 order by requested_at desc limit 1',
    [conversationId],
  );
  return rows[0];
}

/** The latest breadcrumb (system row carrying raw.action) for a conversation. */
async function breadcrumbAction(
  conversationId: string,
): Promise<{ tool: string; input: Record<string, unknown>; result: string } | undefined> {
  const { rows } = await pool.query(
    `select raw from conversation_messages
      where conversation_id = $1 and role = 'system' and raw ? 'action'
      order by created_at desc limit 1`,
    [conversationId],
  );
  return (rows[0]?.raw as { action?: { tool: string; input: Record<string, unknown>; result: string } })?.action;
}

async function latestAgentContent(conversationId: string): Promise<string | undefined> {
  const { rows } = await pool.query(
    `select content from conversation_messages where conversation_id = $1 and role = 'agent'
      order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0]?.content;
}

async function decisionRow(conversationId: string): Promise<{ id: string; content: string; raw: unknown } | undefined> {
  const { rows } = await pool.query(
    `select id, content, raw from conversation_messages
      where conversation_id = $1 and role = 'system' and content like '[approval decided:%'
      order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0];
}

async function createTool(name: string, approval: 'auto' | 'required'): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents/tool-agent/tools',
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
  toolSecrets.push(json(res).secret); // capture plaintext for signature checks
}

async function decide(callId: string, decision: 'approve' | 'deny', note?: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/approvals/${callId}/decision`,
    headers: { 'x-api-key': apiKey },
    payload: { decision, ...(note ? { note } : {}) },
  });
  expect(res.statusCode).toBe(200);
}

beforeAll(async () => {
  await startLlmStub();
  await startToolStub();
  llmBaseUrl = `http://localhost:${(llmStub.address() as AddressInfo).port}`;
  toolUrl = `http://localhost:${(toolStub.address() as AddressInfo).port}/tool`;

  app = await buildApp();
  const email = `tool-exec-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Tool Exec IT', email, password: 'integration-pw-1', organizationName: 'Tool Exec Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  // The reserved ops-notification workflow (approval alerts route to it).
  await app.inject({
    method: 'PUT',
    url: '/v1/workflows',
    headers: { 'x-api-key': apiKey },
    payload: {
      key: 'agent-approvals',
      name: 'Approvals',
      steps: [{ channel: 'inapp', subject: 'Approval needed', body: 'Tool {{toolName}} awaits approval' }],
    },
  });

  const create = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: 'tool-agent',
      name: 'Tool Agent',
      runtime: 'managed',
      model: 'glm-4-test',
      llm: { apiKey: 'managed-test-key', baseUrl: llmBaseUrl },
    },
  });
  expect(create.statusCode).toBe(201);

  await createTool('auto_refund', 'auto');
  await createTool('gated_refund', 'required');
});

afterAll(async () => {
  try {
    await pool.query('delete from agent_tool_calls where tenant_id = $1', [tenantId]);
    await pool.query('delete from agent_tool_defs where tenant_id = $1', [tenantId]);
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await pool.query('delete from events where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
    const keys = await redis.keys(`txn:${tenantId}:*`);
    if (keys.length > 0) await redis.del(...keys);
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

describe('(a) auto tool: one signed POST, effect recorded, idempotent re-run', () => {
  let conversationId = '';
  let messageId = '';

  test('a scripted tool_use fires exactly one signed, idempotency-keyed POST and records the result', async () => {
    toolSeen.length = 0;
    toolMode = 'ok';
    llmQueue = [
      llmToolUse([{ id: 't-a1', name: 'auto_refund', input: { orderId: '#1' } }]),
      llmText('Refund done!'),
    ];
    const turn = await send('auto-user', 'refund my order', 'auto-1');
    conversationId = turn.conversationId;
    messageId = turn.messageId;
    await runWorker(turn.conversationId, turn.messageId);

    // Exactly one POST arrived.
    expect(toolSeen).toHaveLength(1);
    const hit = toolSeen[0];

    // The signature verifies against the plaintext secret captured at create.
    expect(hit.sigValid).toBe(true);

    const row = await callRow(conversationId);
    // Idempotency key == the call row id; body carries the frozen envelope.
    expect(hit.idem).toBe(row.id);
    expect(hit.body).toEqual({
      toolCallId: row.id,
      tool: 'auto_refund',
      arguments: { orderId: '#1' },
      agent: { identifier: 'tool-agent' },
      conversation: { id: conversationId, subscriberId: 'auto-user' },
    });

    // Result lands on the row (executed) AND in the breadcrumb raw.action.result.
    expect(row.status).toBe('executed');
    expect(row.result).toBe(OK_BODY);
    const action = await breadcrumbAction(conversationId);
    expect(action).toEqual({ tool: 'auto_refund', input: { orderId: '#1' }, result: OK_BODY });
  });

  test('re-running the SAME turn job POSTs nothing and reuses the stored result', async () => {
    toolSeen.length = 0;
    llmQueue = [
      llmToolUse([{ id: 't-a1r', name: 'auto_refund', input: { orderId: '#1' } }]),
      llmText('Refund done!'),
    ];
    await runWorker(conversationId, messageId); // crash-retry
    expect(toolSeen).toHaveLength(0); // conflict-reuse: no second POST
    const row = await callRow(conversationId);
    expect(row.status).toBe('executed');
    expect(row.result).toBe(OK_BODY);
  });
});

describe('(b) a 5xx tool endpoint becomes the is_error self-correction path', () => {
  test('status failed, and the model sees the error tool_result on its next call', async () => {
    toolSeen.length = 0;
    toolMode = 'fail';
    llmQueue = [
      llmToolUse([{ id: 't-b1', name: 'auto_refund', input: { orderId: '#b' } }]),
      llmText('Sorry, I could not process that refund.'),
    ];
    const turn = await send('fail-user', 'refund please', 'fail-1');
    await runWorker(turn.conversationId, turn.messageId);
    toolMode = 'ok';

    const row = await callRow(turn.conversationId);
    expect(row.status).toBe('failed');
    expect(row.result).toContain('HTTP 500');

    // The model's round-2 request carried the error tool_result (is_error:true).
    const round2 = llmSeen.at(-1)!.messages;
    const last = round2.at(-1) as { role: string; content: Array<{ is_error?: boolean; content: string }> };
    expect(last.role).toBe('user');
    expect(last.content[0].is_error).toBe(true);
    expect(last.content[0].content).toContain('HTTP 500');
  });
});

describe('(c) a 40KB tool body is truncated to the 16KB cap', () => {
  test('the stored result never exceeds 16384 bytes', async () => {
    toolSeen.length = 0;
    toolMode = 'big';
    llmQueue = [
      llmToolUse([{ id: 't-c1', name: 'auto_refund', input: { orderId: '#c' } }]),
      llmText('Done.'),
    ];
    const turn = await send('big-user', 'refund big', 'big-1');
    await runWorker(turn.conversationId, turn.messageId);
    toolMode = 'ok';

    const row = await callRow(turn.conversationId);
    expect(row.status).toBe('executed');
    expect(row.result!.length).toBeLessThanOrEqual(16384);
    expect(row.result!.length).toBe(16384); // exactly the cap for a 40KB body
  });
});

describe('(d) an approval-required tool pauses the turn (no POST) and notifies staff', () => {
  test('without an approvals subscriber: pending row, breadcrumb, deterministic note, no POST, no phantom subscriber, no event', async () => {
    toolSeen.length = 0;
    llmQueue = [llmToolUse([{ id: 't-d1', name: 'gated_refund', input: { orderId: '#d1' } }])];
    const turn = await send('gate-user-1', 'refund needs approval', 'gate-1');
    await runWorker(turn.conversationId, turn.messageId);

    // No POST happened — execution is gated behind the human decision.
    expect(toolSeen).toHaveLength(0);

    const row = await callRow(turn.conversationId);
    expect(row.status).toBe('pending');
    // expires_at is ~24h out (the APPROVAL_TTL).
    const ttlMs = new Date(row.expires_at!).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(23 * 3600 * 1000);
    expect(ttlMs).toBeLessThan(25 * 3600 * 1000);

    // The breadcrumb records the pause; the reply is the deterministic note.
    const action = await breadcrumbAction(turn.conversationId);
    expect(action?.result).toBe(`pending human approval (${row.id})`);
    expect(await latestAgentContent(turn.conversationId)).toBe(NOTE);

    // No 'approvals' subscriber exists → no phantom row, no notification event.
    const subs = await pool.query(
      "select 1 from subscribers where tenant_id = $1 and external_id = 'approvals'",
      [tenantId],
    );
    expect(subs.rowCount).toBe(0);
    const evt = await pool.query('select 1 from events where tenant_id = $1 and transaction_id = $2', [
      tenantId,
      `approval-note-${row.id}`,
    ]);
    expect(evt.rowCount).toBe(0);
  });

  test('with an approvals subscriber: the reserved notification fires at it, never at the conversation subscriber', async () => {
    // Opt in: the tenant wires an 'approvals' ops subscriber (the workflow
    // 'agent-approvals' already exists from beforeAll).
    await pool.query(
      "insert into subscribers (tenant_id, external_id, email) values ($1, 'approvals', 'ops@example.com')",
      [tenantId],
    );

    toolSeen.length = 0;
    llmQueue = [llmToolUse([{ id: 't-d2', name: 'gated_refund', input: { orderId: '#d2' } }])];
    const turn = await send('gate-user-2', 'refund needs approval', 'gate-2');
    await runWorker(turn.conversationId, turn.messageId);
    expect(toolSeen).toHaveLength(0);

    const row = await callRow(turn.conversationId);
    const evt = await pool.query<{ recipients: Array<{ subscriberId: string }>; payload: Record<string, unknown> }>(
      'select recipients, payload from events where tenant_id = $1 and transaction_id = $2',
      [tenantId, `approval-note-${row.id}`],
    );
    expect(evt.rowCount).toBe(1);
    const recipients = evt.rows[0].recipients;
    expect(recipients.map((r) => r.subscriberId)).toEqual(['approvals']);
    // The end customer is never told their own refund needs approval.
    expect(recipients.some((r) => r.subscriberId === 'gate-user-2')).toBe(false);
    expect(evt.rows[0].payload).toMatchObject({
      approvalId: row.id,
      agentIdentifier: 'tool-agent',
      toolName: 'gated_refund',
      conversationId: turn.conversationId,
    });
  });
});

describe('(e) approve → the tool-decision job runs the POST and threads a follow-up turn', () => {
  let conversationId = '';
  let callId = '';
  let decisionRowId = '';

  test('approving fires exactly one POST, updates the breadcrumb in place, and drops a raw-null decision row', async () => {
    toolSeen.length = 0;
    llmQueue = [llmToolUse([{ id: 't-e1', name: 'gated_refund', input: { orderId: '#e' } }])];
    const turn = await send('appr-user', 'refund with approval', 'appr-1');
    conversationId = turn.conversationId;
    await runWorker(turn.conversationId, turn.messageId);
    expect(toolSeen).toHaveLength(0); // paused, not executed

    const pending = await callRow(conversationId);
    callId = pending.id;
    await decide(callId, 'approve');

    // The decision job runs the POST (no LLM involved in this hop).
    toolSeen.length = 0;
    toolMode = 'ok';
    await runJob(`tool-decision-${callId}`);
    expect(toolSeen).toHaveLength(1); // the approval executed the tool once

    const row = await callRow(conversationId);
    expect(row.status).toBe('executed');
    expect(row.result).toBe(OK_BODY);

    // The pause breadcrumb was rewritten in place — no longer "pending…".
    const action = await breadcrumbAction(conversationId);
    expect(action?.result).toBe(OK_BODY);
    expect(action?.result).not.toContain('pending human approval');

    // A plain, raw-null decision row (skipped by replay; doubles as the turn inbound).
    const decision = await decisionRow(conversationId);
    expect(decision).toBeTruthy();
    expect(decision!.content).toBe('[approval decided: gated_refund — executed]');
    expect(decision!.raw).toBeNull();
    decisionRowId = decision!.id;
  });

  test('the follow-up turn job (conv-<decisionRowId>) is enqueued and produces the user-facing reply', async () => {
    const job = (await getQueue(QUEUE.CONVERSATION).getJob(`conv-${decisionRowId}`)) as Job;
    expect(job).toBeTruthy();
    expect(job.data.messageId).toBe(decisionRowId);

    llmQueue = [llmText('Good news — your refund went through.')];
    await runJob(`conv-${decisionRowId}`);
    expect(await latestAgentContent(conversationId)).toBe('Good news — your refund went through.');
  });

  test('(h) re-running the decision job POSTs nothing and creates no duplicate decision row', async () => {
    toolSeen.length = 0;
    await runJob(`tool-decision-${callId}`); // crash-retry after execution
    expect(toolSeen).toHaveLength(0);

    const decisions = await pool.query(
      `select count(*)::int as n from conversation_messages
        where conversation_id = $1 and content like '[approval decided:%'`,
      [conversationId],
    );
    expect(decisions.rows[0].n).toBe(1);
  });
});

describe('(f) deny → no POST, the denial (with note) lands in the breadcrumb', () => {
  test('the decision job records the denial and never dials the endpoint', async () => {
    toolSeen.length = 0;
    llmQueue = [llmToolUse([{ id: 't-f1', name: 'gated_refund', input: { orderId: '#f' } }])];
    const turn = await send('deny-user', 'refund with approval', 'deny-1');
    await runWorker(turn.conversationId, turn.messageId);

    const pending = await callRow(turn.conversationId);
    await decide(pending.id, 'deny', 'not this time');

    toolSeen.length = 0;
    await runJob(`tool-decision-${pending.id}`);
    expect(toolSeen).toHaveLength(0); // a denial never POSTs

    const row = await callRow(turn.conversationId);
    expect(row.status).toBe('denied');
    const action = await breadcrumbAction(turn.conversationId);
    // decided_by is 'api-key' for an api-key caller (no user identity).
    expect(action?.result).toBe('denied by api-key: not this time');

    const decision = await decisionRow(turn.conversationId);
    expect(decision!.content).toBe('[approval decided: gated_refund — denied]');
  });
});

describe('(g) expiry → the sweep flips the row and the decision job records "approval expired"', () => {
  test('an aged pending row is expired by the sweep, enqueues a decision job, and the breadcrumb reflects it', async () => {
    toolSeen.length = 0;
    llmQueue = [llmToolUse([{ id: 't-g1', name: 'gated_refund', input: { orderId: '#g' } }])];
    const turn = await send('expire-user', 'refund with approval', 'expire-1');
    await runWorker(turn.conversationId, turn.messageId);

    const pending = await callRow(turn.conversationId);
    // Age the row past its deadline (fake the clock, never the path).
    await pool.query("update agent_tool_calls set expires_at = now() - interval '1 minute' where id = $1", [
      pending.id,
    ]);

    await runInactivitySweep();

    const expired = await callRow(turn.conversationId);
    expect(expired.status).toBe('expired');

    // The sweep enqueued the decision job; run it.
    toolSeen.length = 0;
    await runJob(`tool-decision-${pending.id}`);
    expect(toolSeen).toHaveLength(0); // an expiry never POSTs

    const action = await breadcrumbAction(turn.conversationId);
    expect(action?.result).toBe('approval expired');
    const decision = await decisionRow(turn.conversationId);
    expect(decision!.content).toBe('[approval decided: gated_refund — expired]');
  });
});
