import type { FastifyInstance } from 'fastify';
import { authenticate } from '../auth';
import { getEventByTransaction, messagesByTransaction } from '../../db/repositories';

export function registerEventRoutes(app: FastifyInstance) {
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
