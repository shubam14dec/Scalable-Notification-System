import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { CHANNELS } from '../../shared/queues';
import { upsertSubscriber, upsertWorkflow, type WorkflowStep } from '../../db/repositories';
import { getTemplate } from '../../db/templates.repo';

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
        body: z.string().max(100_000).optional(),
        templateKey: z.string().max(255).optional(),
        delaySeconds: z.number().int().min(0).max(30 * 24 * 3600).optional(),
        digest: z
          .object({
            windowSeconds: z.number().int().min(5).max(7 * 24 * 3600),
            itemTemplate: z.string().max(1000).optional(),
          })
          .optional(),
        conditions: z
          .array(
            z.object({
              field: z.string().min(1).max(255),
              op: z.enum(['eq', 'neq', 'gt', 'gte', 'lt', 'lte', 'contains', 'exists', 'not_exists']),
              value: z.unknown().optional(),
            }),
          )
          .max(20)
          .optional(),
        skipIfStep: z
          .object({
            stepIndex: z.number().int().min(0).max(19),
            statusIn: z
              .array(z.enum(['opened', 'read', 'delivered', 'sent', 'failed', 'skipped']))
              .min(1)
              .max(6),
          })
          .optional(),
      })
      .superRefine((step, ctx) => {
        if (!step.templateKey && (!step.body || step.body.trim() === '')) {
          ctx.addIssue({ code: 'custom', message: 'body is required unless templateKey is set' });
        }
        if (step.templateKey && step.channel !== 'email') {
          ctx.addIssue({ code: 'custom', message: 'templateKey is only supported on email steps' });
        }
        if (step.templateKey && step.digest) {
          ctx.addIssue({ code: 'custom', message: 'digest and templateKey cannot be combined' });
        }
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
    // Referenced templates must exist — fail at authoring, not at send time.
    for (const step of parsed.data.steps) {
      if (step.templateKey && !(await getTemplate(req.tenant.id, step.templateKey))) {
        return reply.code(400).send({ error: `unknown template "${step.templateKey}"` });
      }
    }
    const steps: WorkflowStep[] = parsed.data.steps.map((s) => ({
      ...s,
      body: s.body ?? '',
    })) as WorkflowStep[];
    const wf = await upsertWorkflow(req.tenant.id, parsed.data.key, parsed.data.name, steps);
    return reply.code(200).send({ id: wf.id, key: wf.key });
  });
}
