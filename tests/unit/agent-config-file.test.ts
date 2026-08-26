/**
 * Phase A10 slice B — the CONFIG FILE FORMAT itself: the serializer, the
 * tolerant reader, and the diff. Pure functions over rows, so no database and
 * no app here; the routes that use them are proved in
 * tests/integration/agent-config-file.
 *
 * The claims:
 *   1. THE CI FIXTURE IS A VALID IMPORT FILE, unedited. evals/agents/*.agent.json
 *      is the hand-rolled prototype of this feature; if the shipped format
 *      cannot read it, the format converged with nothing.
 *   2. No secret can reach a file — asserted against a row that HAS them.
 *   3. Absent is absent: an unconfigured knob is omitted, never null.
 *   4. The diff says what an import would do, and 'removed' means "the file is
 *      silent", never "this will be deleted".
 */
import { describe, expect, test } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CONFIG_FIELDS,
  CONFIG_FORMAT_VERSION,
  diffAgentConfig,
  missingKnowledgeNames,
  missingWorkflowKeys,
  parseAgentConfigFile,
  referencedWorkflowKeys,
  serializeAgentConfig,
} from '../../src/core/agent-config-file';
import type { Agent } from '../../src/db/conversations.repo';
import type { AgentToolDef } from '../../src/db/agent-tools.repo';
import type { KnowledgeSource } from '../../src/db/knowledge.repo';

const FIXTURE = fileURLToPath(
  new URL('../../evals/agents/support-demo.agent.json', import.meta.url),
);

const SEALED_LLM = 'sealed:v1:llm-credentials-that-must-never-travel';
const SEALED_SIGNING = 'sealed:v1:signing-secret-that-must-never-travel';

function agentRow(over: Partial<Agent> = {}): Agent {
  return {
    id: 'agent-uuid',
    tenant_id: 'tenant-uuid',
    identifier: 'support-demo',
    name: 'Support Demo',
    description: null,
    runtime: 'managed',
    bridge_url: null,
    signing_secret: SEALED_SIGNING,
    model: 'glm-5',
    system_prompt: 'You are the Acme support agent.',
    llm_base_url: 'https://api.z.ai/api/anthropic',
    llm_credentials: SEALED_LLM,
    max_tokens: null,
    max_daily_tokens: null,
    auto_resolve_minutes: null,
    welcome_message: null,
    suggested_prompts: null,
    status: 'active',
    prompt_version: 3,
    canary_version: null,
    canary_percent: null,
    canary_started_at: null,
    canary_sample_percent: null,
    routing: null,
    topics: null,
    moderation: null,
    subscriber_rate: null,
    paused_at: null,
    context: {},
    created_at: '2026-08-26T00:00:00.000Z',
    updated_at: '2026-08-26T00:00:00.000Z',
    ...over,
  } as Agent;
}

function toolRow(over: Partial<AgentToolDef> = {}): AgentToolDef {
  return {
    id: 'tool-uuid',
    tenant_id: 'tenant-uuid',
    agent_id: 'agent-uuid',
    name: 'refund_customer',
    description: 'Refund an order.',
    parameters: { type: 'object', properties: { orderId: { type: 'string' } } },
    endpoint_url: 'http://localhost:5599/refund',
    secret: 'sealed:v1:tool-call-secret-that-must-never-travel',
    approval: 'auto',
    timeout_ms: 10_000,
    status: 'active',
    guard: null,
    created_at: '2026-08-26T00:00:00.000Z',
    updated_at: '2026-08-26T00:00:00.000Z',
    ...over,
  } as AgentToolDef;
}

describe('A10: the CI fixture is a valid config file, unedited', () => {
  const raw = JSON.parse(readFileSync(FIXTURE, 'utf8')) as Record<string, unknown>;
  const parsed = parseAgentConfigFile(raw);

  test('evals/agents/support-demo.agent.json passes the validator as-is', () => {
    expect(parsed.ok, parsed.ok ? '' : JSON.stringify(parsed)).toBe(true);
  });

  test('its documentation keys are ignored, not refused', () => {
    // The file carries a `_comment` array and a `builtInTools` block that this
    // format has no field for. Refusing them would make the fixture — the thing
    // the eval gate drives — un-importable; keeping them would put humans' notes
    // into a typed config. Ignored is the third answer.
    expect(raw).toHaveProperty('_comment');
    expect(raw).toHaveProperty('builtInTools');
    if (!parsed.ok) throw new Error('fixture did not parse');
    expect(parsed.config).not.toHaveProperty('_comment');
    expect(parsed.config).not.toHaveProperty('builtInTools');
  });

  test('its full workflow objects are read as the keys an import checks', () => {
    // The fixture writes {key, name, steps} because its seed CREATES them. An
    // import only ever CHECKS a requirement, so only the key is read.
    if (!parsed.ok) throw new Error('fixture did not parse');
    expect(parsed.config.workflows).toEqual(['order-shipped']);
  });

  test('it has no formatVersion, and defaults to 1 rather than failing', () => {
    expect(raw).not.toHaveProperty('formatVersion');
    if (!parsed.ok) throw new Error('fixture did not parse');
    expect(parsed.config.formatVersion).toBe(CONFIG_FORMAT_VERSION);
  });

  test('its ${ENV} tool endpoint survives the reader — the URL law lives at apply', () => {
    if (!parsed.ok) throw new Error('fixture did not parse');
    expect(parsed.config.tools?.[0]?.endpointUrl).toBe('${ACME_TOOLS_URL}/refund');
    expect(parsed.config.tools?.[0]?.guard).toEqual({ windowDays: 30, maxAutoCalls: 1 });
  });

  test('it carries no reply cap or backstop, and absent stays absent', () => {
    // Those two fields joined the format after this fixture was written. A
    // tolerant reader must leave them undefined rather than invent a default —
    // an import that filled them in would change the thing under test.
    if (!parsed.ok) throw new Error('fixture did not parse');
    expect(parsed.config.maxTokens).toBeUndefined();
    expect(parsed.config.autoResolveMinutes).toBeUndefined();
  });

  test('a file from a NEWER format version is refused, not half-read', () => {
    const future = parseAgentConfigFile({ ...raw, formatVersion: CONFIG_FORMAT_VERSION + 1 });
    expect(future.ok).toBe(false);
  });
});

describe('A10: what a file may never contain', () => {
  test('no sealed secret reaches the file, from an agent that has all of them', () => {
    const file = serializeAgentConfig({
      agent: agentRow(),
      tools: [toolRow()],
      knowledge: [],
      workflowKeys: [],
    });
    const text = JSON.stringify(file);
    expect(text).not.toContain(SEALED_LLM);
    expect(text).not.toContain(SEALED_SIGNING);
    expect(text).not.toContain('tool-call-secret');
    // Nor any field that could later be pointed at one.
    for (const key of ['llm', 'apiKey', 'signingSecret', 'secret', 'llmCredentials']) {
      expect(file).not.toHaveProperty(key);
    }
    expect(file.tools?.[0]).not.toHaveProperty('secret');
  });

  test('operational state stays behind: status, pause, versions and canaries', () => {
    const file = serializeAgentConfig({
      agent: agentRow({
        status: 'disabled',
        paused_at: '2026-08-26T10:00:00.000Z',
        canary_version: 2,
        canary_percent: 10,
      }),
      tools: [],
    });
    for (const key of ['status', 'pausedAt', 'promptVersion', 'canary']) {
      expect(file).not.toHaveProperty(key);
    }
    expect(CONFIG_FIELDS as readonly string[]).not.toContain('status');
  });
});

describe('A10: absent is absent', () => {
  test('an unconfigured knob is omitted rather than written as null', () => {
    const file = serializeAgentConfig({ agent: agentRow(), tools: [] });
    for (const key of [
      'description',
      'bridgeUrl',
      'welcomeMessage',
      'suggestedPrompts',
      'routing',
      'topics',
      'moderation',
      'subscriberRate',
      'maxTokens',
      'maxDailyTokens',
      'autoResolveMinutes',
      'context',
      'tools',
      'knowledge',
      'workflows',
    ]) {
      expect(file[key as keyof typeof file]).toBeUndefined();
    }
    // JSON.stringify is what actually ships over the wire.
    expect(JSON.parse(JSON.stringify(file))).toEqual({
      formatVersion: 1,
      identifier: 'support-demo',
      name: 'Support Demo',
      runtime: 'managed',
      model: 'glm-5',
      systemPrompt: 'You are the Acme support agent.',
      llmBaseUrl: 'https://api.z.ai/api/anthropic',
    });
  });

  test('the reply cap and the idle backstop travel — the file is the WHOLE agent', () => {
    // Minus secrets and operational state, and nothing else. A promotion that
    // dropped these two would leave the target agent answering with a different
    // output ceiling and a different idle timeout than the one that was tested.
    const file = serializeAgentConfig({
      agent: agentRow({ max_tokens: 2048, auto_resolve_minutes: 120, max_daily_tokens: 500_000 }),
      tools: [],
    });
    expect(file).toMatchObject({
      maxTokens: 2048,
      maxDailyTokens: 500_000,
      autoResolveMinutes: 120,
    });
  });

  test('an empty context bag claims no decision', () => {
    expect(serializeAgentConfig({ agent: agentRow({ context: {} }), tools: [] }).context).toBeUndefined();
    expect(
      serializeAgentConfig({ agent: agentRow({ context: { tailTurns: 4 } }), tools: [] }).context,
    ).toEqual({ tailTurns: 4 });
  });

  test('knowledge travels as a reference — name and origin, never content', () => {
    const sources = [
      { name: 'refund-policy', kind: 'url', meta: { url: 'https://acme.test/refunds' } },
      { name: 'pasted-faq', kind: 'text', meta: {} },
    ] as unknown as KnowledgeSource[];
    const file = serializeAgentConfig({ agent: agentRow(), tools: [], knowledge: sources });
    expect(file.knowledge).toEqual([
      { name: 'pasted-faq', origin: 'text' },
      { name: 'refund-policy', origin: 'https://acme.test/refunds' },
    ]);
  });
});

describe('A10: which workflows a prompt actually names', () => {
  test('only keys the prompt mentions are exported', () => {
    const prompt = 'When they enter an email, trigger the order-shipped workflow.';
    expect(referencedWorkflowKeys(prompt, ['order-shipped', 'weekly-digest'])).toEqual([
      'order-shipped',
    ]);
  });

  test('matching is boundary-anchored — "ship" is not "shipping"', () => {
    expect(referencedWorkflowKeys('tell them about shipping', ['ship'])).toEqual([]);
    expect(referencedWorkflowKeys('trigger ship now', ['ship'])).toEqual(['ship']);
  });

  test('an agent with no prompt requires nothing', () => {
    expect(referencedWorkflowKeys(null, ['order-shipped'])).toEqual([]);
  });

  test('missing keys are the file’s requirements minus what the tenant has', () => {
    const file = parseAgentConfigFile({
      identifier: 'a',
      name: 'A',
      runtime: 'managed',
      workflows: ['order-shipped', 'refund-issued'],
    });
    if (!file.ok) throw new Error('unexpected');
    expect(missingWorkflowKeys(file.config, ['order-shipped'])).toEqual(['refund-issued']);
    expect(missingWorkflowKeys(file.config, ['order-shipped', 'refund-issued'])).toEqual([]);
  });

  test('missing knowledge is reported by name', () => {
    const file = parseAgentConfigFile({
      identifier: 'a',
      name: 'A',
      runtime: 'managed',
      knowledge: [{ name: 'refund-policy', origin: 'https://acme.test/refunds' }],
    });
    if (!file.ok) throw new Error('unexpected');
    expect(missingKnowledgeNames(file.config, [])).toEqual(['refund-policy']);
    expect(missingKnowledgeNames(file.config, ['refund-policy'])).toEqual([]);
  });
});

describe('A10: the diff says what an import would do', () => {
  const live = {
    agent: agentRow({
      system_prompt: 'You are v1.',
      welcome_message: 'Hi there.',
      topics: { deny: ['medical advice'], redirect: 'Not here.' } as never,
    }),
    tools: [toolRow(), toolRow({ id: 'tool-2', name: 'lookup_order' })],
  };
  const current = serializeAgentConfig(live);

  test('an unknown identifier is a CREATE, and every stated field is added', () => {
    const parsed = parseAgentConfigFile(current);
    if (!parsed.ok) throw new Error('unexpected');
    const diff = diffAgentConfig(parsed.config, null);
    expect(diff.mode).toBe('create');
    expect(diff.changes.every((c) => c.action === 'added')).toBe(true);
    expect(diff.changes.map((c) => c.field)).toContain('systemPrompt');
    expect(diff.toolChanges).toEqual({
      added: ['lookup_order', 'refund_customer'],
      changed: [],
      removed: [],
    });
  });

  test('exporting and re-importing unchanged reports nothing changed', () => {
    const parsed = parseAgentConfigFile(JSON.parse(JSON.stringify(current)));
    if (!parsed.ok) throw new Error('unexpected');
    const diff = diffAgentConfig(parsed.config, live);
    expect(diff.mode).toBe('update');
    expect(diff.changes.filter((c) => c.action !== 'unchanged')).toEqual([]);
    expect(diff.toolChanges).toEqual({ added: [], changed: [], removed: [] });
  });

  test('changed, added and kept, each named for what it is', () => {
    const edited = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    edited.systemPrompt = 'You are v2.';
    delete edited.welcomeMessage; // the file is silent about it
    const refundTool = (current.tools ?? []).find((t) => t.name === 'refund_customer');
    (edited.tools as Array<Record<string, unknown>>) = [
      { ...refundTool, description: 'Refund an order, carefully.' },
      {
        name: 'check_stock',
        description: 'Check stock.',
        parameters: { type: 'object' },
        endpointUrl: 'http://localhost:5599/stock',
        approval: 'auto',
      },
    ];
    const parsed = parseAgentConfigFile(edited);
    if (!parsed.ok) throw new Error('unexpected');
    const diff = diffAgentConfig(parsed.config, live);

    const action = (f: string) => diff.changes.find((c) => c.field === f)?.action;
    expect(action('systemPrompt')).toBe('changed');
    expect(action('model')).toBe('unchanged');
    expect(action('topics')).toBe('unchanged');
    // 'removed' describes the FILE, not the outcome — the import leaves it.
    expect(action('welcomeMessage')).toBe('removed');
    expect(diff.toolChanges.added).toEqual(['check_stock']);
    expect(diff.toolChanges.changed).toEqual(['refund_customer']);
    expect(diff.toolChanges.removed).toEqual(['lookup_order']);
  });

  test('a tool field the file omits is not a change to that field', () => {
    // `timeoutMs` absent means "no opinion", not "reset it to the default".
    const edited = JSON.parse(JSON.stringify(current)) as Record<string, unknown>;
    (edited.tools as Array<Record<string, unknown>>).forEach((t) => delete t.timeoutMs);
    const parsed = parseAgentConfigFile(edited);
    if (!parsed.ok) throw new Error('unexpected');
    expect(diffAgentConfig(parsed.config, live).toolChanges.changed).toEqual([]);
  });

  test('a field neither side has is not a row in the table', () => {
    const parsed = parseAgentConfigFile(current);
    if (!parsed.ok) throw new Error('unexpected');
    const fields = diffAgentConfig(parsed.config, live).changes.map((c) => c.field);
    expect(fields).not.toContain('moderation');
    expect(fields).not.toContain('subscriberRate');
  });
});
