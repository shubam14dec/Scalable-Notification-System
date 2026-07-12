import type { FastifyInstance, FastifyReply } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { authenticate } from '../auth';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { getQueue, QUEUE } from '../../shared/queues';
import { logExec } from '../../core/execution-log';
import { sealSecret, openSecret } from '../../auth/secret-box';
import { telegram, type TelegramUpdate } from '../../channels/telegram';
import { emailWebhookUrl } from './email-channel';
import { slackWebhookUrls } from './slack';
import { upsertSubscriber } from '../../db/repositories';
import { hashLinkToken } from './identities';
import {
  consumeLinkToken,
  repointConversations,
  resolveChannelIdentity,
  upsertChannelIdentity,
} from '../../db/identities.repo';
import { resolveAgentForInbound } from '../../core/inbound-routing';
import {
  deleteConnection,
  editConversationMessage,
  findConversationByConnectionThread,
  findMessageByTelegramId,
  getAgent,
  getConnectionById,
  getConnectionForAgent,
  getSubscriberById,
  insertConversationMessage,
  listConnectionsForAgent,
  openChannelConversation,
  updateConnectionAgent,
  upsertTelegramConnection,
  type Agent,
  type AgentConnection,
} from '../../db/conversations.repo';

export interface TelegramCredentials {
  botToken: string;
  webhookSecret: string;
}

export function credentials(connection: AgentConnection): TelegramCredentials {
  return JSON.parse(openSecret(connection.credentials)) as TelegramCredentials;
}

export function webhookUrl(connectionId: string): string {
  return `${env.publicUrl}/webhooks/telegram/${connectionId}`;
}

/**
 * The bot-token shape BotFather sends: "<digits>:<30+ of [A-Za-z0-9_-]>".
 * Trimmed first — tokens copied from the BotFather message often carry
 * whitespace, and a malformed token 404s at Telegram confusingly. Shared by
 * the legacy per-agent connect and the standalone /v1/connections/telegram.
 */
export const telegramBotTokenSchema = z
  .string()
  .trim()
  .regex(
    /^\d+:[A-Za-z0-9_-]{30,}$/,
    'not a bot token — expected the "<digits>:<letters/digits>" string BotFather sent',
  );

/**
 * Register (or re-register) the webhook with Telegram. Separate step so a
 * changed PUBLIC_URL (tunnel restarts, domain moves) is one reconnect away.
 */
export async function registerWebhook(connection: AgentConnection): Promise<string> {
  const creds = credentials(connection);
  const url = webhookUrl(connection.id);
  await telegram.setWebhook(creds.botToken, url, creds.webhookSecret);
  return url;
}

/**
 * The core telegram connect flow, shared by the legacy per-agent route and
 * the standalone /v1/connections/telegram route. Validates the token against
 * Telegram, seals credentials, upserts the connection (re-pointing its live
 * threads onto the current agent when the identity-upsert hit an existing
 * row), then registers the webhook. Status codes are the historical ones so
 * the legacy shim stays byte-identical: 201 ok, 422 token rejected, 502
 * saved-but-webhook-failed. The sealed token never leaves this function.
 */
export async function handleTelegramConnect(
  reply: FastifyReply,
  tenantId: string,
  agent: Agent,
  botToken: string,
): Promise<FastifyReply> {
  let bot;
  try {
    bot = await telegram.getMe(botToken);
  } catch (err) {
    return reply.code(422).send({ error: `telegram rejected the token: ${(err as Error).message}` });
  }

  const connection = await upsertTelegramConnection({
    tenantId,
    agentId: agent.id,
    sealedCredentials: sealSecret(
      JSON.stringify({
        botToken,
        // Telegram echoes this on every push; 1-256 chars of [A-Za-z0-9_-].
        webhookSecret: randomBytes(24).toString('hex'),
      } satisfies TelegramCredentials),
    ),
    config: { botId: bot.id, botUsername: bot.username },
  });

  // Re-connecting an existing bot (identity-upsert hit a live row) may be
  // re-pointing it at a different agent: move its live channel threads onto
  // the current agent. Idempotent — an unchanged agent moves zero rows.
  if (connection.refreshed) {
    await updateConnectionAgent(tenantId, connection.id, agent.id);
  }

  try {
    const url = await registerWebhook(connection);
    return reply.code(201).send({
      channel: 'telegram',
      botUsername: bot.username,
      webhookUrl: url,
    });
  } catch (err) {
    // Connection saved, webhook not live (e.g. PUBLIC_URL not reachable by
    // Telegram). Surface it — reconnect retries the registration.
    return reply.code(502).send({
      error: `token accepted but webhook registration failed: ${(err as Error).message}`,
      channel: 'telegram',
      botUsername: bot.username,
    });
  }
}

/**
 * One connection's channel-listing row: its config plus the live webhook
 * state. Telegram rows call getWebhookInfo (the truth lives at Telegram);
 * email rows rebuild the static inbound URL the user pasted into the
 * provider. Extracted so the legacy GET /channels and the new GET
 * /v1/connections assemble identical rows. Never surfaces the sealed token.
 */
export async function connectionWebhookState(c: AgentConnection): Promise<{
  channel: string;
  status: string;
  config: Record<string, unknown>;
  webhook: unknown;
  createdAt: string;
}> {
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
  } else if (c.channel === 'email') {
    // Unlike telegram (we register the webhook), the USER pastes this URL
    // into their provider — so it stays retrievable here. It is our minted
    // inbound credential, tenant-admin scoped.
    webhook = { url: emailWebhookUrl(c.id, c.credentials) };
  } else if (c.channel === 'slack') {
    // Like email: the USER pastes these into the Slack app config, so they
    // stay statically rebuildable here (no secret in them — routing is by id).
    webhook = slackWebhookUrls(c.id);
  }
  return { channel: c.channel, status: c.status, config: c.config, webhook, createdAt: c.created_at };
}

export function registerTelegramRoutes(app: FastifyInstance) {
  // ---- channel management ----

  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/channels/telegram',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = z.object({ botToken: telegramBotTokenSchema }).safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      // Legacy shim: same core flow as POST /v1/connections/telegram, agent
      // resolved from the path instead of the body.
      return handleTelegramConnect(reply, req.tenant.id, agent, parsed.data.botToken);
    },
  );

  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/channels/telegram/reconnect',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const telegrams = (await listConnectionsForAgent(agent.id)).filter(
        (c) => c.channel === 'telegram' && c.status === 'active',
      );
      // Post-split an agent can carry more than one telegram identity; a
      // path-scoped reconnect can't say which — steer to the id-scoped route.
      if (telegrams.length > 1) {
        return reply.code(409).send({
          error: 'multiple telegram connections — use /v1/connections/:id/reconnect',
          connections: telegrams.map((c) => ({
            id: c.id,
            botUsername: (c.config as { botUsername?: string } | null)?.botUsername ?? null,
          })),
        });
      }
      const connection = telegrams[0];
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
        out.push(await connectionWebhookState(c));
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

      // Inline-keyboard clicks arrive as callback_query, not message.
      if (update?.callback_query) {
        return handleCallback(connection, update.callback_query);
      }

      // A user editing a message they already sent arrives as edited_message.
      if (update?.edited_message) {
        return handleEditedMessage(connection, update.edited_message);
      }

      const message = update?.message;
      // Ack everything we don't handle — a 200 is how Telegram stops
      // re-delivering; non-text/bot/group updates are simply not for us (v1).
      if (
        typeof update?.update_id !== 'number' ||
        !message?.text ||
        !message.from ||
        message.from.is_bot ||
        message.chat.type !== 'private'
      ) {
        return { ok: true, skipped: true };
      }
      const agent = await resolveAgentForInbound(connection);
      if (!agent) return { ok: true, skipped: true };

      // A deep-link tap arrives as `/start <token>` — the linking handshake,
      // not a conversation turn. Bare /start (or non-token payloads) falls
      // through to the brain like any other text.
      const startMatch = /^\/start\s+([A-Za-z0-9_-]{20,64})$/.exec(message.text.trim());
      if (startMatch) {
        return handleLinkStart(connection, message.chat.id, message.from.id, startMatch[1]);
      }

      const subscriber = await resolveTelegramSubscriber(connection.tenant_id, message.from.id);
      const conversation = await openChannelConversation({
        tenantId: connection.tenant_id,
        connectionId: connection.id,
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

/**
 * Who is this telegram user? Mapping hit → the customer's REAL subscriber
 * (linked via deep link); miss → the channel-local `tg-<id>` row, exactly
 * as before linking existed. One unique-index lookup on the hot path.
 */
async function resolveTelegramSubscriber(tenantId: string, telegramUserId: number) {
  const linked = await resolveChannelIdentity(tenantId, 'telegram', String(telegramUserId));
  if (linked) return linked;
  return upsertSubscriber(tenantId, { subscriberId: `tg-${telegramUserId}` });
}

/**
 * The `/start <token>` handshake: consume the single-use token, write the
 * identity mapping, and repoint this chat's existing conversations so the
 * history follows the person. Idempotency IS the token — a redelivered
 * update or re-tapped link consumes nothing and (if already linked) stays
 * silent instead of spamming the chat.
 */
async function handleLinkStart(
  connection: AgentConnection,
  chatId: number,
  fromId: number,
  token: string,
): Promise<unknown> {
  const botToken = credentials(connection).botToken;
  const externalKey = String(fromId);
  const consumed = await consumeLinkToken(hashLinkToken(token), connection.tenant_id);

  if (!consumed) {
    const already = await resolveChannelIdentity(connection.tenant_id, 'telegram', externalKey);
    if (!already) {
      await telegram
        .sendMessage(botToken, chatId, 'That link is invalid or has expired — please generate a fresh one and try again.')
        .catch((err) => logger.warn({ err: (err as Error).message }, 'link-failure notice failed'));
    }
    return { ok: true, linked: false };
  }

  const subscriber = await getSubscriberById(consumed.subscriber_id);
  if (!subscriber) return { ok: true, linked: false }; // deleted since minting

  await upsertChannelIdentity({
    tenantId: connection.tenant_id,
    channel: 'telegram',
    externalKey,
    subscriberId: subscriber.id,
  });
  const repointed = await repointConversations(
    connection.tenant_id,
    'telegram',
    String(chatId),
    subscriber.id,
  );

  await telegram
    .sendMessage(
      botToken,
      chatId,
      `Linked! This chat is now connected to your account (${subscriber.external_id}).`,
    )
    .catch((err) => logger.warn({ err: (err as Error).message }, 'link confirmation failed'));

  logExec({
    tenantId: connection.tenant_id,
    transactionId: `link-${consumed.id}`,
    level: 'info',
    detail: `telegram identity ${externalKey} linked to subscriber ${subscriber.external_id} (${repointed} conversations repointed)`,
  });

  return { ok: true, linked: true };
}

/**
 * A button press from a Telegram inline keyboard → the same action pipeline
 * widget clicks use. Dedupe key = Telegram's callback id (redeliveries and
 * double-taps collapse); the label is recovered from the reply row the
 * keyboard was attached to (callback_data carries only our button id).
 */
async function handleCallback(
  connection: AgentConnection,
  callback: NonNullable<TelegramUpdate['callback_query']>,
): Promise<unknown> {
  if (!callback.data || !callback.message || callback.from.is_bot) {
    return { ok: true, skipped: true };
  }
  const agent = await resolveAgentForInbound(connection);
  if (!agent) return { ok: true, skipped: true };

  // Clear the client-side spinner regardless of what happens next.
  await telegram
    .answerCallbackQuery(credentials(connection).botToken, callback.id)
    .catch((err) => logger.warn({ err: (err as Error).message }, 'answerCallbackQuery failed'));

  const subscriber = await resolveTelegramSubscriber(connection.tenant_id, callback.from.id);
  const conversation = await openChannelConversation({
    tenantId: connection.tenant_id,
    connectionId: connection.id,
    agentId: agent.id,
    subscriberId: subscriber.id,
    channel: 'telegram',
    threadKey: String(callback.message.chat.id),
  });

  // Recover the human-readable label from the buttons we sent.
  const sourceRow = await findMessageByTelegramId(conversation.id, callback.message.message_id);
  const buttons = (sourceRow?.raw as { buttons?: Array<{ id: string; label: string }> } | null)
    ?.buttons;
  const label = buttons?.find((b) => b.id === callback.data)?.label ?? callback.data;

  const row = await insertConversationMessage({
    conversationId: conversation.id,
    tenantId: connection.tenant_id,
    role: 'user',
    content: label,
    dedupeKey: `tgcb-${callback.id}`,
    raw: { action: { id: callback.data } },
  });
  if (!row) return { ok: true, duplicate: true };

  // Retire the keyboard, telegram-style: no disabled-button state exists,
  // so rewrite the message with the choice appended — editMessageText
  // without reply_markup is what drops the buttons. First ingest only
  // (dedupe returned above), best-effort (48h-old messages reject edits).
  const originalText = callback.message.text ?? sourceRow?.content;
  if (originalText) {
    await telegram
      .editMessageText(
        credentials(connection).botToken,
        callback.message.chat.id,
        callback.message.message_id,
        `${originalText}\n\n✓ ${label}`,
      )
      .catch((err) => logger.warn({ err: (err as Error).message }, 'telegram keyboard retire failed'));
  }

  await getQueue(QUEUE.CONVERSATION).add(
    row.id,
    { tenantId: connection.tenant_id, conversationId: conversation.id, messageId: row.id },
    { jobId: `conv-${row.id}`, attempts: 5 },
  );

  logExec({
    tenantId: connection.tenant_id,
    transactionId: `conv-${conversation.id}`,
    level: 'info',
    detail: `telegram action accepted: agent=${agent.identifier} action=${callback.data}`,
  });

  return { ok: true };
}

/**
 * A user edited a message they already sent (telegram re-pushes it as
 * edited_message). We update the stored row IN PLACE so the transcript stays
 * honest — but an edit is NOT a new turn: no WS publish, no enqueue, no brain
 * re-dispatch. Guards mirror the message branch exactly; every skip acks so
 * Telegram stops re-delivering.
 */
async function handleEditedMessage(
  connection: AgentConnection,
  edited: NonNullable<TelegramUpdate['edited_message']>,
): Promise<unknown> {
  if (
    !edited.text ||
    !edited.from ||
    edited.from.is_bot ||
    edited.chat.type !== 'private'
  ) {
    return { ok: true, skipped: true };
  }
  const agent = await resolveAgentForInbound(connection);
  if (!agent) return { ok: true, skipped: true };

  await resolveTelegramSubscriber(connection.tenant_id, edited.from.id);
  // An edit must never CREATE a conversation — find-not-create by the
  // connection's thread. No thread yet means there is nothing to edit.
  const conversation = await findConversationByConnectionThread(
    connection.id,
    String(edited.chat.id),
  );
  if (!conversation) return { ok: true, skipped: true };

  // Only the user's own live rows are editable; agent/system rows and
  // tombstones are left untouched.
  const row = await findMessageByTelegramId(conversation.id, edited.message_id);
  if (!row || row.role !== 'user' || row.deleted_at) return { ok: true, skipped: true };

  await editConversationMessage(row.id, connection.tenant_id, edited.text);
  return { ok: true, edited: true };
}
