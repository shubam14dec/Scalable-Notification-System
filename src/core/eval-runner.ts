/**
 * The agent eval ENGINE — extracted from scripts/eval.ts (Phase 22, slice B) so
 * two callers can share one implementation:
 *
 *   1. scripts/eval.ts — the CLI (`npm run eval`), which drives turns over the
 *      real HTTP API with a tenant api key (createHttpDriver).
 *   2. the eval-run worker (workers/processors/eval-run.processor.ts), which has
 *      no plaintext api key for the tenant, so it drives turns IN-PROCESS by
 *      enqueuing conversation-inbound jobs exactly like POST /v1/agents/:id/
 *      messages does (see that processor's inProcessDriver). Both paths run the
 *      SAME production pipeline (queue -> brain) and read the SAME Postgres the
 *      API writes — only the "send one turn" step differs, abstracted behind
 *      EvalDriver.
 *
 * A scenario scripts a conversation as a list of user turns and EXPECTATIONS
 * ABOUT TOOL CALLS (not prose vibes). The engine drives an EXISTING agent, then
 * asserts the tool-call trace each turn produced.
 *
 * WHY IT READS THE TRANSCRIPT FROM THE DB (a deliberate divergence): the scenario
 * semantics are defined over the structured breadcrumb `raw.action =
 * {tool, input, result}`, but NO public HTTP route exposes it, and some tools
 * leave no breadcrumb at all. So the DRIVE path is the real product path, and the
 * READ path queries the same Postgres the API writes, reconstructing the tool
 * trace exactly as core/managed-brain.ts replays it. See evals/README.md.
 */
import { z } from 'zod';
import { pool } from '../db/pool';
import { conversationTranscript, type ConversationMessage } from '../db/conversations.repo';
import {
  isScored,
  judgeReply,
  JudgeError,
  minScoreFor,
  requestedDimensions,
  type JudgeClient,
  type JudgeDimension,
  type JudgeVerdict,
} from './eval-judge';

const TURN_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;
/** After the reply lands, wait once more so trailing breadcrumbs (bridge writes
 *  its trigger/resolve rows AFTER the reply) are captured in the snapshot. */
const SETTLE_MS = 1_200;
/** A plan-card reply row is mid-progress while its content starts with these. */
const PROGRESS_PREFIX = /^[⏳✓✗]/;

// ---- scenario schema --------------------------------------------------------

export interface Expect {
  tool?: string;
  noTool?: string;
  inputContains?: Record<string, unknown>;
  replyContains?: string;
  replyContainsAny?: string[];
  replyNotContains?: string;
  pendingApproval?: string;
  /**
   * LLM-GRADED expectations (Phase A2) — the dimensions a tool assertion cannot
   * express. Additive and optional: an expect without `judge` behaves exactly as
   * it did before, and a judged expect still has to pass its other matchers
   * first (the judge only runs once the deterministic assertions hold).
   *
   * `groundedness: true` is shorthand for the default bar; scores are 1-5 and
   * default to a minimum of 4. See core/eval-judge.ts.
   */
  judge?: {
    groundedness?: true | { min?: number };
    tone?: { rubric?: string; min?: number };
    refusal?: 'must_refuse' | 'must_answer';
  };
}
export type Turn = { user: string } | { expect: Expect };
export interface Scenario {
  /** Which agent this scenario targets (CLI). The in-process runner binds the
   *  agent from the eval row, so a stored scenario's `agent` is advisory. */
  agent?: string;
  description?: string;
  attempts?: number;
  skip?: boolean;
  comment?: string;
  turns: Turn[];
}

/**
 * Minimal scenario validation, LIFTED here so the eval-CRUD route (POST/PUT
 * /v1/agents/:id/evals) and the runner share one source of truth: a scenario is
 * an object with a non-empty `turns` array of `{user}` | `{expect}` steps.
 */
/** Judge scores are 1-5; anything outside that is an author mistake, not a bar. */
const MinScoreSchema = z.number().int().min(1).max(5);

/**
 * The `expect.judge` block is validated STRICTLY — unknown dimension keys are
 * rejected rather than silently ignored, because a typo'd dimension ("grounded"
 * for "groundedness") would otherwise look like a passing eval that never ran a
 * judge. Everything ELSE inside `expect` stays permissive (`catchall`), which is
 * what keeps every pre-A2 scenario validating byte-for-byte as before.
 */
const JudgeSpecSchema = z
  .object({
    groundedness: z
      .union([z.literal(true), z.object({ min: MinScoreSchema.optional() }).strict()])
      .optional(),
    tone: z
      .object({ rubric: z.string().min(1).max(2048).optional(), min: MinScoreSchema.optional() })
      .strict()
      .optional(),
    refusal: z.enum(['must_refuse', 'must_answer']).optional(),
  })
  .strict()
  .refine((j) => j.groundedness !== undefined || j.tone !== undefined || j.refusal !== undefined, {
    message: 'judge needs at least one dimension (groundedness, tone, refusal)',
  });

export const ScenarioSchema = z.object({
  agent: z.string().min(1).max(255).optional(),
  description: z.string().max(4096).optional(),
  attempts: z.number().int().min(1).max(10).optional(),
  skip: z.boolean().optional(),
  comment: z.string().max(4096).optional(),
  turns: z
    .array(
      z.union([
        z.object({ user: z.string().min(1).max(8192) }),
        z.object({
          expect: z.object({ judge: JudgeSpecSchema.optional() }).catchall(z.unknown()),
        }),
      ]),
    )
    .min(1)
    .max(100),
});

/** null = valid; otherwise a human-readable reason string (for a 400). */
export function validateScenario(obj: unknown): string | null {
  const parsed = ScenarioSchema.safeParse(obj);
  if (parsed.success) return null;
  return parsed.error.issues.map((i) => `${i.path.join('.') || 'scenario'}: ${i.message}`).join('; ');
}

// ---- a turn's reconstructed tool trace --------------------------------------

interface ToolCall {
  tool: string;
  input: Record<string, unknown>;
  result: string;
}
interface TurnSnapshot {
  calls: ToolCall[];
  lastReply: string | null;
  /**
   * Conversation rows up to AND INCLUDING the reply under judgment — the judge's
   * evidence window (A2). Empty when the turn produced no reply. Assertions never
   * read it, so a non-judged run pays only the slice.
   */
  transcript: ConversationMessage[];
}

function rawOf(m: ConversationMessage): Record<string, unknown> {
  return (m.raw ?? {}) as Record<string, unknown>;
}

/**
 * A system breadcrumb's tool call. Managed turns store `raw.action`; bridge
 * turns store only human text (metadata.set/trigger/resolve via systemNote),
 * so fall back to parsing the content — the same legacy parse core/managed-brain
 * does. Non-action system rows (typing, notes, dead) return null.
 */
function breadcrumbCall(m: ConversationMessage): ToolCall | null {
  const action = rawOf(m).action as
    | { tool?: string; input?: Record<string, unknown>; result?: string }
    | undefined;
  if (action?.tool) {
    return { tool: action.tool, input: action.input ?? {}, result: action.result ?? '' };
  }
  const trigger = /^triggered workflow (\S+)/.exec(m.content);
  if (trigger) {
    return { tool: 'trigger_workflow', input: { workflowKey: trigger[1] }, result: m.content };
  }
  if (/^conversation resolved/.test(m.content)) {
    return { tool: 'resolve_conversation', input: {}, result: m.content };
  }
  return null;
}

/**
 * Presentation tools leave no breadcrumb — they ride the reply row's
 * raw.buttons / raw.card. Reconstruct them the way managed-brain replays
 * history, so present_buttons/present_choices/request_input are assertable.
 */
function presentationCalls(m: ConversationMessage): ToolCall[] {
  const raw = rawOf(m);
  const calls: ToolCall[] = [];
  const buttons = raw.buttons as unknown[] | undefined;
  if (Array.isArray(buttons) && buttons.length > 0) {
    calls.push({ tool: 'present_buttons', input: { buttons }, result: '' });
  }
  const card = raw.card as
    | { type?: string; id?: string; prompt?: string; placeholder?: string; options?: unknown }
    | undefined;
  if (card?.type === 'select') {
    calls.push({
      tool: 'present_choices',
      input: { id: card.id, ...(card.prompt ? { prompt: card.prompt } : {}), options: card.options },
      result: '',
    });
  } else if (card?.type === 'text_input') {
    calls.push({
      tool: 'request_input',
      input: {
        id: card.id,
        ...(card.prompt ? { prompt: card.prompt } : {}),
        ...(card.placeholder ? { placeholder: card.placeholder } : {}),
      },
      result: '',
    });
  }
  return calls;
}

/**
 * Assemble the tool trace for the rows a turn produced. `metaDelta` are keys
 * that changed in conversation.metadata this turn — the only evidence
 * set_metadata ran (it writes no breadcrumb), surfaced as synthetic calls.
 */
function traceForTurn(
  turnRows: ConversationMessage[],
  metaDelta: Record<string, unknown>,
  transcript: ConversationMessage[],
): TurnSnapshot {
  const calls: ToolCall[] = [];
  let lastReply: string | null = null;
  for (const m of turnRows) {
    if (m.deleted_at) continue;
    if (m.role === 'system') {
      const call = breadcrumbCall(m);
      if (call) calls.push(call);
    } else if (m.role === 'agent') {
      calls.push(...presentationCalls(m));
      if (!PROGRESS_PREFIX.test(m.content)) lastReply = m.content;
    }
  }
  for (const [key, value] of Object.entries(metaDelta)) {
    calls.push({ tool: 'set_metadata', input: { key, value }, result: `saved ${key}` });
  }
  return { calls, lastReply, transcript };
}

/**
 * The judge's evidence window: every row from the start of the conversation
 * through the reply this turn produced. Anything AFTER the reply (trailing
 * bridge breadcrumbs) is excluded — a claim cannot be grounded in evidence that
 * did not exist when the reply was written.
 */
function transcriptThroughReply(
  rows: ConversationMessage[],
  inboundIdx: number,
): ConversationMessage[] {
  for (let i = rows.length - 1; i > inboundIdx; i -= 1) {
    const m = rows[i];
    if (m && m.role === 'agent' && !m.deleted_at && !PROGRESS_PREFIX.test(m.content)) {
      return rows.slice(0, i + 1);
    }
  }
  return [];
}

// ---- expect matchers --------------------------------------------------------

/** subset ⊆ actual: objects recurse; everything else is deep-equal. */
function subsetMatch(subset: unknown, actual: unknown): boolean {
  if (subset && typeof subset === 'object' && !Array.isArray(subset)) {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const a = actual as Record<string, unknown>;
    return Object.entries(subset as Record<string, unknown>).every(([k, v]) => subsetMatch(v, a[k]));
  }
  return JSON.stringify(subset) === JSON.stringify(actual);
}

function includesCI(haystack: string | null, needle: string): boolean {
  return (haystack ?? '').toLowerCase().includes(needle.toLowerCase());
}

/** Evaluate one expect against a snapshot; return null on pass, else a reason. */
function evalExpect(e: Expect, snap: TurnSnapshot): string | null {
  if (e.tool !== undefined) {
    const matches = snap.calls.filter((c) => c.tool === e.tool);
    if (matches.length === 0) return `expected tool "${e.tool}" to be called`;
    if (e.inputContains) {
      const hit = matches.some((c) => subsetMatch(e.inputContains, c.input));
      if (!hit) return `tool "${e.tool}" called, but no call's input matched ${JSON.stringify(e.inputContains)}`;
    }
    return null;
  }
  if (e.noTool !== undefined) {
    return snap.calls.some((c) => c.tool === e.noTool)
      ? `expected tool "${e.noTool}" NOT to be called`
      : null;
  }
  if (e.pendingApproval !== undefined) {
    const hit = snap.calls.some(
      (c) => c.tool === e.pendingApproval && /^pending human approval/i.test(c.result),
    );
    return hit ? null : `expected a pending-approval pause for tool "${e.pendingApproval}"`;
  }
  if (e.replyContains !== undefined) {
    return includesCI(snap.lastReply, e.replyContains) ? null : `expected reply to contain "${e.replyContains}"`;
  }
  if (e.replyContainsAny !== undefined) {
    return e.replyContainsAny.some((s) => includesCI(snap.lastReply, s))
      ? null
      : `expected reply to contain any of ${JSON.stringify(e.replyContainsAny)}`;
  }
  if (e.replyNotContains !== undefined) {
    return includesCI(snap.lastReply, e.replyNotContains)
      ? `expected reply NOT to contain "${e.replyNotContains}"`
      : null;
  }
  // A judge-only expect is not empty — the judge IS its assertion. It is
  // evaluated separately (runAttempt), because it needs a model call.
  if (e.judge !== undefined) return null;
  return 'empty expect (no matcher set)';
}

/** How much of a judge's rationale rides in the (human-read) failure line. */
const RATIONALE_MAX = 160;

function clipRationale(s: string): string {
  return s.length > RATIONALE_MAX ? `${s.slice(0, RATIONALE_MAX)}…` : s;
}

/**
 * The DETERMINISTIC half of judging: the model returns a score and a rationale,
 * and this function — not the model — decides pass/fail. Scored dimensions fail
 * iff `score < min` (the judge's own verdict field is advisory there, so the bar
 * is always the number the scenario author wrote); refusal fails iff the judge
 * says the reply did not meet the stated requirement.
 *
 * Returns the failure line, or null when the dimension passed.
 */
function judgeFailureLine(spec: NonNullable<Expect['judge']>, v: JudgeVerdict): string | null {
  if (isScored(v.dim)) {
    const min = minScoreFor(spec, v.dim);
    const score = v.score ?? 0;
    if (score >= min) return null;
    return `judge.${v.dim}: ${score}/5 < ${min} — ${clipRationale(v.rationale)}`;
  }
  if (v.verdict === 'fail') {
    return `judge.refusal: expected ${spec.refusal} — ${clipRationale(v.rationale)}`;
  }
  return null;
}

function describeExpect(e: Expect): string {
  if (e.tool !== undefined)
    return e.inputContains ? `tool ${e.tool} ${JSON.stringify(e.inputContains)}` : `tool ${e.tool}`;
  if (e.noTool !== undefined) return `noTool ${e.noTool}`;
  if (e.pendingApproval !== undefined) return `pendingApproval ${e.pendingApproval}`;
  if (e.replyContains !== undefined) return `replyContains "${e.replyContains}"`;
  if (e.replyContainsAny !== undefined) return `replyContainsAny ${JSON.stringify(e.replyContainsAny)}`;
  if (e.replyNotContains !== undefined) return `replyNotContains "${e.replyNotContains}"`;
  if (e.judge !== undefined) return `judge ${requestedDimensions(e.judge).join('+')}`;
  return 'expect';
}

/** Compact, debuggable dump of what a turn actually produced. */
function describeTrace(snap: TurnSnapshot): string {
  const calls = snap.calls.length
    ? snap.calls.map((c) => `${c.tool}(${JSON.stringify(c.input).slice(0, 80)})`).join(', ')
    : '(no tool calls)';
  const reply = snap.lastReply === null ? '(no reply)' : `"${snap.lastReply.slice(0, 120)}"`;
  return `tools: ${calls}\n        reply: ${reply}`;
}

// ---- the drive path (pluggable) ---------------------------------------------

/** A drive/infra error aborts the whole scenario (never a scenario "failure"). */
export class EvalError extends Error {}

/**
 * How a turn is sent. The engine owns the READ path (poll Postgres, reconstruct
 * the trace); a driver owns only "send one user turn", returning the
 * conversation id and the inbound row's id so the engine can slice the turn's
 * rows. Two implementations exist: createHttpDriver (CLI) and the worker's
 * inProcessDriver (see eval-run.processor.ts).
 */
export interface EvalDriver {
  sendTurn(input: {
    agent: string | undefined;
    subscriberId: string;
    text: string;
    turnIndex: number;
    conversationId: string | null;
  }): Promise<{ conversationId: string; inboundRowId: string }>;
}

/** The HTTP driver used by `npm run eval`: POST turns via the real API. */
export function createHttpDriver(opts: { apiUrl: string; apiKey: string }): EvalDriver {
  const apiUrl = opts.apiUrl.replace(/\/$/, '');
  async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
    let res: Response;
    try {
      res = await fetch(`${apiUrl}${path}`, {
        method,
        headers: { 'content-type': 'application/json', 'x-api-key': opts.apiKey },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (err) {
      throw new EvalError(
        `API unreachable at ${apiUrl} — is \`npm run api\` running? (${(err as Error).message})`,
      );
    }
    const json = await res.json().catch(() => ({}));
    return { status: res.status, json };
  }
  return {
    async sendTurn({ agent, subscriberId, text, turnIndex }) {
      const messageId = `${subscriberId}-t${turnIndex}`;
      const sent = await api('POST', `/v1/agents/${agent}/messages`, { subscriberId, text, messageId });
      if (sent.status === 404) throw new EvalError(`agent "${agent}" not found on this tenant`);
      if (sent.status === 401 || sent.status === 403) {
        throw new EvalError(`auth rejected (${sent.status}) — check ASYNCIFY_API_KEY`);
      }
      if (sent.status === 409) throw new EvalError(`agent "${agent}" is disabled`);
      if (sent.status !== 202 || !sent.json?.conversationId) {
        throw new EvalError(`send failed (${sent.status}): ${JSON.stringify(sent.json)}`);
      }
      // The response's messageId is the DB ROW id (a uuid); our client-supplied
      // messageId is only its dedupe key. The engine locates rows by the row id.
      return { conversationId: sent.json.conversationId, inboundRowId: sent.json.messageId };
    },
  };
}

// ---- engine deps (DB reads, injectable for tests) ---------------------------

export interface RunnerDeps {
  /** Full transcript read; defaults to the shared conversations.repo. */
  transcript?: (conversationId: string) => Promise<ConversationMessage[]>;
  /** conversation.metadata read; defaults to a direct pool query. */
  metadata?: (conversationId: string) => Promise<Record<string, unknown>>;
}

/**
 * Wiring for LLM-graded expects (A2). ABSENT is a first-class state, not an
 * error: the CLI has no server-side LLM credentials, so a `npm run eval` run
 * marks judged dimensions SKIPPED (visibly, in `judged[]`) and keeps grading the
 * deterministic assertions. Only the worker, which can build the agent's own
 * client, passes this.
 */
export interface JudgeRunOptions {
  client: JudgeClient;
  model: string;
  /** The agent's persona, graded against for the tone dimension. */
  systemPrompt: string | null;
  /** Forwarded to the judge; pass null on models that reject sampling params. */
  temperature?: number | null;
}

export interface RunScenariosOptions extends RunnerDeps {
  driver: EvalDriver;
  /** Unique per run — keeps subscriber ids distinct so history never bleeds. */
  nonce: string;
  judge?: JudgeRunOptions;
}

async function defaultMetadata(conversationId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query('select metadata from conversations where id = $1', [conversationId]);
  return (rows[0]?.metadata ?? {}) as Record<string, unknown>;
}

/** Keys present-and-changed in `after` relative to `before`. */
function metadataDelta(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): Record<string, unknown> {
  const delta: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(after)) {
    if (JSON.stringify(before[k]) !== JSON.stringify(v)) delta[k] = v;
  }
  return delta;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Send one user turn and wait for the agent's reply to land, then snapshot the
 * rows THIS turn produced (everything after the inbound row) plus the metadata
 * delta. `conversationId` is discovered on the first turn and reused after.
 */
async function runTurn(
  driver: EvalDriver,
  read: Required<RunnerDeps>,
  agent: string | undefined,
  subscriberId: string,
  text: string,
  turnIndex: number,
  conversationId: string | null,
): Promise<{ conversationId: string; snap: TurnSnapshot }> {
  const metaBefore = conversationId ? await read.metadata(conversationId) : {};

  const { conversationId: convId, inboundRowId } = await driver.sendTurn({
    agent,
    subscriberId,
    text,
    turnIndex,
    conversationId,
  });

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let settled: ConversationMessage[] | null = null;
  while (Date.now() < deadline) {
    const rows = await read.transcript(convId);
    const inboundIdx = rows.findIndex((m) => m.id === inboundRowId);
    const turnRows = inboundIdx >= 0 ? rows.slice(inboundIdx + 1) : [];
    const replyLanded = turnRows.some(
      (m) => m.role === 'agent' && !m.deleted_at && !PROGRESS_PREFIX.test(m.content),
    );
    if (replyLanded) {
      settled = rows;
      break;
    }
    await sleep(POLL_INTERVAL_MS);
  }

  if (!settled) {
    // Show whatever DID land — a turn with breadcrumbs but no reply is the most
    // informative failure (worker crash, model refusal, plan card frozen).
    const rows = await read.transcript(convId);
    const inboundIdx = rows.findIndex((m) => m.id === inboundRowId);
    const turnRows = inboundIdx >= 0 ? rows.slice(inboundIdx + 1) : [];
    const snap = traceForTurn(turnRows, metadataDelta(metaBefore, await read.metadata(convId)), []);
    throw new EvalError(
      `no agent reply within ${TURN_TIMEOUT_MS / 1000}s — is \`npm run worker\` running?\n        ${describeTrace(snap)}`,
    );
  }

  // Let trailing breadcrumbs (bridge writes trigger/resolve after the reply) land.
  await sleep(SETTLE_MS);
  const rows = await read.transcript(convId);
  const inboundIdx = rows.findIndex((m) => m.id === inboundRowId);
  const turnRows = inboundIdx >= 0 ? rows.slice(inboundIdx + 1) : [];
  const metaAfter = await read.metadata(convId);
  const snap = traceForTurn(
    turnRows,
    metadataDelta(metaBefore, metaAfter),
    transcriptThroughReply(rows, inboundIdx),
  );
  return { conversationId: convId, snap };
}

// ---- attempt / scenario runners ---------------------------------------------

/**
 * One dimension's outcome on one turn — ADDITIVE detail (scores + rationales)
 * that rides alongside the frozen `failures[]`, never inside it.
 */
export interface JudgeVerdictRecord {
  turn: number;
  dim: JudgeDimension;
  verdict: 'pass' | 'fail' | 'skipped';
  score?: number;
  rationale: string;
}

const SKIP_RATIONALE = 'judge requires server-side run';

interface AttemptResult {
  passed: boolean;
  failure?: { turn: number; expect: string; reason: string; trace: string };
  judged: JudgeVerdictRecord[];
}

async function runAttempt(
  sc: Scenario,
  subscriberId: string,
  driver: EvalDriver,
  read: Required<RunnerDeps>,
  judge?: JudgeRunOptions,
): Promise<AttemptResult> {
  let conversationId: string | null = null;
  let lastSnap: TurnSnapshot | null = null;
  let turnIndex = 0;
  const judged: JudgeVerdictRecord[] = [];
  for (const turn of sc.turns) {
    if ('user' in turn) {
      turnIndex += 1;
      const out = await runTurn(driver, read, sc.agent, subscriberId, turn.user, turnIndex, conversationId);
      conversationId = out.conversationId;
      lastSnap = out.snap;
    } else {
      if (!lastSnap) {
        return {
          passed: false,
          judged,
          failure: { turn: turnIndex, expect: describeExpect(turn.expect), reason: 'expect before any user turn', trace: '(none)' },
        };
      }
      const reason = evalExpect(turn.expect, lastSnap);
      if (reason) {
        return {
          passed: false,
          judged,
          failure: { turn: turnIndex, expect: describeExpect(turn.expect), reason, trace: describeTrace(lastSnap) },
        };
      }
      const spec = turn.expect.judge;
      if (!spec) continue;

      // No judge client (the CLI): record a visible skip and keep going. A
      // dimension that could not be graded must never read as a silent pass,
      // and must never block the assertions that DID run.
      if (!judge) {
        for (const dim of requestedDimensions(spec)) {
          judged.push({ turn: turnIndex, dim, verdict: 'skipped', rationale: SKIP_RATIONALE });
        }
        continue;
      }
      if (lastSnap.lastReply === null) {
        return {
          passed: false,
          judged,
          failure: { turn: turnIndex, expect: describeExpect(turn.expect), reason: 'judged expect but the turn produced no reply', trace: describeTrace(lastSnap) },
        };
      }

      const verdicts = await judgeReply({
        client: judge.client,
        model: judge.model,
        transcript: lastSnap.transcript,
        reply: lastSnap.lastReply,
        systemPrompt: judge.systemPrompt,
        spec,
        ...(judge.temperature === undefined ? {} : { temperature: judge.temperature }),
      });

      const judgeFailures: string[] = [];
      for (const v of verdicts) {
        const line = judgeFailureLine(spec, v);
        judged.push({
          turn: turnIndex,
          dim: v.dim,
          verdict: line ? 'fail' : 'pass',
          ...(v.score === undefined ? {} : { score: v.score }),
          rationale: v.rationale,
        });
        if (line) judgeFailures.push(line);
      }
      if (judgeFailures.length > 0) {
        // Judge failures are ordinary scenario failures: same failure shape, so
        // they consume the same attempts/retry budget as an assertion miss.
        return {
          passed: false,
          judged,
          failure: { turn: turnIndex, expect: describeExpect(turn.expect), reason: judgeFailures.join('; '), trace: describeTrace(lastSnap) },
        };
      }
    }
  }
  return { passed: true, judged };
}

/**
 * The per-scenario verdict. The FROZEN, persisted/dashboard shape is
 * {name, passed, failures, attempts} (see agent_eval_runs.results); `status`,
 * `attemptsTotal`, and `detail` are engine extras the CLI renders and the
 * eval-run processor uses to compute run status.
 */
export interface EvalScenarioResult {
  name: string;
  passed: boolean;
  failures: string[];
  /** attempts USED (a passing scenario may pass on attempt 1 of N). */
  attempts: number;
  status: 'pass' | 'fail' | 'skip' | 'error';
  attemptsTotal: number;
  detail?: string;
  /**
   * A2, ADDITIVE: per-dimension judge scores and rationales for the attempt that
   * decided the verdict. Present ONLY when the scenario used `expect.judge` — a
   * scenario without it serializes exactly as it did before A2.
   */
  judged?: JudgeVerdictRecord[];
}

/**
 * The additive keys a judged scenario carries. Returns `{}` when the scenario
 * never used a judge, which is what keeps the frozen shape byte-identical.
 */
function judgeExtras(judged: JudgeVerdictRecord[]): { detail?: string; judged?: JudgeVerdictRecord[] } {
  if (judged.length === 0) return {};
  const skipped = judged.filter((j) => j.verdict === 'skipped');
  return {
    ...(skipped.length > 0
      ? { detail: `judge skipped (${skipped.map((s) => s.dim).join(', ')}) — ${SKIP_RATIONALE}` }
      : {}),
    judged,
  };
}

/** Run ONE scenario (with its retry budget). Never throws — infra failures come
 *  back as status 'error'. */
export async function runScenario(
  name: string,
  sc: Scenario,
  options: RunScenariosOptions,
): Promise<EvalScenarioResult> {
  const read: Required<RunnerDeps> = {
    transcript: options.transcript ?? conversationTranscript,
    metadata: options.metadata ?? defaultMetadata,
  };
  const attemptsTotal = Math.max(1, sc.attempts ?? 1);
  if (sc.skip) {
    return { name, passed: true, failures: [], attempts: 0, status: 'skip', attemptsTotal, detail: sc.comment ?? 'skipped' };
  }
  let lastFailure: AttemptResult['failure'];
  let lastJudged: JudgeVerdictRecord[] = [];
  for (let attempt = 1; attempt <= attemptsTotal; attempt += 1) {
    const subscriberId = `eval-${name}-${options.nonce}-a${attempt}`;
    let result: AttemptResult;
    try {
      result = await runAttempt(sc, subscriberId, options.driver, read, options.judge);
    } catch (err) {
      // A judge that cannot be parsed (after its one re-ask) is infra, exactly
      // like an unreachable worker — never a scenario "failure".
      if (err instanceof EvalError || err instanceof JudgeError) {
        const message = err instanceof JudgeError ? `judge unavailable — ${err.message}` : err.message;
        // A drive/infra error aborts the whole scenario — retrying attempts
        // against a down worker just wastes 60s each.
        return {
          name,
          passed: false,
          failures: [message],
          attempts: attempt,
          status: 'error',
          attemptsTotal,
          detail: message,
        };
      }
      throw err;
    }
    if (result.passed) {
      return {
        name,
        passed: true,
        failures: [],
        attempts: attempt,
        status: 'pass',
        attemptsTotal,
        ...judgeExtras(result.judged),
      };
    }
    lastFailure = result.failure;
    lastJudged = result.judged;
  }
  const f = lastFailure!;
  const detail = `turn ${f.turn} · ${f.expect}\n        ${f.reason}\n        ${f.trace}`;
  return {
    name,
    passed: false,
    failures: [detail],
    attempts: attemptsTotal,
    status: 'fail',
    attemptsTotal,
    detail,
    ...(lastJudged.length > 0 ? { judged: lastJudged } : {}),
  };
}

/** Run a list of named scenarios sequentially. `onStart` lets the CLI print a
 *  progress line before each scenario runs (the engine itself prints nothing). */
export async function runScenarios(
  scenarios: Array<{ name: string; sc: Scenario }>,
  options: RunScenariosOptions,
  onStart?: (name: string) => void,
): Promise<EvalScenarioResult[]> {
  const results: EvalScenarioResult[] = [];
  for (const { name, sc } of scenarios) {
    onStart?.(name);
    results.push(await runScenario(name, sc, options));
  }
  return results;
}
