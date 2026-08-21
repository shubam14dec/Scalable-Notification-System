// Shared types, pure helpers, and constants for the Agents list page and the
// per-agent detail page (pages/AgentDetail.tsx + pages/agent/*Panel.tsx).
// Extracted verbatim from the former monolithic Agents.tsx — no behavior change.

export interface Agent {
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
  /**
   * Phase 24 D6: rolling-summary trigger knobs (agent-level jsonb). Optional —
   * slice B lands the `context` field on the agent view; guard until then.
   */
  context?: { triggerTurns?: number; tailTurns?: number } | null;
  status: 'active' | 'disabled';
  createdAt: string;
  /** Last-save timestamp — used to tell whether an eval run predates the prompt. */
  updatedAt?: string | null;
}

/** An agent-speaks-first starter chip: the label plus the turn it sends. */
export interface SuggestedPrompt {
  title: string;
  message: string;
}

export interface AgentBody {
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
  /** Phase 24 D6: only sent when at least one knob is set (blank = untouched). */
  context?: { triggerTurns?: number; tailTurns?: number };
  llm?: { apiKey?: string; baseUrl?: string | null };
}

export interface ChannelInfo {
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
export interface ToolGuard {
  maxAutoCalls?: number;
  windowDays?: number;
  maxCallsPerHour?: number;
}

/** A callable tool a managed agent can invoke — see Phase 18 Tools contract. */
export interface Tool {
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

/** Phase 23: one knowledge source (pasted text or a fetched URL) for an agent. */
export interface KnowledgeSource {
  id: string;
  name: string;
  kind: 'text' | 'url';
  status: 'pending' | 'indexing' | 'ready' | 'error';
  error: string | null;
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface ToolCreateBody {
  name: string;
  description: string;
  parameters: object;
  endpointUrl: string;
  approval: 'auto' | 'required';
  timeoutMs: number;
  guard?: ToolGuard;
}

export interface ToolPatchBody {
  description: string;
  parameters: object;
  endpointUrl: string;
  approval: 'auto' | 'required';
  timeoutMs: number;
  status: 'active' | 'disabled';
  /** null clears a previously-set guard (PATCH is a full replace). */
  guard?: ToolGuard | null;
}

/** One durable fact: `source` says whether the agent or an operator wrote it. */
export interface Memory {
  key: string;
  value: string;
  source: 'agent' | 'operator';
  updatedAt: string;
}

/** The 409 body when the profile is full — carries the current keys to overwrite. */
export interface MemoryCap {
  error?: string;
  reason?: string;
  currentKeys?: string[];
  limits?: { maxKeys?: number; maxKeyLength?: number; maxValueLength?: number };
}

/** Per-agent health window (Phase 21). Averages may be null on empty windows. */
export interface AgentHealth {
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
  /**
   * Phase 24 D10 (slice C, in flight): 30-day daily-token stats. `suggested`
   * is null until ≥7 days of data exist; both absent until slice C lands.
   */
  suggestedDailyTokens?: number | null;
  p95DailyTokens?: number | null;
}

/** A stored eval scenario — jsonb, same shape as evals/*.json (turns/expects). */
export interface AgentEval {
  id: string;
  name: string;
  scenario: unknown;
  enabled: boolean;
  createdAt: string;
  updatedAt: string;
}

/**
 * One dimension's LLM-judge outcome on one turn (A2). Mirrors
 * `JudgeVerdictRecord` in src/core/eval-runner.ts — the dashboard is a separate
 * app and cannot import server types, so this is a hand-kept copy.
 * `verdict: 'skipped'` means the run had no judge client (a CLI run, or an agent
 * whose LLM credentials could not be opened) — not a pass and not a failure.
 */
export interface JudgeVerdictRecord {
  turn: number;
  dim: 'groundedness' | 'tone' | 'refusal';
  verdict: 'pass' | 'fail' | 'skipped';
  /** 1-5, present for the scored dimensions (groundedness, tone) only. */
  score?: number;
  rationale: string;
}

/** One scenario's outcome inside a run (shape from scripts/eval.ts's core). */
export interface ScenarioResult {
  name: string;
  passed: boolean;
  failures: string[];
  attempts: number;
  /** A2, additive: present only when the scenario used `expect.judge`. */
  judged?: JudgeVerdictRecord[];
}

/** An eval run — an enqueued job; poll until status leaves 'running'. */
export interface EvalRun {
  id: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  results: ScenarioResult[] | null;
  startedAt: string;
  finishedAt: string | null;
  trigger: 'manual' | 'pre_save';
}

export const TEXTAREA_CLS =
  'w-full rounded-md border border-bd bg-transparent px-2.5 py-2 text-[13px] text-t1 placeholder:text-t3 transition-colors duration-150 hover:border-bd-strong focus:border-bd-strong';

/** Client-side file-read cap — pasted/uploaded text only, no upload plumbing. */
export const MAX_KNOWLEDGE_FILE_BYTES = 1024 * 1024;

// Knowledge (Phase 23 D8) — per-agent RAG sources. Status is the ONE place
// color is minted here: pending/indexing pulse info, ready ok, error err.
export const KNOWLEDGE_STATUS: Record<
  KnowledgeSource['status'],
  { color: string; pulse: boolean; label: string }
> = {
  pending: { color: 'var(--info)', pulse: true, label: 'pending' },
  indexing: { color: 'var(--info)', pulse: true, label: 'indexing' },
  ready: { color: 'var(--ok)', pulse: false, label: 'ready' },
  error: { color: 'var(--err)', pulse: false, label: 'error' },
};

export const DEFAULT_SCENARIO = `{
  "description": "",
  "turns": [
    { "user": "Hi, I need help" },
    { "expect": { "replyContains": "" } }
  ]
}`;

/** Parameters must be a JSON object (a JSON Schema), validated before submit. */
export function parseParams(
  raw: string,
): { ok: true; value: object } | { ok: false; error: string } {
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
export function parseGuardField(
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
export function buildGuard(
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

/** Durations read as `840ms` under a second, else `1.2s`. Null → em-dash. */
export function fmtMs(ms: number | null): string {
  if (ms == null || Number.isNaN(ms)) return '—';
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(1)}s`;
}

/** Integer stat with an em-dash fallback — never renders NaN. */
export function fmtInt(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return '—';
  return Math.round(n).toLocaleString();
}

/** Pass/fail/total across a run's scenarios (skips don't count as failures). */
export function runSummary(run: EvalRun): { passed: number; failed: number; total: number } {
  const results = run.results ?? [];
  return {
    total: results.length,
    passed: results.filter((r) => r.passed).length,
    failed: results.filter((r) => !r.passed).length,
  };
}

/** Run-level status dot color — the only place run color is minted. */
export function runDot(run: EvalRun): string {
  if (run.status === 'running') return 'var(--info)';
  if (run.status === 'passed') return 'var(--ok)';
  return 'var(--err)';
}

/** The one-line advisory shown next to Save; `ok:false` means show a warn dot. */
export function runAdvisory(
  run: EvalRun,
  timeAgo: (iso: string) => string,
): { text: string; ok: boolean } {
  if (run.status === 'running') return { text: 'evals: running…', ok: true };
  const s = runSummary(run);
  const when = timeAgo(run.finishedAt ?? run.startedAt);
  if (s.failed > 0 || run.status === 'failed' || run.status === 'error') {
    return { text: `evals: ${s.failed}/${s.total} failed · ${when}`, ok: false };
  }
  return { text: `evals: ${s.passed}/${s.total} passed · ${when}`, ok: true };
}

/** Scenario JSON must parse to an object carrying a `turns` array. */
export function parseScenario(
  raw: string,
): { ok: true; value: object } | { ok: false; error: string } {
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
