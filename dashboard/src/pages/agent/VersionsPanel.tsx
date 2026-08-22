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
import { api } from '../../lib/api';
import { Button, Mono, Modal, Skeleton, EmptyState } from '../../ui';
import { timeAgo } from '../Activity';
import type { Agent, AgentEval, EvalCandidate } from './types';

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

export function VersionsPanel({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [openVersion, setOpenVersion] = useState<number | null>(null);
  const [actionError, setActionError] = useState('');
  const [ranVersion, setRanVersion] = useState<number | null>(null);

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

  const versions = data?.versions ?? [];
  const open = detail.data?.version ?? null;
  const openCandidate = open ? candidateFor(open) : null;

  return (
    <div>
      <p className="mb-4 text-[12px] text-t3">
        Every save that changes this agent&apos;s prompt or model is kept as a version. Restoring
        one is a new save — it publishes the old text again under a new number, so nothing in the
        history is ever overwritten.
      </p>

      {actionError && <p className="mb-3 text-[12px] text-err">{actionError}</p>}

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
            <li
              key={v.version}
              className="flex items-start justify-between gap-2 border-b border-bd pb-3 last:border-0 last:pb-0"
            >
              <div className="min-w-0">
                <span className="flex items-center gap-2">
                  <Mono className="text-t1">v{v.version}</Mono>
                  {v.current && <Chip>current</Chip>}
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
                <Button variant="ghost" onClick={() => setOpenVersion(v.version)}>
                  View
                </Button>
              </div>
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
    </div>
  );
}
