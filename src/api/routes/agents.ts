import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { authenticate } from '../auth';
import { getDayTokens } from '../../shared/agent-counters';
import { verifySubscriberToken } from '../../auth/subscriber-token';
import { sealSecret } from '../../auth/secret-box';
import { getEnvironment, getUserById } from '../../db/accounts.repo';
import { listWorkflows, upsertSubscriber } from '../../db/repositories';
import { listToolDefs, updateToolDef } from '../../db/agent-tools.repo';
import { listSources } from '../../db/knowledge.repo';
import {
  createValidatedTool,
  validateToolCreate,
  validateToolPatch,
  type ToolCreateInput,
  type ToolPatchInput,
} from './agent-tools';
import {
  agentFieldsFromConfig,
  diffAgentConfig,
  missingKnowledgeNames,
  missingWorkflowKeys,
  parseAgentConfigFile,
  referencedWorkflowKeys,
  serializeAgentConfig,
  type AgentConfigFile,
  type ConfigDiff,
} from '../../core/agent-config-file';
import {
  clearCanary,
  conversationTranscript,
  createAgent,
  deleteAgent,
  findConversationByThread,
  getAgent,
  getAgentById,
  getAgentPromptVersion,
  getConversation,
  getSubscriberByExternalId,
  listAgentPromptVersions,
  insertConversationMessage,
  listAgents,
  listConnectionsForAgent,
  listConversations,
  openConversation,
  reopenConversation,
  resolveConversation,
  setConversationHuman,
  handbackConversation,
  lastOperatorMessage,
  rotateAgentSecret,
  setAgentPaused,
  SAMPLE_PERCENT_DEFAULT,
  startCanary,
  updateAgent,
  type Agent,
  type AgentContext,
  type AgentPromptVersion,
} from '../../db/conversations.repo';
import { getQueue, QUEUE } from '../../shared/queues';
import { enqueueSummarize } from '../../core/episodic';
import { buildCanaryReport } from '../../core/turn-judge';
import { enqueueHandbackFold } from '../../core/rolling';
import { emitTenantEvent } from '../../core/tenant-events';
import { CardSchema } from '../../shared/cards';
import { logExec } from '../../core/execution-log';
import { tenantRateLimit } from '../rate-limit';
import { assertSafeOutboundUrl, UnsafeOutboundUrlError } from '../../core/safe-url';
import {
  agentHealth,
  agentRoutingStats,
  type AgentHealth,
} from '../../db/agent-health.repo';
import type { RoutingConfig } from '../../core/managed-brain';
import {
  LABEL_MAX as TOPIC_LABEL_MAX,
  LIST_MAX as TOPIC_LIST_MAX,
  REDIRECT_MAX as TOPIC_REDIRECT_MAX,
} from '../../core/topic-gate';
import {
  DENY_PHRASE_LIST_MAX,
  DENY_PHRASE_MAX,
  FALLBACK_MAX,
} from '../../core/reply-rules';
import {
  MAX_MESSAGES_MAX,
  MAX_MESSAGES_MIN,
  NOTICE_MAX,
  WINDOW_MINUTES_MAX,
  WINDOW_MINUTES_MIN,
} from '../../core/subscriber-rate';
import {
  listMemories,
  upsertMemory,
  deleteMemory,
  MemoryCapError,
  type SubscriberMemory,
} from '../../db/memories.repo';

/**
 * The health aggregate is a whole-window scan — cheap to serve slightly stale,
 * wasteful to recompute on every dashboard poll. Mirror the public-url TTL
 * cache idiom (src/config/public-url.ts): a tiny in-process Map keyed by
 * tenant+agent+window, each entry good for HEALTH_TTL_MS. A 60s lag on an
 * observability panel is invisible; the set-based query it saves is not (the
 * 10-20M rule — don't re-scan per poll). Entries are pruned opportunistically
 * on write, so the map stays bounded by the agents actually being viewed.
 */
const HEALTH_TTL_MS = 60_000;
const healthCache = new Map<string, { value: AgentHealth; at: number }>();

function cacheHealth(key: string, value: AgentHealth): void {
  const now = Date.now();
  for (const [k, entry] of healthCache) {
    if (now - entry.at >= HEALTH_TTL_MS) healthCache.delete(k);
  }
  healthCache.set(key, { value, at: now });
}

/**
 * A6: the routing stats window, in days. Fixed rather than a query knob — the
 * panel states the window in words next to the numbers, and one constant means
 * the sentence and the SQL can never disagree.
 */
const ROUTING_STATS_DAYS = 7;

/** days coerces to an int in [1, 30]; out-of-range (incl. 0) is a 400. */
const HealthQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(30).default(7),
});

/**
 * SSRF write-time gate: bridgeUrl and llm.baseUrl are dialed by our
 * servers, so they must never point at private infrastructure. Returns
 * the rejection message, or null when everything is safe.
 */
async function unsafeUrlError(urls: {
  bridgeUrl?: string | null;
  llmBaseUrl?: string | null;
}): Promise<string | null> {
  for (const [field, value] of Object.entries(urls)) {
    if (!value) continue;
    try {
      await assertSafeOutboundUrl(value);
    } catch (err) {
      if (err instanceof UnsafeOutboundUrlError) return `${field}: ${err.message}`;
      throw err;
    }
  }
  return null;
}

/** Managed-runtime brain config; apiKey is write-only (sealed at rest). */
const LlmConfigSchema = z.object({
  apiKey: z.string().min(8).max(512).optional(),
  /** Anthropic-compatible endpoint; omit for api.anthropic.com. */
  baseUrl: z.string().url().max(2048).nullable().optional(),
});

/** One agent-speaks-first starter: a chip label + the turn it sends. */
const SuggestedPromptSchema = z.object({
  title: z.string().min(1).max(40),
  message: z.string().min(1).max(200),
});

/**
 * Shared by create + patch. null clears; absent leaves untouched.
 *
 * An EMPTY STRING is refused rather than accepted-and-ignored. The repo writes
 * this column through a `''`-means-clear sentinel (conversations.repo.ts), so a
 * caller who sends `""` — a blank form field, a template that rendered to
 * nothing — would silently WIPE the greeting instead of being told the value is
 * meaningless. Clearing is an explicit act: send null.
 */
const welcomeMessageSchema = z
  .string()
  .min(1, 'welcomeMessage cannot be empty — to clear the welcome message, send null')
  .max(2000)
  .nullable()
  .optional();
const suggestedPromptsSchema = z.array(SuggestedPromptSchema).max(6).nullable().optional();

/**
 * D6 rolling-summarization knobs on the agent's `context` bag. Both optional;
 * defaults (trigger 20, tail 10) are applied at fold time, not stored. When
 * BOTH are given the law is 1 ≤ tailTurns < triggerTurns ≤ 200 (a fold must
 * always leave the tail strictly smaller than the trigger).
 */
const AgentContextSchema = z
  .object({
    triggerTurns: z.number().int().min(2).max(200).optional(),
    tailTurns: z.number().int().min(1).max(199).optional(),
  })
  .refine(
    (c) =>
      c.triggerTurns === undefined || c.tailTurns === undefined || c.tailTurns < c.triggerTurns,
    { message: 'tailTurns must be less than triggerTurns (1 ≤ tail < trigger ≤ 200)', path: ['tailTurns'] },
  );

/**
 * A6 — the cheap-first router's config. Two fields, because the escalation law
 * is binary; see `RoutingConfig` in core/managed-brain.ts, which owns the shape.
 *
 * `cheapModel` is optional in the OBJECT but required when `enabled`, so an
 * operator can switch the router off without losing the id they typed (the
 * dashboard round-trips it that way). It is stored as '' when absent, which the
 * brain already reads as "routing does not apply" — the same thing `enabled:
 * false` means, so a half-filled config can never accidentally route.
 *
 * Sending `routing: null` CLEARS it (back to never-configured). Exported so the
 * eval-run route can accept the same shape inside a candidate — a pre-save check
 * has to be able to grade the router the operator is about to turn on.
 */
export const RoutingSchema = z
  .object({
    enabled: z.boolean(),
    // max only — the LOWER bound is the refine below, and only when enabled.
    // A bare min(1) would 400 the perfectly sensible `{enabled: false,
    // cheapModel: ''}` a form sends when the switch is off and the id blank.
    cheapModel: z.string().max(255).optional(),
  })
  .refine((r) => !r.enabled || Boolean(r.cheapModel?.trim()), {
    message: 'cheapModel is required when routing is enabled',
    path: ['cheapModel'],
  });

/** Wire shape -> the stored `RoutingConfig` (cheapModel is '' when unset). */
export function routingConfig(r: z.infer<typeof RoutingSchema>): RoutingConfig {
  return { enabled: r.enabled, cheapModel: r.cheapModel ?? '' };
}

/**
 * A7 — the TOPIC GATE's policy (the `agents.topics` jsonb). Bounds are IMPORTED
 * from core/topic-gate.ts rather than retyped: that module normalizes a stored
 * row against them, and a second copy here would be a second law — the day
 * either moved, an operator would save a 30th label the gate then silently
 * dropped. Shape owned by `TopicsConfig` in core/managed-brain.ts.
 *
 * The refine is the one structural rule: a policy needs something to match on.
 * `redirect` is required and has no default — the whole gate is "send THIS
 * instead", and there is no sentence to invent on an operator's behalf.
 *
 * Sending `topics: null` CLEARS it (back to never-configured). Exported so the
 * eval-run route's candidate accepts THE SAME OBJECT: a pre-save check must
 * grade the gate the operator is about to save, and two schemas for one wire
 * shape is exactly how a check comes to grade something else.
 */
export const TopicsSchema = z
  .object({
    deny: z.array(z.string().min(1).max(TOPIC_LABEL_MAX)).max(TOPIC_LIST_MAX).optional(),
    allow: z.array(z.string().min(1).max(TOPIC_LABEL_MAX)).max(TOPIC_LIST_MAX).optional(),
    redirect: z.string().min(1).max(TOPIC_REDIRECT_MAX),
  })
  .refine((t) => (t.deny?.length ?? 0) > 0 || (t.allow?.length ?? 0) > 0, {
    message: 'topics needs at least one deny or allow label',
    path: ['deny'],
  });

/**
 * A7 slice B — the REPLY RULES (the `agents.moderation` jsonb), on the same
 * terms as TopicsSchema above: bounds imported from core/reply-rules.ts (which
 * exported them for exactly this), one structural refine (rules need something
 * that can match), a required `fallback` with no default, `null` clears, and the
 * candidate reuses this very object. Shape owned by `ModerationConfig`.
 */
export const ModerationSchema = z
  .object({
    denyPhrases: z
      .array(z.string().min(1).max(DENY_PHRASE_MAX))
      .max(DENY_PHRASE_LIST_MAX)
      .optional(),
    blockPii: z.boolean().optional(),
    fallback: z.string().min(1).max(FALLBACK_MAX),
  })
  .refine((m) => (m.denyPhrases?.length ?? 0) > 0 || m.blockPii === true, {
    message: 'moderation needs at least one deny phrase or blockPii',
    path: ['denyPhrases'],
  });

/**
 * A8 — the PER-CUSTOMER MESSAGE LIMIT (the `agents.subscriber_rate` jsonb), on
 * the same terms as the two schemas above: bounds IMPORTED from
 * core/subscriber-rate.ts (which exported them for exactly this), all three
 * fields required because each is a real guard — a cap with no window is not a
 * rate, a window with no cap is not a limit, and a limit with no notice is a
 * customer talking to a wall — and `null` clears.
 *
 * `notice` is TRIMMED here and refuses whitespace-only, which is one step
 * stricter than `redirect`/`fallback`, where A7 caught the same shape in the
 * form alone. The lesson generalizes and the SDK does not go through the form:
 * `resolveSubscriberRate` trims and reads an empty notice as NO LIMIT AT ALL,
 * so a lone space accepted here would store a limit that silently does nothing
 * while the operator reads it back from the API and believes it is on.
 *
 * NOT EXPORTED, deliberately — unlike TopicsSchema and ModerationSchema, which
 * the eval-run candidate imports. There is no candidate field to share it with
 * (see SubscriberRateConfig in core/managed-brain.ts: an eval's scenario turns
 * are a burst from one synthetic subscriber by construction, so a gradeable
 * message limit would grade the limiter instead of the prompt), and an export
 * would be an invitation to wire one up.
 */
const SubscriberRateSchema = z.object({
  maxMessages: z.number().int().min(MAX_MESSAGES_MIN).max(MAX_MESSAGES_MAX),
  windowMinutes: z.number().int().min(WINDOW_MINUTES_MIN).max(WINDOW_MINUTES_MAX),
  notice: z.string().trim().min(1).max(NOTICE_MAX),
});

/**
 * Both gates are MANAGED concepts, and the sentence says why in the operator's
 * own terms rather than quoting a runtime enum at them. One constant per gate
 * because the create refine, the patch guard and (for routing) the stats route
 * all state the same law, and a law stated three times in three wordings is
 * three laws to a reader of error messages.
 */
const TOPICS_MANAGED_ONLY =
  'topic rules need a managed agent: a bridge agent’s brain is your own code, so what it will discuss is decided there';
const MODERATION_MANAGED_ONLY =
  'reply rules need a managed agent: a bridge agent’s replies are written by your own code, which is where to check them';

const AgentSchema = z
  .object({
    identifier: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[a-z0-9-_]+$/, 'lowercase letters, digits, - _ only'),
    name: z.string().min(1).max(255),
    description: z.string().max(2048).optional(),
    runtime: z.enum(['bridge', 'managed']).default('bridge'),
    bridgeUrl: z.string().url().max(2048).optional(),
    model: z.string().min(1).max(255).optional(),
    systemPrompt: z.string().max(100_000).optional(),
    maxTokens: z.number().int().min(256).max(8192).optional(),
    /** Phase 22 G2 daily token budget (null/absent = off). */
    maxDailyTokens: z.number().int().min(1).nullable().optional(),
    autoResolveMinutes: z.number().int().min(1).max(43_200).optional(),
    llm: LlmConfigSchema.optional(),
    welcomeMessage: welcomeMessageSchema,
    suggestedPrompts: suggestedPromptsSchema,
    context: AgentContextSchema.optional(),
    /** A6 cheap-first routing. Managed only (refined below), absent = off. */
    routing: RoutingSchema.optional(),
    /** A7 topic gate. Managed only (refined below), absent = off. */
    topics: TopicsSchema.optional(),
    /** A7 reply rules. Managed only (refined below), absent = off. */
    moderation: ModerationSchema.optional(),
    /**
     * A8 per-customer message limit, absent = off. NOTE THE MISSING REFINE: this
     * is the one per-agent config with NO managed-only guard, and the omission
     * is the design rather than an oversight. Routing, topics and moderation are
     * brain config — they stand between a bridge customer and their own code, so
     * accepting them on a bridge agent would store a policy nothing reads. This
     * is INGRESS PROTECTION, enforced above the managed/bridge fork at the top of
     * processTurn: a flooding customer costs a bridge agent its own compute and
     * its own bill just as surely as it costs a managed agent tokens, and
     * declining to protect it would be a courtesy nobody asked for.
     */
    subscriberRate: SubscriberRateSchema.optional(),
  })
  // A6: routing is a MANAGED concept — a bridge agent's brain is the customer's
  // own code behind a signed URL, and we never pick the model it runs on. Same
  // law the versions/canary/candidate surfaces enforce, stated at create time.
  .refine((a) => a.routing === undefined || a.runtime === 'managed', {
    message:
      'model routing needs a managed agent: a bridge agent’s brain is your own code, not a model we choose',
    path: ['routing'],
  })
  // A7: both gates are managed concepts for the same reason and enforce it in
  // the same place — the turn path applies them inside the managed branch only,
  // so accepting one on a bridge agent would store a policy nothing reads.
  .refine((a) => a.topics === undefined || a.runtime === 'managed', {
    message: TOPICS_MANAGED_ONLY,
    path: ['topics'],
  })
  .refine((a) => a.moderation === undefined || a.runtime === 'managed', {
    message: MODERATION_MANAGED_ONLY,
    path: ['moderation'],
  })
  .refine((a) => a.runtime !== 'bridge' || Boolean(a.bridgeUrl), {
    message: 'bridgeUrl is required for the bridge runtime',
    path: ['bridgeUrl'],
  })
  .refine((a) => a.runtime !== 'managed' || Boolean(a.llm?.apiKey), {
    message: 'llm.apiKey is required for the managed runtime',
    path: ['llm', 'apiKey'],
  });

const AgentPatchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2048).optional(),
  runtime: z.enum(['bridge', 'managed']).optional(),
  bridgeUrl: z.string().url().max(2048).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  model: z.string().min(1).max(255).optional(),
  systemPrompt: z.string().max(100_000).optional(),
  maxTokens: z.number().int().min(256).max(8192).optional(),
  /** null switches the daily token budget off. */
  maxDailyTokens: z.number().int().min(1).nullable().optional(),
  /** null switches the idle-timeout backstop off. */
  autoResolveMinutes: z.number().int().min(1).max(43_200).nullable().optional(),
  llm: LlmConfigSchema.optional(),
  welcomeMessage: welcomeMessageSchema,
  suggestedPrompts: suggestedPromptsSchema,
  context: AgentContextSchema.optional(),
  /** A6: null switches the router off and forgets the config; absent leaves it. */
  routing: RoutingSchema.nullable().optional(),
  /** A7: null switches the topic gate off and forgets it; absent leaves it. */
  topics: TopicsSchema.nullable().optional(),
  /** A7: null switches the reply rules off and forgets them; absent leaves them. */
  moderation: ModerationSchema.nullable().optional(),
  /**
   * A8: null switches the message limit off and forgets it; absent leaves it.
   * Accepted on BOTH runtimes — see the create schema's field for why this one
   * carries no managed-only guard, and note the matching absence below in the
   * PATCH handler, where the other three configs are all runtime-checked.
   */
  subscriberRate: SubscriberRateSchema.nullable().optional(),
});

const InboundMessageSchema = z.object({
  subscriberId: z.string().min(1).max(255),
  text: z.string().min(1).max(8192),
  /** Client-supplied id makes retries idempotent (same doctrine as transactionId). */
  messageId: z.string().min(1).max(255).optional(),
});

const InboundActionSchema = z
  .object({
    subscriberId: z.string().min(1).max(255),
    /** The clicked button / answered card, as offered on the agent reply. */
    actionId: z.string().min(1).max(64),
    /** A button/select label (human-readable); absent for a raw text_input answer. */
    label: z.string().min(1).max(48).optional(),
    /** The select option id or typed text_input value. */
    value: z.string().min(1).max(3000).optional(),
    /** Client-supplied id: a double-click can never become two actions. */
    actionEventId: z.string().min(1).max(255).optional(),
  })
  .refine((d) => d.label || d.value, { message: 'label or value required' });

/** An operator/API push of an agent message into an existing conversation. */
const PushMessageSchema = z
  .object({
    text: z.string().min(1).max(8192),
    /** Client-supplied id makes retries idempotent (same doctrine as messages). */
    messageId: z.string().min(1).max(255).optional(),
    buttons: z
      .array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(48) }))
      .max(6)
      .optional(),
    card: CardSchema.optional(),
    /** Push onto a resolved thread only reopens it when this is set. */
    reopen: z.boolean().optional(),
  })
  .refine((d) => !(d.buttons && d.card), {
    message: 'a reply may carry buttons or a card, not both',
  });

/**
 * D11 memory admin: an operator edit of one durable fact. Bounds mirror the D2
 * caps (the repo re-enforces them as law — a 400 here on a too-long value, a
 * 409 there on a full profile).
 */
const MemoryPutSchema = z.object({
  key: z.string().min(1).max(64),
  value: z.string().min(1).max(300),
});

/** Public shape for a memory row (no internal ids). */
function memoryView(m: SubscriberMemory) {
  return { key: m.key, value: m.value, source: m.source, updatedAt: m.updated_at };
}

/** Public shape — sealed secrets (signing, LLM key) never leave the API. */
function agentView(agent: Agent) {
  return {
    identifier: agent.identifier,
    name: agent.name,
    description: agent.description,
    runtime: agent.runtime,
    bridgeUrl: agent.bridge_url,
    model: agent.model,
    systemPrompt: agent.system_prompt,
    llmBaseUrl: agent.llm_base_url,
    maxTokens: agent.max_tokens,
    maxDailyTokens: agent.max_daily_tokens,
    autoResolveMinutes: agent.auto_resolve_minutes,
    welcomeMessage: agent.welcome_message,
    suggestedPrompts: agent.suggested_prompts,
    // D6 rolling knobs (empty object when unconfigured — defaults apply at fold time).
    context: (agent.context ?? {}) as AgentContext,
    hasLlmKey: Boolean(agent.llm_credentials),
    // A5: the live snapshot number, so the editor can mark "current" in the
    // version list without a second round trip. Meaningless for bridge agents
    // (they have no versions) — the Versions surface is managed-only.
    promptVersion: agent.prompt_version,
    // A5 slice B: present ONLY while a trial is running, so the dashboard's
    // "is there a canary?" test is the presence of the object rather than a
    // percent it has to interpret. canary_version is the authoritative flag.
    canary:
      agent.canary_version !== null
        ? {
            version: agent.canary_version,
            percent: agent.canary_percent,
            startedAt: agent.canary_started_at,
            // A5 slice C: shown on the comparison panel so an operator reading
            // "n=31" knows what it is 31 out of. Resolved here (never raw null)
            // because null means "a trial started before sampling shipped",
            // which behaves as the default rather than as "off".
            samplePercent: agent.canary_sample_percent ?? SAMPLE_PERCENT_DEFAULT,
          }
        : null,
    // A6: the cheap-first router's config, or null when it was never set up —
    // same "presence is the flag" shape as canary above, so the editor tests the
    // object rather than interpreting an enabled flag on a config that isn't
    // there. Managed-only; a bridge agent can never have one.
    routing: agent.routing ?? null,
    // A7: the two gates, or null when never configured — the same "presence of a
    // config is the flag" shape as routing and canary above, so the editor tests
    // the object rather than reading an enabled flag off a config that is not
    // there. Managed-only; a bridge agent can never have either.
    topics: agent.topics ?? null,
    moderation: agent.moderation ?? null,
    // A8: the per-customer message limit, or null when never configured — the
    // same "presence is the flag" shape as the three above. Unlike them it can
    // be non-null on a BRIDGE agent, because the limit is ingress protection
    // rather than brain config (see SubscriberRateConfig).
    subscriberRate: agent.subscriber_rate ?? null,
    status: agent.status,
    // A10 THE KILL-SWITCH: when an operator paused this agent, or null = live.
    // Sits BESIDE `status` rather than inside it on purpose — the two answer
    // different questions and a client must be able to see both at once. An
    // agent can be disabled and paused, or active and paused; "active" keeps
    // meaning "the door is open", and this says whether anyone is answering.
    // Exposed as the raw timestamp, not a boolean, so the dashboard can show
    // WHEN and a post-mortem can read it straight off the API.
    pausedAt: agent.paused_at,
    createdAt: agent.created_at,
    updatedAt: agent.updated_at,
  };
}

function newAgentSecret(): string {
  return `ags_${randomBytes(24).toString('hex')}`;
}

/**
 * Inbound turns accept the widget's credential (x-subscriber-token, scoped
 * to exactly one subscriber) besides api-key/JWT — same pattern as inbox.
 */
export async function authenticateSender(
  req: FastifyRequest,
  reply: FastifyReply,
  subscriberId: string,
): Promise<boolean> {
  const token = req.headers['x-subscriber-token'];
  if (typeof token === 'string' && token.length > 0) {
    const payload = verifySubscriberToken(token);
    if (!payload) {
      await reply.code(401).send({ error: 'invalid or expired subscriber token' });
      return false;
    }
    if (payload.subscriberId !== subscriberId) {
      await reply.code(403).send({ error: 'token is for a different subscriber' });
      return false;
    }
    const environment = await getEnvironment(payload.tenantId);
    if (!environment) {
      await reply.code(401).send({ error: 'unknown environment' });
      return false;
    }
    req.tenant = environment;
    return true;
  }
  await authenticate(req, reply);
  return Boolean(req.tenant) && !reply.sent;
}

/**
 * A10: the two SAVE PATHS, lifted out of their route handlers so the config
 * importer can ride them instead of re-implementing them.
 *
 * This is the A5 doctrine applied to a new caller: an import-update goes
 * through `updateAgent`, which is what mints a prompt version when the prompt or
 * model moves — an importer with its own UPDATE would be a second way to change
 * what an agent says, and history would quietly stop being complete. The same
 * argument covers the guards: the SSRF check, the managed-only rules and the
 * "a managed agent needs a key" rule are laws about agents, not about the route
 * someone reached them through.
 */
type SaveOutcome<T> = { ok: true; value: T } | { ok: false; status: 400 | 404 | 409; error: string };

async function createAgentFromInput(
  tenantId: string,
  data: z.infer<typeof AgentSchema>,
): Promise<SaveOutcome<{ agent: Agent; signingSecret: string }>> {
  const unsafe = await unsafeUrlError({
    bridgeUrl: data.bridgeUrl,
    llmBaseUrl: data.llm?.baseUrl,
  });
  if (unsafe) return { ok: false, status: 400, error: unsafe };
  const secret = newAgentSecret();
  const agent = await createAgent({
    tenantId,
    identifier: data.identifier,
    name: data.name,
    description: data.description,
    runtime: data.runtime,
    bridgeUrl: data.bridgeUrl,
    sealedSecret: sealSecret(secret),
    model: data.model,
    systemPrompt: data.systemPrompt,
    maxTokens: data.maxTokens,
    maxDailyTokens: data.maxDailyTokens ?? undefined,
    autoResolveMinutes: data.autoResolveMinutes,
    llmBaseUrl: data.llm?.baseUrl ?? undefined,
    sealedLlmCredentials: data.llm?.apiKey
      ? sealSecret(JSON.stringify({ apiKey: data.llm.apiKey }))
      : undefined,
    welcomeMessage: data.welcomeMessage,
    suggestedPrompts: data.suggestedPrompts,
    context: data.context,
    routing: data.routing ? routingConfig(data.routing) : undefined,
    // A7: no wire->stored conversion for these two — unlike routing (whose
    // optional cheapModel becomes ''), the validated shape IS the stored
    // shape, so a converter would only be a place for the two to diverge.
    topics: data.topics,
    moderation: data.moderation,
    // A8: same story — the validated shape IS the stored shape. Passed
    // unconditionally, on either runtime.
    subscriberRate: data.subscriberRate,
  });
  if (!agent) {
    return { ok: false, status: 409, error: `agent "${data.identifier}" already exists` };
  }
  return { ok: true, value: { agent, signingSecret: secret } };
}

async function patchAgentFromInput(
  tenantId: string,
  identifier: string,
  existing: Agent,
  data: z.infer<typeof AgentPatchSchema>,
): Promise<SaveOutcome<Agent>> {
  // Switching runtimes must not leave a broken agent behind.
  const nextRuntime = data.runtime ?? existing.runtime;
  if (nextRuntime === 'bridge' && !(data.bridgeUrl ?? existing.bridge_url)) {
    return { ok: false, status: 400, error: 'bridge runtime requires a bridgeUrl' };
  }
  if (nextRuntime === 'managed' && !(data.llm?.apiKey || existing.llm_credentials)) {
    return { ok: false, status: 400, error: 'managed runtime requires llm.apiKey' };
  }
  // A6: routing is managed-only, judged against what the agent will BE after
  // this patch (nextRuntime), not what it was — the same test the bridgeUrl
  // and llm.apiKey guards above make. Clearing (`routing: null`) is exempt
  // on purpose: a managed→bridge conversion must be able to switch the
  // router off in the same request, and a clear is never wrong.
  if (data.routing != null && nextRuntime !== 'managed') {
    return {
      ok: false,
      status: 400,
      error:
        'model routing needs a managed agent: a bridge agent’s brain is your own code, not a model we choose',
    };
  }
  // A7: the two gates take routing's guard verbatim, including its exemption
  // — `!= null` lets a CLEAR through on a managed→bridge conversion, and
  // switching a gate off is never the wrong answer for an agent that cannot
  // run it. Judged against nextRuntime, so the test is what the agent will
  // BE after this patch rather than what it was.
  if (data.topics != null && nextRuntime !== 'managed') {
    return { ok: false, status: 400, error: TOPICS_MANAGED_ONLY };
  }
  if (data.moderation != null && nextRuntime !== 'managed') {
    return { ok: false, status: 400, error: MODERATION_MANAGED_ONLY };
  }
  // A8: NO runtime guard here, and its absence is deliberate — the message
  // limit is the one config a bridge agent may hold. Three guards in a row
  // followed by a fourth field that has none is exactly where a later reader
  // would "fix" the omission, so it is written down instead: this limit runs
  // above the managed/bridge fork and protects the customer's own compute.

  const unsafe = await unsafeUrlError({
    bridgeUrl: data.bridgeUrl,
    llmBaseUrl: data.llm?.baseUrl,
  });
  if (unsafe) return { ok: false, status: 400, error: unsafe };

  const agent = await updateAgent(tenantId, identifier, {
    name: data.name,
    description: data.description,
    runtime: data.runtime,
    bridgeUrl: data.bridgeUrl,
    status: data.status,
    model: data.model,
    systemPrompt: data.systemPrompt,
    maxTokens: data.maxTokens,
    maxDailyTokens: data.maxDailyTokens,
    autoResolveMinutes: data.autoResolveMinutes,
    llmBaseUrl: data.llm === undefined ? undefined : data.llm.baseUrl,
    sealedLlmCredentials: data.llm?.apiKey
      ? sealSecret(JSON.stringify({ apiKey: data.llm.apiKey }))
      : undefined,
    welcomeMessage: data.welcomeMessage,
    suggestedPrompts: data.suggestedPrompts,
    context: data.context,
    routing:
      data.routing === undefined
        ? undefined
        : data.routing === null
          ? null
          : routingConfig(data.routing),
    // A7: absent leaves the stored policy alone, null clears it, an object
    // REPLACES it whole. No merge on purpose — a half-updated deny list is a
    // guard nobody can reason about, and "which entries did I just remove?"
    // is not a question a safety surface should be able to raise.
    topics: data.topics,
    moderation: data.moderation,
    // A8: absent leaves the limit alone, null clears it, an object replaces
    // it whole — three fields, so a merge would only buy ambiguity.
    subscriberRate: data.subscriberRate,
  });
  if (!agent) return { ok: false, status: 404, error: 'unknown agent' };
  return { ok: true, value: agent };
}

export function registerAgentRoutes(app: FastifyInstance) {
  // ---- agent management (dashboard / server credentials) ----

  app.post('/v1/agents', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = AgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const created = await createAgentFromInput(req.tenant.id, parsed.data);
    if (!created.ok) return reply.code(created.status).send({ error: created.error });
    // The plaintext secret is shown exactly once, like API keys.
    return reply
      .code(201)
      .send({ agent: agentView(created.value.agent), signingSecret: created.value.signingSecret });
  });

  app.get('/v1/agents', { preHandler: [authenticate] }, async (req) => ({
    agents: (await listAgents(req.tenant.id)).map(agentView),
  }));

  app.get<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      return { agent: agentView(agent) };
    },
  );

  /**
   * Rolling-window observability for one agent (dashboard health panel): turn /
   * reply / note counts, turn latency (avg + p95 over stored traces), token
   * means, and per-tool call/failure tallies. Served from a 60s in-process
   * cache so a polling panel never re-runs the window scan on every tick.
   */
  app.get<{ Params: { identifier: string }; Querystring: { days?: string } }>(
    '/v1/agents/:identifier/health',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = HealthQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid query', details: parsed.error.issues });
      }
      const { days } = parsed.data;
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      const key = `${req.tenant.id}:${agent.id}:${days}`;
      const hit = healthCache.get(key);
      const stats =
        hit && Date.now() - hit.at < HEALTH_TTL_MS
          ? hit.value
          : await agentHealth(req.tenant.id, agent.id, days);
      if (stats !== hit?.value) cacheHealth(key, stats);
      // Budget numbers ride OUTSIDE the cache: the day counter is one Redis
      // GET, and a 60s-stale "used today" would misread a tripping breaker.
      const usedTodayTokens = await getDayTokens(agent.id);
      return {
        windowDays: days,
        ...stats,
        usedTodayTokens,
        maxDailyTokens: agent.max_daily_tokens ?? null,
      };
    },
  );

  /**
   * A6 slice B — what the router did for this agent lately. The window is FIXED
   * at 7 days and echoed back, so the sentence the dashboard prints ("in the
   * last 7 days") can never drift from the number it prints beside it. Managed
   * only, like every other routing surface.
   */
  app.get<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/routing/stats',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      if (agent.runtime !== 'managed') {
        return reply.code(400).send({
          error:
            'model routing needs a managed agent: a bridge agent’s brain is your own code, not a model we choose',
        });
      }
      const stats = await agentRoutingStats(req.tenant.id, agent.id, ROUTING_STATS_DAYS);
      return { windowDays: ROUTING_STATS_DAYS, ...stats };
    },
  );

  app.patch<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = AgentPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const existing = await getAgent(req.tenant.id, req.params.identifier);
      if (!existing) return reply.code(404).send({ error: 'unknown agent' });

      const saved = await patchAgentFromInput(
        req.tenant.id,
        req.params.identifier,
        existing,
        parsed.data,
      );
      if (!saved.ok) return reply.code(saved.status).send({ error: saved.error });
      return { agent: agentView(saved.value) };
    },
  );

  // ---- A5 slice A: prompt versions ----
  // Every managed prompt/model save snapshots itself (see updateAgent). These
  // three routes are the history's read + restore surface. Bridge agents 400
  // rather than 404: the agent exists, versioning simply doesn't apply to a
  // brain that lives in the customer's own code.

  /** Resolve :identifier + :version, rejecting bridge agents and bad numbers. */
  async function resolveVersionTarget(
    tenantId: string,
    identifier: string,
    reply: FastifyReply,
  ): Promise<Agent | null> {
    const agent = await getAgent(tenantId, identifier);
    if (!agent) {
      await reply.code(404).send({ error: 'unknown agent' });
      return null;
    }
    if (agent.runtime !== 'managed') {
      await reply.code(400).send({
        error:
          'prompt versions need a managed agent: a bridge agent’s brain is your own code, not a prompt',
      });
      return null;
    }
    return agent;
  }

  /** :version is a positive integer or nothing — never a coerced NaN. */
  function parseVersion(raw: string): number | null {
    return /^\d+$/.test(raw) && Number(raw) > 0 ? Number(raw) : null;
  }

  app.get<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/versions',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await resolveVersionTarget(req.tenant.id, req.params.identifier, reply);
      if (!agent) return reply;
      const versions = await listAgentPromptVersions(agent.id);
      return {
        currentVersion: agent.prompt_version,
        // Lists stay light: length + head, never the whole prompt (a long
        // prompt × a long history is megabytes for a panel of dates).
        versions: versions.map((v) => ({
          version: v.version,
          model: v.model,
          promptLength: v.prompt_length,
          promptHead: v.prompt_head,
          current: v.version === agent.prompt_version,
          createdAt: v.created_at,
        })),
      };
    },
  );

  app.get<{ Params: { identifier: string; version: string } }>(
    '/v1/agents/:identifier/versions/:version',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await resolveVersionTarget(req.tenant.id, req.params.identifier, reply);
      if (!agent) return reply;
      const version = parseVersion(req.params.version);
      const row = version && (await getAgentPromptVersion(agent.id, version));
      if (!row) return reply.code(404).send({ error: 'unknown version' });
      return {
        version: {
          version: row.version,
          systemPrompt: row.system_prompt,
          model: row.model,
          current: row.version === agent.prompt_version,
          createdAt: row.created_at,
        },
      };
    },
  );

  /**
   * Restore is a SAVE, not a rewind: it copies an old snapshot forward through
   * the ordinary update path, so it mints a NEW version, bumps prompt_version,
   * and meets whatever guards land on saves. History is append-only — restoring
   * v1 never deletes v2, it publishes v3.
   *
   * Shared with Promote below, which IS a restore (of the version that just
   * won its trial) plus ending the trial. One code path, so a promoted version
   * enters history exactly like any other save rather than by a second
   * mechanism that could drift from this one.
   */
  async function restoreVersionAsSave(
    tenantId: string,
    identifier: string,
    row: AgentPromptVersion,
  ): Promise<Agent | null> {
    return updateAgent(tenantId, identifier, {
      systemPrompt: row.system_prompt ?? undefined,
      // null is the CLEAR sentinel here (back to DEFAULT_MODEL) — restoring a
      // snapshot that ran without a pinned model must reproduce exactly that.
      model: row.model,
    });
  }

  app.post<{ Params: { identifier: string; version: string } }>(
    '/v1/agents/:identifier/versions/:version/restore',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await resolveVersionTarget(req.tenant.id, req.params.identifier, reply);
      if (!agent) return reply;
      const version = parseVersion(req.params.version);
      const row = version && (await getAgentPromptVersion(agent.id, version));
      if (!row) return reply.code(404).send({ error: 'unknown version' });

      const restored = await restoreVersionAsSave(req.tenant.id, req.params.identifier, row);
      if (!restored) return reply.code(404).send({ error: 'unknown agent' });
      return {
        agent: agentView(restored),
        restoredFrom: row.version,
        // Equal to restoredFrom's content but a new number — unless the restore
        // was a no-op (the live config already matched), which mints nothing.
        version: restored.prompt_version,
      };
    },
  );

  // ---- A5 slice B: canary (one version on trial against real traffic) ----
  // Start / Stop / Promote. The trial itself is not a separate override
  // mechanism: a conversation is assigned an arm when it opens, and a
  // canary-arm turn runs on the trial version through the SAME candidate knob
  // the pre-save eval check uses (A4). These routes only move the config.

  const CanarySchema = z.object({
    version: z.number().int().positive(),
    // 1-99, both ends excluded on purpose: 0 is "no trial" (that's Stop) and
    // 100 is "ship it" (that's Promote). A canary is by definition a split,
    // and an all-or-nothing "split" would produce an empty arm and a
    // comparison panel with nothing to compare against.
    percent: z.number().int().min(1).max(99),
    // A5 slice C: share of replies in BOTH arms sampled for async judging.
    // 0..100 inclusive at BOTH ends, unlike `percent` above, because both ends
    // are meaningful here: 0 = run the trial on counters alone (judge nothing,
    // spend nothing extra), 100 = judge every reply, which is affordable for a
    // low-traffic agent and is the only way a short trial gathers enough
    // judgments to separate the arms. Omitted = SAMPLE_PERCENT_DEFAULT.
    samplePercent: z.number().int().min(0).max(100).optional(),
  });

  app.post<{ Params: { identifier: string }; Body: unknown }>(
    '/v1/agents/:identifier/canary',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await resolveVersionTarget(req.tenant.id, req.params.identifier, reply);
      if (!agent) return reply;
      const parsed = CanarySchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: parsed.error.errors[0]?.message ?? 'invalid canary' });
      }
      const row = await getAgentPromptVersion(agent.id, parsed.data.version);
      if (!row) return reply.code(404).send({ error: 'unknown version' });

      const started = await startCanary(
        agent.id,
        parsed.data.version,
        parsed.data.percent,
        parsed.data.samplePercent ?? SAMPLE_PERCENT_DEFAULT,
      );
      // Null means the row already had a canary_version: one trial at a time,
      // enforced by the write itself (see startCanary), so two operators
      // racing the button get one trial and one honest 409 — never a silently
      // replaced trial whose partial results would be attributed to the new
      // version. Changing the version or the percent means Stop, then Start.
      if (!started) {
        return reply.code(409).send({
          error: 'a canary is already running on this agent — stop or promote it first',
        });
      }
      return { agent: agentView(started) };
    },
  );

  /**
   * Stop the trial. Conversations already in the canary arm keep their arm
   * (it records what they were enrolled in, which slice C needs) but revert to
   * the live prompt at their NEXT turn — the processor re-reads the agent every
   * turn, so a rejected prompt stops serving immediately and everywhere rather
   * than lingering in the threads that happened to open under it.
   */
  app.delete<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/canary',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await resolveVersionTarget(req.tenant.id, req.params.identifier, reply);
      if (!agent) return reply;
      const stopped = await clearCanary(agent.id);
      if (!stopped) return reply.code(404).send({ error: 'unknown agent' });
      return { agent: agentView(stopped) };
    },
  );

  /**
   * A5 slice C — the evidence behind Promote.
   *
   * Scoped to the CURRENT trial and nothing else: there is no history endpoint
   * here, because the decision this serves ("promote or stop?") is only ever
   * about the trial running right now. Hence 404 rather than an empty body when
   * none is running — an operator asking for a comparison that does not exist
   * has made a mistake, and an empty report full of zeros would look like a
   * trial going badly instead of a trial that isn't happening.
   *
   * Everything is aggregated IN POSTGRES (two set-based queries, see
   * conversations.repo.ts) — no per-conversation or per-turn iteration, so the
   * panel's poll costs the same on an agent with ten conversations under trial
   * as on one with ten million behind it.
   */
  app.get<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/canary/report',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await resolveVersionTarget(req.tenant.id, req.params.identifier, reply);
      if (!agent) return reply;
      const report = await buildCanaryReport(agent);
      if (!report) return reply.code(404).send({ error: 'no canary is running on this agent' });
      return report;
    },
  );

  /**
   * Promote: the version that won its trial becomes the live prompt, and the
   * trial ends. Deliberately the RESTORE path — promotion mints a new version
   * carrying the winner's content, so history keeps recording every change to
   * what the agent says in one append-only trail.
   *
   * The two steps are not one transaction (updateAgent owns its own, the repo's
   * idiom), so the order is chosen for its failure mode: restore FIRST, then
   * clear. A crash in between leaves the winning content live with the trial
   * still pointing at the version it was copied from — the canary arm then
   * serves content identical to live, which is harmless, and the operator's
   * next Stop (or a repeated Promote — clearCanary is idempotent) tidies up.
   * The reverse order could clear the trial and then fail to promote, quietly
   * losing the decision the operator just made.
   */
  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/canary/promote',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await resolveVersionTarget(req.tenant.id, req.params.identifier, reply);
      if (!agent) return reply;
      if (agent.canary_version === null) {
        return reply.code(404).send({ error: 'no canary is running on this agent' });
      }
      const row = await getAgentPromptVersion(agent.id, agent.canary_version);
      if (!row) return reply.code(404).send({ error: 'unknown version' });

      const promoted = await restoreVersionAsSave(req.tenant.id, req.params.identifier, row);
      if (!promoted) return reply.code(404).send({ error: 'unknown agent' });
      const cleared = await clearCanary(agent.id);
      return {
        agent: agentView(cleared ?? promoted),
        promotedFrom: row.version,
        // The NEW version number carrying the winner's content — equal to
        // promotedFrom only when the trial version was already live (a no-op
        // save mints nothing, exactly as on the restore route).
        version: promoted.prompt_version,
      };
    },
  );

  /**
   * ---- A10 THE KILL-SWITCH: pause / resume ----
   *
   * Two routes, one column, no body. `POST .../pause` stamps `paused_at`;
   * `POST .../resume` clears it. While it is stamped, every inbound message on
   * this agent still LANDS (nothing here or in the channel webhooks reads the
   * column — a pause can never become a 409 at the door), no brain or bridge
   * runs, the customer is told once per conversation, and the conversation is
   * routed to the operator queue. See the hold at the top of processTurn.
   *
   * IDEMPOTENT BY DESIGN — pausing a paused agent is a 200 no-op, and so is
   * resuming a live one. That is not laziness about status codes, it is the
   * requirement: this is an emergency button, and an emergency button that
   * errors on a double-press is a broken button. The person pressing it twice
   * is not reading the response body — they are checking that it worked, at
   * 3am, while something is on fire. A 409 there would read as "the pause
   * failed" and send them looking for a second lever that does not exist.
   *
   * BOTH RUNTIMES. Unlike the brain knobs (versions, canary, routing, the two
   * A7 gates) these routes never 400 a bridge agent: an agent whose brain is
   * the customer's own code is exactly the agent an operator cannot fix by
   * deploying, and for it the pause means its webhook stops being called.
   *
   * NO PRE-SAVE INTERACTION, deliberately. The A7 pre-save eval check guards
   * CONFIG changes — "does this new prompt still behave?" — and a pause changes
   * no config and asks no such question. Making an emergency stop wait on an
   * eval run would be the single worst place in the product to add latency.
   * For the same reason neither route mints a prompt version.
   */
  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/pause',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const paused = await setAgentPaused(req.tenant.id, req.params.identifier, true);
      if (!paused) return reply.code(404).send({ error: 'unknown agent' });
      logExec({
        tenantId: req.tenant.id,
        transactionId: `agent-${paused.identifier}`,
        level: 'warn',
        detail: `agent ${paused.identifier} PAUSED — messages keep landing, no turns run, conversations go to the operator queue`,
      });
      return { agent: agentView(paused) };
    },
  );

  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/resume',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const resumed = await setAgentPaused(req.tenant.id, req.params.identifier, false);
      if (!resumed) return reply.code(404).send({ error: 'unknown agent' });
      logExec({
        tenantId: req.tenant.id,
        transactionId: `agent-${resumed.identifier}`,
        level: 'info',
        detail:
          `agent ${resumed.identifier} RESUMED — new messages run normal turns; ` +
          `conversations already handed to a person stay with them until handback`,
      });
      return { agent: agentView(resumed) };
    },
  );

  /**
   * ---- A10 CONFIG-AS-CODE: export, import preview, import apply ----
   *
   * One file describes an agent; three routes move it. The format itself lives
   * in core/agent-config-file.ts (which owns the serializer and the reader);
   * everything here is about the LAWS an incoming file has to meet, and those
   * are deliberately not new laws: the knobs go through `AgentSchema` /
   * `AgentPatchSchema` (the very objects the save routes use), the tools go
   * through the registration route's own validators, and the write itself rides
   * `createAgentFromInput` / `patchAgentFromInput` — so an imported prompt mints
   * a version exactly like a typed one.
   */

  const ImportBodySchema = z.object({
    /** The parsed config file. Shape-checked by the format owner, not here. */
    file: z.unknown(),
    /**
     * The target environment's LLM key. Never in the file — it travels in the
     * request, once, and only when the operator has one to give. Same bounds as
     * `LlmConfigSchema.apiKey`, because it ends up in exactly that field.
     */
    llmApiKey: z.string().min(8).max(512).optional(),
  });

  /**
   * Preview has no key to type into a managed create, but it still has to be
   * able to tell an operator that their 31st topic label is one too many. So it
   * validates with this stand-in and throws it away — nothing is written by a
   * preview, and `needsLlmKey` (computed from the REAL absence) is what the
   * dashboard reads to decide whether to ask for the real one.
   */
  const PREVIEW_LLM_KEY = 'preview-only-never-stored';

  type ImportRefusal = { status: 400 | 404 | 409 | 422; error: string; details?: unknown };

  interface ImportPlan {
    config: AgentConfigFile;
    existing: Agent | null;
    diff: ConfigDiff;
    missingWorkflows: string[];
    missingKnowledge: string[];
    needsLlmKey: boolean;
    /** Exactly one of these two is set — the mode decides which. */
    create: z.infer<typeof AgentSchema> | null;
    patch: z.infer<typeof AgentPatchSchema> | null;
    toolCreates: Array<{ name: string; data: ToolCreateInput }>;
    toolPatches: Array<{ id: string; name: string; data: ToolPatchInput }>;
    /** On the agent, absent from the file — left exactly where they are. */
    toolsKept: string[];
  }

  /**
   * Everything both import routes need, computed once and identically.
   *
   * Preview and apply do not merely agree by convention here — apply EXECUTES
   * the plan preview describes. That is the whole reason for a two-step import:
   * a modal that says "one tool added, prompt changed" and an apply that then
   * refuses on a bound the preview never checked would be worse than no preview
   * at all, so every check apply makes is made here, before either answers.
   */
  async function planImport(
    tenantId: string,
    body: z.infer<typeof ImportBodySchema>,
    opts: { preview: boolean },
  ): Promise<{ ok: true; plan: ImportPlan } | { ok: false; refusal: ImportRefusal }> {
    const parsed = parseAgentConfigFile(body.file);
    if (!parsed.ok) {
      return {
        ok: false,
        refusal: { status: 400, error: 'invalid config file', details: parsed.issues },
      };
    }
    const config = parsed.config;

    const existing = await getAgent(tenantId, config.identifier);
    const [liveTools, liveKnowledge, tenantWorkflows] = await Promise.all([
      existing ? listToolDefs(tenantId, existing.id) : Promise.resolve([]),
      existing ? listSources(tenantId, existing.id) : Promise.resolve([]),
      listWorkflows(tenantId),
    ]);

    const diff = diffAgentConfig(config, existing ? { agent: existing, tools: liveTools } : null);
    const missingWorkflows = missingWorkflowKeys(
      config,
      (tenantWorkflows as Array<{ key: string }>).map((w) => w.key),
    );
    const missingKnowledge = missingKnowledgeNames(
      config,
      liveKnowledge.map((s) => s.name),
    );
    // A managed agent needs a key it does not already have: always on create,
    // and on the bridge→managed conversion a file can ask for.
    const needsLlmKey =
      config.runtime === 'managed' && !(existing && existing.llm_credentials);
    const llmApiKey =
      body.llmApiKey ?? (opts.preview && needsLlmKey ? PREVIEW_LLM_KEY : undefined);

    // A file NAMES the workflows its prompt drives. Apply refuses when the
    // tenant lacks one (a prompt that tells the model to trigger a workflow
    // that does not exist is a broken agent, and shipping it quietly would make
    // the failure a customer's problem at turn time); preview reports the same
    // list as a warning, so the operator can create them and come back.
    if (!opts.preview && missingWorkflows.length > 0) {
      return {
        ok: false,
        refusal: {
          status: 422,
          error: `this config needs workflows this environment does not have: ${missingWorkflows.join(', ')}`,
          details: { missingWorkflows },
        },
      };
    }

    // Absent means "no opinion" and leaves the stored value alone — which is
    // what makes an import non-destructive. An EXPLICIT null is different: the
    // serializer never writes one, so a null in a file is a human saying "clear
    // this", and the save schemas already read it exactly that way.
    const fields = agentFieldsFromConfig(config);
    // llmBaseUrl never travels on its own: it is the endpoint the stored key is
    // used against, so repointing it while an older key stays behind would ship
    // that key somewhere its owner never agreed to. It moves only together with
    // a key — always on create (where one is required for managed), and on
    // update only when the operator supplies one.
    delete fields.llmBaseUrl;
    const llm = llmApiKey
      ? {
          apiKey: llmApiKey,
          ...(config.llmBaseUrl !== undefined ? { baseUrl: config.llmBaseUrl } : {}),
        }
      : undefined;

    let create: z.infer<typeof AgentSchema> | null = null;
    let patch: z.infer<typeof AgentPatchSchema> | null = null;
    if (!existing) {
      const createBody = { ...fields, identifier: config.identifier, ...(llm ? { llm } : {}) };
      const checked = AgentSchema.safeParse(createBody);
      if (!checked.success) {
        return {
          ok: false,
          refusal: { status: 400, error: 'invalid body', details: checked.error.issues },
        };
      }
      create = checked.data;
    } else {
      const checked = AgentPatchSchema.safeParse({ ...fields, ...(llm ? { llm } : {}) });
      if (!checked.success) {
        return {
          ok: false,
          refusal: { status: 400, error: 'invalid body', details: checked.error.issues },
        };
      }
      patch = checked.data;
    }

    // The SSRF gate, run here rather than only at write time so a preview
    // refuses a bridgeUrl pointing at private infrastructure instead of
    // promising an apply that cannot happen.
    const unsafe = await unsafeUrlError({
      bridgeUrl: create?.bridgeUrl ?? patch?.bridgeUrl,
      llmBaseUrl: llm?.baseUrl,
    });
    if (unsafe) return { ok: false, refusal: { status: 400, error: unsafe } };

    // Tools: validated to the last one BEFORE any of them is written, so a file
    // with one bad endpoint is refused whole rather than applied halfway.
    const byName = new Map(liveTools.map((t) => [t.name, t]));
    const toolCreates: ImportPlan['toolCreates'] = [];
    const toolPatches: ImportPlan['toolPatches'] = [];
    for (const tool of config.tools ?? []) {
      const live = byName.get(tool.name);
      if (!live) {
        const checked = await validateToolCreate(tool);
        if (!checked.ok) {
          return {
            ok: false,
            refusal: {
              status: 400,
              error: `tool "${tool.name}": ${checked.error}`,
              details: checked.details,
            },
          };
        }
        toolCreates.push({ name: tool.name, data: checked.data });
        continue;
      }
      if (!diff.toolChanges.changed.includes(tool.name)) continue;
      // Only the fields the file STATES are patched — an omitted timeoutMs is
      // not a request to reset the timeout. `status` is never among them: a
      // tool an operator disabled here stays disabled, because that is
      // operational state, not config (the same line the agent's own `status`
      // and `pausedAt` sit on).
      const { name: _name, ...stated } = tool;
      const checked = await validateToolPatch(stated);
      if (!checked.ok) {
        return {
          ok: false,
          refusal: {
            status: 400,
            error: `tool "${tool.name}": ${checked.error}`,
            details: checked.details,
          },
        };
      }
      toolPatches.push({ id: live.id, name: tool.name, data: checked.data });
    }

    return {
      ok: true,
      plan: {
        config,
        existing,
        diff,
        missingWorkflows,
        missingKnowledge,
        needsLlmKey,
        create,
        patch,
        toolCreates,
        toolPatches,
        toolsKept: diff.toolChanges.removed,
      },
    };
  }

  /**
   * The file for one agent. Both runtimes: a bridge agent exports its tools and
   * its knobs too, and `runtime` in the file says which kind it is.
   *
   * The body IS the file (no envelope), so `curl ... > support-demo.agent.json`
   * writes something the import route accepts and a human can read in a diff.
   * The canary report route sets the same precedent for a bare body.
   *
   * DISABLED TOOLS ARE NOT EXPORTED. A disabled tool is not part of what the
   * agent does, and `status` is operational state that deliberately does not
   * travel — exporting one would silently re-enable it in the target
   * environment, which is precisely the surprise config-as-code must not have.
   */
  app.get<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/export',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const [tools, knowledge, workflows] = await Promise.all([
        listToolDefs(req.tenant.id, agent.id, { activeOnly: true }),
        listSources(req.tenant.id, agent.id),
        listWorkflows(req.tenant.id),
      ]);
      return serializeAgentConfig({
        agent,
        tools,
        knowledge,
        workflowKeys: referencedWorkflowKeys(
          agent.system_prompt,
          (workflows as Array<{ key: string }>).map((w) => w.key),
        ),
      });
    },
  );

  /**
   * Step one: what WOULD this file do? Reads only — no agent is created, no
   * knob moves, no version is minted. The answer is field-level on purpose: an
   * operator about to promote a config to production is asking "what changes?",
   * and a green checkmark is not an answer to that question.
   */
  app.post('/v1/agents/import/preview', { preHandler: [authenticate] }, async (req, reply) => {
    const body = ImportBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', details: body.error.issues });
    }
    const planned = await planImport(req.tenant.id, body.data, { preview: true });
    if (!planned.ok) {
      const { status, error, details } = planned.refusal;
      return reply.code(status).send({ error, ...(details ? { details } : {}) });
    }
    const { plan } = planned;
    return {
      identifier: plan.config.identifier,
      mode: plan.diff.mode,
      changes: plan.diff.changes,
      toolChanges: plan.diff.toolChanges,
      /**
       * What 'removed' means, said out loud so a dashboard cannot render it as a
       * threat: NOTHING is removed by an import. A knob or a tool the file does
       * not mention is left exactly as it is — an import must not destroy what
       * the file's author never knew about, and deleting a tool stays an
       * explicit act in the dashboard, done by someone who can see what calls it.
       */
      removalPolicy: 'kept' as const,
      missingWorkflows: plan.missingWorkflows,
      /** References the target lacks. A warning, never a refusal: knowledge is
       *  referenced by name in this format and its content is not in the file,
       *  so an import has nothing to create — it can only tell the truth. */
      missingKnowledge: plan.missingKnowledge,
      needsLlmKey: plan.needsLlmKey,
    };
  });

  /**
   * Step two: apply it.
   *
   * Create rides the create path (and therefore requires an llmApiKey for a
   * managed agent, exactly like POST /v1/agents — the file has no key in it, so
   * the operator supplies the target environment's own). Update rides
   * `updateAgent`, so a changed prompt or model MINTS A PROMPT VERSION like any
   * other save and history stays complete.
   *
   * What an import never touches: `status`, `pausedAt` (a paused agent stays
   * paused — importing a config is not an all-clear), the canary, version
   * history, and the stored LLM credentials unless a key was supplied.
   */
  app.post('/v1/agents/import', { preHandler: [authenticate] }, async (req, reply) => {
    const body = ImportBodySchema.safeParse(req.body ?? {});
    if (!body.success) {
      return reply.code(400).send({ error: 'invalid body', details: body.error.issues });
    }
    const planned = await planImport(req.tenant.id, body.data, { preview: false });
    if (!planned.ok) {
      const { status, error, details } = planned.refusal;
      return reply.code(status).send({ error, ...(details ? { details } : {}) });
    }
    const { plan } = planned;

    let agent: Agent;
    let signingSecret: string | undefined;
    if (plan.create) {
      const created = await createAgentFromInput(req.tenant.id, plan.create);
      if (!created.ok) return reply.code(created.status).send({ error: created.error });
      agent = created.value.agent;
      signingSecret = created.value.signingSecret;
    } else {
      // Non-null by construction: planImport sets exactly one of create/patch,
      // and `existing` is what decided which.
      const saved = await patchAgentFromInput(
        req.tenant.id,
        plan.config.identifier,
        plan.existing!,
        plan.patch!,
      );
      if (!saved.ok) return reply.code(saved.status).send({ error: saved.error });
      agent = saved.value;
    }

    // Tool secrets are minted per environment and shown ONCE, like every other
    // secret this API hands out: the file cannot carry them (that is what makes
    // it git-safe), so a freshly imported tool needs its new secret handed to
    // the operator here or its backend can never verify the calls we make.
    const created: Array<{ name: string; secret: string }> = [];
    for (const tool of plan.toolCreates) {
      const made = await createValidatedTool(req.tenant.id, agent.id, tool.data);
      // null = a tool with this name appeared between the plan and now. The
      // import does not fight it: the tool exists, which is what the file asked
      // for, and the racing writer's version is the newer one.
      if (made) created.push({ name: tool.name, secret: made.secret });
    }
    const updated: string[] = [];
    for (const tool of plan.toolPatches) {
      const patched = await updateToolDef(req.tenant.id, tool.id, {
        description: tool.data.description,
        parameters: tool.data.parameters as Record<string, unknown> | undefined,
        endpointUrl: tool.data.endpointUrl,
        approval: tool.data.approval,
        timeoutMs: tool.data.timeoutMs,
        guard: tool.data.guard,
      });
      if (patched) updated.push(tool.name);
    }

    logExec({
      tenantId: req.tenant.id,
      transactionId: `agent-${agent.identifier}`,
      level: 'info',
      detail:
        `agent ${agent.identifier} ${plan.diff.mode === 'create' ? 'CREATED' : 'UPDATED'} from a config file ` +
        `(v${agent.prompt_version}; tools +${created.length} ~${updated.length} kept ${plan.toolsKept.length})`,
    });

    return reply.code(plan.diff.mode === 'create' ? 201 : 200).send({
      mode: plan.diff.mode,
      agent: agentView(agent),
      // Shown exactly once, like POST /v1/agents. Absent on an update.
      ...(signingSecret ? { signingSecret } : {}),
      tools: { created, updated, kept: plan.toolsKept },
      missingKnowledge: plan.missingKnowledge,
    });
  });

  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/rotate-secret',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const secret = newAgentSecret();
      const rotated = await rotateAgentSecret(req.tenant.id, req.params.identifier, sealSecret(secret));
      if (!rotated) return reply.code(404).send({ error: 'unknown agent' });
      return { signingSecret: secret };
    },
  );

  app.delete<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return { deleted: false };
      // Friendly guard over the DB's restrict FK: a routed connection must be
      // re-pointed or disconnected first, so deleting an agent never silently
      // orphans a live bot / inbound address.
      const connections = await listConnectionsForAgent(agent.id);
      if (connections.length > 0) {
        return reply.code(409).send({
          error: 'agent has routed connections — re-point or disconnect them first',
          connections: connections.map((c) => ({
            id: c.id,
            channel: c.channel,
            identity:
              (c.config as { botUsername?: string; address?: string } | null)?.botUsername ??
              (c.config as { botUsername?: string; address?: string } | null)?.address ??
              '',
          })),
        });
      }
      return { deleted: (await deleteAgent(req.tenant.id, req.params.identifier)) > 0 };
    },
  );

  // ---- long-term memory admin (D11 backend) ----
  // A subscriber is addressed by its tenant-scoped external_id here (the id
  // operators know), resolved to the uuid the memory rows key on. Unknown agent
  // OR unknown subscriber -> 404.

  app.get<{ Params: { identifier: string; subscriberExternalId: string } }>(
    '/v1/agents/:identifier/memories/:subscriberExternalId',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const subscriber = await getSubscriberByExternalId(
        req.tenant.id,
        req.params.subscriberExternalId,
      );
      if (!subscriber) return reply.code(404).send({ error: 'unknown subscriber' });
      const memories = await listMemories(agent.id, subscriber.id);
      return { memories: memories.map(memoryView) };
    },
  );

  app.put<{ Params: { identifier: string; subscriberExternalId: string } }>(
    '/v1/agents/:identifier/memories/:subscriberExternalId',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = MemoryPutSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const subscriber = await getSubscriberByExternalId(
        req.tenant.id,
        req.params.subscriberExternalId,
      );
      if (!subscriber) return reply.code(404).send({ error: 'unknown subscriber' });
      try {
        const memory = await upsertMemory({
          tenantId: req.tenant.id,
          agentId: agent.id,
          subscriberId: subscriber.id,
          key: parsed.data.key,
          value: parsed.data.value,
          source: 'operator',
        });
        // Phase 25 (slice B): an operator memory edit — refresh the Memory modal.
        void emitTenantEvent(req.tenant.id, 'memory.changed', req.params.subscriberExternalId);
        return { memory: memoryView(memory) };
      } catch (err) {
        // A full profile is not a client bug — 409 with the current keys so the
        // dashboard can offer an overwrite (never a silent drop).
        if (err instanceof MemoryCapError) {
          return reply.code(409).send({
            error: err.message,
            reason: err.reason,
            currentKeys: err.currentKeys,
            limits: err.limits,
          });
        }
        throw err;
      }
    },
  );

  app.delete<{
    Params: { identifier: string; subscriberExternalId: string };
    Querystring: { key?: string };
  }>(
    '/v1/agents/:identifier/memories/:subscriberExternalId',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const subscriber = await getSubscriberByExternalId(
        req.tenant.id,
        req.params.subscriberExternalId,
      );
      if (!subscriber) return reply.code(404).send({ error: 'unknown subscriber' });
      // ?key= deletes one fact; no key deletes the whole profile.
      const deleted = await deleteMemory(agent.id, subscriber.id, req.query.key);
      // Phase 25 (slice B): a memory delete — refresh the Memory modal.
      void emitTenantEvent(req.tenant.id, 'memory.changed', req.params.subscriberExternalId);
      return { deleted };
    },
  );

  // ---- inbound turns (the widget's send button) ----

  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/messages',
    async (req, reply) => {
      const parsed = InboundMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      if (!(await authenticateSender(req, reply, parsed.data.subscriberId))) return;

      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      if (agent.status !== 'active') {
        return reply.code(409).send({ error: 'agent is disabled' });
      }

      const subscriber = await upsertSubscriber(req.tenant.id, {
        subscriberId: parsed.data.subscriberId,
      });
      const conversation = await openConversation({
        tenantId: req.tenant.id,
        agentId: agent.id,
        subscriberId: subscriber.id,
        channel: 'inapp',
        threadKey: parsed.data.subscriberId,
      });

      const message = await insertConversationMessage({
        conversationId: conversation.id,
        tenantId: req.tenant.id,
        role: 'user',
        content: parsed.data.text,
        dedupeKey: parsed.data.messageId ?? `user-${crypto.randomUUID()}`,
      });
      if (!message) {
        // Same client messageId seen before — accepted once, never twice.
        return reply.code(200).send({ conversationId: conversation.id, duplicate: true });
      }

      await getQueue(QUEUE.CONVERSATION).add(
        message.id,
        { tenantId: req.tenant.id, conversationId: conversation.id, messageId: message.id },
        { jobId: `conv-${message.id}`, attempts: 5 },
      );

      logExec({
        tenantId: req.tenant.id,
        transactionId: `conv-${conversation.id}`,
        level: 'info',
        detail: `inbound turn accepted: agent=${agent.identifier} subscriber=${parsed.data.subscriberId}`,
      });

      return reply.code(202).send({
        conversationId: conversation.id,
        messageId: message.id,
        status: conversation.status,
      });
    },
  );

  /** A button click — same pipeline as a message, structured as an action. */
  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/actions',
    async (req, reply) => {
      const parsed = InboundActionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      if (!(await authenticateSender(req, reply, parsed.data.subscriberId))) return;

      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      if (agent.status !== 'active') {
        return reply.code(409).send({ error: 'agent is disabled' });
      }

      const subscriber = await upsertSubscriber(req.tenant.id, {
        subscriberId: parsed.data.subscriberId,
      });
      const conversation = await openConversation({
        tenantId: req.tenant.id,
        agentId: agent.id,
        subscriberId: subscriber.id,
        channel: 'inapp',
        threadKey: parsed.data.subscriberId,
      });

      // Stored as a user row whose text is the label (or the raw value for a
      // text_input answer) — transcripts read naturally everywhere; raw.action
      // marks it for the brain. kind distinguishes button / select / input.
      const { actionId, label, value } = parsed.data;
      const content = label ?? value!;
      const action =
        label && value
          ? { id: actionId, value, kind: 'select' }
          : value
            ? { id: actionId, value, kind: 'input' }
            : { id: actionId };
      const row = await insertConversationMessage({
        conversationId: conversation.id,
        tenantId: req.tenant.id,
        role: 'user',
        content,
        dedupeKey: parsed.data.actionEventId ?? `action-${crypto.randomUUID()}`,
        raw: { action },
      });
      if (!row) {
        return reply.code(200).send({ conversationId: conversation.id, duplicate: true });
      }

      await getQueue(QUEUE.CONVERSATION).add(
        row.id,
        { tenantId: req.tenant.id, conversationId: conversation.id, messageId: row.id },
        { jobId: `conv-${row.id}`, attempts: 5 },
      );

      logExec({
        tenantId: req.tenant.id,
        transactionId: `conv-${conversation.id}`,
        level: 'info',
        detail: `action accepted: agent=${agent.identifier} action=${parsed.data.actionId}`,
      });

      return reply.code(202).send({ conversationId: conversation.id, messageId: row.id });
    },
  );

  /**
   * The widget's own thread (subscriber-token friendly). System rows are
   * internal breadcrumbs — end users only see user/agent turns.
   */
  app.get<{ Params: { identifier: string }; Querystring: { subscriberId?: string } }>(
    '/v1/agents/:identifier/conversation',
    async (req, reply) => {
      const subscriberId = req.query.subscriberId ?? '';
      if (!subscriberId) return reply.code(400).send({ error: 'subscriberId is required' });
      if (!(await authenticateSender(req, reply, subscriberId))) return;

      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      // Agent-speaks-first: the widget renders the greeting + starters before
      // any turn exists, so this block ships even when the conversation is null.
      const agentBlock = {
        name: agent.name,
        welcomeMessage: agent.welcome_message,
        suggestedPrompts: agent.suggested_prompts,
      };

      const conversation = await findConversationByThread(agent.id, 'inapp', subscriberId);
      if (!conversation) return { agent: agentBlock, conversation: null, messages: [] };
      const messages = await conversationTranscript(conversation.id);
      return {
        agent: agentBlock,
        conversation: { id: conversation.id, status: conversation.status },
        messages: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.created_at,
            editedAt: m.edited_at,
            deletedAt: m.deleted_at,
            buttons: (m.raw as { buttons?: unknown } | null)?.buttons,
            card: (m.raw as { card?: unknown } | null)?.card,
            // D9: operator (human teammate) attribution — the widget renders a
            // quiet "«name» · team" label above these bubbles. Top-level
            // operatorName mirrors the inapp ws 'conversation.message' payload
            // so the history and live paths carry the field identically.
            operatorName: (m.raw as { operator?: { name?: string } } | null)?.operator?.name,
          })),
      };
    },
  );

  // ---- conversation reads (dashboard + API) ----

  app.get<{ Querystring: { agent?: string; status?: string; limit?: string } }>(
    '/v1/conversations',
    { preHandler: [authenticate] },
    async (req) => {
      const limit = Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 200);
      const rows = await listConversations(req.tenant.id, {
        agentIdentifier: req.query.agent,
        status: req.query.status,
        limit,
      });
      return {
        conversations: rows.map((c) => ({
          id: c.id,
          agent: { identifier: c.agent_identifier, name: c.agent_name },
          subscriberId: c.subscriber_external_id,
          channel: c.channel,
          status: c.status,
          messageCount: c.message_count,
          lastMessagePreview: c.last_message_preview,
          lastMessageAt: c.last_message_at,
          createdAt: c.created_at,
        })),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/conversations/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(400).send({ error: 'invalid conversation id' });
      }
      const conversation = await getConversation(req.tenant.id, req.params.id);
      if (!conversation) return reply.code(404).send({ error: 'unknown conversation' });
      const messages = await conversationTranscript(conversation.id);

      // Managed turns record their model spend on the row; sum for the panel.
      const totals = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
      const usageOf = (m: { raw: unknown }) => {
        const usage = (m.raw as { usage?: typeof totals } | null)?.usage;
        if (usage) {
          totals.inputTokens += usage.inputTokens ?? 0;
          totals.outputTokens += usage.outputTokens ?? 0;
          totals.modelCalls += usage.modelCalls ?? 0;
        }
        return usage;
      };

      // The owning agent, so deep-linked pages can act on it (e.g. the
      // dashboard's conversation->eval flow) without router state.
      const owner = await getAgentById(conversation.agent_id);
      return {
        conversation: {
          id: conversation.id,
          channel: conversation.channel,
          status: conversation.status,
          metadata: conversation.metadata,
          summary: conversation.summary,
          // D11: the auto rolling summary (null until the conversation first
          // folds) — the Details panel surfaces it as "Conversation summary (auto)".
          rollingSummary: conversation.rolling_summary,
          messageCount: conversation.message_count,
          lastMessageAt: conversation.last_message_at,
          createdAt: conversation.created_at,
        },
        agent: owner ? { identifier: owner.identifier, name: owner.name } : null,
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          editedAt: m.edited_at,
          deletedAt: m.deleted_at,
          deletedBy: m.deleted_by,
          usage: usageOf(m),
          trace: (m.raw as { trace?: unknown } | null)?.trace,
          // A13: this row is the note of a turn that DIED — its `trace` stops
          // where the turn stopped. Sent only when true so every other row (and
          // every row written before A13) stays byte-identical on the wire.
          crashed: (m.raw as { crashed?: unknown } | null)?.crashed === true ? true : undefined,
          buttons: (m.raw as { buttons?: unknown } | null)?.buttons,
          clicked: Boolean((m.raw as { action?: unknown } | null)?.action),
          // D5/D8: operator (human teammate) attribution — {name} — so the
          // dashboard transcript renders the quiet sender-name tag on these rows.
          operator: (m.raw as { operator?: { name: string } } | null)?.operator,
        })),
        usage: totals,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/conversations/:id/resolve',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(400).send({ error: 'invalid conversation id' });
      }
      const conversation = await getConversation(req.tenant.id, req.params.id);
      if (!conversation) return reply.code(404).send({ error: 'unknown conversation' });
      // Fire the resolved event exactly once — only when THIS call did the flip.
      const flipped = await resolveConversation(conversation.id, 'resolved manually');
      if (flipped) {
        // Phase 25 (slice B): operator manual resolve (status write) — admin hint.
        void emitTenantEvent(conversation.tenant_id, 'conversation.changed', conversation.id);
        // Phase 23 (D7): summarize + embed on operator resolve (managed-only job;
        // idempotent jobId). Only when THIS call did the flip.
        await enqueueSummarize(req.tenant.id, conversation.id);
        const agent = await getAgentById(conversation.agent_id);
        if (agent && agent.runtime === 'bridge' && agent.bridge_url) {
          await getQueue(QUEUE.CONVERSATION).add(
            `resolved-${conversation.id}`,
            {
              kind: 'resolved',
              tenantId: req.tenant.id,
              conversationId: conversation.id,
              resolvedBy: 'operator',
            },
            {
              jobId: `conv-resolved-${conversation.id}-${Date.now()}`,
              attempts: 5,
              priority: 10,
            },
          );
        }
      }
      return { status: 'resolved' };
    },
  );

  /**
   * Push an agent message into an existing conversation (operator reply / API
   * outbound), out of band from any inbound turn. The insert is the durable
   * copy; a 'deliver' job carries it to the channel. Rate-limited: the hard
   * cap 429s, but overflowDiverted is intentionally ignored — conversations
   * have no overflow lane, so a within-cap burst just proceeds.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/conversations/:id/messages',
    { preHandler: [authenticate, tenantRateLimit] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const parsed = PushMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const conversation = await getConversation(req.tenant.id, req.params.id);
      if (!conversation) return reply.code(404).send({ error: 'unknown conversation' });
      const agent = await getAgentById(conversation.agent_id);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      if (agent.status !== 'active') return reply.code(409).send({ error: 'agent is disabled' });

      let status = conversation.status;
      if (parsed.data.reopen === true && conversation.status === 'resolved') {
        await reopenConversation(conversation.id);
        status = 'active';
        // Phase 25 (slice B): a push reopened a resolved thread (status write).
        void emitTenantEvent(conversation.tenant_id, 'conversation.changed', conversation.id);
      }

      // D5 operator attribution: a DASHBOARD JWT caller is a human operator. The
      // authenticate preHandler only runs req.jwtVerify() for the Bearer-token
      // path, so req.user is populated for dashboard users and undefined for
      // API-key (SDK) callers — the exact seam we key on. API-key pushes stay
      // untagged (unchanged behavior). Name from the users row, email local-part
      // as the fallback. raw.operator = {name} is what the delivery path threads
      // into the widget label / channel prefix, what buildHistory + the fold
      // exclude/attribute (D6), and what episodic attributes (D10).
      let operator: { name: string } | undefined;
      if (req.user?.type === 'access') {
        const u = await getUserById(req.user.sub);
        const name = u?.name?.trim() || u?.email?.split('@')[0] || 'teammate';
        operator = { name };
      }

      const row = await insertConversationMessage({
        conversationId: conversation.id,
        tenantId: req.tenant.id,
        role: 'agent',
        content: parsed.data.text,
        dedupeKey: parsed.data.messageId
          ? `push-${parsed.data.messageId}`
          : `push-${crypto.randomUUID()}`,
        raw:
          parsed.data.buttons || parsed.data.card || operator
            ? {
                ...(parsed.data.buttons ? { buttons: parsed.data.buttons } : {}),
                ...(parsed.data.card ? { card: parsed.data.card } : {}),
                ...(operator ? { operator } : {}),
              }
            : undefined,
      });
      if (!row) {
        // Same client messageId seen before — accepted once, never twice.
        return reply.code(200).send({ conversationId: conversation.id, duplicate: true });
      }

      // D5: the FIRST operator reply while waiting_human takes the pen —
      // waiting_human → human (+ stamps had_human, + one P25 emit inside the
      // helper). Guarded to fire exactly once; a later operator reply (already
      // human) is a no-op flip. Only for operator (JWT) pushes.
      if (operator && status === 'waiting_human') {
        const flipped = await setConversationHuman(conversation.id);
        if (flipped) status = 'human';
      }

      await getQueue(QUEUE.CONVERSATION).add(
        row.id,
        {
          kind: 'deliver',
          tenantId: req.tenant.id,
          conversationId: conversation.id,
          messageId: row.id,
        },
        { jobId: `conv-deliver-${row.id}`, attempts: 5 },
      );

      logExec({
        tenantId: req.tenant.id,
        transactionId: `conv-${conversation.id}`,
        level: 'info',
        detail: `agent message pushed: agent=${agent.identifier} conversation=${conversation.id}`,
      });

      return reply.code(202).send({ conversationId: conversation.id, messageId: row.id, status });
    },
  );

  /**
   * D6 "Return to agent": hand a waiting_human/human conversation back to the
   * agent (→ active) and enqueue a FORCED rolling fold through the last operator
   * message so the human exchange is preserved as an attributed summary before
   * the agent speaks again. The fold is NOT awaited — if it hasn't landed when
   * the next customer message arrives, that turn runs on pre-handoff context
   * (transient, self-heals on the next turn); the status flip and the operator's
   * durable rows are the record. Idempotent: a double-click after the flip
   * returns 200 with the current active status.
   */
  app.post<{ Params: { id: string } }>(
    '/v1/conversations/:id/handback',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(400).send({ error: 'invalid conversation id' });
      }
      const conversation = await getConversation(req.tenant.id, req.params.id);
      if (!conversation) return reply.code(404).send({ error: 'unknown conversation' });

      // Guarded flip (waiting_human|human → active); emits conversation.changed
      // exactly when THIS call did the flip.
      const flipped = await handbackConversation(conversation.id);
      if (!flipped) {
        // Not in a human state: idempotent 200 if already active, else 409.
        if (conversation.status === 'active') {
          return reply.code(200).send({ status: 'active' });
        }
        return reply.code(409).send({ error: 'conversation is not awaiting handback' });
      }

      // Fold through the last operator reply (inclusive). No operator ever
      // replied (a handoff returned to the agent with no human turn) → nothing to
      // attribute, skip the fold entirely.
      const boundary = await lastOperatorMessage(conversation.id);
      if (boundary) {
        await enqueueHandbackFold(req.tenant.id, conversation.id, boundary.id);
      }

      logExec({
        tenantId: req.tenant.id,
        transactionId: `conv-${conversation.id}`,
        level: 'info',
        detail: `conversation handed back to the agent${boundary ? ' (forced fold enqueued)' : ''}`,
      });
      return reply.code(200).send({ status: 'active' });
    },
  );
}
