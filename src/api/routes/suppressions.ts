import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { CHANNELS } from '../../shared/queues';
import { listSuppressions, removeSuppression } from '../../db/repositories';

const RemoveSchema = z.object({
  channel: z.enum(CHANNELS),
  address: z.string().min(1).max(4096),
});

export function registerSuppressionRoutes(app: FastifyInstance) {
  app.get<{ Querystring: { channel?: string } }>(
    '/v1/suppressions',
    { preHandler: [authenticate] },
    async (req) => ({
      suppressions: await listSuppressions(req.tenant.id, req.query.channel),
    }),
  );

  /** Un-suppress an address (e.g. after the user fixed a typo'd email). */
  app.delete('/v1/suppressions', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = RemoveSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const removed = await removeSuppression(
      req.tenant.id,
      parsed.data.channel,
      parsed.data.address,
    );
    return { removed };
  });
}
