import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { getQueue, QUEUE } from '../../shared/queues';
import { verifyWebhook } from '../webhook-signature';

const StatusCallbackSchema = z.object({
  providerMessageId: z.string().min(1).max(998),
  status: z.enum(['delivered', 'bounced', 'failed', 'complaint']),
  meta: z.record(z.unknown()).optional(),
});

let warnedNoSecret = false;

export function registerWebhookRoutes(app: FastifyInstance) {
  /**
   * Delivery-status callbacks from providers. Two rules:
   *  1. Verify the HMAC signature BEFORE trusting anything in the body —
   *     status webhooks mutate message state, so forgeries matter.
   *  2. Do no processing inline — enqueue and ack, so a bounce storm after
   *     a big campaign can't slow the API down.
   */
  app.post<{ Params: { provider: string } }>(
    '/webhooks/providers/:provider',
    async (req, reply) => {
      if (env.webhookSigningSecret) {
        const verdict = verifyWebhook(
          env.webhookSigningSecret,
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
        { provider: req.params.provider, ...parsed.data },
        { attempts: 5 },
      );
      return reply.code(200).send({ ok: true });
    },
  );
}
