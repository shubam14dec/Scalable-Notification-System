// Header health strip for the agent detail page (Phase 21 health query). Shows
// the V1 summary line (avg / p95 / errors / today tokens / health dot) with a
// "details" expander that reveals the FULL former-HealthModal stats — turns,
// replies/notes, avg/p95 turn, avg tokens/turn, tool calls, today's budget, the
// 30-day suggested/p95 daily-token stats, and the per-tool table — plus the
// 7/30-day window toggle. Same query key (['agent-health', identifier, days]).
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Mono, Skeleton, td, th } from '../../ui';
import { fmtInt, fmtMs, type Agent, type AgentHealth } from './types';

/** A quiet label/value stat row — mono value, right-aligned. */
function StatRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-3">
      <dt className="text-t3">{label}</dt>
      <dd>
        <Mono className="text-t2">{children}</Mono>
      </dd>
    </div>
  );
}

export function HealthStrip({ agent }: { agent: Agent }) {
  const [days, setDays] = useState<7 | 30>(7);
  const [expanded, setExpanded] = useState(false);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['agent-health', agent.identifier, days],
    queryFn: () => api<AgentHealth>(`/v1/agents/${agent.identifier}/health?days=${days}`),
  });

  const hasData = !!data && data.turns > 0;
  const warn =
    !!data &&
    ((data.toolCalls > 0 && data.toolFailures / data.toolCalls > 0.05) ||
      (data.turns > 0 && data.notes / data.turns > 0.2));
  const failurePct =
    data && data.toolCalls > 0 ? ((data.toolFailures / data.toolCalls) * 100).toFixed(1) : null;
  const dotColor = hasData ? (warn ? 'var(--warn)' : 'var(--ok)') : 'var(--t3)';
  const healthLabel = !hasData ? 'no data' : warn ? 'degraded' : 'healthy';

  return (
    <div className="mt-2.5">
      {isLoading ? (
        <Skeleton className="h-4 w-72" />
      ) : (
        <div className="flex flex-wrap items-center gap-x-5 gap-y-1 font-mono text-[11.5px] text-t2">
          <span>
            avg <span className="text-t1">{data ? fmtMs(data.avgMs) : '—'}</span>
          </span>
          <span>
            p95 <span className="text-t1">{data ? fmtMs(data.p95Ms) : '—'}</span>
          </span>
          <span>
            errors <span className="text-t1">{failurePct ?? '0.0'}%</span>
          </span>
          <span>
            today <span className="text-t1">{fmtInt(data?.usedTodayTokens)}</span> tok
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-[7px] w-[7px] rounded-full"
              style={{ background: dotColor }}
            />
            {healthLabel}
          </span>
          <button
            type="button"
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
            className="text-t3 underline-offset-2 transition-colors hover:text-t1 hover:underline"
          >
            {expanded ? 'hide details' : 'details'}
          </button>
        </div>
      )}

      {expanded && (
        <div className="mt-3 max-w-md rounded-lg border border-bd bg-surface p-4">
          <div className="mb-3 flex items-center justify-between">
            <span className="text-[11px] font-medium uppercase tracking-wider text-t3">
              Last {days} days
            </span>
            <div className="inline-flex overflow-hidden rounded-md border border-bd text-[11px]">
              {([7, 30] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  aria-pressed={days === d}
                  onClick={() => setDays(d)}
                  className={`px-2 py-1 transition-colors ${
                    days === d ? 'bg-elevated text-t1' : 'text-t3 hover:text-t1'
                  }`}
                >
                  {d}d
                </button>
              ))}
            </div>
          </div>

          {isLoading ? (
            <Skeleton className="h-40 w-full" />
          ) : isError ? (
            <p className="text-[12px] text-err">
              Couldn't load health — {error instanceof Error ? error.message : 'try again'}.
            </p>
          ) : !data || data.turns === 0 ? (
            <p className="text-[12px] text-t3">No traced turns in this window yet.</p>
          ) : (
            <>
              <dl className="space-y-2 text-[12px]">
                <StatRow label="Turns">{data.turns.toLocaleString()}</StatRow>
                <StatRow label="Replies / notes">
                  {data.replies.toLocaleString()} / {data.notes.toLocaleString()}
                </StatRow>
                <StatRow label="Avg / p95 turn">
                  {fmtMs(data.avgMs)} / {fmtMs(data.p95Ms)}
                </StatRow>
                <StatRow label="Avg tokens / turn">
                  {fmtInt(data.avgInputTokens)} in / {fmtInt(data.avgOutputTokens)} out
                </StatRow>
                <StatRow label="Tool calls">
                  {data.toolCalls === 0
                    ? '0'
                    : `${data.toolCalls.toLocaleString()} · ${data.toolFailures} failed (${failurePct}%)`}
                </StatRow>
                {data.maxDailyTokens != null && data.maxDailyTokens > 0 && (
                  <StatRow label="Budget (today)">
                    <span className="inline-flex items-center gap-1.5">
                      {(data.usedTodayTokens ?? 0) >= data.maxDailyTokens && (
                        <span
                          aria-hidden
                          className="inline-block h-[7px] w-[7px] rounded-full"
                          style={{ background: 'var(--warn)' }}
                        />
                      )}
                      {fmtInt(data.usedTodayTokens ?? 0)} / {fmtInt(data.maxDailyTokens)}
                    </span>
                  </StatRow>
                )}
                {data.p95DailyTokens != null && (
                  <StatRow label="30-day p95 daily">{fmtInt(data.p95DailyTokens)}</StatRow>
                )}
                {data.suggestedDailyTokens != null && (
                  <StatRow label="Suggested budget">{fmtInt(data.suggestedDailyTokens)}</StatRow>
                )}
              </dl>

              {data.tools.length > 0 && (
                <div className="mt-4 overflow-x-auto border-t border-bd pt-4">
                  <table className="w-full border-collapse">
                    <thead>
                      <tr>
                        <th className={th}>Tool</th>
                        <th className={`${th} text-right`}>Calls</th>
                        <th className={`${th} text-right`}>Failures</th>
                        <th className={`${th} text-right`}>Avg</th>
                      </tr>
                    </thead>
                    <tbody>
                      {data.tools.map((t) => (
                        <tr key={t.name}>
                          <td className={td}>
                            <Mono className="text-t1">{t.name}</Mono>
                          </td>
                          <td className={`${td} text-right`}>
                            <Mono className="text-t2">{t.calls.toLocaleString()}</Mono>
                          </td>
                          <td className={`${td} text-right`}>
                            <Mono className={t.failures > 0 ? 'text-t1' : 'text-t3'}>
                              {t.failures}
                            </Mono>
                          </td>
                          <td className={`${td} text-right`}>
                            <Mono className="text-t2">{fmtMs(t.avgMs)}</Mono>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
