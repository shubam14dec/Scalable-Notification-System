/**
 * Phase A6 slice B — the SURFACE of model routing: the API that configures it,
 * the stats that report on it, and the pre-save check that grades it.
 *
 * Same harness as slice A (tests/integration/model-routing.test.ts): a real app,
 * a real eval-run processor, and the real @anthropic-ai/sdk pointed at a stub
 * Messages API through the agent's llm_base_url. Only the model server is fake,
 * so what the stub RECEIVES is the proof of which model a turn actually ran on
 * — which is the only honest way to test the claim "the pre-save check exercises
 * the NEW routing config".
 *
 * The properties under test:
 *   1. PATCH/POST accept a routing config, validate it, clear it with null, and
 *      refuse it on a bridge agent; agentView carries it back.
 *   2. The stats endpoint counts a seeded window EXACTLY — canary replies and
 *      pre-A6 rows (no `routing` key at all) land in the right buckets.
 *   3. A pre-save run carrying a candidate ROUTING config really routes through
 *      it: enabling it puts the run on the cheap model, an explicit null puts it
 *      back on the strong one, and a candidate that says nothing about routing
 *      leaves slice A's law untouched.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, QUEUE } from '../../src/shared/queues';
import { createRedis, redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import { processEvalRun } from '../../src/workers/processors/eval-run.processor';

/** The agent's own model — what a turn runs on when nothing routes it. */
const STRONG_MODEL = 'strong-surface-1';
/** The tier-1 model a routed turn tries first. */
const CHEAP_MODEL = 'cheap-surface-mini';
/** An A4 candidate's model — the STRONG tier of a candidate-routed turn. */
const CANDIDATE_MODEL = 'candidate-surface-9';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let agentId = '';
let statsAgentId = '';
let subscriberId = '';
let convWorker: Worker;

// ---- stub Anthropic-compatible server (wire capture) ----
let llmStub: Server;
let llmBaseUrl = '';
interface SeenRequest {
  model: string;
  system?: Array<{ type: string; text: string }>;
  messages: Array<{ role: string; content: unknown }>;
}
const seen: SeenRequest[] = [];

const textReply = (text: string) => ({
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
      res.setHeader('content-type', 'application/json');
      // Echo the user's words back (minus the platform reminder) so the eval
      // scenario's replyContains assertion is deterministic. Nothing here ever
      // asks for a tool, so no run in this file escalates for tool reasons —
      // which is the point: the model a request lands on is the whole signal.
      const lastText = String(body.messages.at(-1)?.content ?? '').split(
        '\n\n<platform_reminder>',
      )[0];
      res.end(JSON.stringify(textReply(`echo(${lastText})`)));
    });
  });
  return new Promise((r) => llmStub.listen(0, '127.0.0.1', () => r()));
}

const json = (res: { body: string }) => JSON.parse(res.body);

const authed = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-api-key': apiKey }, ...(payload ? { payload } : {}) });

/** Read one agent back through the public view. */
async function agentView(identifier: string) {
  const res = await authed('GET', `/v1/agents/${identifier}`);
  return json(res).agent as { routing: { enabled: boolean; cheapModel: string } | null };
}

/** Write the agent's LIVE routing config straight to the row (not under test here). */
async function setRouting(routing: { enabled: boolean; cheapModel: string } | null) {
  await pool.query('update agents set routing = $2 where id = $1', [
    agentId,
    routing ? JSON.stringify(routing) : null,
  ]);
}

/** Start an eval run and drive it in-process, exactly as the A4/A6-A suites do. */
async function runEvals(payload: Record<string, unknown>) {
  const started = await authed('POST', '/v1/agents/surface-agent/evals/run', payload);
  expect(started.statusCode).toBe(202);
  const runId = json(started).runId as string;
  await processEvalRun({ data: { runId } } as Job<{ runId: string }>);
  const after = await authed('GET', `/v1/agents/surface-agent/evals/runs/${runId}`);
  return json(after).run as {
    status: string;
    candidate?: { routing?: { enabled: boolean; cheapModel: string } | null };
  };
}

/**
 * Seed ONE reply row on the stats agent. `raw` is written verbatim, so a test
 * can build a pre-A6 row (no `routing` key at all) or a canary row and see it
 * land in the bucket the SQL claims it does.
 */
async function seedReply(
  conversationId: string,
  key: string,
  raw: Record<string, unknown> | null,
  opts: { ageDays?: number; deleted?: boolean; role?: string } = {},
) {
  await pool.query(
    `insert into conversation_messages
       (conversation_id, tenant_id, role, content, dedupe_key, raw, created_at, deleted_at)
     values ($1, $2, $3, 'seeded', $4, $5::jsonb,
             now() - make_interval(days => $6), $7)`,
    [
      conversationId,
      tenantId,
      opts.role ?? 'agent',
      key,
      raw ? JSON.stringify(raw) : null,
      opts.ageDays ?? 1,
      opts.deleted ? new Date().toISOString() : null,
    ],
  );
}

const USAGE = { inputTokens: 10, outputTokens: 5 };

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `routing-surface-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Routing Surface IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Routing Surface IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  await authed('POST', '/v1/agents', {
    identifier: 'surface-agent',
    name: 'Surface Agent',
    runtime: 'managed',
    model: STRONG_MODEL,
    systemPrompt: 'You are the Acme support agent. Be brief.',
    llm: { apiKey: 'zai-test-key-123456', baseUrl: llmBaseUrl },
  });
  // A bridge agent, for the managed-only guards.
  await authed('POST', '/v1/agents', {
    identifier: 'surface-bridge',
    name: 'Surface Bridge',
    runtime: 'bridge',
    bridgeUrl: 'https://example.com/agent',
  });
  // A THIRD agent whose only traffic is the seeded stats fixture, so the
  // numbers this file asserts can be exact rather than "at least".
  await authed('POST', '/v1/agents', {
    identifier: 'stats-agent',
    name: 'Stats Agent',
    runtime: 'managed',
    model: STRONG_MODEL,
    systemPrompt: 'You are the stats agent.',
    llm: { apiKey: 'zai-test-key-123456', baseUrl: llmBaseUrl },
  });

  const { rows } = await pool.query(
    'select identifier, id from agents where tenant_id = $1 and identifier = any($2)',
    [tenantId, ['surface-agent', 'stats-agent']],
  );
  agentId = rows.find((r: { identifier: string }) => r.identifier === 'surface-agent').id;
  statsAgentId = rows.find((r: { identifier: string }) => r.identifier === 'stats-agent').id;

  await app.inject({
    method: 'PUT',
    url: '/v1/subscribers',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId: 'stats-sub', email: 'stats-sub@itest.local' },
  });
  const subs = await pool.query(
    'select id from subscribers where tenant_id = $1 and external_id = $2',
    [tenantId, 'stats-sub'],
  );
  subscriberId = subs.rows[0].id;

  await authed('POST', '/v1/agents/surface-agent/evals', {
    name: 'greeting',
    scenario: { turns: [{ user: 'hi there' }, { expect: { replyContains: 'echo' } }] },
  });

  // The production hop: a real worker services every job this file enqueues.
  convWorker = new Worker(
    QUEUE.CONVERSATION,
    async (job: Job) => processConversation(job as Job<ConversationJobData>),
    { connection: createRedis(), concurrency: 1 },
  );
});

afterAll(async () => {
  await convWorker?.close();
  llmStub?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('A6 slice B: the routing config API', () => {
  test('PATCH accepts a config and the agent view carries it back', async () => {
    const res = await authed('PATCH', '/v1/agents/surface-agent', {
      routing: { enabled: true, cheapModel: CHEAP_MODEL },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.routing).toEqual({ enabled: true, cheapModel: CHEAP_MODEL });
    expect((await agentView('surface-agent')).routing).toEqual({
      enabled: true,
      cheapModel: CHEAP_MODEL,
    });
  });

  test('switching the router OFF keeps the id that was typed', async () => {
    const res = await authed('PATCH', '/v1/agents/surface-agent', {
      routing: { enabled: false, cheapModel: CHEAP_MODEL },
    });
    expect(res.statusCode).toBe(200);
    // Off, but not forgotten — turning it back on costs no retyping, and the
    // brain reads `enabled: false` as "does not apply" either way.
    expect(json(res).agent.routing).toEqual({ enabled: false, cheapModel: CHEAP_MODEL });
  });

  test('enabled with no cheap model is a 400 — there is nothing to route to', async () => {
    const res = await authed('PATCH', '/v1/agents/surface-agent', {
      routing: { enabled: true },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(json(res))).toContain('cheapModel is required when routing is enabled');
  });

  test('an OFF config with a blank id is accepted (a form with the switch down)', async () => {
    const res = await authed('PATCH', '/v1/agents/surface-agent', {
      routing: { enabled: false, cheapModel: '' },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.routing).toEqual({ enabled: false, cheapModel: '' });
  });

  test('routing: null clears it back to never-configured', async () => {
    await authed('PATCH', '/v1/agents/surface-agent', {
      routing: { enabled: true, cheapModel: CHEAP_MODEL },
    });
    const res = await authed('PATCH', '/v1/agents/surface-agent', { routing: null });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.routing).toBeNull();
    const { rows } = await pool.query('select routing from agents where id = $1', [agentId]);
    expect(rows[0].routing).toBeNull();
  });

  test('an unrelated PATCH leaves the config untouched', async () => {
    await authed('PATCH', '/v1/agents/surface-agent', {
      routing: { enabled: true, cheapModel: CHEAP_MODEL },
    });
    const res = await authed('PATCH', '/v1/agents/surface-agent', { description: 'unrelated' });
    expect(json(res).agent.routing).toEqual({ enabled: true, cheapModel: CHEAP_MODEL });
  });

  test('a bridge agent cannot be routed — 400 on PATCH and on create', async () => {
    const patched = await authed('PATCH', '/v1/agents/surface-bridge', {
      routing: { enabled: true, cheapModel: CHEAP_MODEL },
    });
    expect(patched.statusCode).toBe(400);
    expect(json(patched).error).toContain('model routing needs a managed agent');

    const created = await authed('POST', '/v1/agents', {
      identifier: 'surface-bridge-2',
      name: 'Surface Bridge 2',
      runtime: 'bridge',
      bridgeUrl: 'https://example.com/agent',
      routing: { enabled: true, cheapModel: CHEAP_MODEL },
    });
    expect(created.statusCode).toBe(400);
  });

  test('a bridge agent may still CLEAR routing (a clear is never wrong)', async () => {
    const res = await authed('PATCH', '/v1/agents/surface-bridge', { routing: null });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.routing).toBeNull();
  });

  test('create accepts a config on a managed agent', async () => {
    const res = await authed('POST', '/v1/agents', {
      identifier: 'surface-born-routed',
      name: 'Born Routed',
      runtime: 'managed',
      model: STRONG_MODEL,
      systemPrompt: 'hi',
      llm: { apiKey: 'zai-test-key-123456', baseUrl: llmBaseUrl },
      routing: { enabled: true, cheapModel: CHEAP_MODEL },
    });
    expect(res.statusCode).toBe(201);
    expect(json(res).agent.routing).toEqual({ enabled: true, cheapModel: CHEAP_MODEL });
  });

  test('a bridge agent has no routing on its view (null, never an object)', async () => {
    expect((await agentView('surface-bridge')).routing).toBeNull();
  });
});

describe('A6 slice B: the stats count the window exactly', () => {
  test('cheap / escalated / unrouted split, with canary and stale rows excluded', async () => {
    const conv = await pool.query(
      `insert into conversations (tenant_id, agent_id, subscriber_id, thread_key)
       values ($1, $2, $3, 'stats-thread') returning id`,
      [tenantId, statsAgentId, subscriberId],
    );
    const cid = conv.rows[0].id as string;

    // IN the window and counted: 6 cheap, 2 escalated, 2 pre-A6 (no routing key).
    for (let i = 0; i < 6; i++) {
      await seedReply(cid, `cheap-${i}`, {
        usage: USAGE,
        routing: { model: CHEAP_MODEL, escalated: false },
      });
    }
    for (let i = 0; i < 2; i++) {
      await seedReply(cid, `esc-${i}`, {
        usage: USAGE,
        routing: { model: STRONG_MODEL, escalated: true, trigger: 'trigger_workflow' },
      });
    }
    for (let i = 0; i < 2; i++) {
      // A row written before A6 existed: `usage` but no `routing` key at all.
      await seedReply(cid, `pre-a6-${i}`, { usage: USAGE });
    }

    // EXCLUDED, each for its own reason:
    // a canary-trial reply (runs on the trial's own model — the router never
    // saw it, so counting it would depress the cheap share for free)…
    await seedReply(cid, 'canary-1', { usage: USAGE, canaryVersion: 3 });
    // …an operator push (no `usage`: no turn happened here)…
    await seedReply(cid, 'pushed-1', { platformNote: false });
    // …a deleted reply…
    await seedReply(
      cid,
      'deleted-1',
      { usage: USAGE, routing: { model: CHEAP_MODEL, escalated: false } },
      { deleted: true },
    );
    // …a routed reply from OUTSIDE the 7-day window…
    await seedReply(
      cid,
      'stale-1',
      { usage: USAGE, routing: { model: CHEAP_MODEL, escalated: false } },
      { ageDays: 10 },
    );
    // …and the customer's own message.
    await seedReply(cid, 'user-1', { usage: USAGE }, { role: 'user' });

    const res = await authed('GET', '/v1/agents/stats-agent/routing/stats');
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({
      windowDays: 7,
      replies: 10,
      cheapReplies: 6,
      escalatedReplies: 2,
      unroutedReplies: 2,
    });
  });

  test('an agent with no traffic reads as an honest zero', async () => {
    const res = await authed('GET', '/v1/agents/surface-born-routed/routing/stats');
    expect(json(res)).toEqual({
      windowDays: 7,
      replies: 0,
      cheapReplies: 0,
      escalatedReplies: 0,
      unroutedReplies: 0,
    });
  });

  test('stats need a managed agent', async () => {
    const res = await authed('GET', '/v1/agents/surface-bridge/routing/stats');
    expect(res.statusCode).toBe(400);
  });
});

describe('A6 slice B: the pre-save check grades the NEW router', () => {
  test('a candidate that ENABLES routing really runs the evals on the cheap model', async () => {
    // The saved agent is NOT routed. The operator is about to turn routing on,
    // and the whole point of the check is that the run answers "does it still
    // pass once the cheap model is answering?" — so the wire must show the
    // cheap model, not the agent's own.
    await setRouting(null);
    const mark = seen.length;

    const run = await runEvals({
      trigger: 'pre_save',
      candidate: { routing: { enabled: true, cheapModel: CHEAP_MODEL } },
    });
    expect(run.status).toBe('passed');

    const requests = seen.slice(mark);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r.model).toBe(CHEAP_MODEL);
    expect(requests.some((r) => r.model === STRONG_MODEL)).toBe(false);
    // …and the run row remembers what it graded, verbatim.
    expect(run.candidate?.routing).toEqual({ enabled: true, cheapModel: CHEAP_MODEL });
  }, 90_000);

  test('a candidate that DISABLES routing runs the evals on the main model', async () => {
    // The mirror image: the saved agent IS routed, the edit switches it off.
    // An explicit null is a real instruction, not a missing field.
    await setRouting({ enabled: true, cheapModel: CHEAP_MODEL });
    const mark = seen.length;

    const run = await runEvals({ trigger: 'pre_save', candidate: { routing: null } });
    expect(run.status).toBe('passed');

    const requests = seen.slice(mark);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r.model).toBe(STRONG_MODEL);
    expect(run.candidate?.routing).toBeNull();
  }, 90_000);

  test('a candidate SILENT about routing still switches the router off (slice A’s law)', async () => {
    // Byte-compat: the pre-A6-slice-B behavior is keyed on the routing field
    // being ABSENT, so a plain prompt/model candidate — every canary turn, every
    // pre-A6 pre-save check — is untouched by slice B.
    await setRouting({ enabled: true, cheapModel: CHEAP_MODEL });
    const mark = seen.length;

    const run = await runEvals({
      trigger: 'pre_save',
      candidate: { systemPrompt: 'You are the DRAFT agent.' },
    });
    expect(run.status).toBe('passed');

    const requests = seen.slice(mark);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r.model).toBe(STRONG_MODEL);
    expect(requests.some((r) => r.model === CHEAP_MODEL)).toBe(false);
  }, 90_000);

  test('a candidate model is the STRONG tier of a candidate-routed run', async () => {
    // Both knobs at once: the router the operator is enabling, on top of the
    // model edit they are making. Tier 1 is the candidate's cheap model; the
    // candidate's own model is what an escalation would land on.
    await setRouting(null);
    const mark = seen.length;

    const run = await runEvals({
      trigger: 'pre_save',
      candidate: {
        model: CANDIDATE_MODEL,
        routing: { enabled: true, cheapModel: CHEAP_MODEL },
      },
    });
    expect(run.status).toBe('passed');

    const requests = seen.slice(mark);
    expect(requests.length).toBeGreaterThan(0);
    // Nothing in this file asks for a tool, so nothing escalates: every request
    // is tier 1, and neither the agent's model nor the candidate's is dialed.
    for (const r of requests) expect(r.model).toBe(CHEAP_MODEL);
    expect(requests.some((r) => r.model === CANDIDATE_MODEL)).toBe(false);
  }, 90_000);

  test('a candidate carrying ONLY routing is still a valid candidate', async () => {
    // The refine had to grow a third clause; an empty object stays a 400.
    const empty = await authed('POST', '/v1/agents/surface-agent/evals/run', {
      trigger: 'pre_save',
      candidate: {},
    });
    expect(empty.statusCode).toBe(400);

    const routingOnly = await authed('POST', '/v1/agents/surface-agent/evals/run', {
      trigger: 'pre_save',
      candidate: { routing: null },
    });
    expect(routingOnly.statusCode).toBe(202);
  });

  test('a candidate routing config on a bridge agent is a 400', async () => {
    const res = await authed('POST', '/v1/agents/surface-bridge/evals/run', {
      trigger: 'pre_save',
      candidate: { routing: { enabled: true, cheapModel: CHEAP_MODEL } },
    });
    expect(res.statusCode).toBe(400);
  });
});
