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
import { upsertSubscriber } from '../../db/repositories';
import {
  getAgentById,
  openConversation,
  insertConversationMessage,
  getConversationMessageByDedupe,
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
  type Scenario,
} from '../../core/eval-runner';

export interface EvalRunJobData {
  runId: string;
}

/**
 * The in-process turn driver: mirrors POST /v1/agents/:identifier/messages'
 * server-side work (agents.ts), bound to one tenant + agent. Kept as a small
 * replica rather than a shared extraction so this slice touches neither the
 * messages route nor conversation.processor.ts (owned elsewhere).
 */
function inProcessDriver(tenantId: string, agentId: string): EvalDriver {
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
        { tenantId, conversationId: conversation.id, messageId: message.id },
        { jobId: `conv-${message.id}`, attempts: 5 },
      );
      return { conversationId: conversation.id, inboundRowId: message.id };
    },
  };
}

/** Project the engine's rich verdict to the frozen persisted shape. */
function toStored(r: EvalScenarioResult): EvalRunScenarioResult {
  return { name: r.name, passed: r.passed, failures: r.failures, attempts: r.attempts };
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
    return;
  }

  const evals = await listEnabledEvals(run.tenant_id, run.agent_id);
  const scenarios = evals.map((ev) => ({ name: ev.name, sc: ev.scenario as unknown as Scenario }));

  logExec({
    tenantId: run.tenant_id,
    transactionId: `eval-run-${runId}`,
    level: 'info',
    detail: `eval run started: agent=${agent.identifier} scenarios=${scenarios.length}`,
  });

  let status: 'passed' | 'failed' | 'error';
  let stored: EvalRunScenarioResult[];
  try {
    const results = await runScenarios(scenarios, {
      driver: inProcessDriver(run.tenant_id, run.agent_id),
      nonce: runId,
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
  logExec({
    tenantId: run.tenant_id,
    transactionId: `eval-run-${runId}`,
    level: status === 'passed' ? 'info' : 'warn',
    detail: `eval run ${status}: ${stored.filter((r) => r.passed).length}/${stored.length} passed`,
  });
}
