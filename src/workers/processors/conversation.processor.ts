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
import { telegram } from '../../channels/telegram';
import { sendWithFailover } from '../../providers/registry';
import { isSuppressed } from '../../db/repositories';
import { runManagedTurn, type TurnUsage } from '../../core/managed-brain';
import { PermanentError } from '../../shared/errors';
import { fetch as safeFetch } from 'undici';
import {
  assertSafeOutboundUrl,
  safeDispatcher,
  UnsafeOutboundUrlError,
} from '../../core/safe-url';
import {
  conversationHistoryBefore,
  conversationTranscriptBefore,
  getAgentById,
  getConnectionForAgent,
  getConversation,
  getConversationMessage,
  getConversationMessageByDedupe,
  getSubscriberById,
  insertConversationMessage,
  resolveConversation,
  updateConversationMessageRaw,
  updateConversationMetadata,
  type Agent,
  type Conversation,
  type ConversationMessage,
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
  /** Buttons under the reply; clicks come back as 'action' events. */
  buttons: z
    .array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(48) }))
    .max(6)
    .optional(),
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

  // The brain branch: who answers this turn. Everything after (reply row,
  // channel delivery, signals, breadcrumbs) is identical for both runtimes.
  let reply: string | undefined;
  let buttons: Array<{ id: string; label: string }> | undefined;
  let signals: BridgeSignal[] = [];
  let turnUsage: TurnUsage | undefined;

  if (agent.runtime === 'managed') {
    try {
      // Richer history (incl. tool-action breadcrumbs) — the brain folds
      // them in so past tool-backed replies don't look like bare claims.
      const fullHistory = await conversationTranscriptBefore(conversationId, messageId);
      const turn = await runManagedTurn(agent, conversation, subscriber, fullHistory, message);
      reply = turn.reply ?? undefined;
      buttons = turn.buttons;
      turnUsage = turn.usage;
      // No reply row to carry the usage? The note breadcrumb carries it.
      if (turn.note) {
        await systemNote(conversation, messageId, 0, turn.note, reply ? undefined : { usage: turn.usage });
      }
      if (turn.resolved && conversation.channel === 'inapp') {
        await publishConversationEvent(conversation, subscriber.external_id, agent, {
          type: 'conversation.resolved',
        });
      }
    } catch (err) {
      if (err instanceof PermanentError) {
        // Bad key / model / endpoint: retrying can't fix it — make it
        // visible in the transcript and stop, instead of DLQ-ing blind.
        await systemNote(conversation, messageId, 0, err.message);
        logExec({
          tenantId,
          transactionId: `conv-${conversationId}`,
          level: 'error',
          detail: `managed brain permanent failure: ${err.message}`,
        });
        return;
      }
      throw err;
    }
  } else {
    try {
      const dispatched = await dispatchToBridge(agent, conversation, subscriber, message, history);
      reply = dispatched.reply;
      buttons = dispatched.buttons;
      signals = dispatched.signals;
    } catch (err) {
      // Same doctrine as the managed branch: a config-shaped failure
      // (missing/blocked bridge URL) can't be fixed by retrying — surface
      // it in the transcript and stop, instead of burning attempts.
      if (err instanceof PermanentError) {
        await systemNote(conversation, messageId, 0, err.message);
        logExec({
          tenantId,
          transactionId: `conv-${conversationId}`,
          level: 'error',
          detail: `bridge dispatch permanent failure: ${err.message}`,
        });
        return;
      }
      throw err;
    }
  }

  if (reply !== undefined && reply.length > 0) {
    // Retry-safe in two layers: the dedupe key stops a duplicate ROW, and
    // deliverReply's send-once guard stops a duplicate SEND when a prior
    // attempt crashed between inserting the row and delivering it.
    const replyRow =
      (await insertConversationMessage({
        conversationId,
        tenantId,
        role: 'agent',
        content: reply,
        dedupeKey: `reply-${messageId}`,
        // Usage from managed turns; buttons from either runtime.
        raw:
          turnUsage || buttons
            ? { ...(turnUsage ? { usage: turnUsage } : {}), ...(buttons ? { buttons } : {}) }
            : undefined,
      })) ?? (await getConversationMessageByDedupe(conversationId, `reply-${messageId}`));
    if (replyRow) {
      await deliverReply(conversation, subscriber.external_id, agent, replyRow, message);
    }
  }
  await applySignals(conversation, messageId, signals, subscriber, agent);

  logExec({
    tenantId,
    transactionId: `conv-${conversationId}`,
    level: 'info',
    detail:
      `agent ${agent.identifier} (${agent.runtime}) handled turn: ` +
      `reply=${reply !== undefined && reply.length > 0} ` +
      `signals=${signals.map((s) => s.type).join(',') || 'none'}`,
  });
}

type BridgeSignal = z.infer<typeof BridgeResponseSchema>['signals'][number];

/** The customer-code runtime: signed POST to the bridge URL. */
async function dispatchToBridge(
  agent: Agent,
  conversation: Conversation,
  subscriber: NonNullable<Awaited<ReturnType<typeof getSubscriberById>>>,
  message: ConversationMessage,
  history: ConversationMessage[],
): Promise<{
  reply?: string;
  buttons?: Array<{ id: string; label: string }>;
  signals: BridgeSignal[];
}> {
  if (!agent.bridge_url) {
    throw new PermanentError(`bridge agent ${agent.identifier} has no bridge URL`);
  }
  // Button clicks arrive as user rows carrying raw.action — the bridge
  // sees them as first-class 'action' events (label rides message.text).
  const clicked = (message.raw as { action?: { id: string } } | null)?.action;
  const rawBody = JSON.stringify({
    type: clicked ? 'action' : 'message',
    ...(clicked ? { action: { id: clicked.id, label: message.content } } : {}),
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

  // SSRF gate, both halves: the assert catches literal private IPs (which
  // bypass custom DNS lookup), the dispatcher re-checks every resolved
  // address at connect time (DNS rebinding). Blocked → no retries.
  try {
    await assertSafeOutboundUrl(agent.bridge_url, { resolve: false });
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new PermanentError(`bridge URL blocked: ${err.message}`);
    }
    throw err;
  }

  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signWebhook(openSecret(agent.signing_secret), timestamp, rawBody);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), BRIDGE_TIMEOUT_MS);
  let response: Awaited<ReturnType<typeof safeFetch>>;
  try {
    response = await safeFetch(agent.bridge_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-asyncify-timestamp': timestamp,
        'x-asyncify-signature': signature,
      },
      body: rawBody,
      signal: controller.signal,
      dispatcher: safeDispatcher(),
      // A bridge must answer directly; following redirects would let a
      // vetted public host bounce us to a private one.
      redirect: 'manual',
    });
  } catch (err) {
    // undici wraps connect-time failures ("fetch failed" → cause chain).
    for (let e: unknown = err; e instanceof Error; e = e.cause) {
      if (e instanceof UnsafeOutboundUrlError) {
        throw new PermanentError(`bridge URL blocked: ${e.message}`);
      }
    }
    throw err;
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
  return parsed.data;
}

/** Bridge signals, applied in order — deduped so retries can't re-apply. */
async function applySignals(
  conversation: Conversation,
  messageId: string,
  signals: BridgeSignal[],
  subscriber: NonNullable<Awaited<ReturnType<typeof getSubscriberById>>>,
  agent: Agent,
): Promise<void> {
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
      await updateConversationMetadata(conversation.id, merged);
    } else if (signal.type === 'trigger') {
      const result = await internalTrigger({
        tenantId: conversation.tenant_id,
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
      await resolveConversation(conversation.id, signal.summary);
      await systemNote(conversation, messageId, signalIndex, `conversation resolved${signal.summary ? `: ${signal.summary}` : ''}`);
      if (conversation.channel === 'inapp') {
        await publishConversationEvent(conversation, subscriber.external_id, agent, {
          type: 'conversation.resolved',
        });
      }
    }
  }
}

/**
 * Channel-aware reply delivery. in-app: publish on the subscriber's WS
 * pub/sub channel (the row is already the durable inbox copy). telegram:
 * sendMessage via the connection's bot, recording the telegram message id
 * on the row so a retried job never sends the same reply twice.
 */
async function deliverReply(
  conversation: Conversation,
  subscriberExternalId: string,
  agent: Agent,
  replyRow: ConversationMessage,
  inboundRow: ConversationMessage,
): Promise<void> {
  if (conversation.channel === 'inapp') {
    const buttons = (replyRow.raw as { buttons?: Array<{ id: string; label: string }> } | null)
      ?.buttons;
    await publishConversationEvent(conversation, subscriberExternalId, agent, {
      type: 'conversation.message',
      message: {
        id: replyRow.id,
        role: 'agent',
        text: replyRow.content,
        createdAt: replyRow.created_at,
        ...(buttons ? { buttons } : {}),
      },
    });
    return;
  }

  if (conversation.channel === 'telegram') {
    const raw = (replyRow.raw ?? {}) as {
      telegramMessageId?: number;
      buttons?: Array<{ id: string; label: string }>;
    };
    if (raw.telegramMessageId) return; // already delivered on a prior attempt
    const connection = await getConnectionForAgent(agent.id, 'telegram');
    if (!connection || connection.status !== 'active') {
      logger.warn({ agent: agent.identifier }, 'telegram reply dropped: channel not connected');
      return;
    }
    const { botToken } = JSON.parse(openSecret(connection.credentials)) as { botToken: string };
    // Buttons render as an inline keyboard; presses come back as
    // callback_query updates on the webhook.
    const sent = await telegram.sendMessage(
      botToken,
      conversation.thread_key,
      replyRow.content,
      raw.buttons,
    );
    await updateConversationMessageRaw(replyRow.id, { ...raw, telegramMessageId: sent.message_id });
    return;
  }

  if (conversation.channel === 'email') {
    const raw = (replyRow.raw ?? {}) as { providerMessageId?: string };
    if (raw.providerMessageId) return; // already delivered on a prior attempt
    const toEmail = conversation.thread_key;
    // The suppression list is absolute: a bounced/complained address gets
    // no agent replies either. Visible in the transcript, not silent.
    if (await isSuppressed(conversation.tenant_id, 'email', toEmail)) {
      await insertConversationMessage({
        conversationId: conversation.id,
        tenantId: conversation.tenant_id,
        role: 'system',
        content: `reply not emailed: ${toEmail} is on the suppression list`,
        dedupeKey: `suppressed-${replyRow.id}`,
      });
      return;
    }
    const connection = await getConnectionForAgent(agent.id, 'email');
    const address = (connection?.config as { address?: string } | null)?.address;
    const inboundRaw = (inboundRow.raw ?? {}) as { subject?: string; rfcMessageId?: string | null };
    const subject = inboundRaw.subject
      ? inboundRaw.subject.replace(/^(re:\s*)+/i, '')
      : `Message from ${agent.name}`;
    // Email has no buttons — degrade to a numbered options list the user
    // can answer in a plain reply.
    const emailButtons = (replyRow.raw as { buttons?: Array<{ label: string }> } | null)?.buttons;
    const body = emailButtons?.length
      ? `${replyRow.content}\n\nOptions (just reply with your choice):\n` +
        emailButtons.map((b, i) => `${i + 1}) ${b.label}`).join('\n')
      : replyRow.content;

    // The tenant's normal integration chain: breakers + failover included.
    const sent = await sendWithFailover('email', {
      messageId: replyRow.id,
      tenantId: conversation.tenant_id,
      to: { email: toEmail },
      subject: `Re: ${subject}`,
      body,
      replyTo: address,
      headers: inboundRaw.rfcMessageId
        ? { 'In-Reply-To': inboundRaw.rfcMessageId, References: inboundRaw.rfcMessageId }
        : undefined,
    });
    await updateConversationMessageRaw(replyRow.id, {
      ...raw,
      providerMessageId: sent.providerMessageId,
      provider: sent.provider,
    });
    return;
  }

  logger.warn({ channel: conversation.channel }, 'reply for unsupported channel dropped');
}

/** Transcript breadcrumb for a signal — deduped so retries can't repeat it. */
async function systemNote(
  conversation: Conversation,
  messageId: string,
  signalIndex: number,
  content: string,
  raw?: unknown,
): Promise<void> {
  await insertConversationMessage({
    conversationId: conversation.id,
    tenantId: conversation.tenant_id,
    role: 'system',
    content,
    dedupeKey: `signal-${messageId}-${signalIndex}`,
    raw,
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
