import type { Job } from 'bullmq';
import { z } from 'zod';
import { logger } from '../../shared/logger';
import { PRIORITIES, getQueue, QUEUE } from '../../shared/queues';
import { logExec } from '../../core/execution-log';
import { internalTrigger } from '../../core/internal-trigger';
import { signWebhook } from '../../api/webhook-signature';
import { openSecret } from '../../auth/secret-box';
import { telegram } from '../../channels/telegram';
import { slack, SlackError } from '../../channels/slack';
import type { SlackCredentials } from '../../api/routes/slack';
import { sendWithFailover } from '../../providers/registry';
import { isSuppressed } from '../../db/repositories';
import {
  runManagedTurn,
  postCustomToolCall,
  deniedResult,
  type TurnUsage,
} from '../../core/managed-brain';
import { pool } from '../../db/pool';
import {
  getToolCall,
  getToolDef,
  finishToolCall,
} from '../../db/agent-tools.repo';
import { CardSchema, type Card } from '../../shared/cards';
import { publishConversationEvent } from '../../core/conversation-events';
import { PermanentError, TransientError } from '../../shared/errors';
import { fetch as safeFetch } from 'undici';
import {
  assertSafeOutboundUrl,
  safeDispatcher,
  UnsafeOutboundUrlError,
} from '../../core/safe-url';
import {
  conversationHistoryBefore,
  conversationTranscriptBefore,
  finalizeAgentMessage,
  getAgentById,
  getConnectionForConversation,
  getConversation,
  getConversationMessage,
  getConversationMessageByDedupe,
  getSubscriberById,
  insertConversationMessage,
  lastUserMessage,
  resolveConversation,
  setAgentMessageContent,
  updateConversationMessageRaw,
  updateConversationMetadata,
  type Agent,
  type Conversation,
  type ConversationMessage,
} from '../../db/conversations.repo';

export interface ConversationJobData {
  tenantId: string;
  conversationId: string;
  /**
   * conversation_messages.id: the inbound user turn to dispatch ('turn'), or
   * the agent row to deliver ('deliver'). Absent on 'resolved' jobs.
   */
  messageId?: string;
  /**
   * What this job does. Absent = 'turn' (so jobs enqueued before this field
   * existed still dispatch correctly). 'deliver' = push a pre-inserted agent
   * message out over the channel; 'resolved' = notify the bridge a
   * conversation closed; 'tool-decision' = resume a gated custom tool call
   * after a human approved/denied it (or the sweep expired it).
   */
  kind?: 'turn' | 'deliver' | 'resolved' | 'tool-decision';
  /** On 'resolved' jobs: who closed the conversation. */
  resolvedBy?: 'bridge' | 'operator' | 'sweep';
  /** On 'tool-decision' jobs: the agent_tool_calls row to resume. */
  toolCallId?: string;
}

const BRIDGE_TIMEOUT_MS = 10_000;
const METADATA_MAX_BYTES = 64 * 1024;
/** Minimum wall-clock gap between plan-card progress edits (throttle floor). */
const PLAN_CARD_EDIT_SPACING_MS = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** What a bridge may send back — one reply plus batched signals. */
const BridgeResponseSchema = z
  .object({
  reply: z.string().max(64 * 1024).optional(),
  /** Buttons under the reply; clicks come back as 'action' events. */
  buttons: z
    .array(z.object({ id: z.string().min(1).max(64), label: z.string().min(1).max(48) }))
    .max(6)
    .optional(),
  /** A card under the reply (select/text_input); answers come back as 'action' events. */
  card: CardSchema.optional(),
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
  })
  .refine((r) => !(r.buttons && r.card), {
    message: 'a reply may carry buttons or a card, not both',
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
  if (job.data.kind === 'deliver') return processDeliver(job.data);
  if (job.data.kind === 'resolved') return processResolved(job.data);
  if (job.data.kind === 'tool-decision') return processToolDecision(job.data);
  return processTurn(job.data);
}

/** The inbound-turn hop (default kind): dispatch one user turn, apply the reply. */
async function processTurn(data: ConversationJobData): Promise<void> {
  if (!data.messageId) return;
  const { tenantId, conversationId, messageId } = data;

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
  // A message soft-deleted before we processed it gets no reply.
  if (message.deleted_at) return;

  const history = await conversationHistoryBefore(conversationId, messageId);

  // Turn-start "composing" pulse for both runtimes; the managed branch pulses
  // again on each model call via the onModelCall hook.
  const emitTyping = typingEmitter(conversation, subscriber.external_id, agent);
  emitTyping();

  // The brain branch: who answers this turn. Everything after (reply row,
  // channel delivery, signals, breadcrumbs) is identical for both runtimes.
  let reply: string | undefined;
  let buttons: Array<{ id: string; label: string }> | undefined;
  let card: Card | undefined;
  let signals: BridgeSignal[] = [];
  let turnUsage: TurnUsage | undefined;
  // The streaming plan card (managed, non-email): posts ONE evolving agent
  // message on the first labelable tool call and finalizes it as the reply.
  let planCard: PlanCard | undefined;

  if (agent.runtime === 'managed') {
    planCard =
      conversation.channel !== 'email'
        ? createPlanCard({
            conversation,
            agent,
            subscriberExternalId: subscriber.external_id,
            inboundMessageId: messageId,
            inboundRow: message,
          })
        : undefined;
    try {
      // Richer history (incl. tool-action breadcrumbs) — the brain folds
      // them in so past tool-backed replies don't look like bare claims.
      const fullHistory = await conversationTranscriptBefore(conversationId, messageId);
      const turn = await runManagedTurn(agent, conversation, subscriber, fullHistory, message, {
        // Once the plan card is live it carries the "working" signal; keep the
        // typing pulse only for the pre-card model rounds.
        onModelCall: () => {
          if (!planCard?.posted) emitTyping();
        },
        onToolCall: planCard?.onToolCall,
        onToolResult: planCard?.onToolResult,
      });
      reply = turn.reply ?? undefined;
      buttons = turn.buttons;
      card = turn.card;
      turnUsage = turn.usage;
      // If a plan card was posted, its row IS the reply row — finalize it now
      // (the final edit becomes the reply). turn.reply carries the extras; a
      // no-reply turn (note/refusal/empty) finalizes to the same note string.
      if (planCard?.posted) {
        if (turn.reply) {
          await planCard.finalize(turn.reply, {
            buttons: turn.buttons,
            card: turn.card,
            usage: turn.usage,
          });
        } else {
          await planCard.finalize(turn.note ?? 'the model produced no reply text', {
            usage: turn.usage,
          });
        }
      }
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
        // If a plan card is frozen mid-progress, best-effort finalize it to
        // the breadcrumb so the user isn't left staring at a ⏳ (never mask
        // the original flow).
        if (planCard?.posted && !planCard.finalized) {
          try {
            await planCard.finalize(err.message, {});
          } catch {
            /* best-effort — the systemNote below is the durable record */
          }
        }
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
      card = dispatched.card;
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
    if (planCard?.finalized) {
      // The plan-card row IS the reply row: finalize already set its content,
      // merged raw (usage/buttons/card), and pushed the channel edit. Do NOT
      // re-write raw (that would clobber finalize's merge) — just re-run the
      // send-once delivery guard for retry safety (it no-ops sends already
      // made; the inapp branch republishes conversation.message, which the
      // widget drops as a known id).
      const replyRow = await getConversationMessageByDedupe(conversationId, `reply-${messageId}`);
      if (replyRow) {
        await deliverReply(conversation, subscriber.external_id, agent, replyRow, message);
      }
    } else {
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
          // Usage from managed turns; buttons/card from either runtime.
          raw:
            turnUsage || buttons || card
              ? {
                  ...(turnUsage ? { usage: turnUsage } : {}),
                  ...(buttons ? { buttons } : {}),
                  ...(card ? { card } : {}),
                }
              : undefined,
        })) ?? (await getConversationMessageByDedupe(conversationId, `reply-${messageId}`));
      if (replyRow) {
        await deliverReply(conversation, subscriber.external_id, agent, replyRow, message);
      }
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

/**
 * The push hop: an agent message was inserted out-of-band (operator/API push,
 * not a reply to an inbound turn) and needs to reach the subscriber. Same
 * channel delivery + send-once guard as a reply row; retries are safe.
 */
async function processDeliver(data: ConversationJobData): Promise<void> {
  if (!data.messageId) return;
  const conversation = await getConversation(data.tenantId, data.conversationId);
  if (!conversation) return; // deleted underneath us
  const [agent, row, subscriber] = await Promise.all([
    getAgentById(conversation.agent_id),
    getConversationMessage(data.messageId),
    getSubscriberById(conversation.subscriber_id),
  ]);
  if (!agent || !row || !subscriber) return;
  if (agent.status !== 'active') {
    logger.info({ agent: agent.identifier }, 'agent disabled, skipping delivery');
    return;
  }
  if (row.deleted_at) return; // soft-deleted before we delivered it

  // A push has no inbound turn of its own; the latest live user message is
  // what an email reply threads onto (null => a fresh, un-threaded email).
  const inbound = await lastUserMessage(data.conversationId);
  await deliverReply(conversation, subscriber.external_id, agent, row, inbound);
  logExec({
    tenantId: data.tenantId,
    transactionId: `conv-${data.conversationId}`,
    level: 'info',
    detail: `pushed agent message delivered channel=${conversation.channel}`,
  });
}

/**
 * The resolved-event hop: a conversation closed (bridge signal, operator, or
 * the inactivity sweep) — tell the agent's bridge so customer code can react.
 * Never writes a transcript row; the resolve breadcrumb was already written by
 * whoever flipped the status. Idempotent: the status guard drops the event if
 * the conversation was reopened before we ran.
 */
async function processResolved(data: ConversationJobData): Promise<void> {
  const conversation = await getConversation(data.tenantId, data.conversationId);
  if (!conversation) return;
  if (conversation.status !== 'resolved') {
    logExec({
      tenantId: data.tenantId,
      transactionId: `conv-${data.conversationId}`,
      level: 'info',
      detail: 'resolved event dropped: conversation reopened',
    });
    return;
  }
  const [agent, subscriber] = await Promise.all([
    getAgentById(conversation.agent_id),
    getSubscriberById(conversation.subscriber_id),
  ]);
  if (!agent || !subscriber) return;
  if (agent.runtime !== 'bridge' || !agent.bridge_url || agent.status !== 'active') return;

  try {
    await dispatchResolvedToBridge(agent, conversation, subscriber, data.resolvedBy);
  } catch (err) {
    // Config-shaped failure (blocked/missing bridge URL): retrying can't fix
    // it. Surface it and stop instead of burning attempts; other errors
    // rethrow so BullMQ retries the transient case.
    if (err instanceof PermanentError) {
      logExec({
        tenantId: data.tenantId,
        transactionId: `conv-${data.conversationId}`,
        level: 'error',
        detail: `resolved event permanent failure: ${err.message}`,
      });
      return;
    }
    throw err;
  }
  logExec({
    tenantId: data.tenantId,
    transactionId: `conv-${data.conversationId}`,
    level: 'info',
    detail: 'resolved event delivered to bridge',
  });
}

/**
 * The tool-decision resume hop: a gated custom tool call was approved/denied by
 * a human (or expired by the sweep). Execute (or record the denial/expiry),
 * update the pause breadcrumb IN PLACE so replay stays pair-complete, drop a
 * plain human-readable decision row, then run ONE fresh brain turn so the model
 * composes the user-facing follow-up.
 *
 * Every step is content-keyed/atomically-claimed so BullMQ's attempts:5 retries
 * are no-ops: the POST is claimed via finishToolCall (loser reuses the stored
 * result), the decision row is dedupe-keyed, the follow-up turn is a fixed
 * jobId, and the breadcrumb update is a deterministic overwrite.
 */
async function processToolDecision(data: ConversationJobData): Promise<void> {
  const { tenantId, conversationId } = data;
  if (!data.toolCallId) return;
  const call = await getToolCall(tenantId, data.toolCallId);
  if (!call) return; // row vanished (agent/tool deleted) — nothing to resume
  // Still pending means neither a decision nor an expiry landed — the job was
  // enqueued in error; leave the pause intact.
  if (call.status === 'pending') return;

  const conversation = await getConversation(tenantId, conversationId);
  if (!conversation) return;

  // Compute the final result string, executing the POST only for an approval.
  let finalResult: string;
  let outcomeWord: 'executed' | 'failed' | 'denied' | 'expired';
  if (call.status === 'approved') {
    const [agent, subscriber, def] = await Promise.all([
      getAgentById(conversation.agent_id),
      getSubscriberById(conversation.subscriber_id),
      call.tool_def_id ? getToolDef(tenantId, call.tool_def_id) : Promise.resolve(null),
    ]);
    if (!agent || !subscriber) return; // deleted underneath us — retry later
    if (!def) {
      finalResult = 'tool definition no longer exists';
      outcomeWord = 'failed';
      await finishToolCall(call.id, 'failed', finalResult, 'approved');
    } else {
      const { result, isError } = await postCustomToolCall(
        def,
        call.id,
        call.args,
        agent,
        conversation,
        subscriber,
      );
      // Atomic claim from 'approved'; a null loser means a prior attempt already
      // executed — reuse its stored row instead of double-counting the POST.
      const claimed = await finishToolCall(call.id, isError ? 'failed' : 'executed', result, 'approved');
      if (claimed) {
        finalResult = result;
        outcomeWord = isError ? 'failed' : 'executed';
      } else {
        const stored = await getToolCall(tenantId, call.id);
        finalResult = stored?.result ?? result;
        outcomeWord = stored?.status === 'failed' ? 'failed' : 'executed';
      }
    }
  } else if (call.status === 'executed' || call.status === 'failed') {
    // Retry after we already ran the POST: reuse the stored result.
    finalResult = call.result ?? '';
    outcomeWord = call.status;
  } else if (call.status === 'denied') {
    finalResult = deniedResult(call.decided_by, call.note);
    outcomeWord = 'denied';
  } else {
    finalResult = 'approval expired';
    outcomeWord = 'expired';
  }

  // Update the pause breadcrumb's raw.action.result IN PLACE — the replayed
  // tool_use/tool_result pair now carries the true outcome, so the follow-up
  // turn (and every future turn) sees the real result, not "pending".
  if (call.breadcrumb_message_id) {
    await updateBreadcrumbResult(call.breadcrumb_message_id, finalResult);
  }

  // A plain, human-readable transcript row (NO raw.action) — buildHistory folds
  // action-less system rows as nothing (they never become a tool pair), so this
  // can't be mistaken for a forged tool receipt on replay. It's also the turn
  // trigger below: passed as the follow-up turn's inbound.
  const decisionRow =
    (await insertConversationMessage({
      conversationId,
      tenantId,
      role: 'system',
      content: `[approval decided: ${call.tool_name} — ${outcomeWord}]`,
      dedupeKey: `approval-decided-${call.id}`,
    })) ?? (await getConversationMessageByDedupe(conversationId, `approval-decided-${call.id}`));

  logExec({
    tenantId,
    transactionId: `conv-${conversationId}`,
    level: 'info',
    detail: `tool ${call.tool_name} ${outcomeWord} (approval ${call.id})`,
  });

  if (!decisionRow) return; // unreachable (insert-or-recover)

  // Run ONE fresh brain turn off the decision signal — a normal 'turn' job
  // keyed to the decision row, so it reuses the full reply/plan-card/delivery
  // machinery with a fresh MAX_MODEL_CALLS budget. jobId is deterministic, so a
  // retried decision job re-enqueues a no-op.
  await getQueue(QUEUE.CONVERSATION).add(
    decisionRow.id,
    { tenantId, conversationId, messageId: decisionRow.id },
    { jobId: `conv-${decisionRow.id}`, attempts: 5 },
  );
}

/**
 * Surgically overwrite a breadcrumb row's `raw.action.result` (jsonb_set) so a
 * replayed tool pair reflects a decision made after the turn. Content and
 * created_at are untouched — only the result string moves. Tiny helper (not in
 * the frozen repo) because it's specific to the approval-resume flow.
 */
async function updateBreadcrumbResult(messageId: string, result: string): Promise<void> {
  await pool.query(
    `update conversation_messages
        set raw = jsonb_set(raw, '{action,result}', to_jsonb($2::text))
      where id = $1 and raw ? 'action'`,
    [messageId, result],
  );
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
  card?: Card;
  signals: BridgeSignal[];
}> {
  // Button clicks / card answers arrive as user rows carrying raw.action — the
  // bridge sees them as first-class 'action' events (label rides message.text;
  // value carries the select id / typed text when present).
  const clicked = (message.raw as { action?: { id: string; value?: string; kind?: string } } | null)
    ?.action;
  const rawBody = JSON.stringify({
    type: clicked ? 'action' : 'message',
    ...(clicked
      ? {
          action: {
            id: clicked.id,
            label: message.content,
            ...(clicked.value !== undefined ? { value: clicked.value } : {}),
          },
        }
      : {}),
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

  const response = await postSignedToBridge(agent, rawBody);
  const parsed = BridgeResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    throw new Error(`bridge returned an invalid response for agent ${agent.identifier}`);
  }
  return parsed.data;
}

/**
 * The shared bridge transport: HMAC-sign a raw body and POST it to the agent's
 * bridge URL, with both SSRF layers and a hard timeout. Returns the (ok)
 * response so callers can parse a body, or ignore it. Config-shaped failures
 * (missing/blocked URL) throw PermanentError → no retry; a non-2xx is a plain
 * Error → retried.
 */
async function postSignedToBridge(
  agent: Agent,
  rawBody: string,
): Promise<Awaited<ReturnType<typeof safeFetch>>> {
  if (!agent.bridge_url) {
    throw new PermanentError(`bridge agent ${agent.identifier} has no bridge URL`);
  }
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
  return response;
}

/**
 * Fire the resolved lifecycle event at a bridge agent. Mirrors dispatchToBridge's
 * subscriber/conversation shapes for field-name consistency; the bridge's
 * response body is ignored (success = a 2xx, enforced by postSignedToBridge).
 */
async function dispatchResolvedToBridge(
  agent: Agent,
  conversation: Conversation,
  subscriber: NonNullable<Awaited<ReturnType<typeof getSubscriberById>>>,
  resolvedBy: ConversationJobData['resolvedBy'],
): Promise<void> {
  const rawBody = JSON.stringify({
    type: 'resolved',
    resolvedBy,
    agent: { identifier: agent.identifier, name: agent.name },
    conversation: {
      id: conversation.id,
      channel: conversation.channel,
      status: conversation.status,
      metadata: conversation.metadata,
      messageCount: conversation.message_count,
      summary: conversation.summary,
    },
    subscriber: {
      subscriberId: subscriber.external_id,
      email: subscriber.email,
      phone: subscriber.phone,
    },
  });
  await postSignedToBridge(agent, rawBody);
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
      // Tell the bridge its conversation closed (separate hop; deduped per
      // turn so a retried job can't double-fire the resolved event).
      if (agent.runtime === 'bridge' && agent.bridge_url) {
        await getQueue(QUEUE.CONVERSATION).add(
          `resolved-${conversation.id}`,
          {
            kind: 'resolved',
            tenantId: conversation.tenant_id,
            conversationId: conversation.id,
            resolvedBy: 'bridge',
          },
          { jobId: `conv-resolved-${conversation.id}-${messageId}`, attempts: 5, priority: 10 },
        );
      }
    }
  }
}

/**
 * Fire-and-forget "agent is composing" pulse. Never awaited on the hot path,
 * never fails the turn. inapp -> pub/sub; telegram -> sendChatAction; email
 * -> no-op. Returns an `emitTyping` closure the caller pulses per model call.
 */
function typingEmitter(
  conversation: Conversation,
  subscriberExternalId: string,
  agent: Agent,
): () => void {
  if (conversation.channel === 'inapp') {
    return () => {
      void publishConversationEvent(conversation, subscriberExternalId, agent, {
        type: 'conversation.typing',
      }).catch(() => {});
    };
  }
  if (conversation.channel === 'telegram') {
    // Load + unseal the bot creds once, on first pulse; every later call
    // reuses the memoized promise (a rejection just makes each pulse a no-op).
    let creds: Promise<{ botToken: string } | null> | undefined;
    return () => {
      if (!creds) {
        creds = getConnectionForConversation(conversation).then((connection) =>
          connection && connection.status === 'active'
            ? (JSON.parse(openSecret(connection.credentials)) as { botToken: string })
            : null,
        );
      }
      void creds
        .then((c) => c && telegram.sendChatAction(c.botToken, conversation.thread_key))
        .catch(() => {});
    };
  }
  if (conversation.channel === 'slack') return () => {}; // Slack has no general typing API for bots (assistant-only surface); deliberate no-op.
  return () => {};
}

// ---- plan-card streaming engine ----

/** Presentation tools never post a step (a turn with only these posts no card). */
const PLAN_CARD_PRESENTATION_TOOLS = new Set(['present_buttons', 'present_choices', 'request_input']);

/** One tool call's progress line, or null for a tool that gets no step. */
function planStepLabel(tool: string, input: Record<string, unknown>): string | null {
  if (PLAN_CARD_PRESENTATION_TOOLS.has(tool)) return null;
  switch (tool) {
    case 'trigger_workflow':
      return `Triggering ${(input.workflowKey as string | undefined) ?? 'workflow'}…`;
    case 'set_metadata':
      return 'Saving details…';
    case 'resolve_conversation':
      return 'Wrapping up…';
    default:
      return 'Working…';
  }
}

type PlanStep = { label: string; status: 'pending' | 'done' | 'error' };

/** Render the ledger as the plan card's current body (newline-joined). */
function planProgressText(steps: PlanStep[]): string {
  return steps
    .map((s) => {
      if (s.status === 'done') return `✓ ${s.label.replace(/…$/, '')}`;
      if (s.status === 'error') return `✗ ${s.label} failed`;
      return `⏳ ${s.label}`;
    })
    .join('\n');
}

/** Prose degrade for a card whose Slack blocks were rejected (invalid_blocks). */
function planCardProse(text: string, card: Card): string {
  const prompt = card.prompt ?? '';
  if (card.type === 'select') {
    const opts = card.options.map((o, i) => `${i + 1}) ${o.label}`).join('\n');
    return `${text}\n\n${prompt}${prompt ? '\n' : ''}${opts}`;
  }
  return `${text}\n\n${prompt}${card.placeholder ? ` (e.g. ${card.placeholder})` : ''}`;
}

interface PlanCardExtras {
  buttons?: Array<{ id: string; label: string }>;
  card?: Card;
  usage?: TurnUsage;
}

interface PlanCardChannelRaw {
  telegramMessageId?: number;
  slackTs?: string;
  slackChannel?: string;
}

export interface PlanCard {
  readonly posted: boolean;
  readonly finalized: boolean;
  onToolCall: (tool: string, input: Record<string, unknown>) => Promise<void>;
  onToolResult: (tool: string, ok: boolean) => Promise<void>;
  finalize: (text: string, extras: PlanCardExtras) => Promise<void>;
}

/**
 * ONE evolving agent message during a tool-using managed turn: posted on the
 * first labelable tool call, edited per step (⏳/✓/✗), the final edit BEING the
 * reply. The plan-card row IS the reply row (dedupe `reply-<messageId>`), so
 * finalize + the existing reply-insert path collapse to one durable message.
 * Never created for email (no live surface to edit).
 */
function createPlanCard(args: {
  conversation: Conversation;
  agent: Agent;
  subscriberExternalId: string;
  inboundMessageId: string;
  inboundRow: ConversationMessage;
}): PlanCard {
  const { conversation, agent, subscriberExternalId, inboundMessageId, inboundRow } = args;
  const channel = conversation.channel;
  const dedupeKey = `reply-${inboundMessageId}`;

  let state: 'idle' | 'posted' | 'finalized' = 'idle';
  const steps: PlanStep[] = [];
  let row: ConversationMessage | null = null;

  // Throttle state: a monotone seq + a single serialized promise chain.
  let seq = 0;
  let lastEditAt = 0;
  let chain: Promise<void> = Promise.resolve();
  let warnedProgressFailure = false;

  // Lazily-memoized connection creds (typingEmitter pattern): telegram/slack
  // progress + final edits need the bot token; a rejection makes edits no-ops.
  let credsP: Promise<{ botToken: string } | null> | undefined;
  function creds(): Promise<{ botToken: string } | null> {
    if (!credsP) {
      credsP = getConnectionForConversation(conversation).then((connection) =>
        connection && connection.status === 'active'
          ? (JSON.parse(openSecret(connection.credentials)) as { botToken: string })
          : null,
      );
    }
    return credsP;
  }

  function channelRaw(): PlanCardChannelRaw {
    return (row?.raw ?? {}) as PlanCardChannelRaw;
  }

  /** Best-effort progress edit — NEVER fails the turn. */
  async function progressEdit(text: string): Promise<void> {
    try {
      if (channel === 'inapp') {
        await publishConversationEvent(conversation, subscriberExternalId, agent, {
          type: 'conversation.message.updated',
          message: { id: row!.id, text },
        });
        return;
      }
      const c = await creds();
      if (!c) return;
      const raw = channelRaw();
      if (channel === 'telegram' && raw.telegramMessageId) {
        await telegram.editMessageText(c.botToken, conversation.thread_key, raw.telegramMessageId, text);
      } else if (channel === 'slack' && raw.slackTs && raw.slackChannel) {
        await slack.update(c.botToken, raw.slackChannel, raw.slackTs, text);
      }
    } catch (err) {
      // A telegram 429 gets ONE delayed retry; the client doesn't surface
      // retry_after, so a bounded fixed wait stands in. Anything else drops.
      const msg = (err as Error).message ?? '';
      if (channel === 'telegram' && /429|too many requests/i.test(msg)) {
        try {
          await sleep(PLAN_CARD_EDIT_SPACING_MS);
          const c = await creds();
          const raw = channelRaw();
          if (c && raw.telegramMessageId) {
            await telegram.editMessageText(c.botToken, conversation.thread_key, raw.telegramMessageId, text);
          }
          return;
        } catch {
          /* fall through to the warn-once drop */
        }
      }
      if (!warnedProgressFailure) {
        warnedProgressFailure = true;
        logger.warn({ err: msg, channel }, 'plan card progress edit failed (dropped)');
      }
    }
  }

  /**
   * Trailing-edge coalesce, ≥1s spacing. Each call appends one step to the
   * single serialized chain; a step sleeps for the spacing, then edits ONLY if
   * no newer edit was queued while it slept (seq unchanged).
   */
  function scheduleEdit(): void {
    const mySeq = ++seq;
    chain = chain
      .then(async () => {
        const wait = Math.max(0, PLAN_CARD_EDIT_SPACING_MS - (Date.now() - lastEditAt));
        if (wait > 0) await sleep(wait);
        if (mySeq !== seq) return; // a newer edit is queued — let it win
        await progressEdit(planProgressText(steps));
        lastEditAt = Date.now();
      })
      .catch(() => {}); // progress edits never fail the turn
  }

  async function ensurePosted(): Promise<void> {
    const text = planProgressText(steps);
    const inserted =
      (await insertConversationMessage({
        conversationId: conversation.id,
        tenantId: conversation.tenant_id,
        role: 'agent',
        content: text,
        dedupeKey,
      })) ?? (await getConversationMessageByDedupe(conversation.id, dedupeKey));
    if (!inserted) return; // unreachable in practice (insert-or-recover)
    row = inserted;
    state = 'posted';
    // Deliver through the EXISTING path: its send-once guards make retry
    // recovery free, and it stamps the channel ids into raw.
    await deliverReply(conversation, subscriberExternalId, agent, row, inboundRow);
    // Re-read to capture the channel ids deliverReply just wrote.
    row = (await getConversationMessage(row.id)) ?? row;
  }

  /** Forced final edit — failures propagate (as TransientError) so a retry re-finalizes. */
  async function forcedEdit(text: string, extras: PlanCardExtras): Promise<void> {
    try {
      if (channel === 'inapp') {
        await publishConversationEvent(conversation, subscriberExternalId, agent, {
          type: 'conversation.message.updated',
          message: {
            id: row!.id,
            text,
            ...(extras.buttons ? { buttons: extras.buttons } : {}),
            ...(extras.card ? { card: extras.card } : {}),
          },
        });
        return;
      }
      const c = await creds();
      if (!c) return; // channel disconnected — deliverReply already logged the drop
      const raw = channelRaw();
      if (channel === 'telegram') {
        if (!raw.telegramMessageId) return;
        if (extras.card?.type === 'text_input') {
          // D14: editMessageText can't carry a ForceReply, so edit the plain
          // text then send the ForceReply prompt as its own message.
          await telegram.editMessageText(c.botToken, conversation.thread_key, raw.telegramMessageId, text);
          const sent = await telegram.sendMessage(
            c.botToken,
            conversation.thread_key,
            extras.card.prompt ?? 'Reply with your answer:',
            { card: extras.card },
          );
          const merged = ((await getConversationMessage(row!.id))?.raw ?? row!.raw ?? {}) as Record<
            string,
            unknown
          >;
          await updateConversationMessageRaw(row!.id, {
            ...merged,
            cardPromptTelegramMessageId: sent.message_id,
          });
          row = (await getConversationMessage(row!.id)) ?? row;
        } else {
          await telegram.editMessageText(c.botToken, conversation.thread_key, raw.telegramMessageId, text, {
            buttons: extras.buttons,
            card: extras.card,
          });
        }
        return;
      }
      if (channel === 'slack') {
        if (!raw.slackTs || !raw.slackChannel) return;
        try {
          await slack.update(c.botToken, raw.slackChannel, raw.slackTs, text, {
            buttons: extras.buttons,
            card: extras.card,
          });
        } catch (err) {
          // slice A's invalid_blocks prose fallback lives on postMessage only;
          // mirror it here for update so a rejected card still lands as prose.
          if (err instanceof SlackError && err.error === 'invalid_blocks' && extras.card) {
            await slack.update(c.botToken, raw.slackChannel, raw.slackTs, planCardProse(text, extras.card));
            return; // fallback succeeded — not a finalize failure
          }
          throw err;
        }
        return;
      }
    } catch (err) {
      throw new TransientError(`plan card finalize channel edit failed: ${(err as Error).message}`, err);
    }
  }

  return {
    get posted() {
      return state !== 'idle';
    },
    get finalized() {
      return state === 'finalized';
    },

    async onToolCall(tool, input) {
      const label = planStepLabel(tool, input);
      if (label === null) return;
      steps.push({ label, status: 'pending' });
      if (state === 'idle') await ensurePosted();
      else await setAgentMessageContent(row!.id, planProgressText(steps));
      scheduleEdit();
    },

    async onToolResult(tool, ok) {
      if (PLAN_CARD_PRESENTATION_TOOLS.has(tool)) return;
      // Close THIS tool's step (the last still-pending one; calls run serially).
      for (let i = steps.length - 1; i >= 0; i -= 1) {
        if (steps[i].status === 'pending') {
          steps[i].status = ok ? 'done' : 'error';
          break;
        }
      }
      if (state === 'posted') {
        await setAgentMessageContent(row!.id, planProgressText(steps));
        scheduleEdit();
      }
    },

    async finalize(text, extras) {
      if (state !== 'posted') return; // never posted, or already finalized
      // Final write bumps created_at: the row was inserted at the first tool
      // call, BEFORE this turn's breadcrumbs — the bump re-sorts it after
      // them, so replay pairing folds the breadcrumbs into THIS reply.
      await finalizeAgentMessage(row!.id, text);
      // Merge the fresh raw (channel ids deliverReply wrote) with the reply extras.
      const freshRaw = ((await getConversationMessage(row!.id))?.raw ?? {}) as Record<string, unknown>;
      await updateConversationMessageRaw(row!.id, {
        ...freshRaw,
        ...(extras.usage ? { usage: extras.usage } : {}),
        ...(extras.buttons ? { buttons: extras.buttons } : {}),
        ...(extras.card ? { card: extras.card } : {}),
      });
      row = (await getConversationMessage(row!.id)) ?? row;
      // Supersede any pending progress edits, then drain the throttle chain.
      seq += 1;
      await chain.catch(() => {});
      await forcedEdit(text, extras);
      state = 'finalized';
    },
  };
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
  inboundRow: ConversationMessage | null,
): Promise<void> {
  if (conversation.channel === 'inapp') {
    const raw = (replyRow.raw ?? {}) as {
      buttons?: Array<{ id: string; label: string }>;
      card?: Card;
    };
    await publishConversationEvent(conversation, subscriberExternalId, agent, {
      type: 'conversation.message',
      message: {
        id: replyRow.id,
        role: 'agent',
        text: replyRow.content,
        createdAt: replyRow.created_at,
        ...(raw.buttons ? { buttons: raw.buttons } : {}),
        ...(raw.card ? { card: raw.card } : {}),
      },
    });
    return;
  }

  if (conversation.channel === 'telegram') {
    const raw = (replyRow.raw ?? {}) as {
      telegramMessageId?: number;
      buttons?: Array<{ id: string; label: string }>;
      card?: Card;
    };
    if (raw.telegramMessageId) return; // already delivered on a prior attempt
    const connection = await getConnectionForConversation(conversation);
    if (!connection || connection.status !== 'active') {
      logger.warn({ agent: agent.identifier }, 'telegram reply dropped: channel not connected');
      return;
    }
    const { botToken } = JSON.parse(openSecret(connection.credentials)) as { botToken: string };
    // Buttons/select render as an inline keyboard; a text_input card as a
    // ForceReply prompt. Answers come back as callback_query / reply updates.
    const sent = await telegram.sendMessage(botToken, conversation.thread_key, replyRow.content, {
      buttons: raw.buttons,
      card: raw.card,
    });
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
    const connection = await getConnectionForConversation(conversation);
    const address = (connection?.config as { address?: string } | null)?.address;
    const inboundRaw = (inboundRow?.raw ?? {}) as { subject?: string; rfcMessageId?: string | null };
    // A reply to an inbound email keeps the thread (Re: + In-Reply-To). A push
    // with no inbound turn (or an inbound with no email subject) opens a fresh
    // thread: plain subject, no Re:, no threading headers.
    const subject = inboundRaw.subject
      ? `Re: ${inboundRaw.subject.replace(/^(re:\s*)+/i, '')}`
      : `Message from ${agent.name}`;
    // Email has no interactive widgets — degrade buttons and cards to prose
    // the user can answer in a plain reply.
    const emailRaw = (replyRow.raw ?? {}) as {
      buttons?: Array<{ label: string }>;
      card?: Card;
    };
    let body = replyRow.content;
    if (emailRaw.buttons?.length) {
      body =
        `${replyRow.content}\n\nOptions (just reply with your choice):\n` +
        emailRaw.buttons.map((b, i) => `${i + 1}) ${b.label}`).join('\n');
    } else if (emailRaw.card?.type === 'select') {
      const card = emailRaw.card;
      body =
        `${replyRow.content}` +
        (card.prompt ? `\n\n${card.prompt}` : '') +
        `\n\nOptions (just reply with your choice):\n` +
        card.options.map((o, i) => `${i + 1}) ${o.label}`).join('\n');
    } else if (emailRaw.card?.type === 'text_input') {
      const card = emailRaw.card;
      body =
        `${replyRow.content}\n\n${card.prompt ?? 'Just reply with your answer.'}` +
        (card.placeholder ? ` (e.g. ${card.placeholder})` : '');
    }

    // The tenant's normal integration chain: breakers + failover included.
    const sent = await sendWithFailover('email', {
      messageId: replyRow.id,
      tenantId: conversation.tenant_id,
      to: { email: toEmail },
      subject,
      body,
      replyTo: address,
      headers: inboundRaw.subject && inboundRaw.rfcMessageId
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

  if (conversation.channel === 'slack') {
    const raw = (replyRow.raw ?? {}) as {
      slackTs?: string;
      slackChannel?: string;
      buttons?: Array<{ id: string; label: string }>;
      card?: Card;
    };
    if (raw.slackTs) return; // already delivered on a prior attempt
    const connection = await getConnectionForConversation(conversation);
    if (!connection || connection.status !== 'active') {
      logger.warn({ agent: agent.identifier }, 'slack reply dropped: channel not connected');
      return;
    }
    const { botToken } = JSON.parse(openSecret(connection.credentials)) as SlackCredentials;
    // thread_key is a DM channel id (no colon) or `channel:threadTs` for a
    // thread — split on the FIRST colon so a ts (which has none) stays intact.
    const colon = conversation.thread_key.indexOf(':');
    const channel =
      colon === -1 ? conversation.thread_key : conversation.thread_key.slice(0, colon);
    const threadTs = colon === -1 ? undefined : conversation.thread_key.slice(colon + 1);
    // Buttons/select render as blocks; a text_input card as an input block.
    // Answers come back on the interactivity webhook.
    const sent = await slack.postMessage(botToken, channel, replyRow.content, {
      threadTs,
      buttons: raw.buttons,
      card: raw.card,
    });
    await updateConversationMessageRaw(replyRow.id, {
      ...raw,
      slackTs: sent.ts,
      slackChannel: sent.channel,
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

/** Best-effort plain-text edit of a stale plan card on a dead turn (all channels). */
async function staleCardChannelEdit(
  conversation: Conversation,
  subscriberExternalId: string,
  agent: Agent,
  row: ConversationMessage,
  text: string,
): Promise<void> {
  if (conversation.channel === 'inapp') {
    await publishConversationEvent(conversation, subscriberExternalId, agent, {
      type: 'conversation.message.updated',
      message: { id: row.id, text },
    });
    return;
  }
  const raw = (row.raw ?? {}) as PlanCardChannelRaw;
  const connection = await getConnectionForConversation(conversation);
  if (!connection || connection.status !== 'active') return;
  const { botToken } = JSON.parse(openSecret(connection.credentials)) as { botToken: string };
  if (conversation.channel === 'telegram' && raw.telegramMessageId) {
    await telegram.editMessageText(botToken, conversation.thread_key, raw.telegramMessageId, text);
  } else if (conversation.channel === 'slack' && raw.slackTs && raw.slackChannel) {
    await slack.update(botToken, raw.slackChannel, raw.slackTs, text);
  }
}

/** DLQ hook: retries exhausted — leave the failure visible in the transcript. */
export async function onConversationDead(job: Job): Promise<void> {
  const data = job.data as Partial<ConversationJobData>;
  // A resolved event is a lifecycle notification, not a turn — an
  // undeliverable one leaves no transcript row (nothing failed in the chat).
  if (data.kind === 'resolved') {
    if (!data.tenantId || !data.conversationId) return;
    logExec({
      tenantId: data.tenantId,
      transactionId: `conv-${data.conversationId}`,
      level: 'warn',
      detail: 'resolved event undeliverable: bridge unreachable after 5 attempts',
    });
    return;
  }
  if (!data.tenantId || !data.conversationId || !data.messageId) return;

  const deadNote =
    data.kind === 'deliver'
      ? 'agent message could not be delivered'
      : 'agent unreachable — this message was not answered';

  // Turn-ish dead job: the plan-card reply row may be frozen mid-progress
  // (⏳/✓/✗). Best-effort rewrite it to the dead note so the user isn't left
  // staring at a spinner. Fully guarded — the system row below is the record.
  if (data.kind !== 'deliver') {
    try {
      const stale = await getConversationMessageByDedupe(data.conversationId, `reply-${data.messageId}`);
      if (stale && stale.role === 'agent' && !stale.deleted_at && /^[⏳✓✗]/.test(stale.content)) {
        // Same created_at bump as a normal finalize: the dead note replaces
        // the reply and must sort after the turn's breadcrumbs in replay.
        await finalizeAgentMessage(stale.id, deadNote);
        const conversation = await getConversation(data.tenantId, data.conversationId);
        if (conversation) {
          const [agent, subscriber] = await Promise.all([
            getAgentById(conversation.agent_id),
            getSubscriberById(conversation.subscriber_id),
          ]);
          if (agent && subscriber) {
            await staleCardChannelEdit(conversation, subscriber.external_id, agent, stale, deadNote);
          }
        }
      }
    } catch (err) {
      logger.warn({ err }, 'failed to finalize stale plan card on dead turn');
    }
  }

  await insertConversationMessage({
    conversationId: data.conversationId,
    tenantId: data.tenantId,
    role: 'system',
    content: deadNote,
    dedupeKey: `dead-${data.messageId}`,
  }).catch((err) => logger.warn({ err }, 'failed to record dead conversation turn'));
}
