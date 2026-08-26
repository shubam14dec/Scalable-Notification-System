/**
 * Phase A10 slice B — CONFIG-AS-CODE end to end: export, import preview, import
 * apply. Real app in-process, real Postgres, no LLM and no worker — every claim
 * here is about a SAVE, so the whole surface under test is the agents API and
 * the rows behind it.
 *
 * What is proved:
 *   1. ROUND TRIP. A fully configured agent exports to a file that recreates it
 *      somewhere else, and the copy exports byte-identically (modulo its
 *      identifier). Anything the format silently dropped would show up here.
 *   2. NO SECRET TRAVELS, asserted against an agent whose key we just set.
 *   3. IMPORT-UPDATE RIDES updateAgent, so a changed prompt MINTS A VERSION —
 *      the A5 doctrine holds for a config file exactly as it holds for the
 *      editor, or history quietly stops being complete.
 *   4. THE PREVIEW TELLS THE TRUTH, field by field, including the two things an
 *      operator most needs to know before promoting a config: what is missing in
 *      the target, and what the import will NOT touch.
 *   5. ONE LAW PER RULE. An import is refused by the very same schema objects
 *      that refuse a dashboard save — asserted by making both routes reject the
 *      same payloads with the same issue paths.
 *   6. NOTHING IS DESTROYED. A tool the file does not mention is kept; a paused
 *      or disabled agent stays paused and disabled.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';

const LLM_KEY = 'zai-test-key-123456';
const OTHER_LLM_KEY = 'zai-other-key-98765';
const PROMPT = 'You are the Acme support agent. Trigger the order-shipped workflow when asked.';
const FIXTURE = fileURLToPath(
  new URL('../../evals/agents/support-demo.agent.json', import.meta.url),
);

let app: FastifyInstance;
let apiKey = '';

const json = (res: { body: string }) => JSON.parse(res.body);

const authed = (method: 'GET' | 'POST' | 'PATCH' | 'PUT', url: string, payload?: unknown) =>
  app.inject({
    method,
    url,
    headers: { 'x-api-key': apiKey },
    ...(payload === undefined ? {} : { payload }),
  });

type ConfigFile = Record<string, unknown>;

async function exportConfig(identifier: string): Promise<ConfigFile> {
  const res = await authed('GET', `/v1/agents/${identifier}/export`);
  expect(res.statusCode, res.body).toBe(200);
  return json(res) as ConfigFile;
}

async function preview(file: unknown) {
  const res = await authed('POST', '/v1/agents/import/preview', { file });
  return { status: res.statusCode, body: json(res) };
}

async function apply(file: unknown, llmApiKey?: string) {
  const res = await authed('POST', '/v1/agents/import', {
    file,
    ...(llmApiKey ? { llmApiKey } : {}),
  });
  return { status: res.statusCode, body: json(res) };
}

/** A copy of a file under a new identifier — the promote-to-env move. */
function renamed(file: ConfigFile, identifier: string): ConfigFile {
  return { ...file, identifier };
}

function withoutIdentifier(file: ConfigFile): ConfigFile {
  const { identifier: _identifier, ...rest } = file;
  return rest;
}

const TOOL = {
  name: 'refund_customer',
  description: 'Refund an order.',
  parameters: { type: 'object', required: ['orderId'], properties: { orderId: { type: 'string' } } },
  endpointUrl: 'http://localhost:5599/refund',
  approval: 'required' as const,
  timeoutMs: 12_000,
  guard: { maxAutoCalls: 1, windowDays: 30 },
};

const TOOL2 = {
  name: 'lookup_order',
  description: 'Look an order up.',
  parameters: { type: 'object', properties: { orderId: { type: 'string' } } },
  endpointUrl: 'http://localhost:5599/lookup',
};

beforeAll(async () => {
  app = await buildApp();
  const email = `cfg-file-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Config File IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Config File IT Org',
    },
  });
  apiKey = json(signup).environments.find((e: { name: string }) => e.name === 'Development').apiKey;

  // The workflow the prompt names — without it, every import of this config is
  // a 422 (which is its own test, further down).
  await authed('PUT', '/v1/workflows', {
    key: 'order-shipped',
    name: 'Order shipped',
    steps: [{ channel: 'inapp', subject: 'Order shipped', body: 'On its way.' }],
  });

  // The source agent: every knob this format carries, turned on.
  const created = await authed('POST', '/v1/agents', {
    identifier: 'cfg-source',
    name: 'Config Source',
    description: 'The agent every export test starts from.',
    runtime: 'managed',
    model: 'glm-5',
    systemPrompt: PROMPT,
    llm: { apiKey: LLM_KEY, baseUrl: 'https://api.z.ai/api/anthropic' },
    welcomeMessage: 'Hi! Ask me anything.',
    suggestedPrompts: [{ title: 'Track order', message: 'Where is my order?' }],
    context: { triggerTurns: 7, tailTurns: 4 },
    maxTokens: 2048,
    maxDailyTokens: 500_000,
    autoResolveMinutes: 120,
    routing: { enabled: true, cheapModel: 'glm-5-air' },
    topics: { deny: ['medical advice'], redirect: 'I can only help with orders.' },
    moderation: { denyPhrases: ['guaranteed refund'], blockPii: true, fallback: 'Let me check.' },
    subscriberRate: { maxMessages: 20, windowMinutes: 5, notice: 'One moment.' },
  });
  expect(created.statusCode, created.body).toBe(201);

  for (const tool of [TOOL, TOOL2]) {
    const res = await authed('POST', '/v1/agents/cfg-source/tools', tool);
    expect(res.statusCode, res.body).toBe(201);
  }
});

afterAll(async () => {
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('A10 slice B: the export', () => {
  test('carries every knob, both runtimes’ shape, and the tools with their guards', async () => {
    const file = await exportConfig('cfg-source');
    expect(file).toMatchObject({
      formatVersion: 1,
      identifier: 'cfg-source',
      name: 'Config Source',
      description: 'The agent every export test starts from.',
      runtime: 'managed',
      model: 'glm-5',
      systemPrompt: PROMPT,
      welcomeMessage: 'Hi! Ask me anything.',
      context: { triggerTurns: 7, tailTurns: 4 },
      // The reply cap and the idle backstop travel with everything else: the
      // file is the whole agent minus secrets and operational state.
      maxTokens: 2048,
      maxDailyTokens: 500_000,
      autoResolveMinutes: 120,
      routing: { enabled: true, cheapModel: 'glm-5-air' },
      topics: { deny: ['medical advice'], redirect: 'I can only help with orders.' },
      moderation: { denyPhrases: ['guaranteed refund'], blockPii: true, fallback: 'Let me check.' },
      subscriberRate: { maxMessages: 20, windowMinutes: 5, notice: 'One moment.' },
      workflows: ['order-shipped'],
    });
    const tools = file.tools as Array<Record<string, unknown>>;
    expect(tools.map((t) => t.name)).toEqual(['lookup_order', 'refund_customer']);
    expect(tools.find((t) => t.name === 'refund_customer')).toMatchObject({
      description: TOOL.description,
      endpointUrl: TOOL.endpointUrl,
      approval: 'required',
      timeoutMs: 12_000,
      guard: { maxAutoCalls: 1, windowDays: 30 },
    });
  });

  test('NO SECRET is in it — not the LLM key we just stored, not a signing secret', async () => {
    const res = await authed('GET', '/v1/agents/cfg-source/export');
    expect(res.body).not.toContain(LLM_KEY);
    expect(res.body).not.toContain('ags_');
    expect(res.body).not.toContain('ats_');
    const file = await exportConfig('cfg-source');
    for (const key of ['llm', 'apiKey', 'signingSecret', 'hasLlmKey', 'secret']) {
      expect(file).not.toHaveProperty(key);
    }
    expect((file.tools as Array<Record<string, unknown>>).every((t) => !('secret' in t))).toBe(true);
  });

  test('the LLM BASE URL travels, because the read route already hands it out', async () => {
    // An endpoint is not a credential, and a file that hid what GET
    // /v1/agents/:identifier returns to the same API key would be a fiction.
    const view = json(await authed('GET', '/v1/agents/cfg-source')).agent;
    expect(view.llmBaseUrl).toBe('https://api.z.ai/api/anthropic');
    expect((await exportConfig('cfg-source')).llmBaseUrl).toBe(view.llmBaseUrl);
  });

  test('operational state does not travel: no status, no pausedAt, no version', async () => {
    const file = await exportConfig('cfg-source');
    for (const key of ['status', 'pausedAt', 'promptVersion', 'canary', 'createdAt', 'updatedAt']) {
      expect(file).not.toHaveProperty(key);
    }
  });

  test('an unknown agent is a 404, not an empty file', async () => {
    expect((await authed('GET', '/v1/agents/nope/export')).statusCode).toBe(404);
  });
});

describe('A10 slice B: the round trip', () => {
  test('export → import into a fresh identifier → export again is the same file', async () => {
    const first = await exportConfig('cfg-source');
    const applied = await apply(renamed(first, 'cfg-copy'), LLM_KEY);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(applied.body.mode).toBe('create');
    // The copy's own signing secret, shown once — the file could not carry it.
    expect(String(applied.body.signingSecret)).toMatch(/^ags_/);
    expect(applied.body.tools.created.map((t: { name: string }) => t.name).sort()).toEqual([
      'lookup_order',
      'refund_customer',
    ]);
    // Every imported tool gets a NEW call secret for THIS environment, once.
    for (const t of applied.body.tools.created) expect(String(t.secret)).toMatch(/^ats_/);

    const second = await exportConfig('cfg-copy');
    expect(withoutIdentifier(second)).toEqual(withoutIdentifier(first));
  });

  test('the copy really is configured — it is the view, not just the file', async () => {
    const view = json(await authed('GET', '/v1/agents/cfg-copy')).agent;
    expect(view.hasLlmKey).toBe(true);
    expect(view.llmBaseUrl).toBe('https://api.z.ai/api/anthropic');
    expect(view.routing).toEqual({ enabled: true, cheapModel: 'glm-5-air' });
    expect(view.subscriberRate).toEqual({ maxMessages: 20, windowMinutes: 5, notice: 'One moment.' });
    // The promoted copy answers under the SAME ceilings as the tested original.
    expect(view.maxTokens).toBe(2048);
    expect(view.maxDailyTokens).toBe(500_000);
    expect(view.autoResolveMinutes).toBe(120);
    expect(view.status).toBe('active');
    expect(view.pausedAt).toBeNull();
  });

  test('a BRIDGE agent round-trips too — tools, knobs and all', async () => {
    const created = await authed('POST', '/v1/agents', {
      identifier: 'cfg-bridge',
      name: 'Config Bridge',
      runtime: 'bridge',
      bridgeUrl: 'http://localhost:5599/agent',
      subscriberRate: { maxMessages: 5, windowMinutes: 1, notice: 'Slow down.' },
    });
    expect(created.statusCode, created.body).toBe(201);
    await authed('POST', '/v1/agents/cfg-bridge/tools', TOOL2);

    const first = await exportConfig('cfg-bridge');
    expect(first).toMatchObject({ runtime: 'bridge', bridgeUrl: 'http://localhost:5599/agent' });
    // No LLM key is asked for or needed: the runtime field says which kind of
    // agent this is, and a bridge agent's brain is the customer's own code.
    const applied = await apply(renamed(first, 'cfg-bridge-copy'));
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    expect(withoutIdentifier(await exportConfig('cfg-bridge-copy'))).toEqual(
      withoutIdentifier(first),
    );
  });
});

describe('A10 slice B: creating from a file needs the target’s own key', () => {
  test('a managed create with no llmApiKey is refused exactly as POST /v1/agents is', async () => {
    const file = renamed(await exportConfig('cfg-source'), 'cfg-nokey');
    const applied = await apply(file);
    expect(applied.status).toBe(400);
    expect(JSON.stringify(applied.body)).toContain('apiKey');
    expect((await authed('GET', '/v1/agents/cfg-nokey')).statusCode).toBe(404);

    // The same file with a key is fine — the refusal was about the key alone.
    expect((await apply(file, OTHER_LLM_KEY)).status).toBe(201);
  });

  test('a bridge create needs no key at all', async () => {
    const file = renamed(await exportConfig('cfg-bridge'), 'cfg-bridge-nokey');
    expect((await apply(file)).status).toBe(201);
  });
});

describe('A10 slice B: importing over an existing agent', () => {
  beforeAll(async () => {
    const file = renamed(await exportConfig('cfg-source'), 'cfg-target');
    expect((await apply(file, LLM_KEY)).status).toBe(201);
  });

  test('a changed prompt MINTS A VERSION — an import is a save like any other', async () => {
    const before = json(await authed('GET', '/v1/agents/cfg-target')).agent.promptVersion;
    const file = await exportConfig('cfg-target');
    const applied = await apply({ ...file, systemPrompt: `${PROMPT} Be brief.` });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.mode).toBe('update');
    expect(applied.body.agent.promptVersion).toBe(before + 1);

    const versions = json(await authed('GET', '/v1/agents/cfg-target/versions'));
    expect(versions.currentVersion).toBe(before + 1);
    expect(versions.versions.map((v: { version: number }) => v.version)).toContain(before);
  });

  test('re-importing the same file changes nothing and mints nothing', async () => {
    const file = await exportConfig('cfg-target');
    const before = json(await authed('GET', '/v1/agents/cfg-target')).agent.promptVersion;
    const applied = await apply(file);
    expect(applied.status).toBe(200);
    expect(applied.body.agent.promptVersion).toBe(before);
    expect(withoutIdentifier(await exportConfig('cfg-target'))).toEqual(withoutIdentifier(file));
  });

  test('a tool absent from the file is KEPT, and reported as kept', async () => {
    const file = await exportConfig('cfg-target');
    const tools = (file.tools as Array<Record<string, unknown>>).filter(
      (t) => t.name !== 'lookup_order',
    );
    const applied = await apply({ ...file, tools });
    expect(applied.status).toBe(200);
    expect(applied.body.tools.kept).toEqual(['lookup_order']);

    const live = json(await authed('GET', '/v1/agents/cfg-target/tools')).tools;
    expect(live.map((t: { name: string }) => t.name).sort()).toEqual([
      'lookup_order',
      'refund_customer',
    ]);
  });

  test('a changed tool is updated in place by name, and a new one is created', async () => {
    const file = await exportConfig('cfg-target');
    const tools = (file.tools as Array<Record<string, unknown>>).map((t) =>
      t.name === 'refund_customer' ? { ...t, description: 'Refund an order, carefully.' } : t,
    );
    tools.push({
      name: 'check_stock',
      description: 'Check stock levels.',
      parameters: { type: 'object', properties: { sku: { type: 'string' } } },
      endpointUrl: 'http://localhost:5599/stock',
    });
    const applied = await apply({ ...file, tools });
    expect(applied.status, JSON.stringify(applied.body)).toBe(200);
    expect(applied.body.tools.updated).toEqual(['refund_customer']);
    expect(applied.body.tools.created.map((t: { name: string }) => t.name)).toEqual(['check_stock']);

    const live = json(await authed('GET', '/v1/agents/cfg-target/tools')).tools;
    const refund = live.find((t: { name: string }) => t.name === 'refund_customer');
    expect(refund.description).toBe('Refund an order, carefully.');
    // Updated IN PLACE: same row, so its call secret and its history survive.
    expect(live.filter((t: { name: string }) => t.name === 'refund_customer')).toHaveLength(1);
  });

  test('a PAUSED, DISABLED agent stays paused and disabled — a config is not an all-clear', async () => {
    await authed('POST', '/v1/agents/cfg-target/pause');
    await authed('PATCH', '/v1/agents/cfg-target', { status: 'disabled' });

    const file = await exportConfig('cfg-target');
    const applied = await apply({ ...file, name: 'Renamed While Paused' });
    expect(applied.status).toBe(200);
    expect(applied.body.agent.name).toBe('Renamed While Paused');
    expect(applied.body.agent.pausedAt).not.toBeNull();
    expect(applied.body.agent.status).toBe('disabled');

    await authed('POST', '/v1/agents/cfg-target/resume');
    await authed('PATCH', '/v1/agents/cfg-target', { status: 'active' });
  });

  test('the stored LLM key is untouched by an import that carries none', async () => {
    const file = await exportConfig('cfg-target');
    const applied = await apply(file);
    expect(applied.status).toBe(200);
    expect(applied.body.agent.hasLlmKey).toBe(true);
    expect(applied.body.agent.llmBaseUrl).toBe('https://api.z.ai/api/anthropic');
  });

  test('a base URL moves only WITH a key — an endpoint change never repoints an old key', async () => {
    const file = await exportConfig('cfg-target');
    const moved = { ...file, llmBaseUrl: 'https://api.anthropic.com' };

    // No key: the file's base URL is not applied.
    expect((await apply(moved)).status).toBe(200);
    expect(json(await authed('GET', '/v1/agents/cfg-target')).agent.llmBaseUrl).toBe(
      'https://api.z.ai/api/anthropic',
    );

    // With a key, both move together.
    expect((await apply(moved, OTHER_LLM_KEY)).status).toBe(200);
    expect(json(await authed('GET', '/v1/agents/cfg-target')).agent.llmBaseUrl).toBe(
      'https://api.anthropic.com',
    );
  });
});

describe('A10 slice B: the preview', () => {
  test('reports a known delta field by field, and promises no removals', async () => {
    const file = await exportConfig('cfg-source');
    const tools = (file.tools as Array<Record<string, unknown>>)
      .filter((t) => t.name !== 'lookup_order')
      .concat([
        {
          name: 'check_stock',
          description: 'Check stock levels.',
          parameters: { type: 'object' },
          endpointUrl: 'http://localhost:5599/stock',
        },
      ]);
    const edited = { ...file, systemPrompt: `${PROMPT} Always be brief.`, maxTokens: 4096, tools };
    delete (edited as Record<string, unknown>).welcomeMessage;

    const res = await preview(edited);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body.mode).toBe('update');
    const action = (f: string) =>
      res.body.changes.find((c: { field: string }) => c.field === f)?.action;
    expect(action('systemPrompt')).toBe('changed');
    expect(action('model')).toBe('unchanged');
    expect(action('topics')).toBe('unchanged');
    expect(action('welcomeMessage')).toBe('removed');
    // A moved reply cap is a visible row; the backstop the file did not touch
    // reads as unchanged rather than disappearing from the table.
    expect(action('maxTokens')).toBe('changed');
    expect(action('maxDailyTokens')).toBe('unchanged');
    expect(action('autoResolveMinutes')).toBe('unchanged');
    expect(res.body.toolChanges).toEqual({
      added: ['check_stock'],
      changed: [],
      removed: ['lookup_order'],
    });
    // The word 'removed' above must never be read as a threat.
    expect(res.body.removalPolicy).toBe('kept');
    expect(res.body.needsLlmKey).toBe(false);
    expect(res.body.missingWorkflows).toEqual([]);
  });

  test('a preview writes NOTHING — the agent it described is untouched', async () => {
    const before = await exportConfig('cfg-source');
    await preview({ ...before, systemPrompt: 'Rewritten by a preview.', name: 'Renamed' });
    expect(await exportConfig('cfg-source')).toEqual(before);
  });

  test('an unknown identifier previews as a create that will need a key', async () => {
    const res = await preview(renamed(await exportConfig('cfg-source'), 'cfg-never-created'));
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('create');
    expect(res.body.needsLlmKey).toBe(true);
    expect(res.body.changes.every((c: { action: string }) => c.action === 'added')).toBe(true);
    expect(res.body.toolChanges.added.sort()).toEqual(['lookup_order', 'refund_customer']);
    expect((await authed('GET', '/v1/agents/cfg-never-created')).statusCode).toBe(404);
  });

  test('a preview refuses what an apply would refuse, before a key is ever typed', async () => {
    // The stand-in key exists so a managed CREATE preview can still be told
    // that its topic policy is invalid — the operator hears it now, not after
    // pasting a production credential.
    const file = renamed(await exportConfig('cfg-source'), 'cfg-bad-preview');
    const res = await preview({ ...file, topics: { redirect: 'Nope.' } });
    expect(res.status).toBe(400);
    expect(JSON.stringify(res.body)).toContain('at least one deny or allow label');
  });

  test('knowledge is reported as references the target lacks, never created', async () => {
    const file = await exportConfig('cfg-source');
    const res = await preview({
      ...file,
      knowledge: [{ name: 'refund-policy', origin: 'https://acme.test/refunds' }],
    });
    expect(res.status).toBe(200);
    expect(res.body.missingKnowledge).toEqual(['refund-policy']);
    // A warning, not a refusal: the file has no content to index.
    const applied = await apply({
      ...file,
      knowledge: [{ name: 'refund-policy', origin: 'https://acme.test/refunds' }],
    });
    expect(applied.status).toBe(200);
    expect(applied.body.missingKnowledge).toEqual(['refund-policy']);
    expect(json(await authed('GET', '/v1/agents/cfg-source/knowledge')).sources).toEqual([]);
  });
});

describe('A10 slice B: a workflow the tenant does not have', () => {
  test('preview WARNS, apply REFUSES with 422 and names them', async () => {
    const file = {
      ...(await exportConfig('cfg-source')),
      identifier: 'cfg-missing-wf',
      workflows: ['order-shipped', 'refund-issued', 'nightly-digest'],
    };

    const previewed = await preview(file);
    expect(previewed.status).toBe(200);
    expect(previewed.body.missingWorkflows).toEqual(['nightly-digest', 'refund-issued']);

    const applied = await apply(file, LLM_KEY);
    expect(applied.status).toBe(422);
    expect(applied.body.error).toContain('nightly-digest');
    expect(applied.body.details.missingWorkflows).toEqual(['nightly-digest', 'refund-issued']);
    // Refused whole: no half-created agent left behind.
    expect((await authed('GET', '/v1/agents/cfg-missing-wf')).statusCode).toBe(404);
  });
});

describe('A10 slice B: one law per rule (the A7 identity doctrine)', () => {
  /**
   * The import does not own a gentler copy of any knob rule: it runs the file's
   * fields through AgentSchema / AgentPatchSchema — the objects the save routes
   * use. The assertion is behavioural on purpose: identical refusals, with
   * identical zod issue paths, from two routes that share one schema.
   */
  const BAD_KNOBS: Array<[string, Record<string, unknown>]> = [
    ['topics with nothing to match on', { topics: { redirect: 'Nope.' } }],
    ['moderation with no fallback', { moderation: { denyPhrases: ['x'] } }],
    ['routing enabled with no cheap model', { routing: { enabled: true } }],
    [
      'a whitespace-only rate notice',
      { subscriberRate: { maxMessages: 5, windowMinutes: 5, notice: '   ' } },
    ],
    ['a zero daily token budget', { maxDailyTokens: 0 }],
    ['a reply cap below the floor', { maxTokens: 10 }],
    ['an idle backstop past the ceiling', { autoResolveMinutes: 999_999 }],
    ['a context tail longer than its trigger', { context: { triggerTurns: 4, tailTurns: 9 } }],
  ];

  test.each(BAD_KNOBS)('%s is refused by BOTH the save route and the import', async (_name, bad) => {
    const patched = await authed('PATCH', '/v1/agents/cfg-source', bad);
    expect(patched.statusCode).toBe(400);

    const applied = await apply({ ...(await exportConfig('cfg-source')), ...bad });
    expect(applied.status).toBe(400);

    const paths = (body: { details?: Array<{ path: string[] }> }) =>
      (body.details ?? []).map((i) => i.path.join('.')).sort();
    expect(paths(applied.body)).toEqual(paths(json(patched)));
  });

  test('the managed-only gates hold on an imported bridge agent, word for word', async () => {
    const file = await exportConfig('cfg-bridge');
    const withGate = { ...file, topics: { deny: ['medical advice'], redirect: 'Not here.' } };
    const applied = await apply(withGate);
    const patched = await authed('PATCH', '/v1/agents/cfg-bridge', {
      topics: { deny: ['medical advice'], redirect: 'Not here.' },
    });
    expect(applied.status).toBe(400);
    expect(patched.statusCode).toBe(400);
    expect(applied.body.error).toBe(json(patched).error);
  });

  test('a tool endpoint pointing at internal infrastructure is refused, as on registration', async () => {
    const file = await exportConfig('cfg-source');
    const bad = {
      ...file,
      identifier: 'cfg-ssrf',
      tools: [{ ...TOOL, endpointUrl: 'http://169.254.169.254/latest/meta-data/' }],
    };
    const applied = await apply(bad, LLM_KEY);
    expect(applied.status).toBe(400);
    expect(applied.body.error).toContain('endpointUrl');
    // Refused BEFORE anything was written — tools are validated to the last one
    // before the first is created.
    expect((await authed('GET', '/v1/agents/cfg-ssrf')).statusCode).toBe(404);
  });

  test('a reserved tool name is refused here too', async () => {
    const file = await exportConfig('cfg-source');
    const applied = await apply(
      { ...file, identifier: 'cfg-reserved', tools: [{ ...TOOL, name: 'trigger_workflow' }] },
      LLM_KEY,
    );
    expect(applied.status).toBe(400);
    expect(applied.body.error).toContain('reserved');
    expect(applied.body.error).toContain('trigger_workflow');
  });
});

describe('A10 slice B: a tolerant reader', () => {
  test('unknown and underscore-prefixed keys are ignored, not refused', async () => {
    const file = await exportConfig('cfg-source');
    const applied = await apply(
      {
        ...file,
        identifier: 'cfg-unknown-keys',
        _comment: ['written by a human', 'for humans'],
        builtInTools: { alwaysOn: ['set_metadata'] },
        aFieldFromNextYear: { nested: true },
      },
      LLM_KEY,
    );
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const exported = await exportConfig('cfg-unknown-keys');
    expect(exported).not.toHaveProperty('_comment');
    expect(exported).not.toHaveProperty('aFieldFromNextYear');
  });

  test('a file that is not a config at all is a 400 with issues, never a 500', async () => {
    expect((await apply({ nope: true })).status).toBe(400);
    expect((await apply('a string')).status).toBe(400);
    expect((await preview(null)).status).toBe(400);
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/import',
      headers: { 'x-api-key': apiKey },
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('A10 slice B: the CI fixture', () => {
  const fixture = JSON.parse(readFileSync(FIXTURE, 'utf8')) as ConfigFile;

  /**
   * The fixture IS a valid config file, unedited — that claim belongs to the
   * format and is proved in tests/unit/agent-config-file (doc keys ignored,
   * workflow objects read as keys, no formatVersion needed, `${ACME_TOOLS_URL}`
   * tolerated). What these two tests pin is the OTHER half of that decision:
   * the endpoint template survives the reader and is then refused at the moment
   * we would actually dial it — by preview and apply alike, since a preview
   * that green-lights what an apply refuses is worse than no preview.
   */
  test('its unresolved ${ENV} endpoint is refused, and the message names the tool', async () => {
    const previewed = await preview(fixture);
    expect(previewed.status).toBe(400);
    expect(previewed.body.error).toContain('refund_customer');
    expect(JSON.stringify(previewed.body.details)).toContain('endpointUrl');

    const applied = await apply(fixture, LLM_KEY);
    expect(applied.status).toBe(400);
    expect(applied.body.error).toContain('refund_customer');
    // Refused before anything was written.
    expect((await authed('GET', '/v1/agents/support-demo')).statusCode).toBe(404);
  });

  test('with the template resolved — what the seed does — it applies cleanly', async () => {
    const tools = (fixture.tools as Array<Record<string, unknown>>).map((t) => ({
      ...t,
      endpointUrl: String(t.endpointUrl).replace('${ACME_TOOLS_URL}', 'http://localhost:5599'),
    }));
    const applied = await apply({ ...fixture, tools }, LLM_KEY);
    expect(applied.status, JSON.stringify(applied.body)).toBe(201);
    const exported = await exportConfig('support-demo');
    expect(exported.systemPrompt).toBe(fixture.systemPrompt);
    expect(exported.context).toEqual(fixture.context);
    expect(exported.suggestedPrompts).toEqual(fixture.suggestedPrompts);
    expect(exported.workflows).toEqual(['order-shipped']);
  });
});
