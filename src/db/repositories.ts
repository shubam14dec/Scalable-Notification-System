import { pool } from './pool';
import type { Channel, Priority } from '../shared/queues';

export interface Tenant {
  id: string;
  name: string;
  api_key: string;
  rate_limit_per_sec: number;
}

export interface Subscriber {
  id: string;
  tenant_id: string;
  external_id: string;
  email: string | null;
  phone: string | null;
  push_token: string | null;
  preferences: { channels?: Partial<Record<Channel, boolean>> };
}

export interface WorkflowStep {
  channel: Channel;
  subject?: string;
  body: string;
  delaySeconds?: number;
  /**
   * Digest: instead of sending immediately, open a collection window per
   * subscriber; every further event in the window merges into it, and one
   * combined message goes out when the window closes. Templates can use
   * {{digest_count}} and {{digest_items}} (items rendered via itemTemplate).
   */
  digest?: { windowSeconds: number; itemTemplate?: string };
}

export interface Workflow {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  steps: WorkflowStep[];
}

export interface EventRow {
  id: string;
  tenant_id: string;
  transaction_id: string;
  workflow_key: string;
  priority: Priority;
  payload: Record<string, unknown>;
  recipients: RecipientInput[];
  is_broadcast: boolean;
  status: string;
}

export interface RecipientInput {
  subscriberId: string;
  email?: string;
  phone?: string;
  pushToken?: string;
}

export interface MessageRow {
  id: string;
  tenant_id: string;
  event_id: string;
  subscriber_id: string;
  transaction_id: string;
  channel: Channel;
  step_index: number;
  priority: Priority;
  content: {
    subject?: string;
    body: string;
    to: Record<string, string>;
    digest?: {
      subjectTemplate?: string;
      bodyTemplate: string;
      itemTemplate?: string;
      vars: Record<string, unknown>;
    };
  };
  provider: string | null;
  provider_message_id: string | null;
  status: string;
  attempts: number;
}

// ---------- tenants ----------

/**
 * Resolve an API key to its environment. New keys are looked up by SHA-256
 * hash in api_keys (rotatable, revocable); the legacy plaintext column is a
 * fallback for pre-accounts installs.
 */
export async function getTenantByApiKey(apiKey: string): Promise<Tenant | null> {
  const { tenantForApiKeyHash } = await import('./accounts.repo');
  const byHash = await tenantForApiKeyHash(apiKey);
  if (byHash) return byHash;
  const { rows } = await pool.query('select * from tenants where api_key = $1', [apiKey]);
  return rows[0] ?? null;
}

export async function getTenantById(id: string): Promise<Tenant | null> {
  const { rows } = await pool.query('select * from tenants where id = $1', [id]);
  return rows[0] ?? null;
}

// ---------- subscribers ----------

export async function upsertSubscriber(
  tenantId: string,
  r: RecipientInput,
): Promise<Subscriber> {
  const { rows } = await pool.query(
    `insert into subscribers (tenant_id, external_id, email, phone, push_token)
     values ($1, $2, $3, $4, $5)
     on conflict (tenant_id, external_id) do update set
       email      = coalesce(excluded.email, subscribers.email),
       phone      = coalesce(excluded.phone, subscribers.phone),
       push_token = coalesce(excluded.push_token, subscribers.push_token),
       updated_at = now()
     returning *`,
    [tenantId, r.subscriberId, r.email ?? null, r.phone ?? null, r.pushToken ?? null],
  );
  return rows[0];
}

// ---------- workflows ----------

export async function getWorkflow(tenantId: string, key: string): Promise<Workflow | null> {
  const { rows } = await pool.query(
    'select * from workflows where tenant_id = $1 and key = $2',
    [tenantId, key],
  );
  return rows[0] ?? null;
}

export async function upsertWorkflow(
  tenantId: string,
  key: string,
  name: string,
  steps: WorkflowStep[],
): Promise<Workflow> {
  const { rows } = await pool.query(
    `insert into workflows (tenant_id, key, name, steps)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, key) do update set
       name = excluded.name, steps = excluded.steps, updated_at = now()
     returning *`,
    [tenantId, key, name, JSON.stringify(steps)],
  );
  return rows[0];
}

// ---------- events ----------

export async function insertEvent(e: {
  tenantId: string;
  transactionId: string;
  workflowKey: string;
  priority: Priority;
  payload: Record<string, unknown>;
  recipients: RecipientInput[];
  isBroadcast?: boolean;
}): Promise<EventRow | null> {
  const { rows } = await pool.query(
    `insert into events
       (tenant_id, transaction_id, workflow_key, priority, payload, recipients, recipient_count, is_broadcast)
     values ($1, $2, $3, $4, $5, $6, $7, $8)
     on conflict (tenant_id, transaction_id) do nothing
     returning *`,
    [
      e.tenantId,
      e.transactionId,
      e.workflowKey,
      e.priority,
      JSON.stringify(e.payload),
      JSON.stringify(e.recipients),
      e.recipients.length,
      e.isBroadcast ?? false,
    ],
  );
  return rows[0] ?? null;
}

export async function setEventRecipientCount(id: string, count: number): Promise<void> {
  await pool.query('update events set recipient_count = $2 where id = $1', [id, count]);
}

/** Keyset pagination over a tenant's subscribers (broadcast fan-out). */
export async function pageSubscribers(
  tenantId: string,
  afterId: string | null,
  limit: number,
): Promise<Subscriber[]> {
  const { rows } = await pool.query(
    `select * from subscribers
     where tenant_id = $1 and ($2::uuid is null or id > $2)
     order by id
     limit $3`,
    [tenantId, afterId, limit],
  );
  return rows;
}

export async function getEvent(id: string): Promise<EventRow | null> {
  const { rows } = await pool.query('select * from events where id = $1', [id]);
  return rows[0] ?? null;
}

export async function getEventByTransaction(
  tenantId: string,
  transactionId: string,
): Promise<EventRow | null> {
  const { rows } = await pool.query(
    'select * from events where tenant_id = $1 and transaction_id = $2',
    [tenantId, transactionId],
  );
  return rows[0] ?? null;
}

export async function setEventStatus(id: string, status: string): Promise<void> {
  await pool.query('update events set status = $2 where id = $1', [id, status]);
}

// ---------- messages ----------

export async function insertMessage(m: {
  tenantId: string;
  eventId: string;
  subscriberId: string;
  transactionId: string;
  channel: Channel;
  stepIndex: number;
  priority: Priority;
  content: MessageRow['content'];
  status?: string;
  error?: string;
}): Promise<MessageRow> {
  // Idempotent: a retried fan-out job returns the existing row instead of
  // inserting a duplicate (unique on event/subscriber/channel/step).
  const { rows } = await pool.query(
    `insert into messages
       (tenant_id, event_id, subscriber_id, transaction_id, channel, step_index, priority, content, status, error)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (event_id, subscriber_id, channel, step_index)
       do update set updated_at = now()
     returning *`,
    [
      m.tenantId,
      m.eventId,
      m.subscriberId,
      m.transactionId,
      m.channel,
      m.stepIndex,
      m.priority,
      JSON.stringify(m.content),
      m.status ?? 'queued',
      m.error ?? null,
    ],
  );
  return rows[0];
}

export interface NewMessage {
  tenantId: string;
  eventId: string;
  subscriberId: string;
  transactionId: string;
  channel: Channel;
  stepIndex: number;
  priority: Priority;
  content: MessageRow['content'];
  status: string;
  error: string | null;
}

/**
 * Multi-row insert for fan-out (one round trip per ~500 messages instead of
 * one per message — the difference between minutes and hours at broadcast
 * scale). Same idempotent conflict handling as insertMessage: retried
 * batches get the existing rows back instead of duplicating.
 */
export async function insertMessagesBulk(messages: NewMessage[]): Promise<MessageRow[]> {
  const out: MessageRow[] = [];
  const CHUNK = 500;
  for (let i = 0; i < messages.length; i += CHUNK) {
    const chunk = messages.slice(i, i + CHUNK);
    const values: unknown[] = [];
    const tuples = chunk.map((m, j) => {
      const b = j * 10;
      values.push(
        m.tenantId,
        m.eventId,
        m.subscriberId,
        m.transactionId,
        m.channel,
        m.stepIndex,
        m.priority,
        JSON.stringify(m.content),
        m.status,
        m.error,
      );
      return `($${b + 1}, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7}, $${b + 8}, $${b + 9}, $${b + 10})`;
    });
    const { rows } = await pool.query(
      `insert into messages
         (tenant_id, event_id, subscriber_id, transaction_id, channel, step_index, priority, content, status, error)
       values ${tuples.join(', ')}
       on conflict (event_id, subscriber_id, channel, step_index)
         do update set updated_at = now()
       returning *`,
      values,
    );
    out.push(...rows);
  }
  return out;
}

export async function getMessage(id: string): Promise<MessageRow | null> {
  const { rows } = await pool.query('select * from messages where id = $1', [id]);
  return rows[0] ?? null;
}

export async function updateMessage(
  id: string,
  fields: {
    status?: string;
    provider?: string;
    providerMessageId?: string;
    error?: string | null;
    attempts?: number;
  },
): Promise<void> {
  await pool.query(
    `update messages set
       status              = coalesce($2, status),
       provider            = coalesce($3, provider),
       provider_message_id = coalesce($4, provider_message_id),
       error               = $5,
       attempts            = coalesce($6, attempts),
       updated_at          = now()
     where id = $1`,
    [
      id,
      fields.status ?? null,
      fields.provider ?? null,
      fields.providerMessageId ?? null,
      fields.error ?? null,
      fields.attempts ?? null,
    ],
  );
}

export async function updateMessageByProviderId(
  providerMessageId: string,
  status: string,
): Promise<MessageRow | null> {
  const { rows } = await pool.query(
    `update messages set status = $2, updated_at = now()
     where provider_message_id = $1
     returning *`,
    [providerMessageId, status],
  );
  return rows[0] ?? null;
}

export async function messagesByTransaction(
  tenantId: string,
  transactionId: string,
): Promise<MessageRow[]> {
  const { rows } = await pool.query(
    `select * from messages
     where tenant_id = $1 and transaction_id = $2
     order by created_at`,
    [tenantId, transactionId],
  );
  return rows;
}

// ---------- suppressions (bounce/complaint list) ----------

export async function addSuppression(
  tenantId: string,
  channel: Channel,
  address: string,
  reason: string,
): Promise<void> {
  await pool.query(
    `insert into suppressions (tenant_id, channel, address, reason)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, channel, address) do nothing`,
    [tenantId, channel, address, reason],
  );
}

export async function isSuppressed(
  tenantId: string,
  channel: Channel,
  address: string,
): Promise<boolean> {
  const { rows } = await pool.query(
    'select 1 from suppressions where tenant_id = $1 and channel = $2 and address = $3',
    [tenantId, channel, address],
  );
  return rows.length > 0;
}

/**
 * Batch suppression lookup: one query per fan-out batch instead of one per
 * recipient x step. Returns a Set of "channel\naddress" keys.
 */
export async function suppressedSet(
  tenantId: string,
  pairs: Array<{ channel: string; address: string }>,
): Promise<Set<string>> {
  if (pairs.length === 0) return new Set();
  const { rows } = await pool.query(
    `select channel, address from suppressions
     where tenant_id = $1
       and (channel, address) in (select * from unnest($2::text[], $3::text[]))`,
    [tenantId, pairs.map((p) => p.channel), pairs.map((p) => p.address)],
  );
  return new Set(rows.map((r: { channel: string; address: string }) => `${r.channel}\n${r.address}`));
}

export async function listSuppressions(tenantId: string, channel?: string) {
  const { rows } = await pool.query(
    `select channel, address, reason, created_at from suppressions
     where tenant_id = $1 and ($2::text is null or channel = $2)
     order by created_at desc limit 500`,
    [tenantId, channel ?? null],
  );
  return rows;
}

export async function removeSuppression(
  tenantId: string,
  channel: string,
  address: string,
): Promise<number> {
  const { rowCount } = await pool.query(
    'delete from suppressions where tenant_id = $1 and channel = $2 and address = $3',
    [tenantId, channel, address],
  );
  return rowCount ?? 0;
}

// ---------- in-app inbox ----------

export interface InboxMessage {
  id: string;
  subject: string | null;
  body: string;
  status: string;
  read_at: string | null;
  created_at: string;
}

export async function inboxForSubscriber(
  tenantId: string,
  subscriberExternalId: string,
  limit = 50,
): Promise<InboxMessage[]> {
  const { rows } = await pool.query(
    `select m.id,
            m.content->>'subject' as subject,
            m.content->>'body'    as body,
            m.status, m.read_at, m.created_at
     from messages m
     join subscribers s on s.id = m.subscriber_id
     where m.tenant_id = $1
       and s.external_id = $2
       and m.channel = 'inapp'
       and m.status in ('sent', 'delivered')
     order by m.created_at desc
     limit $3`,
    [tenantId, subscriberExternalId, limit],
  );
  return rows;
}

export async function unreadCount(
  tenantId: string,
  subscriberExternalId: string,
): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as n
     from messages m
     join subscribers s on s.id = m.subscriber_id
     where m.tenant_id = $1
       and s.external_id = $2
       and m.channel = 'inapp'
       and m.status in ('sent', 'delivered')
       and m.read_at is null`,
    [tenantId, subscriberExternalId],
  );
  return rows[0]?.n ?? 0;
}

/** Mark specific messages read, or all unread when messageIds is null. */
export async function markInboxRead(
  tenantId: string,
  subscriberExternalId: string,
  messageIds: string[] | null,
): Promise<number> {
  const { rowCount } = await pool.query(
    `update messages m set read_at = now(), updated_at = now()
     from subscribers s
     where s.id = m.subscriber_id
       and m.tenant_id = $1
       and s.external_id = $2
       and m.channel = 'inapp'
       and m.read_at is null
       and ($3::uuid[] is null or m.id = any($3::uuid[]))`,
    [tenantId, subscriberExternalId, messageIds],
  );
  return rowCount ?? 0;
}

// ---------- dashboard reads ----------

export async function recentActivity(tenantId: string, limit = 50) {
  const { rows } = await pool.query(
    `select m.id, m.transaction_id, m.channel, m.status, m.priority, m.provider,
            m.error, m.created_at, m.updated_at,
            s.external_id as subscriber_id,
            e.workflow_key
     from messages m
     join subscribers s on s.id = m.subscriber_id
     join events e on e.id = m.event_id
     where m.tenant_id = $1
     order by m.created_at desc
     limit $2`,
    [tenantId, limit],
  );
  return rows;
}

export async function listWorkflows(tenantId: string) {
  const { rows } = await pool.query(
    `select id, key, name, steps, updated_at from workflows
     where tenant_id = $1 order by updated_at desc`,
    [tenantId],
  );
  return rows;
}

export async function listSubscribers(tenantId: string, limit = 100, search?: string) {
  const { rows } = await pool.query(
    `select external_id, email, phone, push_token is not null as has_push, created_at
     from subscribers
     where tenant_id = $1
       and ($3::text is null or external_id ilike '%' || $3 || '%' or email ilike '%' || $3 || '%')
     order by created_at desc
     limit $2`,
    [tenantId, limit, search ?? null],
  );
  return rows;
}

// ---------- execution logs (batch insert only) ----------

export interface ExecLogEntry {
  tenantId?: string;
  transactionId?: string;
  messageId?: string;
  level: 'info' | 'warn' | 'error';
  detail: string;
  raw?: unknown;
  /** ISO timestamp stamped at emit time (buffered entries keep their real time). */
  at?: string;
}

export async function insertExecutionLogs(entries: ExecLogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const values: unknown[] = [];
  const tuples = entries.map((e, i) => {
    const base = i * 6;
    values.push(
      e.tenantId ?? null,
      e.transactionId ?? null,
      e.messageId ?? null,
      e.level,
      e.detail,
      e.raw === undefined ? null : JSON.stringify(e.raw),
    );
    return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6})`;
  });
  await pool.query(
    `insert into execution_logs (tenant_id, transaction_id, message_id, level, detail, raw)
     values ${tuples.join(', ')}`,
    values,
  );
}
