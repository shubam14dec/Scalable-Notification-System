import { pool } from './pool';

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
  auto_resolve_hours: number | null; // idle-timeout backstop (null = off)
  status: 'active' | 'disabled';
  created_at: string;
  updated_at: string;
}

export interface Conversation {
  id: string;
  tenant_id: string;
  agent_id: string;
  subscriber_id: string;
  channel: string;
  thread_key: string;
  status: 'active' | 'resolved';
  metadata: Record<string, unknown>;
  summary: string | null;
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
  autoResolveHours?: number;
}): Promise<Agent | null> {
  const { rows } = await pool.query(
    `insert into agents
       (tenant_id, identifier, name, description, runtime, bridge_url,
        signing_secret, model, system_prompt, llm_base_url, llm_credentials, max_tokens,
        auto_resolve_hours)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
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
      a.autoResolveHours ?? null,
    ],
  );
  return rows[0] ?? null;
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
    model?: string;
    systemPrompt?: string;
    llmBaseUrl?: string | null;
    sealedLlmCredentials?: string;
    maxTokens?: number;
    /** null switches the backstop OFF (0 is the wire sentinel for null). */
    autoResolveHours?: number | null;
  },
): Promise<Agent | null> {
  const { rows } = await pool.query(
    `update agents set
       name            = coalesce($3, name),
       description     = coalesce($4, description),
       runtime         = coalesce($5, runtime),
       bridge_url      = coalesce($6, bridge_url),
       status          = coalesce($7, status),
       model           = coalesce($8, model),
       system_prompt   = coalesce($9, system_prompt),
       -- '' sentinel clears the base URL (back to api.anthropic.com)
       llm_base_url    = case when $10::text = '' then null else coalesce($10, llm_base_url) end,
       llm_credentials = coalesce($11, llm_credentials),
       max_tokens      = coalesce($12, max_tokens),
       -- 0 sentinel clears the idle timeout (bounds are 1-720)
       auto_resolve_hours = case when $13::int = 0 then null
                                 else coalesce($13, auto_resolve_hours) end,
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
      patch.model ?? null,
      patch.systemPrompt ?? null,
      patch.llmBaseUrl === null ? '' : (patch.llmBaseUrl ?? null),
      patch.sealedLlmCredentials ?? null,
      patch.maxTokens ?? null,
      patch.autoResolveHours === null ? 0 : (patch.autoResolveHours ?? null),
    ],
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

/** Connect (or re-connect) a channel: one connection per (agent, channel). */
export async function upsertConnection(c: {
  tenantId: string;
  agentId: string;
  channel: string;
  sealedCredentials: string;
  config: Record<string, unknown>;
}): Promise<AgentConnection> {
  const { rows } = await pool.query(
    `insert into agent_connections (tenant_id, agent_id, channel, credentials, config)
     values ($1, $2, $3, $4, $5)
     on conflict (agent_id, channel) do update set
       credentials = excluded.credentials,
       config      = excluded.config,
       status      = 'active',
       updated_at  = now()
     returning *`,
    [c.tenantId, c.agentId, c.channel, c.sealedCredentials, JSON.stringify(c.config)],
  );
  return rows[0];
}

export async function getConnectionById(id: string): Promise<AgentConnection | null> {
  const { rows } = await pool.query('select * from agent_connections where id = $1', [id]);
  return rows[0] ?? null;
}

export async function getConnectionForAgent(
  agentId: string,
  channel: string,
): Promise<AgentConnection | null> {
  const { rows } = await pool.query(
    'select * from agent_connections where agent_id = $1 and channel = $2',
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

export async function deleteConnection(agentId: string, channel: string): Promise<number> {
  const { rowCount } = await pool.query(
    'delete from agent_connections where agent_id = $1 and channel = $2',
    [agentId, channel],
  );
  return rowCount ?? 0;
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
     on conflict (agent_id, channel, thread_key) do update set
       status = 'active',
       last_message_at = now()
     returning *`,
    [c.tenantId, c.agentId, c.subscriberId, c.channel, c.threadKey],
  );
  return rows[0];
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

export async function resolveConversation(
  conversationId: string,
  summary?: string,
): Promise<void> {
  await pool.query(
    `update conversations set status = 'resolved', summary = coalesce($2, summary)
     where id = $1`,
    [conversationId, summary ?? null],
  );
}

export interface SweptConversation {
  id: string;
  tenant_id: string;
  channel: string;
  auto_resolve_hours: number;
  agent_identifier: string;
  agent_name: string;
  subscriber_external_id: string;
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
       select c.id, a.auto_resolve_hours, a.identifier as agent_identifier,
              a.name as agent_name
         from conversations c
         join agents a on a.id = c.agent_id
        where c.status = 'active'
          and a.auto_resolve_hours is not null
          and c.last_message_at < now() - make_interval(hours => a.auto_resolve_hours)
        order by c.last_message_at
        limit $1
        for update of c skip locked
     ),
     resolved as (
       update conversations c
          set status = 'resolved',
              summary = 'auto-resolved after ' || s.auto_resolve_hours ||
                        ' hours of inactivity',
              message_count = c.message_count + 1
         from stale s
        where c.id = s.id
        returning c.id, c.tenant_id, c.channel, c.subscriber_id, c.last_message_at,
                  s.auto_resolve_hours, s.agent_identifier, s.agent_name
     ),
     crumbs as (
       insert into conversation_messages
         (conversation_id, tenant_id, role, content, dedupe_key)
       select r.id, r.tenant_id, 'system',
              'auto-resolved after ' || r.auto_resolve_hours || ' hours of inactivity',
              'autoresolve-' || r.id || '-' ||
                extract(epoch from r.last_message_at)::bigint
         from resolved r
       on conflict (conversation_id, dedupe_key) do nothing
     )
     select r.id, r.tenant_id, r.channel, r.auto_resolve_hours,
            r.agent_identifier, r.agent_name,
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

/** The reply row a telegram inline-keyboard click was attached to. */
export async function findMessageByTelegramId(
  conversationId: string,
  telegramMessageId: number,
): Promise<ConversationMessage | null> {
  const { rows } = await pool.query(
    `select * from conversation_messages
     where conversation_id = $1 and raw->>'telegramMessageId' = $2
     limit 1`,
    [conversationId, String(telegramMessageId)],
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

/** The user/agent turns before (and excluding) the message being dispatched. */
export async function conversationHistoryBefore(
  conversationId: string,
  beforeMessageId: string,
  limit = 30,
): Promise<ConversationMessage[]> {
  const { rows } = await pool.query(
    `select * from (
       select m.* from conversation_messages m
       where m.conversation_id = $1
         and m.role in ('user', 'agent')
         and m.created_at < (select created_at from conversation_messages where id = $2)
       order by m.created_at desc limit $3
     ) t order by created_at asc`,
    [conversationId, beforeMessageId, limit],
  );
  return rows;
}

/**
 * Like conversationHistoryBefore but INCLUDING system rows (tool-action
 * breadcrumbs). The managed brain folds these back into the history it
 * replays to the model — without them, past tool-backed replies look like
 * bare claims, and the model learns to imitate claiming instead of calling.
 */
export async function conversationTranscriptBefore(
  conversationId: string,
  beforeMessageId: string,
  limit = 40,
): Promise<ConversationMessage[]> {
  const { rows } = await pool.query(
    `select * from (
       select m.* from conversation_messages m
       where m.conversation_id = $1
         and m.created_at < (select created_at from conversation_messages where id = $2)
       order by m.created_at desc limit $3
     ) t order by created_at asc`,
    [conversationId, beforeMessageId, limit],
  );
  return rows;
}
