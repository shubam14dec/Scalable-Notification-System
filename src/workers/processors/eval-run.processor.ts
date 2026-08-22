/**
 * Phase 22 slice B — the eval-run worker. One job = one run of an agent's
 * ENABLED eval scenarios, enqueued by POST /v1/agents/:id/evals/run.
 *
 * HOW IT DRIVES TURNS (the api-drive decision):
 * The eval engine (core/eval-runner.ts) drives a scenario by SENDING user turns
 * and POLLING the transcript. The CLI (`npm run eval`) sends turns over HTTP with
 * a tenant api key — but the worker has NO plaintext api key for the tenant, and
 * minting one would be inventing a credential. So this processor supplies an
 * IN-PROCESS driver (`inProcessDriver`) that replicates POST /v1/agents/:id/
 * messages' server work verbatim — upsert subscriber, open conversation, insert
 * the user row, enqueue a conversation-inbound job — bypassing HTTP auth while
 * still exercising the EXACT production pipeline (queue -> brain). The reply is
 * produced by the same conversation workers processing that queue; the engine's
 * shared READ path polls the same Postgres. No HTTP, no credentials invented.
 *
 * Concurrency is 1 (registered in workers/index.ts): a run is N scripted
 * conversations (minutes), never a hot path. jobId = runId, so a re-enqueue of
 * the same run is a no-op, and finishRun is guarded on status='running'.
 */
import type { Job } from 'bullmq';
import { logger } from '../../shared/logger';
import { logExec } from '../../core/execution-log';
import { getQueue, QUEUE } from '../../shared/queues';
import { emitTenantEvent } from '../../core/tenant-events';
import { upsertSubscriber } from '../../db/repositories';
import {
  getAgentById,
  openConversation,
  insertConversationMessage,
  getConversationMessageByDedupe,
  type Agent,
} from '../../db/conversations.repo';
import {
  finishRun,
  getRunById,
  listEnabledEvals,
  type EvalRunScenarioResult,
} from '../../db/agent-evals.repo';
import {
  runScenarios,
  type EvalDriver,
  type EvalScenarioResult,
  type JudgeRunOptions,
  type Scenario,
} from '../../core/eval-runner';
import { judgeTemperatureFor, type JudgeClient } from '../../core/eval-judge';
import { buildManagedClient, type CandidateConfig } from '../../core/managed-brain';

export interface EvalRunJobData {
  runId: string;
}

/**
 * The in-process turn driver: mirrors POST /v1/agents/:identifier/messages'
 * server-side work (agents.ts), bound to one tenant + agent. Kept as a small
 * replica rather than a shared extraction so this slice touches neither the
 * messages route nor conversation.processor.ts (owned elsewhere).
 *
 * A4: this replica is deliberately where the two paths DIVERGE — a candidate
 * run stamps `evalCandidate` on each conversation job it enqueues. The public
 * route builds the same payload from a fixed field list and never sets it, so
 * the override is reachable only from an eval run.
 */
function inProcessDriver(
  tenantId: string,
  agentId: string,
  candidate?: CandidateConfig,
): EvalDriver {
  return {
    async sendTurn({ subscriberId, text, turnIndex }) {
      const dedupeKey = `${subscriberId}-t${turnIndex}`;
      const subscriber = await upsertSubscriber(tenantId, { subscriberId });
      const conversation = await openConversation({
        tenantId,
        agentId,
        subscriberId: subscriber.id,
        channel: 'inapp',
        threadKey: subscriberId,
        // A5 slice B: eval conversations never join a canary. A run grades the
        // config it was asked to grade — its own candidate, or the live prompt.
        // If a trial running in production could reassign a fraction of these
        // scenarios to a different prompt, every score would be a silent blend
        // of two configs and the whole eval surface would stop meaning anything.
        noCanary: true,
      });
      const message =
        (await insertConversationMessage({
          conversationId: conversation.id,
          tenantId,
          role: 'user',
          content: text,
          dedupeKey,
        })) ?? (await getConversationMessageByDedupe(conversation.id, dedupeKey));
      if (!message) {
        // Unreachable in practice (insert-or-recover); surfaces as a turn timeout.
        throw new Error('failed to insert eval turn');
      }
      await getQueue(QUEUE.CONVERSATION).add(
        message.id,
        {
          tenantId,
          conversationId: conversation.id,
          messageId: message.id,
          // A4: THE override hop. Stamped here and nowhere else — the public
          // message route builds its payload from this same explicit field
          // list, so `evalCandidate` can only ever originate from an eval run.
          ...(candidate ? { evalCandidate: candidate } : {}),
        },
        { jobId: `conv-${message.id}`, attempts: 5 },
      );
      return { conversationId: conversation.id, inboundRowId: message.id };
    },
  };
}

/**
 * Project the engine's rich verdict to the frozen persisted shape. The four
 * frozen keys stay required and FIRST; A2's `judged` is spread in only when the
 * scenario actually used a judge, so a non-judged run serializes byte-identically
 * to its pre-A2 form (the engine drops the key the same way — eval-runner.ts).
 */
function toStored(r: EvalScenarioResult): EvalRunScenarioResult {
  return {
    name: r.name,
    passed: r.passed,
    failures: r.failures,
    attempts: r.attempts,
    ...(r.judged === undefined ? {} : { judged: r.judged }),
  };
}

/* ---------------- A2: the judge wiring ---------------- */

/**
 * The judge temperature predicate now lives in core/eval-judge.ts — the eval CLI
 * picks a temperature too (Phase A3), and a CLI script importing a worker
 * processor to get it would be backwards. Re-exported here so this module's
 * public surface is unchanged.
 */
export { judgeTemperatureFor } from '../../core/eval-judge';

/**
 * Does this scenario actually ask for a judge? Read defensively: `scenario` is
 * raw jsonb cast to Scenario, never re-validated on the read path, so a
 * hand-edited row can be any shape. `skip` scenarios never run (runScenario
 * returns before the judge), so they must not force a client build either.
 */
export function usesJudge(sc: Scenario): boolean {
  const raw = sc as { turns?: unknown; skip?: unknown };
  if (raw.skip === true || !Array.isArray(raw.turns)) return false;
  return raw.turns.some((t) => {
    const expect = (t as { expect?: { judge?: unknown } } | null)?.expect;
    return !!expect && typeof expect === 'object' && expect.judge !== undefined;
  });
}

/**
 * Build the judge wiring for a run, or undefined to run assertions-only.
 *
 * NEVER THROWS. A judge that cannot be built is a degraded run, not a failed
 * one: the scenarios still grade their deterministic assertions, and slice A's
 * skip markers make the missing dimensions visible in `judged[]` rather than
 * silently passing. Reasons it legitimately comes back undefined:
 *   - the agent is a BRIDGE agent — its credentials are a signing secret for
 *     customer code, not an LLM key (bridge agents do reach this processor;
 *     see tests/integration/agent-evals.test.ts).
 *   - no enabled scenario uses `expect.judge` — the client is built LAZILY so a
 *     judge-less agent never pays the cost (nor an SSRF check, nor a key open).
 *   - buildManagedClient threw (no creds, blocked base URL).
 *
 * `buildClient` is injected for tests (house DI style); production takes the
 * default. It is NOT a second parameter on processEvalRun because BullMQ passes
 * a token there (workers/index.ts registers the processor directly).
 *
 * A4 — `candidate` (last, so the existing 3-arg callers are untouched): a run
 * grading a candidate config JUDGES WITH THAT CONFIG. Both overrides apply:
 *   - systemPrompt: the tone dimension grades "does this reply match the
 *     persona?" — the persona under test is the CANDIDATE one, so grading a
 *     candidate reply against the old persona would score the wrong question.
 *   - model: A2's documented tradeoff is that the agent judges itself; the
 *     config under test IS the candidate, so keeping judge and subject on the
 *     same model preserves that property rather than quietly mixing two.
 * The judge still rides the AGENT's client (creds/base URL are the agent's —
 * a candidate carries no credentials), and the temperature predicate runs on
 * the EFFECTIVE model, so a candidate switch to a modern claude id correctly
 * drops `temperature` instead of 400-ing.
 */
export async function buildJudgeOptions(
  agent: Agent,
  scenarios: Array<{ name: string; sc: Scenario }>,
  buildClient: (a: Agent) => Promise<JudgeClient> = buildManagedClient,
  candidate?: CandidateConfig,
): Promise<JudgeRunOptions | undefined> {
  if (agent.runtime !== 'managed') return undefined;
  if (!scenarios.some((s) => usesJudge(s.sc))) return undefined;
  const model = candidate?.model ?? agent.model;
  const systemPrompt = candidate?.systemPrompt ?? agent.system_prompt;
  if (!model) {
    logger.warn({ agent: agent.identifier }, 'eval judge skipped: managed agent has no model');
    return undefined;
  }
  let client: JudgeClient;
  try {
    client = await buildClient(agent);
  } catch (err) {
    // Degraded, not fatal — the run proceeds on its assertions alone.
    logger.warn(
      { err, agent: agent.identifier },
      'eval judge unavailable — running assertions only, judged dimensions will be marked skipped',
    );
    return undefined;
  }
  return {
    client,
    model,
    systemPrompt,
    temperature: judgeTemperatureFor(model),
  };
}

/** Run status from the per-scenario verdicts (error = infra, failed = a scenario
 *  assertion failed). Only reached when the run didn't throw. */
function rollup(results: EvalScenarioResult[]): 'passed' | 'failed' | 'error' {
  if (results.some((r) => r.status === 'error')) return 'error';
  if (results.some((r) => r.status === 'fail')) return 'failed';
  return 'passed';
}

export async function processEvalRun(job: Job<EvalRunJobData>): Promise<void> {
  const { runId } = job.data;
  const run = await getRunById(runId);
  if (!run) return; // deleted underneath us (agent removed) — nothing to run
  if (run.status !== 'running') return; // already finalized — retried job no-ops

  const agent = await getAgentById(run.agent_id);
  if (!agent || agent.status !== 'active') {
    await finishRun(runId, 'error', [
      {
        name: '(run)',
        passed: false,
        failures: [agent ? 'agent is disabled' : 'agent no longer exists'],
        attempts: 0,
      },
    ]);
    // Phase 25 (slice B): run reached a terminal status (persist write).
    void emitTenantEvent(run.tenant_id, 'eval.finished', runId);
    return;
  }

  // A4: the candidate rides the RUN ROW (not the job payload) — one durable
  // source of truth, so a retried job grades exactly what the stored results
  // are attributed to. Bridge agents are already refused at the API; this is
  // the defensive twin of buildJudgeOptions' runtime guard, for a row written
  // before that check existed or edited by hand.
  let candidate = run.candidate ?? undefined;
  if (candidate && agent.runtime !== 'managed') {
    logger.warn(
      { runId, agent: agent.identifier },
      'candidate override ignored: agent is not managed',
    );
    candidate = undefined;
  }

  const evals = await listEnabledEvals(run.tenant_id, run.agent_id);
  const scenarios = evals.map((ev) => ({ name: ev.name, sc: ev.scenario as unknown as Scenario }));

  logExec({
    tenantId: run.tenant_id,
    transactionId: `eval-run-${runId}`,
    level: 'info',
    detail:
      `eval run started: agent=${agent.identifier} scenarios=${scenarios.length}` +
      (candidate ? ' (candidate config)' : ''),
  });

  // A2: LLM-graded expects run on the agent's OWN client (self-judge bias is a
  // documented tradeoff; a judgeModel override is future work). Absent =
  // assertions-only, never a hard failure — see buildJudgeOptions.
  // A4: on a candidate run the judge grades against the config under test (see
  // buildJudgeOptions), not the agent row's stale prompt/model.
  const judge = await buildJudgeOptions(agent, scenarios, buildManagedClient, candidate);

  let status: 'passed' | 'failed' | 'error';
  let stored: EvalRunScenarioResult[];
  try {
    const results = await runScenarios(scenarios, {
      driver: inProcessDriver(run.tenant_id, run.agent_id, candidate),
      nonce: runId,
      ...(judge === undefined ? {} : { judge }),
    });
    status = rollup(results);
    stored = results.map(toStored);
  } catch (err) {
    // A thrown (non-EvalError) failure escaped the engine — the run itself broke.
    logger.error({ err, runId }, 'eval run crashed');
    status = 'error';
    stored = [
      { name: '(run)', passed: false, failures: [(err as Error).message], attempts: 0 },
    ];
  }

  await finishRun(runId, status, stored);
  // Phase 25 (slice B): run reached a terminal status (persist write) — Evals view.
  void emitTenantEvent(run.tenant_id, 'eval.finished', runId);
  logExec({
    tenantId: run.tenant_id,
    transactionId: `eval-run-${runId}`,
    level: status === 'passed' ? 'info' : 'warn',
    detail: `eval run ${status}: ${stored.filter((r) => r.passed).length}/${stored.length} passed`,
  });
}
