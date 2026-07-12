import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { authenticateSender } from './agents';
import { logger } from '../../shared/logger';
import { openSecret } from '../../auth/secret-box';
import { telegram } from '../../channels/telegram';
import { slack } from '../../channels/slack';
import type { SlackCredentials } from './slack';
import { publishConversationEvent } from '../../core/conversation-events';
import {
  editConversationMessage,
  findConversationByThread,
  getAgent,
  getAgentById,
  getConnectionById,
  getConnectionForConversation,
  getConversation,
  getConversationMessage,
  getSubscriberById,
  softDeleteConversationMessage,
} from '../../db/conversations.repo';

/** Edits older than this can no longer be deleted from a Telegram chat. */
const TELEGRAM_DELETE_WINDOW_MS = 48 * 60 * 60 * 1000;

const EditMessageSchema = z.object({
  subscriberId: z.string().min(1).max(255),
  // Same bounds as the inbound message schema in agents.ts.
  text: z.string().min(1).max(8192),
});

const DeleteMessageQuerySchema = z.object({
  subscriberId: z.string().min(1).max(255),
});

export function registerConversationMessageRoutes(app: FastifyInstance) {
  // ---- end-user edit / delete (widget, subscriber-token friendly) ----

  app.patch<{ Params: { identifier: string; messageId: string } }>(
    '/v1/agents/:identifier/messages/:messageId',
    async (req, reply) => {
      const parsed = EditMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      if (!(await authenticateSender(req, reply, parsed.data.subscriberId))) return;

      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      const conversation = await findConversationByThread(agent.id, 'inapp', parsed.data.subscriberId);
      if (!conversation) return reply.code(404).send({ error: 'unknown conversation' });

      const row = await getConversationMessage(req.params.messageId);
      if (!row || row.conversation_id !== conversation.id) {
        return reply.code(404).send({ error: 'unknown message' });
      }
      if (row.role !== 'user') {
        return reply.code(403).send({ error: 'only your own messages can be edited' });
      }
      if (row.deleted_at) return reply.code(409).send({ error: 'message was deleted' });

      // null = the row was soft-deleted between our read and this write.
      const edited = await editConversationMessage(req.params.messageId, req.tenant.id, parsed.data.text);
      if (!edited) return reply.code(409).send({ error: 'message was deleted' });

      await publishConversationEvent(conversation, parsed.data.subscriberId, agent, {
        type: 'conversation.message.updated',
        message: { id: edited.id, text: edited.content, editedAt: edited.edited_at },
      });
      return { message: { id: edited.id, content: edited.content, editedAt: edited.edited_at } };
    },
  );

  app.delete<{ Params: { identifier: string; messageId: string }; Querystring: { subscriberId?: string } }>(
    '/v1/agents/:identifier/messages/:messageId',
    async (req, reply) => {
      const parsed = DeleteMessageQuerySchema.safeParse(req.query);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid query', details: parsed.error.issues });
      }
      if (!(await authenticateSender(req, reply, parsed.data.subscriberId))) return;

      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      const conversation = await findConversationByThread(agent.id, 'inapp', parsed.data.subscriberId);
      if (!conversation) return reply.code(404).send({ error: 'unknown conversation' });

      const row = await getConversationMessage(req.params.messageId);
      if (!row || row.conversation_id !== conversation.id) {
        return reply.code(404).send({ error: 'unknown message' });
      }
      if (row.role !== 'user') {
        return reply.code(403).send({ error: 'only your own messages can be deleted' });
      }
      // Already a tombstone — delete is idempotent, nothing new to publish.
      if (row.deleted_at) return { deleted: true };

      const deleted = await softDeleteConversationMessage(req.params.messageId, req.tenant.id, 'user');
      if (!deleted) return { deleted: true }; // raced with another delete

      await publishConversationEvent(conversation, parsed.data.subscriberId, agent, {
        type: 'conversation.message.deleted',
        message: { id: deleted.id, deletedAt: deleted.deleted_at, deletedBy: 'user' },
      });
      return { deleted: true };
    },
  );

  // ---- operator delete (dashboard, api-key/JWT) ----

  app.delete<{ Params: { id: string; messageId: string } }>(
    '/v1/conversations/:id/messages/:messageId',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (
        !z.string().uuid().safeParse(req.params.id).success ||
        !z.string().uuid().safeParse(req.params.messageId).success
      ) {
        return reply.code(400).send({ error: 'invalid id' });
      }
      const conversation = await getConversation(req.tenant.id, req.params.id);
      if (!conversation) return reply.code(404).send({ error: 'unknown conversation' });

      const row = await getConversationMessage(req.params.messageId);
      if (!row || row.conversation_id !== conversation.id) {
        return reply.code(404).send({ error: 'unknown message' });
      }
      // System rows are platform audit breadcrumbs, not operator-editable.
      if (row.role === 'system') {
        return reply.code(400).send({ error: 'system rows are platform audit records' });
      }

      const deleted = await softDeleteConversationMessage(req.params.messageId, req.tenant.id, 'operator');
      if (!deleted) return { deleted: true }; // already a tombstone / raced

      if (conversation.channel === 'inapp') {
        const [agent, subscriber] = await Promise.all([
          getAgentById(conversation.agent_id),
          getSubscriberById(conversation.subscriber_id),
        ]);
        if (agent && subscriber) {
          await publishConversationEvent(conversation, subscriber.external_id, agent, {
            type: 'conversation.message.deleted',
            message: { id: deleted.id, deletedAt: deleted.deleted_at, deletedBy: 'operator' },
          });
        }
      } else if (conversation.channel === 'telegram') {
        // Best effort: unreachable bot / expired edit window must never fail
        // the request — the durable tombstone is already written.
        const raw = (deleted.raw ?? {}) as { telegramMessageId?: number };
        const withinWindow =
          Date.now() - new Date(deleted.created_at).getTime() < TELEGRAM_DELETE_WINDOW_MS;
        if (raw.telegramMessageId && withinWindow) {
          try {
            const connection = await getConnectionForConversation(conversation);
            if (connection && connection.status === 'active') {
              const { botToken } = JSON.parse(openSecret(connection.credentials)) as {
                botToken: string;
              };
              await telegram.deleteMessage(botToken, conversation.thread_key, raw.telegramMessageId);
            }
          } catch (err) {
            logger.warn(
              { err: (err as Error).message },
              'telegram deleteMessage failed on operator delete',
            );
          }
        }
      } else if (conversation.channel === 'slack') {
        // Best effort: an unreachable bot must never fail the request — the
        // durable tombstone is already written. No time window (Slack lets a
        // bot delete its own posts indefinitely).
        const raw = (deleted.raw ?? {}) as { slackTs?: string; slackChannel?: string };
        if (raw.slackTs && raw.slackChannel && conversation.connection_id) {
          try {
            const connection = await getConnectionById(conversation.connection_id);
            if (connection && connection.status === 'active') {
              const { botToken } = JSON.parse(openSecret(connection.credentials)) as SlackCredentials;
              await slack.deleteMessage(botToken, raw.slackChannel, raw.slackTs);
            }
          } catch (err) {
            logger.warn(
              { err: (err as Error).message },
              'slack deleteMessage failed on operator delete',
            );
          }
        }
      }

      return { deleted: true };
    },
  );
}
