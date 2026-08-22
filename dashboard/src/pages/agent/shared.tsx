// Shared React atoms/hooks for the per-agent detail panels. Extracted verbatim
// from the former Agents.tsx — same react-query keys, same API paths.
import { useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { ChevronDown, ChevronRight } from 'lucide-react';
import { api } from '../../lib/api';
import { Button, CopyField, Modal, Mono } from '../../ui';
import {
  judgeChipLabel,
  judgeChipTitle,
  judgeDot,
  judgedSpansTurns,
  type EvalRun,
  type JudgeVerdictRecord,
  type ScenarioResult,
} from './types';

/** Monochrome switch — same idiom as the workflow step drawer. */
export function Toggle({
  checked,
  onChange,
  label,
}: {
  checked: boolean;
  onChange: (v: boolean) => void;
  label: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      onClick={() => onChange(!checked)}
      className={`relative inline-flex h-5 w-9 shrink-0 items-center rounded-full border transition-colors duration-150 ${
        checked ? 'border-transparent bg-invert' : 'border-bd bg-elevated hover:border-bd-strong'
      }`}
    >
      <span
        aria-hidden
        className={`inline-block h-3.5 w-3.5 rounded-full transition-transform duration-150 ${
          checked ? 'translate-x-[18px] bg-invert-t' : 'translate-x-[3px] bg-t3'
        }`}
      />
    </button>
  );
}

/**
 * Runs list for an agent, newest first. Polls every 2s while the latest run is
 * still running, then goes quiet — shared by the panel and the save-gate.
 */
export function useEvalRuns(identifier: string, enabled: boolean) {
  return useQuery({
    queryKey: ['agent-eval-runs', identifier],
    queryFn: () => api<{ runs: EvalRun[] }>(`/v1/agents/${identifier}/evals/runs`),
    enabled,
    // Phase 25 D8: live via eval.finished hints; 30s conditional fallback while
    // the latest run is still running (was 2s).
    refetchInterval: (query) => {
      const latest = query.state.data?.runs?.[0];
      return latest && latest.status === 'running' ? 30_000 : false;
    },
  });
}

/**
 * Full results for one run, polled while it is still running — the detail the
 * runs LIST does not have to be trusted for. Same query key as the panel's own
 * detail query, so an `eval.finished` hint invalidates whoever is mounted.
 *
 * `fallbackMs` is the belt-and-braces poll under the live hint (Phase 25 D8):
 * 30s for a panel someone might have left open, tighter for a foreground wait.
 */
export function useEvalRunDetail(identifier: string, runId: string | null, fallbackMs = 30_000) {
  return useQuery({
    queryKey: ['agent-eval-run', identifier, runId],
    queryFn: () => api<{ run: EvalRun }>(`/v1/agents/${identifier}/evals/runs/${runId}`),
    enabled: !!runId,
    refetchInterval: (query) => (query.state.data?.run.status === 'running' ? fallbackMs : false),
  });
}

/**
 * A2: the LLM-judged dimensions of one scenario result. One chip per record —
 * dot carries the verdict (the panel's existing pass/fail idiom), and the
 * rationales stay folded away behind the same chevron the conversation trace
 * uses, because a scenario can carry several ~160-char rationales.
 * Renders nothing for pre-A2 results, which have no `judged`.
 */
function JudgedBlock({ judged }: { judged: JudgeVerdictRecord[] }) {
  const [expanded, setExpanded] = useState(false);
  const showTurn = judgedSpansTurns(judged);

  return (
    <div className="mt-1">
      <div className="flex flex-wrap items-center gap-1.5">
        {judged.map((rec) => (
          <span
            key={`${rec.turn}-${rec.dim}`}
            title={judgeChipTitle(rec)}
            className={`inline-flex items-center gap-1.5 rounded-md border px-2 py-0.5 text-[11px] ${
              rec.verdict === 'skipped'
                ? 'border-dashed border-bd text-t3'
                : rec.verdict === 'fail'
                  ? 'border-bd text-err'
                  : 'border-bd text-t2'
            }`}
          >
            <span
              aria-hidden
              className="inline-block h-[6px] w-[6px] shrink-0 rounded-full"
              style={{ background: judgeDot(rec.verdict) }}
            />
            {judgeChipLabel(rec, showTurn)}
          </span>
        ))}
      </div>

      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="mt-1 inline-flex items-center gap-1 text-t3 transition-colors hover:text-t1"
      >
        {expanded ? (
          <ChevronDown className="h-3 w-3 shrink-0" aria-hidden />
        ) : (
          <ChevronRight className="h-3 w-3 shrink-0" aria-hidden />
        )}
        <Mono className="text-[11px] text-t3">
          {expanded ? 'hide why' : `why — ${judged.length} judged`}
        </Mono>
      </button>

      {expanded && (
        <div className="mt-1.5 space-y-1 border-l border-bd pl-2.5">
          {judged.map((rec) => (
            <div key={`${rec.turn}-${rec.dim}`} className="text-[11px]">
              <Mono className="text-t3">
                turn {rec.turn} · {rec.dim} · {rec.verdict}
                {rec.score != null && ` · ${rec.score}/5`}
              </Mono>
              <Mono className="mt-0.5 block whitespace-pre-wrap break-words text-t3">
                {rec.rationale}
              </Mono>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

/**
 * One run's scenario rows: pass/fail dot, name, frozen failure lines, judged
 * chips. THE renderer for eval results — the Evals panel and A4's pre-save check
 * share it so a result can never look like two different things.
 *
 * `badgeFor` is the pre-save check's one addition: an optional chip beside the
 * scenario name (its delta vs the baseline run). Omitted → the row renders
 * exactly as it did before A4.
 */
export function ScenarioResults({
  results,
  badgeFor,
}: {
  results: ScenarioResult[];
  badgeFor?: (r: ScenarioResult) => ReactNode;
}) {
  return (
    <ul className="space-y-1.5">
      {results.map((r) => {
        const badge = badgeFor?.(r);
        return (
          <li key={r.name} className="flex items-start gap-2 text-[12px]">
            <span
              aria-hidden
              className="mt-1 inline-block h-[6px] w-[6px] shrink-0 rounded-full"
              style={{ background: r.passed ? 'var(--ok)' : 'var(--err)' }}
            />
            <div className="min-w-0">
              {badge ? (
                <div className="flex flex-wrap items-center gap-1.5">
                  <Mono className="text-t2">{r.name}</Mono>
                  {badge}
                </div>
              ) : (
                <Mono className="text-t2">{r.name}</Mono>
              )}
              {!r.passed && r.failures && r.failures.length > 0 && (
                <Mono className="mt-0.5 block whitespace-pre-wrap break-words text-t3">
                  {r.failures.join('\n')}
                </Mono>
              )}
              {r.judged && r.judged.length > 0 && <JudgedBlock judged={r.judged} />}
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/** Shown once after create/rotate — the same doctrine as API keys. */
export function SecretReveal({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Signing secret">
      <p className="mb-3 text-[12px] text-t2">
        Give this to your agent's handler (<Mono>createHandler</Mono> from{' '}
        <Mono>@asyncify-hq/agent</Mono>). It is shown only once — rotate it if lost.
      </p>
      <CopyField value={secret} />
      <div className="mt-4 flex justify-end">
        <Button variant="primary" onClick={onClose}>
          I saved it
        </Button>
      </div>
    </Modal>
  );
}
