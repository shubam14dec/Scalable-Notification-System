/**
 * Phase A4 slice A — CANDIDATE eval runs: an eval run that grades a system
 * prompt and/or model the agent has NOT been saved with (the dashboard's
 * pre-save check), driven through the real pipeline.
 *
 * Real app, real queue, real conversation worker, real @anthropic-ai/sdk
 * pointed (via the agent's llm_base_url) at a stub Messages API — only the
 * model server is fake, so what the stub RECEIVES is the proof of what reached
 * the model. The five properties under test:
 *   1. a candidate run puts the CANDIDATE prompt + model on the wire while the
 *      agent row still holds the old ones (nothing persisted, nothing live);
 *   2. a plain run AFTER a candidate run is back on the agent's own config;
 *   3. a bridge agent can never take a candidate (400 at the API, plus the
 *      worker's defensive skip);
 *   4. the run row and the API run shape carry the candidate verbatim, and a
 *      plain run's shape has NO candidate key (byte-compat with pre-A4);
 *   5. the PUBLIC message route cannot inject the internal override field.
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
import {
  buildJudgeOptions,
  processEvalRun,
} from '../../src/workers/processors/eval-run.processor';
import { getRun } from '../../src/db/agent-evals.repo';
import { getAgentById, type Agent } from '../../src/db/conversations.repo';
import type { JudgeClient } from '../../src/core/eval-judge';
import type { Scenario } from '../../src/core/eval-runner';

/** The agent's SAVED config — what every non-candidate turn must use. */
const LIVE_PROMPT = 'You are the LIVE Acme support agent. Be brief.';
const LIVE_MODEL = 'live-model-1';
/** The unsaved draft under test. */
const CANDIDATE = {
  systemPrompt: 'You are the DRAFT Acme support agent. Quote the 14-day window.',
  model: 'candidate-model-9',
};

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let managedAgentId = '';
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

/**
 * Every conversation job THIS file's tenant produced, as the worker serviced it.
 * The tenant filter matters: the test queue is shared, and a file that enqueues
 * jobs without running a worker leaves them for the next worker to appear — a
 * full-suite run had this worker drain another file's leftovers into here.
 */
const serviced: ConversationJobData[] = [];

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as SeenRequest;
      seen.push(body);
      // Echo the user's words back (minus the platform reminder) so the eval
      // scenario's replyContains assertion is deterministic.
      const lastText = String(body.messages.at(-1)?.content ?? '').split(
        '\n\n<platform_reminder>',
      )[0];
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          id: 'msg_stub_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: `echo(${lastText})` }],
          stop_reason: 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });
  });
  return new Promise((r) => llmStub.listen(0, '127.0.0.1', () => r()));
}

const json = (res: { body: string }) => JSON.parse(res.body);

async function waitFor(pred: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for the turn to reach the model stub');
}

/** Start a run (optionally with a candidate), drive it in-process, read it back. */
async function runEvals(payload: Record<string, unknown>) {
  const started = await app.inject({
    method: 'POST',
    url: '/v1/agents/cand-agent/evals/run',
    headers: { 'x-api-key': apiKey },
    payload,
  });
  expect(started.statusCode).toBe(202);
  const runId = json(started).runId as string;
  await processEvalRun({ data: { runId } } as Job<{ runId: string }>);
  const after = await app.inject({
    method: 'GET',
    url: `/v1/agents/cand-agent/evals/runs/${runId}`,
    headers: { 'x-api-key': apiKey },
  });
  return { runId, run: json(after).run };
}

async function agentRow(): Promise<{ model: string | null; system_prompt: string | null }> {
  const { rows } = await pool.query('select model, system_prompt from agents where id = $1', [
    managedAgentId,
  ]);
  return rows[0];
}

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `cand-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Candidate IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Candidate IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: 'cand-agent',
      name: 'Candidate Agent',
      runtime: 'managed',
      model: LIVE_MODEL,
      systemPrompt: LIVE_PROMPT,
      llm: { apiKey: 'zai-test-key-123456', baseUrl: llmBaseUrl },
    },
  });
  // A bridge agent for the "candidate is a managed-only concept" check. Its URL
  // is a real reachable loopback address (the create route SSRF-checks it) but
  // is never dialed here: the candidate request is refused before any run.
  await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: 'cand-bridge',
      name: 'Candidate Bridge',
      runtime: 'bridge',
      bridgeUrl: llmBaseUrl,
    },
  });
  // agentView hides the row id; read it tenant-scoped for the row assertions.
  const { rows } = await pool.query(
    'select id from agents where tenant_id = $1 and identifier = $2',
    [tenantId, 'cand-agent'],
  );
  managedAgentId = rows[0].id;

  await app.inject({
    method: 'POST',
    url: '/v1/agents/cand-agent/evals',
    headers: { 'x-api-key': apiKey },
    payload: {
      name: 'greeting',
      scenario: { turns: [{ user: 'hi there' }, { expect: { replyContains: 'echo' } }] },
    },
  });

  // A live conversation worker services the jobs the eval driver enqueues —
  // the production hop. The wrapper records each job's data so the internal
  // override field can be asserted at the exact place it travels.
  convWorker = new Worker(
    QUEUE.CONVERSATION,
    async (job: Job) => {
      const data = job.data as ConversationJobData;
      if (data.tenantId === tenantId) serviced.push(data);
      await processConversation(job as Job<ConversationJobData>);
    },
    { connection: createRedis(), concurrency: 5 },
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

describe('A4 candidate runs: the override reaches the model, and only the model', () => {
  let candidateRunId = '';

  test('a candidate run puts the CANDIDATE prompt + model on the wire', async () => {
    const mark = seen.length;
    const jobMark = serviced.length;

    const { runId, run } = await runEvals({ trigger: 'pre_save', candidate: CANDIDATE });
    candidateRunId = runId;
    expect(run.status).toBe('passed');

    // What actually reached the model server.
    const requests = seen.slice(mark);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.model).toBe(CANDIDATE.model);
      expect(r.system?.[0]?.text).toBe(CANDIDATE.systemPrompt);
      expect(JSON.stringify(r.system)).not.toContain(LIVE_PROMPT);
    }

    // The hop itself: the conversation job the driver enqueued carried the
    // internal override, and nothing else about the job changed.
    const jobs = serviced.slice(jobMark);
    expect(jobs.length).toBeGreaterThan(0);
    for (const j of jobs) expect(j.evalCandidate).toEqual(CANDIDATE);

    // …and NOTHING persisted: the agent row still holds the saved config, so a
    // bad draft was never live for a real customer turn.
    expect(await agentRow()).toEqual({ model: LIVE_MODEL, system_prompt: LIVE_PROMPT });
  }, 90_000);

  test('the run row and the API run shape carry the candidate verbatim', async () => {
    const row = await getRun(tenantId, candidateRunId);
    expect(row!.candidate).toEqual(CANDIDATE);

    const res = await app.inject({
      method: 'GET',
      url: `/v1/agents/cand-agent/evals/runs/${candidateRunId}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(json(res).run.candidate).toEqual(CANDIDATE);

    // The list view carries it too (slice B renders "graded the edited prompt").
    const list = await app.inject({
      method: 'GET',
      url: '/v1/agents/cand-agent/evals/runs',
      headers: { 'x-api-key': apiKey },
    });
    const listed = json(list).runs.find((r: { id: string }) => r.id === candidateRunId);
    expect(listed.candidate).toEqual(CANDIDATE);
  });

  test('a plain run AFTER a candidate run uses the agent’s OWN prompt (no leakage)', async () => {
    const mark = seen.length;
    const jobMark = serviced.length;

    const { runId, run } = await runEvals({ trigger: 'manual' });
    expect(run.status).toBe('passed');

    const requests = seen.slice(mark);
    expect(requests.length).toBeGreaterThan(0);
    for (const r of requests) {
      expect(r.model).toBe(LIVE_MODEL);
      expect(r.system?.[0]?.text).toBe(LIVE_PROMPT);
      expect(JSON.stringify(r.system)).not.toContain(CANDIDATE.systemPrompt);
    }
    for (const j of serviced.slice(jobMark)) expect('evalCandidate' in j).toBe(false);

    // Byte-compat: a plain run's row is NULL and its API shape has NO candidate
    // key at all (not null, not {}) — every pre-A4 reader sees what it saw.
    const row = await getRun(tenantId, runId);
    expect(row!.candidate).toBeNull();
    expect('candidate' in run).toBe(false);
    expect(Object.keys(run).sort()).toEqual([
      'finishedAt',
      'id',
      'results',
      'startedAt',
      'status',
      'trigger',
    ]);
  }, 90_000);
});

describe('A4 candidate: managed agents only', () => {
  test('a bridge agent + candidate → 400 with a clear message', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/cand-bridge/evals/run',
      headers: { 'x-api-key': apiKey },
      payload: { trigger: 'pre_save', candidate: CANDIDATE },
    });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toContain('managed agent');

    // No run row was created for the refused request.
    const runs = await app.inject({
      method: 'GET',
      url: '/v1/agents/cand-bridge/evals/runs',
      headers: { 'x-api-key': apiKey },
    });
    expect(json(runs).runs).toHaveLength(0);
  });

  test('the same bridge agent WITHOUT a candidate still starts a run (202)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/cand-bridge/evals/run',
      headers: { 'x-api-key': apiKey },
      payload: { trigger: 'manual' },
    });
    expect(res.statusCode).toBe(202);
  });

  test('an empty candidate object is rejected — there is no override to make', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/cand-agent/evals/run',
      headers: { 'x-api-key': apiKey },
      payload: { candidate: {} },
    });
    expect(res.statusCode).toBe(400);
  });

  test('the worker skips a candidate on a non-managed agent (defensive twin)', async () => {
    // buildJudgeOptions is the guard's existing style: a bridge agent never
    // takes an LLM-side config, candidate or not.
    const bridge = await getAgentById(
      (
        await pool.query('select id from agents where tenant_id = $1 and identifier = $2', [
          tenantId,
          'cand-bridge',
        ])
      ).rows[0].id,
    );
    const judged: Array<{ name: string; sc: Scenario }> = [
      { name: 'j', sc: { turns: [{ expect: { judge: { tone: { min: 3 } } } }] } as Scenario },
    ];
    const stub: JudgeClient = { messages: { create: async () => ({ content: [] }) } };
    expect(
      await buildJudgeOptions(bridge as Agent, judged, async () => stub, CANDIDATE),
    ).toBeUndefined();
  });
});

describe('A4: the judge grades the config under test', () => {
  const judged = (): Array<{ name: string; sc: Scenario }> => [
    { name: 'j', sc: { turns: [{ expect: { judge: { tone: { min: 3 } } } }] } as Scenario },
  ];
  const stub: JudgeClient = { messages: { create: async () => ({ content: [] }) } };

  test('candidate model + prompt are threaded to the judge; temperature follows the candidate model', async () => {
    const agent = (await getAgentById(managedAgentId))!;

    const withCandidate = await buildJudgeOptions(agent, judged(), async () => stub, CANDIDATE);
    expect(withCandidate!.model).toBe(CANDIDATE.model);
    expect(withCandidate!.systemPrompt).toBe(CANDIDATE.systemPrompt);
    // A compat/glm-style id accepts sampling params: the repeatable 0 stands.
    expect(withCandidate!.temperature).toBe(0);

    // A candidate switch to a modern Anthropic id must drop `temperature`
    // (those models 400 on it) — the predicate reads the EFFECTIVE model.
    const modern = await buildJudgeOptions(agent, judged(), async () => stub, {
      model: 'claude-opus-5',
    });
    expect(modern!.temperature).toBeNull();
    // Prompt untouched by a model-only candidate.
    expect(modern!.systemPrompt).toBe(LIVE_PROMPT);

    // No candidate: unchanged A2 behavior, the agent's own config.
    const plain = await buildJudgeOptions(agent, judged(), async () => stub);
    expect(plain!.model).toBe(LIVE_MODEL);
    expect(plain!.systemPrompt).toBe(LIVE_PROMPT);
  });
});

describe('A4: the override is INTERNAL', () => {
  test('the public messages route cannot inject evalCandidate', async () => {
    const mark = seen.length;
    const jobMark = serviced.length;
    const text = `hijack-attempt-${Date.now()}`;

    // The attack: an extra top-level field named exactly like the internal one.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/cand-agent/messages',
      headers: { 'x-api-key': apiKey },
      payload: {
        subscriberId: 'mallory',
        text,
        messageId: `hijack-${Date.now()}`,
        evalCandidate: { systemPrompt: 'HIJACKED PROMPT', model: 'hijacked-model' },
        candidate: { systemPrompt: 'HIJACKED PROMPT', model: 'hijacked-model' },
      },
    });
    expect(res.statusCode).toBe(202);

    await waitFor(() =>
      seen.slice(mark).some((r) => JSON.stringify(r.messages).includes(text)),
    );

    // The job the worker serviced carries no override…
    const job = serviced.slice(jobMark).find((j) => j.messageId === json(res).messageId);
    expect(job).toBeDefined();
    expect('evalCandidate' in job!).toBe(false);
    // …and the model saw the agent's real config.
    const request = seen.slice(mark).find((r) => JSON.stringify(r.messages).includes(text))!;
    expect(request.model).toBe(LIVE_MODEL);
    expect(request.system?.[0]?.text).toBe(LIVE_PROMPT);
    expect(JSON.stringify(request)).not.toContain('HIJACKED');
  }, 30_000);
});
