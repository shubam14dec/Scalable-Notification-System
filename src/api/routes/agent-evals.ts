import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { getAgent } from '../../db/conversations.repo';
import { getQueue, QUEUE } from '../../shared/queues';
import { validateScenario } from '../../core/eval-runner';
import { ModerationSchema, RoutingSchema, TopicsSchema, routingConfig } from './agents';
import type { CandidateConfig } from '../../core/managed-brain';
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
    // A4, ADDITIVE: present ONLY on a run started with a candidate override, so
    // the Evals view can say "this run graded the edited prompt". A plain run's
    // response keeps its exact pre-A4 key set — absent, never null.
    ...(row.candidate ? { candidate: row.candidate } : {}),
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

/**
 * A4: the config a run should GRADE instead of the agent's live one — the
 * dashboard's pre-save check ("does the edited prompt still pass?") and, later,
 * A5's canary. Caps mirror the agent-create route's own (agents.ts): model
 * 1..255, systemPrompt up to 100k — a candidate must be something the agent
 * could actually be saved with. At least one key, or there is no override to
 * make (an empty object is a caller bug, not "use the agent's config").
 */
/**
 * A7 slice C: the two gate schemas now live beside RoutingSchema in
 * routes/agents.ts (slices A and B parked them here only because there was no
 * agent-facing surface to own them yet) and are IMPORTED, never re-declared.
 *
 * That import is the point rather than tidiness: the candidate below is how a
 * pre-save check grades the very policy the operator is about to save, and if
 * the two shapes were separate objects, the first edit to either would let the
 * check grade a policy the save would then reject — or, worse, accept.
 */
export const CandidateSchema = z
  .object({
    systemPrompt: z.string().min(1).max(100_000).optional(),
    model: z.string().min(1).max(255).optional(),
    /**
     * A6 slice B: the ROUTING config to grade, because turning the router on is
     * a behavior change like any prompt edit — the reply comes from a different
     * model. `null` means "grade it with routing OFF", which is a real thing to
     * ask for and is why this is nullable rather than just optional; ABSENT
     * means no opinion, and the router steps aside for the whole run exactly as
     * it did before this field existed.
     */
    routing: RoutingSchema.nullable().optional(),
    /**
     * A7 slice A: the TOPIC POLICY to grade. `null` means "grade it with the
     * gate OFF" — a real thing to ask for, and the only way to say it, because
     * ABSENT deliberately means the AGENT'S OWN gate applies (unlike `routing`
     * above, where absent means the router steps aside). The asymmetry is the
     * design: routing changes who answers, topics changes whether anyone does,
     * and a prompt edit is graded AS THIS AGENT — behind the boundary the agent
     * really has. See CandidateConfig.topics in core/managed-brain.ts.
     */
    topics: TopicsSchema.nullable().optional(),
    /**
     * A7 slice B: the REPLY RULES to grade. `null` means "grade it with the
     * rules OFF", and it is the only way to say that, because ABSENT means the
     * AGENT'S OWN rules apply — topics' semantics, not routing's. Moderation
     * changes what may ship, and a prompt edit is graded AS THIS AGENT, behind
     * the boundary the agent really has. See CandidateConfig.moderation.
     */
    moderation: ModerationSchema.nullable().optional(),
  })
  .refine(
    (c) =>
      c.systemPrompt !== undefined ||
      c.model !== undefined ||
      c.routing !== undefined ||
      c.topics !== undefined ||
      c.moderation !== undefined,
    { message: 'candidate needs systemPrompt, model, routing, topics and/or moderation' },
  );

const RunEvalSchema = z.object({
  trigger: z.enum(['manual', 'pre_save']).optional(),
  candidate: CandidateSchema.optional(),
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

      // A4: a candidate is a MANAGED-runtime concept. A bridge agent's brain is
      // the customer's own code behind a signed URL — there is no prompt or
      // model here to override — so accepting one would be a lie about what the
      // run graded. The worker skips it defensively too (eval-run.processor).
      // The wire shape's routing is normalized to the stored `RoutingConfig`
      // here (cheapModel '' when unset), so exactly one shape reaches the brain
      // — the same object an agent save would have written. `'routing' in raw`
      // is preserved: absent and null are different instructions to the router.
      const raw = parsed.data.candidate;
      const candidate: CandidateConfig | undefined = raw && {
        ...(raw.systemPrompt !== undefined ? { systemPrompt: raw.systemPrompt } : {}),
        ...(raw.model !== undefined ? { model: raw.model } : {}),
        ...('routing' in raw
          ? { routing: raw.routing ? routingConfig(raw.routing) : null }
          : {}),
        // A7: same absent-vs-null preservation, opposite meaning for absent —
        // no key here leaves the AGENT'S gate in force for the run (see the
        // schema's note). The wire shape already IS the stored shape (three
        // plain fields, no sentinels), so there is nothing to normalize.
        ...('topics' in raw ? { topics: raw.topics ?? null } : {}),
        // A7 slice B: same absent-vs-null preservation, same meaning for absent
        // as topics — no key here leaves the AGENT'S rules in force for the run.
        // The wire shape already IS the stored shape, so nothing to normalize.
        ...('moderation' in raw ? { moderation: raw.moderation ?? null } : {}),
      };
      if (candidate && agent.runtime !== 'managed') {
        return reply.code(400).send({
          error:
            'candidate runs need a managed agent: a bridge agent’s brain is your own code, not a prompt',
        });
      }

      // The run row (status 'running') is the durable handle the poller reads;
      // the job carries only its id — the candidate rides the ROW, so a retried
      // job and the stored results can never disagree about what was graded.
      const run = await createRun({
        tenantId: req.tenant.id,
        agentId: agent.id,
        trigger: parsed.data.trigger ?? 'manual',
        ...(candidate ? { candidate } : {}),
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
