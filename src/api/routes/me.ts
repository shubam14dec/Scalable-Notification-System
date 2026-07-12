import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { verifySubscriberToken } from '../../auth/subscriber-token';
import { getEnvironment } from '../../db/accounts.repo';
import { openSecret } from '../../auth/secret-box';
import { tenantRateLimit } from '../rate-limit';
import { slack } from '../../channels/slack';
import {
  getConnection,
  listConnectionsForTenant,
  updateConnectionConfig,
} from '../../db/conversations.repo';
import {
  deleteChannelIdentity,
  listChannelIdentities,
  resolveChannelIdentity,
} from '../../db/identities.repo';
import { mintLinkTokenCore } from './identities';
import type { SlackCredentials } from './slack';

/**
 * The /v1/me self-service family: the endpoints a subscriber's OWN browser/app
 * calls with its short-lived subscriber token to see which channels it can link
 * itself into, mint a link/redirect for one, and unlink an identity. Distinct
 * from the server-side identity routes (api-key, per-subscriber management) —
 * here the token IS the identity, so nothing names a subscriber id.
 */

/**
 * Token-ONLY auth: the nst_ token IS the identity. No api-key fallback —
 * an api key has no subscriber context; admins have their own routes.
 * Returns the token's subscriberId (the subscriber's external id) or null,
 * having already sent the 401 in the null case.
 */
async function authenticateMe(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<string | null> {
  const token = req.headers['x-subscriber-token'];
  const payload = typeof token === 'string' && token.length > 0 ? verifySubscriberToken(token) : null;
  if (!payload) {
    await reply.code(401).send({ error: 'invalid subscriber token' });
    return null;
  }
  const environment = await getEnvironment(payload.tenantId);
  if (!environment) {
    await reply.code(401).send({ error: 'invalid subscriber token' });
    return null;
  }
  req.tenant = environment;
  return payload.subscriberId;
}

const LinkTokenSchema = z.object({ connectionId: z.string().uuid() });

const DeleteIdentitySchema = z.object({
  channel: z.enum(['telegram', 'email', 'slack']),
  externalKey: z.string().min(1).max(320),
});

export function registerMeRoutes(app: FastifyInstance) {
  /**
   * The subscriber's linkable channels + which it has already linked. The shape
   * is a strict PROJECTION — only connectionId/channel/label/linked/identities
   * leave here; workspace ids, bot ids, webhooks, credentials, appIds, and email
   * connection addresses never do.
   */
  app.get('/v1/me/channels', async (req, reply) => {
    const subscriberId = await authenticateMe(req, reply);
    if (subscriberId === null) return;

    const [connections, identities] = await Promise.all([
      listConnectionsForTenant(req.tenant.id),
      listChannelIdentities(req.tenant.id, subscriberId),
    ]);

    const byChannel = (channel: string) =>
      identities
        .filter((i) => i.channel === channel)
        .map((i) => ({ externalKey: i.external_key, linkedAt: i.created_at }));
    const telegramIdentities = byChannel('telegram');
    const slackIdentities = byChannel('slack');

    const telegramRows = connections
      .filter(
        (c) =>
          c.status === 'active' &&
          c.channel === 'telegram' &&
          Boolean((c.config as { botUsername?: string }).botUsername),
      )
      .map((c) => ({
        connectionId: c.id,
        channel: 'telegram' as const,
        label: '@' + (c.config as { botUsername?: string }).botUsername,
        linked: telegramIdentities.length > 0,
        identities: telegramIdentities,
      }));

    const slackRows = connections
      .filter((c) => c.status === 'active' && c.channel === 'slack')
      .map((c) => {
        const config = c.config as { teamName?: string; teamId?: string };
        return {
          connectionId: c.id,
          channel: 'slack' as const,
          label: config.teamName ?? config.teamId ?? 'Slack workspace',
          linked: slackIdentities.length > 0,
          identities: slackIdentities,
        };
      });

    // Email has no connection rows the subscriber links into — the identity IS
    // the address, so surface one row per linked email identity.
    const emailRows = identities
      .filter((i) => i.channel === 'email')
      .map((i) => ({
        connectionId: null,
        channel: 'email' as const,
        label: i.external_key,
        linked: true,
        identities: [{ externalKey: i.external_key, linkedAt: i.created_at }],
      }));

    return { channels: [...telegramRows, ...slackRows, ...emailRows] };
  });

  /**
   * Mint the artifact that links THIS subscriber into a connection: a telegram
   * deep link, or a slack app-redirect URL. Rate-limited per tenant (same
   * budget as triggers) since it mints tokens / calls Slack.
   */
  app.post('/v1/me/link-tokens', async (req, reply) => {
    const subscriberId = await authenticateMe(req, reply);
    if (subscriberId === null) return;

    // tenantRateLimit is a preHandler-shaped fn; invoked in-handler it either
    // sends a 429 (then reply.sent) or sets req.overflowDiverted.
    await tenantRateLimit(req, reply);
    if (reply.sent) return;

    const parsed = LinkTokenSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }

    const connection = await getConnection(req.tenant.id, parsed.data.connectionId);
    if (!connection || connection.status !== 'active') {
      return reply.code(404).send({ error: 'unknown connection' });
    }

    if (connection.channel === 'telegram') {
      const botUsername = (connection.config as { botUsername?: string }).botUsername;
      if (!botUsername) return reply.code(404).send({ error: 'unknown connection' });
      const minted = await mintLinkTokenCore(req.tenant.id, connection, subscriberId);
      reply.code(201);
      return { kind: 'telegram_deeplink', url: minted.deepLink, expiresAt: minted.expiresAt };
    }

    if (connection.channel === 'slack') {
      const config = connection.config as { appId?: string; teamId?: string };
      let appId = config.appId;
      if (!appId) {
        // Lazy backfill: an older connection (or one whose connect-time
        // bots.info failed) has no appId — fetch it now and persist it.
        try {
          const creds = JSON.parse(openSecret(connection.credentials)) as SlackCredentials;
          const at = await slack.authTest(creds.botToken);
          const bi = await slack.botsInfo(creds.botToken, at.bot_id);
          appId = bi.bot.app_id;
          if (appId) await updateConnectionConfig(req.tenant.id, connection.id, { appId });
        } catch {
          // fall through to the 502 below
        }
      }
      if (!appId) {
        return reply
          .code(502)
          .send({ error: 'could not determine the slack app id — reconnect the workspace' });
      }
      reply.code(201);
      return {
        kind: 'slack_redirect',
        url: `https://slack.com/app_redirect?app=${appId}&team=${config.teamId}`,
      };
    }

    return reply.code(404).send({ error: 'unknown connection' });
  });

  /**
   * Unlink one of the subscriber's own identities. Deliberately indistinguishable
   * between "no such identity" and "belongs to someone else" — both return
   * { deleted: false } so the endpoint is not an identity-existence oracle.
   */
  app.delete('/v1/me/identities', async (req, reply) => {
    const subscriberId = await authenticateMe(req, reply);
    if (subscriberId === null) return;

    const parsed = DeleteIdentitySchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }

    const owner = await resolveChannelIdentity(
      req.tenant.id,
      parsed.data.channel,
      parsed.data.externalKey,
    );
    if (!owner || owner.external_id !== subscriberId) {
      return { deleted: false };
    }
    await deleteChannelIdentity(req.tenant.id, parsed.data.channel, parsed.data.externalKey);
    return { deleted: true };
  });
}
