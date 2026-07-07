import type { FastifyInstance } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { authenticate } from '../auth';
import { env } from '../../config/env';
import { logExec } from '../../core/execution-log';
import { getQueue, QUEUE } from '../../shared/queues';
import { sealSecret, openSecret } from '../../auth/secret-box';
import { parsePostmarkInbound, type PostmarkInbound } from '../../channels/email-inbound';
import { upsertSubscriber } from '../../db/repositories';
import {
  deleteConnection,
  getAgent,
  getAgentById,
  getConnectionById,
  getConnectionForAgent,
  insertConversationMessage,
  openConversation,
  upsertConnection,
} from '../../db/conversations.repo';

interface EmailCredentials {
  webhookSecret: string;
}

function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export function registerEmailChannelRoutes(app: FastifyInstance) {
  /**
   * Connect email: the user brings an inbound address (e.g. Postmark's
   * <hash>@inbound.postmarkapp.com) and pastes OUR webhook URL into the
   * provider. Routing is by connectionId in that URL — the address is
   * display/reply-identity, not routing (v1: one agent per inbound server).
   */
  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/channels/email',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = z
        .object({ address: z.string().trim().email().max(320) })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      const connection = await upsertConnection({
        tenantId: req.tenant.id,
        agentId: agent.id,
        channel: 'email',
        sealedCredentials: sealSecret(
          JSON.stringify({
            webhookSecret: randomBytes(24).toString('hex'),
          } satisfies EmailCredentials),
        ),
        config: { address: parsed.data.address.toLowerCase() },
      });

      return reply.code(201).send({
        channel: 'email',
        address: parsed.data.address.toLowerCase(),
        // The credential the user pastes into the provider's inbound
        // settings — retrievable again from the channels listing.
        webhookUrl: emailWebhookUrl(connection.id, connection.credentials),
      });
    },
  );

  app.delete<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/channels/email',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const connection = await getConnectionForAgent(agent.id, 'email');
      if (!connection) return { deleted: false };
      await deleteConnection(agent.id, 'email');
      return { deleted: true };
    },
  );

  // ---- inbound: the provider POSTs every parsed email here ----

  app.post<{ Params: { connectionId: string }; Querystring: { key?: string } }>(
    '/webhooks/email/:connectionId',
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.connectionId).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnectionById(req.params.connectionId);
      if (!connection || connection.channel !== 'email') {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      // Postmark can't set custom headers, so the minted secret rides the
      // query string — same trust role as telegram's secret-token header.
      const creds = JSON.parse(openSecret(connection.credentials)) as EmailCredentials;
      if (!req.query.key || !secretsMatch(req.query.key, creds.webhookSecret)) {
        return reply.code(401).send({ error: 'bad key' });
      }

      const inbound = parsePostmarkInbound((req.body ?? {}) as PostmarkInbound);
      // 200-ack what we can't use — a retry won't make it parseable.
      if (!inbound || connection.status !== 'active') return { ok: true, skipped: true };
      const agent = await getAgentById(connection.agent_id);
      if (!agent || agent.status !== 'active') return { ok: true, skipped: true };

      const subscriber = await upsertSubscriber(connection.tenant_id, {
        subscriberId: inbound.fromEmail,
        email: inbound.fromEmail,
      });
      const conversation = await openConversation({
        tenantId: connection.tenant_id,
        agentId: agent.id,
        subscriberId: subscriber.id,
        channel: 'email',
        threadKey: inbound.fromEmail,
      });

      const row = await insertConversationMessage({
        conversationId: conversation.id,
        tenantId: connection.tenant_id,
        role: 'user',
        content: inbound.text,
        // The provider's message id: a re-delivered webhook is a no-op.
        dedupeKey: `email-${inbound.providerMessageId}`,
        // Kept for the reply: subject for "Re:", Message-ID for In-Reply-To.
        raw: { subject: inbound.subject, rfcMessageId: inbound.rfcMessageId },
      });
      if (!row) return { ok: true, duplicate: true };

      await getQueue(QUEUE.CONVERSATION).add(
        row.id,
        { tenantId: connection.tenant_id, conversationId: conversation.id, messageId: row.id },
        { jobId: `conv-${row.id}`, attempts: 5 },
      );

      logExec({
        tenantId: connection.tenant_id,
        transactionId: `conv-${conversation.id}`,
        level: 'info',
        detail: `email turn accepted: agent=${agent.identifier} from=${inbound.fromEmail}`,
      });

      return { ok: true };
    },
  );
}

/** Rebuild the webhook URL (used by connect and the channels listing). */
export function emailWebhookUrl(connectionId: string, sealedCredentials: string): string {
  const { webhookSecret } = JSON.parse(openSecret(sealedCredentials)) as EmailCredentials;
  return `${env.publicUrl}/webhooks/email/${connectionId}?key=${webhookSecret}`;
}
