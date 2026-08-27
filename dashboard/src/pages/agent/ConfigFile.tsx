// Phase A10 slice C — config as code, on the surface.
//
// Three controls over the routes slice B shipped:
//   · Export agent   (detail header) → downloads <identifier>.agent.json
//   · Import agent   (list page)     → paste/upload → preview → apply
//   · Promote to…    (detail header) → export here, preview THERE, apply there
//
// THE LABELS RULE: this file renders what the API says and nothing it inferred.
// The one place that matters most is `toolChanges.removed`. The server states
// `removalPolicy: 'kept'` precisely so a dashboard cannot render that list as a
// threat — an import deletes NOTHING, and the words below say so out loud.
import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api, fetchMe, session, type Environment } from '../../lib/api';
import { Button, CopyField, Field, Input, Modal, Mono, Spinner } from '../../ui';
import { PreSaveCheck } from './PreSaveCheck';
import { baselineRun, type AgentEval, type EvalCandidate, type EvalRun } from './types';

/* -------------------------------------------------------------------------- */
/* The wire shapes (hand-kept copies)                                          */
/* -------------------------------------------------------------------------- */

/**
 * HAND-KEPT COPY of the server's `AgentConfigFileSchema`
 * (src/core/agent-config-file.ts). The dashboard is a separate app and cannot
 * import server types.
 *
 * Only the fields this surface actually reads are named. The rest ride through
 * untouched under the index signature — which is the point of the format: the
 * dashboard is a courier for the file, not an editor of it, so a field added
 * server-side keeps promoting correctly without a dashboard release.
 */
export interface AgentConfigFile {
  identifier: string;
  name: string;
  runtime: 'bridge' | 'managed';
  systemPrompt?: string;
  model?: string;
  [key: string]: unknown;
}

/** One config field's fate. `field` is a server `CONFIG_FIELDS` member. */
export interface ConfigChange {
  field: string;
  action: 'added' | 'changed' | 'removed' | 'unchanged';
}

export interface ImportPreview {
  identifier: string;
  mode: 'create' | 'update';
  changes: ConfigChange[];
  toolChanges: { added: string[]; changed: string[]; removed: string[] };
  /** Always 'kept'. Read, never assumed — see the header note. */
  removalPolicy: string;
  missingWorkflows: string[];
  missingKnowledge: string[];
  needsLlmKey: boolean;
}

export interface ImportResult {
  mode: 'create' | 'update';
  agent: { identifier: string; name: string };
  /** Create only, shown ONCE. */
  signingSecret?: string;
  tools: { created: Array<{ name: string; secret: string }>; updated: string[]; kept: string[] };
  missingKnowledge: string[];
}

/**
 * Plain-English names for the server's config fields. A field with no entry
 * falls through to its raw key rather than being hidden: the server owns
 * `CONFIG_FIELDS`, and a dashboard that silently dropped a field it had not
 * been taught about would under-report a diff — the one failure this whole
 * feature exists to prevent.
 */
const FIELD_LABELS: Record<string, string> = {
  name: 'Name',
  description: 'Description',
  runtime: 'Runtime',
  bridgeUrl: 'Bridge URL',
  model: 'Model',
  systemPrompt: 'System prompt',
  llmBaseUrl: 'LLM base URL',
  context: 'Rolling summary',
  welcomeMessage: 'Welcome message',
  suggestedPrompts: 'Suggested prompts',
  routing: 'Model routing',
  topics: 'Topic gate',
  moderation: 'Reply rules',
  subscriberRate: 'Per-customer message limit',
  maxTokens: 'Reply cap',
  maxDailyTokens: 'Daily token budget',
  autoResolveMinutes: 'Auto-resolve after idle',
};

const fieldLabel = (field: string) => FIELD_LABELS[field] ?? field;

/* -------------------------------------------------------------------------- */
/* Export                                                                      */
/* -------------------------------------------------------------------------- */

/** The file for one agent. `envId` reads from a SIBLING environment (promote). */
export function fetchAgentFile(identifier: string, envId?: string): Promise<AgentConfigFile> {
  return api<AgentConfigFile>(`/v1/agents/${encodeURIComponent(identifier)}/export`, { envId });
}

/**
 * Hand the file to the browser. The export route's body IS the file, so this
 * re-serializes what we already parsed rather than streaming the response —
 * two extra milliseconds, and it keeps the download on the same authenticated
 * `api()` path as everything else (a bare <a href> would carry no token).
 */
function downloadJson(file: unknown, filename: string): void {
  const url = URL.createObjectURL(
    new Blob([`${JSON.stringify(file, null, 2)}\n`], { type: 'application/json' }),
  );
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Next tick: revoking synchronously races the download in Safari.
  setTimeout(() => URL.revokeObjectURL(url), 0);
}

export function ExportAgentButton({ identifier }: { identifier: string }) {
  const [error, setError] = useState('');
  const exportIt = useMutation({
    mutationFn: () => fetchAgentFile(identifier),
    onSuccess: (file) => {
      setError('');
      downloadJson(file, `${identifier}.agent.json`);
    },
    onError: (err: Error) => setError(err.message),
  });

  return (
    <div className="relative">
      <Button
        onClick={() => exportIt.mutate()}
        disabled={exportIt.isPending}
        title="Download this agent's whole config as one JSON file — no secrets in it"
      >
        {exportIt.isPending ? 'Exporting…' : 'Export agent'}
      </Button>
      {error && (
        <span className="absolute right-0 top-full mt-1 whitespace-nowrap text-[11px] text-err">
          {error}
        </span>
      )}
    </div>
  );
}

/* -------------------------------------------------------------------------- */
/* Promote to…                                                                 */
/* -------------------------------------------------------------------------- */

/**
 * The org's OTHER environments, from the session's own `/auth/me` payload —
 * no new endpoint, and the list is exactly the set the environment switcher
 * offers, so a target that appears here is one the user is already a member of.
 */
function useSiblingEnvironments(): Environment[] {
  // The SAME key and fetcher the Shell's environment switcher uses, so this
  // reads a cache that is already warm behind every page — the menu costs no
  // request, and the two can never disagree about which environments exist.
  const me = useQuery({ queryKey: ['me'], queryFn: fetchMe, retry: false });
  const current = session.envId;
  return (me.data?.organizations ?? [])
    .flatMap((o) => o.environments)
    .filter((e) => e.id !== current);
}

/**
 * Promote to… — the menu.
 *
 * No shared dropdown exists in this dashboard; this follows the one real menu
 * precedent (WorkflowCanvas's AddButton): local open state, a portal to
 * document.body so the header's overflow cannot clip it, outside-mousedown and
 * Escape to close, role="menu"/"menuitem".
 */
function PromoteMenu({ onPick }: { onPick: (env: Environment) => void }) {
  const environments = useSiblingEnvironments();
  const [open, setOpen] = useState(false);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const anchor = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    // The menu lives in a portal, so it is NOT inside the anchor — a mousedown
    // on an item must not count as "outside" (it would unmount the menu before
    // mouseup, and the item's click would never fire). Same pair of checks as
    // WorkflowCanvas's AddButton, this menu's precedent.
    const close = (e: MouseEvent) => {
      if (
        !anchor.current?.contains(e.target as Node) &&
        !menuRef.current?.contains(e.target as Node)
      ) {
        setOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('mousedown', close);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', close);
      window.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // Nothing to promote to: one environment means no destination, and a menu
  // that opens onto "(none)" is worse than a control that isn't there.
  if (environments.length === 0) return null;

  return (
    <>
      <button
        ref={anchor}
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setRect(anchor.current?.getBoundingClientRect() ?? null);
          setOpen((v) => !v);
        }}
        className="inline-flex h-8 items-center justify-center gap-1.5 whitespace-nowrap rounded-md border border-bd bg-transparent px-3 text-[13px] font-medium text-t1 transition-colors duration-150 hover:border-bd-strong hover:bg-elevated"
      >
        Promote to… <span aria-hidden className="text-t3">▾</span>
      </button>
      {open &&
        rect &&
        createPortal(
          <div
            ref={menuRef}
            role="menu"
            className="fixed z-50 w-[220px] rounded-lg border border-bd bg-surface p-1 shadow-lg"
            style={{
              top: rect.bottom + 6,
              // Right-aligned to the button, clamped into the viewport.
              left: Math.max(8, Math.min(rect.right - 220, window.innerWidth - 228)),
              animation: 'modal-in 150ms ease',
            }}
          >
            {environments.map((env) => (
              <button
                key={env.id}
                role="menuitem"
                type="button"
                onClick={() => {
                  setOpen(false);
                  onPick(env);
                }}
                className="block w-full rounded-md px-2.5 py-1.5 text-left text-[13px] text-t1 transition-colors hover:bg-elevated"
              >
                {env.name}
              </button>
            ))}
          </div>,
          document.body,
        )}
    </>
  );
}

/**
 * The detail header's config-as-code pair. Export always; Promote only when the
 * user has somewhere to promote to.
 */
export function AgentConfigActions({ identifier }: { identifier: string }) {
  const [target, setTarget] = useState<{ env: Environment; file: AgentConfigFile } | null>(null);
  const [error, setError] = useState('');

  const start = useMutation({
    mutationFn: async (env: Environment) => ({ env, file: await fetchAgentFile(identifier) }),
    onSuccess: (loaded) => {
      setError('');
      setTarget(loaded);
    },
    onError: (err: Error) => setError(`Couldn't read this agent's config — ${err.message}`),
  });

  return (
    <>
      <ExportAgentButton identifier={identifier} />
      <PromoteMenu onPick={(env) => start.mutate(env)} />
      {start.isPending && <Spinner />}
      {error && <span className="text-[11px] text-err">{error}</span>}
      {target && (
        <ConfigImportModal
          seedFile={target.file}
          target={target.env}
          onClose={() => setTarget(null)}
        />
      )}
    </>
  );
}

/* -------------------------------------------------------------------------- */
/* Import / promote — the preview modal                                        */
/* -------------------------------------------------------------------------- */

/** The list page's button; owns the paste-or-upload step. */
export function ImportAgentButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button onClick={() => setOpen(true)}>Import agent</Button>
      {open && <ConfigImportModal onClose={() => setOpen(false)} />}
    </>
  );
}

type Stage = 'file' | 'preview' | 'presave' | 'done';

/**
 * One modal, two entry points.
 *
 *  · Import (list page): opens on the file step, applies to the CURRENT env.
 *  · Promote (detail header): opens with the file already exported from here,
 *    and previews + applies against `target` — a sibling environment.
 *
 * The cross-environment calls are ordinary dashboard requests carrying an
 * explicit `x-environment-id`. That is not a hole: the access token identifies
 * the USER, and the server resolves the environment and checks the user's
 * membership of its organization on every request (src/api/auth.ts), so naming
 * a sibling env can only reach environments the switcher would also offer.
 */
function ConfigImportModal({
  seedFile,
  target,
  onClose,
}: {
  seedFile?: AgentConfigFile;
  target?: Environment;
  onClose: () => void;
}) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const envId = target?.id;
  const where = target ? target.name : 'this environment';

  const [stage, setStage] = useState<Stage>(seedFile ? 'preview' : 'file');
  const [text, setText] = useState(seedFile ? JSON.stringify(seedFile, null, 2) : '');
  const [file, setFile] = useState<AgentConfigFile | null>(seedFile ?? null);
  const [parseError, setParseError] = useState('');
  const [llmApiKey, setLlmApiKey] = useState('');
  const [result, setResult] = useState<ImportResult | null>(null);

  /* ---- preview ---- */
  //
  // The preview's UI state is COMPONENT state written by the callbacks, never
  // the mutation's own `isPending`/`data`. A mutation fired from the mount
  // effect below resolves detached in dev: StrictMode's simulated unmount drops
  // the observer's last listener, TanStack detaches the observer from the
  // in-flight mutation, and nothing re-attaches it on resubscribe — callbacks
  // still run, but `isPending` freezes at true and the modal spins forever
  // (caught in A10 manual E2E; PreSaveCheck's setRunId-in-onSuccess is the
  // same pattern, there by accident).
  const [previewOutcome, setPreviewOutcome] = useState<
    { data?: ImportPreview; error?: Error } | null
  >(null);
  const preview = useMutation({
    mutationFn: (body: AgentConfigFile) =>
      api<ImportPreview>('/v1/agents/import/preview', {
        method: 'POST',
        body: { file: body },
        envId,
      }),
    onSuccess: (d) => setPreviewOutcome({ data: d }),
    onError: (err: Error) => setPreviewOutcome({ error: err }),
  });
  const previewData = previewOutcome?.data ?? null;
  const previewError = previewOutcome?.error ?? null;
  const previewPending = previewOutcome === null;
  const identifier = previewData?.identifier ?? file?.identifier ?? '';

  // Promote opens straight on the preview with the file already in hand, so
  // nothing has asked the target what it would do yet. Fire once — the ref, not
  // the mutation's own state, is the guard, because StrictMode runs effects
  // twice in dev and this is a POST (the same reason PreSaveCheck uses one).
  const previewStarted = useRef(false);
  const previewMutate = preview.mutate;
  useEffect(() => {
    if (!seedFile || previewStarted.current) return;
    previewStarted.current = true;
    previewMutate(seedFile);
  }, [seedFile, previewMutate]);

  /* ---- apply ---- */
  const apply = useMutation({
    mutationFn: () =>
      api<ImportResult>('/v1/agents/import', {
        method: 'POST',
        body: { file, ...(llmApiKey.trim() ? { llmApiKey: llmApiKey.trim() } : {}) },
        envId,
      }),
    onSuccess: (res) => {
      setResult(res);
      setStage('done');
      // Only the CURRENT environment's caches are ours to refresh; a promote
      // wrote somewhere this app is not looking.
      if (!envId) void queryClient.invalidateQueries({ queryKey: ['agents'] });

      // Land on the agent — but ONLY when this import has nothing the operator
      // can never get back. Tool and signing secrets are shown exactly once, so
      // navigating past them would destroy them; when there are any (or a
      // warning still to read), the done step holds the screen until they say
      // so. A promote also stays put: its agent lives in another environment.
      const oneTimeSecrets = res.signingSecret || res.tools.created.length > 0;
      if (!envId && !oneTimeSecrets && res.missingKnowledge.length === 0) {
        navigate(`/agents/${encodeURIComponent(res.agent.identifier)}`);
        onClose();
      }
    },
  });

  /* ---- the pre-save gate (A7 doctrine: warn, never block) ---- */
  //
  // An import that rewrites a live agent's prompt or model is a config save
  // like any other, so it earns the same check the editor gets. The gate is
  // the caller's job (both existing PreSaveCheck callers fetch this too).
  const brainChanged = (previewData?.changes ?? []).some(
    (c) => (c.field === 'systemPrompt' || c.field === 'model') && c.action !== 'unchanged',
  );
  const gateApplies = previewData?.mode === 'update' && brainChanged;

  const evalsQuery = useQuery({
    queryKey: ['agent-evals', identifier, envId ?? 'current'],
    queryFn: () =>
      api<{ evals: AgentEval[] }>(`/v1/agents/${encodeURIComponent(identifier)}/evals`, { envId }),
    enabled: gateApplies && Boolean(identifier),
  });
  const enabledEvals = (evalsQuery.data?.evals ?? []).filter((e) => e.enabled).length;

  const runsQuery = useQuery({
    queryKey: ['agent-eval-runs', identifier],
    queryFn: () =>
      api<{ runs: EvalRun[] }>(`/v1/agents/${encodeURIComponent(identifier)}/evals/runs`),
    // Same-environment only: this feeds PreSaveCheck's baseline, and PreSaveCheck
    // runs here. See the cross-env note below.
    enabled: gateApplies && !envId && enabledEvals > 0 && Boolean(identifier),
  });

  /**
   * PreSaveCheck runs the agent's evals in the CURRENT environment — its own
   * request, its own react-query keys, its own baseline. Pointing it at a
   * sibling environment would mean threading an env through the run, the
   * polling detail hook and every cache key those share with the Evals tab,
   * where two environments' runs would then collide under one key.
   *
   * So the check runs for a same-environment import, and a cross-environment
   * promote gets the honest thing instead: the warning below, with the target's
   * REAL enabled-eval count (read from the target), and a commit button that
   * names the risk. A check that silently graded the wrong environment's agent
   * would be worse than no check.
   */
  const gateIsResolving = gateApplies && evalsQuery.isPending && evalsQuery.fetchStatus !== 'idle';
  const preSaveRuns = gateApplies && !envId && enabledEvals > 0;
  const crossEnvEvalWarning = gateApplies && Boolean(envId) && enabledEvals > 0;

  const candidate: EvalCandidate = {
    ...(typeof file?.systemPrompt === 'string' ? { systemPrompt: file.systemPrompt } : {}),
    ...(typeof file?.model === 'string' ? { model: file.model } : {}),
  };

  function readFile(f: File) {
    void f.text().then((t) => {
      setText(t);
      parse(t);
    });
  }

  function parse(raw: string) {
    setParseError('');
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      setParseError(`That isn't valid JSON — ${(e as Error).message}`);
      return;
    }
    const asFile = parsed as AgentConfigFile;
    setFile(asFile);
    setStage('preview');
    setPreviewOutcome(null);
    preview.mutate(asFile);
  }

  function commit() {
    if (preSaveRuns) {
      setStage('presave');
      return;
    }
    apply.mutate();
  }

  // The pre-save check is a modal of its own; showing it means showing ONLY it.
  if (stage === 'presave') {
    return (
      <PreSaveCheck
        identifier={identifier}
        candidate={candidate}
        baseline={baselineRun(runsQuery.data?.runs ?? [])}
        evalCount={enabledEvals}
        onSave={() => {
          setStage('preview');
          apply.mutate();
        }}
        // Cancel abandons the import outright — the file is still on disk, and
        // an operator who just saw a regression should not land back on a modal
        // whose only remaining button is Apply.
        onCancel={onClose}
      />
    );
  }

  const title = target
    ? `Promoting to ${target.name}`
    : stage === 'done'
      ? 'Imported'
      : 'Import agent';

  return (
    <Modal open onClose={onClose} title={title} size="lg">
      {stage === 'file' && (
        <FileStep
          text={text}
          setText={setText}
          onPick={readFile}
          onContinue={() => parse(text)}
          error={parseError}
          onClose={onClose}
        />
      )}

      {stage === 'preview' && (
        <div className="space-y-3">
          {previewPending && (
            <div className="flex items-center gap-2 py-6 text-[12px] text-t3">
              <Spinner /> Checking what this file would do in {where}…
            </div>
          )}

          {previewError && (
            <ErrorPanel
              title="This file was refused"
              error={previewError}
              onBack={seedFile ? undefined : () => setStage('file')}
            />
          )}

          {previewData && (
            <>
              <PreviewBody
                preview={previewData}
                where={where}
                parseError={parseError}
                crossEnvEvalWarning={crossEnvEvalWarning}
                enabledEvals={enabledEvals}
                llmApiKey={llmApiKey}
                setLlmApiKey={setLlmApiKey}
              />

              {apply.isError && (
                <ErrorPanel title="The import failed" error={apply.error as Error} />
              )}

              <div className="flex justify-end gap-2 border-t border-bd pt-3">
                <Button type="button" onClick={onClose}>
                  Cancel
                </Button>
                <Button
                  type="button"
                  variant="primary"
                  onClick={commit}
                  disabled={
                    apply.isPending ||
                    (previewData.needsLlmKey && !llmApiKey.trim()) ||
                    // Still finding out whether this agent has evals. Clicking
                    // through here would skip the pre-save check by racing it,
                    // which is the one way this button could quietly do less
                    // than it promises.
                    gateIsResolving
                  }
                >
                  {gateIsResolving
                    ? 'Checking…'
                    : apply.isPending
                    ? 'Applying…'
                    : previewData.mode === 'create'
                      ? `Create in ${where}`
                      : `Update in ${where}`}
                </Button>
              </div>
            </>
          )}
        </div>
      )}

      {stage === 'done' && result && (
        <DoneStep
          result={result}
          target={target}
          onClose={onClose}
          onGoToAgent={() => {
            if (target) session.setEnv(target.id);
            // A promote wrote into another environment; landing on the agent
            // means going there, and every cached list is now the wrong env's.
            void queryClient.invalidateQueries();
            navigate(`/agents/${result.agent.identifier}`);
            onClose();
          }}
        />
      )}
    </Modal>
  );
}

/* ---- step 1: the file ---- */

function FileStep({
  text,
  setText,
  onPick,
  onContinue,
  error,
  onClose,
}: {
  text: string;
  setText: (v: string) => void;
  onPick: (f: File) => void;
  onContinue: () => void;
  error: string;
  onClose: () => void;
}) {
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-t3">
        Paste an agent config file, or choose one. Nothing is created until you have seen what it
        would do.
      </p>

      <input
        type="file"
        accept="application/json,.json"
        onChange={(e) => {
          const f = e.target.files?.[0];
          if (f) onPick(f);
        }}
        className="block w-full text-[12px] text-t2 file:mr-3 file:h-8 file:cursor-pointer file:rounded-md file:border file:border-bd file:bg-transparent file:px-3 file:text-[13px] file:font-medium file:text-t1 hover:file:bg-elevated"
      />

      <Field label="Or paste the file">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={10}
          spellCheck={false}
          placeholder={'{\n  "identifier": "support-demo",\n  ...\n}'}
          className="w-full rounded-md border border-bd bg-transparent px-2.5 py-2 font-mono text-[12px] leading-relaxed text-t1 placeholder:text-t3 transition-colors hover:border-bd-strong focus:border-bd-strong"
        />
      </Field>

      {error && <p className="text-[12px] text-err">{error}</p>}

      <div className="flex justify-end gap-2 border-t border-bd pt-3">
        <Button type="button" onClick={onClose}>
          Cancel
        </Button>
        <Button type="button" variant="primary" onClick={onContinue} disabled={!text.trim()}>
          Preview changes
        </Button>
      </div>
    </div>
  );
}

/* ---- step 2: the preview ---- */

function PreviewBody({
  preview,
  where,
  parseError,
  crossEnvEvalWarning,
  enabledEvals,
  llmApiKey,
  setLlmApiKey,
}: {
  preview: ImportPreview;
  where: string;
  parseError: string;
  crossEnvEvalWarning: boolean;
  enabledEvals: number;
  llmApiKey: string;
  setLlmApiKey: (v: string) => void;
}) {
  const creating = preview.mode === 'create';
  const moving = preview.changes.filter((c) => c.action !== 'unchanged' && c.action !== 'removed');
  const silent = preview.changes.filter((c) => c.action === 'removed');
  const unchanged = preview.changes.filter((c) => c.action === 'unchanged').length;
  const { added, changed, removed } = preview.toolChanges;
  // The server states this; we never assume it. If it ever says something else,
  // the honest thing is to show its word rather than our sentence.
  const keptIsThePolicy = preview.removalPolicy === 'kept';

  return (
    <div className="space-y-3">
      {/* create vs update — the banner */}
      <div className="rounded-md border border-bd bg-elevated px-3 py-2.5">
        <p className="text-[12px] text-t1">
          {creating ? (
            <>
              No agent called <Mono className="text-t1">{preview.identifier}</Mono> exists in{' '}
              {where} — it will be <span className="font-medium">created</span>.
            </>
          ) : (
            <>
              <Mono className="text-t1">{preview.identifier}</Mono> already exists in {where} — it
              will be <span className="font-medium">updated</span> in place.
            </>
          )}
        </p>
        {!creating && (
          <p className="mt-1 text-[11px] text-t3">
            Its status, pause, canary and version history are untouched. A changed prompt or model
            is saved like any other edit, so it mints a new version.
          </p>
        )}
      </div>

      {/* field-level changes */}
      <section>
        <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-t3">
          {creating ? 'What this file sets' : 'What changes'}
        </h3>
        {moving.length === 0 ? (
          <p className="text-[12px] text-t3">
            Nothing in the agent's own settings changes — this file matches what is already here.
          </p>
        ) : (
          <ul className="space-y-1">
            {moving.map((c) => (
              <li key={c.field} className="flex items-baseline gap-2 text-[12px] text-t2">
                <span aria-hidden className="text-t3">
                  ·
                </span>
                <span>
                  <span className="text-t1">{fieldLabel(c.field)}</span>{' '}
                  {c.action === 'added' ? 'will be set' : 'will change'}
                </span>
              </li>
            ))}
          </ul>
        )}
        {silent.length > 0 && (
          <p className="mt-2 text-[11px] text-t3">
            Not mentioned in the file, so left exactly as it is:{' '}
            {silent.map((c) => fieldLabel(c.field)).join(', ')}.
          </p>
        )}
        {unchanged > 0 && (
          <p className="mt-1 text-[11px] text-t3">
            {unchanged} other {unchanged === 1 ? 'setting matches' : 'settings match'} already.
          </p>
        )}
      </section>

      {/* tools */}
      {(added.length > 0 || changed.length > 0 || removed.length > 0) && (
        <section className="border-t border-bd pt-3">
          <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wider text-t3">Tools</h3>
          <ul className="space-y-1 text-[12px] text-t2">
            {added.length > 0 && (
              <li>
                <span className="text-t1">{added.length}</span> to create: {added.join(', ')}
                <span className="block text-[11px] text-t3">
                  Each gets a new signing secret, shown once when you apply.
                </span>
              </li>
            )}
            {changed.length > 0 && (
              <li>
                <span className="text-t1">{changed.length}</span> to update: {changed.join(', ')}
              </li>
            )}
            {removed.length > 0 && (
              <li className="text-t2">
                {keptIsThePolicy ? (
                  <>
                    <span className="text-t1">{removed.length}</span>{' '}
                    {removed.length === 1 ? 'tool' : 'tools'} on this agent{' '}
                    {removed.length === 1 ? 'is' : 'are'} not in the file — {removed.join(', ')}.
                    They will be <span className="font-medium text-t1">KEPT</span>.
                    <span className="block text-[11px] text-t3">
                      An import never deletes anything. Removing a tool stays something you do
                      deliberately, where you can see what calls it.
                    </span>
                  </>
                ) : (
                  <>
                    Not in the file: {removed.join(', ')}. The server reports its removal policy as
                    "{preview.removalPolicy}".
                  </>
                )}
              </li>
            )}
          </ul>
        </section>
      )}

      {/* warnings the server raised */}
      {preview.missingWorkflows.length > 0 && (
        <p className="text-[11px] text-warn">
          This agent's prompt refers to {preview.missingWorkflows.length} workflow
          {preview.missingWorkflows.length === 1 ? '' : 's'} {where} does not have:{' '}
          {preview.missingWorkflows.join(', ')}. The import goes ahead — those triggers will fail
          until you create them here.
        </p>
      )}
      {preview.missingKnowledge.length > 0 && (
        <p className="text-[11px] text-warn">
          {preview.missingKnowledge.length} knowledge source
          {preview.missingKnowledge.length === 1 ? '' : 's'} referenced by this file{' '}
          {preview.missingKnowledge.length === 1 ? 'is' : 'are'} not in {where}:{' '}
          {preview.missingKnowledge.join(', ')}. Config files carry references, not content — add
          and index {preview.missingKnowledge.length === 1 ? 'it' : 'them'} here, or the agent
          answers without {preview.missingKnowledge.length === 1 ? 'it' : 'them'}.
        </p>
      )}
      {crossEnvEvalWarning && (
        <p className="text-[11px] text-warn">
          This changes the prompt or model of an agent with {enabledEvals} enabled eval
          {enabledEvals === 1 ? '' : 's'} in {where}. The pre-save check does not run across
          environments — it would grade the wrong environment's agent — so run {where}'s evals from
          its Evals tab after promoting.
        </p>
      )}
      {parseError && <p className="text-[11px] text-err">{parseError}</p>}

      {/* the key */}
      {preview.needsLlmKey && (
        <div className="border-t border-bd pt-3">
          <Field
            label="LLM API key"
            hint="Stored encrypted in this environment, write-only, and never included in any export."
          >
            <Input
              type="password"
              autoComplete="off"
              value={llmApiKey}
              onChange={(e) => setLlmApiKey(e.target.value)}
              placeholder="sk-…"
            />
          </Field>
          <p className="mt-1.5 text-[11px] text-t3">
            Files never carry keys. Paste the LLM key for this agent:
          </p>
        </div>
      )}
    </div>
  );
}

/* ---- step 3: what happened ---- */

function DoneStep({
  result,
  target,
  onClose,
  onGoToAgent,
}: {
  result: ImportResult;
  target?: Environment;
  onClose: () => void;
  onGoToAgent: () => void;
}) {
  const secrets = result.tools.created;
  return (
    <div className="space-y-3">
      <p className="text-[12px] text-t1">
        <Mono className="text-t1">{result.agent.identifier}</Mono> was{' '}
        {result.mode === 'create' ? 'created' : 'updated'}
        {target ? ` in ${target.name}` : ''}.
      </p>
      <p className="text-[11px] text-t3">
        {result.tools.created.length} tool{result.tools.created.length === 1 ? '' : 's'} created,{' '}
        {result.tools.updated.length} updated, {result.tools.kept.length} kept.
      </p>

      {(result.signingSecret || secrets.length > 0) && (
        <div className="space-y-2 rounded-md border border-bd bg-elevated px-3 py-3">
          <p className="text-[12px] font-medium text-t1">Copy these now — they are shown once.</p>
          {result.signingSecret && (
            <div>
              <p className="mb-1 text-[11px] text-t3">Agent signing secret</p>
              <CopyField value={result.signingSecret} />
            </div>
          )}
          {secrets.map((t) => (
            <div key={t.name}>
              <p className="mb-1 text-[11px] text-t3">Tool · {t.name}</p>
              <CopyField value={t.secret} />
            </div>
          ))}
        </div>
      )}

      {result.missingKnowledge.length > 0 && (
        <p className="text-[11px] text-warn">
          Still missing here: {result.missingKnowledge.join(', ')}. Add and index{' '}
          {result.missingKnowledge.length === 1 ? 'it' : 'them'} on the Knowledge tab.
        </p>
      )}

      <div className="flex justify-end gap-2 border-t border-bd pt-3">
        <Button type="button" onClick={onClose}>
          Close
        </Button>
        <Button type="button" variant="primary" onClick={onGoToAgent}>
          {target ? `Switch to ${target.name} and open it` : 'Open the agent'}
        </Button>
      </div>
    </div>
  );
}

/* ---- shared: the API's own words ---- */

/**
 * The server's message, verbatim. `details` on a 400 is a list of zod issues
 * (the SAME schemas the save routes use), and their paths are the most useful
 * thing an operator can be handed — "topics.labels.30: too many" beats
 * "invalid config file".
 */
function ErrorPanel({
  title,
  error,
  onBack,
}: {
  title: string;
  error: Error;
  onBack?: () => void;
}) {
  const body = (error as { body?: { details?: unknown } }).body;
  const issues = Array.isArray(body?.details) ? (body.details as Array<Record<string, unknown>>) : [];
  return (
    <div className="rounded-md border border-bd bg-elevated px-3 py-2.5">
      <p className="text-[12px] text-err">
        {title}: {error.message}
      </p>
      {issues.length > 0 && (
        <ul className="mt-1.5 space-y-0.5">
          {issues.slice(0, 12).map((issue, i) => (
            <li key={i} className="font-mono text-[11px] text-t3">
              {Array.isArray(issue.path) && issue.path.length > 0 ? issue.path.join('.') : '(root)'}:{' '}
              {String(issue.message ?? '')}
            </li>
          ))}
        </ul>
      )}
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="mt-2 text-[12px] text-t3 underline-offset-2 transition-colors hover:text-t1 hover:underline"
        >
          ← Edit the file
        </button>
      )}
    </div>
  );
}
