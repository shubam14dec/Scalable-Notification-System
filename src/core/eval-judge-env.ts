/**
 * The eval CLI's judge wiring (Phase A3, slice B): build a REAL judge client
 * from ENVIRONMENT credentials, so `npm run eval` — and the CI gate built on
 * top of it — grades `expect.judge` dimensions instead of reporting them
 * skipped.
 *
 * WHY THIS EXISTS SEPARATELY FROM THE WORKER'S WIRING: the eval-run worker
 * judges with THE AGENT'S OWN credentials (buildJudgeOptions ->
 * buildManagedClient, eval-run.processor.ts) — a sealed per-tenant key and an
 * SSRF-pinned base URL read out of the database. The CLI has neither: it drives
 * the API with a tenant API KEY, which is not an LLM credential. So the judge it
 * uses is the OPERATOR'S own: creds supplied by the person (or the CI job)
 * running the harness, in env.
 *
 * ENV CONTRACT (ASYNCIFY_JUDGE_* wins, EVAL_LLM_* is the friendlier alias):
 *   ASYNCIFY_JUDGE_API_KEY  ?? EVAL_LLM_API_KEY   the judge's key — the switch
 *                                                 that turns judging on at all
 *   ASYNCIFY_JUDGE_MODEL    ?? EVAL_LLM_MODEL     REQUIRED when a key is set
 *   ASYNCIFY_JUDGE_BASE_URL ?? EVAL_LLM_BASE_URL  optional Anthropic-COMPATIBLE
 *                                                 endpoint (glm, a proxy, …)
 *
 * NO DEFAULT MODEL, deliberately: a judge silently defaulting to some model is a
 * scoring change nobody reviewed, and judged scores are only comparable across
 * runs when the judge is pinned. Key without model is a hard, named error.
 *
 * NO PERSONA (systemPrompt: null): the worker passes `agent.system_prompt`, and
 * eval-judge.ts uses it as the yardstick for the `tone` dimension. This process
 * never reads the agent row (it only holds an API key), so inventing a persona
 * here would grade tone against a fiction. Passing null takes the judge's
 * documented fallback — "grade against ordinary professional support tone" —
 * and a scenario that needs more can carry `judge.tone.rubric`, which is read
 * from the SCENARIO and therefore works identically on CLI and worker runs.
 * Consequence worth knowing: a tone score from `npm run eval` is a generic-tone
 * score; the persona-aware one comes from a dashboard/API run.
 *
 * NO SSRF GATE on the base URL, unlike buildManagedClient: that gate exists
 * because llm_base_url is TENANT-supplied data reaching a server-side fetch.
 * Here the URL comes from the environment of the process itself — the operator
 * cannot escalate against themselves — and gating it would break the ordinary
 * case of pointing a local judge at http://localhost, which the guard blocks.
 */
import Anthropic from '@anthropic-ai/sdk';
import { judgeTemperatureFor, type JudgeClient } from './eval-judge';
import { EvalError, type JudgeRunOptions } from './eval-runner';

/** Mirrors managed-brain.ts's client policy: one retry, a bounded wait. */
const JUDGE_TIMEOUT_MS = 60_000;

/** Present-and-non-blank, else undefined — `??` alone would keep `''`. */
function envValue(...values: Array<string | undefined>): string | undefined {
  for (const v of values) {
    const trimmed = v?.trim();
    if (trimmed) return trimmed;
  }
  return undefined;
}

export interface EnvJudgeCreds {
  apiKey: string;
  model: string;
  baseUrl?: string;
}

/**
 * The env creds, or undefined when judging is simply off. Throws EvalError when
 * the operator clearly MEANT to judge (a key is set) but left the model out —
 * that must be a loud failure, never a quiet assertions-only run.
 */
export function readEnvJudgeCreds(env: NodeJS.ProcessEnv): EnvJudgeCreds | undefined {
  const apiKey = envValue(env.ASYNCIFY_JUDGE_API_KEY, env.EVAL_LLM_API_KEY);
  if (!apiKey) return undefined;
  const model = envValue(env.ASYNCIFY_JUDGE_MODEL, env.EVAL_LLM_MODEL);
  if (!model) {
    throw new EvalError(
      'a judge api key is set but no judge model: set EVAL_LLM_MODEL (or ' +
        'ASYNCIFY_JUDGE_MODEL), e.g. glm-4.6. There is no default model — the ' +
        'judge must be pinned for scores to be comparable across runs.',
    );
  }
  const baseUrl = envValue(env.ASYNCIFY_JUDGE_BASE_URL, env.EVAL_LLM_BASE_URL);
  return { apiKey, model, ...(baseUrl === undefined ? {} : { baseUrl }) };
}

/**
 * The minimal env-creds twin of buildManagedClient (managed-brain.ts): same SDK,
 * same "any Anthropic-compatible endpoint" posture, minus the two things that
 * only make sense for a tenant row — opening a sealed secret, and SSRF-pinning a
 * customer-supplied URL (see the header for why neither applies here).
 */
export function buildEnvJudgeClient(creds: EnvJudgeCreds): JudgeClient {
  return new Anthropic({
    apiKey: creds.apiKey,
    baseURL: creds.baseUrl,
    timeout: JUDGE_TIMEOUT_MS,
    maxRetries: 1,
  });
}

/**
 * env -> the runner's judge wiring, or undefined for today's assertions-only
 * behavior. Pure with respect to I/O: constructing the SDK client opens no
 * socket, so this is safe to call (and to test) without a model in reach.
 */
export function buildEnvJudgeOptions(env: NodeJS.ProcessEnv = process.env): JudgeRunOptions | undefined {
  const creds = readEnvJudgeCreds(env);
  if (!creds) return undefined;
  return {
    client: buildEnvJudgeClient(creds),
    model: creds.model,
    // Never a persona — see the header. The judge falls back to ordinary
    // professional support tone, and scenario rubrics still apply.
    systemPrompt: null,
    temperature: judgeTemperatureFor(creds.model),
  };
}
