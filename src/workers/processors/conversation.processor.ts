import type { Job } from 'bullmq';
import { z } from 'zod';
import { logger } from '../../shared/logger';
import { redis } from '../../shared/redis';
import { PRIORITIES } from '../../shared/queues';
import { logExec } from '../../core/execution-log';
import { internalTrigger } from '../../core/internal-trigger';
import { signWebhook } from '../../api/webhook-signature';
import { openSecret } from '../../auth/secret-box';
import { inAppPubSubChannel } from '../../providers/inapp';
import {
  conversationHistoryBefore,
  getAgentById,
  getConversation,
  getConversationMessage,
  getSubscriberById,
  insertConversationMessage,
  resolveConversation,
  updateConversationMetadata,
  type Agent,
  type Conversation,
} from '../../db/conversations.repo';

export interface ConversationJobData {
  tenantId: string;
  conversationId: string;
  /** conversation_messages.id of the inbound user turn to dispatch. */
  messageId: string;
}

const BRIDGE_TIMEOUT_MS = 10_000;
const METADATA_MAX_BYTES = 64 * 1024;

/** What a bridge may send back — one reply plus batched signals. */
const BridgeResponseSchema = z.object({
  reply: z.string().max(64 * 1024).optional(),
  signals: z
    .array(
      z.discriminatedUnion('type', [
        z.object({ type: z.literal('metadata.set'), key: z.string().min(1).max(255), value: z.unknown() }),
        z.object({
          type: z.literal('trigger'),
          workflowKey: z.string().min(1).max(255),
          payload: z.record(z.unknown()).optional(),
          priority: z.enum(PRIORITIES).optional(),
        }),
        z.object({ type: z.literal('resolve'), summary: z.string().max(4096).optional() }),
      ]),
    )
    .max(20)
    .default([]),
});

/**
 * The two-way hop: take one inbound user turn, POST the normalized event to
 * the agent's bridge URL (HMAC-signed), then apply what comes back — insert
 * the reply row + push it live over the subscriber's existing WS channel,
 * and run the signals in order (metadata merge, workflow trigger, resolve).
 *
 * Every side effect is deduped (reply/dedupe_key, trigger/transactionId,
 * metadata + resolve idempotent), so BullMQ retries after a mid-flight crash
 * are safe — the same doctrine as the delivery pipeline.
 */
export async function processConversation(job: Job<ConversationJobData>): Promise<void> {
  const { tenantId, conversationId, messageId } = job.data;

  const conversation = await getConversation(tenantId, conversationId);
  if (!conversation) return; // deleted underneath us — nothing to do
  const [agent, message, subscriber] = await Promise.all([
    getAgentById(conversation.agent_id),
    getConversationMessage(messageId),
    getSubscriberById(conversation.subscriber_id),
  ]);
  if (!agent || !message || !subscriber) return;
  if (agent.status !== 'active') {
    logger.info({ agent: agent.identifier }, 'agent disabled, skipping dispatch');
    return;
  }

  const history = await conversationHistoryBefore(conversationId, messageId);
  const rawBody = JSON.stringify({
    type: 'message',
    agent: { identifier: agent.identifier, name: agent.name },
    conversation: {
      id: conversation.id,
      channel: conversation.channel,
      status: conversation.status,
      metadata: conversation.metadata,
      messageCount: conversation.message_count,
    },
    subscriber: {
      subscriberId: subscriber.external_id,
      email: subscriber.email,
      phone: subscriber.phone,
    },
    message: { id: message.id, text: message.content, createdAt: message.created_at },
    // Pre-shaped for LLM SDKs: user turns + the agent's own prior replies.
    history: history.map((m) => ({
      role: m.role === 'agent' ? ('assistant' as const) : ('user' as const),
      content: m.content,
    })),
  });

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signWebhook(openSecret(agent.signing_secret), timestamp, rawBody);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(agent.bridge_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-asyncify-timestamp': timestamp,
        'x-asyncify-signature': signature,
      },
      body: rawBody,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw new Error(`bridge responded ${response.status} for agent ${agent.identifier}`);
  }
  const parsed = BridgeResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new Error(`bridge returned an invalid response for agent ${agent.identifier}`);
  }
  const { reply, signals } = parsed.data;

  if (reply !== undefined && reply.length > 0) {
    const replyRow = await insertConversationMessage({
      conversationId,
      tenantId,
      role: 'agent',
      content: reply,
      dedupeKey: `reply-${messageId}`,
    });
    if (replyRow) {
      await publishConversationEvent(conversation, subscriber.external_id, agent, {
        type: 'conversation.message',
        message: {
          id: replyRow.id,
          role: 'agent',
          text: reply,
          createdAt: replyRow.created_at,
        },
      });
    }
  }

  let signalIndex = 0;
  for (const signal of signals) {
    signalIndex += 1;
    if (signal.type === 'metadata.set') {
      const merged = { ...conversation.metadata, [signal.key]: signal.value };
      if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > METADATA_MAX_BYTES) {
        await systemNote(conversation, messageId, signalIndex, `metadata.set "${signal.key}" rejected: over the 64KB cap`);
        continue;
      }
      conversation.metadata = merged;
      await updateConversationMetadata(conversationId, merged);
    } else if (signal.type === 'trigger') {
      const result = await internalTrigger({
        tenantId,
        workflowKey: signal.workflowKey,
        to: [
          {
            subscriberId: subscriber.external_id,
            email: subscriber.email ?? undefined,
            phone: subscriber.phone ?? undefined,
            pushToken: subscriber.push_token ?? undefined,
          },
        ],
        payload: signal.payload,
        priority: signal.priority,
        // Deterministic per turn+signal: a retried job re-fires as a dupe no-op.
        transactionId: `conv-${messageId}-${signalIndex}`,
        source: `agent ${agent.identifier}`,
      });
      await systemNote(
        conversation,
        messageId,
        signalIndex,
        result.ok
          ? `triggered workflow ${signal.workflowKey} (txn conv-${messageId}-${signalIndex})`
          : `trigger of ${signal.workflowKey} failed: ${result.error}`,
      );
    } else if (signal.type === 'resolve') {
      await resolveConversation(conversationId, signal.summary);
      await systemNote(conversation, messageId, signalIndex, `conversation resolved${signal.summary ? `: ${signal.summary}` : ''}`);
      await publishConversationEvent(conversation, subscriber.external_id, agent, {
        type: 'conversation.resolved',
      });
    }
  }

  logExec({
    tenantId,
    transactionId: `conv-${conversationId}`,
    level: 'info',
    detail:
      `agent ${agent.identifier} handled turn: reply=${reply !== undefined && reply.length > 0} ` +
      `signals=${signals.map((s) => s.type).join(',') || 'none'}`,
  });
}

/** Transcript breadcrumb for a signal — deduped so retries can't repeat it. */
async function systemNote(
  conversation: Conversation,
  messageId: string,
  signalIndex: number,
  content: string,
): Promise<void> {
  await insertConversationMessage({
    conversationId: conversation.id,
    tenantId: conversation.tenant_id,
    role: 'system',
    content,
    dedupeKey: `signal-${messageId}-${signalIndex}`,
  });
}

/** Live push over the same per-subscriber channel the inbox already uses. */
async function publishConversationEvent(
  conversation: Conversation,
  subscriberExternalId: string,
  agent: Agent,
  event: Record<string, unknown>,
): Promise<void> {
  await redis.publish(
    inAppPubSubChannel(conversation.tenant_id, subscriberExternalId),
    JSON.stringify({
      ...event,
      conversation: {
        id: conversation.id,
        agentIdentifier: agent.identifier,
        agentName: agent.name,
      },
    }),
  );
}

/** DLQ hook: retries exhausted — leave the failure visible in the transcript. */
export async function onConversationDead(job: Job): Promise<void> {
  const data = job.data as Partial<ConversationJobData>;
  if (!data.tenantId || !data.conversationId || !data.messageId) return;
  await insertConversationMessage({
    conversationId: data.conversationId,
    tenantId: data.tenantId,
    role: 'system',
    content: 'agent unreachable — this message was not answered',
    dedupeKey: `dead-${data.messageId}`,
  }).catch((err) => logger.warn({ err }, 'failed to record dead conversation turn'));
}
