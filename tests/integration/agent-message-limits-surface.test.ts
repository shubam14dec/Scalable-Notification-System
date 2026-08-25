/**
 * Phase A8 slice B — the SURFACE of the per-customer message limit: the API that
 * configures it, the view that reads it back, the bounds it borrows from core,
 * and the one place it deliberately does NOT appear.
 *
 * No LLM stub and no worker here, for the reason the A7 surface file states:
 * slice A already proves what the limit DOES through the real turn path
 * (tests/integration/subscriber-rate). What is unproven until this file is that
 * an operator can put a limit in, read it back unchanged, and take it out again
 * — and two claims that are about this slice specifically rather than about
 * behavior:
 *
 *   1. IT WORKS ON BOTH RUNTIMES. Every other per-agent config (routing, topics,
 *      moderation) answers 400 on a bridge agent, because those configure a
 *      brain we run. This one is ingress protection — a flood costs a bridge
 *      agent its own compute — so a bridge agent may hold it. The gates' 400 is
 *      asserted alongside it in the same test, because "both are accepted" would
 *      pass just as well if someone had quietly dropped the gates' guard.
 *
 *   2. IT IS NOT GRADEABLE. `subscriberRate` is absent from the eval candidate
 *      on purpose (an eval scenario is a burst from one synthetic subscriber by
 *      construction, so a gradeable limit would throttle the check itself and
 *      report the limiter as the prompt). Absence is only a decision if it is
 *      asserted; otherwise the next person to read CandidateSchema fixes it.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { CandidateSchema } from '../../src/api/routes/agent-evals';
import {
  MAX_MESSAGES_MAX,
  MAX_MESSAGES_MIN,
  NOTICE_MAX,
  WINDOW_MINUTES_MAX,
  WINDOW_MINUTES_MIN,
} from '../../src/core/subscriber-rate';

let app: FastifyInstance;
let apiKey = '';

const json = (res: { body: string }) => JSON.parse(res.body);

const authed = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-api-key': apiKey }, ...(payload ? { payload } : {}) });

interface RateLimitedAgentView {
  runtime: 'bridge' | 'managed';
  subscriberRate: { maxMessages: number; windowMinutes: number; notice: string } | null;
  topics: unknown | null;
  moderation: unknown | null;
}

async function agentView(identifier: string): Promise<RateLimitedAgentView> {
  const res = await authed('GET', `/v1/agents/${identifier}`);
  expect(res.statusCode).toBe(200);
  return json(res).agent as RateLimitedAgentView;
}

const RATE = {
  maxMessages: 20,
  windowMinutes: 5,
  notice: "You're sending messages faster than I can answer — I'll pick this up shortly.",
};

beforeAll(async () => {
  app = await buildApp();
  const email = `msg-limits-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Message Limits IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Message Limits IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;

  await authed('POST', '/v1/agents', {
    identifier: 'limit-agent',
    name: 'Limit Agent',
    runtime: 'managed',
    model: 'limit-model-1',
    systemPrompt: 'You are the Acme support agent. Be brief.',
    llm: { apiKey: 'zai-test-key-123456' },
  });
  await authed('POST', '/v1/agents', {
    identifier: 'limit-bridge',
    name: 'Limit Bridge',
    runtime: 'bridge',
    bridgeUrl: 'https://example.com/agent',
  });
});

afterAll(async () => {
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('A8 slice B: putting a message limit in and taking it out', () => {
  test('a new agent has no limit — the field is null, not missing', async () => {
    const view = await agentView('limit-agent');
    expect(view).toHaveProperty('subscriberRate');
    expect(view.subscriberRate).toBeNull();
  });

  test('PATCH accepts the limit and the agent view carries it back', async () => {
    const res = await authed('PATCH', '/v1/agents/limit-agent', { subscriberRate: RATE });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.subscriberRate).toEqual(RATE);
    expect((await agentView('limit-agent')).subscriberRate).toEqual(RATE);
  });

  test('an unrelated PATCH leaves the limit exactly where it was', async () => {
    const res = await authed('PATCH', '/v1/agents/limit-agent', { name: 'Limit Agent Renamed' });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.subscriberRate).toEqual(RATE);
  });

  test('a provided object REPLACES the whole config — no field-level merge', async () => {
    const next = { maxMessages: 3, windowMinutes: 2, notice: 'Give me a moment to catch up.' };
    const res = await authed('PATCH', '/v1/agents/limit-agent', { subscriberRate: next });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.subscriberRate).toEqual(next);
  });

  test('null clears it back to never-configured', async () => {
    const res = await authed('PATCH', '/v1/agents/limit-agent', { subscriberRate: null });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.subscriberRate).toBeNull();
    expect((await agentView('limit-agent')).subscriberRate).toBeNull();
  });

  test('create carries a limit from the very first message the agent ever sees', async () => {
    const res = await authed('POST', '/v1/agents', {
      identifier: 'limit-at-birth',
      name: 'Limit At Birth',
      runtime: 'managed',
      model: 'limit-model-1',
      systemPrompt: 'Be brief.',
      llm: { apiKey: 'zai-test-key-123456' },
      subscriberRate: RATE,
    });
    expect(res.statusCode).toBe(201);
    expect(json(res).agent.subscriberRate).toEqual(RATE);
    expect((await agentView('limit-at-birth')).subscriberRate).toEqual(RATE);
  });
});

describe('A8 slice B: the one config a BRIDGE agent may hold', () => {
  test('a bridge agent takes a message limit while both gates still refuse it', async () => {
    const rate = await authed('PATCH', '/v1/agents/limit-bridge', { subscriberRate: RATE });
    expect(rate.statusCode).toBe(200);
    expect(json(rate).agent.subscriberRate).toEqual(RATE);

    // The contrast is the assertion. "The limit is accepted" would pass just as
    // well on a build where someone had dropped the gates' managed-only guard,
    // and then this file would be proving nothing about the difference.
    const topics = await authed('PATCH', '/v1/agents/limit-bridge', {
      topics: { deny: ['medical advice'], redirect: 'Not here, sorry.' },
    });
    expect(topics.statusCode).toBe(400);
    const moderation = await authed('PATCH', '/v1/agents/limit-bridge', {
      moderation: { denyPhrases: ['guarantee'], fallback: 'A teammate will follow up.' },
    });
    expect(moderation.statusCode).toBe(400);

    const view = await agentView('limit-bridge');
    expect(view.runtime).toBe('bridge');
    expect(view.subscriberRate).toEqual(RATE);
    expect(view.topics).toBeNull();
    expect(view.moderation).toBeNull();
  });

  test('a bridge agent can be BORN with a limit, and can clear it', async () => {
    const created = await authed('POST', '/v1/agents', {
      identifier: 'limit-bridge-born',
      name: 'Limit Bridge Born',
      runtime: 'bridge',
      bridgeUrl: 'https://example.com/agent',
      subscriberRate: RATE,
    });
    expect(created.statusCode).toBe(201);
    expect(json(created).agent.subscriberRate).toEqual(RATE);

    const cleared = await authed('PATCH', '/v1/agents/limit-bridge-born', {
      subscriberRate: null,
    });
    expect(cleared.statusCode).toBe(200);
    expect(json(cleared).agent.subscriberRate).toBeNull();
  });

  test('a limit survives a managed→bridge conversion — it was never brain config', async () => {
    await authed('POST', '/v1/agents', {
      identifier: 'limit-converts',
      name: 'Limit Converts',
      runtime: 'managed',
      model: 'limit-model-1',
      systemPrompt: 'Be brief.',
      llm: { apiKey: 'zai-test-key-123456' },
      subscriberRate: RATE,
    });
    const res = await authed('PATCH', '/v1/agents/limit-converts', {
      runtime: 'bridge',
      bridgeUrl: 'https://example.com/agent',
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.runtime).toBe('bridge');
    expect(json(res).agent.subscriberRate).toEqual(RATE);
  });
});

describe('A8 slice B: the bounds are core’s numbers, not a second set', () => {
  /** The 400 body's message, so a test can say WHY something was refused. */
  const rejected = async (payload: unknown): Promise<string> => {
    const res = await authed('PATCH', '/v1/agents/limit-agent', payload);
    expect(res.statusCode).toBe(400);
    return JSON.stringify(json(res));
  };

  const accepted = async (subscriberRate: unknown) => {
    const res = await authed('PATCH', '/v1/agents/limit-agent', { subscriberRate });
    expect(res.statusCode).toBe(200);
    return json(res).agent.subscriberRate;
  };

  test('all three fields are required — each one is a real guard', async () => {
    await rejected({ subscriberRate: { windowMinutes: 5, notice: 'Slow down.' } });
    await rejected({ subscriberRate: { maxMessages: 20, notice: 'Slow down.' } });
    await rejected({ subscriberRate: { maxMessages: 20, windowMinutes: 5 } });
    await rejected({ subscriberRate: {} });
  });

  test('maxMessages is bounded at core’s constants, and the boundaries themselves pass', async () => {
    await rejected({ subscriberRate: { ...RATE, maxMessages: MAX_MESSAGES_MIN - 1 } });
    await rejected({ subscriberRate: { ...RATE, maxMessages: MAX_MESSAGES_MAX + 1 } });
    expect((await accepted({ ...RATE, maxMessages: MAX_MESSAGES_MIN })).maxMessages).toBe(
      MAX_MESSAGES_MIN,
    );
    expect((await accepted({ ...RATE, maxMessages: MAX_MESSAGES_MAX })).maxMessages).toBe(
      MAX_MESSAGES_MAX,
    );
  });

  test('windowMinutes is bounded at core’s constants, and the boundaries themselves pass', async () => {
    await rejected({ subscriberRate: { ...RATE, windowMinutes: WINDOW_MINUTES_MIN - 1 } });
    await rejected({ subscriberRate: { ...RATE, windowMinutes: WINDOW_MINUTES_MAX + 1 } });
    expect((await accepted({ ...RATE, windowMinutes: WINDOW_MINUTES_MIN })).windowMinutes).toBe(
      WINDOW_MINUTES_MIN,
    );
    expect((await accepted({ ...RATE, windowMinutes: WINDOW_MINUTES_MAX })).windowMinutes).toBe(
      WINDOW_MINUTES_MAX,
    );
  });

  test('a fractional or non-numeric cap is refused rather than rounded', async () => {
    await rejected({ subscriberRate: { ...RATE, maxMessages: 2.5 } });
    await rejected({ subscriberRate: { ...RATE, windowMinutes: 1.5 } });
    await rejected({ subscriberRate: { ...RATE, maxMessages: '20' } });
  });

  test('the notice is capped at NOTICE_MAX and the cap itself is not a lie', async () => {
    await rejected({ subscriberRate: { ...RATE, notice: 'x'.repeat(NOTICE_MAX + 1) } });
    expect((await accepted({ ...RATE, notice: 'x'.repeat(NOTICE_MAX) })).notice).toHaveLength(
      NOTICE_MAX,
    );
  });

  test('a whitespace-only notice is REFUSED, not stored — a lone space is not a limit', async () => {
    // core's resolveSubscriberRate trims and reads an empty notice as NO LIMIT.
    // Accepting "   " here would store a limit that quietly does nothing while
    // the operator reads it back from this very API and believes it is on.
    await rejected({ subscriberRate: { ...RATE, notice: '   ' } });
    await rejected({ subscriberRate: { ...RATE, notice: '' } });
    await rejected({ subscriberRate: { ...RATE, notice: '\n\t ' } });
  });

  test('a notice is stored trimmed, so what comes back is what will be sent', async () => {
    expect((await accepted({ ...RATE, notice: '  Slow down please.  ' })).notice).toBe(
      'Slow down please.',
    );
  });

  test('a non-object limit is refused outright', async () => {
    await rejected({ subscriberRate: 20 });
    await rejected({ subscriberRate: 'off' });
    await rejected({ subscriberRate: [20, 5, 'Slow down.'] });
  });
});

describe('A8 slice B: a message limit is deliberately not gradeable', () => {
  test('CandidateSchema has no subscriberRate field at all', () => {
    // Same unwrap idiom as the A7 anti-drift block: CandidateSchema is a refined
    // object, so the shape lives one level down. Asserting the ABSENCE is the
    // point — it is the only thing standing between this decision and a future
    // reader "completing the set".
    const shape = (
      CandidateSchema as unknown as { _def: { schema: { shape: Record<string, unknown> } } }
    )._def.schema.shape;
    expect(Object.keys(shape).sort()).toEqual(
      ['model', 'moderation', 'routing', 'systemPrompt', 'topics'].sort(),
    );
    expect(shape).not.toHaveProperty('subscriberRate');
  });

  test('a limit sent inside a candidate is stripped, never graded', () => {
    const parsed = CandidateSchema.safeParse({
      systemPrompt: 'You are the Acme support agent.',
      subscriberRate: RATE,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data).not.toHaveProperty('subscriberRate');
  });

  test('a candidate that names ONLY a message limit is refused by the run route', async () => {
    // Stripped to {}, which then fails the "a candidate needs something to
    // grade" refine — so the operator hears that there is no such thing to
    // grade rather than watching a run report on a config it never applied.
    const res = await authed('POST', '/v1/agents/limit-agent/evals/run', {
      trigger: 'pre_save',
      candidate: { subscriberRate: RATE },
    });
    expect(res.statusCode).toBe(400);
  });

  test('the save route takes the same object the run route will not', async () => {
    const save = await authed('PATCH', '/v1/agents/limit-agent', { subscriberRate: RATE });
    expect(save.statusCode).toBe(200);
    const run = await authed('POST', '/v1/agents/limit-agent/evals/run', {
      trigger: 'pre_save',
      candidate: { subscriberRate: RATE },
    });
    expect(run.statusCode).toBe(400);
  });
});
