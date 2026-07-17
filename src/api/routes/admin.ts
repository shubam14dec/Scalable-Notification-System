import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { CHANNELS } from '../../shared/queues';
import { upsertSubscriber, upsertWorkflow, type WorkflowStep } from '../../db/repositories';
import { getTemplate } from '../../db/templates.repo';
import { normalizePhone } from '../../shared/phone';
import { assertSafeOutboundUrl, UnsafeOutboundUrlError } from '../../core/safe-url';

/** Zod refinement: parse+normalize a phone to E.164 or 400 with a clear hint. */
const phoneField = z
  .string()
  .max(32)
  .transform((raw, ctx) => {
    const normalized = normalizePhone(raw);
    if (!normalized) {
      ctx.addIssue({ code: 'custom', message: 'phone must be E.164, e.g. +919901489187' });
      return z.NEVER;
    }
    return normalized;
  });

const SubscriberSchema = z.object({
  subscriberId: z.string().min(1).max(255),
  email: z.string().email().optional(),
  phone: phoneField.optional(),
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
        // Push rich extras. clickUrl/imageUrl are SSRF-gated in the route
        // (async), which can't run inside superRefine — see below.
        push: z
          .object({
            clickUrl: z.string().url().max(2048).optional(),
            imageUrl: z.string().url().max(2048).optional(),
            data: z.record(z.string().max(64), z.string().max(256)).optional(),
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
        if (step.push && step.channel !== 'push') {
          ctx.addIssue({ code: 'custom', message: 'push extras are only supported on push steps' });
        }
        if (step.push?.data && Object.keys(step.push.data).length > 10) {
          ctx.addIssue({ code: 'custom', message: 'push.data supports at most 10 keys' });
        }
      }),
    )
    .min(1)
    .max(20),
});

/**
 * SSRF write-time gate for a push step's clickUrl/imageUrl (the worker/device
 * dials these). Skipped when the URL carries Handlebars vars — those resolve
 * per-recipient at fan-out, so there is no literal host to vet here; a literal
 * internal target is the risk this catches. Mirrors agent-tools' endpoint gate.
 */
async function unsafePushUrl(
  push?: { clickUrl?: string; imageUrl?: string },
): Promise<string | null> {
  const fields: Array<['clickUrl' | 'imageUrl', string | undefined]> = [
    ['clickUrl', push?.clickUrl],
    ['imageUrl', push?.imageUrl],
  ];
  for (const [field, url] of fields) {
    if (!url || url.includes('{{')) continue; // var-bearing URLs resolve at fan-out
    try {
      await assertSafeOutboundUrl(url);
    } catch (err) {
      if (err instanceof UnsafeOutboundUrlError) return `${field}: ${err.message}`;
      throw err;
    }
  }
  return null;
}

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
      const unsafe = await unsafePushUrl(step.push);
      if (unsafe) return reply.code(400).send({ error: unsafe });
    }
    const steps: WorkflowStep[] = parsed.data.steps.map((s) => ({
      ...s,
      body: s.body ?? '',
    })) as WorkflowStep[];
    const wf = await upsertWorkflow(req.tenant.id, parsed.data.key, parsed.data.name, steps);
    return reply.code(200).send({ id: wf.id, key: wf.key });
  });
}
