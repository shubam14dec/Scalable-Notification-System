import type { FastifyInstance, FastifyReply } from 'fastify';
import { createHash, randomBytes } from 'node:crypto';
import { z } from 'zod';
import { authenticate } from '../auth';
import { upsertSubscriber } from '../../db/repositories';
import {
  getAgent,
  listConnectionsForAgent,
  type AgentConnection,
} from '../../db/conversations.repo';
import {
  createLinkToken,
  deleteChannelIdentity,
  listChannelIdentities,
} from '../../db/identities.repo';

/**
 * Subscriber linking: mint the deep-link token that merges a channel
 * identity into a REAL subscriber, and inspect/undo the mappings.
 * The token is single-use, stored hashed, 24h TTL (long enough to ride
 * inside an email or a QR code; still single-use so exposure is bounded).
 */

const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

export function hashLinkToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/**
 * Mint a telegram deep-link token for a subscriber through a specific active
 * telegram connection. Shared by the legacy per-agent route and the standalone
 * POST /v1/connections/:id/link-tokens. Callers must have already established
 * that the connection is an active telegram identity; the botUsername off its
 * config builds the t.me deep link. Forgiving like triggers: the customer's
 * user may not have messaged yet, so the subscriber is upserted.
 */
export async function mintLinkToken(
  reply: FastifyReply,
  tenantId: string,
  connection: AgentConnection,
  subscriberId: string,
): Promise<FastifyReply> {
  const botUsername = (connection.config as { botUsername?: string } | null)?.botUsername;

  const subscriber = await upsertSubscriber(tenantId, { subscriberId });

  // 48 hex chars — inside Telegram's 64-char start-payload limit.
  const token = randomBytes(24).toString('hex');
  const row = await createLinkToken({
    tenantId,
    subscriberId: subscriber.id,
    channel: 'telegram',
    tokenHash: hashLinkToken(token),
    expiresAt: new Date(Date.now() + TOKEN_TTL_MS),
  });

  return reply.code(201).send({
    token,
    deepLink: `https://t.me/${botUsername}?start=${token}`,
    expiresAt: row.expires_at,
  });
}

/** An agent's active telegram connections (0, 1, or — post-split — several). */
export async function activeTelegramConnections(agentId: string): Promise<AgentConnection[]> {
  return (await listConnectionsForAgent(agentId)).filter(
    (c) =>
      c.channel === 'telegram' &&
      c.status === 'active' &&
      Boolean((c.config as { botUsername?: string } | null)?.botUsername),
  );
}

export function registerIdentityRoutes(app: FastifyInstance) {
  /** Mint a telegram deep link for a subscriber (server-side only). */
  app.post<{
    Params: { identifier: string; subscriberId: string };
    Querystring: { connectionId?: string };
  }>(
    '/v1/agents/:identifier/subscribers/:subscriberId/link-token',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const telegrams = await activeTelegramConnections(agent.id);
      if (telegrams.length === 0) {
        return reply.code(404).send({ error: 'agent has no active telegram connection' });
      }

      // Post-split an agent may carry several telegram identities. One is
      // unambiguous; more than one needs the caller to name which via
      // ?connectionId, else it's a 409 listing the choices.
      let connection = telegrams[0];
      if (telegrams.length > 1) {
        const picked = req.query.connectionId
          ? telegrams.find((c) => c.id === req.query.connectionId)
          : undefined;
        if (!picked) {
          return reply.code(409).send({
            error: 'multiple telegram connections',
            connections: telegrams.map((c) => ({
              id: c.id,
              botUsername: (c.config as { botUsername?: string } | null)?.botUsername ?? null,
            })),
          });
        }
        connection = picked;
      }

      return mintLinkToken(reply, req.tenant.id, connection, req.params.subscriberId);
    },
  );

  /** The subscriber's linked channel identities. */
  app.get<{ Params: { subscriberId: string } }>(
    '/v1/subscribers/:subscriberId/identities',
    { preHandler: [authenticate] },
    async (req) => ({
      identities: (await listChannelIdentities(req.tenant.id, req.params.subscriberId)).map(
        (i) => ({ channel: i.channel, externalKey: i.external_key, linkedAt: i.created_at }),
      ),
    }),
  );

  /** Unlink: drop the mapping; future messages fall back to a channel-local identity. */
  app.delete<{ Params: { subscriberId: string } }>(
    '/v1/subscribers/:subscriberId/identities',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = z
        .object({ channel: z.enum(['telegram', 'email']), externalKey: z.string().min(1).max(320) })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const deleted = await deleteChannelIdentity(
        req.tenant.id,
        parsed.data.channel,
        parsed.data.externalKey,
      );
      return { deleted };
    },
  );
}
