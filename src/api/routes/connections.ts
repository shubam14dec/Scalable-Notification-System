import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { logger } from '../../shared/logger';
import { telegram } from '../../channels/telegram';
import {
  connectionWebhookState,
  credentials,
  handleTelegramConnect,
  registerWebhook,
  telegramBotTokenSchema,
} from './telegram';
import { emailAddressSchema, handleEmailConnect } from './email-channel';
import {
  handleSlackConnect,
  slackBotTokenSchema,
  slackSigningSecretSchema,
} from './slack';
import { mintLinkToken } from './identities';
import {
  deleteConnectionById,
  deleteRoutingRule,
  getAgent,
  getConnection,
  listConnectionsForTenant,
  listRoutingRules,
  updateConnectionAgent,
  upsertRoutingRule,
} from '../../db/conversations.repo';

/**
 * The connection-as-endpoint API surface: channel connections are standalone
 * resources (a bot / an inbound address), each routed to exactly one agent.
 * The legacy per-agent routes (telegram.ts, email-channel.ts, identities.ts)
 * are byte-identical shims over the SAME shared cores this file calls, so
 * either surface produces the same effects. A sealed credential or bot token
 * never appears in any response here — only minted webhook URLs and config.
 */
export function registerConnectionRoutes(app: FastifyInstance) {
  /** Every connection in the tenant, with its agent and live webhook state. */
  app.get('/v1/connections', { preHandler: [authenticate] }, async (req) => {
    const rows = await listConnectionsForTenant(req.tenant.id);
    const connections = [];
    for (const c of rows) {
      const state = await connectionWebhookState(c);
      connections.push({
        id: c.id,
        channel: state.channel,
        status: state.status,
        config: state.config,
        agent: { identifier: c.agent_identifier, name: c.agent_name },
        webhook: state.webhook,
        createdAt: state.createdAt,
      });
    }
    return { connections };
  });

  /** Connect a telegram bot and route it to an agent named in the body. */
  app.post('/v1/connections/telegram', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = z
      .object({ botToken: telegramBotTokenSchema, agentIdentifier: z.string().min(1) })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const agent = await getAgent(req.tenant.id, parsed.data.agentIdentifier);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });
    return handleTelegramConnect(reply, req.tenant.id, agent, parsed.data.botToken);
  });

  /** Connect an inbound email address and route it to an agent named in the body. */
  app.post('/v1/connections/email', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = z
      .object({ address: emailAddressSchema, agentIdentifier: z.string().min(1) })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const agent = await getAgent(req.tenant.id, parsed.data.agentIdentifier);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });
    return handleEmailConnect(reply, req.tenant.id, agent, parsed.data.address);
  });

  /** Connect a Slack workspace (bot token + signing secret) and route it to an agent. */
  app.post('/v1/connections/slack', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = z
      .object({
        botToken: slackBotTokenSchema,
        signingSecret: slackSigningSecretSchema,
        agentIdentifier: z.string().min(1),
      })
      .safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const agent = await getAgent(req.tenant.id, parsed.data.agentIdentifier);
    if (!agent) return reply.code(404).send({ error: 'unknown agent' });
    return handleSlackConnect(
      reply,
      req.tenant.id,
      agent,
      parsed.data.botToken,
      parsed.data.signingSecret,
    );
  });

  /** Re-point a connection at a different agent, moving its live threads along. */
  app.patch<{ Params: { id: string } }>(
    '/v1/connections/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(400).send({ error: 'invalid connection id' });
      }
      const parsed = z.object({ agentIdentifier: z.string().min(1) }).safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const agent = await getAgent(req.tenant.id, parsed.data.agentIdentifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const result = await updateConnectionAgent(req.tenant.id, req.params.id, agent.id);
      if (!result) return reply.code(404).send({ error: 'unknown connection' });
      return {
        id: result.connection.id,
        agent: { identifier: agent.identifier, name: agent.name },
        movedConversations: result.movedConversations,
      };
    },
  );

  /** Re-register the channel's webhook (telegram only — email's URL is static). */
  app.post<{ Params: { id: string } }>(
    '/v1/connections/:id/reconnect',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });
      if (connection.channel !== 'telegram') {
        // Non-telegram channels register no webhook (email's inbound address
        // and slack's paste-in URLs are both static) — nothing to re-issue.
        const msg =
          connection.channel === 'slack'
            ? 'nothing to re-register — the slack webhook URLs are static'
            : 'nothing to re-register — the email webhook URL is static';
        return reply.code(400).send({ error: msg });
      }
      try {
        const url = await registerWebhook(connection);
        return { channel: 'telegram', webhookUrl: url };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  /** Disconnect a connection: best-effort de-register, then delete the row. */
  app.delete<{ Params: { id: string } }>(
    '/v1/connections/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });
      if (connection.channel === 'telegram') {
        // Best effort: a revoked bot token must not block disconnecting.
        await telegram
          .deleteWebhook(credentials(connection).botToken)
          .catch((err) =>
            logger.warn(
              { err: (err as Error).message },
              'telegram deleteWebhook failed on disconnect',
            ),
          );
      }
      await deleteConnectionById(req.tenant.id, req.params.id);
      return { deleted: true };
    },
  );

  /** Mint a telegram deep-link token through a specific active connection. */
  app.post<{ Params: { id: string } }>(
    '/v1/connections/:id/link-tokens',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const parsed = z.object({ subscriberId: z.string().min(1) }).safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });
      const botUsername = (connection.config as { botUsername?: string } | null)?.botUsername;
      if (connection.channel !== 'telegram' || connection.status !== 'active' || !botUsername) {
        return reply.code(404).send({ error: 'no active telegram connection' });
      }
      return mintLinkToken(reply, req.tenant.id, connection, parsed.data.subscriberId);
    },
  );

  // ---- slack scope routing rules (a slack-only feature) ----

  /** List a slack connection's scope routing rules. */
  app.get<{ Params: { id: string } }>(
    '/v1/connections/:id/routes',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });
      if (connection.channel !== 'slack') {
        return reply.code(400).send({ error: 'routing rules are a slack feature' });
      }
      const rules = await listRoutingRules(req.tenant.id, connection.id);
      return {
        routes: rules.map((r) => ({
          scopeKey: r.scope_key,
          agent: { identifier: r.agent_identifier, name: r.agent_name },
          createdAt: r.created_at,
        })),
      };
    },
  );

  /** Set (or re-point) the rule for a scope — a slack channel/group id. */
  app.put<{ Params: { id: string } }>(
    '/v1/connections/:id/routes',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });
      if (connection.channel !== 'slack') {
        return reply.code(400).send({ error: 'routing rules are a slack feature' });
      }
      const parsed = z
        .object({
          scopeKey: z
            .string()
            .trim()
            .regex(/^[CG][A-Z0-9]{6,}$/i, 'that does not look like a slack channel id'),
          agentIdentifier: z.string().min(1),
        })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const agent = await getAgent(req.tenant.id, parsed.data.agentIdentifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      await upsertRoutingRule({
        tenantId: req.tenant.id,
        connectionId: connection.id,
        scopeKey: parsed.data.scopeKey,
        agentId: agent.id,
      });
      return {
        scopeKey: parsed.data.scopeKey,
        agent: { identifier: agent.identifier, name: agent.name },
      };
    },
  );

  /** Remove a scope routing rule. */
  app.delete<{ Params: { id: string; scopeKey: string } }>(
    '/v1/connections/:id/routes/:scopeKey',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnection(req.tenant.id, req.params.id);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });
      if (connection.channel !== 'slack') {
        return reply.code(400).send({ error: 'routing rules are a slack feature' });
      }
      const deleted = await deleteRoutingRule(req.tenant.id, connection.id, req.params.scopeKey);
      return { deleted };
    },
  );
}
