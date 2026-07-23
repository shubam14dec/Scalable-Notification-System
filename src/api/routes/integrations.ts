import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { CHANNELS, type Channel } from '../../shared/queues';
import { sealSecret, openSecret } from '../../auth/secret-box';
import {
  validateCredentials,
  buildProviderFromIntegration,
  PROVIDER_CATALOG,
  INTEGRATION_CHANNELS,
  type IntegrationChannel,
} from '../../providers/factory';
import { invalidateChain } from '../../providers/registry';
import {
  createIntegration,
  deleteIntegration,
  getIntegration,
  listIntegrations,
  updateIntegration,
  type IntegrationRow,
} from '../../db/integrations.repo';
import { assertSafeOutboundHost, assertSafeOutboundUrl, UnsafeOutboundUrlError } from '../../core/safe-url';
import { PermanentError } from '../../shared/errors';
import { probeEmbeddings, getEmbeddingsConfig } from '../../core/embeddings';
import { ensurePineconeIndex } from '../../core/vector-store';

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

/**
 * The embeddings baseUrl is dialed by our servers (probe + every embed), so it
 * is SSRF-gated at CONFIG time — same policy as an agent's llm.baseUrl: local
 * Ollama is reached only by allow-listing localhost in OUTBOUND_URL_ALLOW, no
 * code branch.
 */
async function unsafeEmbeddingsUrlError(
  channel: IntegrationChannel,
  creds: unknown,
): Promise<string | null> {
  if (channel !== 'embeddings') return null;
  const baseUrl = (creds as { baseUrl?: unknown }).baseUrl;
  if (typeof baseUrl !== 'string') return null; // schema validation already failed it
  try {
    await assertSafeOutboundUrl(baseUrl);
    return null;
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) return `credentials.baseUrl: ${err.message}`;
    throw err;
  }
}

/** Only delivery channels have a failover-chain cache to bust. */
function isDeliveryChannel(c: IntegrationChannel): c is Channel {
  return (CHANNELS as readonly string[]).includes(c);
}

const CreateSchema = z.object({
  channel: z.enum(INTEGRATION_CHANNELS),
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
    const unsafeEmbedUrl = await unsafeEmbeddingsUrlError(body.channel, check.value);
    if (unsafeEmbedUrl) return reply.code(400).send({ error: unsafeEmbedUrl });

    const row = await createIntegration({
      tenantId: req.tenant.id,
      // The DB column is `text`; embeddings/vectorstore ride the same table.
      channel: body.channel as Channel,
      provider: body.provider,
      sealedCredentials: sealSecret(JSON.stringify(check.value)),
      isPrimary: body.isPrimary,
      fallbackOrder: body.fallbackOrder,
    });
    if (isDeliveryChannel(body.channel)) invalidateChain(req.tenant.id, body.channel);
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
        const unsafeEmbedUrl = await unsafeEmbeddingsUrlError(existing.channel, check.value);
        if (unsafeEmbedUrl) return reply.code(400).send({ error: unsafeEmbedUrl });
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
      const row = await getIntegration(req.params.id, req.tenant.id);
      if (!row) return reply.code(404).send({ error: 'unknown integration' });

      // Infrastructure integrations validate against their real endpoint (no
      // `to` recipient): probe the embeddings endpoint / create-or-validate the
      // vector index, recording the dimension / host back into the sealed blob.
      if (row.channel === ('embeddings' as Channel)) return testEmbeddings(req.tenant.id, reply, row);
      if (row.channel === ('vectorstore' as Channel)) return testVectorStore(req.tenant.id, reply, row);

      const parsed = TestSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }

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

/** PermanentError = a config fault the tenant must fix (400); else transient (422). */
function sendTestError(reply: FastifyReply, err: unknown) {
  const status = err instanceof PermanentError ? 400 : 422;
  return reply.code(status).send({ ok: false, error: (err as Error).message });
}

/** Probe the embeddings endpoint and record the dimension it returns. */
async function testEmbeddings(tenantId: string, reply: FastifyReply, row: IntegrationRow) {
  const creds = JSON.parse(openSecret(row.credentials)) as {
    baseUrl: string;
    apiKey: string;
    model: string;
  };
  try {
    const { dim } = await probeEmbeddings({
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
      model: creds.model,
    });
    await updateIntegration(row.id, tenantId, {
      sealedCredentials: sealSecret(JSON.stringify({ ...creds, dim })),
    });
    return reply.send({ ok: true, dim });
  } catch (err) {
    return sendTestError(reply, err);
  }
}

/**
 * Create-or-validate the Pinecone index at the tenant's embeddings dimension
 * and record its durable host. Requires the embeddings integration first —
 * the index dimension comes from its probe.
 */
async function testVectorStore(tenantId: string, reply: FastifyReply, row: IntegrationRow) {
  const creds = JSON.parse(openSecret(row.credentials)) as {
    apiKey: string;
    indexName: string;
    host?: string;
  };
  const embeddings = await getEmbeddingsConfig(tenantId);
  if (!embeddings) {
    return reply.code(400).send({
      ok: false,
      error:
        'Configure and Test an embeddings integration first — the vector index dimension is taken from it.',
    });
  }
  try {
    const { host, dimension, created } = await ensurePineconeIndex(
      creds.apiKey,
      creds.indexName,
      embeddings.dim,
    );
    await updateIntegration(row.id, tenantId, {
      sealedCredentials: sealSecret(
        JSON.stringify({ apiKey: creds.apiKey, indexName: creds.indexName, host }),
      ),
    });
    return reply.send({ ok: true, dim: dimension, host, created });
  } catch (err) {
    return sendTestError(reply, err);
  }
}
