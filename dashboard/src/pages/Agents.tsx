import { useState, type ReactNode } from 'react';
import { useNavigate } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { api } from '../lib/api';
import {
  Button,
  Card,
  CopyField,
  EmptyState,
  Field,
  Input,
  Modal,
  Mono,
  PageHeader,
  Skeleton,
  StatusBadge,
  td,
  th,
} from '../ui';
import { timeAgo } from './Activity';

interface Agent {
  identifier: string;
  name: string;
  description: string | null;
  runtime: 'bridge' | 'managed';
  bridgeUrl: string | null;
  model: string | null;
  systemPrompt: string | null;
  llmBaseUrl: string | null;
  maxTokens: number | null;
  autoResolveMinutes: number | null;
  welcomeMessage: string | null;
  suggestedPrompts: SuggestedPrompt[] | null;
  hasLlmKey: boolean;
  /** Phase 22 G2: per-agent daily token circuit breaker (null = off). */
  maxDailyTokens?: number | null;
  status: 'active' | 'disabled';
  createdAt: string;
  /** Last-save timestamp — used to tell whether an eval run predates the prompt. */
  updatedAt?: string | null;
}

/** An agent-speaks-first starter chip: the label plus the turn it sends. */
interface SuggestedPrompt {
  title: string;
  message: string;
}

interface AgentBody {
  identifier: string;
  name: string;
  description?: string;
  runtime: 'bridge' | 'managed';
  bridgeUrl?: string;
  model?: string;
  systemPrompt?: string;
  maxTokens?: number;
  autoResolveMinutes?: number | null;
  welcomeMessage?: string | null;
  suggestedPrompts?: SuggestedPrompt[] | null;
  maxDailyTokens?: number | null;
  llm?: { apiKey?: string; baseUrl?: string | null };
}

interface ChannelInfo {
  channel: string;
  status: string;
  config: { botUsername?: string; address?: string };
  webhook: {
    url?: string;
    pendingUpdates?: number;
    lastError?: string | null;
    expectedUrl?: string;
    error?: string;
  } | null;
}

/**
 * Phase 22 guardrails (frozen shape). Every field optional; the object is
 * omitted from a tool payload when all three are blank. maxAutoCalls +
 * windowDays pair up (the repeat-action rule); maxCallsPerHour is independent.
 */
interface ToolGuard {
  maxAutoCalls?: number;
  windowDays?: number;
  maxCallsPerHour?: number;
}

/** A callable tool a managed agent can invoke — see Phase 18 Tools contract. */
interface Tool {
  id: string;
  name: string;
  description: string;
  parameters: unknown;
  endpointUrl: string;
  approval: 'auto' | 'required';
  timeoutMs: number;
  guard?: ToolGuard | null;
  status: 'active' | 'disabled';
  createdAt: string;
}

interface ToolCreateBody {
  name: string;
  description: string;
  parameters: object;
  endpointUrl: string;
  approval: 'auto' | 'required';
  timeoutMs: number;
  guard?: ToolGuard;
}

interface ToolPatchBody {
  description: string;
  parameters: object;
  endpointUrl: string;
  approval: 'auto' | 'required';
  timeoutMs: number;
  status: 'active' | 'disabled';
  /** null clears a previously-set guard (PATCH is a full replace). */
  guard?: ToolGuard | null;
}

const TEXTAREA_CLS =
  'w-full rounded-md border border-bd bg-transparent px-2.5 py-2 text-[13px] text-t1 placeholder:text-t3 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong';

/** Parameters must be a JSON object (a JSON Schema), validated before submit. */
function parseParams(raw: string): { ok: true; value: object } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Parameters must be valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Parameters must be a JSON object (e.g. a JSON Schema).' };
  }
  return { ok: true, value: parsed };
}

/** One guard number field: blank → off; otherwise a whole number ≥ 1. */
function parseGuardField(
  raw: string,
  label: string,
): { ok: true; value?: number } | { ok: false; error: string } {
  const s = raw.trim();
  if (s === '') return { ok: true, value: undefined };
  const n = Number.parseInt(s, 10);
  if (!Number.isFinite(n) || n < 1 || String(n) !== s) {
    return { ok: false, error: `${label} must be a whole number ≥ 1.` };
  }
  return { ok: true, value: n };
}

/**
 * Assemble the frozen guard payload from the three inputs. All blank → no
 * object (guardrails off). maxAutoCalls and windowDays must be set together —
 * the repeat-action count is meaningless without a window.
 */
function buildGuard(
  rawAuto: string,
  rawWindow: string,
  rawHour: string,
): { ok: true; guard?: ToolGuard } | { ok: false; error: string } {
  const auto = parseGuardField(rawAuto, 'Max auto-executes');
  if (!auto.ok) return auto;
  const win = parseGuardField(rawWindow, 'Window (days)');
  if (!win.ok) return win;
  const hour = parseGuardField(rawHour, 'Max calls per hour');
  if (!hour.ok) return hour;
  if ((auto.value == null) !== (win.value == null)) {
    return { ok: false, error: 'Set both Max auto-executes and its window, or leave both blank.' };
  }
  const guard: ToolGuard = {};
  if (auto.value != null) guard.maxAutoCalls = auto.value;
  if (win.value != null) guard.windowDays = win.value;
  if (hour.value != null) guard.maxCallsPerHour = hour.value;
  return { ok: true, guard: Object.keys(guard).length ? guard : undefined };
}

/** Monochrome switch — same idiom as the workflow step drawer. */
function Toggle({
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

/** Tool signing secret — shown once after create or rotate. */
function ToolSecretReveal({ secret, onClose }: { secret: string; onClose: () => void }) {
  return (
    <Modal open onClose={onClose} title="Tool signing secret">
      <p className="mb-3 text-[12px] text-t2">
        Copy it now — used to verify our signed calls to your endpoint; you won't see it again.
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

/** Create or edit a single tool. Name is immutable after create. */
function ToolFormModal({
  agent,
  tool,
  onClose,
  onCreated,
  onUpdated,
}: {
  agent: Agent;
  tool: Tool | null;
  onClose: () => void;
  onCreated: (secret: string) => void;
  onUpdated: () => void;
}) {
  const editing = Boolean(tool);
  const [name, setName] = useState(tool?.name ?? '');
  const [description, setDescription] = useState(tool?.description ?? '');
  const [params, setParams] = useState(
    tool
      ? JSON.stringify(tool.parameters, null, 2)
      : '{\n  "type": "object",\n  "properties": {}\n}',
  );
  const [endpointUrl, setEndpointUrl] = useState(tool?.endpointUrl ?? '');
  const [approvalRequired, setApprovalRequired] = useState(tool?.approval === 'required');
  const [timeoutMs, setTimeoutMs] = useState(String(tool?.timeoutMs ?? 10000));
  const [enabled, setEnabled] = useState(tool ? tool.status === 'active' : true);
  const [guardMaxAuto, setGuardMaxAuto] = useState(
    tool?.guard?.maxAutoCalls != null ? String(tool.guard.maxAutoCalls) : '',
  );
  const [guardWindowDays, setGuardWindowDays] = useState(
    tool?.guard?.windowDays != null ? String(tool.guard.windowDays) : '',
  );
  const [guardPerHour, setGuardPerHour] = useState(
    tool?.guard?.maxCallsPerHour != null ? String(tool.guard.maxCallsPerHour) : '',
  );
  const [error, setError] = useState('');

  const create = useMutation({
    mutationFn: (body: ToolCreateBody) =>
      api<{ tool: Tool; secret: string }>(`/v1/agents/${agent.identifier}/tools`, {
        method: 'POST',
        body,
      }),
    onSuccess: (res) => onCreated(res.secret),
    onError: (err) => setError(err.message),
  });

  const update = useMutation({
    mutationFn: (body: ToolPatchBody) =>
      api<{ tool: Tool }>(`/v1/agents/${agent.identifier}/tools/${tool!.id}`, {
        method: 'PATCH',
        body,
      }),
    onSuccess: () => onUpdated(),
    onError: (err) => setError(err.message),
  });

  const pending = create.isPending || update.isPending;

  return (
    <Modal open onClose={onClose} title={editing ? `Edit ${tool!.name}` : 'New tool'}>
      <form
        className="space-y-4"
        onSubmit={(e) => {
          e.preventDefault();
          setError('');
          if (!editing && !/^[a-z][a-z0-9_]*$/.test(name.trim())) {
            setError('Name must match ^[a-z][a-z0-9_]*$.');
            return;
          }
          const parsed = parseParams(params);
          if (!parsed.ok) {
            setError(parsed.error);
            return;
          }
          const t = Number.parseInt(timeoutMs, 10);
          if (!Number.isFinite(t) || t < 1000 || t > 30000) {
            setError('Timeout must be between 1000 and 30000 ms.');
            return;
          }
          const guardResult = buildGuard(guardMaxAuto, guardWindowDays, guardPerHour);
          if (!guardResult.ok) {
            setError(guardResult.error);
            return;
          }
          if (editing) {
            update.mutate({
              description: description.trim(),
              parameters: parsed.value,
              endpointUrl: endpointUrl.trim(),
              approval: approvalRequired ? 'required' : 'auto',
              timeoutMs: t,
              status: enabled ? 'active' : 'disabled',
              // PATCH is a full replace — send null to clear a removed guard.
              guard: guardResult.guard ?? null,
            });
          } else {
            create.mutate({
              name: name.trim(),
              description: description.trim(),
              parameters: parsed.value,
              endpointUrl: endpointUrl.trim(),
              approval: approvalRequired ? 'required' : 'auto',
              timeoutMs: t,
              // Omitted entirely when all guard fields are blank.
              guard: guardResult.guard,
            });
          }
        }}
      >
        {editing ? (
          <div>
            <span className="mb-1.5 block text-[12px] font-medium text-t2">Name</span>
            <Mono className="text-t2">{tool!.name}</Mono>
            <span className="mt-1 block text-[11px] text-t3">The name is fixed after creation.</span>
          </div>
        ) : (
          <Field label="Name" hint="Immutable after create — ^[a-z][a-z0-9_]*$">
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              required
              autoFocus
              placeholder="lookup_order"
              pattern="[a-z][a-z0-9_]*"
              className="font-mono"
            />
          </Field>
        )}

        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-t2">Description</span>
          <textarea
            value={description}
            onChange={(e) => setDescription(e.target.value.slice(0, 1024))}
            rows={3}
            required
            placeholder="Look up the status of a customer order by its id."
            className={TEXTAREA_CLS}
          />
          <div className="mt-1 flex items-center justify-between">
            <span className="text-[11px] text-t3">
              The model reads this to decide WHEN to call the tool.
            </span>
            <Mono className="text-t3">{description.length}/1024</Mono>
          </div>
        </div>

        <div>
          <span className="mb-1.5 block text-[12px] font-medium text-t2">Parameters</span>
          <textarea
            value={params}
            onChange={(e) => setParams(e.target.value)}
            rows={6}
            spellCheck={false}
            className={`${TEXTAREA_CLS} font-mono`}
          />
          <span className="mt-1 block text-[11px] text-t3">
            JSON Schema object describing the arguments the model must supply.
          </span>
        </div>

        <Field label="Endpoint URL" hint="We POST the tool call here, signed with the secret below">
          <Input
            value={endpointUrl}
            onChange={(e) => setEndpointUrl(e.target.value)}
            required
            type="url"
            placeholder="https://app.example.com/tools/lookup-order"
            className="font-mono"
          />
        </Field>

        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <span className="block text-[12px] font-medium text-t2">Require human approval</span>
            <span className="mt-1 block text-[11px] text-t3">
              When on, this tool pauses on the Approvals page before it runs.
            </span>
          </div>
          <Toggle
            checked={approvalRequired}
            onChange={setApprovalRequired}
            label="Require human approval before this tool runs"
          />
        </div>

        <Field label="Timeout (ms)" hint="How long we wait for your endpoint — 1000–30000">
          <Input
            value={timeoutMs}
            onChange={(e) => setTimeoutMs(e.target.value)}
            type="number"
            min={1000}
            max={30000}
            className="font-mono"
          />
        </Field>

        {/* Phase 22 guardrails — deterministic limits the executor enforces. */}
        <div className="space-y-3 rounded-md border border-bd bg-elevated px-3 py-3">
          <div>
            <span className="block text-[12px] font-medium text-t2">Guardrails</span>
            <span className="mt-0.5 block text-[11px] text-t3">
              Optional per-customer limits. Leave blank to turn a limit off.
            </span>
          </div>
          <Field
            label="Max auto-executes"
            hint="After this many automatic runs per customer in the window, further runs need human approval."
          >
            <Input
              value={guardMaxAuto}
              onChange={(e) => setGuardMaxAuto(e.target.value)}
              type="number"
              min={1}
              placeholder="off"
              className="font-mono"
            />
          </Field>
          <Field
            label="Window (days)"
            hint="The rolling window the auto-execute count is measured over."
          >
            <Input
              value={guardWindowDays}
              onChange={(e) => setGuardWindowDays(e.target.value)}
              type="number"
              min={1}
              placeholder="off"
              className="font-mono"
            />
          </Field>
          <Field
            label="Max calls per hour per customer"
            hint="Hard cap per customer each hour — extra calls return a rate-limit error the agent explains, no approval."
          >
            <Input
              value={guardPerHour}
              onChange={(e) => setGuardPerHour(e.target.value)}
              type="number"
              min={1}
              placeholder="off"
              className="font-mono"
            />
          </Field>
        </div>

        {editing && (
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <span className="block text-[12px] font-medium text-t2">Enabled</span>
              <span className="mt-1 block text-[11px] text-t3">
                Disabled tools stay defined but the model can't call them.
              </span>
            </div>
            <Toggle checked={enabled} onChange={setEnabled} label="Tool enabled" />
          </div>
        )}

        {error && <p className="text-[12px] text-err">{error}</p>}
        <div className="flex justify-end gap-2">
          <Button type="button" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" disabled={pending}>
            {pending ? 'Saving…' : editing ? 'Save changes' : 'Create tool'}
          </Button>
        </div>
      </form>
    </Modal>
  );
}

/** Per-agent tools: list, add/edit, rotate secret, delete. Managed agents only. */
function ToolsModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const queryClient = useQueryClient();
  const [formFor, setFormFor] = useState<Tool | 'new' | null>(null);
  const [secret, setSecret] = useState('');
  const [actionError, setActionError] = useState('');

  const invalidate = () =>
    void queryClient.invalidateQueries({ queryKey: ['agent-tools', agent.identifier] });

  const { data, isLoading } = useQuery({
    queryKey: ['agent-tools', agent.identifier],
    queryFn: () => api<{ tools: Tool[] }>(`/v1/agents/${agent.identifier}/tools`),
  });

  const rotate = useMutation({
    mutationFn: (toolId: string) =>
      api<{ secret: string }>(`/v1/agents/${agent.identifier}/tools/${toolId}/rotate-secret`, {
        method: 'POST',
      }),
    onSuccess: (res) => setSecret(res.secret),
    onError: (err) => setActionError(err.message),
  });

  const remove = useMutation({
    mutationFn: (toolId: string) =>
      api<{ deleted: true }>(`/v1/agents/${agent.identifier}/tools/${toolId}`, { method: 'DELETE' }),
    onSuccess: () => {
      setActionError('');
      invalidate();
    },
    onError: (err) => setActionError(err.message),
  });

  return (
    <Modal open onClose={onClose} title={`Tools — ${agent.identifier}`}>
      <p className="mb-4 text-[12px] text-t3">
        Tools let this managed agent call your endpoints mid-conversation. The model decides when,
        using each tool's description; tools marked "needs approval" pause on the Approvals page.
      </p>

      {actionError && <p className="mb-3 text-[12px] text-err">{actionError}</p>}

      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : data && data.tools.length > 0 ? (
        <ul className="space-y-3">
          {data.tools.map((t) => (
            <li key={t.id} className="border-b border-bd pb-3 last:border-0 last:pb-0">
              <div className="flex items-start justify-between gap-2">
                <div className="min-w-0">
                  <Mono className="text-t1">{t.name}</Mono>
                  <div className="mt-1 flex items-center gap-3">
                    {t.approval === 'required' ? (
                      <span className="inline-flex items-center gap-1.5 text-[12px] text-t2">
                        <span
                          aria-hidden
                          className="inline-block h-[7px] w-[7px] rounded-full"
                          style={{ background: 'var(--warn)' }}
                        />
                        needs approval
                      </span>
                    ) : (
                      <span className="text-[12px] text-t3">auto</span>
                    )}
                    <StatusBadge status={t.status} />
                  </div>
                  <Mono className="mt-1 block max-w-[260px] truncate text-t3">{t.endpointUrl}</Mono>
                </div>
              </div>
              <div className="mt-2 flex flex-wrap justify-end gap-1">
                <Button variant="ghost" onClick={() => setFormFor(t)}>
                  Edit
                </Button>
                <Button variant="ghost" onClick={() => rotate.mutate(t.id)}>
                  Rotate secret
                </Button>
                <Button
                  variant="danger"
                  onClick={() => {
                    if (window.confirm(`Delete tool "${t.name}"?`)) remove.mutate(t.id);
                  }}
                >
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-[12px] text-t3">No tools yet. Add one to let this agent call your code.</p>
      )}

      <div className="mt-4 flex justify-end border-t border-bd pt-4">
        <Button variant="primary" onClick={() => setFormFor('new')}>
          Add tool
        </Button>
      </div>

      {formFor && (
        <ToolFormModal
          agent={agent}
          tool={formFor === 'new' ? null : formFor}
          onClose={() => setFormFor(null)}
          onCreated={(s) => {
            setFormFor(null);
            setSecret(s);
            invalidate();
          }}
          onUpdated={() => {
            setFormFor(null);
            invalidate();
          }}
        />
      )}
      {secret && <ToolSecretReveal secret={secret} onClose={() => setSecret('')} />}
    </Modal>
  );
}

/**
 * Per-agent channel connections, read-only. Shows what's wired to this agent;
 * connecting, re-pointing, and disconnecting all live on the Connections page.
 */
function ChannelsModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const navigate = useNavigate();

  const { data, isLoading } = useQuery({
    queryKey: ['agent-channels', agent.identifier],
    queryFn: () => api<{ channels: ChannelInfo[] }>(`/v1/agents/${agent.identifier}/channels`),
  });

  return (
    <Modal open onClose={onClose} title={`Channels — ${agent.identifier}`}>
      {isLoading ? (
        <Skeleton className="h-24 w-full" />
      ) : data && data.channels.length > 0 ? (
        <ul className="space-y-3">
          {data.channels.map((c) => {
            const identity =
              c.channel === 'telegram' ? `@${c.config.botUsername ?? '—'}` : c.config.address ?? '—';
            const webhookHealthy =
              c.webhook?.url && c.webhook.url === c.webhook.expectedUrl;
            return (
              <li
                key={c.channel}
                className="flex items-center justify-between gap-2 border-b border-bd pb-3 last:border-0 last:pb-0"
              >
                <span className="min-w-0">
                  <span className="text-[13px] text-t1 capitalize">{c.channel}</span>{' '}
                  <Mono className="break-all text-t2">{identity}</Mono>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  <StatusBadge status={c.status} />
                  {c.channel === 'telegram' && (
                    <StatusBadge status={webhookHealthy ? 'active' : 'failed'} />
                  )}
                </span>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="text-[12px] text-t3">No channels connected to this agent yet.</p>
      )}
      <div className="mt-4 flex justify-end border-t border-bd pt-4">
        <Button
          variant="ghost"
          onClick={() => {
            onClose();
            navigate('/connections');
          }}
        >
          Manage on the Connections page →
        </Button>
      </div>
    </Modal>
  );
}

/** Per-agent health window (Phase 21). Averages may be null on empty windows. */
interface AgentHealth {
  windowDays: number;
  turns: number;
  replies: number;
  notes: number;
  avgMs: number | null;
  p95Ms: number | null;
  avgInputTokens: number;
  avgOutputTokens: number;
  toolCalls: number;
  toolFailures: number;
  tools: Array<{ name: string; calls: number; failures: number; avgMs: number | null }>;
  /** Phase 22 G2 — present only when the agent has a daily token budget. */
  usedTodayTokens?: number | null;
  maxDailyTokens?: number | null;
}

/** Durations read as `840ms` under a second, else `1.2s`. Null → em-dash. */
function fmtMs(ms: number | null): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Integer stat with an em-dash fallback — never renders NaN. */
function fmtInt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return Math.round(n).toLocaleString();
}

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

/**
 * Health section for one agent — turns, latency, token spend, and tool
 * reliability over a trailing window. A dot warns when tools fail past 5% or
 * the agent falls back to internal notes past 20% of turns.
 */
function HealthModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
  const [days, setDays] = useState<7 | 30>(7);

  const { data, isLoading, isError, error } = useQuery({
    queryKey: ['agent-health', agent.identifier, days],
    queryFn: () => api<AgentHealth>(`/v1/agents/${agent.identifier}/health?days=${days}`),
  });

  const warn =
    !!data &&
    ((data.toolCalls > 0 && data.toolFailures / data.toolCalls > 0.05) ||
      (data.turns > 0 && data.notes / data.turns > 0.2));
  const failurePct =
    data && data.toolCalls > 0 ? ((data.toolFailures / data.toolCalls) * 100).toFixed(1) : null;

  return (
    <Modal open onClose={onClose} title={`Health — ${agent.identifier}`}>
      <div className="mb-4 flex items-center justify-between">
        <span className="inline-flex items-center gap-1.5">
          <span
            aria-hidden
            className="inline-block h-[7px] w-[7px] rounded-full"
            style={{ background: data && data.turns > 0 ? (warn ? 'var(--warn)' : 'var(--ok)') : 'var(--t3)' }}
          />
          <span className="text-[11px] font-medium uppercase tracking-wider text-t3">
            Last {days} days
          </span>
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
                        <Mono className={t.failures > 0 ? 'text-t1' : 'text-t3'}>{t.failures}</Mono>
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
    </Modal>
  );
}

/** Shown once after create/rotate — the same doctrine as API keys. */
function SecretReveal({ secret, onClose }: { secret: string; onClose: () => void }) {
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

// ---------------------------------------------------------------------------
// Evals (Phase 22 E1–E4) — per-agent scenario suite, runs, and the advisory
// save gate. Shapes track the frozen backend contract; verified against mocks
// until the /v1/agents/:id/evals routes land.
// ---------------------------------------------------------------------------

/** A stored eval scenario — jsonb, same shape as evals/*.json (turns/expects). */
interface AgentEval {
  id: string;
  name: string;
  scenario: unknown;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/** One scenario's outcome inside a run (shape from scripts/eval.ts's core). */
interface ScenarioResult {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  detail?: string;
}

/** An eval run — an enqueued job; poll until status leaves 'running'. */
interface EvalRun {
  id: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  results: ScenarioResult[] | null;
  startedAt: string;
  finishedAt: string | null;
  trigger: 'manual' | 'pre_save';
}

const DEFAULT_SCENARIO = `{
  "description": "",
  "turns": [
    { "user": "Hi, I need help" },
    { "expect": { "replyContains": "" } }
  ]
}`;

/** Pass/fail/total across a run's scenarios (skips don't count as failures). */
function runSummary(run: EvalRun): { passed: number; failed: number; total: number } {
  const results = run.results ?? [];
  return {
    total: results.length,
    passed: results.filter((r) => r.status === 'pass').length,
    failed: results.filter((r) => r.status === 'fail' || r.status === 'error').length,
  };
}

/** Run-level status dot color — the only place run color is minted. */
function runDot(run: EvalRun): string {
  if (run.status === 'running') return 'var(--info)';
  if (run.status === 'passed') return 'var(--ok)';
  return 'var(--err)';
}

/** Per-scenario dot color — pass green, fail/error red, skip muted. */
function scenarioDot(status: ScenarioResult['status']): string {
  if (status === 'pass') return 'var(--ok)';
  if (status === 'skip') return 'var(--t3)';
  return 'var(--err)';
}

/** The one-line advisory shown next to Save; `ok:false` means show a warn dot. */
function runAdvisory(run: EvalRun): { text: string; ok: boolean } {
  if (run.status === 'running') return { text: 'evals: running…', ok: true };
  const s = runSummary(run);
  const when = timeAgo(run.finishedAt ?? run.startedAt);
  if (s.failed > 0 || run.status === 'failed' || run.status === 'error') {
    return { text: `evals: ${s.failed}/${s.total} failed · ${when}`, ok: false };
  }
  return { text: `evals: ${s.passed}/${s.total} passed · ${when}`, ok: true };
}

/** Scenario JSON must parse to an object carrying a `turns` array. */
function parseScenario(raw: string): { ok: true; value: object } | { ok: false; error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: 'Scenario must be valid JSON.' };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'Scenario must be a JSON object with a "turns" array.' };
  }
  if (!Array.isArray((parsed as { turns?: unknown }).turns)) {
    return { ok: false, error: 'Scenario needs a "turns" array (user turns and expects).' };
  }
  return { ok: true, value: parsed as object };
}

/**
 * Runs list for an agent, newest first. Polls every 2s while the latest run is
 * still running, then goes quiet — shared by the modal and the save-gate.
 */
function useEvalRuns(identifier: string, enabled: boolean) {
  return useQuery({
    queryKey: ['agent-eval-runs', identifier],
    queryFn: () => api<{ runs: EvalRun[] }>(`/v1/agents/${identifier}/evals/runs`),
    enabled,
    refetchInterval: (query) => {
      const latest = query.state.data?.runs?.[0];
      return latest && latest.status === 'running' ? 2000 : false;
    },
  });
}

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
        ? api(`/v1/agents/${agent.identifier}/evals/${evalItem!.id}`, { method: 'PATCH', body })
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
            A JSON object with a <Mono>turns</Mono> array — user turns and tool/reply
            expectations, same format as the eval files.
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
function EvalsModal({ agent, onClose }: { agent: Agent; onClose: () => void }) {
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
  // detail is polled while it's still running.
  const runDetail = useQuery({
    queryKey: ['agent-eval-run', agent.identifier, activeRunId],
    queryFn: () => api<{ run: EvalRun }>(`/v1/agents/${agent.identifier}/evals/runs/${activeRunId}`),
    enabled: !!activeRunId,
    refetchInterval: (query) => (query.state.data?.run.status === 'running' ? 2000 : false),
  });

  const toggleEnabled = useMutation({
    mutationFn: (vars: { id: string; enabled: boolean }) =>
      api(`/v1/agents/${agent.identifier}/evals/${vars.id}`, {
        method: 'PATCH',
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
    <Modal open onClose={onClose} title={`Evals — ${agent.identifier}`}>
      <p className="mb-4 text-[12px] text-t3">
        Evals script a conversation and assert what the agent should do — which tools it calls,
        what its reply contains. Run them after a prompt change to catch regressions before your
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
          {run.status === 'running' && !(run.results && run.results.length) ? (
            <Skeleton className="h-16 w-full" />
          ) : run.results && run.results.length > 0 ? (
            <ul className="space-y-1.5">
              {run.results.map((r) => (
                <li key={r.name} className="flex items-start gap-2 text-[12px]">
                  <span
                    aria-hidden
                    className="mt-1 inline-block h-[6px] w-[6px] shrink-0 rounded-full"
                    style={{ background: scenarioDot(r.status) }}
                  />
                  <div className="min-w-0">
                    <Mono className="text-t2">{r.name}</Mono>
                    {r.detail && (r.status === 'fail' || r.status === 'error') && (
                      <Mono className="mt-0.5 block whitespace-pre-wrap break-words text-t3">
                        {r.detail}
                      </Mono>
                    )}
                  </div>
                </li>
              ))}
            </ul>
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
    </Modal>
  );
}

function AgentForm({
  initial,
  pending,
  error,
  submitLabel,
  onSubmit,
  onCancel,
}: {
  initial?: Partial<Agent>;
  pending: boolean;
  error: string;
  submitLabel: string;
  onSubmit: (body: AgentBody) => void;
  onCancel: () => void;
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
  const advisory = latestRun ? runAdvisory(latestRun) : null;
  const advisoryDot = !latestRun
    ? 'var(--t3)'
    : latestRun.status === 'running'
      ? 'var(--info)'
      : advisory!.ok
        ? 'var(--ok)'
        : 'var(--err)';

  return (
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

      {error && <p className="text-[12px] text-err">{error}</p>}
      <div className="flex justify-end gap-2">
        <Button type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button variant="primary" type="submit" disabled={pending}>
          {pending ? 'Saving…' : submitLabel}
        </Button>
      </div>
    </form>
  );
}

export default function AgentsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<Agent | null>(null);
  const [channelsFor, setChannelsFor] = useState<Agent | null>(null);
  const [toolsFor, setToolsFor] = useState<Agent | null>(null);
  const [evalsFor, setEvalsFor] = useState<Agent | null>(null);
  const [healthFor, setHealthFor] = useState<Agent | null>(null);
  const [secret, setSecret] = useState('');
  const [error, setError] = useState('');
  // Delete failures (e.g. 409: agent still has routed connections) surface
  // here, since the delete action has no modal of its own to show them in.
  const [deleteError, setDeleteError] = useState('');

  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['agents'] });

  const { data, isLoading } = useQuery({
    queryKey: ['agents'],
    queryFn: () => api<{ agents: Agent[] }>('/v1/agents'),
  });

  const create = useMutation({
    mutationFn: (body: AgentBody) =>
      api<{ signingSecret: string }>('/v1/agents', { method: 'POST', body }),
    onSuccess: (res) => {
      setCreateOpen(false);
      setError('');
      setSecret(res.signingSecret);
      invalidate();
    },
    onError: (err) => setError(err.message),
  });

  const update = useMutation({
    mutationFn: ({ identifier, ...body }: Partial<AgentBody> & { identifier: string; status?: string }) =>
      api(`/v1/agents/${identifier}`, { method: 'PATCH', body }),
    onSuccess: () => {
      setEditing(null);
      setError('');
      invalidate();
    },
    onError: (err) => setError(err.message),
  });

  const rotate = useMutation({
    mutationFn: (identifier: string) =>
      api<{ signingSecret: string }>(`/v1/agents/${identifier}/rotate-secret`, { method: 'POST' }),
    onSuccess: (res) => setSecret(res.signingSecret),
  });

  const remove = useMutation({
    mutationFn: (identifier: string) => api(`/v1/agents/${identifier}`, { method: 'DELETE' }),
    onSuccess: () => {
      setDeleteError('');
      invalidate();
    },
    onError: (err, identifier) => setDeleteError(`Couldn't delete "${identifier}" — ${err.message}`),
  });

  return (
    <>
      <PageHeader
        title="Agents"
        action={
          <Button variant="primary" onClick={() => setCreateOpen(true)}>
            New agent
          </Button>
        }
      />
      <p className="-mt-4 mb-5 max-w-2xl text-[12px] text-t3">
        An agent is your code answering conversations: register the URL your handler listens on,
        and every message a subscriber sends arrives there as one signed event. Replies and
        workflow triggers come back in the response — see <Mono>@asyncify-hq/agent</Mono>.
      </p>

      {deleteError && (
        <div className="mb-4 flex items-center justify-between gap-3 rounded-md border border-bd bg-elevated px-3 py-2">
          <span className="text-[12px] text-err">{deleteError}</span>
          <button
            className="shrink-0 text-[12px] text-t3 transition-colors hover:text-t1"
            onClick={() => setDeleteError('')}
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {isLoading ? (
        <Skeleton className="h-40 w-full" />
      ) : data && data.agents.length > 0 ? (
        <Card className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr>
                <th className={th}>Identifier</th>
                <th className={th}>Name</th>
                <th className={th}>Brain</th>
                <th className={th}>Status</th>
                <th className={`${th} text-right`}>Created</th>
                <th className={`${th} text-right`} />
              </tr>
            </thead>
            <tbody>
              {data.agents.map((a) => (
                <tr key={a.identifier} className="transition-colors hover:bg-elevated">
                  <td className={td}>
                    <button
                      className="font-mono text-[12px] text-t1 hover:underline"
                      onClick={() => navigate(`/conversations?agent=${a.identifier}`)}
                      title="View this agent's conversations"
                    >
                      {a.identifier}
                    </button>
                  </td>
                  <td className={td}>{a.name}</td>
                  <td className={td}>
                    <Mono className="text-t2">
                      {a.runtime === 'managed'
                        ? `managed · ${a.model ?? 'claude-opus-4-8'}`
                        : a.bridgeUrl}
                    </Mono>
                  </td>
                  <td className={td}>
                    <StatusBadge status={a.status} />
                  </td>
                  <td className={`${td} text-right`}>
                    <Mono className="text-t3">{timeAgo(a.createdAt)}</Mono>
                  </td>
                  <td className={`${td} text-right whitespace-nowrap`}>
                    <Button variant="ghost" onClick={() => setHealthFor(a)}>
                      Health
                    </Button>
                    <Button variant="ghost" onClick={() => setChannelsFor(a)}>
                      Channels
                    </Button>
                    {a.runtime === 'managed' && (
                      <Button variant="ghost" onClick={() => setToolsFor(a)}>
                        Tools
                      </Button>
                    )}
                    {a.runtime === 'managed' && (
                      <Button variant="ghost" onClick={() => setEvalsFor(a)}>
                        Evals
                      </Button>
                    )}
                    <Button variant="ghost" onClick={() => setEditing(a)}>
                      Edit
                    </Button>
                    <Button variant="ghost" onClick={() => rotate.mutate(a.identifier)}>
                      Rotate secret
                    </Button>
                    <Button
                      variant="ghost"
                      onClick={() =>
                        update.mutate({
                          identifier: a.identifier,
                          status: a.status === 'active' ? 'disabled' : 'active',
                        })
                      }
                    >
                      {a.status === 'active' ? 'Disable' : 'Enable'}
                    </Button>
                    <Button
                      variant="danger"
                      onClick={() => {
                        if (window.confirm(`Delete agent "${a.identifier}" and all its conversations?`)) {
                          remove.mutate(a.identifier);
                        }
                      }}
                    >
                      Delete
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ) : (
        <EmptyState
          title="No agents yet"
          body="Register your first agent, point it at your handler, and your users can talk to it from the in-app widget."
          snippet={`import { defineAgent, createHandler } from '@asyncify-hq/agent';

const support = defineAgent({
  onMessage: (ctx) => \`You said: \${ctx.message.text}\`,
});

http.createServer(createHandler(support, {
  signingSecret: process.env.ASYNCIFY_AGENT_SECRET,
})).listen(4100);`}
        />
      )}

      <Modal open={createOpen} onClose={() => setCreateOpen(false)} title="New agent">
        <AgentForm
          pending={create.isPending}
          error={error}
          submitLabel="Create agent"
          onSubmit={(body) => create.mutate(body)}
          onCancel={() => setCreateOpen(false)}
        />
      </Modal>

      {editing && (
        <Modal open onClose={() => setEditing(null)} title={`Edit ${editing.identifier}`}>
          <AgentForm
            initial={editing}
            pending={update.isPending}
            error={error}
            submitLabel="Save changes"
            onSubmit={(body) =>
              update.mutate({
                identifier: editing.identifier,
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
                llm: body.llm,
              })
            }
            onCancel={() => setEditing(null)}
          />
        </Modal>
      )}

      {healthFor && <HealthModal agent={healthFor} onClose={() => setHealthFor(null)} />}

      {channelsFor && <ChannelsModal agent={channelsFor} onClose={() => setChannelsFor(null)} />}

      {toolsFor && <ToolsModal agent={toolsFor} onClose={() => setToolsFor(null)} />}

      {evalsFor && <EvalsModal agent={evalsFor} onClose={() => setEvalsFor(null)} />}

      {secret && <SecretReveal secret={secret} onClose={() => setSecret('')} />}
    </>
  );
}
