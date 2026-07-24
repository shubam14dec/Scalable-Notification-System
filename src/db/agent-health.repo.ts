import { pool } from './pool';

/**
 * Agent observability aggregates (Phase 21). Everything here is SET-BASED —
 * two grouped queries over indexed columns, never a per-turn or per-tool loop
 * (the 10-20M rule): the window is a single interval predicate, the tallies are
 * count(*) FILTER, and turn latency comes straight from percentile_cont over the
 * traces stored on each row. A dashboard poll costs two index-range scans.
 */

/**
 * One tool's slice of the window. avgMs is the mean of agent_tool_calls
 * .duration_ms (the executor-measured signed-POST wall-clock, Phase 22 G4)
 * over executed calls in the window; null when no call in the window carries a
 * duration (e.g. only pending/denied rows, or pre-G4 history).
 */
export interface AgentToolStat {
  name: string;
  calls: number;
  failures: number;
  avgMs: number | null;
}

/** The health window, minus windowDays (the route echoes that back). */
export interface AgentHealth {
  turns: number;
  replies: number;
  notes: number;
  /**
   * Turn latency in ms from raw.trace.totalMs; null when no traced turns fell
   * in the window (untraced turns still count toward `turns`).
   */
  avgMs: number | null;
  p95Ms: number | null;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  toolCalls: number;
  toolFailures: number;
  tools: AgentToolStat[];
  /**
   * Phase 24 D10 budget intelligence. p95DailyTokens is the 95th percentile of
   * per-day token spend (input+output over reply rows) across the last 30 days;
   * suggestedDailyTokens is that p95 x 3 rounded UP to the nearest 50,000 — a
   * headroom-padded daily budget the dashboard shows as a hint (never
   * auto-applied). suggestedDailyTokens is null when fewer than 7 distinct days
   * of data exist (no suggestion from noise); both are null when the agent has
   * no usage in the 30-day window. This window is FIXED at 30 days regardless of
   * the health `windowDays`, so the figure always matches the "30-day" hint.
   */
  suggestedDailyTokens: number | null;
  p95DailyTokens: number | null;
}

/** node-pg hands numeric/avg back as text; float8 as number. Normalize both. */
function num(v: unknown): number | null {
  return v == null ? null : Number(v);
}

/**
 * Rolling-window health for one agent, scoped to its tenant. A "turn" is an
 * agent/system row that carries a `usage` object — managed turns always stamp
 * usage, and a turn that ended in a refusal/limit/paused NOTE stamps it on the
 * system row, so `raw ? 'usage'` is the honest marker of "a turn happened
 * here". Latency + token means read the trace/usage on those same rows; rows
 * without a trace fall out of the latency aggregates but still count as turns.
 */
export async function agentHealth(
  tenantId: string,
  agentId: string,
  windowDays: number,
): Promise<AgentHealth> {
  const turns = await pool.query(
    `select
       count(*)::int                                                          as turns,
       count(*) filter (where m.role = 'agent' and m.deleted_at is null)::int as replies,
       count(*) filter (where m.role = 'system')::int                         as notes,
       avg((m.raw->'trace'->>'totalMs')::numeric)                             as avg_ms,
       percentile_cont(0.95) within group (order by (m.raw->'trace'->>'totalMs')::numeric)
         filter (where m.raw ? 'trace')                                       as p95_ms,
       avg((m.raw->'usage'->>'inputTokens')::numeric)                         as avg_input_tokens,
       avg((m.raw->'usage'->>'outputTokens')::numeric)                        as avg_output_tokens
     from conversation_messages m
     join conversations c on c.id = m.conversation_id
     where c.tenant_id = $1
       and c.agent_id = $2
       and m.created_at >= now() - make_interval(days => $3)
       and m.role in ('agent', 'system')
       and m.raw ? 'usage'`,
    [tenantId, agentId, windowDays],
  );

  const toolRows = await pool.query(
    `select m.tool_name                                       as name,
            count(*)::int                                     as calls,
            count(*) filter (where m.status = 'failed')::int  as failures,
            avg(m.duration_ms)                                as avg_ms
       from agent_tool_calls m
      where m.tenant_id = $1
        and m.agent_id = $2
        and m.requested_at >= now() - make_interval(days => $3)
      group by m.tool_name
      order by count(*) desc, m.tool_name`,
    [tenantId, agentId, windowDays],
  );

  // D10 budget suggestion: 30-day per-day token spend, then the 95th percentile
  // of those daily sums. ONE set-based query (the 10-20M rule — cost scales with
  // matches, not users): a CTE buckets reply-row usage into UTC days (matching
  // the day-token budget counter's UTC boundary), the outer aggregate takes the
  // distinct-day count + percentile_cont(0.95) over them. Fixed 30-day window,
  // independent of `windowDays`, so the suggestion is always the documented
  // 30-day figure. Reply rows only (role='agent') per the D10 contract.
  const budget = await pool.query(
    `with daily as (
       select date_trunc('day', m.created_at) as day,
              sum(coalesce((m.raw->'usage'->>'inputTokens')::numeric, 0)
                + coalesce((m.raw->'usage'->>'outputTokens')::numeric, 0)) as tokens
         from conversation_messages m
         join conversations c on c.id = m.conversation_id
        where c.tenant_id = $1
          and c.agent_id = $2
          and m.created_at >= now() - make_interval(days => 30)
          and m.role = 'agent'
          and m.raw ? 'usage'
        group by 1
     )
     select count(*)::int as days,
            percentile_cont(0.95) within group (order by tokens) as p95
       from daily`,
    [tenantId, agentId],
  );
  const b = budget.rows[0] as { days: number; p95: string | null };
  const p95Daily = num(b.p95);
  // <7 distinct days -> no suggestion from noise (D10). p95 x 3, rounded UP to
  // the nearest 50k so the number reads as a deliberate budget.
  const suggestedDailyTokens =
    b.days < 7 || p95Daily === null
      ? null
      : Math.ceil((p95Daily * 3) / 50_000) * 50_000;
  const p95DailyTokens = p95Daily === null ? null : Math.round(p95Daily);

  const t = turns.rows[0] as {
    turns: number;
    replies: number;
    notes: number;
    avg_ms: string | null;
    p95_ms: number | null;
    avg_input_tokens: string | null;
    avg_output_tokens: string | null;
  };

  const tools: AgentToolStat[] = toolRows.rows.map(
    (r: { name: string; calls: number; failures: number; avg_ms: string | null }) => {
      const avg = num(r.avg_ms);
      return {
        name: r.name,
        calls: r.calls,
        failures: r.failures,
        avgMs: avg === null ? null : Math.round(avg),
      };
    },
  );
  // Totals summed from the grouped rows (bounded by the distinct-tool count) —
  // no second scan of agent_tool_calls just to re-count what we already grouped.
  const toolCalls = tools.reduce((s, x) => s + x.calls, 0);
  const toolFailures = tools.reduce((s, x) => s + x.failures, 0);

  const avgMs = num(t.avg_ms);
  const p95Ms = num(t.p95_ms);
  return {
    turns: t.turns,
    replies: t.replies,
    notes: t.notes,
    avgMs: avgMs === null ? null : Math.round(avgMs),
    p95Ms: p95Ms === null ? null : Math.round(p95Ms),
    avgInputTokens: num(t.avg_input_tokens),
    avgOutputTokens: num(t.avg_output_tokens),
    toolCalls,
    toolFailures,
    tools,
    suggestedDailyTokens,
    p95DailyTokens,
  };
}
