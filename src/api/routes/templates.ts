import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import {
  deleteTemplate,
  getTemplate,
  listTemplates,
  upsertTemplate,
} from '../../db/templates.repo';
import { renderMjmlTemplate, renderSubject } from '../../core/email-template';

const TemplateSchema = z.object({
  key: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[a-z0-9-_]+$/, 'lowercase letters, digits, - _ only'),
  name: z.string().min(1).max(255),
  subject: z.string().min(1).max(998),
  mjml: z.string().min(10).max(200_000),
});

const PreviewSchema = z.object({
  subject: z.string().max(998).default(''),
  mjml: z.string().min(10).max(200_000),
  vars: z.record(z.unknown()).default({}),
});

export function registerTemplateRoutes(app: FastifyInstance) {
  app.get('/v1/templates', { preHandler: [authenticate] }, async (req) => ({
    templates: await listTemplates(req.tenant.id),
  }));

  app.get<{ Params: { key: string } }>(
    '/v1/templates/:key',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const template = await getTemplate(req.tenant.id, req.params.key);
      if (!template) return reply.code(404).send({ error: 'unknown template' });
      return {
        template: {
          key: template.key,
          name: template.name,
          subject: template.subject,
          mjml: template.mjml,
          version: template.current_version,
          updatedAt: template.updated_at,
        },
      };
    },
  );

  /** Saving always creates a new version; in-flight sends keep the old one. */
  app.put('/v1/templates', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = TemplateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    // Compile once at save time so broken MJML is rejected at the door.
    try {
      await renderMjmlTemplate(parsed.data.mjml, {});
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const template = await upsertTemplate(
      req.tenant.id,
      parsed.data.key,
      parsed.data.name,
      parsed.data.subject,
      parsed.data.mjml,
    );
    return { key: template.key, version: template.current_version };
  });

  app.delete<{ Params: { key: string } }>(
    '/v1/templates/:key',
    { preHandler: [authenticate] },
    async (req) => ({ deleted: (await deleteTemplate(req.tenant.id, req.params.key)) > 0 }),
  );

  /** Live preview for the editor — renders the unsaved buffer. */
  app.post('/v1/templates/preview', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = PreviewSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    try {
      const rendered = await renderMjmlTemplate(parsed.data.mjml, parsed.data.vars);
      return {
        subject: parsed.data.subject
          ? renderSubject(parsed.data.subject, parsed.data.vars)
          : '',
        html: rendered.html,
        text: rendered.text,
      };
    } catch (err) {
      return reply.code(422).send({ error: (err as Error).message });
    }
  });
}
