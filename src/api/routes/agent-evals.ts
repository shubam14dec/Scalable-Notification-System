import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { getAgent } from '../../db/conversations.repo';
import { getQueue, QUEUE } from '../../shared/queues';
import { validateScenario } from '../../core/eval-runner';
import {
  createEval,
  createRun,
  deleteEval,
  getEval,
  getRun,
  listEvals,
  listRuns,
  updateEval,
  type AgentEval,
  type AgentEvalRun,
} from '../../db/agent-evals.repo';

/**
 * Phase 22: per-agent eval scenarios + runs. CRUD over agent_evals, run enqueue
 * + results over agent_eval_runs. Response shapes are frozen (dashboard slice C
 * codes against them). Every route resolves the agent by :identifier like
 * agents.ts, 404-ing an unknown agent.
 */
function evalView(row: AgentEval) {
  return {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    scenario: row.scenario,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function runView(row: AgentEvalRun) {
  return {
    id: row.id,
    status: row.status,
    trigger: row.trigger,
    results: row.results,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
  };
}

const CreateEvalSchema = z.object({
  name: z.string().min(1).max(255),
  scenario: z.record(z.string(), z.unknown()),
  enabled: z.boolean().optional(),
});

const UpdateEvalSchema = z
  .object({
    name: z.string().min(1).max(255).optional(),
    scenario: z.record(z.string(), z.unknown()).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((b) => b.name !== undefined || b.scenario !== undefined || b.enabled !== undefined, {
    message: 'no fields to update',
  });

const RunEvalSchema = z.object({
  trigger: z.enum(['manual', 'pre_save']).optional(),
});

export function registerAgentEvalRoutes(app: FastifyInstance) {
  // ---- eval scenario CRUD ----

  app.get<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/evals',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const evals = await listEvals(req.tenant.id, agent.id);
      return { evals: evals.map(evalView) };
    },
  );

  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/evals',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = CreateEvalSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const scenarioError = validateScenario(parsed.data.scenario);
      if (scenarioError) return reply.code(400).send({ error: `invalid scenario: ${scenarioError}` });

      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      const created = await createEval({
        tenantId: req.tenant.id,
        agentId: agent.id,
        name: parsed.data.name,
        scenario: parsed.data.scenario,
        enabled: parsed.data.enabled ?? true,
      });
      if (!created) {
        return reply.code(409).send({ error: `an eval named "${parsed.data.name}" already exists` });
      }
      return reply.code(201).send({ eval: evalView(created) });
    },
  );

  app.put<{ Params: { identifier: string; id: string } }>(
    '/v1/agents/:identifier/evals/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = UpdateEvalSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      if (parsed.data.scenario !== undefined) {
        const scenarioError = validateScenario(parsed.data.scenario);
        if (scenarioError) return reply.code(400).send({ error: `invalid scenario: ${scenarioError}` });
      }
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      // Scope the eval to THIS agent — a valid id under a different agent 404s.
      const existing = await getEval(req.tenant.id, req.params.id);
      if (!existing || existing.agent_id !== agent.id) {
        return reply.code(404).send({ error: 'unknown eval' });
      }

      const updated = await updateEval(req.tenant.id, req.params.id, parsed.data);
      if (!updated) return reply.code(404).send({ error: 'unknown eval' });
      return { eval: evalView(updated) };
    },
  );

  app.delete<{ Params: { identifier: string; id: string } }>(
    '/v1/agents/:identifier/evals/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const existing = await getEval(req.tenant.id, req.params.id);
      if (!existing || existing.agent_id !== agent.id) return { deleted: false };
      return { deleted: await deleteEval(req.tenant.id, req.params.id) };
    },
  );

  // ---- runs ----

  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/evals/run',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = RunEvalSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      // The run row (status 'running') is the durable handle the poller reads;
      // the job carries only its id. jobId = runId dedupes a double-submit.
      const run = await createRun({
        tenantId: req.tenant.id,
        agentId: agent.id,
        trigger: parsed.data.trigger ?? 'manual',
      });
      await getQueue(QUEUE.EVAL_RUN).add('eval-run', { runId: run.id }, { jobId: `eval-run-${run.id}` });

      return reply.code(202).send({ runId: run.id });
    },
  );

  app.get<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/evals/runs',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const runs = await listRuns(req.tenant.id, agent.id, 20);
      return { runs: runs.map(runView) };
    },
  );

  app.get<{ Params: { identifier: string; runId: string } }>(
    '/v1/agents/:identifier/evals/runs/:runId',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const run = await getRun(req.tenant.id, req.params.runId);
      if (!run || run.agent_id !== agent.id) return reply.code(404).send({ error: 'unknown run' });
      return { run: runView(run) };
    },
  );
}
