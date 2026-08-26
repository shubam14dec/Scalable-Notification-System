/**
 * Phase A10 — CONFIG-AS-CODE: the canonical agent config file.
 *
 * One JSON document that describes an agent completely enough to recreate it in
 * another environment: its identity, the six knobs, its custom tools (guards
 * included), the knowledge it reads and the workflows its prompt names. This
 * module OWNS that format — the serializer (agent row + tools -> file) and the
 * validator (file -> typed config) live here together, because a format whose
 * writer and reader live in different files is two formats waiting to disagree.
 *
 * ## Git-safe by construction
 *
 * NO SECRET IS EVER SERIALIZED. Not the LLM key, not the agent signing secret,
 * not a tool's call secret. Those are sealed at rest and write-only through the
 * API, and the export path below simply has no field to put them in — the file
 * is safe to commit because there is nowhere for a credential to hide, not
 * because a redaction step remembered to run.
 *
 * `llmBaseUrl` and `bridgeUrl` DO travel, and the call is deliberate: both are
 * endpoints rather than credentials, and both are already handed to any holder
 * of an API key by `agentView` (GET /v1/agents/:identifier returns them today).
 * A file that is strictly less revealing than the read route it was exported
 * through would be a fiction — and a bridge agent whose file omitted its own
 * bridgeUrl could not be recreated at all. The pairing worry is real but lands
 * on the other side: the key never travels, so an endpoint on its own dials
 * nothing. Import treats them accordingly (see the routes: a base URL is only
 * applied together with a key).
 *
 * ## Knowledge is REFERENCES, not content
 *
 * `knowledge` lists what an agent reads by name and origin. The chunk text and
 * its embeddings are NOT in the file (v1, user-approved): a knowledge base is
 * megabytes of customer prose that would dwarf the config, and re-indexing it
 * costs embedding calls that an import must not spend behind an operator's
 * back. The list is there so a promote-to-production preview can say "this
 * agent expects a source called `refund-policy` and the target has none".
 *
 * ## Workflows are REQUIREMENTS
 *
 * `workflows` lists the workflow keys the agent's prompt names. They are
 * checked, never created: a prompt that tells the model to trigger
 * `order-shipped` on a tenant with no such workflow is a broken agent, and the
 * import says so (422) instead of shipping it.
 *
 * ## Two laws, one place each
 *
 * This module states the file's SHAPE (what keys exist, what type each holds,
 * which are required). It deliberately does NOT restate any BOUND — the length
 * of a deny list, the range of a token budget, the URL-ness of a tool endpoint.
 * Those laws already live in the save routes' zod schemas and in core's cap
 * constants, and the import route runs every knob through THOSE VERY OBJECTS
 * (the A7 identity doctrine). A second copy of a bound here would be a second
 * law, and the day either moved an operator would import a config the dashboard
 * cannot save.
 *
 * ## Tolerant reader
 *
 * The CI eval fixture (`evals/agents/support-demo.agent.json`) is the
 * hand-rolled prototype of this feature, and it must remain a valid import file
 * without being edited to suit us. So the reader tolerates what it wrote:
 *   - unknown keys are ignored (`builtInTools`), including `_comment` blocks;
 *   - `formatVersion` may be absent (it predates the field) and defaults to 1;
 *   - `workflows` may be full workflow objects instead of bare keys — only the
 *     key is read, because that is all an import ever checks;
 *   - a tool `endpointUrl` may be an env template (`${ACME_TOOLS_URL}/refund`)
 *     rather than an absolute URL. The file is a document, not a live config:
 *     the URL law belongs to the moment we are about to dial it, so APPLY runs
 *     every endpoint through the tool-registration schema and its SSRF guard,
 *     and an unresolved template is refused there with the real message.
 */
import { z } from 'zod';
import type { Agent } from '../db/conversations.repo';
import type { AgentToolDef } from '../db/agent-tools.repo';
import type { KnowledgeSource } from '../db/knowledge.repo';

/** The only format version that exists. Bumped when the shape breaks. */
export const CONFIG_FORMAT_VERSION = 1;

/**
 * Bounds on the file's LISTS — memory guards on an uploaded document, not
 * product limits. They sit far above anything the product itself allows, so
 * the export path can never produce a file its own validator would refuse (the
 * one bug class that would make config-as-code untrustworthy).
 */
export const CONFIG_TOOLS_MAX = 200;
export const CONFIG_KNOWLEDGE_MAX = 200;
export const CONFIG_WORKFLOWS_MAX = 100;

/**
 * The agent fields that travel in a file, in the order a diff should read them.
 * Exported because the import route builds its create/patch bodies from exactly
 * this set — the file, the diff and the save must agree on what a config IS.
 *
 * NOT here, on purpose: `status` and the kill-switch's pause timestamp
 * (operational state, never config — an import must not disable a live agent or
 * resume a paused one), `promptVersion`/`canary` (history and trials belong to
 * the environment they happened in), and every secret.
 *
 * That timestamp's COLUMN NAME is deliberately absent from this file: A10 slice
 * A pins its readers to exactly three modules and proves it by scanning src/,
 * so a config file mentioning it — even in a comment — would read as a fourth.
 */
export const CONFIG_FIELDS = [
  'name',
  'description',
  'runtime',
  'bridgeUrl',
  'model',
  'systemPrompt',
  'llmBaseUrl',
  'context',
  'welcomeMessage',
  'suggestedPrompts',
  'routing',
  'topics',
  'moderation',
  'subscriberRate',
  // The three budget/backstop numbers travel together. `maxTokens` and
  // `autoResolveMinutes` are here because the contract is "the file is the whole
  // agent minus secrets and operational state" — a promotion that silently
  // dropped an agent's reply cap or its idle backstop would be exactly the
  // failure config-as-code exists to prevent, and a format with two forgotten
  // fields is a format nobody can trust the boundaries of.
  'maxTokens',
  'maxDailyTokens',
  'autoResolveMinutes',
] as const;

export type ConfigField = (typeof CONFIG_FIELDS)[number];

/* -------------------------------------------------------------------------- */
/* The schema                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * A custom tool as it travels. Shape only: `description`, `parameters` and
 * `endpointUrl` are re-validated at apply time by the tool-registration schema
 * (bounds, JSON-Schema-ness, reserved names, SSRF), which is where those laws
 * already live. `guard` rides through untouched for the same reason.
 */
const ConfigToolSchema = z.object({
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.unknown()),
  endpointUrl: z.string().min(1),
  approval: z.enum(['auto', 'required']).default('auto'),
  timeoutMs: z.number().int().optional(),
  guard: z.record(z.unknown()).nullable().optional(),
});

export type ConfigTool = z.infer<typeof ConfigToolSchema>;

/**
 * One knowledge source, by reference. `origin` is the URL for a `url` source
 * and the literal string 'text' for pasted text — enough to recognise the same
 * source in another environment, never enough to reconstruct its content.
 */
const ConfigKnowledgeSchema = z.object({
  name: z.string().min(1),
  origin: z.string().min(1),
});

export type ConfigKnowledge = z.infer<typeof ConfigKnowledgeSchema>;

/**
 * A workflow reference. A bare key is what we write; a full workflow object is
 * what the CI fixture writes (it seeds the workflows it names), and only the
 * key is read out of it — an import checks requirements, it never creates a
 * workflow, so `name` and `steps` have nothing to do here.
 */
const ConfigWorkflowSchema = z.union([
  z.string().min(1),
  z
    .object({ key: z.string().min(1) })
    .passthrough()
    .transform((w) => w.key),
]);

/**
 * The file. Knob values ride as `unknown` deliberately: this schema says a
 * `topics` key may be present, and the SAVE ROUTE'S OWN SCHEMA says what a
 * valid topics policy is. One law each.
 */
const AgentConfigFileSchema = z.object({
  formatVersion: z.number().int().positive().max(CONFIG_FORMAT_VERSION).default(CONFIG_FORMAT_VERSION),
  /** The file's primary key — the one bound this module states, because
   *  resolving create-vs-update is impossible without something to look up. */
  identifier: z.string().min(1),
  name: z.string(),
  description: z.string().optional(),
  runtime: z.enum(['bridge', 'managed']),
  bridgeUrl: z.string().optional(),
  model: z.string().optional(),
  systemPrompt: z.string().optional(),
  llmBaseUrl: z.string().optional(),
  context: z.record(z.unknown()).optional(),
  welcomeMessage: z.string().nullable().optional(),
  suggestedPrompts: z.array(z.unknown()).optional(),
  routing: z.unknown().optional(),
  topics: z.unknown().optional(),
  moderation: z.unknown().optional(),
  subscriberRate: z.unknown().optional(),
  // Shape only, like every knob here: the RANGES (256..8192 output tokens,
  // 1..43200 idle minutes, a positive day budget) belong to the save schemas
  // and are enforced when the import runs the file through them.
  maxTokens: z.number().nullable().optional(),
  maxDailyTokens: z.number().nullable().optional(),
  autoResolveMinutes: z.number().nullable().optional(),
  tools: z.array(ConfigToolSchema).max(CONFIG_TOOLS_MAX).optional(),
  knowledge: z.array(ConfigKnowledgeSchema).max(CONFIG_KNOWLEDGE_MAX).optional(),
  workflows: z.array(ConfigWorkflowSchema).max(CONFIG_WORKFLOWS_MAX).optional(),
});

export type AgentConfigFile = z.infer<typeof AgentConfigFileSchema>;

export type ParseResult =
  | { ok: true; config: AgentConfigFile }
  | { ok: false; issues: z.ZodIssue[] };

/**
 * Read a file. Unknown keys are STRIPPED rather than refused (zod's default,
 * kept on purpose): a config written by a newer dashboard should import into an
 * older API minus the field it does not know, and a human's `_comment` block
 * must never be the reason a deploy fails.
 *
 * A `formatVersion` ABOVE ours is the one forward-incompatibility we refuse —
 * silently ignoring keys is safe, silently mis-reading a changed shape is not.
 */
export function parseAgentConfigFile(raw: unknown): ParseResult {
  const parsed = AgentConfigFileSchema.safeParse(raw);
  if (!parsed.success) return { ok: false, issues: parsed.error.issues };
  return { ok: true, config: parsed.data };
}

/* -------------------------------------------------------------------------- */
/* Serializer                                                                  */
/* -------------------------------------------------------------------------- */

/** Drop a null/empty knob rather than writing `"topics": null` into the file. */
function present<T>(v: T | null | undefined): T | undefined {
  return v === null || v === undefined ? undefined : v;
}

/**
 * A knowledge source's origin: the URL it was fetched from, or 'text' for
 * pasted prose. The content itself never leaves the database.
 */
export function knowledgeOrigin(s: KnowledgeSource): string {
  const url = (s.meta as { url?: unknown } | null)?.url;
  return s.kind === 'url' && typeof url === 'string' && url.length > 0 ? url : 'text';
}

/**
 * Which of the tenant's workflow keys does this prompt actually name?
 *
 * There is no agent->workflow table to read: the managed brain offers
 * `trigger_workflow` with the tenant's whole workflow list as an enum, so an
 * agent's real dependency is exactly the set of keys its PROMPT tells the model
 * to trigger. Scanning the prompt for them is a heuristic, and it is stated as
 * one — but it is the same convention the CI fixture already follows by hand
 * (its prompt says "the order-shipped workflow" and its `workflows` block lists
 * `order-shipped`), and its failure modes are both benign: a key the prompt
 * never mentions is simply not exported, and a spurious match only ever adds a
 * requirement the source environment provably satisfies.
 *
 * Matching is boundary-anchored so a workflow keyed `ship` does not match the
 * word "shipping". One pass over the prompt per key, on a list a tenant edits by
 * hand — this is not a per-turn path.
 */
export function referencedWorkflowKeys(systemPrompt: string | null, tenantKeys: string[]): string[] {
  if (!systemPrompt) return [];
  const hits = tenantKeys.filter((key) => {
    const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}([^A-Za-z0-9_-]|$)`).test(systemPrompt);
  });
  return hits.sort().slice(0, CONFIG_WORKFLOWS_MAX);
}

/**
 * Agent row (+ its tools, knowledge and workflow requirements) -> the file.
 *
 * Absent is absent: a knob that was never configured is OMITTED rather than
 * written as null, so a config file reads as a list of decisions someone made
 * rather than a form with fifteen blanks. Lists are sorted by name so two
 * exports of the same agent are byte-identical regardless of row order.
 */
export function serializeAgentConfig(input: {
  agent: Agent;
  tools: AgentToolDef[];
  knowledge?: KnowledgeSource[];
  workflowKeys?: string[];
}): AgentConfigFile {
  const { agent } = input;
  const context = present(agent.context);
  const tools = [...input.tools].sort((a, b) => a.name.localeCompare(b.name));
  const knowledge = [...(input.knowledge ?? [])].sort((a, b) => a.name.localeCompare(b.name));

  return {
    formatVersion: CONFIG_FORMAT_VERSION,
    identifier: agent.identifier,
    name: agent.name,
    description: present(agent.description),
    runtime: agent.runtime,
    bridgeUrl: present(agent.bridge_url),
    model: present(agent.model),
    systemPrompt: present(agent.system_prompt),
    llmBaseUrl: present(agent.llm_base_url),
    // The context bag is `{}` on an agent that never set a rolling knob; an
    // empty object in the file would claim a decision nobody made.
    context:
      context && Object.keys(context).length > 0
        ? ({ ...context } as Record<string, unknown>)
        : undefined,
    welcomeMessage: present(agent.welcome_message),
    suggestedPrompts: present(agent.suggested_prompts),
    routing: present(agent.routing),
    topics: present(agent.topics),
    moderation: present(agent.moderation),
    subscriberRate: present(agent.subscriber_rate),
    maxTokens: present(agent.max_tokens),
    maxDailyTokens: present(agent.max_daily_tokens),
    autoResolveMinutes: present(agent.auto_resolve_minutes),
    // A custom tool is config; the call secret that authenticates us to its
    // backend is not, and there is no field here to put one in.
    tools: tools.length
      ? tools.map((t) => ({
          name: t.name,
          description: t.description,
          parameters: t.parameters,
          endpointUrl: t.endpoint_url,
          approval: t.approval,
          timeoutMs: t.timeout_ms,
          ...(t.guard ? { guard: t.guard as Record<string, unknown> } : {}),
        }))
      : undefined,
    knowledge: knowledge.length
      ? knowledge.map((s) => ({ name: s.name, origin: knowledgeOrigin(s) }))
      : undefined,
    workflows: input.workflowKeys?.length ? [...input.workflowKeys].sort() : undefined,
  };
}

/**
 * The file's agent fields as a body the save schemas can parse. Absent keys stay
 * absent — which is what makes an import non-destructive on the fields a file
 * does not mention (see the diff's 'removed' action below).
 */
export function agentFieldsFromConfig(config: AgentConfigFile): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of CONFIG_FIELDS) {
    const value = (config as Record<string, unknown>)[field];
    if (value !== undefined) out[field] = value;
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* Diff                                                                        */
/* -------------------------------------------------------------------------- */

/**
 * What an import will do to one field.
 *
 *   added     — the file carries it, the agent has nothing there yet.
 *   changed   — both carry it, and they differ. The file's value wins.
 *   unchanged — both carry it and they are identical.
 *   removed   — the AGENT carries it and the file does not.
 *
 * READ 'removed' CAREFULLY: it describes the FILE, not the outcome. Nothing is
 * removed. A field the file does not mention is left exactly as it is, for the
 * same reason a tool missing from the file is kept (below) — an import must not
 * destroy what the file's author never knew about. The preview reports the
 * asymmetry so an operator can see it; removing something stays an explicit act
 * in the dashboard.
 */
export type ConfigFieldAction = 'added' | 'changed' | 'removed' | 'unchanged';

export interface ConfigChange {
  field: ConfigField;
  action: ConfigFieldAction;
}

export interface ToolChanges {
  /** In the file, not on the agent — import creates these. */
  added: string[];
  /** On both, and different — import updates these in place, by name. */
  changed: string[];
  /** On the agent, not in the file — KEPT. See the note above. */
  removed: string[];
}

export interface ConfigDiff {
  mode: 'create' | 'update';
  changes: ConfigChange[];
  toolChanges: ToolChanges;
}

/** Order-insensitive value equality for the small JSON values a knob holds. */
function stable(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v) ?? 'undefined';
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  const keys = Object.keys(v as Record<string, unknown>).sort();
  return `{${keys
    .map((k) => `${JSON.stringify(k)}:${stable((v as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

function same(a: unknown, b: unknown): boolean {
  return stable(a) === stable(b);
}

/**
 * File vs live agent, field by field.
 *
 * The live side is compared THROUGH THE SERIALIZER: the agent row is turned
 * into the file it would export as, and the two files are compared. That is why
 * a stored `''` cheapModel or a `{}` context never shows up as a spurious
 * change — whatever normalisation export does, the diff inherits for free, and
 * "export, change nothing, import" is guaranteed to report nothing.
 */
export function diffAgentConfig(
  file: AgentConfigFile,
  live: { agent: Agent; tools: AgentToolDef[] } | null,
): ConfigDiff {
  if (!live) {
    return {
      mode: 'create',
      changes: CONFIG_FIELDS.filter(
        (f) => (file as Record<string, unknown>)[f] !== undefined,
      ).map((field) => ({ field, action: 'added' as const })),
      toolChanges: {
        added: (file.tools ?? []).map((t) => t.name).sort(),
        changed: [],
        removed: [],
      },
    };
  }

  const current = serializeAgentConfig({ agent: live.agent, tools: live.tools });
  const changes: ConfigChange[] = [];
  for (const field of CONFIG_FIELDS) {
    const next = (file as Record<string, unknown>)[field];
    const now = (current as Record<string, unknown>)[field];
    // Neither side has an opinion — not a row worth showing an operator.
    if (next === undefined && now === undefined) continue;
    if (next === undefined) changes.push({ field, action: 'removed' });
    else if (now === undefined) changes.push({ field, action: 'added' });
    else changes.push({ field, action: same(next, now) ? 'unchanged' : 'changed' });
  }

  // Tools reconcile BY NAME: a tool name is immutable and unique per agent (the
  // registration route refuses a rename), which makes it the only stable
  // identity a file can carry — a row id would be meaningless in the target
  // environment, where the same tool has a different one.
  const fileTools = new Map((file.tools ?? []).map((t) => [t.name, t]));
  const liveTools = new Map((current.tools ?? []).map((t) => [t.name, t]));
  const added: string[] = [];
  const changed: string[] = [];
  for (const [name, tool] of fileTools) {
    const existing = liveTools.get(name) as Record<string, unknown> | undefined;
    if (!existing) {
      added.push(name);
      continue;
    }
    // Only the fields the file STATES are compared. An omitted `timeoutMs` is
    // not a request to change the timeout, so it must not read as one — the
    // same "absent means no opinion" rule the field diff above follows, and the
    // reason the file format can stay silent about defaults it does not own.
    const stated = Object.entries(tool).filter(([, v]) => v !== undefined);
    if (stated.some(([k, v]) => !same(v, existing[k]))) changed.push(name);
  }
  const removed = [...liveTools.keys()].filter((n) => !fileTools.has(n));

  return {
    mode: 'update',
    changes,
    toolChanges: { added: added.sort(), changed: changed.sort(), removed: removed.sort() },
  };
}

/** Workflow keys the file requires that this tenant does not have. */
export function missingWorkflowKeys(file: AgentConfigFile, tenantKeys: string[]): string[] {
  const have = new Set(tenantKeys);
  return [...new Set(file.workflows ?? [])].filter((k) => !have.has(k)).sort();
}

/** Knowledge sources the file references that this agent does not have. */
export function missingKnowledgeNames(file: AgentConfigFile, liveNames: string[]): string[] {
  const have = new Set(liveNames);
  return [...new Set((file.knowledge ?? []).map((k) => k.name))].filter((n) => !have.has(n)).sort();
}
