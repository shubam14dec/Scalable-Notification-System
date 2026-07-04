import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { inboxForSubscriber, markInboxRead, unreadCount } from '../../db/repositories';

const ReadSchema = z.object({
  // Omit to mark everything read.
  messageIds: z.array(z.string().uuid()).min(1).max(500).optional(),
});

/**
 * REST side of the in-app channel. The WebSocket gateway is only a live-push
 * accelerator — this is the durable inbox clients load on open/reconnect.
 */
export function registerInboxRoutes(app: FastifyInstance) {
  app.get<{ Params: { subscriberId: string }; Querystring: { limit?: string } }>(
    '/v1/inbox/:subscriberId',
    { preHandler: [authenticate] },
    async (req) => {
      const limit = Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 200);
      const [messages, unread] = await Promise.all([
        inboxForSubscriber(req.tenant.id, req.params.subscriberId, limit),
        unreadCount(req.tenant.id, req.params.subscriberId),
      ]);
      return { subscriberId: req.params.subscriberId, unreadCount: unread, messages };
    },
  );

  app.post<{ Params: { subscriberId: string } }>(
    '/v1/inbox/:subscriberId/read',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = ReadSchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const updated = await markInboxRead(
        req.tenant.id,
        req.params.subscriberId,
        parsed.data.messageIds ?? null,
      );
      return { updated };
    },
  );
}
