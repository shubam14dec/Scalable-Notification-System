import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { authenticate } from '../auth';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { getQueue, QUEUE } from '../../shared/queues';
import { logExec } from '../../core/execution-log';
import { sealSecret, openSecret } from '../../auth/secret-box';
import { telegram, type TelegramUpdate } from '../../channels/telegram';
import { upsertSubscriber } from '../../db/repositories';
import {
  deleteConnection,
  getAgent,
  getAgentById,
  getConnectionById,
  getConnectionForAgent,
  insertConversationMessage,
  listConnectionsForAgent,
  openConversation,
  upsertConnection,
  type AgentConnection,
} from '../../db/conversations.repo';

interface TelegramCredentials {
  botToken: string;
  webhookSecret: string;
}

function credentials(connection: AgentConnection): TelegramCredentials {
  return JSON.parse(openSecret(connection.credentials)) as TelegramCredentials;
}

function webhookUrl(connectionId: string): string {
  return `${env.publicUrl}/webhooks/telegram/${connectionId}`;
}

/**
 * Register (or re-register) the webhook with Telegram. Separate step so a
 * changed PUBLIC_URL (tunnel restarts, domain moves) is one reconnect away.
 */
async function registerWebhook(connection: AgentConnection): Promise<string> {
  const creds = credentials(connection);
  const url = webhookUrl(connection.id);
  await telegram.setWebhook(creds.botToken, url, creds.webhookSecret);
  return url;
}

export function registerTelegramRoutes(app: FastifyInstance) {
  // ---- channel management ----

  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/channels/telegram',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = z
        .object({ botToken: z.string().min(20).max(255) })
        .safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      // Validate the token against Telegram before storing anything.
      let bot;
      try {
        bot = await telegram.getMe(parsed.data.botToken);
      } catch (err) {
        return reply.code(422).send({ error: `telegram rejected the token: ${(err as Error).message}` });
      }

      const connection = await upsertConnection({
        tenantId: req.tenant.id,
        agentId: agent.id,
        channel: 'telegram',
        sealedCredentials: sealSecret(
          JSON.stringify({
            botToken: parsed.data.botToken,
            // Telegram echoes this on every push; 1-256 chars of [A-Za-z0-9_-].
            webhookSecret: randomBytes(24).toString('hex'),
          } satisfies TelegramCredentials),
        ),
        config: { botId: bot.id, botUsername: bot.username },
      });

      try {
        const url = await registerWebhook(connection);
        return reply.code(201).send({
          channel: 'telegram',
          botUsername: bot.username,
          webhookUrl: url,
        });
      } catch (err) {
        // Connection saved, webhook not live (e.g. PUBLIC_URL not reachable
        // by Telegram). Surface it — reconnect retries the registration.
        return reply.code(502).send({
          error: `token accepted but webhook registration failed: ${(err as Error).message}`,
          channel: 'telegram',
          botUsername: bot.username,
        });
      }
    },
  );

  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/channels/telegram/reconnect',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const connection = await getConnectionForAgent(agent.id, 'telegram');
      if (!connection) return reply.code(404).send({ error: 'telegram is not connected' });
      try {
        const url = await registerWebhook(connection);
        return { channel: 'telegram', webhookUrl: url };
      } catch (err) {
        return reply.code(502).send({ error: (err as Error).message });
      }
    },
  );

  /** Connections + live webhook state, so the dashboard can show the truth. */
  app.get<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/channels',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const connections = await listConnectionsForAgent(agent.id);
      const out = [];
      for (const c of connections) {
        let webhook: unknown = null;
        if (c.channel === 'telegram') {
          try {
            const info = await telegram.getWebhookInfo(credentials(c).botToken);
            webhook = {
              url: info.url,
              pendingUpdates: info.pending_update_count,
              lastError: info.last_error_message ?? null,
              expectedUrl: webhookUrl(c.id),
            };
          } catch (err) {
            webhook = { error: (err as Error).message };
          }
        }
        out.push({ channel: c.channel, status: c.status, config: c.config, webhook, createdAt: c.created_at });
      }
      return { channels: out };
    },
  );

  app.delete<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/channels/telegram',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const connection = await getConnectionForAgent(agent.id, 'telegram');
      if (!connection) return { deleted: false };
      // Best effort: a revoked bot token must not block disconnecting.
      await telegram.deleteWebhook(credentials(connection).botToken).catch((err) =>
        logger.warn({ err: (err as Error).message }, 'telegram deleteWebhook failed on disconnect'),
      );
      await deleteConnection(agent.id, 'telegram');
      return { deleted: true };
    },
  );

  // ---- inbound: Telegram pushes every update here (prod AND local dev) ----

  app.post<{ Params: { connectionId: string } }>(
    '/webhooks/telegram/:connectionId',
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.connectionId).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnectionById(req.params.connectionId);
      if (!connection) return reply.code(404).send({ error: 'unknown connection' });

      const secret = req.headers['x-telegram-bot-api-secret-token'];
      if (secret !== credentials(connection).webhookSecret) {
        return reply.code(401).send({ error: 'bad secret token' });
      }

      const update = req.body as TelegramUpdate;
      const message = update?.message;
      // Ack everything we don't handle — a 200 is how Telegram stops
      // re-delivering; non-text/bot/group updates are simply not for us (v1).
      if (
        typeof update?.update_id !== 'number' ||
        !message?.text ||
        !message.from ||
        message.from.is_bot ||
        message.chat.type !== 'private' ||
        connection.status !== 'active'
      ) {
        return { ok: true, skipped: true };
      }
      const agent = await getAgentById(connection.agent_id);
      if (!agent || agent.status !== 'active') return { ok: true, skipped: true };

      const subscriber = await upsertSubscriber(connection.tenant_id, {
        subscriberId: `tg-${message.from.id}`,
      });
      const conversation = await openConversation({
        tenantId: connection.tenant_id,
        agentId: agent.id,
        subscriberId: subscriber.id,
        channel: 'telegram',
        threadKey: String(message.chat.id),
      });

      const row = await insertConversationMessage({
        conversationId: conversation.id,
        tenantId: connection.tenant_id,
        role: 'user',
        content: message.text,
        // Telegram re-delivers until acked; its own update_id is the wall.
        dedupeKey: `tg-${update.update_id}`,
        raw: { telegramMessageId: message.message_id, from: message.from.username ?? null },
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
        detail: `telegram turn accepted: agent=${agent.identifier} subscriber=tg-${message.from.id}`,
      });

      return { ok: true };
    },
  );
}
