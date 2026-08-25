/**
 * Phase A8 — PER-CUSTOMER MESSAGE LIMITS, driven through the real path.
 *
 * Real app, real queue, real conversation worker, real @anthropic-ai/sdk pointed
 * (via the agent's llm_base_url) at a stub Messages API — only the model server
 * is fake, so what the stub RECEIVES is the proof of what reached a model. A
 * real bridge stub plays the second runtime's customer code for the same reason.
 *
 * The properties under test are the limit's whole contract:
 *   1. off = byte-identical to a pre-A8 agent;
 *   2. N messages pass, N+1 is throttled — no model call, no bridge call, and
 *      the operator's notice ships VERBATIM;
 *   3. N+2..N+k: the rows still land in the transcript (the record stays
 *      truthful) but nothing else happens — no second notice, no turns;
 *   4. the limit is PER CUSTOMER: another subscriber flows freely at the same
 *      moment, which is the entire reason this phase exists;
 *   5. the window resets;
 *   6. BOTH runtimes — this is ingress protection, not brain config;
 *   7. eval-driver turns are immune under an active limit;
 *   8. a broken Redis SKIPS the check with a warn and never throttles anyone;
 *   9. button/card taps count — a tap flood is still a flood;
 *  10. operator/proactive messages are neither counted nor throttled;
 *  11. the breadcrumb and the ops alert say who and how much, never WHAT.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, getQueue, QUEUE } from '../../src/shared/queues';
import { createRedis, redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { logger } from '../../src/shared/logger';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import { processEvalRun } from '../../src/workers/processors/eval-run.processor';

/**
 * The ONE seam this file fakes, and only for property 8: the counter's Redis
 * call. Everything else — the queue, the worker, the database, the counters
 * themselves — is real. `vi.hoisted` because a `vi.mock` factory is hoisted
 * above the imports and cannot close over an ordinary module-scope `let`.
 */
const fault = vi.hoisted(() => ({ redisDown: false }));
vi.mock('../../src/shared/agent-counters', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/shared/agent-counters')>();
  return {
    ...actual,
    incrSubscriberInbound: async (
      ...args: Parameters<typeof actual.incrSubscriberInbound>
    ): Promise<number> => {
      if (fault.redisDown) throw new Error('simulated redis outage');
      return actual.incrSubscriberInbound(...args);
    },
  };
});

const MODEL = 'strong-model-1';
const NOTICE =
  "You're sending messages faster than I can answer them — I'll catch up shortly, no need to resend.";
/** Deliberately distinctive: property 11 asserts it never reaches the ops alert. */
const FLOOD_TEXT = 'FLOODTEXT-please-refund-card-4242-4242';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let agentId = '';
let bridgeAgentId = '';
let convWorker: Worker;

// ---- stub Anthropic-compatible server (wire capture) ------------------------
let llmStub: Server;
let llmBaseUrl = '';
interface SeenRequest {
  model: string;
  messages: Array<{ role: string; content: string }>;
}
const seen: SeenRequest[] = [];

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
      const body = JSON.parse(raw) as SeenRequest;
      seen.push(body);
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

/** Write the limit the way slice B's API will (null = no policy row). */
async function setRate(rate: Record<string, unknown> | null, identifier = 'rate-agent') {
  await pool.query('update agents set subscriber_rate = $2 where tenant_id = $1 and identifier = $3', [
    tenantId,
    rate ? JSON.stringify(rate) : null,
    identifier,
  ]);
}

const FINISHED_REPLY_RAW = `(raw->'usage' is not null or raw->'trace' is not null
                             or raw->'platformNote' is not null)`;

/** Every FINISHED agent reply in a conversation, oldest first. */
async function replies(
  conversationId: string,
): Promise<Array<{ content: string; raw: Record<string, unknown> }>> {
  const { rows } = await pool.query(
    `select content, raw from conversation_messages
      where conversation_id = $1 and role = 'agent' and ${FINISHED_REPLY_RAW}
      order by created_at`,
    [conversationId],
  );
  return rows;
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

/** The limiter's breadcrumbs for a conversation, oldest first. */
async function rateBreadcrumbs(
  conversationId: string,
): Promise<Array<{ content: string; raw: Record<string, unknown> }>> {
  const { rows } = await pool.query(
    `select content, raw from conversation_messages
      where conversation_id = $1 and role = 'system' and raw->'rateLimit' is not null
      order by created_at`,
    [conversationId],
  );
  return rows;
}

async function send(identifier: string, subscriberId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  return json(res) as { conversationId: string; messageId: string };
}

async function tapAction(identifier: string, subscriberId: string, actionEventId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/actions`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, actionId: 'refund-yes', label: 'Yes, refund it', actionEventId },
  });
  return json(res) as { conversationId: string; messageId: string };
}

/**
 * Wait for THE TURN JOB ITSELF to finish, not for a reply to appear.
 *
 * This is the assertion tool the phase needs and the older gate suites did not:
 * a throttled message produces NO reply at all, so "wait until a row shows up"
 * cannot distinguish "suppressed correctly" from "still in the queue". Waiting
 * on the job's own terminal state makes the negative assertions below honest.
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

/** Send one message and wait for its turn to be fully over, whatever happened. */
async function sendAndSettle(
  identifier: string,
  subscriberId: string,
  text: string,
  messageId: string,
) {
  const sent = await send(identifier, subscriberId, text, messageId);
  await turnDone(sent.messageId);
  return sent;
}

async function createManagedAgent(identifier: string, name: string): Promise<string> {
  await app.inject({
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
  const { rows } = await pool.query('select id from agents where tenant_id = $1 and identifier = $2', [
    tenantId,
    identifier,
  ]);
  return rows[0].id;
}

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;
  await startBridgeStub();
  bridgeUrl = `http://127.0.0.1:${(bridgeStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `rate-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Rate IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Rate IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  agentId = await createManagedAgent('rate-agent', 'Rate Agent');

  await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: { identifier: 'rate-bridge', name: 'Rate Bridge', runtime: 'bridge', bridgeUrl },
  });
  const bridgeRow = await pool.query(
    'select id from agents where tenant_id = $1 and identifier = $2',
    [tenantId, 'rate-bridge'],
  );
  bridgeAgentId = bridgeRow.rows[0].id;

  // Two USER turns from one synthetic subscriber — i.e. exactly the burst a
  // tight limit would throttle if the driver were not exempt.
  await app.inject({
    method: 'POST',
    url: '/v1/agents/rate-agent/evals',
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

  // The reserved ops-notification workflow + audience (the P22 opt-in pair).
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
  await pool.query(
    "insert into subscribers (tenant_id, external_id, email) values ($1, 'approvals', 'ops@example.com')",
    [tenantId],
  );

  convWorker = new Worker(
    QUEUE.CONVERSATION,
    async (job: Job) => processConversation(job as Job<ConversationJobData>),
    { connection: createRedis(), concurrency: 1 },
  );
});

afterAll(async () => {
  await convWorker?.close();
  try {
    for (const id of [agentId, bridgeAgentId]) {
      const keys = await redis.keys(`*${id}*`);
      if (keys.length > 0) await redis.del(...keys);
    }
    const txnKeys = await redis.keys(`txn:${tenantId}:*`);
    if (txnKeys.length > 0) await redis.del(...txnKeys);
  } catch {
    /* best-effort cleanup */
  }
  llmStub?.close();
  bridgeStub?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

beforeEach(async () => {
  fault.redisDown = false;
  vi.restoreAllMocks();
  // Each test is its own window: clear this agent's counters, notice claims and
  // alert debounces so a five-minute bucket can't leak between tests (or, for
  // the hourly alert claim, between runs inside the same hour).
  for (const id of [agentId, bridgeAgentId]) {
    const keys = await redis.keys(`*${id}*`);
    if (keys.length > 0) await redis.del(...keys);
  }
  await setRate(null);
  await setRate(null, 'rate-bridge');
});

// ---- 1. off ------------------------------------------------------------------

describe('A8: an agent with no limit behaves exactly as it did before A8', TURN_TIMEOUT, () => {
  test('five messages in a second all get real replies, and nothing is written', async () => {
    const mark = seen.length;

    let conversationId = '';
    for (let i = 1; i <= 5; i += 1) {
      const sent = await sendAndSettle('rate-agent', 'off-1', `message ${i}`, `off-1-${i}`);
      conversationId = sent.conversationId;
    }

    const got = await replies(conversationId);
    expect(got).toHaveLength(5);
    // The MODEL answered every one of them.
    expect(got.every((r) => r.content.startsWith('echo('))).toBe(true);
    expect(seen.slice(mark).length).toBeGreaterThanOrEqual(5);
    // Byte-identical: no platform tag, no breadcrumb, no trace of a limiter.
    expect(got.every((r) => r.raw.platformNote === undefined)).toBe(true);
    expect(await rateBreadcrumbs(conversationId)).toHaveLength(0);
  });
});

// ---- 2-3. the limit, the notice, the silence ---------------------------------

describe('A8: N pass, N+1 is throttled, and the notice ships once', TURN_TIMEOUT, () => {
  test('the first three answer; the fourth gets the notice and NO model call', async () => {
    await setRate({ maxMessages: 3, windowMinutes: 5, notice: NOTICE });

    let conversationId = '';
    for (let i = 1; i <= 3; i += 1) {
      const sent = await sendAndSettle('rate-agent', 'lim-1', `question ${i}`, `lim-1-${i}`);
      conversationId = sent.conversationId;
    }
    expect(await replies(conversationId)).toHaveLength(3);

    // THE FOURTH. Mark the wire here so the assertion is about this message only.
    const mark = seen.length;
    await sendAndSettle('rate-agent', 'lim-1', FLOOD_TEXT, 'lim-1-4');

    // NOTHING reached a model — not the brain, not a classifier, not a tool.
    // This is the property the whole phase is for: a throttled turn is cheap.
    expect(seen.slice(mark)).toHaveLength(0);

    const got = await replies(conversationId);
    expect(got).toHaveLength(4);
    // The operator's sentence, VERBATIM — never a model paraphrase of it.
    expect(got[3].content).toBe(NOTICE);
    // Platform-authored, so buildHistory never replays it as an assistant turn:
    // an agent that learned to imitate its own throttle notice would start
    // telling unthrottled customers to slow down (the budget-note parroting
    // lesson, §13).
    expect(got[3].raw.platformNote).toBe(true);
  });

  test('the 5th and 6th land in the transcript but get nothing — no second notice', async () => {
    await setRate({ maxMessages: 3, windowMinutes: 5, notice: NOTICE });

    let conversationId = '';
    for (let i = 1; i <= 4; i += 1) {
      const sent = await sendAndSettle('rate-agent', 'lim-2', `question ${i}`, `lim-2-${i}`);
      conversationId = sent.conversationId;
    }
    expect(await replies(conversationId)).toHaveLength(4); // 3 answers + the notice

    const mark = seen.length;
    await sendAndSettle('rate-agent', 'lim-2', 'let me in', 'lim-2-5');
    await sendAndSettle('rate-agent', 'lim-2', 'hello?', 'lim-2-6');

    // THE RECORD STAYS TRUTHFUL: every message the customer sent is in the
    // transcript, including the ones nobody answered. An operator reading this
    // thread later sees what actually happened rather than a gap.
    expect(await userRows(conversationId)).toEqual([
      'question 1',
      'question 2',
      'question 3',
      'question 4',
      'let me in',
      'hello?',
    ]);
    // And nothing else happened: no turns, no model calls, and — the point of
    // the once-per-window claim — no second notice. A limit that re-explained
    // itself on every message would be a second flood aimed back at the customer.
    expect(seen.slice(mark)).toHaveLength(0);
    expect(await replies(conversationId)).toHaveLength(4);
  });

  test('one breadcrumb per window records WHY, and it is not raw.action', async () => {
    await setRate({ maxMessages: 2, windowMinutes: 5, notice: NOTICE });

    let conversationId = '';
    for (let i = 1; i <= 5; i += 1) {
      const sent = await sendAndSettle('rate-agent', 'crumb-1', `q${i}`, `crumb-1-${i}`);
      conversationId = sent.conversationId;
    }

    const crumbs = await rateBreadcrumbs(conversationId);
    // ONE, not three: the 2nd..kth suppressed messages write nothing, because
    // their rows already record that they arrived and a breadcrumb per message
    // would turn a flood in the conversation into the same flood in the Turn
    // Inspector.
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].raw.rateLimit).toEqual({
      maxMessages: 2,
      windowMinutes: 5,
      count: 3,
      blocked: true,
    });
    // NOT the tool-breadcrumb shape: an action row replays to the model as a
    // tool call, which would teach the agent a tool it does not have.
    expect(crumbs[0].raw.action).toBeUndefined();
  });
});

// ---- 4. per CUSTOMER ---------------------------------------------------------

describe('A8: the limit is one customer’s, not the agent’s', TURN_TIMEOUT, () => {
  test('a second subscriber flows freely while the first is throttled', async () => {
    await setRate({ maxMessages: 2, windowMinutes: 5, notice: NOTICE });

    let floodConv = '';
    for (let i = 1; i <= 4; i += 1) {
      const sent = await sendAndSettle('rate-agent', 'noisy', `spam ${i}`, `noisy-${i}`);
      floodConv = sent.conversationId;
    }
    expect((await replies(floodConv)).at(-1)!.content).toBe(NOTICE);

    // AT THE SAME MOMENT, with the noisy subscriber still inside their closed
    // window, an ordinary customer asks an ordinary question. THIS is the whole
    // phase: leaning on the day budget instead would have let one person mute
    // the agent for everyone.
    const quiet = await sendAndSettle('rate-agent', 'quiet', 'where is my order', 'quiet-1');
    const got = await replies(quiet.conversationId);
    expect(got).toHaveLength(1);
    expect(got[0].content).toBe('echo(where is my order)');
    expect(got[0].raw.platformNote).toBeUndefined();
  });

  test('the window resets and the same customer is served again', async () => {
    await setRate({ maxMessages: 2, windowMinutes: 5, notice: NOTICE });

    let conversationId = '';
    for (let i = 1; i <= 3; i += 1) {
      const sent = await sendAndSettle('rate-agent', 'reset-1', `q${i}`, `reset-1-${i}`);
      conversationId = sent.conversationId;
    }
    expect((await replies(conversationId)).at(-1)!.content).toBe(NOTICE);

    // ROLL THE WINDOW. In production the bucket self-evicts on its TTL (asserted
    // in the unit suite) and the next message lands on a key that does not exist
    // yet; dropping this agent's keys reproduces that exact state without
    // sleeping a whole window out inside the suite.
    const keys = await redis.keys(`*${agentId}*`);
    if (keys.length > 0) await redis.del(...keys);

    const after = await sendAndSettle('rate-agent', 'reset-1', 'still there?', 'reset-1-4');
    const got = await replies(after.conversationId);
    expect(got).toHaveLength(4);
    expect(got[3].content).toBe('echo(still there?)');
  });
});

// ---- 6. both runtimes --------------------------------------------------------

describe('A8: ingress protection, so BOTH runtimes are limited', TURN_TIMEOUT, () => {
  test('a bridge agent throttles too, and its own service is never called', async () => {
    await setRate({ maxMessages: 2, windowMinutes: 5, notice: NOTICE }, 'rate-bridge');

    let conversationId = '';
    for (let i = 1; i <= 2; i += 1) {
      const sent = await sendAndSettle('rate-bridge', 'br-1', `q${i}`, `br-1-${i}`);
      conversationId = sent.conversationId;
    }
    expect(await replies(conversationId)).toHaveLength(2);

    const hitsBefore = bridgeHits;
    await sendAndSettle('rate-bridge', 'br-1', FLOOD_TEXT, 'br-1-3');

    // The customer's OWN service was never POSTed. Unlike every A5-A7 knob, this
    // one applies to a bridge agent — a flood costs them their compute and their
    // bill, and declining to protect it would be a courtesy nobody asked for.
    expect(bridgeHits).toBe(hitsBefore);
    const got = await replies(conversationId);
    expect(got).toHaveLength(3);
    expect(got[2].content).toBe(NOTICE);
    expect(got[2].raw.platformNote).toBe(true);
  });
});

// ---- 7. the eval driver ------------------------------------------------------

describe('A8: an eval run grades the prompt, never the limiter', TURN_TIMEOUT, () => {
  test('a two-turn scenario passes under a limit of ONE message per window', async () => {
    // Tight enough that turn 2 would be throttled if the driver were not exempt
    // — and it would fail as a mysterious canned notice where an echo belonged.
    await setRate({ maxMessages: 1, windowMinutes: 5, notice: NOTICE });

    const started = await app.inject({
      method: 'POST',
      url: '/v1/agents/rate-agent/evals/run',
      headers: { 'x-api-key': apiKey },
      payload: {},
    });
    expect(started.statusCode).toBe(202);
    const runId = json(started).runId as string;
    await processEvalRun({ data: { runId } } as Job<{ runId: string }>);

    const after = await app.inject({
      method: 'GET',
      url: `/v1/agents/rate-agent/evals/runs/${runId}`,
      headers: { 'x-api-key': apiKey },
    });
    const run = json(after).run as {
      status: string;
      results: Array<{ name: string; passed: boolean; failures: string[] }>;
    };

    // Both turns got the MODEL's words, so the second one was never throttled.
    expect(run.results.every((r) => r.passed)).toBe(true);
    expect(run.status).toBe('passed');
  });
});

// ---- 8. degrade never block --------------------------------------------------

describe('A8: a broken limiter must not throttle or mute anyone', TURN_TIMEOUT, () => {
  test('Redis down → the check is skipped with a warn and the turn runs', async () => {
    await setRate({ maxMessages: 1, windowMinutes: 5, notice: NOTICE });
    const warn = vi.spyOn(logger, 'warn');
    fault.redisDown = true;

    // Well past the cap. Every one of them still gets a real answer.
    let conversationId = '';
    for (let i = 1; i <= 4; i += 1) {
      const sent = await sendAndSettle('rate-agent', 'down-1', `q${i}`, `down-1-${i}`);
      conversationId = sent.conversationId;
    }

    const got = await replies(conversationId);
    expect(got).toHaveLength(4);
    expect(got.every((r) => r.content.startsWith('echo('))).toBe(true);
    expect(await rateBreadcrumbs(conversationId)).toHaveLength(0);

    // NOTE THE ASYMMETRY, and why it is the right way round: for the A7 gates,
    // failing open lets an unchecked reply through. For a LIMITER, failing open
    // simply does not limit — which is what every agent did before A8. Failing
    // closed would turn a counter's hiccup into a platform outage that muted
    // every customer of every limited agent.
    expect(
      warn.mock.calls.some((c) => JSON.stringify(c).includes('subscriber rate check unavailable')),
    ).toBe(true);
  });
});

// ---- 9. taps -----------------------------------------------------------------

describe('A8: a tap flood is still a flood', TURN_TIMEOUT, () => {
  test('button/card taps count against the limit and are throttled', async () => {
    await setRate({ maxMessages: 1, windowMinutes: 5, notice: NOTICE });

    const first = await sendAndSettle('rate-agent', 'tap-1', 'hello', 'tap-1-1');
    expect(await replies(first.conversationId)).toHaveLength(1);

    const mark = seen.length;
    // A tap is a user row carrying raw.action and it enqueues a turn exactly
    // like a typed message — so exempting taps would have left the cheapest way
    // to abuse an agent as the only unlimited one.
    const tapped = await tapAction('rate-agent', 'tap-1', 'tap-1-evt-2');
    await turnDone(tapped.messageId);

    expect(seen.slice(mark)).toHaveLength(0);
    const got = await replies(first.conversationId);
    expect(got).toHaveLength(2);
    expect(got[1].content).toBe(NOTICE);
  });

  test('a tap consumes allowance, proving it was counted and not merely blocked', async () => {
    await setRate({ maxMessages: 2, windowMinutes: 5, notice: NOTICE });

    const tapped = await tapAction('rate-agent', 'tap-2', 'tap-2-evt-1');
    await turnDone(tapped.messageId);
    await sendAndSettle('rate-agent', 'tap-2', 'and also this', 'tap-2-2');
    // Two used up by a tap and a message; the third is over.
    await sendAndSettle('rate-agent', 'tap-2', 'one more', 'tap-2-3');

    const got = await replies(tapped.conversationId);
    expect(got).toHaveLength(3);
    expect(got[2].content).toBe(NOTICE);
  });
});

// ---- 10. operator and proactive ---------------------------------------------

describe('A8: this limits the CUSTOMER’s inbound and nothing else', TURN_TIMEOUT, () => {
  test('proactive pushes are neither counted nor throttled', async () => {
    await setRate({ maxMessages: 2, windowMinutes: 5, notice: NOTICE });

    const first = await sendAndSettle('rate-agent', 'ops-1', 'hello', 'ops-1-1');
    const { conversationId } = first;

    // Three platform-authored pushes. If these were counted, the customer's
    // NEXT message would be throttled — so the assertion after them is the proof.
    for (let i = 1; i <= 3; i += 1) {
      const pushed = await app.inject({
        method: 'POST',
        url: `/v1/conversations/${conversationId}/messages`,
        headers: { 'x-api-key': apiKey },
        payload: { text: `an update for you (${i})`, messageId: `ops-push-${i}` },
      });
      expect(pushed.statusCode).toBe(202);
    }

    // The customer's SECOND message — still inside a cap of two — is answered
    // by the model, so the three pushes consumed none of their allowance.
    await sendAndSettle('rate-agent', 'ops-1', 'thanks, one question', 'ops-1-2');
    const got = await replies(conversationId);
    expect(got.some((r) => r.content === 'echo(thanks, one question)')).toBe(true);
    expect(got.some((r) => r.content === NOTICE)).toBe(false);
  });

  test('a push still reaches a throttled customer', async () => {
    await setRate({ maxMessages: 1, windowMinutes: 5, notice: NOTICE });

    const first = await sendAndSettle('rate-agent', 'ops-2', 'hello', 'ops-2-1');
    await sendAndSettle('rate-agent', 'ops-2', FLOOD_TEXT, 'ops-2-2');
    const { conversationId } = first;
    expect((await replies(conversationId)).some((r) => r.content === NOTICE)).toBe(true);

    // Operator/proactive traffic is kind:'deliver' and is routed to
    // processDeliver before processTurn is ever entered — so it is excluded
    // structurally, not by a list somebody has to maintain. It matters because
    // being throttled is exactly when a human tends to step in.
    const pushed = await app.inject({
      method: 'POST',
      url: `/v1/conversations/${conversationId}/messages`,
      headers: { 'x-api-key': apiKey },
      payload: { text: 'a teammate here — let me help', messageId: 'ops-2-push' },
    });
    expect(pushed.statusCode).toBe(202);

    await waitFor(async () => {
      const { rows } = await pool.query(
        `select 1 from conversation_messages where conversation_id = $1 and content = $2`,
        [conversationId, 'a teammate here — let me help'],
      );
      return rows.length > 0;
    });
  });
});

// ---- 11. the ops alert -------------------------------------------------------

describe('A8: the ops alert says WHO and HOW MUCH, never WHAT', TURN_TIMEOUT, () => {
  test('the reserved audience is told, and the payload carries no message content', async () => {
    await setRate({ maxMessages: 1, windowMinutes: 5, notice: NOTICE });

    await sendAndSettle('rate-agent', 'alert-1', 'hello', 'alert-1-1');
    const over = await sendAndSettle('rate-agent', 'alert-1', FLOOD_TEXT, 'alert-1-2');

    const evt = await pool.query<{
      recipients: Array<{ subscriberId: string }>;
      payload: Record<string, unknown>;
    }>('select recipients, payload from events where tenant_id = $1 and transaction_id = $2', [
      tenantId,
      `subscriber-rate-alert-${over.messageId}`,
    ]);
    expect(evt.rows).toHaveLength(1);
    expect(evt.rows[0].recipients.map((r) => r.subscriberId)).toEqual(['approvals']);
    expect(evt.rows[0].payload).toEqual({
      agentIdentifier: 'rate-agent',
      subscriberExternalId: 'alert-1',
      conversationId: over.conversationId,
      maxMessages: 1,
      windowMinutes: 5,
      // This hour's count is always 1 when the alert fires and would say
      // nothing; the hour BEFORE separates a double-tap from an all-morning
      // hammering. A fresh flood's previous hour is honestly zero.
      suppressedPreviousHour: 0,
    });

    // NOT ONE CHARACTER OF WHAT THEY SAID. This alert is delivered by a workflow
    // the TENANT wrote, whose steps can email or SMS it anywhere — and a flood is
    // often someone upset, so its content is frequently the most sensitive thing
    // they have said. Ops gets enough to act and nothing to be indiscreet with.
    expect(JSON.stringify(evt.rows[0].payload)).not.toContain(FLOOD_TEXT);
    expect(JSON.stringify(evt.rows[0].payload)).not.toContain('4242');
  });

  test('a second flood in the same hour is debounced', async () => {
    await setRate({ maxMessages: 1, windowMinutes: 5, notice: NOTICE });

    await sendAndSettle('rate-agent', 'alert-2', 'hello', 'alert-2-1');
    await sendAndSettle('rate-agent', 'alert-2', 'spam a', 'alert-2-2');

    // Roll the WINDOW (not the hourly alert claim) so a second notice is due.
    const windowKeys = await redis.keys(`subrate:${agentId}:*`);
    const noticeKeys = await redis.keys(`subrate-notice:*${agentId}*`);
    const stale = [...windowKeys, ...noticeKeys];
    if (stale.length > 0) await redis.del(...stale);

    await sendAndSettle('rate-agent', 'alert-2', 'hello again', 'alert-2-3');
    const again = await sendAndSettle('rate-agent', 'alert-2', 'spam b', 'alert-2-4');

    // A second notice DID ship (a new window earns a new explanation)...
    const got = await replies(again.conversationId);
    expect(got.filter((r) => r.content === NOTICE)).toHaveLength(2);

    // ...but ops was not told twice. Nothing is lost: every window's first
    // suppression writes its own durable breadcrumb, which is the record — the
    // alert is only the nudge to go and read it.
    const evt = await pool.query(
      'select 1 from events where tenant_id = $1 and transaction_id = $2',
      [tenantId, `subscriber-rate-alert-${again.messageId}`],
    );
    expect(evt.rows).toHaveLength(0);
  });

  test('a different subscriber flooding the same agent still alerts', async () => {
    await setRate({ maxMessages: 1, windowMinutes: 5, notice: NOTICE });

    await sendAndSettle('rate-agent', 'alert-3', 'hello', 'alert-3-1');
    await sendAndSettle('rate-agent', 'alert-3', 'spam', 'alert-3-2');

    await sendAndSettle('rate-agent', 'alert-4', 'hello', 'alert-4-1');
    const other = await sendAndSettle('rate-agent', 'alert-4', 'spam', 'alert-4-2');

    // The debounce is per (agent, SUBSCRIBER), deliberately unlike reply-rules'
    // per-agent one: this alert names a specific end user as the source, so an
    // agent-wide debounce would hide the hour's second and third offender behind
    // the first — and "which customer" is the entire actionable content.
    const evt = await pool.query<{ payload: { subscriberExternalId: string } }>(
      'select payload from events where tenant_id = $1 and transaction_id = $2',
      [tenantId, `subscriber-rate-alert-${other.messageId}`],
    );
    expect(evt.rows).toHaveLength(1);
    expect(evt.rows[0].payload.subscriberExternalId).toBe('alert-4');
  });
});
