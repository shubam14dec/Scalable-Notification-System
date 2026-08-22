// The agent form (shared by the list's create/edit modals and the detail Edit
// tab) plus EditTab — the detail page's Edit panel, which wires the PATCH save
// and the agent-level Rotate secret button (next to Save, per the V1 mockup).
// API paths and react-query keys identical to the former Agents.tsx.
import { useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../../lib/api';
import { Button, Field, Input, Mono } from '../../ui';
import { timeAgo } from '../Activity';
import { SecretReveal, Toggle, useEvalRuns } from './shared';
import { PreSaveCheck } from './PreSaveCheck';
import {
  baselineRun,
  fmtInt,
  routingSummary,
  runAdvisory,
  runSummary,
  type Agent,
  type AgentBody,
  type AgentEval,
  type AgentHealth,
  type AgentRouting,
  type AgentRoutingStats,
  type EvalCandidate,
  type SuggestedPrompt,
} from './types';

export function AgentForm({
  initial,
  pending,
  error,
  submitLabel,
  onSubmit,
  onCancel,
  hideCancel = false,
  footerExtra,
}: {
  initial?: Partial<Agent>;
  pending: boolean;
  error: string;
  submitLabel: string;
  onSubmit: (body: AgentBody) => void;
  onCancel: () => void;
  hideCancel?: boolean;
  footerExtra?: ReactNode;
}) {
  const [runtime, setRuntime] = useState<'bridge' | 'managed'>(initial?.runtime ?? 'bridge');
  const editing = Boolean(initial?.identifier);
  const identifier = initial?.identifier ?? '';
  const queryClient = useQueryClient();

  // Agent-speaks-first config: controlled so the char counters and add/remove
  // rows stay live. Empty here means "clear" (sent as null on save).
  const [welcome, setWelcome] = useState(initial?.welcomeMessage ?? '');
  const [prompts, setPrompts] = useState<SuggestedPrompt[]>(initial?.suggestedPrompts ?? []);

  // Advisory eval gate — only meaningful for an existing managed agent whose
  // prompt we're editing. Polls while a run is in flight.
  const evalGateOn = editing && runtime === 'managed' && Boolean(identifier);
  const runsQuery = useEvalRuns(identifier, evalGateOn);
  const latestRun = evalGateOn ? runsQuery.data?.runs?.[0] ?? null : null;
  const runEvals = useMutation({
    mutationFn: () => api(`/v1/agents/${identifier}/evals/run`, { method: 'POST' }),
    onSuccess: () =>
      void queryClient.invalidateQueries({ queryKey: ['agent-eval-runs', identifier] }),
  });
  // A4: the pre-save check. It needs the agent's enabled evals (same query key
  // the Evals tab uses, so visiting both costs one fetch) and a baseline — the
  // newest finished run of the SAVED config, which the advisory query already
  // has in hand. Nothing here touches the save path itself.
  const evalsQuery = useQuery({
    queryKey: ['agent-evals', identifier],
    queryFn: () => api<{ evals: AgentEval[] }>(`/v1/agents/${identifier}/evals`),
    enabled: evalGateOn,
  });
  const enabledEvals = evalsQuery.data?.evals.filter((e) => e.enabled).length ?? 0;
  const preSaveOn = evalGateOn && enabledEvals > 0;
  const [pendingSave, setPendingSave] = useState<{
    body: AgentBody;
    candidate: EvalCandidate;
  } | null>(null);

  const advisory = latestRun ? runAdvisory(latestRun, timeAgo) : null;
  const advisoryDot = !latestRun
    ? 'var(--t3)'
    : latestRun.status === 'running'
      ? 'var(--info)'
      : advisory!.ok
        ? 'var(--ok)'
        : 'var(--err)';

  // Budget suggestion (Phase 24 D10) — the health window carries 30-day p95
  // daily usage + a suggested budget once ≥7 days of data exist. Only fetched
  // for an existing managed agent; guarded so it stays silent until slice C
  // populates the fields.
  const budgetHintOn = editing && runtime === 'managed' && Boolean(identifier);
  const healthQuery = useQuery({
    queryKey: ['agent-health', identifier, 30],
    queryFn: () => api<AgentHealth>(`/v1/agents/${identifier}/health?days=30`),
    enabled: budgetHintOn,
  });
  const suggested = healthQuery.data?.suggestedDailyTokens;
  const p95Daily = healthQuery.data?.p95DailyTokens;

  // ---- A6: model routing ----
  // The switch is state (the section's copy and the stats strip react to it);
  // the cheap-model id is an ordinary uncontrolled field like Model, read off
  // the form on submit. Switching the router off does NOT wipe the id — it
  // rides along as `enabled: false`, so turning it back on costs no retyping.
  const [routingOn, setRoutingOn] = useState(initial?.routing?.enabled ?? false);
  const routingStats = useQuery({
    queryKey: ['agent-routing-stats', identifier],
    queryFn: () => api<AgentRoutingStats>(`/v1/agents/${identifier}/routing/stats`),
    // Only asked for once the agent EXISTS, is managed, and is actually routing:
    // the numbers describe live traffic, and there is none to describe otherwise.
    enabled: editing && runtime === 'managed' && Boolean(identifier) && routingOn,
  });
  const routingWords = routingStats.data ? routingSummary(routingStats.data) : null;

  /** The routing config this form would save, or null for "off and forgotten". */
  const readRouting = (cheapModel: string): AgentRouting | null =>
    routingOn || cheapModel ? { enabled: routingOn, cheapModel } : null;

  return (
    <>
    <form
      className="space-y-4"
      onSubmit={(e) => {
        e.preventDefault();
        const form = new FormData(e.currentTarget);
        const str = (key: string) => String(form.get(key) ?? '').trim();
        const body: AgentBody = {
          identifier: str('identifier') || initial?.identifier || '',
          name: str('name'),
          description: str('description') || undefined,
          runtime,
        };
        if (runtime === 'bridge') {
          body.bridgeUrl = str('bridgeUrl');
        } else {
          body.model = str('model') || undefined;
          body.systemPrompt = str('systemPrompt') || undefined;
          const maxTokens = Number.parseInt(str('maxTokens'), 10);
          if (Number.isFinite(maxTokens)) body.maxTokens = maxTokens;
          const apiKey = str('llmApiKey');
          const baseUrl = str('llmBaseUrl');
          // On edit, a blank key means "keep the stored one".
          if (apiKey || baseUrl || !editing) {
            body.llm = {
              ...(apiKey ? { apiKey } : {}),
              ...(baseUrl ? { baseUrl } : {}),
            };
          }
          // Daily token budget (G2): blank = off; clearing an existing one → null.
          const maxDaily = Number.parseInt(str('maxDailyTokens'), 10);
          if (Number.isFinite(maxDaily) && maxDaily > 0) {
            body.maxDailyTokens = maxDaily;
          } else if (editing && initial?.maxDailyTokens != null) {
            body.maxDailyTokens = null;
          }
          // Rolling-summary knobs (D6): only sent when at least one is set.
          const triggerTurns = Number.parseInt(str('triggerTurns'), 10);
          const tailTurns = Number.parseInt(str('tailTurns'), 10);
          const context: { triggerTurns?: number; tailTurns?: number } = {};
          if (Number.isFinite(triggerTurns) && triggerTurns > 0) context.triggerTurns = triggerTurns;
          if (Number.isFinite(tailTurns) && tailTurns > 0) context.tailTurns = tailTurns;
          if (Object.keys(context).length > 0) body.context = context;
          // A6 routing: same rule maxDailyTokens follows — send the config when
          // there is one, send an explicit null only on an EDIT (create has
          // nothing to clear, and its schema rejects null), send nothing at all
          // for a brand-new agent that never touched the switch.
          const nextRouting = readRouting(str('cheapModel'));
          if (nextRouting) {
            body.routing = nextRouting;
          } else if (editing && initial?.routing) {
            body.routing = null;
          }
        }
        const arHours = Number.parseInt(str('autoResolveH'), 10);
        const arMins = Number.parseInt(str('autoResolveM'), 10);
        const totalMinutes =
          (Number.isFinite(arHours) ? arHours * 60 : 0) + (Number.isFinite(arMins) ? arMins : 0);
        if (totalMinutes > 0) {
          body.autoResolveMinutes = totalMinutes;
        } else if (editing && initial?.autoResolveMinutes) {
          body.autoResolveMinutes = null; // both cleared = backstop off
        }
        // Welcome + prompts always travel (null clears) so an emptied field saves.
        body.welcomeMessage = welcome.trim() ? welcome.trim() : null;
        const cleanPrompts = prompts
          .map((p) => ({ title: p.title.trim(), message: p.message.trim() }))
          .filter((p) => p.title && p.message)
          .slice(0, 6);
        body.suggestedPrompts = cleanPrompts.length ? cleanPrompts : null;

        // A4 PRE-SAVE CHECK — a managed agent with enabled evals whose PROMPT,
        // MODEL or (A6) MODEL ROUTING actually changed gets those evals run
        // against the EDITED values before the save commits. The panel owns the
        // rest of this save: it calls back with `body` untouched (Save / Save
        // anyway) or drops it (Cancel). Supersedes the confirm() advisory below
        // for this one case — two warnings about the same edit is one too many.
        // Every other save (bridge, no enabled evals, nothing behavioral
        // changed) falls through to the pre-A4 path below, byte for byte.
        if (preSaveOn) {
          const nextPrompt = str('systemPrompt');
          const nextModel = str('model');
          const candidate: EvalCandidate = {};
          // Only CHANGED keys ride along, and only non-empty ones: the server
          // caps a candidate field at 1..N, so "cleared to blank" is not an
          // override to grade — that save takes the normal path.
          if (nextPrompt && nextPrompt !== (initial?.systemPrompt ?? '').trim()) {
            candidate.systemPrompt = nextPrompt;
          }
          if (nextModel && nextModel !== (initial?.model ?? '').trim()) {
            candidate.model = nextModel;
          }
          // A6: enabling the router, disabling it, or swapping the cheap model
          // all change which model writes the reply — a behavior change exactly
          // like a prompt edit, so it rides the SAME candidate the check grades
          // and the run really executes through the edited router. Sent even
          // when the new value is "off" (an explicit null), because "does it
          // still pass with routing off?" is a real question to ask of a save
          // that switches routing off.
          const nextRouting = readRouting(str('cheapModel'));
          const prev = initial?.routing ?? null;
          const changed =
            (prev?.enabled ?? false) !== (nextRouting?.enabled ?? false) ||
            (prev?.cheapModel ?? '') !== (nextRouting?.cheapModel ?? '');
          if (changed) candidate.routing = nextRouting;
          if (
            candidate.systemPrompt !== undefined ||
            candidate.model !== undefined ||
            'routing' in candidate
          ) {
            setPendingSave({ body, candidate });
            return;
          }
        }

        // Advisory eval gate (never a hard block): if the latest run failed, or
        // the prompt changed since it ran (so the run tested a different
        // version), ask once before saving.
        if (evalGateOn && latestRun && latestRun.status !== 'running') {
          const currentPrompt = str('systemPrompt');
          const promptDirty = (initial?.systemPrompt ?? '').trim() !== currentPrompt;
          const s = runSummary(latestRun);
          const hasFailures =
            latestRun.status === 'failed' || latestRun.status === 'error' || s.failed > 0;
          const runPredatesSave =
            !!initial?.updatedAt &&
            !!latestRun.finishedAt &&
            new Date(latestRun.finishedAt).getTime() < new Date(initial.updatedAt).getTime();
          if (
            (hasFailures || promptDirty || runPredatesSave) &&
            !window.confirm("Evals haven't passed for this version — save anyway?")
          ) {
            return;
          }
        }
        onSubmit(body);
      }}
    >
      {!editing && (
        <Field label="Identifier" hint="Stable id used by the widget and SDK — cannot change later">
          <Input name="identifier" required autoFocus placeholder="support" className="font-mono" pattern="[a-z0-9-_]+" />
        </Field>
      )}
      <Field label="Name">
        <Input name="name" required placeholder="Support agent" defaultValue={initial?.name} />
      </Field>

      <Field label="Runtime" hint="Who answers each message">
        <select
          aria-label="Runtime"
          className="h-8 w-full rounded-md border border-bd bg-transparent px-2 text-[13px] text-t1 hover:border-bd-strong"
          value={runtime}
          onChange={(e) => setRuntime(e.target.value as 'bridge' | 'managed')}
        >
          <option value="bridge" className="bg-surface">Your code — we POST turns to your bridge URL</option>
          <option value="managed" className="bg-surface">Managed LLM — we run the model, zero code</option>
        </select>
      </Field>

      {runtime === 'bridge' ? (
        <Field label="Bridge URL" hint="Where your handler listens — we POST every conversation turn here, signed">
          <Input
            name="bridgeUrl"
            required
            type="url"
            placeholder="https://app.example.com/asyncify-agent"
            defaultValue={initial?.bridgeUrl ?? ''}
            className="font-mono"
          />
        </Field>
      ) : (
        <>
          <Field label="System prompt" hint="The agent's role, tone, and boundaries — runs on every turn">
            <textarea
              name="systemPrompt"
              rows={5}
              placeholder="You are the Acme support agent. Be brief and friendly…"
              defaultValue={initial?.systemPrompt ?? ''}
              className="w-full rounded-md border border-bd bg-transparent px-2.5 py-2 text-[13px] text-t1 placeholder:text-t3 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong"
            />
          </Field>
          <Field label="Model" hint="Defaults to claude-opus-4-8; use your endpoint's model id if you set a base URL">
            <Input name="model" placeholder="claude-opus-4-8" defaultValue={initial?.model ?? ''} className="font-mono" />
          </Field>
          <Field label="Max reply tokens" hint="Per-reply output cap, 256–8192 (blank = 1024). Controls spend on your key">
            <Input
              name="maxTokens"
              type="number"
              min={256}
              max={8192}
              placeholder="1024"
              defaultValue={initial?.maxTokens ?? ''}
              className="font-mono"
            />
          </Field>
          <Field
            label="Daily token budget"
            hint="Circuit breaker, not a quota — size it ~4x a busy day (see Health for tokens/turn)."
          >
            <Input
              name="maxDailyTokens"
              type="number"
              min={1}
              placeholder="off"
              defaultValue={initial?.maxDailyTokens ?? ''}
              className="font-mono"
            />
          </Field>
          {budgetHintOn && suggested != null && (
            <p className="-mt-2 text-[11px] text-t3">
              30-day p95 daily usage:{' '}
              <Mono className="text-t2">{fmtInt(p95Daily)}</Mono> · suggested budget:{' '}
              <Mono className="text-t2">{fmtInt(suggested)}</Mono>
            </p>
          )}
          <Field
            label="API key"
            hint={
              initial?.hasLlmKey
                ? 'A key is stored — leave blank to keep it, paste to replace'
                : 'Stored encrypted, never shown again'
            }
          >
            <Input
              name="llmApiKey"
              type="password"
              autoComplete="off"
              required={runtime === 'managed' && !initial?.hasLlmKey}
              placeholder={initial?.hasLlmKey ? '••••••••  (kept)' : 'sk-ant-… or your provider key'}
              className="font-mono"
            />
          </Field>
          <Field
            label="Base URL"
            hint="Optional — any Anthropic-compatible endpoint (e.g. z.ai). Blank = api.anthropic.com"
          >
            <Input
              name="llmBaseUrl"
              type="url"
              placeholder="https://api.z.ai/api/anthropic"
              defaultValue={initial?.llmBaseUrl ?? ''}
              className="font-mono"
            />
          </Field>

          {/* Phase A6 — model routing. Managed only: it lives inside this
              branch, so a bridge agent never sees the section at all. */}
          <div className="space-y-3 rounded-md border border-bd bg-elevated px-3 py-3">
            <div className="flex items-start justify-between gap-3">
              <div>
                <span className="block text-[12px] font-medium text-t2">Model routing</span>
                <span className="mt-0.5 block text-[11px] text-t3">
                  Answer the easy messages on a cheaper model. Simple replies are handled by the
                  smaller model; anything that needs a real action — a refund, a workflow, a
                  knowledge lookup — automatically runs on your main model instead.
                </span>
              </div>
              <Toggle checked={routingOn} onChange={setRoutingOn} label="Model routing enabled" />
            </div>
            <Field
              label="Cheap model"
              hint="Must be a model your LLM endpoint already serves — routing uses this agent's own key and base URL. Getting the id wrong is safe: every reply just runs on the main model."
            >
              <Input
                name="cheapModel"
                required={routingOn}
                placeholder="claude-haiku-4-5"
                defaultValue={initial?.routing?.cheapModel ?? ''}
                className="font-mono"
              />
            </Field>
            {/* The stats strip — what routing actually did, in words. */}
            {routingOn && editing && routingStats.isSuccess && (
              <div className="space-y-1 border-t border-bd pt-3">
                {routingWords ? (
                  <>
                    <p className="text-[11px] text-t2">
                      Last {routingStats.data.windowDays} days ·{' '}
                      <Mono className="text-t2">{fmtInt(routingStats.data.replies)}</Mono> replies
                    </p>
                    <p className="text-[11px] text-t2">
                      {routingWords.cheap} · {routingWords.escalated}
                    </p>
                    {routingWords.unrouted && (
                      <p className="text-[11px] text-t3">{routingWords.unrouted}</p>
                    )}
                  </>
                ) : (
                  <p className="text-[11px] text-t3">
                    No routed replies in the last {routingStats.data.windowDays} days.
                  </p>
                )}
                <p className="text-[11px] text-t3">
                  Canary-trial replies always use the trial's own model, so they're not counted
                  here.
                </p>
              </div>
            )}
          </div>

          {/* Phase 24 D6 — rolling-summary knobs. Blank uses the defaults. */}
          <div className="space-y-3 rounded-md border border-bd bg-elevated px-3 py-3">
            <div>
              <span className="block text-[12px] font-medium text-t2">
                Advanced — long conversations
              </span>
              <span className="mt-0.5 block text-[11px] text-t3">
                On long chats the agent condenses older turns into a running summary to stay fast and
                in budget. Blank uses the defaults (summarize after 20 turns, keep the last 10
                verbatim).
              </span>
            </div>
            <Field
              label="Summarize after N turns"
              hint="Fold older turns into a summary once the conversation passes this many turns."
            >
              <Input
                name="triggerTurns"
                type="number"
                min={1}
                placeholder="20"
                defaultValue={initial?.context?.triggerTurns ?? ''}
                className="font-mono"
              />
            </Field>
            <Field
              label="Keep last N turns verbatim"
              hint="How many recent turns stay word-for-word after a summary is made."
            >
              <Input
                name="tailTurns"
                type="number"
                min={1}
                placeholder="10"
                defaultValue={initial?.context?.tailTurns ?? ''}
                className="font-mono"
              />
            </Field>
          </div>
        </>
      )}

      <Field
        label="Auto-resolve after inactivity"
        hint="Conversations idle this long resolve automatically (up to 720h). Blank = never — a new message always reopens"
      >
        <div className="flex items-center gap-2">
          <Input
            name="autoResolveH"
            type="number"
            min={0}
            max={720}
            placeholder="0"
            aria-label="Hours"
            defaultValue={
              initial?.autoResolveMinutes ? Math.floor(initial.autoResolveMinutes / 60) || '' : ''
            }
            className="font-mono"
          />
          <span className="shrink-0 text-[12px] text-t3">hours</span>
          <Input
            name="autoResolveM"
            type="number"
            min={0}
            max={59}
            placeholder="0"
            aria-label="Minutes"
            defaultValue={initial?.autoResolveMinutes ? initial.autoResolveMinutes % 60 || '' : ''}
            className="font-mono"
          />
          <span className="shrink-0 text-[12px] text-t3">min</span>
        </div>
      </Field>
      <Field label="Description">
        <Input name="description" placeholder="What this agent handles (optional)" defaultValue={initial?.description ?? ''} />
      </Field>

      {/* Agent-speaks-first — used by the in-app chat widget. */}
      <div>
        <span className="mb-1.5 block text-[12px] font-medium text-t2">Welcome message</span>
        <textarea
          value={welcome}
          onChange={(e) => setWelcome(e.target.value.slice(0, 2000))}
          maxLength={2000}
          rows={3}
          placeholder="Hi! I'm the Acme assistant — ask me anything about your account."
          className="w-full rounded-md border border-bd bg-transparent px-2.5 py-2 text-[13px] text-t1 placeholder:text-t3 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong"
        />
        <div className="mt-1 flex items-center justify-between">
          <span className="text-[11px] text-t3">
            The agent's opening line when a chat starts — blank sends nothing.
          </span>
          <Mono className="text-t3">{welcome.length}/2000</Mono>
        </div>
      </div>

      <div>
        <span className="mb-1.5 block text-[12px] font-medium text-t2">Suggested prompts</span>
        <p className="mb-2 text-[11px] text-t3">
          Up to 6 starter chips shown under the welcome — the title is the chip, the message is
          what it sends. Empty saves none.
        </p>
        {prompts.length > 0 && (
          <div className="space-y-2">
            {prompts.map((p, i) => (
              <div key={i} className="flex items-start gap-2">
                <div className="flex-1">
                  <Input
                    value={p.title}
                    maxLength={40}
                    placeholder="Reset password"
                    aria-label={`Prompt ${i + 1} title`}
                    onChange={(e) => {
                      const title = e.target.value.slice(0, 40);
                      setPrompts((prev) => prev.map((q, j) => (j === i ? { ...q, title } : q)));
                    }}
                  />
                  <div className="mt-1 text-right">
                    <Mono className="text-t3">{p.title.length}/40</Mono>
                  </div>
                </div>
                <div className="flex-[2]">
                  <Input
                    value={p.message}
                    maxLength={200}
                    placeholder="How do I reset my password?"
                    aria-label={`Prompt ${i + 1} message`}
                    onChange={(e) => {
                      const message = e.target.value.slice(0, 200);
                      setPrompts((prev) => prev.map((q, j) => (j === i ? { ...q, message } : q)));
                    }}
                  />
                  <div className="mt-1 text-right">
                    <Mono className="text-t3">{p.message.length}/200</Mono>
                  </div>
                </div>
                <button
                  type="button"
                  aria-label={`Remove prompt ${i + 1}`}
                  onClick={() => setPrompts((prev) => prev.filter((_, j) => j !== i))}
                  className="h-8 shrink-0 px-1.5 text-[12px] text-t3 transition-colors hover:text-t1"
                >
                  Remove
                </button>
              </div>
            ))}
          </div>
        )}
        {prompts.length < 6 && (
          <button
            type="button"
            onClick={() => setPrompts((prev) => [...prev, { title: '', message: '' }])}
            className="mt-2 text-[12px] text-t3 transition-colors hover:text-t1"
          >
            + Add prompt
          </button>
        )}
      </div>

      {evalGateOn && (
        <div className="flex items-center justify-between gap-3 border-t border-bd pt-4">
          <span className="inline-flex min-w-0 items-center gap-1.5">
            <span
              aria-hidden
              className="inline-block h-[7px] w-[7px] shrink-0 rounded-full"
              style={{ background: advisoryDot }}
            />
            <Mono className="truncate text-t3">{advisory ? advisory.text : 'evals: none run yet'}</Mono>
          </span>
          <Button
            type="button"
            onClick={() => runEvals.mutate()}
            disabled={runEvals.isPending || latestRun?.status === 'running'}
          >
            {runEvals.isPending || latestRun?.status === 'running' ? 'Running…' : 'Run evals'}
          </Button>
        </div>
      )}

      {/* A4: the quiet counterpart to the check — an agent with no enabled eval
          has nothing to check a prompt edit against, and should know it. */}
      {evalGateOn && evalsQuery.isSuccess && enabledEvals === 0 && (
        <p className="-mt-2 text-[11px] text-t3">
          No evals enabled — with one, a prompt or model edit is run against it before Save
          commits.
        </p>
      )}

      {error && <p className="text-[12px] text-err">{error}</p>}
      <div className="flex items-center justify-end gap-2">
        {footerExtra}
        {!hideCancel && (
          <Button type="button" onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
    {/* Outside the <form> on purpose: a nested submit button would re-fire this
        save. Cancel just drops the pending body — the edit stays in the fields. */}
    {pendingSave && (
      <PreSaveCheck
        identifier={identifier}
        candidate={pendingSave.candidate}
        baseline={baselineRun(runsQuery.data?.runs ?? [])}
        evalCount={enabledEvals}
        onSave={() => {
          const body = pendingSave.body;
          setPendingSave(null);
          onSubmit(body);
        }}
        onCancel={() => setPendingSave(null)}
      />
    )}
    </>
  );
}

/** Detail page Edit tab — full AgentForm + save (PATCH) + agent-level rotate. */
export function EditTab({ agent }: { agent: Agent }) {
  const queryClient = useQueryClient();
  const [error, setError] = useState('');
  const [secret, setSecret] = useState('');

  const update = useMutation({
    mutationFn: ({ identifier, ...body }: Partial<AgentBody> & { identifier: string }) =>
      api(`/v1/agents/${identifier}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setError('');
      void queryClient.invalidateQueries({ queryKey: ['agents'] });
    },
    onError: (err) => setError(err.message),
  });

  const rotate = useMutation({
    mutationFn: (identifier: string) =>
      api<{ signingSecret: string }>(`/v1/agents/${identifier}/rotate-secret`, { method: 'POST' }),
    onSuccess: (res) => setSecret(res.signingSecret),
  });

  return (
    <div className="max-w-xl">
      <AgentForm
        initial={agent}
        pending={update.isPending}
        error={error}
        submitLabel="Save changes"
        hideCancel
        footerExtra={
          <Button type="button" onClick={() => rotate.mutate(agent.identifier)}>
            Rotate secret
          </Button>
        }
        onSubmit={(body) =>
          update.mutate({
            identifier: agent.identifier,
            name: body.name,
            description: body.description,
            runtime: body.runtime,
            bridgeUrl: body.bridgeUrl,
            model: body.model,
            systemPrompt: body.systemPrompt,
            maxTokens: body.maxTokens,
            autoResolveMinutes: body.autoResolveMinutes,
            welcomeMessage: body.welcomeMessage,
            suggestedPrompts: body.suggestedPrompts,
            maxDailyTokens: body.maxDailyTokens,
            context: body.context,
            routing: body.routing,
            llm: body.llm,
          })
        }
        onCancel={() => {}}
      />
      {secret && <SecretReveal secret={secret} onClose={() => setSecret('')} />}
    </div>
  );
}
