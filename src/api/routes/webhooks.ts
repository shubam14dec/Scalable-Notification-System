import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { getQueue, QUEUE } from '../../shared/queues';
import { tenantWebhookSecret, verifyWebhook } from '../webhook-signature';

const StatusCallbackSchema = z.object({
  providerMessageId: z.string().min(1).max(998),
  status: z.enum(['delivered', 'bounced', 'failed', 'complaint']),
  meta: z.record(z.unknown()).optional(),
});

let warnedNoSecret = false;

/**
 * S1.2 — the replay key for a status callback.
 *
 * A provider delivery callback is a STATEMENT OF FACT ("this message
 * bounced"), so the same statement arriving twice must have the effect of
 * arriving once. It already nearly does — the processor's UPDATE is
 * idempotent — but each delivery costs a job, a DB write and a tenant event,
 * and a captured request replayed a thousand times used to buy a thousand of
 * those. A deterministic jobId makes BullMQ drop the duplicates for free
 * (§4: every queue hop declares its dedupe key).
 *
 * Keyed on (tenant, provider message, status) — NOT on the request — because
 * the fact is what should happen once. `status` is part of the key so a
 * genuine later transition (sent -> delivered -> complaint) is still its own
 * job, and only the SAME statement collapses.
 *
 * The provider id is hashed rather than embedded: it is provider-controlled
 * text that may contain colons (`twilio:abc`, `<id@mail.host>`), and a BullMQ
 * jobId containing colons is a project-wide landmine (see the gotchas
 * ledger). Hex is unambiguous, fixed-width and dash-separated.
 */
export function statusJobId(tenantId: string, providerMessageId: string, status: string): string {
  const digest = createHash('sha256').update(providerMessageId).digest('hex').slice(0, 32);
  return `status-${tenantId}-${digest}-${status}`;
}

export function registerWebhookRoutes(app: FastifyInstance) {
  /**
   * Delivery-status callbacks from providers. Three rules:
   *  1. The URL names the TENANT, and the signature is checked with THAT
   *     tenant's derived key (S1.2). Before this, one global secret verified
   *     callbacks for every tenant and the body carried no tenant at all, so
   *     a single leaked secret could flip any tenant's message to bounced or
   *     complaint — which writes a suppression and quietly stops that address
   *     from ever being delivered to again.
   *  2. Verify the HMAC BEFORE trusting anything in the body — status
   *     webhooks mutate message state, so forgeries matter.
   *  3. Do no processing inline — enqueue and ack, so a bounce storm after a
   *     big campaign can't slow the API down.
   *
   * DEPLOY NOTE: the tenant-less path is gone rather than kept as a fallback.
   * A compatibility route would be a permanent unscoped hole that nobody ever
   * closes; a 404 is loud, immediate and fixed by re-pasting one URL at the
   * provider. See docs/DEPLOYMENT.md for how an operator derives the URL and
   * the per-tenant key.
   */
  app.post<{ Params: { provider: string; tenantId: string } }>(
    '/webhooks/providers/:provider/:tenantId',
    async (req, reply) => {
      const { provider, tenantId } = req.params;
      if (!z.string().uuid().safeParse(tenantId).success) {
        return reply.code(400).send({ error: 'invalid tenant id' });
      }

      if (env.webhookSigningSecret) {
        const verdict = verifyWebhook(
          tenantWebhookSecret(env.webhookSigningSecret, tenantId),
          req.headers['x-webhook-timestamp'] as string | undefined,
          req.headers['x-webhook-signature'] as string | undefined,
          req.rawBody ?? '',
        );
        if (!verdict.ok) {
          return reply.code(401).send({ error: `webhook rejected: ${verdict.reason}` });
        }
      } else if (!warnedNoSecret) {
        warnedNoSecret = true;
        logger.warn('WEBHOOK_SIGNING_SECRET not set — webhook signatures are NOT verified');
      }

      const parsed = StatusCallbackSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      await getQueue(QUEUE.STATUS).add(
        'status',
        { provider, tenantId, ...parsed.data },
        {
          attempts: 5,
          jobId: statusJobId(tenantId, parsed.data.providerMessageId, parsed.data.status),
        },
      );
      return reply.code(200).send({ ok: true });
    },
  );
}
