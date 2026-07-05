import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth';
import {
  getEventByTransaction,
  listWorkflows,
  listSubscribers,
  messagesByTransaction,
  recentActivity,
} from '../../db/repositories';

export function registerEventRoutes(app: FastifyInstance) {
  /** Latest messages across the environment — the dashboard activity feed. */
  app.get<{ Querystring: { limit?: string } }>(
    '/v1/activity',
    { preHandler: [authenticate] },
    async (req) => {
      const limit = Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 200);
      return { activity: await recentActivity(req.tenant.id, limit) };
    },
  );

  app.get('/v1/workflows', { preHandler: [authenticate] }, async (req) => ({
    workflows: (await listWorkflows(req.tenant.id)).map(
      (w: { id: string; key: string; name: string; steps: unknown[]; updated_at: string }) => ({
        id: w.id,
        key: w.key,
        name: w.name,
        stepCount: Array.isArray(w.steps) ? w.steps.length : 0,
        channels: Array.isArray(w.steps)
          ? [...new Set((w.steps as Array<{ channel: string }>).map((s) => s.channel))]
          : [],
        updatedAt: w.updated_at,
      }),
    ),
  }));

  app.get<{ Querystring: { limit?: string; search?: string } }>(
    '/v1/subscribers',
    { preHandler: [authenticate] },
    async (req) => {
      const limit = Math.min(Number.parseInt(req.query.limit ?? '100', 10) || 100, 500);
      return { subscribers: await listSubscribers(req.tenant.id, limit, req.query.search) };
    },
  );

  /** Delivery status for one trigger: the event plus every per-channel message. */
  app.get<{ Params: { transactionId: string } }>(
    '/v1/events/:transactionId',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const { transactionId } = req.params;
      const event = await getEventByTransaction(req.tenant.id, transactionId);
      if (!event) {
        return reply.code(404).send({ error: 'unknown transactionId' });
      }
      const messages = await messagesByTransaction(req.tenant.id, transactionId);
      return {
        transactionId,
        workflowKey: event.workflow_key,
        priority: event.priority,
        status: event.status,
        messages: messages.map((m) => ({
          id: m.id,
          channel: m.channel,
          status: m.status,
          provider: m.provider,
          providerMessageId: m.provider_message_id,
          attempts: m.attempts,
          error: (m as unknown as { error: string | null }).error,
        })),
      };
    },
  );
}
