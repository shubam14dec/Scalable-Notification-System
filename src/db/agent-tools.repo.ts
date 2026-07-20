/**
 * Data layer for Phase 18 agent tools: the per-agent custom tool registry
 * (agent_tool_defs) and the unified execution-log / approval-queue
 * (agent_tool_calls). Two invariants live HERE so every caller inherits them:
 *
 * 1. Content-keyed idempotency: recordToolCall() inserts on a UNIQUE
 *    dedupe_key with conflict-reuse — a retried worker job gets the ORIGINAL
 *    row (and its stored result) back instead of creating a duplicate and
 *    double-firing an HTTP side effect.
 * 2. Atomic state transitions: decide()/markExecuted()/markFailed() only move
 *    rows FROM the expected prior status, so concurrent deciders, sweep
 *    expiry, and job retries can never double-decide or double-execute —
 *    the loser of a race simply gets null back.
 */
import { pool } from './pool';

export interface AgentToolDef {
  id: string;
  tenant_id: string;
  agent_id: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpoint_url: string;
  secret: string; // sealed
  approval: 'auto' | 'required';
  status: 'active' | 'disabled';
  timeout_ms: number;
  /**
   * Phase 22 guardrails (null = no guards, today's behavior). maxAutoCalls +
   * windowDays arm the repeat-action rule (an auto tool flips to approval once
   * this subscriber's executed calls in the window hit the ceiling);
   * maxCallsPerHour arms the per-subscriber hourly rate cap.
   */
  guard: { maxAutoCalls?: number; windowDays?: number; maxCallsPerHour?: number } | null;
  created_at: string;
  updated_at: string;
}

/** A posted channel approval card, tracked so taps correlate and the card
 *  can be edited to the outcome. connectionId picks the bot token. */
export type ApprovalCardRef =
  | { channel: 'slack'; connectionId: string; channelId: string; ts: string }
  | { channel: 'telegram'; connectionId: string; chatId: string; messageId: number };

export interface AgentToolCall {
  id: string;
  tenant_id: string;
  agent_id: string;
  conversation_id: string;
  tool_def_id: string | null;
  tool_name: string;
  args: Record<string, unknown>;
  dedupe_key: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';
  result: string | null;
  note: string | null;
  decided_by: string | null;
  breadcrumb_message_id: string | null;
  cards: ApprovalCardRef[];
  /** Wall-clock ms of the signed tool POST (Phase 22 G4); null until executed. */
  duration_ms: number | null;
  requested_at: string;
  decided_at: string | null;
  expires_at: string | null;
}

/* ---------------- tool defs ---------------- */

export async function createToolDef(d: {
  tenantId: string;
  agentId: string;
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  endpointUrl: string;
  sealedSecret: string;
  approval: 'auto' | 'required';
  timeoutMs: number;
  guard?: { maxAutoCalls?: number; windowDays?: number; maxCallsPerHour?: number } | null;
}): Promise<AgentToolDef | null> {
  const { rows } = await pool.query(
    `insert into agent_tool_defs
       (tenant_id, agent_id, name, description, parameters, endpoint_url,
        secret, approval, timeout_ms, guard)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
     on conflict (agent_id, name) do nothing
     returning *`,
    [
      d.tenantId,
      d.agentId,
      d.name,
      d.description,
      JSON.stringify(d.parameters),
      d.endpointUrl,
      d.sealedSecret,
      d.approval,
      d.timeoutMs,
      d.guard ? JSON.stringify(d.guard) : null,
    ],
  );
  return rows[0] ?? null; // null = name already taken on this agent
}

export async function listToolDefs(
  tenantId: string,
  agentId: string,
  opts: { activeOnly?: boolean } = {},
): Promise<AgentToolDef[]> {
  const { rows } = await pool.query(
    `select * from agent_tool_defs
      where tenant_id = $1 and agent_id = $2
        ${opts.activeOnly ? "and status = 'active'" : ''}
      order by created_at asc`,
    [tenantId, agentId],
  );
  return rows;
}

export async function getToolDef(
  tenantId: string,
  toolId: string,
): Promise<AgentToolDef | null> {
  const { rows } = await pool.query(
    'select * from agent_tool_defs where tenant_id = $1 and id = $2',
    [tenantId, toolId],
  );
  return rows[0] ?? null;
}

/** Patch mutable fields (never name — it's the model-facing identity). */
export async function updateToolDef(
  tenantId: string,
  toolId: string,
  patch: {
    description?: string;
    parameters?: Record<string, unknown>;
    endpointUrl?: string;
    approval?: 'auto' | 'required';
    status?: 'active' | 'disabled';
    timeoutMs?: number;
    /** null clears the guard (jsonb 'null' sentinel); undefined leaves it. */
    guard?: { maxAutoCalls?: number; windowDays?: number; maxCallsPerHour?: number } | null;
  },
): Promise<AgentToolDef | null> {
  const { rows } = await pool.query(
    `update agent_tool_defs set
       description  = coalesce($3, description),
       parameters   = coalesce($4, parameters),
       endpoint_url = coalesce($5, endpoint_url),
       approval     = coalesce($6, approval),
       status       = coalesce($7, status),
       timeout_ms   = coalesce($8, timeout_ms),
       -- jsonb 'null' sentinel clears the guard; null param leaves it untouched
       guard        = case when $9::jsonb = 'null'::jsonb then null
                           else coalesce($9::jsonb, guard) end,
       updated_at   = now()
     where tenant_id = $1 and id = $2
     returning *`,
    [
      tenantId,
      toolId,
      patch.description ?? null,
      patch.parameters ? JSON.stringify(patch.parameters) : null,
      patch.endpointUrl ?? null,
      patch.approval ?? null,
      patch.status ?? null,
      patch.timeoutMs ?? null,
      patch.guard === null ? 'null' : patch.guard === undefined ? null : JSON.stringify(patch.guard),
    ],
  );
  return rows[0] ?? null;
}

export async function rotateToolSecret(
  tenantId: string,
  toolId: string,
  sealedSecret: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `update agent_tool_defs set secret = $3, updated_at = now()
      where tenant_id = $1 and id = $2`,
    [tenantId, toolId, sealedSecret],
  );
  return (rowCount ?? 0) > 0;
}

export async function deleteToolDef(tenantId: string, toolId: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'delete from agent_tool_defs where tenant_id = $1 and id = $2',
    [tenantId, toolId],
  );
  return (rowCount ?? 0) > 0;
}

/* ---------------- tool calls ---------------- */

/**
 * Record an invocation idempotently. Returns {call, fresh}: fresh=false means
 * the dedupe_key already existed (job retry) — reuse call.result / call.status
 * instead of executing again.
 */
export async function recordToolCall(c: {
  tenantId: string;
  agentId: string;
  conversationId: string;
  toolDefId: string;
  toolName: string;
  args: Record<string, unknown>;
  dedupeKey: string;
  status: 'pending' | 'approved';
  expiresAt?: Date;
}): Promise<{ call: AgentToolCall; fresh: boolean }> {
  const { rows } = await pool.query(
    `insert into agent_tool_calls
       (tenant_id, agent_id, conversation_id, tool_def_id, tool_name, args,
        dedupe_key, status, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (dedupe_key) do nothing
     returning *`,
    [
      c.tenantId,
      c.agentId,
      c.conversationId,
      c.toolDefId,
      c.toolName,
      JSON.stringify(c.args),
      c.dedupeKey,
      c.status,
      c.expiresAt ?? null,
    ],
  );
  if (rows[0]) return { call: rows[0], fresh: true };
  const existing = await pool.query('select * from agent_tool_calls where dedupe_key = $1', [
    c.dedupeKey,
  ]);
  return { call: existing.rows[0], fresh: false };
}

export async function getToolCall(
  tenantId: string,
  callId: string,
): Promise<AgentToolCall | null> {
  const { rows } = await pool.query(
    'select * from agent_tool_calls where tenant_id = $1 and id = $2',
    [tenantId, callId],
  );
  return rows[0] ?? null;
}

export async function listToolCalls(
  tenantId: string,
  opts: { status: 'pending' | 'decided'; limit?: number },
): Promise<AgentToolCall[]> {
  const where =
    opts.status === 'pending' ? "status = 'pending'" : "status <> 'pending'";
  const { rows } = await pool.query(
    `select * from agent_tool_calls
      where tenant_id = $1 and ${where}
      order by requested_at desc
      limit $2`,
    [tenantId, Math.min(opts.limit ?? 100, 100)],
  );
  return rows;
}

/**
 * Atomic decision: pending → approved|denied. Null = lost the race (already
 * decided or expired) — surface a 409.
 */
export async function decideToolCall(
  tenantId: string,
  callId: string,
  decision: 'approved' | 'denied',
  decidedBy: string,
  note?: string,
): Promise<AgentToolCall | null> {
  const { rows } = await pool.query(
    `update agent_tool_calls
        set status = $3, decided_by = $4, note = $5, decided_at = now()
      where tenant_id = $1 and id = $2 and status = 'pending'
      returning *`,
    [tenantId, callId, decision, decidedBy, note ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Atomic execution claim: approved → executed|failed with the result stored.
 * fromStatus guards the transition; null = someone else already moved it
 * (retry after a completed execution → reuse the stored row via getToolCall).
 */
export async function finishToolCall(
  callId: string,
  outcome: 'executed' | 'failed',
  result: string,
  fromStatus: 'approved' | 'pending' = 'approved',
  durationMs?: number,
): Promise<AgentToolCall | null> {
  const { rows } = await pool.query(
    `update agent_tool_calls set status = $2, result = $3,
            duration_ms = coalesce($5, duration_ms)
      where id = $1 and status = $4
      returning *`,
    [callId, outcome, result, fromStatus, durationMs ?? null],
  );
  return rows[0] ?? null;
}

/**
 * Store the guard-history note on a freshly-paused call (Phase 22 G1). Written
 * only when the repeat-action rule flips an auto tool to the approval path, so
 * the dashboard's pending entry and channel cards can show why it paused. A
 * later human decision overwrites `note` with the approver's own — by then the
 * history is on the card and no longer pending, so nothing is lost.
 */
export async function setToolCallNote(callId: string, note: string): Promise<void> {
  await pool.query('update agent_tool_calls set note = $2 where id = $1', [callId, note]);
}

/**
 * Repeat-action count (Phase 22 G1): how many times this tool has EXECUTED for
 * one subscriber inside the window, plus the up-to-3 most recent execution
 * dates for the approval card's history line. One set-based query over the
 * `agent_tool_calls_guard_idx` partial index (status='executed'), joined to
 * conversations to scope by subscriber; `count(*) over ()` returns the full
 * window total alongside the 3 rows in a single round-trip. Rare path — only an
 * auto tool that opted into a repeat guard reaches here.
 */
export async function countExecutedCalls(
  toolDefId: string,
  subscriberId: string,
  windowDays: number,
): Promise<{ count: number; recent: string[] }> {
  const { rows } = await pool.query<{ requested_at: string; total: string }>(
    `select ac.requested_at, count(*) over () as total
       from agent_tool_calls ac
       join conversations c on c.id = ac.conversation_id
      where ac.tool_def_id = $1
        and ac.status = 'executed'
        and c.subscriber_id = $2
        and ac.requested_at >= now() - make_interval(days => $3)
      order by ac.requested_at desc
      limit 3`,
    [toolDefId, subscriberId, windowDays],
  );
  if (rows.length === 0) return { count: 0, recent: [] };
  return { count: Number(rows[0].total), recent: rows.map((r) => r.requested_at) };
}

/** Record the channel approval cards posted for a call (one write, once). */
export async function setToolCallCards(
  callId: string,
  cards: ApprovalCardRef[],
): Promise<void> {
  await pool.query('update agent_tool_calls set cards = $2 where id = $1', [
    callId,
    JSON.stringify(cards),
  ]);
}

export async function setToolCallBreadcrumb(
  callId: string,
  messageId: string,
): Promise<void> {
  await pool.query('update agent_tool_calls set breadcrumb_message_id = $2 where id = $1', [
    callId,
    messageId,
  ]);
}

/**
 * Sweep: expire pending calls past their deadline, set-based. Returns the
 * expired rows so the caller can enqueue one tool-decision job each (batch
 * capped by the sweep's own budget).
 */
export async function expirePendingToolCalls(limit = 500): Promise<AgentToolCall[]> {
  const { rows } = await pool.query(
    `update agent_tool_calls set status = 'expired', decided_at = now(),
            decided_by = 'system:expiry'
      where id in (
        select id from agent_tool_calls
         where status = 'pending' and expires_at is not null and expires_at < now()
         limit $1
      )
      returning *`,
    [limit],
  );
  return rows;
}
