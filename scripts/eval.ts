/**
 * The agent eval harness CLI — "test your agent's prompt like you test your code".
 *
 * A scenario file (evals/<name>.json) scripts a conversation as a list of user
 * turns and EXPECTATIONS ABOUT TOOL CALLS (not prose vibes). The ENGINE that
 * drives an agent + asserts the trace lives in src/core/eval-runner.ts (shared
 * with the eval-run worker, Phase 22); this file is the thin CLI over it: load
 * evals/*.json, drive them over the real HTTP API with a tenant api key, print.
 *
 *   npm run eval                 # every evals/*.json
 *   npm run eval -- refund-path  # just evals/refund-path.json
 *
 * Env:
 *   ASYNCIFY_API_URL   default http://localhost:3000  (drive path: POST turns)
 *   ASYNCIFY_API_KEY   required                        (x-api-key on the tenant)
 *   ASYNCIFY_EVAL_NONCE optional run id (default Date.now) — keeps subscriber
 *                       ids unique so history never bleeds between runs
 *   DATABASE_URL       used by the engine's read path (poll the transcript)
 *
 * The worker MUST be running (npm run worker) — the API only enqueues the turn;
 * the worker runs the brain. A turn that never gets a reply is reported as such.
 *
 * LLM-judged expects (`expect.judge`) need a server-side LLM client built from
 * the agent's own credentials, which this CLI has none of — so their dimensions
 * are reported SKIPPED (see reportJudged) while the deterministic assertions in
 * the same scenario grade normally. They grade for real in dashboard/API runs.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool } from '../src/db/pool';
import {
  EvalError,
  createHttpDriver,
  runScenario,
  type EvalScenarioResult,
  type JudgeVerdictRecord,
  type Scenario,
} from '../src/core/eval-runner';

const API_URL = (process.env.ASYNCIFY_API_URL ?? 'http://localhost:3000').replace(/\/$/, '');
const API_KEY = process.env.ASYNCIFY_API_KEY ?? '';
const RUN_NONCE = process.env.ASYNCIFY_EVAL_NONCE ?? String(Date.now());
const EVALS_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'evals');

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

/**
 * One judged dimension, compactly: `groundedness 4/5`, `refusal pass`,
 * `tone skipped`. Scored dimensions print the score (the BAR lives in the
 * scenario, not the record — a failing dimension's full `judge.<dim>: x/5 < min`
 * line is already in the failure detail below).
 */
function fmtVerdict(j: JudgeVerdictRecord): string {
  if (j.score === undefined) return `${j.dim} ${j.verdict}`;
  return `${j.dim} ${j.score}/5${j.verdict === 'fail' ? ' (fail)' : ''}`;
}

/**
 * Judged dimensions never reach the table (only pass/fail does) and a PASSING
 * scenario never reaches the failure block — so without this, a run whose judge
 * never ran would print exactly like a fully graded one. `npm run eval` has no
 * server-side LLM client, so that is the normal case here, and it has to be
 * visible: a dimension that was skipped must never read as a dimension that
 * passed.
 */
function reportJudged(results: EvalScenarioResult[]): void {
  const judgedRows = results.filter((r) => (r.judged?.length ?? 0) > 0);
  if (judgedRows.length === 0) return;
  console.log('');
  for (const r of judgedRows) {
    const judged = r.judged!;
    console.log(`  [JUDGE] ${r.name}`);
    const turns = [...new Set(judged.map((j) => j.turn))].sort((a, b) => a - b);
    for (const turn of turns) {
      const parts = judged.filter((j) => j.turn === turn).map(fmtVerdict);
      console.log(`        turn ${turn} · ${parts.join(' · ')}`);
    }
    const skipped = judged.filter((j) => j.verdict === 'skipped').length;
    if (skipped > 0) {
      console.log(`        ⚠ ${skipped} judged dimension(s) skipped (no judge client on CLI runs)`);
    }
  }
}

function report(results: EvalScenarioResult[]): void {
  const icon: Record<EvalScenarioResult['status'], string> = { pass: 'PASS', fail: 'FAIL', skip: 'SKIP', error: 'ERR ' };
  const nameW = Math.max(8, ...results.map((r) => r.name.length));
  console.log('');
  console.log(`  ${pad('SCENARIO', nameW)}  RESULT  ATTEMPTS`);
  console.log(`  ${'-'.repeat(nameW)}  ------  --------`);
  for (const r of results) {
    const attempts = r.status === 'skip' ? '  -' : `${r.attempts}/${r.attemptsTotal}`;
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

  reportJudged(results);

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

  const driver = createHttpDriver({ apiUrl: API_URL, apiKey: API_KEY });
  const results: EvalScenarioResult[] = [];
  for (const { name, sc } of scenarios) {
    process.stdout.write(`  · ${name} … `);
    const result = await runScenario(name, sc, { driver, nonce: RUN_NONCE });
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
