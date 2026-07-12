import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { authenticate } from '../auth';
import { env } from '../../config/env';
import { logExec } from '../../core/execution-log';
import { getQueue, QUEUE } from '../../shared/queues';
import { sealSecret, openSecret } from '../../auth/secret-box';
import { parsePostmarkInbound, type PostmarkInbound } from '../../channels/email-inbound';
import { upsertSubscriber, type Subscriber } from '../../db/repositories';
import {
  findSubscriberByEmail,
  repointConversations,
  resolveChannelIdentity,
  upsertChannelIdentity,
} from '../../db/identities.repo';
import { resolveAgentForInbound } from '../../core/inbound-routing';
import {
  deleteConnection,
  getAgent,
  getConnectionById,
  getConnectionForAgent,
  insertConversationMessage,
  openChannelConversation,
  updateConnectionAgent,
  upsertEmailConnection,
  type Agent,
} from '../../db/conversations.repo';

interface EmailCredentials {
  webhookSecret: string;
}

function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/** The inbound address a connect body must carry, shared by both connect routes. */
export const emailAddressSchema = z.string().trim().email().max(320);

/**
 * The core email connect flow, shared by the legacy per-agent route and the
 * standalone /v1/connections/email route. Upserts the connection (re-pointing
 * its live threads onto the current agent when the identity-upsert hit an
 * existing row) and returns the pasteable inbound webhook URL. Mirrors the
 * historical response so the legacy shim stays byte-identical.
 */
export async function handleEmailConnect(
  reply: FastifyReply,
  tenantId: string,
  agent: Agent,
  address: string,
): Promise<FastifyReply> {
  const connection = await upsertEmailConnection({
    tenantId,
    agentId: agent.id,
    sealedCredentials: sealSecret(
      JSON.stringify({
        webhookSecret: randomBytes(24).toString('hex'),
      } satisfies EmailCredentials),
    ),
    config: { address: address.toLowerCase() },
  });

  // Re-connecting the same inbound address may be re-pointing it at a
  // different agent: move its live threads onto the current agent.
  // Idempotent — an unchanged agent moves zero rows.
  if (connection.refreshed) {
    await updateConnectionAgent(tenantId, connection.id, agent.id);
  }

  return reply.code(201).send({
    channel: 'email',
    address: address.toLowerCase(),
    // The credential the user pastes into the provider's inbound settings —
    // retrievable again from the channels listing.
    webhookUrl: emailWebhookUrl(connection.id, connection.credentials),
  });
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
      const parsed = z.object({ address: emailAddressSchema }).safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      // Legacy shim: same core flow as POST /v1/connections/email, agent
      // resolved from the path instead of the body.
      return handleEmailConnect(reply, req.tenant.id, agent, parsed.data.address);
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
      if (!inbound) return { ok: true, skipped: true };
      const agent = await resolveAgentForInbound(connection);
      if (!agent) return { ok: true, skipped: true };

      const subscriber = await resolveEmailSubscriber(connection.tenant_id, inbound.fromEmail);
      const conversation = await openChannelConversation({
        tenantId: connection.tenant_id,
        connectionId: connection.id,
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

/**
 * Who is this sender? Resolution order:
 *  1. explicit mapping (linked before) → the real subscriber
 *  2. AUTO-MATCH: the address equals an existing real subscriber's email →
 *     write the mapping now and repoint this thread's history. Industry-
 *     standard (From is spoofable, but consequences are bounded: replies
 *     go to the real mailbox owner, never the spoofer).
 *  3. fallback: today's channel-local row keyed by the address itself.
 */
async function resolveEmailSubscriber(tenantId: string, fromEmail: string): Promise<Subscriber> {
  const linked = await resolveChannelIdentity(tenantId, 'email', fromEmail);
  if (linked) return linked;

  const match = await findSubscriberByEmail(tenantId, fromEmail);
  if (match) {
    await upsertChannelIdentity({
      tenantId,
      channel: 'email',
      externalKey: fromEmail,
      subscriberId: match.id,
    });
    const repointed = await repointConversations(tenantId, 'email', fromEmail, match.id);
    logExec({
      tenantId,
      transactionId: `link-email-${match.id}`,
      level: 'info',
      detail: `email ${fromEmail} auto-linked to subscriber ${match.external_id} (${repointed} conversations repointed)`,
    });
    return match;
  }

  return upsertSubscriber(tenantId, { subscriberId: fromEmail, email: fromEmail });
}

/** Rebuild the webhook URL (used by connect and the channels listing). */
export function emailWebhookUrl(connectionId: string, sealedCredentials: string): string {
  const { webhookSecret } = JSON.parse(openSecret(sealedCredentials)) as EmailCredentials;
  return `${env.publicUrl}/webhooks/email/${connectionId}?key=${webhookSecret}`;
}
