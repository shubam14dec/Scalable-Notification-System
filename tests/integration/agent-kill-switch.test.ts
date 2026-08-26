/**
 * Phase A10 slice A — THE KILL-SWITCH, driven through the real path.
 *
 * Real app, real queue, real conversation worker, real @anthropic-ai/sdk pointed
 * (via the agent's llm_base_url) at a stub Messages API — only the model server
 * is fake, so what the stub RECEIVES is the proof of what reached a model. A
 * real bridge stub plays the second runtime's customer code for the same reason:
 * for a bridge agent, "paused" means one specific thing, and the only honest way
 * to assert it is to count the POSTs that never arrived.
 *
 * The properties under test are the switch's whole contract:
 *   1. off = byte-identical to a pre-A10 agent;
 *   2. the door stays open — a paused agent still ACCEPTS messages (202, never
 *      the 409 `disabled` gives) and the row still lands in the transcript;
 *   3. nothing runs — no model call, no bridge POST;
 *   4. the customer hears the platform's holding line VERBATIM, exactly once
 *      per conversation, tagged so the model can never learn to imitate it;
 *   5. the conversation lands in the P26 operator queue, asserted through the
 *      SAME read the dashboard's queue uses;
 *   6. a second message adds its row and nothing else — no second apology;
 *   7. the P26 surface keeps working while paused: an operator replies into a
 *      held conversation and takes the pen;
 *   8. a conversation a human already owns is not transitioned twice;
 *   9. handback while still paused re-holds it — a fresh breadcrumb, still no
 *      second holding line;
 *  10. resume → the very next message runs an ordinary turn;
 *  11. both runtimes, including the bridge;
 *  12. pause/resume are idempotent (an emergency button never errors on a
 *      double-press) and 404 on an unknown agent;
 *  13. `disabled` and `paused` stay different things at the API;
 *  14. an eval run is exempt — pause, diagnose, RUN THE EVALS, resume;
 *  15. structurally: nothing at ingress reads the column.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, getQueue, QUEUE } from '../../src/shared/queues';
import { createRedis, redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import { processEvalRun } from '../../src/workers/processors/eval-run.processor';

const MODEL = 'strong-model-1';

/**
 * The platform's holding line, TYPED OUT rather than imported from the
 * processor. The const is customer-facing copy on an emergency path, so the
 * test's job is to notice if it silently changes — importing it would assert
 * only that the string equals itself.
 */
const HOLDING_LINE =
  'Our team is taking over this conversation — a person will be with you shortly.';

let app: FastifyInstance;
let apiKey = '';
let accessToken = ''; // dashboard JWT — the operator identity (P26 push)
let tenantId = '';
let convWorker: Worker;

// ---- stub Anthropic-compatible server (wire capture) ------------------------
let llmStub: Server;
let llmBaseUrl = '';
let llmHits = 0;

const envelope = (text: string) => ({
  id: 'msg_stub_1',
  type: 'message',
  role: 'assistant',
  model: 'scripted',
  content: [{ type: 'text', text }],
  stop_reason: 'end_turn',
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      llmHits += 1;
      const body = JSON.parse(raw) as { messages: Array<{ role: string; content: string }> };
      const lastText = String(body.messages.at(-1)?.content ?? '').split('\n\n<platform_reminder>')[0];
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(envelope(`echo(${lastText})`)));
    });
  });
  return new Promise((r) => llmStub.listen(0, '127.0.0.1', () => r()));
}

// ---- a bridge agent's own server (never an LLM) -----------------------------
let bridgeStub: Server;
let bridgeUrl = '';
let bridgeHits = 0;
function startBridgeStub(): Promise<void> {
  bridgeStub = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      bridgeHits += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ reply: 'the bridge answered' }));
    });
  });
  return new Promise((r) => bridgeStub.listen(0, '127.0.0.1', () => r()));
}

const json = (res: { body: string }) => JSON.parse(res.body);
const TURN_TIMEOUT = { timeout: 45_000 };

async function waitFor(pred: () => Promise<boolean>, ms = 35_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for the turn to finish');
}

/**
 * Wait for THE TURN JOB ITSELF to finish, not for a reply to appear — the same
 * tool A8 needed and for the same reason: a held message may produce NO reply
 * at all, so "wait until a row shows up" cannot tell "held correctly" from
 * "still queued", and every negative assertion below would be worthless.
 */
async function turnDone(messageId: string): Promise<void> {
  const q = getQueue(QUEUE.CONVERSATION);
  await waitFor(async () => {
    const job = await q.getJob(`conv-${messageId}`);
    if (!job) return true; // already reaped
    const state = await job.getState();
    return state === 'completed' || state === 'failed';
  });
}

async function send(identifier: string, subscriberId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  return { status: res.statusCode, body: json(res) as { conversationId: string; messageId: string } };
}

async function sendAndSettle(
  identifier: string,
  subscriberId: string,
  text: string,
  messageId: string,
) {
  const sent = await send(identifier, subscriberId, text, messageId);
  expect(sent.status, `post ${messageId}`).toBe(202);
  await turnDone(sent.body.messageId);
  return sent.body;
}

const pauseAgent = (identifier: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/pause`,
    headers: { 'x-api-key': apiKey },
  });

const resumeAgent = (identifier: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/resume`,
    headers: { 'x-api-key': apiKey },
  });

async function conversationStatus(id: string): Promise<string> {
  const { rows } = await pool.query('select status from conversations where id = $1', [id]);
  return rows[0]?.status as string;
}

/**
 * Is this conversation in the operator's queue? Asked through the SAME route
 * and filter the dashboard's Conversations page uses, so a pass here means a
 * person really would see it — not merely that a column says waiting_human.
 */
async function inOperatorQueue(conversationId: string): Promise<boolean> {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/conversations?status=waiting_human&limit=200',
    headers: { 'x-api-key': apiKey },
  });
  expect(res.statusCode).toBe(200);
  return (json(res).conversations as Array<{ id: string }>).some((c) => c.id === conversationId);
}

async function operatorQueueSize(agentIdentifier: string): Promise<number> {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/conversations?status=waiting_human&agent=${agentIdentifier}&limit=200`,
    headers: { 'x-api-key': apiKey },
  });
  return (json(res).conversations as unknown[]).length;
}

/** Every user row in a conversation — what the transcript actually recorded. */
async function userRows(conversationId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `select content from conversation_messages
      where conversation_id = $1 and role = 'user' order by created_at`,
    [conversationId],
  );
  return rows.map((r: { content: string }) => r.content);
}

/** THE holding lines shipped into a conversation (raw.pausedHold on the reply). */
async function holdingLines(
  conversationId: string,
): Promise<Array<{ content: string; raw: Record<string, unknown> }>> {
  const { rows } = await pool.query(
    `select content, raw from conversation_messages
      where conversation_id = $1 and role = 'agent' and raw->'pausedHold' is not null
      order by created_at`,
    [conversationId],
  );
  return rows;
}

/** The kill-switch's breadcrumbs for a conversation, oldest first. */
async function holdBreadcrumbs(
  conversationId: string,
): Promise<Array<{ content: string; raw: { pausedHold: Record<string, unknown> } }>> {
  const { rows } = await pool.query(
    `select content, raw from conversation_messages
      where conversation_id = $1 and role = 'system' and raw->'pausedHold' is not null
      order by created_at`,
    [conversationId],
  );
  return rows;
}

/** Every agent reply, finished ones only (the A8 predicate, reused). */
async function replies(conversationId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `select content from conversation_messages
      where conversation_id = $1 and role = 'agent'
        and (raw->'usage' is not null or raw->'trace' is not null
             or raw->'platformNote' is not null or raw->'operator' is not null)
      order by created_at`,
    [conversationId],
  );
  return rows.map((r: { content: string }) => r.content);
}

async function createManagedAgent(identifier: string, name: string): Promise<void> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier,
      name,
      runtime: 'managed',
      model: MODEL,
      systemPrompt: 'You are the Acme support agent. Be brief.',
      llm: { apiKey: 'zai-test-key-123456', baseUrl: llmBaseUrl },
    },
  });
  expect(res.statusCode, `create ${identifier}`).toBe(201);
}

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;
  await startBridgeStub();
  bridgeUrl = `http://127.0.0.1:${(bridgeStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `killswitch-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Sam Operator',
      email,
      password: 'integration-pw-1',
      organizationName: 'Kill Switch IT Org',
    },
  });
  const body = json(signup);
  accessToken = body.accessToken;
  const dev = body.environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  await createManagedAgent('ks-agent', 'Kill Switch Agent');
  await createManagedAgent('ks-door', 'Kill Switch Door Agent');

  const bridge = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: { identifier: 'ks-bridge', name: 'Kill Switch Bridge', runtime: 'bridge', bridgeUrl },
  });
  expect(bridge.statusCode).toBe(201);

  // A two-turn scenario for property 14 — the run an operator would use to
  // verify a fix BEFORE resuming.
  await app.inject({
    method: 'POST',
    url: '/v1/agents/ks-agent/evals',
    headers: { 'x-api-key': apiKey },
    payload: {
      name: 'two-turns',
      scenario: {
        turns: [
          { user: 'first question' },
          { expect: { replyContains: 'echo' } },
          { user: 'second question' },
          { expect: { replyContains: 'echo' } },
        ],
      },
    },
  });

  convWorker = new Worker(
    QUEUE.CONVERSATION,
    async (job: Job) => processConversation(job as Job<ConversationJobData>),
    { connection: createRedis(), concurrency: 1 },
  );
});

afterAll(async () => {
  await convWorker?.close();
  try {
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await pool.query('delete from agents where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
    await getQueue(QUEUE.CONVERSATION).obliterate({ force: true });
  } catch {
    /* best-effort */
  }
  llmStub?.close();
  bridgeStub?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

// ---- 1. off = unchanged -----------------------------------------------------

describe('A10: a live agent is byte-identical to a pre-A10 agent', TURN_TIMEOUT, () => {
  test('a normal turn answers, leaves no hold rows, and stays active', async () => {
    const before = llmHits;
    const sent = await sendAndSettle('ks-agent', 'ks-live', 'hello there', 'ks-live-1');

    expect(llmHits).toBe(before + 1);
    expect(await replies(sent.conversationId)).toEqual(['echo(hello there)']);
    expect(await holdingLines(sent.conversationId)).toHaveLength(0);
    expect(await holdBreadcrumbs(sent.conversationId)).toHaveLength(0);
    expect(await conversationStatus(sent.conversationId)).toBe('active');
  });

  test('the agent view reports pausedAt: null while live', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/ks-agent',
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.pausedAt).toBeNull();
    // The pause is a SIBLING of the status, not a value inside it.
    expect(json(res).agent.status).toBe('active');
  });
});

// ---- 2. the button ----------------------------------------------------------

describe('A10: the pause/resume API', TURN_TIMEOUT, () => {
  test('pause stamps a timestamp and leaves the status alone', async () => {
    const res = await pauseAgent('ks-agent');
    expect(res.statusCode).toBe(200);
    const agent = json(res).agent as { pausedAt: string | null; status: string };
    expect(agent.pausedAt).toBeTruthy();
    expect(Number.isNaN(Date.parse(agent.pausedAt as string))).toBe(false);
    // Paused is not disabled: the door is still open.
    expect(agent.status).toBe('active');
  });

  test('pausing a paused agent is a 200 no-op — an emergency button never errors on a double-press', async () => {
    const again = await pauseAgent('ks-agent');
    expect(again.statusCode).toBe(200);
    expect(json(again).agent.pausedAt).toBeTruthy();
  });

  test('pause and resume 404 on an unknown agent', async () => {
    expect((await pauseAgent('ks-nope')).statusCode).toBe(404);
    expect((await resumeAgent('ks-nope')).statusCode).toBe(404);
  });
});

// ---- 3-9. the hold, on one conversation, end to end -------------------------

describe('A10: the hold lifecycle on one conversation', TURN_TIMEOUT, () => {
  let conversationId = '';

  test('(a) the first message lands, runs NOTHING, is answered once, and goes to the queue', async () => {
    const before = llmHits;
    const sent = await sendAndSettle('ks-agent', 'ks-hold', 'my order is wrong', 'ks-hold-1');
    conversationId = sent.conversationId;

    // The door stayed open and the record stayed truthful.
    expect(await userRows(conversationId)).toEqual(['my order is wrong']);
    // Not one byte reached a model.
    expect(llmHits).toBe(before);

    // The holding line, VERBATIM, once.
    const held = await holdingLines(conversationId);
    expect(held).toHaveLength(1);
    expect(held[0].content).toBe(HOLDING_LINE);
    // Tagged so buildHistory never replays it as the model's own words — an
    // agent that learned to imitate this would hand off conversations nobody
    // handed off.
    expect(held[0].raw.platformNote).toBe(true);
    expect(held[0].raw.pausedHold).toBe(true);

    // The breadcrumb: a NAMED key, never raw.action.
    const crumbs = await holdBreadcrumbs(conversationId);
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].raw.pausedHold.notice).toBe(true);
    expect(crumbs[0].raw.pausedHold.runtime).toBe('managed');
    expect(crumbs[0].raw.pausedHold.pausedAt).toBeTruthy();
    expect(crumbs[0].content).toContain('paused');

    // And a person can see it — through the queue's own read.
    expect(await conversationStatus(conversationId)).toBe('waiting_human');
    expect(await inOperatorQueue(conversationId)).toBe(true);
  });

  test('(b) a second message adds its row and nothing else — no flood of apologies', async () => {
    const before = llmHits;
    await sendAndSettle('ks-agent', 'ks-hold', 'are you there?', 'ks-hold-2');

    expect(await userRows(conversationId)).toEqual(['my order is wrong', 'are you there?']);
    expect(llmHits).toBe(before);
    // Exactly ONE holding line for the whole conversation.
    expect(await holdingLines(conversationId)).toHaveLength(1);
    expect(await conversationStatus(conversationId)).toBe('waiting_human');
    // NOTE the honest granularity: the second message is stopped by the D2
    // human-pen gate (the conversation already belongs to a person), which
    // writes its own exec line rather than a second hold breadcrumb. A second
    // breadcrumb means something specific — see (e).
    expect(await holdBreadcrumbs(conversationId)).toHaveLength(1);
  });

  test('(c) the P26 surface still works while paused: an operator replies and takes the pen', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/messages`,
      headers: { authorization: `Bearer ${accessToken}`, 'x-environment-id': tenantId },
      payload: { text: 'Hi, this is Sam — I have your order open now.', messageId: 'op-1' },
    });
    expect(res.statusCode).toBe(202);
    expect(await conversationStatus(conversationId)).toBe('human');
    expect(await replies(conversationId)).toContain('Hi, this is Sam — I have your order open now.');
  });

  test('(d) a conversation a human already owns is never transitioned twice', async () => {
    const before = llmHits;
    await sendAndSettle('ks-agent', 'ks-hold', 'thanks Sam', 'ks-hold-3');

    // The row landed, the human keeps the pen, and the platform stayed quiet.
    expect(await userRows(conversationId)).toHaveLength(3);
    expect(await conversationStatus(conversationId)).toBe('human');
    expect(llmHits).toBe(before);
    expect(await holdingLines(conversationId)).toHaveLength(1);
    expect(await holdBreadcrumbs(conversationId)).toHaveLength(1);
  });

  test('(e) handback while still paused re-holds it — a fresh breadcrumb, still no second apology', async () => {
    const back = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/handback`,
      headers: { authorization: `Bearer ${accessToken}`, 'x-environment-id': tenantId },
    });
    expect(back.statusCode).toBe(200);
    expect(await conversationStatus(conversationId)).toBe('active');

    const before = llmHits;
    await sendAndSettle('ks-agent', 'ks-hold', 'one more thing', 'ks-hold-4');

    expect(llmHits).toBe(before);
    // The hold is re-asserted — the customer is NOT stranded in an active
    // conversation nobody is answering.
    expect(await conversationStatus(conversationId)).toBe('waiting_human');
    expect(await inOperatorQueue(conversationId)).toBe(true);
    // A second breadcrumb, because this really is a second hold episode...
    const crumbs = await holdBreadcrumbs(conversationId);
    expect(crumbs).toHaveLength(2);
    expect(crumbs[1].raw.pausedHold.notice).toBe(false);
    // ...but still exactly one holding line, ever, for this conversation.
    expect(await holdingLines(conversationId)).toHaveLength(1);
  });
});

// ---- 10. resume -------------------------------------------------------------

describe('A10: resume', TURN_TIMEOUT, () => {
  test('the very next message runs an ordinary turn again', async () => {
    const res = await resumeAgent('ks-agent');
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.pausedAt).toBeNull();

    const before = llmHits;
    const sent = await sendAndSettle('ks-agent', 'ks-resumed', 'hello again', 'ks-resume-1');

    expect(llmHits).toBe(before + 1);
    expect(await replies(sent.conversationId)).toEqual(['echo(hello again)']);
    expect(await holdingLines(sent.conversationId)).toHaveLength(0);
    expect(await conversationStatus(sent.conversationId)).toBe('active');
  });

  test('resuming a live agent is a 200 no-op too', async () => {
    const again = await resumeAgent('ks-agent');
    expect(again.statusCode).toBe(200);
    expect(json(again).agent.pausedAt).toBeNull();
  });

  test('conversations already handed to a person STAY with them — resume is not a recall', async () => {
    // P26 semantics, unchanged and deliberately not swept: the conversation
    // held during the incident is still waiting for its human.
    expect(await operatorQueueSize('ks-agent')).toBeGreaterThan(0);
  });
});

// ---- 11. the second runtime -------------------------------------------------

describe('A10: a paused BRIDGE agent — its webhook simply stops being called', TURN_TIMEOUT, () => {
  test('live: the bridge answers', async () => {
    const before = bridgeHits;
    const sent = await sendAndSettle('ks-bridge', 'ks-bridge-sub', 'hello bridge', 'ks-br-1');
    expect(bridgeHits).toBe(before + 1);
    expect(await replies(sent.conversationId)).toEqual(['the bridge answered']);
  });

  test('paused: ZERO POSTs leave this process, and the customer still hears back once', async () => {
    expect((await pauseAgent('ks-bridge')).statusCode).toBe(200);
    const before = bridgeHits;
    const sent = await sendAndSettle('ks-bridge', 'ks-bridge-held', 'anyone home?', 'ks-br-2');

    expect(bridgeHits).toBe(before);
    expect(await userRows(sent.conversationId)).toEqual(['anyone home?']);
    const held = await holdingLines(sent.conversationId);
    expect(held).toHaveLength(1);
    expect(held[0].content).toBe(HOLDING_LINE);
    const crumbs = await holdBreadcrumbs(sent.conversationId);
    expect(crumbs[0].raw.pausedHold.runtime).toBe('bridge');
    expect(await inOperatorQueue(sent.conversationId)).toBe(true);
  });

  test('resumed: the bridge is called again', async () => {
    expect((await resumeAgent('ks-bridge')).statusCode).toBe(200);
    const before = bridgeHits;
    const sent = await sendAndSettle('ks-bridge', 'ks-bridge-back', 'hello again', 'ks-br-3');
    expect(bridgeHits).toBe(before + 1);
    expect(await replies(sent.conversationId)).toEqual(['the bridge answered']);
  });
});

// ---- 13. paused is not disabled ---------------------------------------------

describe('A10: `disabled` and `paused` stay different things', TURN_TIMEOUT, () => {
  test('a PAUSED agent still accepts messages (202); a DISABLED one still 409s', async () => {
    expect((await pauseAgent('ks-door')).statusCode).toBe(200);

    // Paused: the door is open. The customer is heard even though nobody
    // answers — which is the entire reason this is a timestamp and not a third
    // status value.
    const whilePaused = await send('ks-door', 'ks-door-sub', 'still listening?', 'ks-door-1');
    expect(whilePaused.status).toBe(202);
    await turnDone(whilePaused.body.messageId);
    expect(await userRows(whilePaused.body.conversationId)).toEqual(['still listening?']);

    // Disabled: the door is shut, exactly as before A10.
    const off = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/ks-door',
      headers: { 'x-api-key': apiKey },
      payload: { status: 'disabled' },
    });
    expect(off.statusCode).toBe(200);
    const whileDisabled = await send('ks-door', 'ks-door-sub', 'hello?', 'ks-door-2');
    expect(whileDisabled.status).toBe(409);
    expect(whileDisabled.body).toMatchObject({ error: 'agent is disabled' });
  });

  test('the two are reported side by side, so a client can see both at once', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/ks-door',
      headers: { 'x-api-key': apiKey },
    });
    const agent = json(res).agent as { status: string; pausedAt: string | null };
    expect(agent.status).toBe('disabled');
    expect(agent.pausedAt).toBeTruthy();
  });
});

// ---- 14. the eval driver ----------------------------------------------------

describe('A10: pause, diagnose, RUN THE EVALS, resume', TURN_TIMEOUT, () => {
  test('an eval run on a paused agent still grades the prompt and never fills the queue', async () => {
    expect((await pauseAgent('ks-agent')).statusCode).toBe(200);
    const queueBefore = await operatorQueueSize('ks-agent');

    const started = await app.inject({
      method: 'POST',
      url: '/v1/agents/ks-agent/evals/run',
      headers: { 'x-api-key': apiKey },
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    const runId = json(started).runId as string;
    await processEvalRun({ data: { runId } } as Job<{ runId: string }>);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/agents/ks-agent/evals/runs/${runId}`,
      headers: { 'x-api-key': apiKey },
    });
    const run = json(after).run as { status: string; results: Array<{ passed: boolean }> };

    // Both turns got the MODEL's words, not the holding line — so the fix
    // really can be verified before the agent goes back on.
    expect(run.results.every((r) => r.passed)).toBe(true);
    expect(run.status).toBe('passed');
    // And Sam's incident queue did not fill up with robots.
    expect(await operatorQueueSize('ks-agent')).toBe(queueBefore);

    await resumeAgent('ks-agent');
  });
});

// ---- 15. the structural claim ------------------------------------------------

describe('A10: nothing at ingress reads the kill-switch', () => {
  test('`paused_at` is read in exactly three places, and none of them is a channel', () => {
    const root = join(__dirname, '..', '..', 'src');
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = join(dir, entry);
        if (statSync(full).isDirectory()) walk(full);
        else if (entry.endsWith('.ts') && /paused_at|pausedAt/.test(readFileSync(full, 'utf8'))) {
          hits.push(full.slice(root.length + 1).replace(/\\/g, '/'));
        }
      }
    };
    walk(root);

    // The whole design in one assertion. The column is DECLARED by the repo,
    // ENFORCED at the single chokepoint, and REPORTED by the agents route —
    // and it is read nowhere else, which is what guarantees a pause can never
    // turn into a 409 at the widget, at a Slack webhook, at Telegram or at
    // inbound email. A new file appearing in this list is a design change and
    // has to be argued for, not merged.
    expect(hits.sort()).toEqual(
      [
        'api/routes/agents.ts',
        'db/conversations.repo.ts',
        'workers/processors/conversation.processor.ts',
      ].sort(),
    );
  });
});
