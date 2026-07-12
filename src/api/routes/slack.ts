import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { env } from '../../config/env';
import { logger } from '../../shared/logger';
import { logExec } from '../../core/execution-log';
import { getQueue, QUEUE } from '../../shared/queues';
import { sealSecret, openSecret } from '../../auth/secret-box';
import {
  slack,
  verifySlackSignature,
  type SlackEventEnvelope,
  type SlackMessageEvent,
} from '../../channels/slack';
import type { Card } from '../../shared/cards';
import { upsertSubscriber, type Subscriber } from '../../db/repositories';
import {
  findSubscriberByEmail,
  resolveChannelIdentity,
  upsertChannelIdentity,
} from '../../db/identities.repo';
import { resolveAgentForInbound } from '../../core/inbound-routing';
import {
  editConversationMessage,
  findConversationByConnectionThread,
  findMessageBySlackTs,
  getAgentById,
  getConnectionById,
  insertConversationMessage,
  openChannelConversation,
  softDeleteConversationMessage,
  updateConnectionAgent,
  upsertSlackConnection,
  type Agent,
  type AgentConnection,
  type Conversation,
} from '../../db/conversations.repo';

/**
 * The bot token shape Slack issues: "xoxb-" then an unbroken run of
 * [A-Za-z0-9-]. Trimmed first — tokens pasted from the Slack app config often
 * carry whitespace. Shared by the standalone connect route (a later slice).
 */
export const slackBotTokenSchema = z
  .string()
  .trim()
  .regex(/^xoxb-[A-Za-z0-9-]{20,}$/, 'that does not look like a bot token (xoxb-...)');

export const slackSigningSecretSchema = z
  .string()
  .trim()
  .min(16, 'that does not look like a signing secret');

export interface SlackCredentials {
  botToken: string;
  signingSecret: string;
}

export function credentials(connection: AgentConnection): SlackCredentials {
  return JSON.parse(openSecret(connection.credentials)) as SlackCredentials;
}

/**
 * The two URLs a Slack app must be pointed at. Unlike telegram (we register
 * the webhook), the USER pastes these into the Slack app config — so they are
 * static and rebuildable here (email-shaped). connectionId is the routing key.
 */
export function slackWebhookUrls(connectionId: string): {
  eventsUrl: string;
  interactivityUrl: string;
} {
  return {
    eventsUrl: `${env.publicUrl}/webhooks/slack/${connectionId}/events`,
    interactivityUrl: `${env.publicUrl}/webhooks/slack/${connectionId}/interactivity`,
  };
}

/**
 * The core slack connect flow, shared by the (later) standalone connect route.
 * Validates the token against Slack, seals credentials, upserts the connection
 * keyed by the workspace team id (re-pointing its live threads onto the current
 * agent when the identity-upsert hit an existing row), then returns the URLs
 * the user pastes into the Slack app. Email-shaped: no webhook registration, so
 * no 502 branch — 201 ok, 422 token rejected. The sealed token never leaves
 * this function.
 */
export async function handleSlackConnect(
  reply: FastifyReply,
  tenantId: string,
  agent: Agent,
  botToken: string,
  signingSecret: string,
): Promise<FastifyReply> {
  let r;
  try {
    r = await slack.authTest(botToken);
  } catch (err) {
    return reply.code(422).send({ error: `slack rejected the token: ${(err as Error).message}` });
  }

  const connection = await upsertSlackConnection({
    tenantId,
    agentId: agent.id,
    sealedCredentials: sealSecret(
      JSON.stringify({ botToken, signingSecret } satisfies SlackCredentials),
    ),
    config: { teamId: r.team_id, teamName: r.team, botUserId: r.user_id },
  });

  // Re-connecting the same workspace (identity-upsert hit a live row) may be
  // re-pointing it at a different default agent: move its live threads onto
  // the current agent. Idempotent — an unchanged agent moves zero rows.
  if (connection.refreshed) {
    await updateConnectionAgent(tenantId, connection.id, agent.id);
  }

  reply.code(201);
  return reply.send({ channel: 'slack', teamName: r.team, ...slackWebhookUrls(connection.id) });
}

/**
 * A Slack interactive payload (button click). Slack POSTs it form-urlencoded
 * with a single `payload` field carrying this JSON. Only block_actions is
 * handled; every field is optional so a malformed/other-type payload is
 * skip-acked rather than trusted.
 */
interface SlackInteractivityPayload {
  type?: string;
  user?: { id?: string };
  channel?: { id?: string };
  message?: { ts?: string; text?: string; thread_ts?: string };
  actions?: Array<{
    action_id: string;
    action_ts: string;
    /** 'button' | 'static_select' | 'plain_text_input' (absent on legacy buttons). */
    type?: string;
    /** A button's own label. */
    text?: { text?: string };
    /** A plain_text_input's typed value. */
    value?: string;
    /** A static_select's chosen option. */
    selected_option?: { value?: string; text?: { text?: string } };
  }>;
}

export function registerSlackRoutes(app: FastifyInstance) {
  // ---- inbound: Slack POSTs every event here (prod AND local dev via tunnel) ----

  app.post<{ Params: { connectionId: string } }>(
    '/webhooks/slack/:connectionId/events',
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.connectionId).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnectionById(req.params.connectionId);
      if (!connection || connection.channel !== 'slack') {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const creds = credentials(connection);

      const verified = verifySlackSignature(
        creds.signingSecret,
        String(req.headers['x-slack-request-timestamp'] ?? ''),
        String(req.headers['x-slack-signature'] ?? ''),
        req.rawBody ?? '',
      );
      if (!verified.ok) {
        return reply.code(401).send({ error: 'bad signature', reason: verified.reason });
      }

      const body = req.body as SlackEventEnvelope;

      // Slack's endpoint-ownership handshake — echo the challenge back.
      if (body.type === 'url_verification') {
        return { challenge: body.challenge };
      }
      // Only event_callback carries an inbound event; ack anything else.
      if (body.type !== 'event_callback' || !body.event) {
        return { ok: true, skipped: true };
      }

      const event = body.event;
      const config = connection.config as { botUserId?: string };

      // app_mention is a duplicate envelope of the same message.channels event
      // we ingest below — skip it so a mention isn't counted twice.
      if (event.type === 'app_mention') {
        return { ok: true, skipped: true };
      }
      if (event.type !== 'message') {
        return { ok: true, skipped: true };
      }

      // Bot-echo guard FIRST, before any DB work: our own posts (and any bot)
      // come back as events. This is the infinite-loop breaker.
      if (
        event.bot_id ||
        event.message?.bot_id ||
        (event.user && event.user === config.botUserId)
      ) {
        return { ok: true, skipped: true };
      }

      // Edits/deletes arrive as message subtypes; handle in place (no re-dispatch).
      if (event.subtype === 'message_changed') return handleMessageChanged(connection, event);
      if (event.subtype === 'message_deleted') return handleMessageDeleted(connection, event);
      // Any other subtype (channel_join, file_share, …) is not a turn for us.
      if (event.subtype) return { ok: true, skipped: true };

      if (!event.text || !event.user) return { ok: true, skipped: true };

      // ---- DM: the connection's DEFAULT agent answers (never the scope table) ----
      if (event.channel_type === 'im') {
        const agent = await resolveAgentForInbound(connection);
        if (!agent) return { ok: true, skipped: true };

        const subscriber = await resolveSlackSubscriber(
          connection.tenant_id,
          event.user,
          creds.botToken,
        );
        const conversation = await openChannelConversation({
          tenantId: connection.tenant_id,
          connectionId: connection.id,
          agentId: agent.id,
          subscriberId: subscriber.id,
          channel: 'slack',
          threadKey: event.channel,
        });
        return ingestSlackTurn(connection, agent, conversation, event, event.text);
      }

      // ---- channel / group: mention starts a thread, replies follow it ----
      if (event.channel_type === 'channel' || event.channel_type === 'group') {
        const mentioned = event.text.includes('<@' + config.botUserId + '>');
        const threadTs = event.thread_ts ?? event.ts;
        const threadKey = `${event.channel}:${threadTs}`;

        let agent: Agent | null;
        let conversation: Conversation;
        if (!mentioned) {
          // Not addressed to us — only continue if it's a reply on a thread we
          // already own (thread-following), using that thread's agent.
          const existing = await findConversationByConnectionThread(connection.id, threadKey);
          if (!existing) return { ok: true, skipped: true };
          agent = await getAgentById(existing.agent_id);
          if (!agent || agent.status !== 'active') return { ok: true, skipped: true };
          conversation = existing;
        } else {
          // Addressed to us — SCOPE routing: this channel id may map to a
          // specific agent, else the connection default.
          agent = await resolveAgentForInbound(connection, event.channel);
          if (!agent) return { ok: true, skipped: true };
          const subscriber = await resolveSlackSubscriber(
            connection.tenant_id,
            event.user,
            creds.botToken,
          );
          conversation = await openChannelConversation({
            tenantId: connection.tenant_id,
            connectionId: connection.id,
            agentId: agent.id,
            subscriberId: subscriber.id,
            channel: 'slack',
            threadKey,
          });
        }

        // Strip the leading bot mention so the agent sees the bare request.
        const stripped = event.text.replace(/^\s*<@U[A-Z0-9]+>\s*/, '');
        const content = stripped || event.text;
        return ingestSlackTurn(connection, agent, conversation, event, content);
      }

      // mpim / anything else: not handled in this slice.
      return { ok: true, skipped: true };
    },
  );

  // ---- inbound: Slack POSTs interactive component events (button clicks) here ----
  // Everything runs inline — well under Slack's 3s interactivity ack budget.
  app.post<{ Params: { connectionId: string } }>(
    '/webhooks/slack/:connectionId/interactivity',
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.connectionId).success) {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const connection = await getConnectionById(req.params.connectionId);
      if (!connection || connection.channel !== 'slack') {
        return reply.code(404).send({ error: 'unknown connection' });
      }
      const creds = credentials(connection);

      const verified = verifySlackSignature(
        creds.signingSecret,
        String(req.headers['x-slack-request-timestamp'] ?? ''),
        String(req.headers['x-slack-signature'] ?? ''),
        req.rawBody ?? '',
      );
      if (!verified.ok) {
        return reply.code(401).send({ error: 'bad signature', reason: verified.reason });
      }

      // Slack wraps the interaction JSON in a single form field `payload`.
      let payload: SlackInteractivityPayload;
      try {
        payload = JSON.parse((req.body as { payload?: string }).payload ?? '');
      } catch {
        return { ok: true, skipped: true };
      }

      const action = payload.actions?.[0];
      if (
        payload.type !== 'block_actions' ||
        !action ||
        !payload.user?.id ||
        !payload.channel?.id ||
        !payload.message?.ts
      ) {
        return { ok: true, skipped: true };
      }

      // Channel/group ids (C…/G…) are routable scopes; a DM (D…) never is.
      const scope =
        payload.channel.id.startsWith('C') || payload.channel.id.startsWith('G')
          ? payload.channel.id
          : undefined;
      const agent = await resolveAgentForInbound(connection, scope);
      if (!agent) return { ok: true, skipped: true };

      const threadKey = payload.channel.id.startsWith('D')
        ? payload.channel.id
        : `${payload.channel.id}:${payload.message.thread_ts ?? payload.message.ts}`;

      const subscriber = await resolveSlackSubscriber(
        connection.tenant_id,
        payload.user.id,
        creds.botToken,
      );
      const conversation = await openChannelConversation({
        tenantId: connection.tenant_id,
        connectionId: connection.id,
        agentId: agent.id,
        subscriberId: subscriber.id,
        channel: 'slack',
        threadKey,
      });

      // Shape content + action by the interaction type. A static_select carries
      // the chosen option; a plain_text_input carries typed text; a button (or
      // no type) is byte-identical to the pre-card path. The card id (when the
      // source row carried one) keys the action, else the bare action_id.
      const sourceRow = await findMessageBySlackTs(conversation.id, payload.message.ts);
      const sourceCard = (sourceRow?.raw as { card?: Card } | null)?.card;
      let content: string;
      let storedAction: { id: string; value?: string; kind?: string };
      if (action.type === 'static_select') {
        const optionLabel = action.selected_option?.text?.text ?? '';
        const value = action.selected_option?.value;
        content = optionLabel || value || '';
        storedAction = { id: sourceCard?.id ?? action.action_id, value, kind: 'select' };
      } else if (action.type === 'plain_text_input') {
        const value = action.value;
        // An empty submission is not an answer — ack without a turn.
        if (!value) return { ok: true, skipped: true };
        content = value;
        storedAction = { id: sourceCard?.id ?? action.action_id, value, kind: 'input' };
      } else {
        const buttons = (
          sourceRow?.raw as { buttons?: Array<{ id: string; label: string }> } | null
        )?.buttons;
        content =
          action.text?.text ??
          buttons?.find((b) => b.id === action.action_id)?.label ??
          action.action_id;
        storedAction = { id: action.action_id };
      }

      const row = await insertConversationMessage({
        conversationId: conversation.id,
        tenantId: connection.tenant_id,
        role: 'user',
        content,
        // Slack re-delivers until acked; the action_ts is the natural wall.
        dedupeKey: `slackcb-${action.action_ts}`,
        raw: { action: storedAction },
      });
      // A duplicate click: already ingested — ack without retiring again.
      if (!row) return { ok: true, duplicate: true };

      // Retire the widget best-effort: rewrite the source message with the
      // response appended (omitting blocks strips the widget). Never fails the ack.
      const text = sourceRow?.content ?? payload.message.text ?? '';
      try {
        await slack.update(
          creds.botToken,
          payload.channel.id,
          payload.message.ts,
          `${text}\n\n✓ ${content}`,
        );
      } catch (err) {
        logger.warn({ err: (err as Error).message }, 'slack update failed retiring widget');
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
        detail: `slack action accepted: agent=${agent.identifier} action=${action.action_id} subscriber=slack-${payload.user.id}`,
      });

      return { ok: true };
    },
  );
}

/**
 * Insert the inbound turn and enqueue it for the brain. Shared by the DM and
 * channel paths — same dedupe wall (the Slack ts within the channel) and same
 * raw crumbs (ts + channel for edit/delete lookups, sender for display).
 */
async function ingestSlackTurn(
  connection: AgentConnection,
  agent: Agent,
  conversation: Conversation,
  event: SlackMessageEvent,
  content: string,
): Promise<unknown> {
  const row = await insertConversationMessage({
    conversationId: conversation.id,
    tenantId: connection.tenant_id,
    role: 'user',
    content,
    // Slack re-delivers until acked; (channel, ts) is the natural wall.
    dedupeKey: `slack-${event.channel}-${event.ts}`,
    raw: { slackTs: event.ts, slackChannel: event.channel, from: event.user },
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
    detail: `slack turn accepted: agent=${agent.identifier} channel=${event.channel} subscriber=slack-${event.user}`,
  });

  return { ok: true };
}

/**
 * A user edited a message they already sent — Slack re-pushes it as a
 * message_changed subtype whose nested `event.message` carries the edited text
 * and the ORIGINAL ts. We update the stored row IN PLACE so the transcript
 * stays honest, but an edit is NOT a new turn: no enqueue, no re-dispatch.
 * Every skip acks so Slack stops re-delivering.
 */
async function handleMessageChanged(
  connection: AgentConnection,
  event: SlackMessageEvent,
): Promise<unknown> {
  if (event.message?.bot_id || !event.message?.text) return { ok: true, skipped: true };

  const threadKey =
    event.channel_type === 'im'
      ? event.channel
      : `${event.channel}:${event.message.thread_ts ?? event.message.ts}`;
  const conversation = await findConversationByConnectionThread(connection.id, threadKey);
  if (!conversation) return { ok: true, skipped: true };

  const row = await findMessageBySlackTs(conversation.id, event.message.ts);
  if (!row || row.role !== 'user' || row.deleted_at) return { ok: true, skipped: true };

  await editConversationMessage(row.id, connection.tenant_id, event.message.text);
  return { ok: true, edited: true };
}

/**
 * A user deleted a message — Slack pushes a message_deleted subtype naming the
 * removed ts. We tombstone the stored row (same soft-delete as the widget/
 * telegram path). Every skip acks.
 */
async function handleMessageDeleted(
  connection: AgentConnection,
  event: SlackMessageEvent,
): Promise<unknown> {
  if (!event.deleted_ts) return { ok: true, skipped: true };

  const threadTs = event.previous_message?.thread_ts ?? event.deleted_ts;
  const threadKey =
    event.channel_type === 'im' ? event.channel : `${event.channel}:${threadTs}`;
  const conversation = await findConversationByConnectionThread(connection.id, threadKey);
  if (!conversation) return { ok: true, skipped: true };

  const row = await findMessageBySlackTs(conversation.id, event.deleted_ts);
  if (!row || row.role !== 'user' || row.deleted_at) return { ok: true, skipped: true };

  await softDeleteConversationMessage(row.id, connection.tenant_id, 'user');
  return { ok: true, deleted: true };
}

/**
 * Who is this Slack user? Resolution order (mirrors the email precedent):
 *  1. explicit mapping (linked before) → the real subscriber
 *  2. AUTO-MATCH by email: users.info gives the profile email; if it equals an
 *     existing real subscriber, write the mapping now (but do NOT repoint —
 *     a Slack user id is stable, so future turns hit step 1 directly)
 *  3. fallback: the channel-local `slack-<userId>` row
 */
async function resolveSlackSubscriber(
  tenantId: string,
  slackUserId: string,
  botToken: string,
): Promise<Subscriber> {
  const linked = await resolveChannelIdentity(tenantId, 'slack', slackUserId);
  if (linked) return linked;

  const info = await slack.usersInfo(botToken, slackUserId).catch(() => null);
  const email = info?.user.profile?.email;
  if (email) {
    const match = await findSubscriberByEmail(tenantId, email);
    if (match) {
      await upsertChannelIdentity({
        tenantId,
        channel: 'slack',
        externalKey: slackUserId,
        subscriberId: match.id,
      });
      logExec({
        tenantId,
        transactionId: `link-slack-${match.id}`,
        level: 'info',
        detail: `slack ${slackUserId} auto-linked to subscriber ${match.external_id} by email`,
      });
      return match;
    }
  }

  return upsertSubscriber(tenantId, { subscriberId: `slack-${slackUserId}` });
}
