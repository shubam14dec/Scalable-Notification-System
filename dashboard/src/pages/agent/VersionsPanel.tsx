// Phase A5 slice A: the agent's prompt history. Every managed prompt/model save
// snapshots itself server-side, so this panel is pure read + two actions:
// RESTORE (a new save that copies an old snapshot forward — history is
// append-only, so restoring v1 publishes v3 rather than deleting v2) and RUN
// EVALS AGAINST THIS VERSION, which is the A4 candidate knob pointed at a
// stored snapshot instead of an unsaved draft. Results are the Evals tab's job
// — this panel links there rather than forking a second results renderer.
import { useState, type ReactNode } from 'react';
import { Link } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, ApiError } from '../../lib/api';
import { Button, Input, Mono, Modal, Skeleton, EmptyState } from '../../ui';
import { timeAgo } from '../Activity';
import { PreSaveCheck } from './PreSaveCheck';
import { useEvalRuns } from './shared';
import { baselineRun, fmtInt, type Agent, type AgentEval, type EvalCandidate } from './types';

/** The list shape: length + head, never the whole prompt (lists stay light). */
interface VersionSummary {
  version: number;
  model: string | null;
  promptLength: number;
  promptHead: string;
  current: boolean;
  createdAt: string;
}

interface VersionDetail {
  version: number;
  systemPrompt: string | null;
  model: string | null;
  current: boolean;
  createdAt: string;
}

/** One side of the trial. `arms` always carries both — select by `.arm`. */
interface CanaryArmReport {
  arm: 'canary' | 'control';
  conversations: number;
  turns: number;
  resolutions: number;
  handoffs: number;
  guardPauses: number;
  /** null when no turn in this arm recorded usage — an em dash, never a 0. */
  avgTokensPerTurn: number | null;
  /** dim -> { avg, n }; `{}` until the judge has scored something. */
  judged: Record<string, { avg: number; n: number }>;
}

interface CanaryReport {
  version: number;
  percent: number | null;
  samplePercent: number;
  startedAt: string;
  arms: CanaryArmReport[];
}

/**
 * A trial accumulates over hours, not seconds — a tighter loop would redraw the
 * same numbers. Same conditional-refetchInterval idiom as useEvalRuns, and the
 * query is off entirely when no trial is running.
 */
const CANARY_REPORT_POLL_MS = 30_000;

/** The dotted chip idiom used for the pre-save marker in run history. */
function Chip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex items-center rounded-md border border-dashed border-bd px-1.5 py-0.5 text-[11px] text-t3">
      {children}
    </span>
  );
}

/** A snapshot with neither prompt nor model can't be graded — nothing to send. */
function candidateFor(v: { systemPrompt: string | null; model: string | null }): EvalCandidate | null {
  const candidate: EvalCandidate = {
    ...(v.systemPrompt ? { systemPrompt: v.systemPrompt } : {}),
    ...(v.model ? { model: v.model } : {}),
  };
  return candidate.systemPrompt || candidate.model ? candidate : null;
}

/**
 * One arm of the comparison. Both columns render from the same component so the
 * two sides can never disagree about what a row means — the whole point of the
 * panel is that the numbers are read side by side.
 */
function ArmColumn({
  label,
  arm,
  samplePercent,
}: {
  label: string;
  arm: CanaryArmReport | undefined;
  samplePercent: number;
}) {
  const judged = Object.entries(arm?.judged ?? {});
  // Labels are words a customer already knows, not our internal vocabulary
  // (his feedback 2026-08-23) — "turns" and "guard pauses" read as jargon.
  const rows: Array<[string, string]> = [
    ['conversations', fmtInt(arm?.conversations)],
    ['agent replies', fmtInt(arm?.turns)],
    ['conversations resolved', fmtInt(arm?.resolutions)],
    ['handed to a human', fmtInt(arm?.handoffs)],
    ['tool calls paused for approval', fmtInt(arm?.guardPauses)],
    // fmtInt renders null as an em dash: "we recorded no usage" and "it cost
    // nothing" are different claims, and a 0 here would tell the second lie.
    ['avg tokens per reply', fmtInt(arm?.avgTokensPerTurn)],
  ];

  return (
    <div>
      <span className="block text-[11px] font-medium uppercase tracking-wider text-t3">
        {label}
      </span>
      <dl className="mt-1.5 space-y-1">
        {rows.map(([name, value]) => (
          <div key={name} className="flex items-baseline justify-between gap-3">
            <dt className="text-[12px] text-t3">{name}</dt>
            <dd>
              <Mono className="text-t1">{value}</Mono>
            </dd>
          </div>
        ))}
      </dl>
      <div className="mt-2 border-t border-bd pt-2">
        {/* His feedback 2026-08-23: "n=5" is stats shorthand — a customer
            shouldn't need to decode it. Every judged line now says what the
            number IS (a 1-5 average) and where it came from (how many replies
            the judge scored), in words. */}
        {judged.length > 0 && (
          <span className="mb-1 block text-[11px] text-t3">
            reply quality, scored 1–5 by an LLM judge on a {samplePercent}% sample:
          </span>
        )}
        {judged.length > 0 ? (
          judged.map(([dim, stat]) => (
            <div key={dim} className="flex items-baseline justify-between gap-3">
              <span className="text-[12px] text-t3">{dim}</span>
              <Mono className="text-t2">
                {stat.avg.toFixed(1)} / 5 avg
                <span className="text-t3">
                  {' '}
                  ({stat.n} {stat.n === 1 ? 'reply' : 'replies'} judged)
                </span>
              </Mono>
            </div>
          ))
        ) : (
          // Empty judged is two different situations, and guessing between them
          // is how a panel starts lying: sampling on means "not yet", sampling
          // off means "never, for this trial".
          <span className="text-[11px] text-t3">
            {samplePercent > 0
              ? `no judged replies yet — the judge scores a random ${samplePercent}% of replies in both columns`
              : 'judging is off for this trial'}
          </span>
        )}
      </div>
    </div>
  );
}

export function VersionsPanel({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const [ranVersion, setRanVersion] = useState<number | null>(null);
  // A5 slice B: which version's "Start canary" row is expanded, and the percent
  // typed into it. 10% is the default — small enough that a bad prompt reaches
  // few customers, large enough to accumulate a comparable sample.
  const [startFor, setStartFor] = useState<number | null>(null);
  const [percent, setPercent] = useState('10');

  const { data, isLoading } = useQuery({
    queryKey: ['agent-versions', agent.identifier],
    queryFn: () =>
      api<{ currentVersion: number; versions: VersionSummary[] }>(
        `/v1/agents/${agent.identifier}/versions`,
      ),
  });

  // The full text of the one version being read — fetched only when opened, so
  // a long history never pulls every prompt down at once.
  const detail = useQuery({
    queryKey: ['agent-version', agent.identifier, openVersion],
    queryFn: () =>
      api<{ version: VersionDetail }>(`/v1/agents/${agent.identifier}/versions/${openVersion}`),
    enabled: openVersion !== null,
  });

  // Shares EvalsPanel's cache entry — the gate is the same one that tab uses.
  const evalsQuery = useQuery({
    queryKey: ['agent-evals', agent.identifier],
    queryFn: () => api<{ evals: AgentEval[] }>(`/v1/agents/${agent.identifier}/evals`),
  });
  const enabledEvals = (evalsQuery.data?.evals ?? []).filter((e) => e.enabled).length;

  const canary = agent.canary ?? null;

  // A5 slice C: the running trial's counters. Presence of `agent.canary` is the
  // only thing that turns this on — with no trial there is nothing to poll, and
  // the version in the key keeps a promoted trial's numbers from flashing under
  // the next one.
  const report = useQuery({
    queryKey: ['agent-canary-report', agent.identifier, canary?.version ?? null],
    queryFn: async () => {
      try {
        return await api<CanaryReport>(`/v1/agents/${agent.identifier}/canary/report`);
      } catch (err) {
        // A trial that ended between renders 404s; a bridge agent 400s. Neither
        // is a failure to show anyone — both mean "no trial", which this panel
        // already renders by dropping the strip once `agent.canary` refreshes
        // away. Swallowing them here also keeps the 30s poll from burning a
        // retry every tick on a condition that will never resolve.
        if (err instanceof ApiError && (err.status === 404 || err.status === 400)) return null;
        throw err;
      }
    },
    enabled: canary !== null,
    refetchInterval: CANARY_REPORT_POLL_MS,
  });
  const arms = report.data?.arms ?? [];
  // Arm order is not guaranteed by the API — always select, never index.
  const armOf = (name: CanaryArmReport['arm']) => arms.find((a) => a.arm === name);

  // A5 slice C: a restore publishes a live prompt, so it earns the same pre-save
  // check an ordinary Save gets. The gate mirrors EditPanel's `preSaveOn`
  // exactly — an agent with no enabled eval keeps the plain confirm, because
  // there is nothing to run against it.
  const evalGateOn = agent.runtime === 'managed' && Boolean(agent.identifier);
  const runsQuery = useEvalRuns(agent.identifier, evalGateOn);
  const preSaveOn = evalGateOn && enabledEvals > 0;
  const [restoreCheck, setRestoreCheck] = useState<{
    version: number;
    candidate: EvalCandidate;
  } | null>(null);

  const restore = useMutation({
    mutationFn: (version: number) =>
      api<{ restoredFrom: number; version: number }>(
        `/v1/agents/${agent.identifier}/versions/${version}/restore`,
        { method: 'POST' },
      ),
    onSuccess: () => {
      setActionError('');
      setOpenVersion(null);
      // The editor reads the agent off the shared ['agents'] list — refresh it
      // so the prompt box shows what is now live, not the pre-restore text.
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
      void queryClient.invalidateQueries({ queryKey: ['agent-versions', agent.identifier] });
    },
    onError: (err) => setActionError(err.message),
  });

  const runEvals = useMutation({
    mutationFn: (vars: { version: number; candidate: EvalCandidate }) =>
      api<{ runId: string }>(`/v1/agents/${agent.identifier}/evals/run`, {
        method: 'POST',
        body: { trigger: 'manual', candidate: vars.candidate },
      }),
    onSuccess: (_res, vars) => {
      setActionError('');
      setRanVersion(vars.version);
      setOpenVersion(null);
      void queryClient.invalidateQueries({ queryKey: ['agent-eval-runs', agent.identifier] });
    },
    onError: (err) => setActionError(err.message),
  });

  // ---- A5 slice B: canary controls (slice C added the comparison above them) ----
  // Start / Stop / Promote only. Every one of them changes the agent row, so
  // they all invalidate ['agents'] (the editor and this panel read the agent
  // from it) alongside the version list a promote appends to.
  const invalidateAgent = () => {
    void queryClient.invalidateQueries({ queryKey: ['agents'] });
    void queryClient.invalidateQueries({ queryKey: ['agent-versions', agent.identifier] });
  };

  const startCanary = useMutation({
    mutationFn: (vars: { version: number; percent: number }) =>
      api(`/v1/agents/${agent.identifier}/canary`, { method: 'POST', body: vars }),
    onSuccess: () => {
      setActionError('');
      setStartFor(null);
      invalidateAgent();
    },
    onError: (err) => setActionError(err.message),
  });

  const stopCanary = useMutation({
    mutationFn: () => api(`/v1/agents/${agent.identifier}/canary`, { method: 'DELETE' }),
    onSuccess: () => {
      setActionError('');
      invalidateAgent();
    },
    onError: (err) => setActionError(err.message),
  });

  const promoteCanary = useMutation({
    mutationFn: () => api(`/v1/agents/${agent.identifier}/canary/promote`, { method: 'POST' }),
    onSuccess: () => {
      setActionError('');
      invalidateAgent();
    },
    onError: (err) => setActionError(err.message),
  });

  const versions = data?.versions ?? [];
  const open = detail.data?.version ?? null;
  const openCandidate = open ? candidateFor(open) : null;

  return (
    <div>
      <p className="mb-4 text-[12px] text-t3">
        Every save that changes this agent&apos;s prompt or model is kept as a version. Restoring
        one is a new save — it publishes the old text again under a new number, so nothing in the
        history is ever overwritten. You can also put one version on trial with a share of new
        conversations before it takes over; a conversation keeps whichever version it started on.
      </p>

      {actionError && <p className="mb-3 text-[12px] text-err">{actionError}</p>}

      {canary && (
        <div className="mb-4 rounded-lg border border-bd bg-elevated px-3 py-2.5">
          <p className="text-[12px] text-t2">
            <Mono className="text-t1">v{canary.version}</Mono> is on trial with{' '}
            <span className="text-t1">{canary.percent}%</span> of new conversations
            {canary.startedAt && ` · started ${timeAgo(canary.startedAt)}`}
            {canary.samplePercent > 0
              ? ` · an LLM judge scores ${canary.samplePercent}% of replies on both sides`
              : ' · counters only (judging off)'}
          </p>

          {report.isLoading ? (
            <Skeleton className="mt-3 h-36 w-full" />
          ) : report.data ? (
            <div className="mt-3 grid gap-4 sm:grid-cols-2">
              <ArmColumn
                label="Live"
                arm={armOf('control')}
                samplePercent={report.data.samplePercent}
              />
              <ArmColumn
                label={`Canary v${report.data.version}`}
                arm={armOf('canary')}
                samplePercent={report.data.samplePercent}
              />
            </div>
          ) : report.isError ? (
            // Muted, not an error box: the comparison failing to load says
            // nothing about the trial, which is still running and still
            // steerable with the two buttons below.
            <p className="mt-2 text-[11px] text-t3">
              Couldn&apos;t read the trial&apos;s counters just now — the trial itself is
              unaffected, and this retries on its own.
            </p>
          ) : null}

          {/* The report is the evidence, so the two decisions sit under it. */}
          <div className="mt-3 flex justify-end gap-2 border-t border-bd pt-2.5">
            <Button
              variant="ghost"
              disabled={stopCanary.isPending || promoteCanary.isPending}
              onClick={() => stopCanary.mutate()}
            >
              Stop
            </Button>
            <Button
              variant="primary"
              disabled={stopCanary.isPending || promoteCanary.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Promote v${canary.version}? It becomes the live prompt for every conversation, and the trial ends.`,
                  )
                ) {
                  promoteCanary.mutate();
                }
              }}
            >
              Promote
            </Button>
          </div>
        </div>
      )}

      {ranVersion !== null && (
        <p className="mb-3 text-[12px] text-t2">
          Running the evals against v{ranVersion}.{' '}
          <Link
            to={`/agents/${agent.identifier}?tab=evals`}
            className="underline underline-offset-2 transition-colors hover:text-t1"
          >
            See the results in Evals
          </Link>
        </p>
      )}

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : versions.length === 0 ? (
        <EmptyState
          title="No versions yet"
          body="This agent predates prompt versioning. Its current prompt becomes version 1 the next time you save a change."
        />
      ) : (
        <ul className="space-y-3">
          {versions.map((v) => (
            <li key={v.version} className="border-b border-bd pb-3 last:border-0 last:pb-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <span className="flex items-center gap-2">
                    <Mono className="text-t1">v{v.version}</Mono>
                    {v.current && <Chip>current</Chip>}
                    {canary?.version === v.version && <Chip>on trial</Chip>}
                    <Mono className="text-t3">{v.model ?? 'default model'}</Mono>
                  </span>
                  <span className="mt-0.5 block truncate text-[11px] text-t3">
                    {v.promptLength > 0
                      ? `${v.promptLength.toLocaleString()} chars · ${v.promptHead}`
                      : 'no prompt'}
                  </span>
                </div>
                <div className="flex shrink-0 items-center gap-2">
                  <span className="text-[11px] text-t3">{timeAgo(v.createdAt)}</span>
                  {/* Only offered on a version that isn't already live, and only
                      while nothing is on trial — one canary per agent, so the
                      control disappears rather than failing with a 409. */}
                  {!v.current && !canary && startFor !== v.version && (
                    <Button variant="ghost" onClick={() => setStartFor(v.version)}>
                      Start canary
                    </Button>
                  )}
                  <Button variant="ghost" onClick={() => setOpenVersion(v.version)}>
                    View
                  </Button>
                </div>
              </div>

              {startFor === v.version && !canary && (
                <div className="mt-2.5 flex flex-wrap items-center gap-2 rounded-lg border border-bd bg-elevated px-3 py-2.5">
                  <span className="text-[12px] text-t2">Send</span>
                  <Input
                    type="number"
                    min={1}
                    max={99}
                    value={percent}
                    autoFocus
                    onChange={(e) => setPercent(e.target.value)}
                    className="w-16"
                  />
                  <span className="text-[12px] text-t2">
                    % of new conversations to v{v.version}
                  </span>
                  <span className="ml-auto flex items-center gap-2">
                    <Button
                      variant="ghost"
                      onClick={() => {
                        setStartFor(null);
                        setActionError('');
                      }}
                    >
                      Cancel
                    </Button>
                    <Button
                      variant="primary"
                      disabled={startCanary.isPending}
                      onClick={() =>
                        startCanary.mutate({ version: v.version, percent: Number(percent) })
                      }
                    >
                      Start
                    </Button>
                  </span>
                </div>
              )}
            </li>
          ))}
        </ul>
      )}

      <Modal
        open={openVersion !== null}
        onClose={() => setOpenVersion(null)}
        title={`Version ${openVersion ?? ''}`}
      >
        {detail.isLoading || !open ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <>
            <p className="mb-3 text-[12px] text-t3">
              {open.model ?? 'default model'} · saved {timeAgo(open.createdAt)}
              {open.current && ' · currently live'}
            </p>
            <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap rounded-lg border border-bd bg-elevated p-3 font-mono text-[12px] leading-relaxed text-t2">
              {open.systemPrompt ?? 'This version had no system prompt.'}
            </pre>
            <div className="mt-4 flex justify-end gap-2 border-t border-bd pt-3">
              <Button variant="ghost" onClick={() => setOpenVersion(null)}>
                Close
              </Button>
              <Button
                disabled={!openCandidate || enabledEvals === 0 || runEvals.isPending}
                title={
                  !openCandidate
                    ? 'This version has no prompt or model to grade'
                    : enabledEvals === 0
                      ? 'Enable at least one eval to run'
                      : undefined
                }
                onClick={() =>
                  openCandidate &&
                  runEvals.mutate({ version: open.version, candidate: openCandidate })
                }
              >
                Run evals against this version
              </Button>
              {!open.current && (
                <Button
                  variant="primary"
                  disabled={restore.isPending}
                  onClick={() => {
                    // With evals enabled the check owns this decision: it runs
                    // them against the snapshot being restored and asks once, at
                    // the end. A confirm() here too would be one warning about
                    // the same act too many (EditPanel's save path reasons the
                    // same way). A snapshot with neither prompt nor model has
                    // nothing to grade, so it keeps the plain confirm.
                    if (preSaveOn && openCandidate) {
                      // Close the drawer first — the check is a modal of its own
                      // and Escape would otherwise dismiss both at once.
                      setRestoreCheck({ version: open.version, candidate: openCandidate });
                      setOpenVersion(null);
                      return;
                    }
                    if (
                      window.confirm(
                        `Restore v${open.version}? This saves its prompt as a new version and makes it live for new turns.`,
                      )
                    ) {
                      restore.mutate(open.version);
                    }
                  }}
                >
                  Restore
                </Button>
              )}
            </div>
          </>
        )}
      </Modal>

      {/* The restore's pre-save check. Same panel the Edit tab uses, pointed at
          the stored snapshot instead of an unsaved draft: it grades the version
          first, and only its own Save/Save anyway fires the restore. */}
      {restoreCheck && (
        <PreSaveCheck
          identifier={agent.identifier}
          candidate={restoreCheck.candidate}
          baseline={baselineRun(runsQuery.data?.runs ?? [])}
          evalCount={enabledEvals}
          onSave={() => {
            const { version } = restoreCheck;
            setRestoreCheck(null);
            restore.mutate(version);
          }}
          onCancel={() => setRestoreCheck(null)}
        />
      )}
    </div>
  );
}
