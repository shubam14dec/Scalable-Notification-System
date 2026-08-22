/**
 * Phase A6 slice A — CHEAP-FIRST model routing, driven through the real path.
 *
 * Real app, real queue, real conversation worker, real @anthropic-ai/sdk pointed
 * (via the agent's llm_base_url) at a stub Messages API — only the model server
 * is fake, so what the stub RECEIVES is the proof of what reached which model.
 *
 * The properties under test are the router's whole contract:
 *   1. a chatty turn is SERVED by the cheap model and says so on the reply row;
 *   2. a SAFE tool (resolve_conversation) keeps the turn on the cheap model and
 *      its effect really lands;
 *   3. a NON-safe tool discards the cheap attempt and re-runs the whole turn on
 *      the strong model from a byte-identical prompt — the unsafe tool executes
 *      exactly once, on the strong model;
 *   4. a MIXED safe+unsafe response executes NOTHING on the cheap path;
 *   5. a cheap-model 400 escalates instead of failing the turn;
 *   6. routing off / null / overridden by a candidate is byte-identical to
 *      pre-A6 — no cheap call on the wire, no `routing` key on the row;
 *   7. eval-driver turns route too (the driver is the real path).
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
import type { TurnRouting, TurnTrace } from '../../src/core/managed-brain';

/** The agent's own model — what a turn runs on when nothing routes it. */
const STRONG_MODEL = 'strong-model-1';
/** The tier-1 model the router tries first. */
const CHEAP_MODEL = 'cheap-model-mini';
/** An A4 candidate's model: it must beat routing (candidate > routing). */
const CANDIDATE_MODEL = 'candidate-model-9';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let agentId = '';
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
/** Scripted responses consumed FIFO; empty = the default echo reply. */
let script: unknown[] = [];
/** Model ids the endpoint does not serve — a 400, exactly like a typo'd id. */
const unknownModels = new Set<string>();

const envelope = (content: unknown[], stopReason: string, model: string) => ({
  id: 'msg_stub_1',
  type: 'message',
  role: 'assistant',
  model,
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const toolUse = (uses: Array<{ id: string; name: string; input: unknown }>) =>
  envelope(uses.map((u) => ({ type: 'tool_use', ...u })), 'tool_use', 'scripted');
const textReply = (text: string) => envelope([{ type: 'text', text }], 'end_turn', 'scripted');

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as SeenRequest;
      seen.push(body);
      res.setHeader('content-type', 'application/json');
      if (unknownModels.has(body.model)) {
        res.statusCode = 400;
        res.end(
          JSON.stringify({
            type: 'error',
            error: { type: 'invalid_request_error', message: `model: ${body.model}` },
          }),
        );
        return;
      }
      if (script.length > 0) {
        res.end(JSON.stringify(script.shift()));
        return;
      }
      // Echo the user's words back (minus the platform reminder) so the eval
      // scenario's replyContains assertion is deterministic.
      const lastText = String(body.messages.at(-1)?.content ?? '').split(
        '\n\n<platform_reminder>',
      )[0];
      res.end(JSON.stringify(textReply(`echo(${lastText})`)));
    });
  });
  return new Promise((r) => llmStub.listen(0, '127.0.0.1', () => r()));
}

const json = (res: { body: string }) => JSON.parse(res.body);

async function waitFor(pred: () => Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for the turn to finish');
}

/** Write the routing config the way slice B's API will (null = no config row). */
async function setRouting(routing: { enabled: boolean; cheapModel: string } | null) {
  await pool.query('update agents set routing = $2 where id = $1', [
    agentId,
    routing ? JSON.stringify(routing) : null,
  ]);
}

/** A FINISHED reply row (raw.usage is stamped at insert / plan-card finalize). */
async function finishedReply(
  conversationId: string,
): Promise<{ content: string; raw: Record<string, unknown> } | undefined> {
  const { rows } = await pool.query(
    `select content, raw from conversation_messages
      where conversation_id = $1 and role = 'agent' and raw->'usage' is not null
      order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0];
}

/**
 * One turn end to end: post as a FRESH subscriber (so every test gets its own
 * conversation and its own single reply), then wait for the worker to finish it.
 */
async function turn(subscriberId: string, text: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents/router-agent/messages',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId: `${subscriberId}-1` },
  });
  const { conversationId } = json(res) as { conversationId: string };
  await waitFor(async () => (await finishedReply(conversationId)) !== undefined);
  const reply = (await finishedReply(conversationId))!;
  return {
    conversationId,
    reply,
    routing: reply.raw.routing as TurnRouting | undefined,
    trace: reply.raw.trace as TurnTrace,
  };
}

/** Every workflow-trigger breadcrumb in a conversation (the effect's receipt). */
async function triggerBreadcrumbs(conversationId: string): Promise<string[]> {
  const { rows } = await pool.query(
    `select content from conversation_messages
      where conversation_id = $1 and role = 'system' and content like 'triggered workflow%'`,
    [conversationId],
  );
  return rows.map((r: { content: string }) => r.content);
}

async function conversationRow(conversationId: string) {
  const { rows } = await pool.query(
    'select status, metadata from conversations where id = $1',
    [conversationId],
  );
  return rows[0] as { status: string; metadata: Record<string, unknown> };
}

/** Start an eval run and drive it in-process, exactly as the A4 suite does. */
async function runEvals(payload: Record<string, unknown>) {
  const started = await app.inject({
    method: 'POST',
    url: '/v1/agents/router-agent/evals/run',
    headers: { 'x-api-key': apiKey },
    payload,
  });
  expect(started.statusCode).toBe(202);
  const runId = json(started).runId as string;
  await processEvalRun({ data: { runId } } as Job<{ runId: string }>);
  const after = await app.inject({
    method: 'GET',
    url: `/v1/agents/router-agent/evals/runs/${runId}`,
    headers: { 'x-api-key': apiKey },
  });
  return json(after).run as { status: string };
}

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `routing-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Routing IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Routing IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  // A workflow for the NON-safe tool to reach for (inapp: no provider needed).
  await app.inject({
    method: 'PUT',
    url: '/v1/workflows',
    headers: { 'x-api-key': apiKey },
    payload: {
      key: 'route-wf',
      name: 'Routing workflow',
      steps: [{ channel: 'inapp', subject: 'Hi', body: 'Sent' }],
    },
  });

  await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: 'router-agent',
      name: 'Router Agent',
      runtime: 'managed',
      model: STRONG_MODEL,
      systemPrompt: 'You are the Acme support agent. Be brief.',
      llm: { apiKey: 'zai-test-key-123456', baseUrl: llmBaseUrl },
    },
  });
  const { rows } = await pool.query(
    'select id from agents where tenant_id = $1 and identifier = $2',
    [tenantId, 'router-agent'],
  );
  agentId = rows[0].id;

  await app.inject({
    method: 'POST',
    url: '/v1/agents/router-agent/evals',
    headers: { 'x-api-key': apiKey },
    payload: {
      name: 'greeting',
      scenario: { turns: [{ user: 'hi there' }, { expect: { replyContains: 'echo' } }] },
    },
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

describe('A6: the cheap model serves what it can', () => {
  test('a chatty turn never touches the strong model', async () => {
    await setRouting({ enabled: true, cheapModel: CHEAP_MODEL });
    const mark = seen.length;

    const { reply, routing } = await turn('chatty', 'hello there');

    const requests = seen.slice(mark);
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe(CHEAP_MODEL);
    expect(reply.content).toBe('echo(hello there)');
    expect(routing).toEqual({ model: CHEAP_MODEL, escalated: false });
  });

  test('a SAFE tool (resolve_conversation) keeps the turn cheap and really resolves', async () => {
    await setRouting({ enabled: true, cheapModel: CHEAP_MODEL });
    script = [
      toolUse([{ id: 'toolu_r1', name: 'resolve_conversation', input: { summary: 'all set' } }]),
      textReply('Glad I could help!'),
    ];
    const mark = seen.length;

    const { conversationId, reply, routing } = await turn('safe', 'thanks, that is all');

    // Both rounds — the tool round AND the reply round — ran on the cheap model.
    const requests = seen.slice(mark);
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.model)).toEqual([CHEAP_MODEL, CHEAP_MODEL]);
    // The effect is real, not simulated.
    expect((await conversationRow(conversationId)).status).toBe('resolved');
    expect(reply.content).toBe('Glad I could help!');
    expect(routing).toEqual({ model: CHEAP_MODEL, escalated: false });
  });
});

describe('A6: a consequential tool escalates the whole turn', () => {
  test('the cheap attempt is discarded and the strong model re-runs it clean', async () => {
    await setRouting({ enabled: true, cheapModel: CHEAP_MODEL });
    script = [
      // 1. the cheap model reaches for a REAL notification — discarded, unrun.
      toolUse([
        { id: 'toolu_c1', name: 'trigger_workflow', input: { workflowKey: 'route-wf', payload: {} } },
      ]),
      // 2-3. the strong model's own fresh turn: the same tool, then the reply.
      toolUse([
        { id: 'toolu_s1', name: 'trigger_workflow', input: { workflowKey: 'route-wf', payload: {} } },
      ]),
      textReply('Sent — check your inbox.'),
    ];
    const mark = seen.length;

    const { conversationId, reply, routing, trace } = await turn('unsafe', 'resend my order');

    const requests = seen.slice(mark);
    expect(requests).toHaveLength(3);
    expect(requests.map((r) => r.model)).toEqual([CHEAP_MODEL, STRONG_MODEL, STRONG_MODEL]);

    // NO TRACE: the strong model's first request is byte-identical to the cheap
    // model's first request — same prompt, same single user turn. Nothing about
    // the discarded attempt (its assistant block, its tool_use, a hint that it
    // happened) can reach the model that replaces it.
    expect(requests[1].messages).toEqual(requests[0].messages);
    expect(requests[1].system).toEqual(requests[0].system);
    expect(requests[1].messages).toHaveLength(1);
    expect(JSON.stringify(requests[1])).not.toContain('tool_use');
    expect(JSON.stringify(requests[1])).not.toContain('tool_result');

    // The notification was sent EXACTLY ONCE — by the strong model.
    expect(await triggerBreadcrumbs(conversationId)).toHaveLength(1);
    expect(reply.content).toBe('Sent — check your inbox.');
    expect(routing).toEqual({
      model: STRONG_MODEL,
      escalated: true,
      trigger: 'trigger_workflow',
    });

    // The trace keeps the WHOLE turn's truth: the discarded cheap call is real
    // spend and stays visible beside the two strong calls that replaced it.
    const models = trace.events
      .filter((e): e is Extract<typeof e, { t: 'model_call' }> => e.t === 'model_call')
      .map((e) => e.model);
    expect(models).toEqual([CHEAP_MODEL, STRONG_MODEL, STRONG_MODEL]);
    expect(reply.raw.usage).toMatchObject({ modelCalls: 3 });
  });

  test('a MIXED safe+unsafe response executes NOTHING on the cheap path', async () => {
    await setRouting({ enabled: true, cheapModel: CHEAP_MODEL });
    script = [
      // One response, two blocks: bookkeeping first, then a real notification.
      toolUse([
        { id: 'toolu_m1', name: 'set_metadata', input: { key: 'mixed_probe', value: 'yes' } },
        { id: 'toolu_m2', name: 'trigger_workflow', input: { workflowKey: 'route-wf', payload: {} } },
      ]),
      // The strong re-run decides for itself — here, plain words, no tools.
      textReply('I can help with that.'),
    ];
    const mark = seen.length;

    const { conversationId, reply, routing } = await turn('mixed', 'where is my order?');

    const requests = seen.slice(mark);
    expect(requests).toHaveLength(2);
    expect(requests.map((r) => r.model)).toEqual([CHEAP_MODEL, STRONG_MODEL]);

    // The safe half never ran: inspecting ALL blocks before executing ANY is
    // what makes "discarded" mean discarded.
    expect((await conversationRow(conversationId)).metadata).not.toHaveProperty('mixed_probe');
    expect(await triggerBreadcrumbs(conversationId)).toHaveLength(0);
    expect(reply.content).toBe('I can help with that.');
    expect(routing).toEqual({
      model: STRONG_MODEL,
      escalated: true,
      trigger: 'trigger_workflow',
    });
  });

  test('a cheap model the endpoint does not serve escalates — the turn still succeeds', async () => {
    await setRouting({ enabled: true, cheapModel: 'typo-model-does-not-exist' });
    unknownModels.add('typo-model-does-not-exist');
    const mark = seen.length;

    const { reply, routing } = await turn('badmodel', 'are you there?');

    const requests = seen.slice(mark);
    expect(requests.map((r) => r.model)).toEqual(['typo-model-does-not-exist', STRONG_MODEL]);
    // The customer got their answer — a routing fault is never the turn's fault.
    expect(reply.content).toBe('echo(are you there?)');
    // An ERROR escalation names no trigger: it was not a tool that caused it.
    expect(routing).toEqual({ model: STRONG_MODEL, escalated: true });
    expect(routing && 'trigger' in routing).toBe(false);
    unknownModels.delete('typo-model-does-not-exist');
  });
});

describe('A6: routing off is byte-identical to pre-A6', () => {
  test('enabled:false → no cheap call on the wire and no routing key on the row', async () => {
    await setRouting({ enabled: false, cheapModel: CHEAP_MODEL });
    const mark = seen.length;

    const { reply } = await turn('disabled', 'hi there');

    const requests = seen.slice(mark);
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe(STRONG_MODEL);
    expect('routing' in reply.raw).toBe(false);
  });

  test('a null routing config → the agent’s own model, no routing key', async () => {
    await setRouting(null);
    const mark = seen.length;

    const { reply } = await turn('nullcfg', 'hi again');

    const requests = seen.slice(mark);
    expect(requests).toHaveLength(1);
    expect(requests[0].model).toBe(STRONG_MODEL);
    expect('routing' in reply.raw).toBe(false);
  });

  test('an A4 candidate BEATS routing — the run grades the config it was given', async () => {
    // Routing on, and a candidate in flight: the candidate must win outright.
    // A pre-save check that passed on the cheap model would prove nothing about
    // the edit under test.
    await setRouting({ enabled: true, cheapModel: CHEAP_MODEL });
    const mark = seen.length;

    const run = await runEvals({
      trigger: 'pre_save',
      candidate: { systemPrompt: 'You are the DRAFT agent.', model: CANDIDATE_MODEL },
    });
    expect(run.status).toBe('passed');

    const requests = seen.slice(mark);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) expect(r.model).toBe(CANDIDATE_MODEL);
    expect(requests.some((r) => r.model === CHEAP_MODEL)).toBe(false);
  }, 90_000);
});

describe('A6: the eval driver is the real path, so it routes too', () => {
  test('a plain eval run on a routed agent is served by the cheap model', async () => {
    await setRouting({ enabled: true, cheapModel: CHEAP_MODEL });
    const mark = seen.length;

    const run = await runEvals({ trigger: 'manual' });
    expect(run.status).toBe('passed');

    const requests = seen.slice(mark);
    expect(requests.length).toBeGreaterThan(0);
    // The scenario is pure conversation — it never reaches for a tool, so the
    // whole run stays on tier 1. That is the point: the gate proves the cheap
    // model holds the bar on exactly the traffic the router will send it.
    for (const r of requests) expect(r.model).toBe(CHEAP_MODEL);
  }, 90_000);
});
