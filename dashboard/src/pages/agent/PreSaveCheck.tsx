// Phase A4 slice B — the pre-save check.
//
// Save on a changed managed prompt/model opens this panel: it runs the agent's
// OWN evals against the edited config (a `candidate` run — slice A), then shows
// each scenario's delta against the last run of the live config.
//
// Doctrine, from the phase plan: WARN, NEVER BLOCK. The commit button is
// present and enabled from the moment the panel opens — while the run is still
// in flight, when the run errors, when the request never got off the ground.
// A check that can trap a customer mid-edit is worse than no check at all.
import { useEffect, useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, Modal, Mono, Skeleton } from '../../ui';
import { timeAgo } from '../Activity';
import { ScenarioResults, useEvalRunDetail } from './shared';
import {
  candidateLabel,
  DELTA_LABEL,
  deltaDot,
  preSaveSummary,
  runDot,
  scenarioDelta,
  type EvalCandidate,
  type EvalRun,
  type ScenarioResult,
} from './types';

/**
 * The run is a foreground wait — someone is staring at this panel with an
 * unsaved edit behind it. `eval.finished` over the admin socket is still the
 * primary path (Phase 25 D8); this is only the fallback under it, and it stops
 * the moment the run leaves 'running'.
 */
const PRE_SAVE_POLL_MS = 3_000;

/** One scenario's delta chip — same chip idiom as the judged dimensions. */
function DeltaChip({ result, baseline }: { result: ScenarioResult; baseline: ScenarioResult[] | null }) {
  const delta = scenarioDelta(result, baseline);
  const label = DELTA_LABEL[delta];
  if (!label) return null;
  return (
    <span
      className={`inline-flex items-center gap-1.5 rounded-md border border-bd px-2 py-0.5 text-[11px] ${
        delta === 'new-fail' ? 'text-err' : delta === 'fixed' ? 'text-t2' : 'text-t3'
      }`}
    >
      <span
        aria-hidden
        className="inline-block h-[6px] w-[6px] shrink-0 rounded-full"
        style={{ background: deltaDot(delta) }}
      />
      {label}
    </span>
  );
}

export function PreSaveCheck({
  identifier,
  candidate,
  baseline,
  evalCount,
  onSave,
  onCancel,
}: {
  identifier: string;
  /** The edited values — only the keys that actually changed. */
  candidate: EvalCandidate;
  /** Newest finished run of the LIVE config, or null when there is none yet. */
  baseline: EvalRun | null;
  /** How many enabled evals this agent has — the run's expected size. */
  evalCount: number;
  /** Commit the save the user asked for. */
  onSave: () => void;
  /** Close and leave the edit in the form, unsaved. */
  onCancel: () => void;
}) {
  const queryClient = useQueryClient();
  const [runId, setRunId] = useState<string | null>(null);
  const [startError, setStartError] = useState('');
  const started = useRef(false);

  const start = useMutation({
    mutationFn: () =>
      api<{ runId: string }>(`/v1/agents/${identifier}/evals/run`, {
        method: 'POST',
        body: { trigger: 'pre_save', candidate },
      }),
    onSuccess: (res) => {
      setRunId(res.runId);
      void queryClient.invalidateQueries({ queryKey: ['agent-eval-runs', identifier] });
    },
    onError: (err) => setStartError(err.message),
  });

  // Fire once on open. The ref (not the mutation's own state) is the guard:
  // StrictMode runs effects twice in dev, and each POST would mint its own run
  // row — the queue's jobId dedupe would not save us.
  const startMutation = start.mutate;
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    startMutation();
  }, [startMutation]);

  const detail = useEvalRunDetail(identifier, runId, PRE_SAVE_POLL_MS);
  const run = detail.data?.run ?? null;
  const results = run?.results ?? [];
  const baselineResults = baseline?.results ?? null;

  const running = !run || run.status === 'running';
  const errored = run?.status === 'error';
  const summary = !running ? preSaveSummary(results, baselineResults) : null;
  // "Nothing regressed" is a positive claim: it needs a finished run that did
  // not error AND graded something. Anything else keeps the honest wording.
  const clean = !!summary && summary.clean && !errored && results.length > 0;
  const failedToStart = !!startError;

  return (
    <Modal open onClose={onCancel} title="Pre-save check">
      <div className="space-y-3">
        <p className="text-[12px] text-t3">
          Running this agent's {evalCount} enabled eval{evalCount === 1 ? '' : 's'} against the
          edited <Mono className="text-t2">{candidateLabel(candidate)}</Mono>. Nothing is saved and
          the live agent is untouched until you choose below.
        </p>

        {failedToStart ? (
          <div className="rounded-md border border-bd bg-elevated px-3 py-2.5">
            <p className="text-[12px] text-err">Couldn't start the check: {startError}</p>
            <p className="mt-1 text-[11px] text-t3">
              Your edit is still in the form — save it anyway, or cancel and try again.
            </p>
          </div>
        ) : (
          <>
            <div className="flex items-center justify-between gap-3 border-t border-bd pt-3">
              <span className="inline-flex min-w-0 items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-t3">
                <span
                  aria-hidden
                  className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
                  style={{ background: run ? runDot(run) : 'var(--info)' }}
                />
                {running ? 'Running…' : summary!.text}
              </span>
              {run && !running && (
                <Mono className="shrink-0 text-t3">{timeAgo(run.finishedAt ?? run.startedAt)}</Mono>
              )}
            </div>

            {detail.isError && (
              <p className="text-[12px] text-err">
                Couldn't read this run's results: {(detail.error as Error).message}. The run itself
                may still be going — the Evals tab will have it either way.
              </p>
            )}

            {errored && (
              <p className="text-[12px] text-err">
                The run errored before it finished — treat the results below, if any, as
                incomplete.
              </p>
            )}

            {!running && !baseline && (
              <p className="text-[11px] text-t3">
                No previous run of the saved config to compare against, so these are absolute
                results — not a before/after.
              </p>
            )}
            {!running && baseline && (
              <p className="text-[11px] text-t3">
                Compared with the last run of the saved config,{' '}
                {timeAgo(baseline.finishedAt ?? baseline.startedAt)}.
              </p>
            )}

            {running && !results.length ? (
              <Skeleton className="h-16 w-full" />
            ) : results.length > 0 ? (
              <ScenarioResults
                results={results}
                badgeFor={(r) => <DeltaChip result={r} baseline={baselineResults} />}
              />
            ) : (
              <p className="text-[12px] text-t3">No scenario results recorded for this run.</p>
            )}
          </>
        )}

        <div className="flex justify-end gap-2 border-t border-bd pt-3">
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
          {/* One commit control, always enabled — it reads "Save" only once the
              check has finished and nothing regressed; every other state
              (running, errored, regressions) says "Save anyway", because that is
              what the click means there. */}
          <Button type="button" variant={clean ? 'primary' : 'secondary'} onClick={onSave}>
            {clean ? 'Save' : 'Save anyway'}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
