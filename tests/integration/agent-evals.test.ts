/**
 * Phase 22 slice B — per-agent evals: CRUD API + the run lifecycle driven THROUGH
 * the real queue. A bridge agent points at a local stub that echoes a fixed
 * reply; the eval-run processor's in-process driver enqueues conversation jobs
 * which a real conversation Worker (spun up here) services — exactly the
 * production pipeline (queue -> brain), no HTTP api key involved.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, QUEUE } from '../../src/shared/queues';
import { createRedis, redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { processConversation } from '../../src/workers/processors/conversation.processor';
import {
  buildJudgeOptions,
  judgeTemperatureFor,
  processEvalRun,
  usesJudge,
} from '../../src/workers/processors/eval-run.processor';
import { createRun, finishRun, getRun } from '../../src/db/agent-evals.repo';
import type { Agent } from '../../src/db/conversations.repo';
import { REPLY_BEGIN, TRANSCRIPT_BEGIN } from '../../src/core/eval-judge';
import type { JudgeClient, JudgeRequest, JudgeVerdict } from '../../src/core/eval-judge';
import { runScenarios } from '../../src/core/eval-runner';
import type { EvalDriver, Scenario } from '../../src/core/eval-runner';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let agentId = '';
let convWorker: Worker;

// A stub bridge that echoes a fixed reply for every turn.
let bridge: Server;
let bridgeUrl = '';

const json = (res: { body: string }) => JSON.parse(res.body);

function startBridge(): Promise<void> {
  return new Promise((resolve) => {
    bridge = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ reply: 'hello there, how can I help?' }));
      });
    });
    bridge.listen(0, '127.0.0.1', () => resolve());
  });
}

beforeAll(async () => {
  await startBridge();
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `evals-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Evals IT', email, password: 'integration-pw-1', organizationName: 'Evals IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: { identifier: 'evals-agent', name: 'Evals Agent', runtime: 'bridge', bridgeUrl },
  });
  // agentView deliberately hides the row id, so read it tenant-scoped for the
  // repo-level round-trip tests below.
  const { rows } = await pool.query(
    'select id from agents where tenant_id = $1 and identifier = $2',
    [tenantId, 'evals-agent'],
  );
  agentId = rows[0].id;

  // A live conversation worker to service the jobs the eval-run driver enqueues.
  convWorker = new Worker(QUEUE.CONVERSATION, processConversation as unknown as (job: Job) => Promise<void>, {
    connection: createRedis(),
    concurrency: 5,
  });
});

afterAll(async () => {
  await convWorker?.close();
  bridge?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

const evalUrl = (suffix = '') => `/v1/agents/evals-agent/evals${suffix}`;

describe('eval CRUD', () => {
  let evalId = '';

  test('create → list → update → delete', async () => {
    const scenario = { turns: [{ user: 'hi' }, { expect: { replyContains: 'help' } }] };
    const created = await app.inject({
      method: 'POST',
      url: evalUrl(),
      headers: { 'x-api-key': apiKey },
      payload: { name: 'greeting', scenario },
    });
    expect(created.statusCode).toBe(201);
    evalId = json(created).eval.id;
    expect(json(created).eval).toMatchObject({ name: 'greeting', enabled: true });

    // Duplicate name → 409.
    const dup = await app.inject({
      method: 'POST',
      url: evalUrl(),
      headers: { 'x-api-key': apiKey },
      payload: { name: 'greeting', scenario },
    });
    expect(dup.statusCode).toBe(409);

    // Bad scenario (no turns) → 400.
    const bad = await app.inject({
      method: 'POST',
      url: evalUrl(),
      headers: { 'x-api-key': apiKey },
      payload: { name: 'broken', scenario: { turns: [] } },
    });
    expect(bad.statusCode).toBe(400);

    const list = await app.inject({ method: 'GET', url: evalUrl(), headers: { 'x-api-key': apiKey } });
    expect(json(list).evals).toHaveLength(1);

    const updated = await app.inject({
      method: 'PUT',
      url: evalUrl(`/${evalId}`),
      headers: { 'x-api-key': apiKey },
      payload: { enabled: false },
    });
    expect(json(updated).eval.enabled).toBe(false);

    const del = await app.inject({
      method: 'DELETE',
      url: evalUrl(`/${evalId}`),
      headers: { 'x-api-key': apiKey },
    });
    expect(json(del).deleted).toBe(true);
  });

  test('unknown agent → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/nope/evals',
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('eval run lifecycle (through the queue)', () => {
  test('enqueue → drive turns → results populated', async () => {
    await app.inject({
      method: 'POST',
      url: evalUrl(),
      headers: { 'x-api-key': apiKey },
      payload: {
        name: 'run-greeting',
        scenario: { turns: [{ user: 'hi' }, { expect: { replyContains: 'help' } }] },
      },
    });

    const started = await app.inject({
      method: 'POST',
      url: evalUrl('/run'),
      headers: { 'x-api-key': apiKey },
      payload: { trigger: 'manual' },
    });
    expect(started.statusCode).toBe(202);
    const runId = json(started).runId as string;

    // Row is 'running' before the worker touches it.
    const before = await app.inject({
      method: 'GET',
      url: evalUrl(`/runs/${runId}`),
      headers: { 'x-api-key': apiKey },
    });
    expect(json(before).run.status).toBe('running');

    // Drive the run in-process; its driver enqueues conversation jobs the live
    // convWorker services, and it polls the transcript for the reply.
    await processEvalRun({ data: { runId } } as Job<{ runId: string }>);

    const after = await app.inject({
      method: 'GET',
      url: evalUrl(`/runs/${runId}`),
      headers: { 'x-api-key': apiKey },
    });
    const run = json(after).run;
    expect(run.status).toBe('passed');
    expect(run.finishedAt).not.toBeNull();
    expect(run.results).toHaveLength(1);
    expect(run.results[0]).toMatchObject({ name: 'run-greeting', passed: true, failures: [] });

    const list = await app.inject({
      method: 'GET',
      url: evalUrl('/runs'),
      headers: { 'x-api-key': apiKey },
    });
    expect(json(list).runs.length).toBeGreaterThanOrEqual(1);
  }, 90_000);
});

/**
 * Phase A2 slice B — the judge wiring in the eval-run worker.
 *
 * The client is built from the AGENT's own creds, LAZILY: a run whose scenarios
 * never mention `expect.judge` must not open a sealed key or pay an SSRF check,
 * and a run that cannot build one must still grade its deterministic assertions
 * (slice A then marks the judged dimensions visibly 'skipped').
 *
 * `buildJudgeOptions` takes its client builder as an injected parameter — the
 * house DI style — because processEvalRun itself cannot take a second argument:
 * workers/index.ts hands it straight to BullMQ, which passes a token there.
 */
describe('A2 judge wiring', () => {
  const stubClient: JudgeClient = {
    messages: { create: async () => ({ content: [] }) },
  };

  function fakeAgent(over: Partial<Agent> = {}): Agent {
    return {
      id: agentId,
      tenant_id: tenantId,
      identifier: 'judge-agent',
      name: 'Judge Agent',
      description: null,
      runtime: 'managed',
      bridge_url: null,
      signing_secret: 'sealed-secret',
      model: 'glm-4.6',
      system_prompt: 'You are warm and concise.',
      llm_base_url: null,
      llm_credentials: 'sealed-creds',
      max_tokens: null,
      max_daily_tokens: null,
      auto_resolve_minutes: null,
      welcome_message: null,
      suggested_prompts: null,
      status: 'active',
      context: {},
      created_at: '2026-08-21T10:00:00.000Z',
      updated_at: '2026-08-21T10:00:00.000Z',
      ...over,
    };
  }

  const judgedScenarios = (): Array<{ name: string; sc: Scenario }> => [
    {
      name: 'judged',
      sc: {
        turns: [
          { user: 'what is your refund window?' },
          { expect: { judge: { groundedness: { min: 4 } } } },
        ],
      } as Scenario,
    },
  ];
  const plainScenarios = (): Array<{ name: string; sc: Scenario }> => [
    {
      name: 'plain',
      sc: { turns: [{ user: 'hi' }, { expect: { replyContains: 'help' } }] } as Scenario,
    },
  ];

  /** Counts builds so "never built" is an assertion, not an assumption. */
  function countingBuilder(impl: () => Promise<JudgeClient> = async () => stubClient) {
    const calls = { n: 0 };
    return {
      calls,
      build: async () => {
        calls.n += 1;
        return impl();
      },
    };
  }

  test('managed agent + a judged scenario: client, model, persona, temperature threaded', async () => {
    const { calls, build } = countingBuilder();
    const opts = await buildJudgeOptions(fakeAgent(), judgedScenarios(), build);
    expect(calls.n).toBe(1);
    expect(opts).toBeDefined();
    expect(opts!.client).toBe(stubClient);
    expect(opts!.model).toBe('glm-4.6');
    expect(opts!.systemPrompt).toBe('You are warm and concise.');
    // A compat/glm endpoint accepts sampling params: keep the repeatable 0.
    expect(opts!.temperature).toBe(0);
  });

  test('modern Anthropic families get temperature null (the field is omitted)', async () => {
    const opts = await buildJudgeOptions(
      fakeAgent({ model: 'claude-fable-5' }),
      judgedScenarios(),
      async () => stubClient,
    );
    // null is eval-judge.ts's "omit the field" signal: these models 400 on it.
    expect(opts!.temperature).toBeNull();

    for (const m of ['claude-fable-5', 'claude-opus-4.7', 'claude-opus-5', 'claude-sonnet-5']) {
      expect(judgeTemperatureFor(m)).toBeNull();
    }
    for (const m of ['glm-4.6', 'claude-3-5-sonnet-20241022', 'claude-opus-4.5', 'gpt-4o-mini']) {
      expect(judgeTemperatureFor(m)).toBe(0);
    }
  });

  test('no judge block in any scenario: the client is NEVER built', async () => {
    const { calls, build } = countingBuilder();
    const opts = await buildJudgeOptions(fakeAgent(), plainScenarios(), build);
    expect(opts).toBeUndefined();
    expect(calls.n).toBe(0);
  });

  test('a bridge agent never builds an LLM client, even for a judged scenario', async () => {
    const { calls, build } = countingBuilder();
    const opts = await buildJudgeOptions(fakeAgent({ runtime: 'bridge' }), judgedScenarios(), build);
    expect(opts).toBeUndefined();
    expect(calls.n).toBe(0);
  });

  test('a skipped scenario does not force a client build', async () => {
    const { calls, build } = countingBuilder();
    const skipped = judgedScenarios();
    skipped[0].sc.skip = true;
    expect(await buildJudgeOptions(fakeAgent(), skipped, build)).toBeUndefined();
    expect(calls.n).toBe(0);
  });

  test('a client that cannot be built degrades to assertions-only, never throws', async () => {
    const opts = await buildJudgeOptions(fakeAgent(), judgedScenarios(), async () => {
      throw new Error('managed agent judge-agent has no LLM credentials');
    });
    expect(opts).toBeUndefined();
  });

  test('a managed agent with no model configured is skipped', async () => {
    const { calls, build } = countingBuilder();
    const opts = await buildJudgeOptions(fakeAgent({ model: null }), judgedScenarios(), build);
    expect(opts).toBeUndefined();
    expect(calls.n).toBe(0);
  });

  test('usesJudge reads raw jsonb defensively', () => {
    const judgedRaw = { turns: [{ expect: { judge: { tone: { min: 3 } } } }] };
    expect(usesJudge(judgedRaw as unknown as Scenario)).toBe(true);
    expect(usesJudge({ turns: [{ expect: { replyContains: 'x' } }] } as unknown as Scenario)).toBe(false);
    // Hand-edited / malformed rows must not throw on the scan.
    expect(usesJudge({} as unknown as Scenario)).toBe(false);
    expect(usesJudge({ turns: null } as unknown as Scenario)).toBe(false);
    expect(usesJudge({ turns: [null, 'nope', 7] } as unknown as Scenario)).toBe(false);
  });
});

describe('A2 persistence round-trip', () => {
  test('judged[] survives the jsonb column intact', async () => {
    const run = await createRun({ tenantId, agentId, trigger: 'manual' });
    const judgedResult = {
      name: 'grounded-answer',
      passed: false,
      failures: ['judge.groundedness: 2/5 < 4 — invented a 30-day window'],
      attempts: 1,
      judged: [
        {
          turn: 1,
          dim: 'groundedness' as const,
          verdict: 'fail' as const,
          score: 2,
          rationale: 'invented a 30-day window',
        },
        {
          turn: 1,
          dim: 'tone' as const,
          verdict: 'pass' as const,
          score: 5,
          rationale: 'warm and brief',
        },
      ],
    };
    await finishRun(run.id, 'failed', [judgedResult]);

    const read = await getRun(tenantId, run.id);
    expect(read!.status).toBe('failed');
    // Deep-equal, not toMatchObject: scores and rationales must survive exactly.
    expect(read!.results).toEqual([judgedResult]);
  });

  test('a result WITHOUT judged[] is byte-identical to the pre-A2 shape', async () => {
    const run = await createRun({ tenantId, agentId, trigger: 'manual' });
    const preA2 = { name: 'plain', passed: true, failures: [], attempts: 1 };
    await finishRun(run.id, 'passed', [preA2]);

    const read = await getRun(tenantId, run.id);
    // NOTE: `results` is a jsonb column, and jsonb NORMALIZES key order (shorter
    // keys first, then alphabetical) — so a literal byte-for-byte string compare
    // is not satisfiable here, and never was, A2 or not. The invariant that
    // actually matters is that the KEY SET is unchanged: no `judged` key at all
    // (not null, not []), so every pre-A2 reader sees exactly what it saw before.
    expect(Object.keys(read!.results[0]).sort()).toEqual([
      'attempts',
      'failures',
      'name',
      'passed',
    ]);
    expect('judged' in read!.results[0]).toBe(false);
    expect(read!.results).toEqual([preA2]);
  });
});

/**
 * Phase A2 slice D — the JUDGED PIPELINE end to end: a real driven turn (API
 * route → queue → conversation worker → brain) whose reply is then graded by a
 * SCRIPTED judge.
 *
 * The judge is a canned JudgeClient rather than a live model — a model that
 * decides pass/fail on its own would make these assertions non-deterministic,
 * and what is under test here is the plumbing around it: evidence assembly, the
 * one-call-per-judged-expect contract, the exact failure line, and judged[].
 * The failure strings are asserted BYTE-EXACTLY because they are published in
 * docs/ASYNCIFY-AGENTS-GUIDE.md §10 — a format change must break a test, not a
 * customer's expectations.
 */
describe('A2 pipeline: a scripted judge over a real driven turn', () => {
  /**
   * A turn driver over app.inject: the same route createHttpDriver posts to,
   * minus the TCP hop. The turn itself still travels queue → convWorker → brain,
   * so the transcript the judge reads is the one production writes.
   */
  const injectDriver = (): EvalDriver => ({
    async sendTurn({ agent, subscriberId, text, turnIndex }) {
      const res = await app.inject({
        method: 'POST',
        url: `/v1/agents/${agent}/messages`,
        headers: { 'x-api-key': apiKey },
        payload: { subscriberId, text, messageId: `${subscriberId}-t${turnIndex}` },
      });
      if (res.statusCode !== 202) {
        throw new Error(`send failed (${res.statusCode}): ${res.body}`);
      }
      const body = json(res);
      return { conversationId: body.conversationId, inboundRowId: body.messageId };
    },
  });

  /** A judge that always answers with the same verdicts, and keeps every request. */
  function scriptedJudge(verdicts: JudgeVerdict[]) {
    const seen: JudgeRequest[] = [];
    const client: JudgeClient = {
      messages: {
        create: async (body: JudgeRequest) => {
          seen.push(body);
          return {
            content: [{ type: 'tool_use', name: 'report_verdicts', input: { verdicts } }],
          };
        },
      },
    };
    return { client, seen };
  }

  const judgedScenario = (expectJudge: Scenario['turns'][number]): Scenario =>
    ({
      agent: 'evals-agent',
      attempts: 1,
      turns: [{ user: 'what is your refund window?' }, expectJudge],
    }) as Scenario;

  const run = async (name: string, sc: Scenario, client: JudgeClient) =>
    (
      await runScenarios([{ name, sc }], {
        driver: injectDriver(),
        nonce: `d-${name}-${Date.now()}`,
        judge: { client, model: 'glm-4.6', systemPrompt: 'You are warm and concise.', temperature: 0 },
      })
    )[0];

  test('groundedness under the bar fails the scenario, with the documented line', async () => {
    const rationale = 'the reply states a 30-day window; no evidence line mentions one';
    const { client, seen } = scriptedJudge([
      { dim: 'groundedness', score: 2, verdict: 'fail', rationale },
    ]);
    const sc = judgedScenario({ expect: { judge: { groundedness: { min: 4 } } } });

    const result = await run('grounded-under-bar', sc, client);

    expect(result.passed).toBe(false);
    expect(result.status).toBe('fail');
    // The published format: `judge.<dim>: <score>/5 < <min> — <rationale>`.
    expect(result.failures).toHaveLength(1);
    const lines = result.failures[0].split('\n').map((l) => l.trim());
    expect(lines[0]).toBe('turn 1 · judge groundedness');
    expect(lines[1]).toBe(`judge.groundedness: 2/5 < 4 — ${rationale}`);
    // …and the additive record carries the score the line quotes.
    expect(result.judged).toEqual([
      { turn: 1, dim: 'groundedness', verdict: 'fail', score: 2, rationale },
    ]);
    // The judge saw the REAL turn: the fenced transcript and the actual reply.
    expect(seen).toHaveLength(1);
    expect(seen[0].messages[0].content).toContain(TRANSCRIPT_BEGIN);
    expect(seen[0].messages[0].content).toContain('what is your refund window?');
    expect(seen[0].messages[0].content).toContain(REPLY_BEGIN);
    expect(seen[0].messages[0].content).toContain('hello there, how can I help?');
  }, 90_000);

  test('every dimension at or above its bar passes, and judged[] keeps the scores', async () => {
    const { client, seen } = scriptedJudge([
      { dim: 'groundedness', score: 5, verdict: 'pass', rationale: 'makes no factual claims' },
      { dim: 'tone', score: 4, verdict: 'pass', rationale: 'warm opener, offers help' },
    ]);
    const sc = judgedScenario({
      expect: { judge: { groundedness: { min: 4 }, tone: { rubric: 'warm and brief', min: 3 } } },
    });

    const result = await run('judged-pass', sc, client);

    expect(result.passed).toBe(true);
    expect(result.failures).toEqual([]);
    expect(result.judged).toEqual([
      { turn: 1, dim: 'groundedness', verdict: 'pass', score: 5, rationale: 'makes no factual claims' },
      { turn: 1, dim: 'tone', verdict: 'pass', score: 4, rationale: 'warm opener, offers help' },
    ]);
    // Both dimensions rode ONE forced-tool call at temperature 0 — the contract
    // section 10 documents, and the thing that keeps judged evals affordable.
    expect(seen).toHaveLength(1);
    expect(seen[0].tool_choice).toEqual({ type: 'tool', name: 'report_verdicts' });
    expect(seen[0].temperature).toBe(0);
    expect(seen[0].model).toBe('glm-4.6');
  }, 90_000);

  test('must_refuse against a complying reply fails, with the refusal line', async () => {
    const rationale = 'the reply answers the request instead of declining it';
    const { client } = scriptedJudge([{ dim: 'refusal', verdict: 'fail', rationale }]);
    const sc = judgedScenario({ expect: { judge: { refusal: 'must_refuse' } } });

    const result = await run('refusal-complied', sc, client);

    expect(result.passed).toBe(false);
    const lines = result.failures[0].split('\n').map((l) => l.trim());
    expect(lines[0]).toBe('turn 1 · judge refusal');
    // Refusal is a requirement, not a score — no `x/5` in its line.
    expect(lines[1]).toBe(`judge.refusal: expected must_refuse — ${rationale}`);
    expect(result.judged).toEqual([{ turn: 1, dim: 'refusal', verdict: 'fail', rationale }]);
  }, 90_000);
});

describe('A2 end-to-end: a judged scenario with no judge available', () => {
  test('assertions still grade, judged dimensions persist as visibly skipped', async () => {
    // The bridge agent genuinely has no LLM client, the same degraded state a
    // missing-credentials managed agent lands in, driven through the real
    // processor, queue and repo rather than simulated.
    await app.inject({
      method: 'POST',
      url: evalUrl(),
      headers: { 'x-api-key': apiKey },
      payload: {
        name: 'judged-no-client',
        scenario: {
          turns: [
            { user: 'hi' },
            { expect: { replyContains: 'help', judge: { tone: { rubric: 'warm', min: 3 } } } },
          ],
        },
      },
    });

    const started = await app.inject({
      method: 'POST',
      url: evalUrl('/run'),
      headers: { 'x-api-key': apiKey },
      payload: { trigger: 'manual' },
    });
    const runId = json(started).runId as string;
    await processEvalRun({ data: { runId } } as Job<{ runId: string }>);

    const after = await app.inject({
      method: 'GET',
      url: evalUrl(`/runs/${runId}`),
      headers: { 'x-api-key': apiKey },
    });
    const run = json(after).run;
    // Status came from the ASSERTIONS alone: a skipped judge is not a failure.
    expect(run.status).toBe('passed');
    const judgedRow = run.results.find((r: { name: string }) => r.name === 'judged-no-client');
    expect(judgedRow).toMatchObject({ passed: true, failures: [] });
    expect(judgedRow.judged).toEqual([
      { turn: 1, dim: 'tone', verdict: 'skipped', rationale: 'judge requires server-side run' },
    ]);
    // A plain scenario in the same run stays byte-identical to pre-A2.
    const plainRow = run.results.find((r: { name: string }) => r.name === 'run-greeting');
    if (plainRow) expect('judged' in plainRow).toBe(false);
  }, 90_000);
});
