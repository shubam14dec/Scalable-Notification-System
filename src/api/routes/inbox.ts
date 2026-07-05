import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { mintSubscriberToken, verifySubscriberToken } from '../../auth/subscriber-token';
import { getEnvironment } from '../../db/accounts.repo';
import { inboxForSubscriber, markInboxRead, unreadCount } from '../../db/repositories';

const ReadSchema = z.object({
  // Omit to mark everything read.
  messageIds: z.array(z.string().uuid()).min(1).max(500).optional(),
});

/**
 * Inbox routes accept a third credential besides api-key/JWT: a short-lived
 * subscriber token (x-subscriber-token) minted by the customer's backend.
 * It is scoped to exactly one subscriber — the widget's credential.
 */
async function authenticateInbox(
  req: FastifyRequest,
  reply: FastifyReply,
  subscriberId: string,
): Promise<boolean> {
  const token = req.headers['x-subscriber-token'];
  if (typeof token === 'string' && token.length > 0) {
    const payload = verifySubscriberToken(token);
    if (!payload) {
      await reply.code(401).send({ error: 'invalid or expired subscriber token' });
      return false;
    }
    if (payload.subscriberId !== subscriberId) {
      await reply.code(403).send({ error: 'token is for a different subscriber' });
      return false;
    }
    const environment = await getEnvironment(payload.tenantId);
    if (!environment) {
      await reply.code(401).send({ error: 'unknown environment' });
      return false;
    }
    req.tenant = environment;
    return true;
  }
  await authenticate(req, reply);
  return Boolean(req.tenant) && !reply.sent;
}

/**
 * REST side of the in-app channel. The WebSocket gateway is only a live-push
 * accelerator — this is the durable inbox clients load on open/reconnect.
 */
export function registerInboxRoutes(app: FastifyInstance) {
  /** Mint a short-lived, single-subscriber token (for the inbox widget). */
  app.post('/v1/subscriber-tokens', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = z
      .object({
        subscriberId: z.string().min(1).max(255),
        ttlSeconds: z.number().int().min(60).max(86_400).default(3600),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    return mintSubscriberToken(req.tenant.id, parsed.data.subscriberId, parsed.data.ttlSeconds);
  });
  app.get<{ Params: { subscriberId: string }; Querystring: { limit?: string } }>(
    '/v1/inbox/:subscriberId',
    async (req, reply) => {
      if (!(await authenticateInbox(req, reply, req.params.subscriberId))) return;
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
    async (req, reply) => {
      if (!(await authenticateInbox(req, reply, req.params.subscriberId))) return;
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
