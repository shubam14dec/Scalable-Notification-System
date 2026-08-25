import { pool } from './pool';
import { emitTenantEvent } from '../core/tenant-events';
import type {
  ModerationConfig,
  RoutingConfig,
  SubscriberRateConfig,
  TopicsConfig,
} from '../core/managed-brain';

/**
 * Agents + conversations repository. An agent is a customer-registered
 * bridge URL; conversations are per-(agent, channel, thread) transcripts
 * whose message rows are the durable copy (same doctrine as the inbox:
 * Postgres is the record, everything live-pushed is an accelerator).
 */

export interface Agent {
  id: string;
  tenant_id: string;
  identifier: string;
  name: string;
  description: string | null;
  /** Who answers a turn: customer code at bridge_url, or our LLM loop. */
  runtime: 'bridge' | 'managed';
  bridge_url: string | null;
  signing_secret: string; // sealed — open only at dispatch time
  /** Managed runtime only. */
  model: string | null;
  system_prompt: string | null;
  llm_base_url: string | null;
  llm_credentials: string | null; // sealed {apiKey} — write-only via the API
  max_tokens: number | null; // per-reply output cap (null = brain default)
  max_daily_tokens: number | null; // Phase 22 G2 daily token circuit breaker (null = off)
  auto_resolve_minutes: number | null; // idle-timeout backstop (null = off)
  /** Agent-speaks-first: the greeting shown before the user acts (null = off). */
  welcome_message: string | null;
  /** Up to 6 one-tap starters offered with the welcome (null = none). */
  suggested_prompts: Array<{ title: string; message: string }> | null;
  status: 'active' | 'disabled';
  /**
   * A5: which agent_prompt_versions row is LIVE. Managed agents only — a bridge
   * agent keeps the default 1 with no version rows behind it, meaning nothing.
   */
  prompt_version: number;
  /**
   * A5 slice B: the ACTIVE canary, or no canary at all. The three move
   * together — `canary_version === null` is the one authoritative test for "no
   * trial running" and every read in the codebase uses it (percent alone is
   * never consulted). At most one per agent by construction: they are columns
   * on the agent row, not rows in a table, so a second trial has nowhere to go.
   */
  canary_version: number | null;
  /** Share of NEWLY OPENED conversations routed to the canary arm (1-99). */
  canary_percent: number | null;
  canary_started_at: string | null;
  /**
   * A5 slice C: share of replies in BOTH arms sampled for async LLM judging
   * (0 = counters only). Moves with the trio above — Start sets it, Stop and
   * Promote clear it.
   */
  canary_sample_percent: number | null;
  /**
   * A6: cheap-first model routing, or null = off (the default, and what every
   * pre-A6 row holds). The shape is owned by the brain — it is the brain that
   * applies it — so this is a type-only import and adds no runtime dependency
   * from the repo layer onto core/.
   */
  routing: RoutingConfig | null;
  /**
   * A7: the topic gate's policy, or null = off (the default, and what every
   * pre-A7 row holds). Shape owned by the brain beside RoutingConfig, for the
   * same reason and on the same type-only import. Whether a stored policy is
   * COHERENT enough to gate a turn is decided at read time by
   * core/topic-gate.ts's resolveTopics — the column is jsonb, so the type here
   * is a description of the intent, never a guarantee about the row.
   */
  topics: TopicsConfig | null;
  /**
   * A7 slice B: the outbound reply rules, or null = off (the default, and what
   * every pre-A7 row holds). Same type-only import and the same caveat as
   * `topics` above — the column is jsonb, so this type states the intent and
   * `resolveModeration` in core/reply-rules.ts decides at read time whether a
   * stored row is coherent enough to gate a reply.
   */
  moderation: ModerationConfig | null;
  /**
   * A8: the per-customer inbound message limit, or null = off (the default, and
   * what every pre-A8 row holds). Same type-only import and the same jsonb
   * caveat as `topics`/`moderation` above — `resolveSubscriberRate` in
   * core/subscriber-rate.ts decides at read time whether a stored row is
   * coherent enough to limit anyone.
   *
   * The odd one out of the four: routing, topics and moderation are all managed
   * -runtime brain config, while this is ingress protection that applies to
   * BRIDGE AGENTS TOO. See SubscriberRateConfig for why.
   */
  subscriber_rate: SubscriberRateConfig | null;
  /** D6 per-agent config bag; carries the rolling-summarization trigger knobs. */
  context: AgentContext;
  created_at: string;
  updated_at: string;
}

/**
 * Per-agent free-form config (the `context` jsonb column). Today it holds only
 * the rolling-summarization knobs (D6); both optional — defaults (trigger 20,
 * tail 10) are applied at read time in the fold logic, never stored.
 */
export interface AgentContext {
  triggerTurns?: number;
  tailTurns?: number;
}

export interface Conversation {
  id: string;
  tenant_id: string;
  agent_id: string;
  /** The channel connection this thread belongs to (null for inapp/legacy). */
  connection_id: string | null;
  subscriber_id: string;
  channel: string;
  thread_key: string;
  /**
   * Phase 26 HITL handoff state machine:
   *   active →(handoff_to_human tool)→ waiting_human →(first operator reply)→
   *   human →(Return to agent)→ active   ·   waiting_human|human →(Resolve)→ resolved
   * Nothing automatic: a handoff is a promise only a person un-makes (no timeout
   * hand-back). Customer messages in the two human states never change state.
   */
  status: 'active' | 'resolved' | 'waiting_human' | 'human';
  metadata: Record<string, unknown>;
  summary: string | null;
  /** D5 rolling-summarization state: the folded-so-far summary (null = none). */
  rolling_summary: string | null;
  /** D5: the newest message id already folded into rolling_summary (null = none). */
  rolling_upto: string | null;
  /**
   * Phase 26 (D7): true once a human teammate has engaged (set when the first
   * operator reply flips waiting_human → human). Durable across handback and the
   * folding-away of operator turns, so the post-handback reminder stays honest.
   */
  had_human: boolean;
  /**
   * A5 slice B: which side of the running canary this thread was assigned when
   * it OPENED — null when it opened with no canary active (the overwhelming
   * majority of rows). Written exactly once, on the insert branch of the
   * find-or-create upsert, and never updated: a customer must not meet two
   * personalities in one thread.
   *
   * NOTE for readers doing attribution: arm === 'canary' means "opened into the
   * canary arm", NOT "every turn here ran the canary prompt". A trial that is
   * stopped or promoted mid-thread reverts this conversation to the live prompt
   * at its next turn (see the conversation processor). Which config actually
   * served a given turn is stamped per-reply-row in `raw.canaryVersion`.
   */
  canary_arm: 'canary' | 'control' | null;
  message_count: number;
  last_message_at: string;
  created_at: string;
}

export interface ConversationMessage {
  id: string;
  conversation_id: string;
  tenant_id: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  dedupe_key: string;
  raw: unknown;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
  deleted_by: 'user' | 'operator' | null;
}

// ---- agents ----

export async function createAgent(a: {
  tenantId: string;
  identifier: string;
  name: string;
  description?: string;
  runtime: 'bridge' | 'managed';
  bridgeUrl?: string;
  sealedSecret: string;
  model?: string;
  systemPrompt?: string;
  llmBaseUrl?: string;
  sealedLlmCredentials?: string;
  maxTokens?: number;
  maxDailyTokens?: number | null;
  autoResolveMinutes?: number;
  welcomeMessage?: string | null;
  suggestedPrompts?: Array<{ title: string; message: string }> | null;
  context?: AgentContext;
  /** A6: cheap-first routing, or absent = off (what every agent is born as). */
  routing?: RoutingConfig;
  /** A7: the topic gate's policy, or absent = off (what every agent is born as). */
  topics?: TopicsConfig;
  /** A7: the outbound reply rules, or absent = off (ditto). */
  moderation?: ModerationConfig;
}): Promise<Agent | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `insert into agents
       (tenant_id, identifier, name, description, runtime, bridge_url,
        signing_secret, model, system_prompt, llm_base_url, llm_credentials, max_tokens,
        auto_resolve_minutes, welcome_message, suggested_prompts, max_daily_tokens, context,
        routing, topics, moderation)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             coalesce($17::jsonb, '{}'::jsonb), $18::jsonb, $19::jsonb, $20::jsonb)
     on conflict (tenant_id, identifier) do nothing
     returning *`,
      [
        a.tenantId,
        a.identifier,
        a.name,
        a.description ?? null,
        a.runtime,
        a.bridgeUrl ?? null,
        a.sealedSecret,
        a.model ?? null,
        a.systemPrompt ?? null,
        a.llmBaseUrl ?? null,
        a.sealedLlmCredentials ?? null,
        a.maxTokens ?? null,
        a.autoResolveMinutes ?? null,
        a.welcomeMessage ?? null,
        a.suggestedPrompts ? JSON.stringify(a.suggestedPrompts) : null,
        a.maxDailyTokens ?? null,
        a.context ? JSON.stringify(a.context) : null,
        a.routing ? JSON.stringify(a.routing) : null,
        a.topics ? JSON.stringify(a.topics) : null,
        a.moderation ? JSON.stringify(a.moderation) : null,
      ],
    );
    const agent: Agent | undefined = rows[0];
    // A5: a managed agent is born at version 1 — the prompt it was created with
    // is history from the first second, so the version list is never missing its
    // own origin. Bridge agents get no row (no prompt to version). Same
    // transaction as the insert: an agent can never exist without its v1.
    if (agent && agent.runtime === 'managed') {
      await client.query(
        `insert into agent_prompt_versions (agent_id, version, system_prompt, model)
         values ($1, 1, $2, $3)
         on conflict (agent_id, version) do nothing`,
        [agent.id, agent.system_prompt, agent.model],
      );
    }
    await client.query('COMMIT');
    return agent ?? null;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

export async function listAgents(tenantId: string): Promise<Agent[]> {
  const { rows } = await pool.query(
    'select * from agents where tenant_id = $1 order by created_at desc',
    [tenantId],
  );
  return rows;
}

export async function getAgent(tenantId: string, identifier: string): Promise<Agent | null> {
  const { rows } = await pool.query(
    'select * from agents where tenant_id = $1 and identifier = $2',
    [tenantId, identifier],
  );
  return rows[0] ?? null;
}

export async function getAgentById(id: string): Promise<Agent | null> {
  const { rows } = await pool.query('select * from agents where id = $1', [id]);
  return rows[0] ?? null;
}

export async function updateAgent(
  tenantId: string,
  identifier: string,
  patch: {
    name?: string;
    description?: string;
    runtime?: 'bridge' | 'managed';
    bridgeUrl?: string;
    status?: string;
    /**
     * null CLEARS the model (back to DEFAULT_MODEL) — '' is the wire sentinel.
     * The public PATCH schema can't produce null (model is min(1)); the clear
     * exists so an A5 restore can reproduce a snapshot that had no model.
     */
    model?: string | null;
    systemPrompt?: string;
    llmBaseUrl?: string | null;
    sealedLlmCredentials?: string;
    maxTokens?: number;
    /** null switches the daily token budget OFF (0 is the wire sentinel). */
    maxDailyTokens?: number | null;
    /** null switches the backstop OFF (0 is the wire sentinel for null). */
    autoResolveMinutes?: number | null;
    /** null clears the greeting ('' is the wire sentinel for null). */
    welcomeMessage?: string | null;
    /** null clears the starters (jsonb 'null' is the wire sentinel for null). */
    suggestedPrompts?: Array<{ title: string; message: string }> | null;
    /** D6 rolling knobs; undefined leaves untouched (no clear sentinel — the bag is small). */
    context?: AgentContext;
    /**
     * A6: null switches routing OFF and forgets the config (jsonb 'null' is the
     * wire sentinel); undefined leaves it untouched. A provided object REPLACES
     * the whole config — it is two fields, so a merge would only buy ambiguity.
     */
    routing?: RoutingConfig | null;
    /**
     * A7: null switches the topic gate OFF and forgets the policy (jsonb 'null'
     * is the wire sentinel); undefined leaves it untouched. A provided object
     * REPLACES the whole policy — merging two deny lists would leave an operator
     * unable to remove a label, which is the one edit a guard must never refuse.
     */
    topics?: TopicsConfig | null;
    /** A7: the reply rules, on exactly the terms `topics` above states. */
    moderation?: ModerationConfig | null;
  },
): Promise<Agent | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Lock the agent row for the whole save. Two concurrent prompt edits would
    // otherwise read the same version counter and race for the same version
    // number — one would lose its snapshot to the primary key. Serialized here,
    // the second save simply mints the next version.
    const before = await client.query(
      'select * from agents where tenant_id = $1 and identifier = $2 for update',
      [tenantId, identifier],
    );
    const existing: Agent | undefined = before.rows[0];
    if (!existing) {
      await client.query('ROLLBACK');
      return null;
    }
    const { rows } = await client.query(
      `update agents set
       name            = coalesce($3, name),
       description     = coalesce($4, description),
       runtime         = coalesce($5, runtime),
       bridge_url      = coalesce($6, bridge_url),
       status          = coalesce($7, status),
       -- '' sentinel clears the model (back to DEFAULT_MODEL)
       model           = case when $8::text = '' then null else coalesce($8, model) end,
       system_prompt   = coalesce($9, system_prompt),
       -- '' sentinel clears the base URL (back to api.anthropic.com)
       llm_base_url    = case when $10::text = '' then null else coalesce($10, llm_base_url) end,
       llm_credentials = coalesce($11, llm_credentials),
       max_tokens      = coalesce($12, max_tokens),
       -- 0 sentinel clears the idle timeout (bounds are 1-43200)
       auto_resolve_minutes = case when $13::int = 0 then null
                                   else coalesce($13, auto_resolve_minutes) end,
       -- '' sentinel clears the greeting; null param leaves it untouched
       welcome_message = case when $14::text = '' then null
                              else coalesce($14, welcome_message) end,
       -- jsonb 'null' sentinel clears the starters; null param leaves them
       suggested_prompts = case when $15::jsonb = 'null'::jsonb then null
                                else coalesce($15::jsonb, suggested_prompts) end,
       -- 0 sentinel clears the daily token budget (bounds are 1+)
       max_daily_tokens = case when $16::int = 0 then null
                               else coalesce($16, max_daily_tokens) end,
       -- undefined leaves the config bag untouched; a provided object replaces it
       context         = coalesce($17::jsonb, context),
       -- A6: jsonb 'null' sentinel clears the router; null param leaves it
       routing         = case when $18::jsonb = 'null'::jsonb then null
                              else coalesce($18::jsonb, routing) end,
       -- A7: same jsonb 'null' clear sentinel for both gates
       topics          = case when $19::jsonb = 'null'::jsonb then null
                              else coalesce($19::jsonb, topics) end,
       moderation      = case when $20::jsonb = 'null'::jsonb then null
                              else coalesce($20::jsonb, moderation) end,
       updated_at      = now()
     where tenant_id = $1 and identifier = $2
     returning *`,
      [
        tenantId,
        identifier,
        patch.name ?? null,
        patch.description ?? null,
        patch.runtime ?? null,
        patch.bridgeUrl ?? null,
        patch.status ?? null,
        patch.model === null ? '' : (patch.model ?? null),
        patch.systemPrompt ?? null,
        patch.llmBaseUrl === null ? '' : (patch.llmBaseUrl ?? null),
        patch.sealedLlmCredentials ?? null,
        patch.maxTokens ?? null,
        patch.autoResolveMinutes === null ? 0 : (patch.autoResolveMinutes ?? null),
        patch.welcomeMessage === null ? '' : (patch.welcomeMessage ?? null),
        patch.suggestedPrompts === null
          ? 'null'
          : patch.suggestedPrompts === undefined
            ? null
            : JSON.stringify(patch.suggestedPrompts),
        patch.maxDailyTokens === null ? 0 : (patch.maxDailyTokens ?? null),
        patch.context === undefined ? null : JSON.stringify(patch.context),
        patch.routing === null
          ? 'null'
          : patch.routing === undefined
            ? null
            : JSON.stringify(patch.routing),
        patch.topics === null
          ? 'null'
          : patch.topics === undefined
            ? null
            : JSON.stringify(patch.topics),
        patch.moderation === null
          ? 'null'
          : patch.moderation === undefined
            ? null
            : JSON.stringify(patch.moderation),
      ],
    );
    let agent: Agent = rows[0];

    // ---- A5: the save mints a version ----
    // The trigger is the OUTCOME, not the request: a PATCH that carries the
    // same prompt it already had changes nothing, so it versions nothing. Only
    // a real change to what the brain is (prompt or model) is history.
    const promptChanged =
      agent.system_prompt !== existing.system_prompt || agent.model !== existing.model;
    if (agent.runtime === 'managed' && promptChanged) {
      const { rows: maxRows } = await client.query(
        'select coalesce(max(version), 0)::int as max from agent_prompt_versions where agent_id = $1',
        [agent.id],
      );
      let previous: number = maxRows[0].max;
      // BACKFILL: an agent older than versioning (or one just converted from
      // bridge) has no rows. Seed v1 from the PRE-EDIT values first, so its
      // original prompt enters history instead of being overwritten into
      // oblivion by its own first edit — then this save lands as v2.
      if (previous === 0) {
        await client.query(
          `insert into agent_prompt_versions (agent_id, version, system_prompt, model)
           values ($1, 1, $2, $3)`,
          [agent.id, existing.system_prompt, existing.model],
        );
        previous = 1;
      }
      const next = previous + 1;
      await client.query(
        `insert into agent_prompt_versions (agent_id, version, system_prompt, model)
         values ($1, $2, $3, $4)`,
        [agent.id, next, agent.system_prompt, agent.model],
      );
      const bumped = await client.query(
        'update agents set prompt_version = $2 where id = $1 returning *',
        [agent.id, next],
      );
      agent = bumped.rows[0];
    }

    await client.query('COMMIT');
    return agent;
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

// ---- A5: prompt versions (immutable snapshots of a managed agent's brain) ----

export interface AgentPromptVersion {
  agent_id: string;
  version: number;
  system_prompt: string | null;
  model: string | null;
  created_at: string;
}

/**
 * The history list. Deliberately NOT the prompt text: a hundred versions of a
 * 100k-char prompt is megabytes down the wire for a panel that only renders
 * numbers and dates. The length + head are enough to tell versions apart; the
 * full text is one click away on the single-version route.
 */
export async function listAgentPromptVersions(
  agentId: string,
): Promise<
  Array<{ version: number; model: string | null; prompt_length: number; prompt_head: string; created_at: string }>
> {
  const { rows } = await pool.query(
    `select version,
            model,
            coalesce(length(system_prompt), 0)::int as prompt_length,
            coalesce(left(system_prompt, 140), '')  as prompt_head,
            created_at
       from agent_prompt_versions
      where agent_id = $1
      order by version desc`,
    [agentId],
  );
  return rows;
}

export async function getAgentPromptVersion(
  agentId: string,
  version: number,
): Promise<AgentPromptVersion | null> {
  const { rows } = await pool.query(
    'select * from agent_prompt_versions where agent_id = $1 and version = $2',
    [agentId, version],
  );
  return rows[0] ?? null;
}

// ---- A5 slice B: canary (one version on trial against a slice of real traffic) ----

/**
 * Start a trial. Returns null when one is ALREADY running — the `canary_version
 * is null` predicate makes "at most one active canary per agent" an atomic
 * property of the write, so two operators racing the Start button produce one
 * trial and one honest 409, never two half-applied configs. The caller has
 * already checked that the version exists and that the agent is managed.
 */
/**
 * A5 slice C: the share of replies — in BOTH arms — sampled for async judging
 * when Start doesn't say otherwise. 20% is chosen to make the comparison
 * affordable at scale: judging is one extra LLM call per sampled turn, so a
 * 10M-turn month at 100% would double the agent's model spend, while 20% of
 * both arms still reaches a few hundred judgments within hours of a normal
 * trial — enough for the averages to separate, cheap enough to leave on.
 */
export const SAMPLE_PERCENT_DEFAULT = 20;

export async function startCanary(
  agentId: string,
  version: number,
  percent: number,
  samplePercent: number = SAMPLE_PERCENT_DEFAULT,
): Promise<Agent | null> {
  const { rows } = await pool.query(
    `update agents
        set canary_version = $2, canary_percent = $3, canary_started_at = now(),
            canary_sample_percent = $4
      where id = $1 and canary_version is null
      returning *`,
    [agentId, version, percent, samplePercent],
  );
  return rows[0] ?? null;
}

/**
 * End a trial (Stop, and the second half of Promote). Idempotent: clearing an
 * agent that has no canary is a no-op that still returns the row, so a repeated
 * Stop — or a Promote retried after a crash between its two steps — is safe.
 * Conversations already in the canary arm keep their arm but revert to the live
 * prompt at their NEXT turn (the processor re-checks the agent every turn).
 */
export async function clearCanary(agentId: string): Promise<Agent | null> {
  const { rows } = await pool.query(
    `update agents
        set canary_version = null, canary_percent = null, canary_started_at = null,
            canary_sample_percent = null
      where id = $1
      returning *`,
    [agentId],
  );
  return rows[0] ?? null;
}

// ---- A5 slice C: the comparison (per-turn judgments + per-arm report) ----

/** One (reply, dimension) score. `arm` is what SERVED the turn — see schema.sql. */
export interface TurnJudgmentRow {
  tenantId: string;
  agentId: string;
  conversationId: string;
  messageId: string;
  arm: 'canary' | 'control';
  canaryVersion: number | null;
  dim: string;
  score: number;
  rationale: string;
}

/**
 * Write a judged turn's scores. ONE statement for all dimensions (a judge call
 * returns groundedness and tone together), and `on conflict do nothing` on
 * unique (message_id, dim): a retried BullMQ job re-judges the same reply and
 * its scores are DROPPED rather than added, so no reply can be counted twice
 * and pull an arm's average toward whichever turn happened to be retried.
 * Returns how many rows were actually new — the caller logs it, and the tests
 * assert 0 on the second attempt.
 */
export async function insertTurnJudgments(rows: TurnJudgmentRow[]): Promise<number> {
  if (rows.length === 0) return 0;
  // Positional tuples rather than N round trips: the whole verdict set is one
  // insert regardless of how many dimensions the judge returned.
  const values = rows
    .map((_, i) => {
      const b = i * 9;
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8},$${b + 9})`;
    })
    .join(',');
  const params = rows.flatMap((r) => [
    r.tenantId,
    r.agentId,
    r.conversationId,
    r.messageId,
    r.arm,
    r.canaryVersion,
    r.dim,
    r.score,
    r.rationale,
  ]);
  const { rowCount } = await pool.query(
    `insert into agent_turn_judgments
       (tenant_id, agent_id, conversation_id, message_id, arm, canary_version, dim, score, rationale)
     values ${values}
     on conflict (message_id, dim) do nothing`,
    params,
  );
  return rowCount ?? 0;
}

export interface CanaryArmStats {
  arm: 'canary' | 'control';
  conversations: number;
  turns: number;
  resolutions: number;
  handoffs: number;
  guardPauses: number;
  /** Mean input+output tokens over the turns that RECORDED usage; null if none. */
  avgTokensPerTurn: number | null;
}

export interface CanaryJudgedStat {
  arm: 'canary' | 'control';
  dim: string;
  avg: number;
  n: number;
}

/**
 * Per-arm operational counters for ONE trial.
 *
 * TWO DIFFERENT ATTRIBUTIONS, deliberately, because two different things are
 * being counted:
 *  - conversations / resolutions / handoffs / guard pauses are counted by the
 *    arm the conversation was ENROLLED in. A conversation is a thing that was
 *    assigned once; "did this thread resolve?" is a property of the thread.
 *  - turns are counted by what ACTUALLY SERVED them (raw.canaryVersion on the
 *    reply row). The arm alone would lie: a canary-arm thread whose trial
 *    version vanished underneath it falls through to the live prompt, and
 *    slice B's revert means the same after a Stop. A reply the trial version
 *    never wrote must not be counted as evidence for it.
 * The two agree for every ordinary turn; where they disagree, each column is
 * answering its own question honestly.
 *
 * QUERY COST — every scan is proportional to THIS TRIAL, never to table size:
 *   `trial`  → conversations_canary_arm_idx (agent_id, canary_arm) WHERE
 *              canary_arm is not null (slice B's partial index), with
 *              created_at as a residual filter. Rows = conversations opened
 *              under this trial.
 *   `turns`  → conversation_messages_conv_idx (conversation_id, created_at),
 *              one index range per trial conversation.
 *   `pauses` → agent_tool_calls_conversation_idx (conversation_id).
 * No per-row loop and no per-conversation round trip: one statement, two
 * grouped aggregates, at 10M users the work still scales with the sampled
 * trial rather than with history.
 */
export async function canaryArmStats(
  agentId: string,
  startedAt: string,
  canaryVersion: number,
): Promise<CanaryArmStats[]> {
  const { rows } = await pool.query(
    `with trial as (
       select id, canary_arm, status, had_human
         from conversations
        where agent_id = $1 and canary_arm is not null and created_at >= $2
     ),
     conv as (
       select canary_arm as arm,
              count(*) as n,
              count(*) filter (where status = 'resolved') as resolved,
              count(*) filter (where had_human) as handoffs
         from trial group by canary_arm
     ),
     turns as (
       select case when (m.raw->>'canaryVersion')::int = $3 then 'canary' else 'control' end as arm,
              (m.raw->'usage'->>'inputTokens')::numeric
                + (m.raw->'usage'->>'outputTokens')::numeric as tokens
         from trial t
         join conversation_messages m on m.conversation_id = t.id
        where m.role = 'agent'
          -- Platform-authored rows (the budget-pause note) are not model turns
          -- and must not dilute either arm's counts or its token average.
          and (m.raw->>'platformNote') is null
          and m.created_at >= $2
     ),
     turn_agg as (
       select arm, count(*) as n, round(avg(tokens))::int as avg_tokens
         from turns group by arm
     ),
     pauses as (
       select t.canary_arm as arm, count(*) as n
         from trial t
         join agent_tool_calls c on c.conversation_id = t.id
        -- A guard pause is a tool call that STOPPED for a human. Final status
        -- cannot tell them apart (an approved-then-run call ends 'executed',
        -- exactly like an auto call), but only the approval path stamps an
        -- expiry at insert — so expires_at is the durable marker of "this one
        -- paused". See managed-brain's recordToolCall calls.
        where c.expires_at is not null and c.requested_at >= $2
        group by t.canary_arm
     )
     select a.arm,
            coalesce(conv.n, 0)::int          as conversations,
            coalesce(turn_agg.n, 0)::int      as turns,
            coalesce(conv.resolved, 0)::int   as resolutions,
            coalesce(conv.handoffs, 0)::int   as handoffs,
            coalesce(pauses.n, 0)::int        as guard_pauses,
            turn_agg.avg_tokens               as avg_tokens
       from (select unnest(array['canary','control']) as arm) a
       left join conv     on conv.arm = a.arm
       left join turn_agg on turn_agg.arm = a.arm
       left join pauses   on pauses.arm = a.arm`,
    [agentId, startedAt, canaryVersion],
  );
  return rows.map((r) => ({
    arm: r.arm as 'canary' | 'control',
    conversations: r.conversations,
    turns: r.turns,
    resolutions: r.resolutions,
    handoffs: r.handoffs,
    guardPauses: r.guard_pauses,
    avgTokensPerTurn: r.avg_tokens ?? null,
  }));
}

/**
 * Judged averages per arm per dimension, scoped to ONE trial.
 *
 * The scope predicate is why a re-run of the same version doesn't pollute the
 * new numbers: canary rows must carry THIS trial's version, and everything is
 * floored at started_at. Control rows carry no version (they are live-prompt
 * observations), so the floor alone scopes them.
 *
 * COST: agent_turn_judgments_report_idx (agent_id, created_at) — one index
 * range over this trial's judgments, aggregated in the database. n never
 * exceeds sample% of the trial's turns.
 */
export async function canaryJudgedStats(
  agentId: string,
  startedAt: string,
  canaryVersion: number,
): Promise<CanaryJudgedStat[]> {
  const { rows } = await pool.query(
    `select arm, dim, avg(score)::float8 as avg, count(*)::int as n
       from agent_turn_judgments
      where agent_id = $1
        and created_at >= $2
        and (arm = 'control' or canary_version = $3)
      group by arm, dim
      order by arm, dim`,
    [agentId, startedAt, canaryVersion],
  );
  return rows.map((r) => ({
    arm: r.arm as 'canary' | 'control',
    dim: r.dim as string,
    avg: r.avg as number,
    n: r.n as number,
  }));
}

export async function rotateAgentSecret(
  tenantId: string,
  identifier: string,
  sealedSecret: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update agents set signing_secret = $3, updated_at = now()
     where tenant_id = $1 and identifier = $2`,
    [tenantId, identifier, sealedSecret],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteAgent(tenantId: string, identifier: string): Promise<number> {
  const { rowCount } = await pool.query(
    'delete from agents where tenant_id = $1 and identifier = $2',
    [tenantId, identifier],
  );
  return rowCount ?? 0;
}

// ---- channel connections ----

export interface AgentConnection {
  id: string;
  tenant_id: string;
  agent_id: string;
  channel: string;
  credentials: string; // sealed — open only where the channel client needs it
  config: Record<string, unknown>;
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

/**
 * Connect (or re-connect) telegram: identity-upsert keyed by the bot's id
 * within the tenant, NOT by agent — the same bot re-pointed at a new agent
 * updates the existing connection in place (agent_id = excluded.agent_id).
 * `refreshed` (Postgres's xmax trick) is true when this hit an existing row.
 */
export async function upsertTelegramConnection(c: {
  tenantId: string;
  agentId: string;
  sealedCredentials: string;
  config: Record<string, unknown>;
}): Promise<AgentConnection & { refreshed: boolean }> {
  const { rows } = await pool.query(
    `insert into agent_connections (tenant_id, agent_id, channel, credentials, config)
     values ($1, $2, 'telegram', $3, $4)
     on conflict (tenant_id, (config->>'botId')) where channel = 'telegram' and status = 'active'
       do update set
         credentials = excluded.credentials,
         config      = excluded.config,
         agent_id    = excluded.agent_id,
         updated_at  = now()
     returning *, (xmax <> 0) as refreshed`,
    [c.tenantId, c.agentId, c.sealedCredentials, JSON.stringify(c.config)],
  );
  // Phase 25 (slice B): a telegram connect/re-connect write — refresh the admin connections list.
  void emitTenantEvent(rows[0].tenant_id, 'connection.changed', rows[0].id);
  return rows[0];
}

/** Connect (or re-connect) email: identity-upsert keyed by the inbound address. */
export async function upsertEmailConnection(c: {
  tenantId: string;
  agentId: string;
  sealedCredentials: string;
  config: Record<string, unknown>;
}): Promise<AgentConnection & { refreshed: boolean }> {
  const { rows } = await pool.query(
    `insert into agent_connections (tenant_id, agent_id, channel, credentials, config)
     values ($1, $2, 'email', $3, $4)
     on conflict (tenant_id, (config->>'address')) where channel = 'email' and status = 'active'
       do update set
         credentials = excluded.credentials,
         config      = excluded.config,
         agent_id    = excluded.agent_id,
         updated_at  = now()
     returning *, (xmax <> 0) as refreshed`,
    [c.tenantId, c.agentId, c.sealedCredentials, JSON.stringify(c.config)],
  );
  // Phase 25 (slice B): an email connect/re-connect write.
  void emitTenantEvent(rows[0].tenant_id, 'connection.changed', rows[0].id);
  return rows[0];
}

/**
 * Connect (or re-connect) slack: identity-upsert keyed by the workspace's
 * team id within the tenant — the same workspace re-pointed at a new default
 * agent updates the existing connection in place. `refreshed` (the xmax
 * trick) is true when this hit an existing row.
 */
export async function upsertSlackConnection(c: {
  tenantId: string;
  agentId: string;
  sealedCredentials: string;
  config: Record<string, unknown>;
}): Promise<AgentConnection & { refreshed: boolean }> {
  const { rows } = await pool.query(
    `insert into agent_connections (tenant_id, agent_id, channel, credentials, config)
     values ($1, $2, 'slack', $3, $4)
     on conflict (tenant_id, (config->>'teamId')) where channel = 'slack' and status = 'active'
       do update set
         credentials = excluded.credentials,
         config      = excluded.config,
         agent_id    = excluded.agent_id,
         updated_at  = now()
     returning *, (xmax <> 0) as refreshed`,
    [c.tenantId, c.agentId, c.sealedCredentials, JSON.stringify(c.config)],
  );
  // Phase 25 (slice B): a slack connect/re-connect write.
  void emitTenantEvent(rows[0].tenant_id, 'connection.changed', rows[0].id);
  return rows[0];
}

export async function getConnectionById(id: string): Promise<AgentConnection | null> {
  const { rows } = await pool.query('select * from agent_connections where id = $1', [id]);
  return rows[0] ?? null;
}

/** Tenant-scoped connection fetch (the connection-as-endpoint API surface). */
export async function getConnection(tenantId: string, id: string): Promise<AgentConnection | null> {
  const { rows } = await pool.query(
    'select * from agent_connections where tenant_id = $1 and id = $2',
    [tenantId, id],
  );
  return rows[0] ?? null;
}

/** The active connection for an agent+channel (v1: one live identity per pair). */
export async function getConnectionForAgent(
  agentId: string,
  channel: string,
): Promise<AgentConnection | null> {
  const { rows } = await pool.query(
    `select * from agent_connections where agent_id = $1 and channel = $2
       and status = 'active' order by created_at asc limit 1`,
    [agentId, channel],
  );
  return rows[0] ?? null;
}

export async function listConnectionsForAgent(agentId: string): Promise<AgentConnection[]> {
  const { rows } = await pool.query(
    'select * from agent_connections where agent_id = $1 order by channel',
    [agentId],
  );
  return rows;
}

export interface ConnectionListRow extends AgentConnection {
  agent_identifier: string;
  agent_name: string;
}

/** Every connection in the tenant, with its current agent (the routing view). */
export async function listConnectionsForTenant(tenantId: string): Promise<ConnectionListRow[]> {
  const { rows } = await pool.query(
    `select c.*, a.identifier as agent_identifier, a.name as agent_name
       from agent_connections c
       join agents a on a.id = c.agent_id
      where c.tenant_id = $1
      order by c.channel, c.created_at`,
    [tenantId],
  );
  return rows;
}

/**
 * Re-point a connection at a different agent, moving its channel conversations
 * along in the SAME transaction so no inbound turn lands on the old agent
 * mid-move. Returns null when the connection doesn't exist in this tenant.
 */
export async function updateConnectionAgent(
  tenantId: string,
  connectionId: string,
  newAgentId: string,
): Promise<{ connection: AgentConnection; movedConversations: number } | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `update agent_connections set agent_id = $3, updated_at = now()
       where id = $2 and tenant_id = $1
       returning *`,
      [tenantId, connectionId, newAgentId],
    );
    if (!rows[0]) {
      await client.query('ROLLBACK');
      return null;
    }
    const moved = await client.query(
      'update conversations set agent_id = $3 where tenant_id = $1 and connection_id = $2 and agent_id <> $3',
      [tenantId, connectionId, newAgentId],
    );
    await client.query('COMMIT');
    // Phase 25 (slice B): re-point committed — the connection's agent changed.
    void emitTenantEvent(rows[0].tenant_id, 'connection.changed', rows[0].id);
    return { connection: rows[0], movedConversations: moved.rowCount ?? 0 };
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
}

/** Shallow-merge a config patch (jsonb ||) — idempotent; races converge. */
export async function updateConnectionConfig(
  tenantId: string,
  connectionId: string,
  patch: Record<string, unknown>,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update agent_connections set config = config || $3::jsonb, updated_at = now()
      where tenant_id = $1 and id = $2`,
    [tenantId, connectionId, JSON.stringify(patch)],
  );
  // Phase 25 (slice B): a config-flag write (e.g. manifestAutoUpdate on/broken during reconnect).
  if ((rowCount ?? 0) > 0) void emitTenantEvent(tenantId, 'connection.changed', connectionId);
  return (rowCount ?? 0) > 0;
}

/** Tenant-scoped delete by connection id (the endpoint-model delete path). */
export async function deleteConnectionById(tenantId: string, id: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'delete from agent_connections where tenant_id = $1 and id = $2',
    [tenantId, id],
  );
  // Phase 25 (slice B): disconnect write — drop the row from the admin list live.
  if ((rowCount ?? 0) > 0) void emitTenantEvent(tenantId, 'connection.changed', id);
  return (rowCount ?? 0) > 0;
}

/**
 * Legacy shim: delete an agent's connection(s) for a channel. Post-split this
 * may delete MORE than one row (parked duplicates) — that's fine, they're all
 * this agent's identity on the channel.
 */
export async function deleteConnection(agentId: string, channel: string): Promise<number> {
  const { rowCount } = await pool.query(
    'delete from agent_connections where agent_id = $1 and channel = $2',
    [agentId, channel],
  );
  return rowCount ?? 0;
}

// ---- per-scope routing rules (slack: channel id -> agent within one workspace) ----

export interface RoutingRule {
  id: string;
  tenant_id: string;
  connection_id: string;
  scope_key: string;
  agent_id: string;
  created_at: string;
}

/** The rule for one scope inside a connection — the inbound routing lookup. */
export async function getRoutingRule(
  connectionId: string,
  scopeKey: string,
): Promise<RoutingRule | null> {
  const { rows } = await pool.query(
    'select * from connection_routing_rules where connection_id = $1 and scope_key = $2',
    [connectionId, scopeKey],
  );
  return rows[0] ?? null;
}

export interface RoutingRuleListRow extends RoutingRule {
  agent_identifier: string;
  agent_name: string;
}

/** Every scope rule on a connection, with its target agent (the management view). */
export async function listRoutingRules(
  tenantId: string,
  connectionId: string,
): Promise<RoutingRuleListRow[]> {
  const { rows } = await pool.query(
    `select r.*, a.identifier as agent_identifier, a.name as agent_name
       from connection_routing_rules r
       join agents a on a.id = r.agent_id
      where r.tenant_id = $1 and r.connection_id = $2
      order by r.scope_key`,
    [tenantId, connectionId],
  );
  return rows;
}

/** Set (or re-point) the rule for a scope: last write wins. */
export async function upsertRoutingRule(r: {
  tenantId: string;
  connectionId: string;
  scopeKey: string;
  agentId: string;
}): Promise<RoutingRule> {
  const { rows } = await pool.query(
    `insert into connection_routing_rules (tenant_id, connection_id, scope_key, agent_id)
     values ($1, $2, $3, $4)
     on conflict (connection_id, scope_key) do update set agent_id = excluded.agent_id
     returning *`,
    [r.tenantId, r.connectionId, r.scopeKey, r.agentId],
  );
  return rows[0];
}

export async function deleteRoutingRule(
  tenantId: string,
  connectionId: string,
  scopeKey: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    'delete from connection_routing_rules where tenant_id = $1 and connection_id = $2 and scope_key = $3',
    [tenantId, connectionId, scopeKey],
  );
  return (rowCount ?? 0) > 0;
}

/** Subscriber row by primary key (conversations store the uuid). */
export async function getSubscriberById(id: string): Promise<{
  id: string;
  external_id: string;
  email: string | null;
  phone: string | null;
  push_token: string | null;
} | null> {
  const { rows } = await pool.query(
    'select id, external_id, email, phone, push_token from subscribers where id = $1',
    [id],
  );
  return rows[0] ?? null;
}

/**
 * Resolve a subscriber by its tenant-scoped external_id (the id customers use
 * in the API/widget). Returns null when unknown — callers 404. Used by the
 * memory admin API, which addresses a subscriber by external_id, not uuid.
 */
export async function getSubscriberByExternalId(
  tenantId: string,
  externalId: string,
): Promise<{
  id: string;
  external_id: string;
  email: string | null;
  phone: string | null;
  push_token: string | null;
} | null> {
  const { rows } = await pool.query(
    `select id, external_id, email, phone, push_token
       from subscribers where tenant_id = $1 and external_id = $2`,
    [tenantId, externalId],
  );
  return rows[0] ?? null;
}

// ---- conversations ----

/**
 * Find-or-create the conversation for a thread, reopening it if it was
 * resolved (a new message on a resolved thread = the user came back).
 */
/**
 * A5 slice B — THE canary arm roll, in SQL, as one expression shared by both
 * find-or-create paths so no channel can quietly opt itself out by forgetting.
 *
 * `$N` is the JS roll: a number in [0,100), or NULL to decline the trial
 * entirely (the eval driver — see `noCanary` below). The agent's canary config
 * is read by scalar subquery in the same statement as the insert, so there is
 * no extra round trip and no window where a trial starts between the read and
 * the write. Deliberately NOT SQL's own `random()`: the roll belongs to the
 * caller so tests can pin it, and so the percent boundary is checked in one
 * language rather than two.
 *
 * The result is written ONLY on the insert branch — every `on conflict do
 * update` below leaves canary_arm alone. That is what makes the arm sticky:
 * not a rule to remember at each call site, but the shape of the statement.
 */
const CANARY_ARM_SQL = (rollParam: string, agentIdParam: string) => `
      case
        when ${rollParam}::numeric is null then null
        else (
          select case
                   when a.canary_version is null then null
                   when ${rollParam}::numeric < a.canary_percent then 'canary'
                   else 'control'
                 end
            from agents a
           where a.id = ${agentIdParam}
        )
      end`;

/** One roll in [0,100), or null when this conversation declines the trial. */
function canaryRoll(noCanary?: boolean): number | null {
  return noCanary ? null : Math.random() * 100;
}

export async function openConversation(c: {
  tenantId: string;
  agentId: string;
  subscriberId: string; // subscribers.id (uuid)
  channel: string;
  threadKey: string;
  /**
   * A5 slice B: open this conversation OUTSIDE any running canary (arm null).
   * The eval-run driver passes it: an eval run grades the config it was asked
   * to grade, so a trial running in production must not silently reassign a
   * fraction of its scenarios to a different prompt and make the scores lie.
   * Explicit rather than inferred from `channel`/caller shape — a future
   * internal driver should have to state its intent, not inherit it by accident.
   */
  noCanary?: boolean;
}): Promise<Conversation> {
  const { rows } = await pool.query(
    `insert into conversations (tenant_id, agent_id, subscriber_id, channel, thread_key, canary_arm)
     values ($1, $2, $3, $4, $5, ${CANARY_ARM_SQL('$6', '$2')})
     on conflict (agent_id, channel, thread_key) where connection_id is null do update set
       -- Reopen a RESOLVED thread (the user came back), but NEVER force a
       -- waiting_human/human thread back to active (Phase 26 D1/D11): a customer
       -- message while a human owns the pen must not steal it back — the D2 gate
       -- relies on this find not flipping the status out from under it.
       -- canary_arm is deliberately ABSENT here: an existing thread keeps the
       -- arm it opened with, for the whole life of the thread (A5 slice B).
       status = case when conversations.status = 'resolved' then 'active' else conversations.status end,
       last_message_at = now()
     returning *`,
    [c.tenantId, c.agentId, c.subscriberId, c.channel, c.threadKey, canaryRoll(c.noCanary)],
  );
  // Phase 25 (slice B): the find-or-create/reopen write — a new inbound turn (or
  // a reopened resolved thread) is a conversation change the admin list must see.
  void emitTenantEvent(rows[0].tenant_id, 'conversation.changed', rows[0].id);
  return rows[0];
}

/**
 * Find-or-create a CHANNEL conversation, keyed by (connection_id, thread_key).
 * agent_id self-heals to the connection's current agent on every inbound turn,
 * closing the race where a re-point lands between openings.
 */
export async function openChannelConversation(c: {
  tenantId: string;
  connectionId: string;
  agentId: string;
  subscriberId: string;
  channel: string;
  threadKey: string;
}): Promise<Conversation> {
  const { rows } = await pool.query(
    `insert into conversations
       (tenant_id, agent_id, connection_id, subscriber_id, channel, thread_key, canary_arm)
     values ($1, $2, $3, $4, $5, $6, ${CANARY_ARM_SQL('$7', '$2')})
     on conflict (connection_id, thread_key) where connection_id is not null do update set
       -- Reopen a RESOLVED thread only; keep a waiting_human/human thread in its
       -- human state so a customer message can't steal the pen back (Phase 26 D1/D11).
       -- canary_arm absent for the same reason as in openConversation: sticky.
       status = case when conversations.status = 'resolved' then 'active' else conversations.status end,
       last_message_at = now(),
       agent_id = excluded.agent_id
     returning *`,
    [c.tenantId, c.agentId, c.connectionId, c.subscriberId, c.channel, c.threadKey, canaryRoll()],
  );
  // Phase 25 (slice B): find-or-create/reopen write for a channel thread — see openConversation.
  void emitTenantEvent(rows[0].tenant_id, 'conversation.changed', rows[0].id);
  return rows[0];
}

/** Channel lookup by (connection, thread) — the edit path's find-not-create. */
export async function findConversationByConnectionThread(
  connectionId: string,
  threadKey: string,
): Promise<Conversation | null> {
  const { rows } = await pool.query(
    'select * from conversations where connection_id = $1 and thread_key = $2',
    [connectionId, threadKey],
  );
  return rows[0] ?? null;
}

/**
 * The connection an outbound reply should be sent through. Channel rows carry
 * connection_id directly; legacy/inapp rows fall back to the agent's active
 * connection for the channel. The fallback is intentionally silent to keep
 * this data layer log-free (see file style) — a null connection_id on a
 * channel row means pre-split legacy data or a disconnected channel.
 */
export async function getConnectionForConversation(
  conversation: Conversation,
): Promise<AgentConnection | null> {
  if (conversation.connection_id) {
    return getConnectionById(conversation.connection_id);
  }
  return getConnectionForAgent(conversation.agent_id, conversation.channel);
}

/** The widget's lookup: the one conversation for this agent+channel+thread. */
export async function findConversationByThread(
  agentId: string,
  channel: string,
  threadKey: string,
): Promise<Conversation | null> {
  const { rows } = await pool.query(
    'select * from conversations where agent_id = $1 and channel = $2 and thread_key = $3',
    [agentId, channel, threadKey],
  );
  return rows[0] ?? null;
}

export async function getConversation(
  tenantId: string,
  id: string,
): Promise<Conversation | null> {
  const { rows } = await pool.query(
    'select * from conversations where tenant_id = $1 and id = $2',
    [tenantId, id],
  );
  return rows[0] ?? null;
}

export interface ConversationListRow extends Conversation {
  agent_identifier: string;
  agent_name: string;
  subscriber_external_id: string;
  last_message_preview: string | null;
}

export async function listConversations(
  tenantId: string,
  filter: { agentIdentifier?: string; status?: string; limit: number },
): Promise<ConversationListRow[]> {
  const { rows } = await pool.query(
    `select c.*, a.identifier as agent_identifier, a.name as agent_name,
            s.external_id as subscriber_external_id,
            (select m.content from conversation_messages m
              where m.conversation_id = c.id and m.role in ('user','agent')
              order by m.created_at desc limit 1) as last_message_preview
     from conversations c
     join agents a on a.id = c.agent_id
     join subscribers s on s.id = c.subscriber_id
     where c.tenant_id = $1
       and ($2::text is null or a.identifier = $2)
       and ($3::text is null or c.status = $3)
     order by c.last_message_at desc
     limit $4`,
    [tenantId, filter.agentIdentifier ?? null, filter.status ?? null, filter.limit],
  );
  return rows;
}

export async function updateConversationMetadata(
  conversationId: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  await pool.query('update conversations set metadata = $2 where id = $1', [
    conversationId,
    JSON.stringify(metadata),
  ]);
}

/**
 * Flip a non-resolved conversation to resolved. Returns true only when THIS call
 * did the flip — the caller uses that to fire the resolved event exactly once,
 * even under concurrent resolves / retries. Guard is `status <> 'resolved'` (not
 * `= 'active'`) so the dashboard's Resolve also closes a waiting_human/human
 * conversation directly (Phase 26 D1 state machine: waiting_human|human → resolved).
 */
export async function resolveConversation(
  conversationId: string,
  summary?: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update conversations set status = 'resolved', summary = coalesce($2, summary)
     where id = $1 and status <> 'resolved'
     returning id`,
    [conversationId, summary ?? null],
  );
  return (rowCount ?? 0) > 0;
}

// ---- Phase 26: HITL handoff state-machine helpers ----
// Each is a guarded, once-only transition (mirrors resolveConversation): the
// status guard makes it fire exactly when the legal source state holds, so the
// boolean return doubles as "THIS call did the flip" for a single P25 emit. Each
// emits conversation.changed AFTER the write (row-then-hint), only when it flipped.

/** active → waiting_human (the handoff_to_human tool). Returns did-flip. */
export async function setConversationWaitingHuman(conversationId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `update conversations set status = 'waiting_human'
     where id = $1 and status = 'active'
     returning tenant_id`,
    [conversationId],
  );
  if (rows[0]) void emitTenantEvent(rows[0].tenant_id, 'conversation.changed', conversationId);
  return rows.length > 0;
}

/**
 * waiting_human → human (the FIRST operator reply). Also stamps had_human=true —
 * the durable D7 flag that a person engaged, kept across handback and folding.
 * Returns did-flip so only the first operator reply fires the emit + status flip.
 */
export async function setConversationHuman(conversationId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `update conversations set status = 'human', had_human = true
     where id = $1 and status = 'waiting_human'
     returning tenant_id`,
    [conversationId],
  );
  if (rows[0]) void emitTenantEvent(rows[0].tenant_id, 'conversation.changed', conversationId);
  return rows.length > 0;
}

/** waiting_human|human → active ("Return to agent"). Returns did-flip. */
export async function handbackConversation(conversationId: string): Promise<boolean> {
  const { rows } = await pool.query(
    `update conversations set status = 'active'
     where id = $1 and status in ('waiting_human', 'human')
     returning tenant_id`,
    [conversationId],
  );
  if (rows[0]) void emitTenantEvent(rows[0].tenant_id, 'conversation.changed', conversationId);
  return rows.length > 0;
}

/**
 * The newest operator (raw.operator) reply row in a conversation — the fold
 * boundary a handback folds through (inclusive). Null when no operator ever
 * replied (a handoff returned to the agent with no human turn), in which case
 * the handback skips the fold entirely.
 */
export async function lastOperatorMessage(
  conversationId: string,
): Promise<ConversationMessage | null> {
  const { rows } = await pool.query(
    `select * from conversation_messages
     where conversation_id = $1 and role = 'agent'
       and raw ? 'operator' and deleted_at is null
     order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

/** A new turn on a resolved thread reopens it (the user came back). */
export async function reopenConversation(conversationId: string): Promise<void> {
  await pool.query(`update conversations set status = 'active' where id = $1`, [conversationId]);
}

/** The latest live inbound turn — the row an agent push is replying to. */
export async function lastUserMessage(
  conversationId: string,
): Promise<ConversationMessage | null> {
  const { rows } = await pool.query(
    `select * from conversation_messages
     where conversation_id = $1 and role = 'user' and deleted_at is null
     order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0] ?? null;
}

export interface SweptConversation {
  id: string;
  tenant_id: string;
  channel: string;
  auto_resolve_minutes: number;
  agent_identifier: string;
  agent_name: string;
  subscriber_external_id: string;
  agent_id: string;
  agent_runtime: 'bridge' | 'managed';
  agent_bridge_url: string | null;
  /** Epoch (seconds, as text) of the row's honest idle timestamp — matches
   * the autoresolve crumb's dedupe suffix so the resolved-event jobId dedupes
   * against the same swept row. */
  idle_epoch: string;
}

/**
 * One batch of the inactivity sweep, as a SINGLE statement: find stale
 * active conversations (agents with the backstop enabled), flip them to
 * resolved, and write the breadcrumb — Postgres does all the work, the
 * caller only loops. Scale shape (the 10-20M rule): the partial index on
 * active conversations makes the scan O(matches); FOR UPDATE SKIP LOCKED
 * lets concurrent worker replicas split batches instead of colliding; the
 * status guard makes re-runs no-ops. The breadcrumb bumps message_count
 * but NOT last_message_at — the row keeps its honest idle timestamp.
 */
export async function sweepInactiveConversations(limit: number): Promise<SweptConversation[]> {
  const { rows } = await pool.query(
    `with stale as (
       select c.id, a.auto_resolve_minutes, a.identifier as agent_identifier,
              a.name as agent_name, a.id as agent_id, a.runtime as agent_runtime,
              a.bridge_url as agent_bridge_url
         from conversations c
         join agents a on a.id = c.agent_id
        where c.status = 'active'
          and a.auto_resolve_minutes is not null
          and c.last_message_at < now() - make_interval(mins => a.auto_resolve_minutes)
        order by c.last_message_at
        limit $1
        for update of c skip locked
     ),
     resolved as (
       update conversations c
          set status = 'resolved',
              -- Humanized: "1 minute" / "45 minutes" / "24 hours" / "1h 30m"
              summary = 'auto-resolved after ' ||
                        case
                          when s.auto_resolve_minutes < 60 then
                            s.auto_resolve_minutes || ' minute' ||
                            case when s.auto_resolve_minutes = 1 then '' else 's' end
                          when s.auto_resolve_minutes % 60 = 0 then
                            (s.auto_resolve_minutes / 60) || ' hour' ||
                            case when s.auto_resolve_minutes = 60 then '' else 's' end
                          else
                            (s.auto_resolve_minutes / 60) || 'h ' ||
                            (s.auto_resolve_minutes % 60) || 'm'
                        end || ' of inactivity',
              message_count = c.message_count + 1
         from stale s
        where c.id = s.id
        returning c.id, c.tenant_id, c.channel, c.subscriber_id, c.last_message_at,
                  c.summary, s.auto_resolve_minutes, s.agent_identifier, s.agent_name,
                  s.agent_id, s.agent_runtime, s.agent_bridge_url
     ),
     crumbs as (
       insert into conversation_messages
         (conversation_id, tenant_id, role, content, dedupe_key)
       select r.id, r.tenant_id, 'system', r.summary,
              'autoresolve-' || r.id || '-' ||
                extract(epoch from r.last_message_at)::bigint
         from resolved r
       on conflict (conversation_id, dedupe_key) do nothing
     )
     select r.id, r.tenant_id, r.channel, r.auto_resolve_minutes,
            r.agent_identifier, r.agent_name,
            r.agent_id, r.agent_runtime, r.agent_bridge_url,
            extract(epoch from r.last_message_at)::bigint::text as idle_epoch,
            sub.external_id as subscriber_external_id
       from resolved r
       join subscribers sub on sub.id = r.subscriber_id`,
    [limit],
  );
  return rows;
}

// ---- messages ----

/** Insert a turn; returns null when the dedupe key already exists (retry). */
export async function insertConversationMessage(m: {
  conversationId: string;
  tenantId: string;
  role: 'user' | 'agent' | 'system';
  content: string;
  dedupeKey: string;
  raw?: unknown;
}): Promise<ConversationMessage | null> {
  const { rows } = await pool.query(
    `insert into conversation_messages
       (conversation_id, tenant_id, role, content, dedupe_key, raw)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (conversation_id, dedupe_key) do nothing
     returning *`,
    [
      m.conversationId,
      m.tenantId,
      m.role,
      m.content,
      m.dedupeKey,
      m.raw === undefined ? null : JSON.stringify(m.raw),
    ],
  );
  const row = rows[0] ?? null;
  if (row) {
    await pool.query(
      `update conversations set message_count = message_count + 1, last_message_at = now()
       where id = $1`,
      [m.conversationId],
    );
  }
  return row;
}

export async function getConversationMessage(id: string): Promise<ConversationMessage | null> {
  const { rows } = await pool.query('select * from conversation_messages where id = $1', [id]);
  return rows[0] ?? null;
}

/** For retry paths: recover the row a dedupe-blocked insert points at. */
export async function getConversationMessageByDedupe(
  conversationId: string,
  dedupeKey: string,
): Promise<ConversationMessage | null> {
  const { rows } = await pool.query(
    'select * from conversation_messages where conversation_id = $1 and dedupe_key = $2',
    [conversationId, dedupeKey],
  );
  return rows[0] ?? null;
}

/**
 * The reply row a telegram inline-keyboard click / ForceReply answer was
 * attached to. Matches EITHER the reply's own message id (buttons, select
 * keyboards, and the reply the plan card finalized on) OR — for a text_input
 * card finalized as a separate ForceReply prompt (D14) — that prompt's message
 * id stored on the same row as `cardPromptTelegramMessageId`. The two ids are
 * always distinct telegram messages, so the OR can never be ambiguous.
 */
export async function findMessageByTelegramId(
  conversationId: string,
  telegramMessageId: number,
): Promise<ConversationMessage | null> {
  const { rows } = await pool.query(
    `select * from conversation_messages
     where conversation_id = $1
       and (raw->>'telegramMessageId' = $2 or raw->>'cardPromptTelegramMessageId' = $2)
     limit 1`,
    [conversationId, String(telegramMessageId)],
  );
  return rows[0] ?? null;
}

/** The row a Slack edit/delete event references, matched by its stored ts. */
export async function findMessageBySlackTs(
  conversationId: string,
  ts: string,
): Promise<ConversationMessage | null> {
  const { rows } = await pool.query(
    `select * from conversation_messages
     where conversation_id = $1 and raw->>'slackTs' = $2
     limit 1`,
    [conversationId, ts],
  );
  return rows[0] ?? null;
}

/** Send-once bookkeeping (e.g. the telegram message id once delivered). */
export async function updateConversationMessageRaw(id: string, raw: unknown): Promise<void> {
  await pool.query('update conversation_messages set raw = $2 where id = $1', [
    id,
    JSON.stringify(raw),
  ]);
}

/**
 * Overwrite an agent message's content in place — the plan-card streaming
 * engine's PROGRESS writes (⏳/✓/✗ step edits). Deliberately does NOT touch
 * edited_at: a finalized reply must never render "(edited)" (that is the
 * whole reason this exists instead of editConversationMessage). Content-only,
 * no tenant guard (the caller owns the row it created this turn).
 */
export async function setAgentMessageContent(id: string, content: string): Promise<void> {
  await pool.query(
    'update conversation_messages set content = $2 where id = $1 and deleted_at is null',
    [id, content],
  );
}

/**
 * The plan card's FINAL write: content + a created_at bump to now(). Why the
 * bump: the plan-card row is inserted at the FIRST tool call, so its
 * insert-time created_at precedes the tool breadcrumbs written during the
 * turn — but replay pairing (buildHistory buffers system breadcrumbs and
 * attaches them to the NEXT agent row) and transcript layout both require a
 * turn's reply to sort AFTER its own breadcrumbs. Bumping at finalize
 * restores the invariant that a turn's reply is its last-written row, so the
 * turn's breadcrumbs fold into THIS reply, not the next one. Like
 * setAgentMessageContent, edited_at stays untouched — a finalized reply must
 * never render "(edited)".
 */
export async function finalizeAgentMessage(id: string, content: string): Promise<void> {
  await pool.query(
    'update conversation_messages set content = $2, created_at = now() where id = $1 and deleted_at is null',
    [id, content],
  );
}

/** Record-only edit. Returns null when missing, deleted, or tenant-mismatched. */
export async function editConversationMessage(
  id: string,
  tenantId: string,
  content: string,
): Promise<ConversationMessage | null> {
  const { rows } = await pool.query(
    `update conversation_messages set content = $3, edited_at = now()
     where id = $1 and tenant_id = $2 and deleted_at is null
     returning *`,
    [id, tenantId, content],
  );
  return rows[0] ?? null;
}

/** Soft-delete tombstone. Idempotent: second call matches nothing, returns null. */
export async function softDeleteConversationMessage(
  id: string,
  tenantId: string,
  deletedBy: 'user' | 'operator',
): Promise<ConversationMessage | null> {
  const { rows } = await pool.query(
    `update conversation_messages set content = '', deleted_at = now(), deleted_by = $3
     where id = $1 and tenant_id = $2 and deleted_at is null
     returning *`,
    [id, tenantId, deletedBy],
  );
  return rows[0] ?? null;
}

export async function conversationTranscript(
  conversationId: string,
  limit = 200,
): Promise<ConversationMessage[]> {
  const { rows } = await pool.query(
    `select * from (
       select * from conversation_messages
       where conversation_id = $1
       order by created_at desc limit $2
     ) t order by created_at asc`,
    [conversationId, limit],
  );
  return rows;
}

/**
 * The user/agent turns before (and excluding) the message being dispatched.
 * `afterMessageId` (D8 rolling-summarization) narrows the window to rows
 * strictly AFTER that message's created_at — the replay backstop stays as a
 * safety limit. NOTE: this role-filtered variant feeds the BRIDGE dispatch,
 * which never sees breadcrumbs; the managed brain replays via
 * conversationTranscriptBefore (see its note).
 */
export async function conversationHistoryBefore(
  conversationId: string,
  beforeMessageId: string,
  limit = 30,
  afterMessageId?: string | null,
): Promise<ConversationMessage[]> {
  const { rows } = await pool.query(
    `select * from (
       select m.* from conversation_messages m
       where m.conversation_id = $1
         and m.role in ('user', 'agent')
         and m.deleted_at is null
         and m.created_at < (select created_at from conversation_messages where id = $2)
         and ($4::uuid is null
              or m.created_at > (select created_at from conversation_messages where id = $4))
       order by m.created_at desc limit $3
     ) t order by created_at asc`,
    [conversationId, beforeMessageId, limit, afterMessageId ?? null],
  );
  return rows;
}

/**
 * Like conversationHistoryBefore but INCLUDING system rows (tool-action
 * breadcrumbs). The managed brain folds these back into the history it
 * replays to the model — without them, past tool-backed replies look like
 * bare claims, and the model learns to imitate claiming instead of calling.
 * THIS is the managed replay path (buildHistory consumes these rows), so the
 * D8 rolling window is applied HERE: `afterMessageId` = the conversation's
 * rolling_upto, so folded turns AND their breadcrumbs drop out (their
 * created_at ≤ rolling_upto's), while every breadcrumb AFTER rolling_upto —
 * belonging to a still-replayed tail turn — is preserved.
 */
export async function conversationTranscriptBefore(
  conversationId: string,
  beforeMessageId: string,
  limit = 40,
  afterMessageId?: string | null,
): Promise<ConversationMessage[]> {
  const { rows } = await pool.query(
    `select * from (
       select m.* from conversation_messages m
       where m.conversation_id = $1
         and m.created_at < (select created_at from conversation_messages where id = $2)
         and ($4::uuid is null
              or m.created_at > (select created_at from conversation_messages where id = $4))
       order by m.created_at desc limit $3
     ) t order by created_at asc`,
    [conversationId, beforeMessageId, limit, afterMessageId ?? null],
  );
  return rows;
}

/**
 * A5 slice C — the judge's evidence window for a REAL turn: every row from the
 * start of the thread THROUGH the reply under judgment, oldest first.
 *
 * The `<=` (rather than the `<` of the *Before loaders) is the whole point: the
 * reply being graded must be in its own evidence window's tail, and so must the
 * tool-result breadcrumbs that justify it. Anything AFTER the reply is excluded
 * — a claim cannot be grounded in evidence that did not exist when the reply
 * was written (the same rule eval-runner's transcriptThroughReply applies to
 * scripted runs). The tie on created_at is broken by id so a breadcrumb written
 * in the same millisecond as the reply cannot be dropped by the limit.
 */
export async function conversationTranscriptThrough(
  conversationId: string,
  messageId: string,
  limit = 40,
): Promise<ConversationMessage[]> {
  const { rows } = await pool.query(
    `select * from (
       select m.* from conversation_messages m
       where m.conversation_id = $1
         and m.deleted_at is null
         and m.created_at <= (select created_at from conversation_messages where id = $2)
       order by m.created_at desc, m.id desc limit $3
     ) t order by created_at asc, id asc`,
    [conversationId, messageId, limit],
  );
  return rows;
}

/**
 * Every transcript row (all roles) strictly AFTER a message's created_at,
 * oldest first — the rolling-fold recompute's source. Unlike the *Before
 * loaders this has no upper bound (it reaches the newest reply) and a generous
 * limit so a fold that skipped several triggers still captures the whole
 * un-summarized region. `afterMessageId` null = from the very start.
 */
export async function conversationRowsAfter(
  conversationId: string,
  afterMessageId: string | null,
  limit = 500,
): Promise<ConversationMessage[]> {
  const { rows } = await pool.query(
    `select * from conversation_messages
      where conversation_id = $1
        and ($2::uuid is null
             or created_at > (select created_at from conversation_messages where id = $2))
      order by created_at asc limit $3`,
    [conversationId, afterMessageId, limit],
  );
  return rows;
}
