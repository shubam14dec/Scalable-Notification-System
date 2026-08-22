// Evals tab — per-agent scenario suite, runs, and clickable run detail.
// Managed agents only. EvalFormModal kept as a modal opened from the panel.
// Same query keys (['agent-evals'], ['agent-eval-runs'], ['agent-eval-run', …])
// and paths as the former EvalsModal.
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, Field, Input, Modal, Mono, Skeleton } from '../../ui';
import { timeAgo } from '../Activity';
import { ScenarioResults, Toggle, useEvalRunDetail, useEvalRuns } from './shared';
import {
  DEFAULT_SCENARIO,
  parseScenario,
  runDot,
  runSummary,
  TEXTAREA_CLS,
  type Agent,
  type AgentEval,
  type EvalRun,
} from './types';

/** Create or edit one eval scenario. Name + JSON scenario + enabled. */
function EvalFormModal({
  agent,
  evalItem,
  onClose,
  onSaved,
}: {
  agent: Agent;
  evalItem: AgentEval | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const editing = Boolean(evalItem);
  const [name, setName] = useState(evalItem?.name ?? '');
  const [enabled, setEnabled] = useState(evalItem ? evalItem.enabled : true);
  const [scenario, setScenario] = useState(
    evalItem ? JSON.stringify(evalItem.scenario, null, 2) : DEFAULT_SCENARIO,
  );
  const [error, setError] = useState('');

  const save = useMutation({
    mutationFn: (body: { name: string; scenario: object; enabled: boolean }) =>
      editing
        ? api(`/v1/agents/${agent.identifier}/evals/${evalItem!.id}`, { method: 'PUT', body })
        : api(`/v1/agents/${agent.identifier}/evals`, { method: 'POST', body }),
    onSuccess: () => onSaved(),
    onError: (err) => setError(err.message),
  });

  return (
    <Modal open onClose={onClose} title={editing ? `Edit ${evalItem!.name}` : 'New eval'}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          if (!name.trim()) {
            setError('Name is required.');
            return;
          }
          const parsed = parseScenario(scenario);
          if (!parsed.ok) {
            setError(parsed.error);
            return;
          }
          save.mutate({ name: name.trim(), scenario: parsed.value, enabled });
        }}
      >
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
            autoFocus
            placeholder="refund-pauses-for-approval"
            className="font-mono"
          />
        </Field>

        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-t2">Scenario</span>
          <textarea
            value={scenario}
            onChange={(e) => setScenario(e.target.value)}
            rows={12}
            spellCheck={false}
            className={`${TEXTAREA_CLS} font-mono`}
          />
          <span className="mt-1 block text-[11px] text-t3">
            A JSON object with a <Mono>turns</Mono> array — user turns and tool/reply expectations,
            same format as the eval files.
          </span>
          <span className="mt-1 block text-[11px] text-t3">
            An <Mono>expect</Mono> may also carry a <Mono>judge</Mono> block, graded by this agent's
            own model after its plain assertions pass:{' '}
            <Mono>{'groundedness: true | { min }'}</Mono>, <Mono>{'tone: { rubric, min }'}</Mono>{' '}
            (the rubric is the voice to grade against), and{' '}
            <Mono>refusal: "must_refuse" | "must_answer"</Mono>. Scores run 1–5 and{' '}
            <Mono>min</Mono> defaults to 4. Judged dimensions only run here — a CLI run marks them
            skipped.
          </span>
        </div>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="block text-[12px] font-medium text-t2">Enabled</span>
            <span className="mt-1 block text-[11px] text-t3">
              Only enabled evals run when you click “Run evals”.
            </span>
          </div>
          <Toggle checked={enabled} onChange={setEnabled} label="Eval enabled" />
        </div>

        {error && <p className="text-[12px] text-err">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : editing ? 'Save changes' : 'Create eval'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Per-agent evals: list, edit, run, and read results. Managed agents only. */
export function EvalsPanel({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [formFor, setFormFor] = useState<AgentEval | 'new' | null>(null);
  const [selectedRunId, setSelectedRunId] = useState<string | null>(null);
  const [actionError, setActionError] = useState('');

  const invalidateEvals = () =>
    void queryClient.invalidateQueries({ queryKey: ['agent-evals', agent.identifier] });
  const invalidateRuns = () =>
    void queryClient.invalidateQueries({ queryKey: ['agent-eval-runs', agent.identifier] });

  const { data: evalsData, isLoading } = useQuery({
    queryKey: ['agent-evals', agent.identifier],
    queryFn: () => api<{ evals: AgentEval[] }>(`/v1/agents/${agent.identifier}/evals`),
  });

  const runsQuery = useEvalRuns(agent.identifier, true);
  const runs = runsQuery.data?.runs ?? [];
  const activeRunId = selectedRunId ?? runs[0]?.id ?? null;

  // Full results for the selected/latest run — the list may carry only status;
  // detail is polled while it's still running. Phase 25 D8: live via
  // eval.finished hints, 30s conditional fallback (was 2s).
  const runDetail = useEvalRunDetail(agent.identifier, activeRunId);

  const toggleEnabled = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      api(`/v1/agents/${agent.identifier}/evals/${vars.id}`, {
        method: 'PUT',
        body: { enabled: vars.enabled },
      }),
    onSuccess: invalidateEvals,
    onError: (err) => setActionError(err.message),
  });

  const remove = useMutation({
    mutationFn: (id: string) =>
      api(`/v1/agents/${agent.identifier}/evals/${id}`, { method: 'DELETE' }),
    onSuccess: () => {
      setActionError('');
      invalidateEvals();
    },
    onError: (err) => setActionError(err.message),
  });

  const runEvals = useMutation({
    mutationFn: () =>
      api<{ run?: EvalRun; runId?: string; id?: string }>(
        `/v1/agents/${agent.identifier}/evals/run`,
        { method: 'POST' },
      ),
    onSuccess: (res) => {
      setActionError('');
      setSelectedRunId(res.run?.id ?? res.runId ?? res.id ?? null);
      invalidateRuns();
    },
    onError: (err) => setActionError(err.message),
  });

  const evals = evalsData?.evals ?? [];
  const enabledCount = evals.filter((e) => e.enabled).length;
  const run = runDetail.data?.run ?? runs.find((r) => r.id === activeRunId) ?? null;

  return (
    <div>
      <p className="mb-4 text-[12px] text-t3">
        Evals script a conversation and assert what the agent should do — which tools it calls, what
        its reply contains. Run them after a prompt change to catch regressions before your
        customers do.
      </p>

      {actionError && <p className="mb-3 text-[12px] text-err">{actionError}</p>}

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : evals.length > 0 ? (
        <ul className="space-y-3">
          {evals.map((e) => (
            <li
              key={e.id}
              className="flex items-start justify-between gap-2 border-b border-bd pb-3 last:border-0 last:pb-0"
            >
              <div className="min-w-0">
                <Mono className="text-t1">{e.name}</Mono>
                <span className="mt-0.5 block text-[11px] text-t3">updated {timeAgo(e.updatedAt)}</span>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Toggle
                  checked={e.enabled}
                  onChange={(v) => toggleEnabled.mutate({ id: e.id, enabled: v })}
                  label={`Eval ${e.name} enabled`}
                />
                <Button variant="ghost" onClick={() => setFormFor(e)}>
                  Edit
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (window.confirm(`Delete eval "${e.name}"?`)) remove.mutate(e.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-t3">
          No evals yet. Add one, or use “Save as eval” on a conversation.
        </p>
      )}

      <div className="mt-4 flex items-center justify-between border-t border-bd pt-4">
        <Button
          variant="ghost"
          onClick={() => runEvals.mutate()}
          disabled={runEvals.isPending || enabledCount === 0 || run?.status === 'running'}
          title={enabledCount === 0 ? 'Enable at least one eval to run' : undefined}
        >
          {runEvals.isPending || run?.status === 'running' ? 'Running…' : 'Run evals'}
        </Button>
        <Button variant="primary" onClick={() => setFormFor('new')}>
          New eval
        </Button>
      </div>

      {run && (
        <div className="mt-4 border-t border-bd pt-4">
          <div className="mb-2 flex items-center justify-between">
            <span className="inline-flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-wider text-t3">
              <span
                aria-hidden
                className="inline-block h-[7px] w-[7px] rounded-full"
                style={{ background: runDot(run) }}
              />
              Run {run.status === 'running' ? 'running…' : run.status}
            </span>
            <Mono className="text-t3">{timeAgo(run.finishedAt ?? run.startedAt)}</Mono>
          </div>
          {run.candidate && (
            <p className="mb-2 text-[11px] text-t3">
              Pre-save check — this run graded an edited{' '}
              {run.candidate.systemPrompt !== undefined && run.candidate.model !== undefined
                ? 'system prompt and model'
                : run.candidate.systemPrompt !== undefined
                  ? 'system prompt'
                  : 'model'}
              , not the agent's saved config.
            </p>
          )}
          {run.status === 'running' && !(run.results && run.results.length) ? (
            <Skeleton className="h-16 w-full" />
          ) : run.results && run.results.length > 0 ? (
            <ScenarioResults results={run.results} />
          ) : (
            <p className="text-[12px] text-t3">No scenario results recorded for this run.</p>
          )}
        </div>
      )}

      {runs.length > 0 && (
        <div className="mt-4 border-t border-bd pt-4">
          <p className="mb-2 text-[11px] font-medium uppercase tracking-wider text-t3">Recent runs</p>
          <ul className="space-y-1">
            {runs.slice(0, 5).map((r) => {
              const s = runSummary(r);
              return (
                <li key={r.id}>
                  <button
                    type="button"
                    onClick={() => setSelectedRunId(r.id)}
                    aria-pressed={r.id === activeRunId}
                    className={`flex w-full items-center justify-between gap-2 rounded-md px-2 py-1 text-left transition-colors hover:bg-elevated ${
                      r.id === activeRunId ? 'bg-elevated' : ''
                    }`}
                  >
                    <span className="inline-flex items-center gap-1.5">
                      <span
                        aria-hidden
                        className="inline-block h-[6px] w-[6px] rounded-full"
                        style={{ background: runDot(r) }}
                      />
                      <Mono className="text-t2">
                        {r.status === 'running'
                          ? 'running…'
                          : s.total > 0
                            ? `${s.passed}/${s.total} passed`
                            : r.status}
                      </Mono>
                      {/* A4: a pre-save run graded an edit that may never have
                          been saved — say so, or its numbers read as the
                          agent's. */}
                      {r.trigger === 'pre_save' && (
                        <span
                          title="Ran against an edited prompt or model before it was saved"
                          className="inline-flex items-center rounded-md border border-dashed border-bd px-1.5 py-0.5 text-[11px] text-t3"
                        >
                          pre-save
                        </span>
                      )}
                    </span>
                    <Mono className="text-t3">{timeAgo(r.finishedAt ?? r.startedAt)}</Mono>
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      )}

      {formFor && (
        <EvalFormModal
          agent={agent}
          evalItem={formFor === 'new' ? null : formFor}
          onClose={() => setFormFor(null)}
          onSaved={() => {
            setFormFor(null);
            invalidateEvals();
          }}
        />
      )}
    </div>
  );
}
