/**
 * Phase A5 slice B — CANARY: one stored prompt version put on trial against a
 * slice of REAL conversations before it takes over.
 *
 * Real app in-process, real Postgres, a real BullMQ conversation worker and a
 * stub Anthropic-compatible server that records every request — so each claim
 * is checked at the wire, not at the intention. The properties:
 *   1. no trial running → conversations open with a null arm (nothing changes);
 *   2. a trial assigns the arm ONCE, at open, by the configured percent — and
 *      it STICKS: later turns in the same thread never re-roll;
 *   3. a canary-arm turn puts the TRIAL version's prompt + model on the wire
 *      while a control-arm turn puts the LIVE one there;
 *   4. eval-run conversations never join a trial (a run must grade the config
 *      it was asked to grade, not a blend of two);
 *   5. STOP reverts even already-enrolled threads at their very next turn;
 *   6. PROMOTE makes the trial version live through the restore path (a NEW
 *      version row) and ends the trial;
 *   7. the guards: managed-only, percent 1-99, version must exist, one trial.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test, vi } from 'vitest';
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

// Distinctive markers rather than whole-string equality: the system block is
// assembled from the prompt plus scaffolding, so "which prompt is in there" is
// the honest question — and "the other one is NOT" is the half that matters.
const LIVE_PROMPT = 'You are the LIVE-MARKER Acme agent. Quote the 14-day return window.';
const LIVE_MODEL = 'live-model-1';
const CANARY_PROMPT = 'You are the CANARY-MARKER Acme agent. Quote the 30-day return window.';
const CANARY_MODEL = 'canary-model-2';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let agentId = '';
let promoteAgentId = '';
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

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as SeenRequest;
      seen.push(body);
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
const headers = () => ({ 'x-api-key': apiKey });

async function waitFor(pred: () => boolean, ms = 20_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (pred()) return;
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error('timed out waiting for the turn to reach the model stub');
}

/**
 * Pin THE arm roll for the duration of one call. The repo rolls with
 * `Math.random() * 100`, so a pinned value makes the percent boundary exactly
 * checkable instead of statistically hoped for. Safe to stub globally here:
 * the only other `Math.random` on this path is BullMQ's backoff jitter
 * (src/shared/queues.ts), where a pinned value just means minimum jitter.
 */
async function withRoll<T>(roll: number, fn: () => Promise<T>): Promise<T> {
  const spy = vi.spyOn(Math, 'random').mockReturnValue(roll / 100);
  try {
    return await fn();
  } finally {
    spy.mockRestore();
  }
}

let seq = 0;

/**
 * One real inbound turn through the public messages route. `roll` pins the arm
 * roll for the request itself — which is where the conversation is opened, and
 * therefore the only moment the roll can matter.
 */
async function sendTurn(
  identifier: string,
  subscriberId: string,
  text: string,
  roll?: number,
): Promise<SeenRequest> {
  const mark = seen.length;
  const inject = () =>
    app.inject({
      method: 'POST',
      url: `/v1/agents/${identifier}/messages`,
      headers: headers(),
      payload: { subscriberId, text, messageId: `canary-m-${Date.now()}-${seq++}` },
    });
  const res = roll === undefined ? await inject() : await withRoll(roll, inject);
  expect(res.statusCode, res.body).toBe(202);
  await waitFor(() => seen.slice(mark).some((r) => JSON.stringify(r.messages).includes(text)));
  return seen.slice(mark).find((r) => JSON.stringify(r.messages).includes(text))!;
}

/** The stored arm for a thread, straight from the row — no view can gloss it. */
async function armOf(agent: string, subscriberId: string): Promise<string | null> {
  const { rows } = await pool.query(
    `select c.canary_arm
       from conversations c
       join subscribers s on s.id = c.subscriber_id
       join agents a      on a.id = c.agent_id
      where c.tenant_id = $1 and s.external_id = $2 and a.identifier = $3`,
    [tenantId, subscriberId, agent],
  );
  return rows[0]?.canary_arm ?? null;
}

async function agentRow(identifier: string) {
  const { rows } = await pool.query(
    `select id, prompt_version, system_prompt, model,
            canary_version, canary_percent, canary_started_at
       from agents where tenant_id = $1 and identifier = $2`,
    [tenantId, identifier],
  );
  return rows[0] as {
    id: string;
    prompt_version: number;
    system_prompt: string | null;
    model: string | null;
    canary_version: number | null;
    canary_percent: number | null;
    canary_started_at: string | null;
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

const promoteCanary = (identifier: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/canary/promote`,
    headers: headers(),
  });

/**
 * Build a managed agent whose LIVE config is v1's content and whose v2 holds
 * the canary content — so a trial on v2 is a genuinely different brain from
 * live. Restore is used to get back to v1's content, which mints v3: exactly
 * the append-only history slice A established.
 */
async function seedVersionedAgent(identifier: string) {
  await app.inject({
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
  // v2 = the future canary
  await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${identifier}`,
    headers: headers(),
    payload: { systemPrompt: CANARY_PROMPT, model: CANARY_MODEL },
  });
  // v3 = v1's content back on top, so live ≠ the trial version
  await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/versions/1/restore`,
    headers: headers(),
  });
  const row = await agentRow(identifier);
  expect(row.system_prompt).toBe(LIVE_PROMPT);
  expect(row.model).toBe(LIVE_MODEL);
  return row.id;
}

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `canary-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Canary IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Canary IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  agentId = await seedVersionedAgent('can-agent');
  promoteAgentId = await seedVersionedAgent('can-promote');

  // A bridge agent for the managed-only guards. Real reachable loopback URL
  // (the create route SSRF-checks it) but never dialed: every canary request
  // against it is refused before anything runs.
  await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: headers(),
    payload: {
      identifier: 'can-bridge',
      name: 'Canary Bridge',
      runtime: 'bridge',
      bridgeUrl: llmBaseUrl,
    },
  });

  // A deterministic eval (no judge needed) for the eval-driver opt-out check.
  await app.inject({
    method: 'POST',
    url: '/v1/agents/can-agent/evals',
    headers: headers(),
    payload: {
      name: 'greeting',
      scenario: { turns: [{ user: 'hi there' }, { expect: { replyContains: 'echo' } }] },
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

describe('A5 canary: the arm is decided once, at open', () => {
  test('with no trial running, conversations open with no arm at all', async () => {
    const req = await sendTurn('can-agent', 'no-canary-user', 'hello with no trial', 0);
    // Even a roll of 0 — which would land in the canary arm under any trial —
    // assigns nothing when there is no trial to join.
    expect(await armOf('can-agent', 'no-canary-user')).toBeNull();
    expect(JSON.stringify(req.system)).toContain('LIVE-MARKER');
  }, 30_000);

  test('starting a trial: the percent decides the arm, at the boundary', async () => {
    const started = await startCanary('can-agent', { version: 2, percent: 50 });
    expect(started.statusCode, started.body).toBe(200);
    expect(json(started).agent.canary).toMatchObject({ version: 2, percent: 50 });

    // The rule is `roll < percent`, so 49.9 is inside the arm and 50 is not —
    // checked at the boundary rather than somewhere comfortably far from it.
    await sendTurn('can-agent', 'boundary-in', 'inside the split', 49.9);
    expect(await armOf('can-agent', 'boundary-in')).toBe('canary');

    await sendTurn('can-agent', 'boundary-out', 'outside the split', 50);
    expect(await armOf('can-agent', 'boundary-out')).toBe('control');
  }, 60_000);

  test('the arm STICKS: a second turn never re-rolls it', async () => {
    // Opened deep inside the canary arm…
    const first = await sendTurn('can-agent', 'sticky-user', 'first turn of the thread', 0);
    expect(await armOf('can-agent', 'sticky-user')).toBe('canary');
    expect(JSON.stringify(first.system)).toContain('CANARY-MARKER');

    // …and a second turn rolled at a value that would mean CONTROL for a fresh
    // conversation. The thread keeps the arm it opened with, and the wire
    // proves it: the customer does not meet a second personality mid-thread.
    const second = await sendTurn('can-agent', 'sticky-user', 'second turn of the thread', 99);
    expect(await armOf('can-agent', 'sticky-user')).toBe('canary');
    expect(JSON.stringify(second.system)).toContain('CANARY-MARKER');
    expect(JSON.stringify(second.system)).not.toContain('LIVE-MARKER');
  }, 60_000);
});

describe('A5 canary: what actually reaches the model', () => {
  test('canary arm gets the trial version; control arm gets the live one', async () => {
    const canary = await sendTurn('can-agent', 'wire-canary', 'trial side please', 0);
    expect(await armOf('can-agent', 'wire-canary')).toBe('canary');
    expect(JSON.stringify(canary.system)).toContain('CANARY-MARKER');
    expect(JSON.stringify(canary.system)).not.toContain('LIVE-MARKER');
    expect(canary.model).toBe(CANARY_MODEL);

    const control = await sendTurn('can-agent', 'wire-control', 'live side please', 99);
    expect(await armOf('can-agent', 'wire-control')).toBe('control');
    expect(JSON.stringify(control.system)).toContain('LIVE-MARKER');
    expect(JSON.stringify(control.system)).not.toContain('CANARY-MARKER');
    expect(control.model).toBe(LIVE_MODEL);
  }, 60_000);

  test('the served version is stamped on the reply row, per turn', async () => {
    // The conversation's arm cannot answer "which config served THIS turn"
    // (see the stop test below), so attribution is recorded per reply.
    const { rows } = await pool.query(
      `select m.raw
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
         join subscribers s   on s.id = c.subscriber_id
        where s.external_id = $1 and m.role = 'agent'
        order by m.created_at desc limit 1`,
      ['wire-canary'],
    );
    expect(rows[0]?.raw?.canaryVersion).toBe(2);
  }, 30_000);

  test('eval-run conversations never join the trial', async () => {
    const before = new Date().toISOString();
    const started = await app.inject({
      method: 'POST',
      url: '/v1/agents/can-agent/evals/run',
      headers: headers(),
      payload: { trigger: 'manual' },
    });
    expect(started.statusCode, started.body).toBe(202);

    // Pinned at a roll of 0 for the WHOLE run: if the driver did not opt out,
    // every one of its conversations would land in the canary arm.
    await withRoll(0, () =>
      processEvalRun({ data: { runId: json(started).runId } } as Job<{ runId: string }>),
    );

    const { rows } = await pool.query(
      `select canary_arm from conversations
        where agent_id = $1 and created_at >= $2`,
      [agentId, before],
    );
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.canary_arm === null)).toBe(true);
  }, 60_000);
});

describe('A5 canary: stopping and promoting', () => {
  test('STOP puts an already-enrolled thread back on the live prompt next turn', async () => {
    const before = await sendTurn('can-agent', 'stop-user', 'turn under the trial', 0);
    expect(await armOf('can-agent', 'stop-user')).toBe('canary');
    expect(JSON.stringify(before.system)).toContain('CANARY-MARKER');

    const stopped = await stopCanary('can-agent');
    expect(stopped.statusCode, stopped.body).toBe(200);
    expect(json(stopped).agent.canary).toBeNull();
    const row = await agentRow('can-agent');
    expect(row.canary_version).toBeNull();
    expect(row.canary_percent).toBeNull();
    expect(row.canary_started_at).toBeNull();

    // The thread keeps its arm — it records what it was ENROLLED in — but the
    // rejected prompt stops serving immediately, including here.
    const after = await sendTurn('can-agent', 'stop-user', 'turn after the stop');
    expect(await armOf('can-agent', 'stop-user')).toBe('canary');
    expect(JSON.stringify(after.system)).toContain('LIVE-MARKER');
    expect(JSON.stringify(after.system)).not.toContain('CANARY-MARKER');
    expect(after.model).toBe(LIVE_MODEL);
  }, 60_000);

  test('PROMOTE makes the trial version live as a NEW version, and ends the trial', async () => {
    const beforeRow = await agentRow('can-promote');
    const started = await startCanary('can-promote', { version: 2, percent: 25 });
    expect(started.statusCode, started.body).toBe(200);

    const res = await promoteCanary('can-promote');
    expect(res.statusCode, res.body).toBe(200);
    expect(json(res).promotedFrom).toBe(2);

    const after = await agentRow('can-promote');
    // The trial version's content is live…
    expect(after.system_prompt).toBe(CANARY_PROMPT);
    expect(after.model).toBe(CANARY_MODEL);
    // …carried there by the restore path, so it is a NEW version, not a rewind.
    expect(after.prompt_version).toBe(beforeRow.prompt_version + 1);
    expect(json(res).version).toBe(after.prompt_version);
    const { rows } = await pool.query(
      'select system_prompt, model from agent_prompt_versions where agent_id = $1 and version = $2',
      [promoteAgentId, after.prompt_version],
    );
    expect(rows[0]).toMatchObject({ system_prompt: CANARY_PROMPT, model: CANARY_MODEL });
    // …and the trial is over.
    expect(after.canary_version).toBeNull();
    expect(after.canary_percent).toBeNull();
    expect(after.canary_started_at).toBeNull();
    const view = await app.inject({
      method: 'GET',
      url: '/v1/agents/can-promote',
      headers: headers(),
    });
    expect(json(view).agent.canary).toBeNull();
  }, 60_000);

  test('a new conversation after the promote is arm-null again', async () => {
    await sendTurn('can-promote', 'post-promote-user', 'after promotion', 0);
    expect(await armOf('can-promote', 'post-promote-user')).toBeNull();
  }, 30_000);
});

describe('A5 canary: the guards', () => {
  test('a bridge agent is refused on all three routes', async () => {
    for (const res of [
      await startCanary('can-bridge', { version: 1, percent: 10 }),
      await stopCanary('can-bridge'),
      await promoteCanary('can-bridge'),
    ]) {
      expect(res.statusCode).toBe(400);
      expect(json(res).error).toMatch(/managed/i);
    }
  });

  test('percent must be a whole number strictly inside 1-99', async () => {
    for (const percent of [0, 100, 101, -5, 10.5]) {
      const res = await startCanary('can-agent', { version: 2, percent });
      expect(res.statusCode, `percent ${percent}`).toBe(400);
    }
    // …and the rejected attempts started nothing.
    expect((await agentRow('can-agent')).canary_version).toBeNull();
  });

  test('a version that does not exist is a 404', async () => {
    const res = await startCanary('can-agent', { version: 9999, percent: 10 });
    expect(res.statusCode).toBe(404);
    expect(json(res).error).toBe('unknown version');
  });

  test('a second trial on the same agent is a 409', async () => {
    const first = await startCanary('can-agent', { version: 2, percent: 10 });
    expect(first.statusCode, first.body).toBe(200);

    const second = await startCanary('can-agent', { version: 3, percent: 20 });
    expect(second.statusCode).toBe(409);
    expect(json(second).error).toMatch(/already running/i);

    // The 409 changed nothing: the FIRST trial is still the one running.
    const row = await agentRow('can-agent');
    expect(row.canary_version).toBe(2);
    expect(row.canary_percent).toBe(10);

    await stopCanary('can-agent');
  });

  test('promoting with no trial running is a 404', async () => {
    const res = await promoteCanary('can-agent');
    expect(res.statusCode).toBe(404);
    expect(json(res).error).toMatch(/no canary/i);
  });

  test('stopping when nothing is running is a harmless no-op', async () => {
    const res = await stopCanary('can-agent');
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.canary).toBeNull();
  });
});
