import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { CHANNELS } from '../../shared/queues';
import { sealSecret } from '../../auth/secret-box';
import { validateCredentials, buildProviderFromIntegration, PROVIDER_CATALOG } from '../../providers/factory';
import { invalidateChain } from '../../providers/registry';
import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  listIntegrations,
  updateIntegration,
} from '../../db/integrations.repo';
import { assertSafeOutboundHost, UnsafeOutboundUrlError } from '../../core/safe-url';

/** SMTP is the one provider whose destination host the tenant controls. */
async function unsafeSmtpHostError(provider: string, creds: unknown): Promise<string | null> {
  if (provider !== 'smtp') return null;
  const host = (creds as { host?: unknown }).host;
  if (typeof host !== 'string') return null; // schema validation already failed it
  try {
    await assertSafeOutboundHost(host);
    return null;
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) return `credentials.host: ${err.message}`;
    throw err;
  }
}

const CreateSchema = z.object({
  channel: z.enum(CHANNELS),
  provider: z.string().min(1).max(64),
  credentials: z.record(z.unknown()),
  isPrimary: z.boolean().default(true),
  fallbackOrder: z.number().int().min(0).max(100).default(0),
});

const UpdateSchema = z.object({
  credentials: z.record(z.unknown()).optional(),
  isPrimary: z.boolean().optional(),
  fallbackOrder: z.number().int().min(0).max(100).optional(),
  active: z.boolean().optional(),
});

const TestSchema = z.object({
  to: z.object({
    email: z.string().email().optional(),
    phone: z.string().max(32).optional(),
    pushToken: z.string().max(4096).optional(),
  }),
});

/**
 * Bring-your-own-provider store. Credentials are validated against the
 * provider's schema, sealed with AES-256-GCM, and never returned by any
 * endpoint — the list shows provider/type/status only.
 */
export function registerIntegrationRoutes(app: FastifyInstance) {
  /** Catalog of installable providers and their credential fields. */
  app.get('/v1/integrations/catalog', { preHandler: [authenticate] }, async () => ({
    providers: Object.entries(PROVIDER_CATALOG).map(([slug, entry]) => ({
      provider: slug,
      channel: entry.channel,
    })),
  }));

  app.get('/v1/integrations', { preHandler: [authenticate] }, async (req) => {
    const rows = await listIntegrations(req.tenant.id);
    return {
      integrations: rows.map((r) => ({
        id: r.id,
        channel: r.channel,
        provider: r.provider,
        isPrimary: r.is_primary,
        fallbackOrder: r.fallback_order,
        active: r.active,
        updatedAt: r.updated_at,
      })),
    };
  });

  app.post('/v1/integrations', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = CreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const body = parsed.data;

    const check = validateCredentials(body.provider, body.channel, body.credentials);
    if (!check.ok) {
      return reply.code(400).send({ error: check.error });
    }
    const unsafeHost = await unsafeSmtpHostError(body.provider, check.value);
    if (unsafeHost) return reply.code(400).send({ error: unsafeHost });

    const row = await createIntegration({
      tenantId: req.tenant.id,
      channel: body.channel,
      provider: body.provider,
      sealedCredentials: sealSecret(JSON.stringify(check.value)),
      isPrimary: body.isPrimary,
      fallbackOrder: body.fallbackOrder,
    });
    invalidateChain(req.tenant.id, body.channel);
    return reply.code(201).send({ id: row.id, channel: row.channel, provider: row.provider });
  });

  app.patch<{ Params: { id: string } }>(
    '/v1/integrations/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = UpdateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const existing = await getIntegration(req.params.id, req.tenant.id);
      if (!existing) return reply.code(404).send({ error: 'unknown integration' });

      let sealed: string | undefined;
      if (parsed.data.credentials) {
        const check = validateCredentials(
          existing.provider,
          existing.channel,
          parsed.data.credentials,
        );
        if (!check.ok) return reply.code(400).send({ error: check.error });
        const unsafeHost = await unsafeSmtpHostError(existing.provider, check.value);
        if (unsafeHost) return reply.code(400).send({ error: unsafeHost });
        sealed = sealSecret(JSON.stringify(check.value));
      }

      await updateIntegration(req.params.id, req.tenant.id, {
        sealedCredentials: sealed,
        isPrimary: parsed.data.isPrimary,
        fallbackOrder: parsed.data.fallbackOrder,
        active: parsed.data.active,
      });
      invalidateChain(req.tenant.id, existing.channel);
      return { updated: true };
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/integrations/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const existing = await getIntegration(req.params.id, req.tenant.id);
      if (!existing) return reply.code(404).send({ error: 'unknown integration' });
      await deleteIntegration(req.params.id, req.tenant.id);
      invalidateChain(req.tenant.id, existing.channel);
      return { deleted: true };
    },
  );

  /** Fire a real test message through ONE integration (bypasses the chain). */
  app.post<{ Params: { id: string } }>(
    '/v1/integrations/:id/test',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = TestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const row = await getIntegration(req.params.id, req.tenant.id);
      if (!row) return reply.code(404).send({ error: 'unknown integration' });

      try {
        const provider = buildProviderFromIntegration(row);
        const result = await provider.send({
          messageId: 'test',
          tenantId: req.tenant.id,
          to: parsed.data.to,
          subject: 'Test notification',
          body: 'This is a test message from your notification system integration.',
        });
        return { ok: true, providerMessageId: result.providerMessageId };
      } catch (err) {
        return reply.code(422).send({ ok: false, error: (err as Error).message });
      }
    },
  );
}
