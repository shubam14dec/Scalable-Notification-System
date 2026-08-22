import { pool } from './pool';
import { emitTenantEvent } from '../core/tenant-events';

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
}): Promise<Agent | null> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const { rows } = await client.query(
      `insert into agents
       (tenant_id, identifier, name, description, runtime, bridge_url,
        signing_secret, model, system_prompt, llm_base_url, llm_credentials, max_tokens,
        auto_resolve_minutes, welcome_message, suggested_prompts, max_daily_tokens, context)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16,
             coalesce($17::jsonb, '{}'::jsonb))
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
export async function openConversation(c: {
  tenantId: string;
  agentId: string;
  subscriberId: string; // subscribers.id (uuid)
  channel: string;
  threadKey: string;
}): Promise<Conversation> {
  const { rows } = await pool.query(
    `insert into conversations (tenant_id, agent_id, subscriber_id, channel, thread_key)
     values ($1, $2, $3, $4, $5)
     on conflict (agent_id, channel, thread_key) where connection_id is null do update set
       -- Reopen a RESOLVED thread (the user came back), but NEVER force a
       -- waiting_human/human thread back to active (Phase 26 D1/D11): a customer
       -- message while a human owns the pen must not steal it back — the D2 gate
       -- relies on this find not flipping the status out from under it.
       status = case when conversations.status = 'resolved' then 'active' else conversations.status end,
       last_message_at = now()
     returning *`,
    [c.tenantId, c.agentId, c.subscriberId, c.channel, c.threadKey],
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
       (tenant_id, agent_id, connection_id, subscriber_id, channel, thread_key)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (connection_id, thread_key) where connection_id is not null do update set
       -- Reopen a RESOLVED thread only; keep a waiting_human/human thread in its
       -- human state so a customer message can't steal the pen back (Phase 26 D1/D11).
       status = case when conversations.status = 'resolved' then 'active' else conversations.status end,
       last_message_at = now(),
       agent_id = excluded.agent_id
     returning *`,
    [c.tenantId, c.agentId, c.connectionId, c.subscriberId, c.channel, c.threadKey],
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
