import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { openSecret } from '../../auth/secret-box';
import { integrationsForChannel } from '../../db/integrations.repo';
import { addSuppression, getMessage } from '../../db/repositories';
import { logger } from '../../shared/logger';
import { getQueue, QUEUE } from '../../shared/queues';

/** Constant-time compare of two ASCII strings (unequal lengths -> false). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

/**
 * Twilio's request signature: base64(HMAC-SHA1(authToken, url + params)),
 * where params is every POST field concatenated as key+value in ascending
 * key order. See https://www.twilio.com/docs/usage/security#validating-requests
 */
function twilioSignature(authToken: string, url: string, params: Record<string, string>): string {
  let data = url;
  for (const key of Object.keys(params).sort()) data += key + params[key];
  return createHmac('sha1', authToken).update(data, 'utf8').digest('base64');
}

/**
 * Phase 20: Twilio delivery-status callbacks. PUBLIC route (Twilio calls it),
 * authenticated by X-Twilio-Signature instead of an api key.
 *
 * No content-type parser is registered here: app.ts already installs a global
 * application/x-www-form-urlencoded parser (rawBody + URLSearchParams-decoded
 * body), which is exactly the shape Twilio posts. A second parser for the same
 * type in this (non-encapsulated) context would throw at boot.
 */
export function registerSmsWebhookRoutes(app: FastifyInstance) {
  app.post<{ Params: { messageId: string } }>(
    '/webhooks/sms/twilio/:messageId',
    async (req, reply) => {
      const message = await getMessage(req.params.messageId);
      if (!message || message.channel !== 'sms') {
        return reply.code(404).send({ error: 'unknown message' });
      }

      const params = (req.body ?? {}) as Record<string, string>;
      const signature = (req.headers['x-twilio-signature'] as string | undefined) ?? '';
      // Reconstruct the EXACT url Twilio signed. Behind the cloudflared tunnel
      // the Host header is the tunnel host, so this stays correct across tunnel
      // rotations — unlike getPublicUrl(), whose cached value can lag a rotate.
      const url = `${req.headers['x-forwarded-proto'] ?? 'https'}://${req.headers.host}${req.raw.url}`;

      // Candidate authTokens: the tenant's active twilio integrations. The
      // message's provider field records which instance sent it
      // (`twilio:<id8>`, see providers/factory.ts), so try the matching
      // integration first, then any other active twilio integration in case
      // the instance was rotated/deleted after the send.
      const candidates = (await integrationsForChannel(message.tenant_id, 'sms')).filter(
        (r) => r.provider === 'twilio',
      );
      candidates.sort(
        (a, b) =>
          Number(message.provider === `twilio:${b.id.slice(0, 8)}`) -
          Number(message.provider === `twilio:${a.id.slice(0, 8)}`),
      );

      let valid = false;
      for (const row of candidates) {
        let authToken: string;
        try {
          authToken = (JSON.parse(openSecret(row.credentials)) as { authToken?: string })
            .authToken ?? '';
        } catch {
          continue; // unreadable/rotated credentials — skip this candidate
        }
        if (authToken && safeEqual(signature, twilioSignature(authToken, url, params))) {
          valid = true;
          break;
        }
      }

      if (!valid) {
        logger.warn(
          { messageId: message.id, tenantId: message.tenant_id },
          'twilio callback rejected: invalid signature',
        );
        return reply.code(403).send({ error: 'invalid signature' });
      }

      // STOP/blacklist (ErrorCode 21610): the recipient texted STOP, so suppress
      // the number — future sms fan-outs skip it. Best-effort; a failed insert
      // must not fail the callback (Twilio would just retry it).
      if (params.ErrorCode === '21610' && message.content.to.phone) {
        try {
          await addSuppression(message.tenant_id, 'sms', message.content.to.phone, 'stop');
        } catch (err) {
          logger.warn(
            { err: (err as Error).message, messageId: message.id },
            'twilio callback: suppression insert failed',
          );
        }
      }

      // Map Twilio's terminal states onto ours; intermediate states
      // (queued/sending/sent/accepted) don't advance our Activity, so they are
      // a fast 204 no-op rather than queue churn.
      const mapped =
        params.MessageStatus === 'delivered'
          ? 'delivered'
          : params.MessageStatus === 'failed' || params.MessageStatus === 'undelivered'
            ? 'failed'
            : null;

      if (!mapped || !params.MessageSid) {
        return reply.code(204).send();
      }

      // Mirror webhooks.ts exactly: enqueue on the status queue and ack, so the
      // shared status processor applies the state flip (and suppression, for
      // hard failures) off the request path. provider carries the message
      // row's instance id, matching how updateMessageByProviderId is keyed.
      await getQueue(QUEUE.STATUS).add(
        'status',
        {
          provider: message.provider ?? 'twilio',
          providerMessageId: params.MessageSid,
          status: mapped,
        },
        { attempts: 5 },
      );
      return reply.code(204).send();
    },
  );
}
