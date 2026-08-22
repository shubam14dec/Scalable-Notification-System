import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { authenticate } from '../auth';
import { getDayTokens } from '../../shared/agent-counters';
import { verifySubscriberToken } from '../../auth/subscriber-token';
import { sealSecret } from '../../auth/secret-box';
import { getEnvironment, getUserById } from '../../db/accounts.repo';
import { upsertSubscriber } from '../../db/repositories';
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
  startCanary,
  updateAgent,
  type Agent,
  type AgentContext,
  type AgentPromptVersion,
} from '../../db/conversations.repo';
import { getQueue, QUEUE } from '../../shared/queues';
import { enqueueSummarize } from '../../core/episodic';
import { enqueueHandbackFold } from '../../core/rolling';
import { emitTenantEvent } from '../../core/tenant-events';
import { CardSchema } from '../../shared/cards';
import { logExec } from '../../core/execution-log';
import { tenantRateLimit } from '../rate-limit';
import { assertSafeOutboundUrl, UnsafeOutboundUrlError } from '../../core/safe-url';
import { agentHealth, type AgentHealth } from '../../db/agent-health.repo';
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

/** Shared by create + patch. null clears; absent leaves untouched. */
const welcomeMessageSchema = z.string().max(2000).nullable().optional();
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
          }
        : null,
    status: agent.status,
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

export function registerAgentRoutes(app: FastifyInstance) {
  // ---- agent management (dashboard / server credentials) ----

  app.post('/v1/agents', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = AgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const unsafe = await unsafeUrlError({
      bridgeUrl: parsed.data.bridgeUrl,
      llmBaseUrl: parsed.data.llm?.baseUrl,
    });
    if (unsafe) return reply.code(400).send({ error: unsafe });
    const secret = newAgentSecret();
    const agent = await createAgent({
      tenantId: req.tenant.id,
      identifier: parsed.data.identifier,
      name: parsed.data.name,
      description: parsed.data.description,
      runtime: parsed.data.runtime,
      bridgeUrl: parsed.data.bridgeUrl,
      sealedSecret: sealSecret(secret),
      model: parsed.data.model,
      systemPrompt: parsed.data.systemPrompt,
      maxTokens: parsed.data.maxTokens,
      maxDailyTokens: parsed.data.maxDailyTokens ?? undefined,
      autoResolveMinutes: parsed.data.autoResolveMinutes,
      llmBaseUrl: parsed.data.llm?.baseUrl ?? undefined,
      sealedLlmCredentials: parsed.data.llm?.apiKey
        ? sealSecret(JSON.stringify({ apiKey: parsed.data.llm.apiKey }))
        : undefined,
      welcomeMessage: parsed.data.welcomeMessage,
      suggestedPrompts: parsed.data.suggestedPrompts,
      context: parsed.data.context,
    });
    if (!agent) {
      return reply.code(409).send({ error: `agent "${parsed.data.identifier}" already exists` });
    }
    // The plaintext secret is shown exactly once, like API keys.
    return reply.code(201).send({ agent: agentView(agent), signingSecret: secret });
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

      // Switching runtimes must not leave a broken agent behind.
      const nextRuntime = parsed.data.runtime ?? existing.runtime;
      if (nextRuntime === 'bridge' && !(parsed.data.bridgeUrl ?? existing.bridge_url)) {
        return reply.code(400).send({ error: 'bridge runtime requires a bridgeUrl' });
      }
      if (
        nextRuntime === 'managed' &&
        !(parsed.data.llm?.apiKey || existing.llm_credentials)
      ) {
        return reply.code(400).send({ error: 'managed runtime requires llm.apiKey' });
      }
      const unsafe = await unsafeUrlError({
        bridgeUrl: parsed.data.bridgeUrl,
        llmBaseUrl: parsed.data.llm?.baseUrl,
      });
      if (unsafe) return reply.code(400).send({ error: unsafe });

      const agent = await updateAgent(req.tenant.id, req.params.identifier, {
        name: parsed.data.name,
        description: parsed.data.description,
        runtime: parsed.data.runtime,
        bridgeUrl: parsed.data.bridgeUrl,
        status: parsed.data.status,
        model: parsed.data.model,
        systemPrompt: parsed.data.systemPrompt,
        maxTokens: parsed.data.maxTokens,
        maxDailyTokens: parsed.data.maxDailyTokens,
        autoResolveMinutes: parsed.data.autoResolveMinutes,
        llmBaseUrl: parsed.data.llm === undefined ? undefined : parsed.data.llm.baseUrl,
        sealedLlmCredentials: parsed.data.llm?.apiKey
          ? sealSecret(JSON.stringify({ apiKey: parsed.data.llm.apiKey }))
          : undefined,
        welcomeMessage: parsed.data.welcomeMessage,
        suggestedPrompts: parsed.data.suggestedPrompts,
        context: parsed.data.context,
      });
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      return { agent: agentView(agent) };
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

      const started = await startCanary(agent.id, parsed.data.version, parsed.data.percent);
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
