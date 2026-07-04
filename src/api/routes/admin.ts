import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { CHANNELS } from '../../shared/queues';
import { upsertSubscriber, upsertWorkflow } from '../../db/repositories';

const SubscriberSchema = z.object({
  subscriberId: z.string().min(1).max(255),
  email: z.string().email().optional(),
  phone: z.string().max(32).optional(),
  pushToken: z.string().max(4096).optional(),
});

const WorkflowSchema = z.object({
  key: z.string().min(1).max(255),
  name: z.string().min(1).max(255),
  steps: z
    .array(
      z.object({
        channel: z.enum(CHANNELS),
        subject: z.string().max(998).optional(),
        body: z.string().min(1).max(100_000),
        delaySeconds: z.number().int().min(0).max(30 * 24 * 3600).optional(),
        digest: z
          .object({
            windowSeconds: z.number().int().min(5).max(7 * 24 * 3600),
            itemTemplate: z.string().max(1000).optional(),
          })
          .optional(),
      }),
    )
    .min(1)
    .max(20),
});

export function registerAdminRoutes(app: FastifyInstance) {
  app.put('/v1/subscribers', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = SubscriberSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const sub = await upsertSubscriber(req.tenant.id, parsed.data);
    return reply.code(200).send({ id: sub.id, subscriberId: sub.external_id });
  });

  app.put('/v1/workflows', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = WorkflowSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const wf = await upsertWorkflow(
      req.tenant.id,
      parsed.data.key,
      parsed.data.name,
      parsed.data.steps,
    );
    return reply.code(200).send({ id: wf.id, key: wf.key });
  });
}
