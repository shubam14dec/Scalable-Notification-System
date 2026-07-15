import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { pool } from '../../db/pool';
import { getQueue, QUEUE } from '../../shared/queues';
import {
  decideToolCall,
  getToolCall,
  listToolCalls,
  type AgentToolCall,
} from '../../db/agent-tools.repo';

/**
 * The human-in-the-loop approval queue (Phase 18). A managed agent's tool call
 * with approval='required' (or an auto call the worker chose to gate) lands in
 * agent_tool_calls as `pending`; an operator approves/denies it here and the
 * worker resumes the conversation from the decision job we enqueue.
 *
 * The CREATE side (a pending call appearing + its notification) is the worker's
 * job — this module only reads the queue and records decisions.
 */

const DecisionSchema = z.object({
  decision: z.enum(['approve', 'deny']),
  note: z.string().max(500).optional(),
});

function approvalView(call: AgentToolCall, identifier: string | null) {
  return {
    id: call.id,
    agentIdentifier: identifier,
    toolName: call.tool_name,
    args: call.args,
    conversationId: call.conversation_id,
    status: call.status,
    note: call.note,
    requestedAt: call.requested_at,
    decidedAt: call.decided_at,
    decidedBy: call.decided_by,
    expiresAt: call.expires_at,
  };
}

/**
 * The decider identity we record. The dashboard JWT payload only carries
 * { sub, type } (see api/jwt-auth.ts) — there is NO email on it — so the best
 * stable identifier available is the user id (sub); api-key callers have no
 * user at all. See the task report for this divergence from `req.user?.email`.
 */
function deciderOf(req: { user?: { sub?: string } }): string {
  return req.user?.sub ?? 'api-key';
}

export function registerApprovalRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { status?: string } }>(
    '/v1/approvals',
    { preHandler: [authenticate] },
    async (req) => {
      const status = req.query.status === 'decided' ? 'decided' : 'pending';
      const calls = await listToolCalls(req.tenant.id, { status });

      // Resolve agent identifiers in one round-trip (repo is frozen; join here).
      const agentIds = [...new Set(calls.map((c) => c.agent_id))];
      const identifiers = new Map<string, string>();
      if (agentIds.length > 0) {
        const { rows } = await pool.query<{ id: string; identifier: string }>(
          'select id, identifier from agents where id = any($1)',
          [agentIds],
        );
        for (const row of rows) identifiers.set(row.id, row.identifier);
      }

      return {
        approvals: calls.map((c) => approvalView(c, identifiers.get(c.agent_id) ?? null)),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/approvals/:id/decision',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const parsed = DecisionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }

      const call = await decideToolCall(
        req.tenant.id,
        req.params.id,
        parsed.data.decision === 'approve' ? 'approved' : 'denied',
        deciderOf(req),
        parsed.data.note,
      );
      if (!call) {
        // Lost the race, or never pending: distinguish already-decided vs missing.
        const existing = await getToolCall(req.tenant.id, req.params.id);
        if (existing) return reply.code(409).send({ error: 'already decided' });
        return reply.code(404).send({ error: 'unknown approval' });
      }

      // Hand the decision back to the conversation worker (frozen job contract).
      await getQueue(QUEUE.CONVERSATION).add(
        call.id,
        {
          kind: 'tool-decision',
          tenantId: req.tenant.id,
          conversationId: call.conversation_id,
          toolCallId: call.id,
        },
        { jobId: `tool-decision-${call.id}`, attempts: 5 },
      );

      return { id: call.id, status: call.status };
    },
  );
}
