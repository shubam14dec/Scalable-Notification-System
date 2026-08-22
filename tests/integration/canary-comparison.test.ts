/**
 * Phase A5 slice C — THE COMPARISON: the evidence that makes Promote a decision
 * instead of a vibe.
 *
 * Real app in-process, real Postgres, a real BullMQ conversation worker, and a
 * stub Anthropic-compatible server that answers BOTH kinds of call the trial
 * makes — the agent's own turns, and the judge's forced-tool grading of them.
 * The properties:
 *   1. sampling is a coin flip on a configured percent, applied to BOTH arms at
 *      the same rate (an unjudged control arm is not a control), and 0 means
 *      counters only;
 *   2. judging is FIRE-AND-FORGET: a broken judge queue costs a data point and
 *      never the customer's reply;
 *   3. a judgment is attributed by what ACTUALLY SERVED the turn — a canary-arm
 *      turn that ran the live prompt is stored (and counted) as control;
 *   4. unique (message_id, dim) means a re-run job cannot double-count;
 *   5. missing credentials degrade to a logged skip, never a retry storm;
 *   6. the judge really receives the transcript, both dims, and the model that
 *      served the turn — asserted at the wire, not at the intention;
 *   7. the report aggregates exactly, on a known seeded fixture, and is guarded
 *      (managed-only, current-trial-only).
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker, type Job } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, getQueue, QUEUE } from '../../src/shared/queues';
import { createRedis, redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import {
  judgeTurn,
  shouldJudgeTurn,
  CANARY_JUDGE_SPEC,
  type TurnJudgeJobData,
} from '../../src/core/turn-judge';
import type { JudgeClient, JudgeRequest } from '../../src/core/eval-judge';

const LIVE_PROMPT = 'You are the LIVE-MARKER Acme agent. Quote the 14-day return window.';
const LIVE_MODEL = 'live-model-1';
const CANARY_PROMPT = 'You are the CANARY-MARKER Acme agent. Quote the 30-day return window.';
const CANARY_MODEL = 'canary-model-2';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let convWorker: Worker;

// ---- stub Anthropic-compatible server ----
// It answers two DIFFERENT shapes on the same endpoint, which is the point: the
// judge rides the agent's own client (the A2 self-judge posture), so both the
// turn and its grading arrive here. A request carrying the report_verdicts tool
// is a judge call and is answered with a tool_use block; anything else is an
// ordinary turn and is echoed back as text.
let llmStub: Server;
let llmBaseUrl = '';
const turns: JudgeRequest[] = [];
const judgeCalls: JudgeRequest[] = [];

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as JudgeRequest & { messages: Array<{ content: unknown }> };
      const isJudge = (body.tools ?? []).some((t) => t.name === 'report_verdicts');
      res.setHeader('content-type', 'application/json');
      if (isJudge) {
        judgeCalls.push(body);
        res.end(
          JSON.stringify({
            id: 'msg_judge_1',
            type: 'message',
            role: 'assistant',
            model: body.model,
            content: [
              {
                type: 'tool_use',
                id: 'tu_1',
                name: 'report_verdicts',
                input: {
                  verdicts: [
                    { dim: 'groundedness', score: 4, verdict: 'pass', rationale: 'traced' },
                    { dim: 'tone', score: 5, verdict: 'pass', rationale: 'on voice' },
                  ],
                },
              },
            ],
            stop_reason: 'tool_use',
            usage: { input_tokens: 20, output_tokens: 8 },
          }),
        );
        return;
      }
      turns.push(body);
      const lastText = String(body.messages.at(-1)?.content ?? '').split(
        '\n\n<platform_reminder>',
      )[0];
      res.end(
        JSON.stringify({
          id: 'msg_stub_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: [{ type: 'text', text: `echo(${lastText})` }],
          stop_reason: 'end_turn',
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });
  });
  return new Promise((r) => llmStub.listen(0, '127.0.0.1', () => r()));
}

const json = (res: { body: string }) => JSON.parse(res.body);
const headers = () => ({ 'x-api-key': apiKey });

async function waitFor(pred: () => boolean | Promise<boolean>, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out');
}

let seq = 0;

/**
 * One real inbound turn, start to finish: the roll is pinned for the WHOLE
 * exchange, not just the HTTP request, because slice C rolls twice on two
 * different threads of control — the arm is rolled in the API request (when the
 * conversation opens) and the sampling coin is flipped in the WORKER after the
 * reply is delivered. Restoring the spy at the end of the request, the way
 * canary.test.ts can, would leave the second roll to chance.
 */
async function sendTurn(
  identifier: string,
  subscriberId: string,
  text: string,
  roll?: number,
): Promise<void> {
  const spy =
    roll === undefined ? null : vi.spyOn(Math, 'random').mockReturnValue(roll / 100);
  try {
    const mark = turns.length;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agents/${identifier}/messages`,
      headers: headers(),
      payload: { subscriberId, text, messageId: `cmp-m-${Date.now()}-${seq++}` },
    });
    expect(res.statusCode, res.body).toBe(202);
    // The wire proves the turn ran; the reply row proves it landed. The judge
    // enqueue happens immediately after delivery, so both are settled here.
    await waitFor(() => turns.slice(mark).some((r) => JSON.stringify(r.messages).includes(text)));
    await waitFor(async () => {
      const { rows } = await pool.query(
        `select 1 from conversation_messages m
           join conversations c on c.id = m.conversation_id
           join agents a on a.id = c.agent_id
          where a.identifier = $1 and m.role = 'agent' and m.content like $2`,
        [identifier, `%${text}%`],
      );
      return rows.length > 0;
    });
  } finally {
    spy?.mockRestore();
  }
}

const judgeQueue = () => getQueue(QUEUE.TURN_JUDGE);

async function judgeJobs(): Promise<TurnJudgeJobData[]> {
  const jobs = await judgeQueue().getJobs(['waiting', 'delayed', 'active', 'completed', 'failed']);
  return jobs.map((j) => j.data as TurnJudgeJobData);
}

async function drainJudgeQueue(): Promise<void> {
  await judgeQueue().obliterate({ force: true });
}

async function agentRow(identifier: string) {
  const { rows } = await pool.query(
    `select id, system_prompt, model, canary_version, canary_percent,
            canary_started_at, canary_sample_percent
       from agents where tenant_id = $1 and identifier = $2`,
    [tenantId, identifier],
  );
  return rows[0] as {
    id: string;
    system_prompt: string | null;
    model: string | null;
    canary_version: number | null;
    canary_sample_percent: number | null;
  };
}

const startCanary = (identifier: string, payload: Record<string, unknown>) =>
  app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/canary`,
    headers: headers(),
    payload,
  });

const stopCanary = (identifier: string) =>
  app.inject({ method: 'DELETE', url: `/v1/agents/${identifier}/canary`, headers: headers() });

const getReport = (identifier: string) =>
  app.inject({
    method: 'GET',
    url: `/v1/agents/${identifier}/canary/report`,
    headers: headers(),
  });

/** Live config = v1's content, v2 = the canary content. Same shape as slice B. */
async function seedVersionedAgent(identifier: string) {
  const created = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: headers(),
    payload: {
      identifier,
      name: identifier,
      runtime: 'managed',
      model: LIVE_MODEL,
      systemPrompt: LIVE_PROMPT,
      llm: { apiKey: 'zai-test-key-123456', baseUrl: llmBaseUrl },
    },
  });
  expect(created.statusCode, created.body).toBe(201);
  await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${identifier}`,
    headers: headers(),
    payload: { systemPrompt: CANARY_PROMPT, model: CANARY_MODEL },
  });
  await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/versions/1/restore`,
    headers: headers(),
  });
  return (await agentRow(identifier)).id;
}

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `cmp-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Comparison IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Comparison IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  await seedVersionedAgent('cmp-sample');
  await seedVersionedAgent('cmp-judge');
  await seedVersionedAgent('cmp-report');
  await seedVersionedAgent('cmp-fireforget');
  // The create route requires an LLM key for a managed agent, so the
  // no-credentials state is produced the way it actually occurs in the wild —
  // an agent whose sealed key is gone — rather than by a shape the API refuses
  // to make. buildManagedClient throws PermanentError on this one.
  await seedVersionedAgent('cmp-nocreds');
  await pool.query(
    `update agents set llm_credentials = null where tenant_id = $1 and identifier = 'cmp-nocreds'`,
    [tenantId],
  );

  await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: headers(),
    payload: {
      identifier: 'cmp-bridge',
      name: 'Comparison Bridge',
      runtime: 'bridge',
      bridgeUrl: llmBaseUrl,
    },
  });

  convWorker = new Worker(
    QUEUE.CONVERSATION,
    async (job: Job) => processConversation(job as Job<ConversationJobData>),
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

// ---------------------------------------------------------------------------

describe('A5 slice C: the sampling decision', () => {
  test('the roll is a percent, and 0 is an honest off switch', () => {
    // Boundaries pinned rather than hoped for: roll*100 < percent.
    expect(shouldJudgeTurn(20, 0.19)).toBe(true);
    expect(shouldJudgeTurn(20, 0.2)).toBe(false);
    expect(shouldJudgeTurn(20, 0.9)).toBe(false);
    expect(shouldJudgeTurn(100, 0.999)).toBe(true);
    // 0 = counters only. Never judge, whatever the roll says.
    expect(shouldJudgeTurn(0, 0)).toBe(false);
    expect(shouldJudgeTurn(0, 0.5)).toBe(false);
    // null = a trial started before sampling shipped — the default applies,
    // rather than the trial silently gathering no evidence at all.
    expect(shouldJudgeTurn(null, 0.19)).toBe(true);
    expect(shouldJudgeTurn(null, 0.5)).toBe(false);
  });
});

describe('A5 slice C: sampling real turns', () => {
  // Each test configures its OWN trial, so the previous one must be gone even
  // if an assertion failed mid-test — otherwise a single failure cascades into
  // a 409 on the next Start and every later test measures the wrong config.
  afterEach(async () => {
    await stopCanary('cmp-sample');
  });

  test('BOTH arms are sampled, at the same rate', async () => {
    await drainJudgeQueue();
    const start = await startCanary('cmp-sample', { version: 2, percent: 50, samplePercent: 100 });
    expect(start.statusCode, start.body).toBe(200);
    expect(json(start).agent.canary.samplePercent).toBe(100);

    // roll 10 → below percent 50 → canary arm. roll 90 → control arm.
    await sendTurn('cmp-sample', 'cmp-sub-canary', 'canary arm turn', 10);
    await sendTurn('cmp-sample', 'cmp-sub-control', 'control arm turn', 90);
    await waitFor(async () => (await judgeJobs()).length >= 2);

    const jobs = await judgeJobs();
    expect(jobs).toHaveLength(2);
    // The comparison only exists because both arms are graded the same way: one
    // job carries the trial version, the other carries none (the live prompt).
    expect(new Set(jobs.map((j) => j.canaryVersion))).toEqual(new Set([null, 2]));
  });

  test('samplePercent 0 runs the trial on counters alone', async () => {
    await drainJudgeQueue();
    const start = await startCanary('cmp-sample', { version: 2, percent: 50, samplePercent: 0 });
    expect(start.statusCode, start.body).toBe(200);
    expect((await agentRow('cmp-sample')).canary_sample_percent).toBe(0);

    await sendTurn('cmp-sample', 'cmp-sub-zero', 'unjudged turn', 10);
    // Nothing to wait FOR, so hold the assertion open: the enqueue would have
    // happened immediately after the reply landed, which sendTurn already
    // waited on.
    for (let i = 0; i < 10; i += 1) {
      expect(await judgeJobs()).toHaveLength(0);
      await new Promise((r) => setTimeout(r, 100));
    }
  });

  test('a missed roll judges nothing, an outside-the-trial thread judges nothing', async () => {
    await drainJudgeQueue();
    await startCanary('cmp-sample', { version: 2, percent: 99, samplePercent: 20 });
    // roll 90: inside the arm (99%), outside the sample (20%).
    await sendTurn('cmp-sample', 'cmp-sub-missed', 'sampled out turn', 90);
    expect(await judgeJobs()).toHaveLength(0);
    await stopCanary('cmp-sample');

    // With the trial over, a turn has no arm and nothing to compare — the
    // sampler must not keep spending the customer's LLM budget.
    await sendTurn('cmp-sample', 'cmp-sub-after', 'post trial turn', 1);
    expect(await judgeJobs()).toHaveLength(0);
  });
});

describe('A5 slice C: judging never delays the customer', () => {
  test('the reply still lands when the judge queue is broken', async () => {
    await drainJudgeQueue();
    await startCanary('cmp-fireforget', { version: 2, percent: 99, samplePercent: 100 });
    // getQueue memoizes, so this is the very instance the processor will use.
    const broken = vi
      .spyOn(judgeQueue(), 'add')
      .mockRejectedValue(new Error('redis is on fire'));
    try {
      // sendTurn itself asserts the agent reply row exists — i.e. the turn ran
      // to completion and was delivered with the judge enqueue failing under it.
      await sendTurn('cmp-fireforget', 'cmp-sub-ff', 'reply despite broken judging', 1);
      // Asserted BEFORE the restore: mockRestore drops the call history with
      // the implementation, so a check afterwards would always read zero.
      expect(broken).toHaveBeenCalled();
    } finally {
      broken.mockRestore();
    }
    expect(await judgeJobs()).toHaveLength(0);
    await stopCanary('cmp-fireforget');
  });
});

// ---------------------------------------------------------------------------

/** A judge client that records what it was asked and answers a fixed verdict. */
function stubJudge(): { client: JudgeClient; seen: JudgeRequest[] } {
  const seen: JudgeRequest[] = [];
  return {
    seen,
    client: {
      messages: {
        create: async (body: JudgeRequest) => {
          seen.push(body);
          return {
            content: [
              {
                type: 'tool_use',
                name: 'report_verdicts',
                input: {
                  verdicts: [
                    { dim: 'groundedness', score: 3, verdict: 'fail', rationale: 'invented' },
                    { dim: 'tone', score: 5, verdict: 'pass', rationale: 'warm' },
                  ],
                },
              },
            ],
          };
        },
      },
    },
  };
}

/** The newest agent reply row in a thread, with the ids the judge job carries. */
async function lastReply(identifier: string, subscriberId: string) {
  const { rows } = await pool.query(
    `select m.id as message_id, c.id as conversation_id, c.canary_arm,
            m.raw->>'canaryVersion' as served_version
       from conversation_messages m
       join conversations c on c.id = m.conversation_id
       join agents a        on a.id = c.agent_id
       join subscribers s   on s.id = c.subscriber_id
      where a.identifier = $1 and s.external_id = $2 and m.role = 'agent'
      order by m.created_at desc limit 1`,
    [identifier, subscriberId],
  );
  return rows[0] as {
    message_id: string;
    conversation_id: string;
    canary_arm: string | null;
    served_version: string | null;
  };
}

async function judgmentsFor(messageId: string) {
  const { rows } = await pool.query(
    `select dim, score, arm, canary_version, rationale
       from agent_turn_judgments where message_id = $1 order by dim`,
    [messageId],
  );
  return rows as Array<{
    dim: string;
    score: number;
    arm: string;
    canary_version: number | null;
    rationale: string;
  }>;
}

describe('A5 slice C: the judge job', () => {
  test('a canary turn is stored against the version that served it', async () => {
    await startCanary('cmp-judge', { version: 2, percent: 99, samplePercent: 100 });
    await sendTurn('cmp-judge', 'cmp-j-canary', 'judge me canary', 1);
    const reply = await lastReply('cmp-judge', 'cmp-j-canary');
    expect(reply.canary_arm).toBe('canary');
    expect(reply.served_version).toBe('2');

    const { client, seen } = stubJudge();
    const agent = await agentRow('cmp-judge');
    await judgeTurn(
      {
        tenantId,
        agentId: agent.id,
        conversationId: reply.conversation_id,
        messageId: reply.message_id,
        canaryVersion: 2,
      },
      { buildClient: async () => client },
    );

    const rows = await judgmentsFor(reply.message_id);
    expect(rows.map((r) => r.dim)).toEqual(['groundedness', 'tone']);
    expect(rows.map((r) => r.score)).toEqual([3, 5]);
    // Raw scores, no verdict column: a canary has no author-declared bar.
    expect(rows.every((r) => r.arm === 'canary' && r.canary_version === 2)).toBe(true);
    // The persona under test is the CANDIDATE one — grading a trial reply
    // against the live prompt would score the wrong question.
    expect(seen[0]?.model).toBe(CANARY_MODEL);
    expect(JSON.stringify(seen[0])).toContain('CANARY-MARKER');
    expect(JSON.stringify(seen[0])).not.toContain('LIVE-MARKER');
  });

  test('a canary-ARM turn that ran the LIVE prompt is stored as control', async () => {
    // The honest representation of the stopped-trial (and vanished-snapshot)
    // case: the thread is enrolled in the canary, but this reply was written by
    // the live prompt, so it is control evidence. Counting it as canary would
    // credit the trial version for words it never wrote.
    await sendTurn('cmp-judge', 'cmp-j-mixed', 'first canary turn', 1);
    const enrolled = await lastReply('cmp-judge', 'cmp-j-mixed');
    expect(enrolled.canary_arm).toBe('canary');

    const { client } = stubJudge();
    const agent = await agentRow('cmp-judge');
    await judgeTurn(
      {
        tenantId,
        agentId: agent.id,
        conversationId: enrolled.conversation_id,
        messageId: enrolled.message_id,
        // What ACTUALLY served it — the live prompt.
        canaryVersion: null,
      },
      { buildClient: async () => client },
    );
    const rows = await judgmentsFor(enrolled.message_id);
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.arm === 'control' && r.canary_version === null)).toBe(true);
  });

  test('re-running the job cannot double-count a reply', async () => {
    const reply = await lastReply('cmp-judge', 'cmp-j-canary');
    const before = await judgmentsFor(reply.message_id);
    expect(before).toHaveLength(2);

    const { client } = stubJudge();
    const agent = await agentRow('cmp-judge');
    const data: TurnJudgeJobData = {
      tenantId,
      agentId: agent.id,
      conversationId: reply.conversation_id,
      messageId: reply.message_id,
      canaryVersion: 2,
    };
    // A retried BullMQ attempt re-judges and lands on unique (message_id, dim).
    await judgeTurn(data, { buildClient: async () => client });
    await judgeTurn(data, { buildClient: async () => client });
    const after = await judgmentsFor(reply.message_id);
    expect(after).toHaveLength(2);
    // The FIRST verdict stands — a later re-judge cannot rewrite the evidence.
    expect(after.map((r) => r.score)).toEqual(before.map((r) => r.score));
  });

  test('missing credentials degrade to a skip, never a throw', async () => {
    await startCanary('cmp-nocreds', { version: 2, percent: 99, samplePercent: 100 });
    const agent = await agentRow('cmp-nocreds');
    // A conversation of its own so the assertion is about this agent alone.
    const { rows } = await pool.query(
      `insert into conversations (tenant_id, agent_id, subscriber_id, channel, thread_key, canary_arm)
       select $1, $2, s.id, 'inapp', 'nocreds-thread', 'canary'
         from subscribers s where s.tenant_id = $1 limit 1
       returning id`,
      [tenantId, agent.id],
    );
    const conversationId = rows[0].id as string;
    const msg = await pool.query(
      `insert into conversation_messages (conversation_id, tenant_id, role, content, dedupe_key)
       values ($1,$2,'agent','a reply nobody can grade','nocreds-reply-1') returning id`,
      [conversationId, tenantId],
    );
    const messageId = msg.rows[0].id as string;

    // The real buildManagedClient — this agent has no sealed key, so it throws
    // PermanentError. The job must swallow it: retrying a misconfigured agent
    // just bills someone for the same failure five more times.
    await expect(
      judgeTurn({ tenantId, agentId: agent.id, conversationId, messageId, canaryVersion: null }),
    ).resolves.toBeUndefined();
    expect(await judgmentsFor(messageId)).toHaveLength(0);
    await stopCanary('cmp-nocreds');
  });

  test('the real judge call carries the transcript, both dims, and the served model', async () => {
    // Wire capture through the agent's OWN client (no stub injection): this is
    // the whole judging path, end to end, against the stub Anthropic server.
    const reply = await lastReply('cmp-judge', 'cmp-j-canary');
    await pool.query('delete from agent_turn_judgments where message_id = $1', [reply.message_id]);
    const mark = judgeCalls.length;
    const agent = await agentRow('cmp-judge');
    await judgeTurn({
      tenantId,
      agentId: agent.id,
      conversationId: reply.conversation_id,
      messageId: reply.message_id,
      canaryVersion: 2,
    });
    const call = judgeCalls[mark];
    expect(call, 'the judge call never reached the wire').toBeTruthy();

    const wire = JSON.stringify(call);
    // The evidence window: the customer's own words are in the transcript...
    expect(wire).toContain('judge me canary');
    // ...and BOTH scored dimensions were requested, but never refusal — real
    // traffic carries no author declaring which way the reply should have gone.
    expect(wire).toContain('groundedness');
    expect(wire).toContain('tone');
    expect(wire).not.toContain('refusal (verdict only');
    expect(CANARY_JUDGE_SPEC).toEqual({ groundedness: true, tone: {} });
    // Forced tool, so the verdict is parseable rather than prose.
    expect(call?.tool_choice).toEqual({ type: 'tool', name: 'report_verdicts' });
    // The model that SERVED the turn — and its temperature predicate with it.
    expect(call?.model).toBe(CANARY_MODEL);
    expect(call?.temperature).toBe(0);

    const rows = await judgmentsFor(reply.message_id);
    expect(rows.map((r) => r.score)).toEqual([4, 5]);
    await stopCanary('cmp-judge');
  });
});

// ---------------------------------------------------------------------------

describe('A5 slice C: the report', () => {
  let reportAgentId = '';
  let subscriberId = '';

  /**
   * A KNOWN fixture, written straight to the tables, so every number in the
   * assertions below is arithmetic rather than a guess about what the pipeline
   * happened to produce.
   */
  async function seedFixture() {
    const conv = async (thread: string, arm: string, status: string, hadHuman: boolean) => {
      const { rows } = await pool.query(
        `insert into conversations
           (tenant_id, agent_id, subscriber_id, channel, thread_key, canary_arm, status, had_human)
         values ($1,$2,$3,'inapp',$4,$5,$6,$7) returning id`,
        [tenantId, reportAgentId, subscriberId, thread, arm, status, hadHuman],
      );
      return rows[0].id as string;
    };
    const turn = async (
      conversationId: string,
      key: string,
      raw: Record<string, unknown> | null,
      role = 'agent',
    ) => {
      const { rows } = await pool.query(
        `insert into conversation_messages (conversation_id, tenant_id, role, content, dedupe_key, raw)
         values ($1,$2,$3,'text',$4,$5) returning id`,
        [conversationId, tenantId, role, key, raw ? JSON.stringify(raw) : null],
      );
      return rows[0].id as string;
    };
    const usage = (i: number, o: number) => ({ usage: { inputTokens: i, outputTokens: o } });
    // agent_tool_calls.dedupe_key is unique across the WHOLE table, not per
    // tenant, so a fixture key has to be unique per run — everything else here
    // is scoped to this run's freshly signed-up tenant and cannot collide.
    const run = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const call = async (conversationId: string, key: string, paused: boolean) => {
      await pool.query(
        `insert into agent_tool_calls
           (tenant_id, agent_id, conversation_id, tool_name, args, dedupe_key, status, expires_at)
         values ($1,$2,$3,'refund','{}',$4,'executed',$5)`,
        [
          tenantId,
          reportAgentId,
          conversationId,
          `${key}-${run}`,
          // Only the approval-required path stamps an expiry at insert, so this
          // is what separates a call that PAUSED from an ordinary auto call —
          // their final status is identical ('executed') either way.
          paused ? new Date(Date.now() + 8.64e7) : null,
        ],
      );
    };

    // --- control arm: 3 conversations, 2 resolved, 1 handed off ---
    const a = await conv('rep-ctl-a', 'control', 'resolved', false);
    const b = await conv('rep-ctl-b', 'control', 'resolved', true);
    await conv('rep-ctl-c', 'control', 'active', false);
    await turn(a, 'ctl-a-1', usage(10, 5));
    await turn(a, 'ctl-a-2', usage(20, 10));
    await turn(b, 'ctl-b-1', usage(30, 20));
    // A user row and a PLATFORM-authored row: neither is a model turn, and the
    // huge usage on the platform note would wreck the average if counted.
    await turn(a, 'ctl-a-user', null, 'user');
    await turn(a, 'ctl-a-note', { ...usage(999, 999), platformNote: true });
    await call(a, 'rep-call-1', true); // a guard pause
    await call(a, 'rep-call-2', false); // an ordinary auto call

    // --- canary arm: 2 conversations, 1 resolved, 1 handed off ---
    const d = await conv('rep-can-d', 'canary', 'resolved', false);
    const e = await conv('rep-can-e', 'canary', 'waiting_human', true);
    const d1 = await turn(d, 'can-d-1', { ...usage(10, 5), canaryVersion: 2 });
    await turn(d, 'can-d-2', { ...usage(12, 8), canaryVersion: 2 });
    // THE ATTRIBUTION CASE: enrolled in the canary arm, but served by the live
    // prompt (no canaryVersion stamp) — this turn belongs to CONTROL.
    await turn(e, 'can-e-1', usage(100, 100));
    await call(d, 'rep-call-3', true);

    const judgment = async (
      conversationId: string,
      messageId: string,
      arm: string,
      version: number | null,
      dim: string,
      score: number,
    ) => {
      await pool.query(
        `insert into agent_turn_judgments
           (tenant_id, agent_id, conversation_id, message_id, arm, canary_version, dim, score, rationale)
         values ($1,$2,$3,$4,$5,$6,$7,$8,'seeded')`,
        [tenantId, reportAgentId, conversationId, messageId, arm, version, dim, score],
      );
    };
    // Judgments hang off distinct messages (unique (message_id, dim)).
    const m1 = await turn(d, 'jm-1', { canaryVersion: 2, ...usage(1, 1) });
    const m2 = await turn(d, 'jm-2', { canaryVersion: 2, ...usage(1, 1) });
    const m3 = await turn(a, 'jm-3', usage(1, 1));
    const m4 = await turn(a, 'jm-4', usage(1, 1));
    await judgment(d, d1, 'canary', 2, 'groundedness', 4);
    await judgment(d, m1, 'canary', 2, 'groundedness', 5);
    await judgment(d, m2, 'canary', 2, 'tone', 3);
    await judgment(a, m3, 'control', null, 'groundedness', 3);
    await judgment(a, m4, 'control', null, 'groundedness', 4);
    // A leftover from a PREVIOUS trial of a different version: scoping by
    // canary_version is what keeps it out of this trial's average.
    await judgment(d, await turn(d, 'jm-old', null), 'canary', 99, 'groundedness', 1);
  }

  beforeAll(async () => {
    reportAgentId = (await agentRow('cmp-report')).id;
    const sub = await pool.query(
      `insert into subscribers (tenant_id, external_id) values ($1,'cmp-report-sub')
       on conflict (tenant_id, external_id) do update set external_id = excluded.external_id
       returning id`,
      [tenantId],
    );
    subscriberId = sub.rows[0].id as string;
    // The trial must start BEFORE the fixture rows exist: started_at is the
    // window floor every aggregate is scoped by.
    const start = await startCanary('cmp-report', { version: 2, percent: 40, samplePercent: 25 });
    expect(start.statusCode, start.body).toBe(200);
    await seedFixture();
  });

  test('per-arm counters aggregate exactly', async () => {
    const res = await getReport('cmp-report');
    expect(res.statusCode, res.body).toBe(200);
    const report = json(res);
    expect(report.version).toBe(2);
    expect(report.percent).toBe(40);
    expect(report.samplePercent).toBe(25);

    const arm = (name: string) =>
      report.arms.find((a: { arm: string }) => a.arm === name) as Record<string, number>;

    // Conversations/resolutions/handoffs follow ENROLLMENT — they are
    // properties of a thread, which was assigned exactly once.
    expect(arm('control').conversations).toBe(3);
    expect(arm('control').resolutions).toBe(2);
    expect(arm('control').handoffs).toBe(1);
    expect(arm('canary').conversations).toBe(2);
    expect(arm('canary').resolutions).toBe(1);
    expect(arm('canary').handoffs).toBe(1);

    // Turns follow WHAT SERVED THEM, not what the thread was enrolled in. The
    // canary-arm turn carrying no canaryVersion stamp (the stopped-trial /
    // vanished-snapshot case) lands in CONTROL — this single assertion is the
    // attribution rule. Control: ctl-a-1, ctl-a-2, ctl-b-1, the mis-armed
    // can-e-1, jm-3, jm-4, jm-old = 7. Canary: can-d-1, can-d-2, jm-1, jm-2 = 4.
    // The user row and the platform note are not model turns and are counted in
    // neither arm.
    expect(arm('canary').turns).toBe(4);
    expect(arm('control').turns).toBe(7);

    // A guard pause is a tool call that stopped for a human — the auto call
    // beside it is not one.
    expect(arm('control').guardPauses).toBe(1);
    expect(arm('canary').guardPauses).toBe(1);

    // canary turns: 15, 20, 2, 2 → 39/4 = 9.75 → 10
    expect(arm('canary').avgTokensPerTurn).toBe(10);
    // control: 15, 30, 50, 200 (the mis-armed one), 2, 2 → 299/6 = 49.83 → 50.
    // Divided by SIX, not by the seven turns above: jm-old recorded no usage,
    // and the average is over the turns that actually reported it rather than
    // over all turns, which would silently understate the arm.
    expect(arm('control').avgTokensPerTurn).toBe(50);
  });

  test('judged averages are per arm per dim, scoped to THIS trial', async () => {
    const report = json(await getReport('cmp-report'));
    const arm = (name: string) =>
      report.arms.find((a: { arm: string }) => a.arm === name) as {
        judged: Record<string, { avg: number; n: number }>;
      };

    expect(arm('canary').judged.groundedness.n).toBe(2);
    expect(arm('canary').judged.groundedness.avg).toBeCloseTo(4.5, 5);
    expect(arm('canary').judged.tone).toEqual({ avg: 3, n: 1 });
    expect(arm('control').judged.groundedness.n).toBe(2);
    expect(arm('control').judged.groundedness.avg).toBeCloseTo(3.5, 5);
    // The previous trial's row (version 99, score 1) would have dragged the
    // canary average to 3.33 if the scope predicate were missing.
    expect(arm('control').judged.tone).toBeUndefined();
  });

  test('an arm with nothing judged yet reports an empty object, not a zero', async () => {
    // An honest empty state matters: 0.0 avg would read as "the canary is
    // terrible" when it means "nothing has been graded".
    await startCanary('cmp-fireforget', { version: 2, percent: 50, samplePercent: 20 });
    const report = json(await getReport('cmp-fireforget'));
    for (const a of report.arms) expect(a.judged).toEqual({});
    expect(report.arms).toHaveLength(2);
    await stopCanary('cmp-fireforget');
  });

  test('guards: managed-only, current-trial-only, and unknown agents', async () => {
    const bridge = await getReport('cmp-bridge');
    expect(bridge.statusCode).toBe(400);
    expect(json(bridge).error).toContain('managed agent');

    const none = await getReport('cmp-sample');
    expect(none.statusCode).toBe(404);
    expect(json(none).error).toContain('no canary');

    const missing = await getReport('cmp-nope');
    expect(missing.statusCode).toBe(404);

    const anon = await app.inject({ method: 'GET', url: '/v1/agents/cmp-report/canary/report' });
    expect(anon.statusCode).toBe(401);
  });
});
