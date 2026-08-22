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
  /**
   * Phase A5: the live prompt-snapshot number (managed agents only — a bridge
   * agent has no versions behind it). The Versions panel reads the authoritative
   * marker off the versions endpoint; this is the same number on the agent row.
   */
  promptVersion?: number;
  /**
   * Phase A5 slice B: the RUNNING canary, or null when none is. Presence is the
   * flag — the API only sends the object while a trial is active, so the panel
   * never has to decide what a percent of 0 or a null version would mean.
   */
  canary?: {
    version: number;
    percent: number | null;
    startedAt: string | null;
    /**
     * Slice C: the share of turns judged in BOTH arms, already resolved by the
     * server (never null). 0 means the trial counts outcomes only — the panel
     * says so rather than showing an empty judged block with no explanation.
     */
    samplePercent: number;
  } | null;
  /**
   * Phase A6: cheap-first model routing, or null when it was never set up.
   * Presence is the flag, same as `canary` above — managed agents only.
   */
  routing?: AgentRouting | null;
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

/**
 * Phase A6: the cheap-first router's config. Mirrors `RoutingConfig` in
 * src/core/managed-brain.ts. `cheapModel` is '' when the operator switched the
 * router off without clearing the id they had typed — the server reads that the
 * same way it reads `enabled: false`, so a half-filled config never routes.
 */
export interface AgentRouting {
  enabled: boolean;
  cheapModel: string;
}

/**
 * Phase A6 slice B: what the router actually did over the last `windowDays`.
 * ONE denominator — every reply the agent sent in the window, minus canary-trial
 * replies (a canary turn runs on the trial's own model, so the router never saw
 * it). The three buckets sum to `replies`.
 */
export interface AgentRoutingStats {
  windowDays: number;
  replies: number;
  cheapReplies: number;
  escalatedReplies: number;
  unroutedReplies: number;
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
  /**
   * Phase A6: null switches routing off and forgets the config. Only sent on an
   * EDIT (create rejects null — there is nothing to clear on an agent that does
   * not exist yet), same rule maxDailyTokens follows.
   */
  routing?: AgentRouting | null;
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

/**
 * A4: the edited config a run graded INSTEAD of the agent's live one — what the
 * dashboard's pre-save check sends. Mirrors `CandidateSchema` in
 * src/api/routes/agent-evals.ts; at least one key is always present.
 */
export interface EvalCandidate {
  systemPrompt?: string;
  model?: string;
  /**
   * A6: the routing config to grade. Turning the router on changes which model
   * writes the reply, so the check has to run THROUGH the edited router or it
   * proves nothing about the save. `null` means "grade it with routing off";
   * the key being ABSENT means the edit did not touch routing at all.
   */
  routing?: AgentRouting | null;
}

/** An eval run — an enqueued job; poll until status leaves 'running'. */
export interface EvalRun {
  id: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  results: ScenarioResult[] | null;
  startedAt: string;
  finishedAt: string | null;
  trigger: 'manual' | 'pre_save';
  /**
   * A4, additive: present ONLY on a run started with a candidate override (the
   * server omits the key on a plain run — absent, never null). Its presence is
   * what makes a run unusable as a BASELINE: it graded an edit, not the agent.
   */
  candidate?: EvalCandidate;
}

/**
 * A4 pre-save: one scenario's outcome relative to the baseline run.
 * `unknown` = no baseline, or a scenario the baseline never ran (added since) —
 * there is nothing honest to say about it, so it carries no label.
 */
export type ScenarioDelta = 'new-fail' | 'fixed' | 'still-failing' | 'unchanged' | 'unknown';

/** Where a candidate scenario stands against the same scenario in the baseline. */
export function scenarioDelta(
  result: ScenarioResult,
  baseline: ScenarioResult[] | null,
): ScenarioDelta {
  if (!baseline) return 'unknown';
  const before = baseline.find((b) => b.name === result.name);
  if (!before) return 'unknown';
  if (before.passed && !result.passed) return 'new-fail';
  if (!before.passed && result.passed) return 'fixed';
  if (!before.passed && !result.passed) return 'still-failing';
  return 'unchanged';
}

/** Chip text per delta. `null` = render no chip (an unchanged pass is the norm). */
export const DELTA_LABEL: Record<ScenarioDelta, string | null> = {
  'new-fail': 'new fail',
  fixed: 'fixed',
  'still-failing': 'still failing',
  unchanged: null,
  unknown: null,
};

/**
 * Delta dot colour — the only place delta colour is minted, same doctrine as
 * runDot/judgeDot. `still failing` deliberately takes the muted t3: the scenario
 * was already red before this edit, so it is not what the edit broke.
 */
export function deltaDot(delta: ScenarioDelta): string {
  if (delta === 'new-fail') return 'var(--err)';
  if (delta === 'fixed') return 'var(--ok)';
  return 'var(--t3)';
}

/**
 * The run a candidate is measured against: the newest FINISHED run of the
 * agent's own live config. A run with a `candidate` graded somebody's edit, and
 * a run with no recorded scenarios (errored before it graded anything) has
 * nothing to compare — neither can be a baseline. Runs arrive newest-first.
 */
export function baselineRun(runs: EvalRun[]): EvalRun | null {
  return (
    runs.find(
      (r) => !r.candidate && r.status !== 'running' && (r.results?.length ?? 0) > 0,
    ) ?? null
  );
}

/** Counted deltas plus the one-line verdict shown at the top of the check. */
export interface PreSaveSummary {
  total: number;
  passed: number;
  regressed: number;
  fixed: number;
  stillFailing: number;
  /** No scenario that passed before fails now — the only thing Save waits on. */
  clean: boolean;
  text: string;
}

/**
 * Summarize a candidate run against the baseline. With no baseline the counts
 * stay zero and the text falls back to absolute pass/fail — the caller shows
 * the "nothing to compare against" note.
 */
export function preSaveSummary(
  results: ScenarioResult[],
  baseline: ScenarioResult[] | null,
): PreSaveSummary {
  const total = results.length;
  const passed = results.filter((r) => r.passed).length;
  let regressed = 0;
  let fixed = 0;
  let stillFailing = 0;
  for (const r of results) {
    const d = scenarioDelta(r, baseline);
    if (d === 'new-fail') regressed++;
    else if (d === 'fixed') fixed++;
    else if (d === 'still-failing') stillFailing++;
  }
  const s = total === 1 ? '' : 's';
  let text: string;
  if (!baseline) {
    text = `${passed} of ${total} scenario${s} passed`;
  } else if (regressed > 0) {
    text = `${regressed} of ${total} scenario${s} regressed`;
  } else if (stillFailing > 0) {
    text = `no new failures · ${stillFailing} still failing`;
    if (fixed > 0) text += ` · ${fixed} fixed`;
  } else if (fixed > 0) {
    text = `all ${total} pass · ${fixed} fixed`;
  } else {
    text = `all ${total} still pass`;
  }
  return { total, passed, regressed, fixed, stillFailing, clean: regressed === 0, text };
}

/** Human list of what the candidate overrides, for the panel's subtitle. */
export function candidateLabel(candidate: EvalCandidate): string {
  const parts: string[] = [];
  if (candidate.systemPrompt !== undefined) parts.push('system prompt');
  if (candidate.model !== undefined) parts.push('model');
  // `in`, not `!== undefined`: an explicit null IS the edit (routing switched
  // off), and it is exactly the case a `!== undefined` test would hide.
  if ('routing' in candidate) parts.push('model routing');
  return parts.join(' + ');
}

/**
 * A6 slice B — the routing numbers as sentences, per the labels rule: a number
 * a customer reads has to say what it counts, in words, with no stats shorthand
 * to decode. Returns null when the router served nothing in the window, so the
 * panel shows its empty state instead of three zeroes.
 *
 * The remainder is computed as `100 - cheap - escalated` rather than rounded
 * on its own, so the three percentages always add to 100 and nobody has to
 * wonder where the missing point went.
 */
export function routingSummary(s: AgentRoutingStats): {
  /** The two headline figures, split from their labels so the panel can set
   *  the NUMBER large and the words quiet (his feedback 2026-08-23: these are
   *  the payoff of the whole feature and were whispering in 11px). */
  cheap: { pct: number; label: string };
  escalated: { pct: number; label: string };
  unrouted: string | null;
} | null {
  const routed = s.cheapReplies + s.escalatedReplies;
  if (routed === 0 || s.replies === 0) return null;
  const cheapPct = Math.round((s.cheapReplies / s.replies) * 100);
  const escPct = Math.round((s.escalatedReplies / s.replies) * 100);
  const restPct = 100 - cheapPct - escPct;
  return {
    cheap: { pct: cheapPct, label: 'of replies were answered by the cheap model' },
    escalated: { pct: escPct, label: 'started cheap and escalated to the main model' },
    unrouted:
      s.unroutedReplies > 0 && restPct > 0
        ? `The other ${restPct}% ran on the main model without routing — it was switched off when they were sent.`
        : null,
  };
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

/**
 * Judge verdict dot colour — the only place judge colour is minted, same
 * doctrine as runDot. `skipped` deliberately borrows the muted t3 used by the
 * `skipped` status badge: it is neither a pass nor a failure.
 */
export function judgeDot(verdict: JudgeVerdictRecord['verdict']): string {
  if (verdict === 'pass') return 'var(--ok)';
  if (verdict === 'fail') return 'var(--err)';
  return 'var(--t3)';
}

/** Why a dimension can come back unjudged — shown on every skipped chip. */
export const JUDGE_SKIP_HINT =
  'Not judged: this run had no judge available (a CLI run, or an agent whose LLM credentials could not be opened). Neither a pass nor a failure.';

/** True when a scenario's judged records span more than one turn. */
export function judgedSpansTurns(judged: JudgeVerdictRecord[]): boolean {
  return judged.some((r) => r.turn !== judged[0].turn);
}

/**
 * Chip text: the dimension, its score when the dimension is a scored one, and
 * the turn only when the scenario judged more than one (keeps the common
 * single-turn case short — the turn is always in the tooltip regardless).
 */
export function judgeChipLabel(rec: JudgeVerdictRecord, showTurn: boolean): string {
  const head = showTurn ? `turn ${rec.turn} · ${rec.dim}` : rec.dim;
  if (rec.verdict === 'skipped') return `${head} skipped`;
  return rec.score != null ? `${head} ${rec.score}/5` : head;
}

/** Tooltip: turn + verdict + score always, then the rationale (or the skip hint). */
export function judgeChipTitle(rec: JudgeVerdictRecord): string {
  const head =
    `turn ${rec.turn} · ${rec.dim} · ${rec.verdict}` + (rec.score != null ? ` · ${rec.score}/5` : '');
  return `${head}\n${rec.verdict === 'skipped' ? JUDGE_SKIP_HINT : rec.rationale}`;
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
