/**
 * The agent eval harness — "test your agent's prompt like you test your code".
 *
 * A scenario file (evals/<name>.json) scripts a conversation as a list of user
 * turns and EXPECTATIONS ABOUT TOOL CALLS (not prose vibes). This runner drives
 * an EXISTING agent through the real Asyncify API + worker, then asserts the
 * tool-call trace each turn produced.
 *
 *   npm run eval                 # every evals/*.json
 *   npm run eval -- refund-path  # just evals/refund-path.json
 *
 * Env:
 *   ASYNCIFY_API_URL   default http://localhost:3000  (drive path: POST turns)
 *   ASYNCIFY_API_KEY   required                        (x-api-key on the tenant)
 *   ASYNCIFY_EVAL_NONCE optional run id (default Date.now) — keeps subscriber
 *                       ids unique so history never bleeds between runs
 *   DATABASE_URL       used by the repo layer (read path — see below)
 *
 * WHY IT READS THE TRANSCRIPT FROM THE DB (a deliberate divergence):
 * the scenario semantics are defined over the structured breadcrumb
 * `raw.action = {tool, input, result}`, but NO public HTTP route exposes it
 * (GET /v1/conversations/:id returns content/buttons/clicked only), and some
 * tools leave no breadcrumb at all (set_metadata records only conversation
 * metadata; present_* ride the reply row's raw.buttons/raw.card). So the DRIVE
 * path is the real product path (HTTP POST -> queue -> worker -> LLM), and the
 * READ path queries the same Postgres the API writes, reconstructing the tool
 * trace exactly as core/managed-brain.ts replays it. See evals/README.md.
 *
 * The worker MUST be running (npm run worker) — the API only enqueues the turn;
 * the worker runs the brain. A turn that never gets a reply is reported as such.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool';
import { conversationTranscript, type ConversationMessage } from '../src/db/conversations.repo';

const API_URL = (process.env.ASYNCIFY_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.ASYNCIFY_API_KEY ?? '';
const RUN_NONCE = process.env.ASYNCIFY_EVAL_NONCE ?? String(Date.now());
const EVALS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals');

const TURN_TIMEOUT_MS = 60_000;
const POLL_INTERVAL_MS = 1_500;
/** After the reply lands, wait once more so trailing breadcrumbs (bridge writes
 *  its trigger/resolve rows AFTER the reply) are captured in the snapshot. */
const SETTLE_MS = 1_200;
/** A plan-card reply row is mid-progress while its content starts with these. */
const PROGRESS_PREFIX = /^[⏳✓✗]/;

// ---- scenario schema (hand-validated; no deps) ------------------------------

interface Expect {
  tool?: string;
  noTool?: string;
  inputContains?: Record<string, unknown>;
  replyContains?: string;
  replyContainsAny?: string[];
  replyNotContains?: string;
  pendingApproval?: string;
}
type Turn = { user: string } | { expect: Expect };
interface Scenario {
  agent: string;
  description?: string;
  attempts?: number;
  skip?: boolean;
  comment?: string;
  turns: Turn[];
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
}

// ---- the reconstruction: transcript rows -> tool calls ----------------------

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
  const card = raw.card as { type?: string; id?: string; prompt?: string; placeholder?: string; options?: unknown } | undefined;
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
function traceForTurn(turnRows: ConversationMessage[], metaDelta: Record<string, unknown>): TurnSnapshot {
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
  return { calls, lastReply };
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
    return snap.calls.some((c) => c.tool === e.noTool) ? `expected tool "${e.noTool}" NOT to be called` : null;
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
    return includesCI(snap.lastReply, e.replyNotContains) ? `expected reply NOT to contain "${e.replyNotContains}"` : null;
  }
  return 'empty expect (no matcher set)';
}

function describeExpect(e: Expect): string {
  if (e.tool !== undefined) return e.inputContains ? `tool ${e.tool} ${JSON.stringify(e.inputContains)}` : `tool ${e.tool}`;
  if (e.noTool !== undefined) return `noTool ${e.noTool}`;
  if (e.pendingApproval !== undefined) return `pendingApproval ${e.pendingApproval}`;
  if (e.replyContains !== undefined) return `replyContains "${e.replyContains}"`;
  if (e.replyContainsAny !== undefined) return `replyContainsAny ${JSON.stringify(e.replyContainsAny)}`;
  if (e.replyNotContains !== undefined) return `replyNotContains "${e.replyNotContains}"`;
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

// ---- the drive path (real HTTP API) -----------------------------------------

class EvalError extends Error {}

async function api(method: string, path: string, body?: unknown): Promise<{ status: number; json: any }> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new EvalError(`API unreachable at ${API_URL} — is \`npm run api\` running? (${(err as Error).message})`);
  }
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

async function conversationMetadata(conversationId: string): Promise<Record<string, unknown>> {
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
  agent: string,
  subscriberId: string,
  text: string,
  turnIndex: number,
  conversationId: string | null,
): Promise<{ conversationId: string; snap: TurnSnapshot }> {
  const messageId = `${subscriberId}-t${turnIndex}`;
  const metaBefore = conversationId ? await conversationMetadata(conversationId) : {};

  const sent = await api('POST', `/v1/agents/${agent}/messages`, { subscriberId, text, messageId });
  if (sent.status === 404) throw new EvalError(`agent "${agent}" not found on this tenant`);
  if (sent.status === 401 || sent.status === 403) {
    throw new EvalError(`auth rejected (${sent.status}) — check ASYNCIFY_API_KEY`);
  }
  if (sent.status === 409) throw new EvalError(`agent "${agent}" is disabled`);
  if (sent.status !== 202 || !sent.json?.conversationId) {
    throw new EvalError(`send failed (${sent.status}): ${JSON.stringify(sent.json)}`);
  }
  const convId: string = sent.json.conversationId;
  // The response's messageId is the DB ROW id (a uuid); our client-supplied
  // messageId is only its dedupe key. Locate the inbound row by the row id.
  const inboundRowId: string = sent.json.messageId;

  const deadline = Date.now() + TURN_TIMEOUT_MS;
  let settled: ConversationMessage[] | null = null;
  while (Date.now() < deadline) {
    const rows = await conversationTranscript(convId);
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
    const rows = await conversationTranscript(convId);
    const inboundIdx = rows.findIndex((m) => m.id === inboundRowId);
    const turnRows = inboundIdx >= 0 ? rows.slice(inboundIdx + 1) : [];
    const snap = traceForTurn(turnRows, metadataDelta(metaBefore, await conversationMetadata(convId)));
    throw new EvalError(
      `no agent reply within ${TURN_TIMEOUT_MS / 1000}s — is \`npm run worker\` running?\n        ${describeTrace(snap)}`,
    );
  }

  // Let trailing breadcrumbs (bridge writes trigger/resolve after the reply) land.
  await sleep(SETTLE_MS);
  const rows = await conversationTranscript(convId);
  const inboundIdx = rows.findIndex((m) => m.id === inboundRowId);
  const turnRows = inboundIdx >= 0 ? rows.slice(inboundIdx + 1) : [];
  const metaAfter = await conversationMetadata(convId);
  const snap = traceForTurn(turnRows, metadataDelta(metaBefore, metaAfter));
  return { conversationId: convId, snap };
}

// ---- attempt / scenario runners ---------------------------------------------

interface AttemptResult {
  passed: boolean;
  failure?: { turn: number; expect: string; reason: string; trace: string };
}

async function runAttempt(sc: Scenario, subscriberId: string): Promise<AttemptResult> {
  let conversationId: string | null = null;
  let lastSnap: TurnSnapshot | null = null;
  let turnIndex = 0;
  for (const turn of sc.turns) {
    if ('user' in turn) {
      turnIndex += 1;
      const out = await runTurn(sc.agent, subscriberId, turn.user, turnIndex, conversationId);
      conversationId = out.conversationId;
      lastSnap = out.snap;
    } else {
      if (!lastSnap) {
        return {
          passed: false,
          failure: { turn: turnIndex, expect: describeExpect(turn.expect), reason: 'expect before any user turn', trace: '(none)' },
        };
      }
      const reason = evalExpect(turn.expect, lastSnap);
      if (reason) {
        return {
          passed: false,
          failure: { turn: turnIndex, expect: describeExpect(turn.expect), reason, trace: describeTrace(lastSnap) },
        };
      }
    }
  }
  return { passed: true };
}

interface ScenarioResult {
  name: string;
  status: 'pass' | 'fail' | 'skip' | 'error';
  attemptsUsed: number;
  attemptsTotal: number;
  detail?: string;
}

async function runScenario(name: string, sc: Scenario): Promise<ScenarioResult> {
  const attemptsTotal = Math.max(1, sc.attempts ?? 1);
  if (sc.skip) {
    return { name, status: 'skip', attemptsUsed: 0, attemptsTotal, detail: sc.comment ?? 'skipped' };
  }
  let lastFailure: AttemptResult['failure'];
  for (let attempt = 1; attempt <= attemptsTotal; attempt += 1) {
    const subscriberId = `eval-${name}-${RUN_NONCE}-a${attempt}`;
    let result: AttemptResult;
    try {
      result = await runAttempt(sc, subscriberId);
    } catch (err) {
      if (err instanceof EvalError) {
        // A drive/infra error aborts the whole scenario — retrying attempts
        // against a down worker just wastes 60s each.
        return { name, status: 'error', attemptsUsed: attempt, attemptsTotal, detail: err.message };
      }
      throw err;
    }
    if (result.passed) {
      return { name, status: 'pass', attemptsUsed: attempt, attemptsTotal };
    }
    lastFailure = result.failure;
  }
  const f = lastFailure!;
  return {
    name,
    status: 'fail',
    attemptsUsed: attemptsTotal,
    attemptsTotal,
    detail: `turn ${f.turn} · ${f.expect}\n        ${f.reason}\n        ${f.trace}`,
  };
}

// ---- scenario loading + reporting -------------------------------------------

function loadScenarios(filter?: string): Array<{ name: string; sc: Scenario }> {
  let files: string[];
  try {
    files = readdirSync(EVALS_DIR).filter((f) => f.endsWith('.json'));
  } catch {
    throw new EvalError(`no evals directory at ${EVALS_DIR}`);
  }
  const out: Array<{ name: string; sc: Scenario }> = [];
  for (const file of files.sort()) {
    const name = file.replace(/\.json$/, '');
    if (filter && name !== filter) continue;
    let sc: Scenario;
    try {
      sc = JSON.parse(readFileSync(join(EVALS_DIR, file), 'utf8')) as Scenario;
    } catch (err) {
      throw new EvalError(`could not parse evals/${file}: ${(err as Error).message}`);
    }
    if (!sc.agent || !Array.isArray(sc.turns)) {
      throw new EvalError(`evals/${file} is missing "agent" or "turns"`);
    }
    out.push({ name, sc });
  }
  if (filter && out.length === 0) throw new EvalError(`no scenario named "${filter}" in evals/`);
  return out;
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + ' '.repeat(n - s.length);
}

function report(results: ScenarioResult[]): void {
  const icon: Record<ScenarioResult['status'], string> = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', error: 'ERR ' };
  const nameW = Math.max(8, ...results.map((r) => r.name.length));
  console.log('');
  console.log(`  ${pad('SCENARIO', nameW)}  RESULT  ATTEMPTS`);
  console.log(`  ${'-'.repeat(nameW)}  ------  --------`);
  for (const r of results) {
    const attempts =
      r.status === 'skip' ? '  -' : r.status === 'pass' ? `${r.attemptsUsed}/${r.attemptsTotal}` : `${r.attemptsUsed}/${r.attemptsTotal}`;
    console.log(`  ${pad(r.name, nameW)}  ${icon[r.status]}    ${attempts}`);
  }

  const notable = results.filter((r) => r.status !== 'pass');
  if (notable.length > 0) {
    console.log('');
    for (const r of notable) {
      console.log(`  [${icon[r.status].trim()}] ${r.name}`);
      if (r.detail) console.log(`        ${r.detail}`);
    }
  }

  const passed = results.filter((r) => r.status === 'pass').length;
  const failed = results.filter((r) => r.status === 'fail' || r.status === 'error').length;
  const skipped = results.filter((r) => r.status === 'skip').length;
  console.log('');
  console.log(`  ${passed} passed · ${failed} failed · ${skipped} skipped`);
}

async function main() {
  if (!API_KEY) {
    throw new EvalError('ASYNCIFY_API_KEY is required (the tenant api key, e.g. dev-api-key-123)');
  }
  const filter = process.argv[2];
  const scenarios = loadScenarios(filter);
  console.log(`Running ${scenarios.length} scenario(s) against ${API_URL} (run ${RUN_NONCE})`);

  const results: ScenarioResult[] = [];
  for (const { name, sc } of scenarios) {
    process.stdout.write(`  · ${name} … `);
    const result = await runScenario(name, sc);
    console.log(result.status.toUpperCase());
    results.push(result);
  }

  report(results);
  const anyFailed = results.some((r) => r.status === 'fail' || r.status === 'error');
  await pool.end();
  process.exit(anyFailed ? 1 : 0);
}

main().catch(async (err) => {
  if (err instanceof EvalError) {
    console.error(`\neval error: ${err.message}`);
  } else {
    console.error('\neval crashed:', err);
  }
  await pool.end().catch(() => {});
  process.exit(1);
});
