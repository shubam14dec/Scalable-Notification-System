/**
 * Phase A7 slice C — the SURFACE of the two gates: the API that configures the
 * topic gate and the reply rules, the view that reads them back, and the ONE
 * pair of schemas both the agent save and the eval candidate validate against.
 *
 * No LLM stub and no worker here on purpose: slice A and slice B already prove
 * what the gates DO through the real turn path (tests/integration/topic-gate,
 * reply-rules). What is unproven until this file is that an operator can put a
 * policy in, read it back unchanged, take it out again — and that the pre-save
 * check grades the very object the save would write, which is a claim about
 * SCHEMAS rather than about behavior.
 *
 * The last describe is the anti-drift block, and it is the reason this file
 * exists at all. Slices A and B parked the two schemas in routes/agent-evals.ts
 * with a note to move them here beside RoutingSchema; if the move had left a
 * copy behind, a check could grade a policy the save then rejected — or, far
 * worse, quietly accept one the gate would never apply. So the sameness is
 * asserted twice: structurally (the candidate's schema IS this object) and
 * behaviorally (the same payloads win and lose on both routes).
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { ModerationSchema, TopicsSchema } from '../../src/api/routes/agents';
import { CandidateSchema } from '../../src/api/routes/agent-evals';
import {
  LABEL_MAX,
  LIST_MAX,
  REDIRECT_MAX,
} from '../../src/core/topic-gate';
import {
  DENY_PHRASE_LIST_MAX,
  DENY_PHRASE_MAX,
  FALLBACK_MAX,
} from '../../src/core/reply-rules';

let app: FastifyInstance;
let apiKey = '';

const json = (res: { body: string }) => JSON.parse(res.body);

const authed = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown) =>
  app.inject({ method, url, headers: { 'x-api-key': apiKey }, ...(payload ? { payload } : {}) });

interface GuardedAgentView {
  topics: { deny?: string[]; allow?: string[]; redirect: string } | null;
  moderation: { denyPhrases?: string[]; blockPii?: boolean; fallback: string } | null;
}

async function agentView(identifier: string): Promise<GuardedAgentView> {
  const res = await authed('GET', `/v1/agents/${identifier}`);
  expect(res.statusCode).toBe(200);
  return json(res).agent as GuardedAgentView;
}

const TOPICS = {
  deny: ['medical advice', 'legal advice'],
  allow: ['orders and delivery'],
  redirect: 'I can only help with orders and returns here.',
};
const RULES = {
  denyPhrases: ['guarantee', 'risk-free'],
  blockPii: true,
  fallback: 'A teammate will follow up shortly.',
};

beforeAll(async () => {
  app = await buildApp();
  const email = `guardrails-surface-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Guardrails Surface IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Guardrails Surface IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;

  await authed('POST', '/v1/agents', {
    identifier: 'guard-agent',
    name: 'Guard Agent',
    runtime: 'managed',
    model: 'guard-model-1',
    systemPrompt: 'You are the Acme support agent. Be brief.',
    llm: { apiKey: 'zai-test-key-123456' },
  });
  await authed('POST', '/v1/agents', {
    identifier: 'guard-bridge',
    name: 'Guard Bridge',
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

describe('A7 slice C: configuring the two gates', () => {
  test('PATCH accepts both configs and the agent view carries them back', async () => {
    const res = await authed('PATCH', '/v1/agents/guard-agent', {
      topics: TOPICS,
      moderation: RULES,
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.topics).toEqual(TOPICS);
    expect(json(res).agent.moderation).toEqual(RULES);

    // Round-trip through a FRESH read: the PATCH response could be echoing the
    // request, but the view of a re-fetched row can only be echoing the column.
    const view = await agentView('guard-agent');
    expect(view.topics).toEqual(TOPICS);
    expect(view.moderation).toEqual(RULES);
  });

  test('a provided config REPLACES the stored one — lists are never merged', async () => {
    await authed('PATCH', '/v1/agents/guard-agent', { topics: TOPICS, moderation: RULES });
    const res = await authed('PATCH', '/v1/agents/guard-agent', {
      topics: { deny: ['medical advice'], redirect: 'Orders and returns only.' },
      moderation: { denyPhrases: ['guarantee'], fallback: 'A teammate will follow up.' },
    });
    expect(res.statusCode).toBe(200);
    const view = await agentView('guard-agent');
    // The dropped label and the dropped phrase are GONE, and so are the keys
    // that were not sent — removing an entry is the one edit a guard surface
    // must never quietly refuse.
    expect(view.topics).toEqual({ deny: ['medical advice'], redirect: 'Orders and returns only.' });
    expect(view.topics?.allow).toBeUndefined();
    expect(view.moderation).toEqual({
      denyPhrases: ['guarantee'],
      fallback: 'A teammate will follow up.',
    });
    expect(view.moderation?.blockPii).toBeUndefined();
  });

  test('one gate can be edited without disturbing the other', async () => {
    await authed('PATCH', '/v1/agents/guard-agent', { topics: TOPICS, moderation: RULES });
    const res = await authed('PATCH', '/v1/agents/guard-agent', { name: 'Guard Agent Renamed' });
    expect(res.statusCode).toBe(200);
    const view = await agentView('guard-agent');
    expect(view.topics).toEqual(TOPICS);
    expect(view.moderation).toEqual(RULES);
  });

  test('null clears each gate independently', async () => {
    await authed('PATCH', '/v1/agents/guard-agent', { topics: TOPICS, moderation: RULES });

    await authed('PATCH', '/v1/agents/guard-agent', { topics: null });
    let view = await agentView('guard-agent');
    expect(view.topics).toBeNull();
    expect(view.moderation).toEqual(RULES);

    await authed('PATCH', '/v1/agents/guard-agent', { moderation: null });
    view = await agentView('guard-agent');
    expect(view.topics).toBeNull();
    expect(view.moderation).toBeNull();
  });

  test('create accepts both configs, like routing', async () => {
    const res = await authed('POST', '/v1/agents', {
      identifier: 'guard-born-gated',
      name: 'Born Gated',
      runtime: 'managed',
      systemPrompt: 'Be brief.',
      llm: { apiKey: 'zai-test-key-123456' },
      topics: TOPICS,
      moderation: RULES,
    });
    expect(res.statusCode).toBe(201);
    expect(json(res).agent.topics).toEqual(TOPICS);
    expect(json(res).agent.moderation).toEqual(RULES);
    const view = await agentView('guard-born-gated');
    expect(view.topics).toEqual(TOPICS);
    expect(view.moderation).toEqual(RULES);
  });

  test('an ungated agent reads back null for both — never undefined', async () => {
    const view = await agentView('guard-bridge');
    expect(view.topics).toBeNull();
    expect(view.moderation).toBeNull();
  });
});

describe('A7 slice C: both gates are managed-only', () => {
  test('create rejects either on a bridge agent', async () => {
    const withTopics = await authed('POST', '/v1/agents', {
      identifier: 'guard-bridge-topics',
      name: 'Bridge Topics',
      runtime: 'bridge',
      bridgeUrl: 'https://example.com/agent',
      topics: TOPICS,
    });
    expect(withTopics.statusCode).toBe(400);
    expect(JSON.stringify(json(withTopics).details)).toContain('managed agent');

    const withRules = await authed('POST', '/v1/agents', {
      identifier: 'guard-bridge-rules',
      name: 'Bridge Rules',
      runtime: 'bridge',
      bridgeUrl: 'https://example.com/agent',
      moderation: RULES,
    });
    expect(withRules.statusCode).toBe(400);
    expect(JSON.stringify(json(withRules).details)).toContain('managed agent');
  });

  test('PATCH rejects either on a bridge agent', async () => {
    const topics = await authed('PATCH', '/v1/agents/guard-bridge', { topics: TOPICS });
    expect(topics.statusCode).toBe(400);
    expect(json(topics).error).toContain('topic rules need a managed agent');

    const rules = await authed('PATCH', '/v1/agents/guard-bridge', { moderation: RULES });
    expect(rules.statusCode).toBe(400);
    expect(json(rules).error).toContain('reply rules need a managed agent');
  });

  test('CLEARING either on a bridge agent is allowed — a clear is never wrong', async () => {
    const res = await authed('PATCH', '/v1/agents/guard-bridge', {
      topics: null,
      moderation: null,
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).agent.topics).toBeNull();
    expect(json(res).agent.moderation).toBeNull();
  });
});

/**
 * The caps are IMPORTED from core rather than typed as literals here, so this
 * block tests the law instead of a copy of it: move a bound in core and these
 * assertions move with it, exactly as the API's schema does.
 */
describe('A7 slice C: what the API refuses', () => {
  const rejected = async (payload: unknown) => {
    const res = await authed('PATCH', '/v1/agents/guard-agent', payload);
    expect(res.statusCode).toBe(400);
    return JSON.stringify(json(res).details);
  };

  test('a topic policy with no list at all is not a policy', async () => {
    expect(await rejected({ topics: { redirect: 'Sorry, not here.' } })).toContain(
      'at least one deny or allow label',
    );
    expect(await rejected({ topics: { deny: [], allow: [], redirect: 'Sorry.' } })).toContain(
      'at least one deny or allow label',
    );
  });

  test('a topic policy with no redirect is a mute button, not a boundary', async () => {
    await rejected({ topics: { deny: ['medical advice'] } });
    await rejected({ topics: { deny: ['medical advice'], redirect: '' } });
  });

  test('topic lists and labels are capped at the numbers core normalizes to', async () => {
    const tooMany = Array.from({ length: LIST_MAX + 1 }, (_, i) => `topic ${i}`);
    await rejected({ topics: { deny: tooMany, redirect: 'Sorry.' } });
    await rejected({ topics: { allow: tooMany, redirect: 'Sorry.' } });
    await rejected({ topics: { deny: ['x'.repeat(LABEL_MAX + 1)], redirect: 'Sorry.' } });
    await rejected({
      topics: { deny: ['medical advice'], redirect: 'x'.repeat(REDIRECT_MAX + 1) },
    });
    // …and the boundary values themselves are accepted, or the cap is a lie.
    const ok = await authed('PATCH', '/v1/agents/guard-agent', {
      topics: {
        deny: Array.from({ length: LIST_MAX }, (_, i) => `topic ${i}`),
        redirect: 'x'.repeat(REDIRECT_MAX),
      },
    });
    expect(ok.statusCode).toBe(200);
  });

  test('reply rules with nothing that can match are refused', async () => {
    expect(await rejected({ moderation: { fallback: 'A teammate will follow up.' } })).toContain(
      'at least one deny phrase or blockPii',
    );
    expect(
      await rejected({
        moderation: { denyPhrases: [], blockPii: false, fallback: 'A teammate will follow up.' },
      }),
    ).toContain('at least one deny phrase or blockPii');
  });

  test('reply rules with no fallback are refused', async () => {
    await rejected({ moderation: { denyPhrases: ['guarantee'] } });
    await rejected({ moderation: { blockPii: true, fallback: '' } });
  });

  test('phrase list and phrase length are capped at core’s numbers', async () => {
    const tooMany = Array.from({ length: DENY_PHRASE_LIST_MAX + 1 }, (_, i) => `phrase ${i}`);
    await rejected({ moderation: { denyPhrases: tooMany, fallback: 'A teammate will follow up.' } });
    await rejected({
      moderation: {
        denyPhrases: ['x'.repeat(DENY_PHRASE_MAX + 1)],
        fallback: 'A teammate will follow up.',
      },
    });
    await rejected({
      moderation: { blockPii: true, fallback: 'x'.repeat(FALLBACK_MAX + 1) },
    });
    const ok = await authed('PATCH', '/v1/agents/guard-agent', {
      moderation: {
        denyPhrases: Array.from({ length: DENY_PHRASE_LIST_MAX }, (_, i) => `phrase ${i}`),
        fallback: 'x'.repeat(FALLBACK_MAX),
      },
    });
    expect(ok.statusCode).toBe(200);
  });
});

describe('A7 slice C: the candidate and the config validate against ONE schema', () => {
  test('the candidate schema holds the very objects routes/agents.ts exports', () => {
    // CandidateSchema is a refined object: unwrap the effect, then the
    // `.nullable().optional()` around each field. Identity, not equality —
    // "structurally similar" is exactly the state this assertion exists to
    // rule out.
    const shape = (
      CandidateSchema as unknown as {
        _def: { schema: { shape: Record<string, { unwrap: () => { unwrap: () => unknown } }> } };
      }
    )._def.schema.shape;
    expect(shape.topics.unwrap().unwrap()).toBe(TopicsSchema);
    expect(shape.moderation.unwrap().unwrap()).toBe(ModerationSchema);
  });

  test('the same payloads win and lose on the save route and the run route', async () => {
    const cases: Array<{ what: string; topics?: unknown; moderation?: unknown; ok: boolean }> = [
      { what: 'a complete topic policy', topics: TOPICS, ok: true },
      { what: 'a topic policy with no list', topics: { redirect: 'Sorry.' }, ok: false },
      { what: 'a topic policy with no redirect', topics: { deny: ['medical advice'] }, ok: false },
      {
        what: 'an over-long label',
        topics: { deny: ['x'.repeat(LABEL_MAX + 1)], redirect: 'Sorry.' },
        ok: false,
      },
      { what: 'complete reply rules', moderation: RULES, ok: true },
      { what: 'rules with nothing to match', moderation: { fallback: 'Soon.' }, ok: false },
      { what: 'rules with no fallback', moderation: { denyPhrases: ['guarantee'] }, ok: false },
      {
        what: 'an over-long phrase',
        moderation: { denyPhrases: ['x'.repeat(DENY_PHRASE_MAX + 1)], fallback: 'Soon.' },
        ok: false,
      },
    ];

    for (const c of cases) {
      const body = {
        ...(c.topics !== undefined ? { topics: c.topics } : {}),
        ...(c.moderation !== undefined ? { moderation: c.moderation } : {}),
      };
      const save = await authed('PATCH', '/v1/agents/guard-agent', body);
      const run = await authed('POST', '/v1/agents/guard-agent/evals/run', {
        trigger: 'pre_save',
        candidate: body,
      });
      // The run route answers 200/202 on an accepted candidate (there may be no
      // enabled evals — an empty run is still an accepted candidate) and 400 on
      // a rejected one, which is the only distinction under test.
      expect(
        { what: c.what, save: save.statusCode < 400, run: run.statusCode < 400 },
      ).toEqual({ what: c.what, save: c.ok, run: c.ok });
    }
  });

  test('an explicit null candidate is accepted on both routes — off is gradeable', async () => {
    const save = await authed('PATCH', '/v1/agents/guard-agent', {
      topics: null,
      moderation: null,
    });
    expect(save.statusCode).toBe(200);
    const run = await authed('POST', '/v1/agents/guard-agent/evals/run', {
      trigger: 'pre_save',
      candidate: { topics: null, moderation: null },
    });
    expect(run.statusCode).toBeLessThan(400);
  });
});
