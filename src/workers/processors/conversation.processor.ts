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
import { getWorkflow, isSuppressed } from '../../db/repositories';
import {
  runManagedTurn,
  postCustomToolCall,
  deniedResult,
  attachPartialTrace,
  partialTraceOf,
  DEFAULT_MODEL,
  type TurnUsage,
  type TurnTrace,
  type TurnTraceEvent,
  type TurnRouting,
  type CandidateConfig,
} from '../../core/managed-brain';
import { pool } from '../../db/pool';
import { enqueueSummarize } from '../../core/episodic';
import {
  enqueueRollingFold,
  isReplayableTurn,
  resolveRollingKnobs,
  serializeFoldInput,
  shouldFold,
} from '../../core/rolling';
import {
  getToolCall,
  getToolDef,
  finishToolCall,
} from '../../db/agent-tools.repo';
import {
  getDayTokens,
  incrDayTokens,
  claimBudgetNotify,
  incrReplyBlockCount,
  claimReplyRulesNotify,
  incrSubscriberInbound,
  incrSubscriberSuppressed,
  claimSubscriberRateNotice,
  claimSubscriberRateNotify,
} from '../../shared/agent-counters';
import { resolveSubscriberRate } from '../../core/subscriber-rate';
import { CardSchema, type Card } from '../../shared/cards';
import { publishConversationEvent } from '../../core/conversation-events';
import { emitTenantEvent } from '../../core/tenant-events';
import { judgeTurnIfSampled } from '../../core/turn-judge';
import {
  resolveTopics,
  runTopicGate,
  topicGateModel,
  topicsForTurn,
} from '../../core/topic-gate';
import { checkReply, moderationForTurn, resolveModeration } from '../../core/reply-rules';
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
  getAgentPromptVersion,
  getConnectionById,
  getConnectionForConversation,
  getConversation,
  getConversationMessage,
  getConversationMessageByDedupe,
  getSubscriberById,
  insertConversationMessage,
  lastUserMessage,
  pausedHoldNoticeSent,
  resolveConversation,
  setAgentMessageContent,
  setConversationWaitingHuman,
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
  /**
   * INTERNAL (Phase A4) — never accepted from a request body. A candidate
   * system prompt / model this ONE turn runs on instead of the agent row's,
   * stamped only by the eval-run processor's in-process driver (pre-save eval
   * runs). Every public enqueue site — POST /v1/agents/:id/messages, /actions,
   * the channel webhooks — builds its job payload from an explicit field list,
   * never a spread of the request body, so a caller cannot inject this.
   */
  evalCandidate?: CandidateConfig;
  /**
   * INTERNAL (Phase A8) — never accepted from a request body, for the same
   * reason and by the same construction as `evalCandidate` above: every public
   * enqueue site builds its payload from an explicit field list.
   *
   * Exempts this turn from the per-customer message limit. Stamped ONLY by the
   * eval-run driver, whose scenario turns are a burst from one synthetic
   * subscriber by construction — an eval run that could throttle itself would
   * grade the limiter instead of the prompt, and would do it silently, as a
   * mysterious wall of canned notices in the middle of a scored transcript.
   *
   * An EXPLICIT FLAG rather than inferring it from `evalCandidate`, `channel`,
   * or the caller's shape — the `noCanary` precedent (conversations.repo.ts): a
   * driver that wants out of a platform-wide protection should have to say so,
   * not inherit it by accident. `evalCandidate` in particular would have been
   * the wrong proxy: a prompt-less eval run carries no candidate at all, so half
   * the runs would have been throttleable and half not.
   */
  noRateLimit?: boolean;
  /**
   * INTERNAL (Phase A10) — never accepted from a request body, by the same
   * explicit-field-list construction as the two fields above.
   *
   * Exempts this turn from the kill-switch hold. Stamped ONLY by the eval-run
   * driver, and it protects two different things at once. First, the operator's
   * queue: an eval scenario opens real conversations against a synthetic
   * subscriber, and holding them would file a stack of robot conversations in
   * front of the human who is already dealing with the incident. Second, the
   * incident workflow itself — pause, diagnose, RUN THE EVALS, resume is the
   * sequence the button exists to make possible, and an agent whose evals all
   * come back as the same holding line cannot be verified before it is switched
   * back on.
   *
   * An explicit flag rather than inferring it from `evalCandidate` or the
   * caller's shape — the `noCanary`/`noRateLimit` precedent: a driver opting out
   * of a platform-wide protection should have to say so.
   */
  noPauseHold?: boolean;
}

const BRIDGE_TIMEOUT_MS = 10_000;
const METADATA_MAX_BYTES = 64 * 1024;
/** Deterministic reply shipped when an agent's daily token budget is spent (G2). */
const BUDGET_EXHAUSTED_NOTE =
  "I'm temporarily unavailable right now — the team has been notified. Please try again later.";
/**
 * A10 THE KILL-SWITCH: the one line a customer hears while an agent is paused,
 * shipped ONCE per conversation just before the conversation is handed to a
 * person.
 *
 * PLATFORM COPY, not per-agent config, and that is a v1 decision with a reason
 * rather than a corner cut. A pause is an EMERGENCY BUTTON: the operator
 * pressing it is watching something go wrong right now, and a button that first
 * asks them to compose a customer-facing sentence is a button they will hesitate
 * over — which is the one thing an emergency control must never cost. So the
 * platform supplies one honest default and the operator supplies one click.
 *
 * The sentence is chosen to be true no matter WHY the button was pressed. It
 * promises only what the next line of code actually delivers (the conversation
 * really is being routed to the team's queue), never explains, never apologises
 * on the tenant's behalf, and never says the word "error" — the customer does
 * not need to know whether this is a bad deploy or a bad prompt.
 *
 * Making it configurable is additive and easy later (a nullable `pause_notice`
 * column read here, exactly like the A8 limiter's `notice`). It is deliberately
 * NOT in v1 because the failure mode of a configurable field on an emergency
 * control is an operator staring at an empty textarea during an incident.
 */
const PAUSED_HOLD_NOTE =
  'Our team is taking over this conversation — a person will be with you shortly.';
/** Minimum wall-clock gap between plan-card progress edits (throttle floor). */
const PLAN_CARD_EDIT_SPACING_MS = 1000;
/**
 * What the transcript says when a turn ran out of attempts. TWO writers race for
 * this row under the same dedupe key — the DLQ hook (onConversationDead) and
 * A13's final-attempt write in processTurn — so the wording lives in one place:
 * whichever wins, the customer-visible sentence is identical.
 */
const DEAD_TURN_NOTE = 'agent unreachable — this message was not answered';

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
  // A13: the turn hop is the only one that needs the JOB and not just its data —
  // a crashed turn's partial trace is worth persisting on the LAST attempt, and
  // only the job knows which attempt this is.
  return processTurn(job.data, job);
}

/**
 * A13 — is this the last attempt BullMQ will make at this job?
 *
 * Turn jobs are enqueued with `attempts: 5` at every call site. Both fallbacks
 * are deliberate rather than defensive: a job with no `attempts` gets exactly
 * one run by BullMQ's own default, so "attempt 1 of 1" IS the final attempt, and
 * that is also what a hand-built job object in a test means.
 */
function isFinalAttempt(job: Job<ConversationJobData>): boolean {
  return (job.attemptsMade ?? 0) + 1 >= (job.opts?.attempts ?? 1);
}

/**
 * A13 — persist a crashed turn's partial trace on its LAST attempt, then let the
 * error keep going.
 *
 * The row is the DEAD NOTE itself, under the same `dead-<messageId>` dedupe key
 * onConversationDead uses: the two writers race, the winner takes the row, and
 * the loser's insert no-ops on the dedupe conflict (insertConversationMessage is
 * `on conflict do nothing`). The transcript can therefore never show two dead
 * notes, and the copy that carries the trace is the one that gets there first —
 * this one, because it runs before the job is marked failed.
 *
 * Best-effort by construction: a failure to write bookkeeping must never mask
 * the error that actually killed the turn, and must never turn a retryable
 * failure into a different one.
 *
 * THE LIMIT, stated where the write happens: this only fires if the process
 * lives long enough to run this catch. A hard kill — OOM, SIGKILL, an evicted
 * container — takes the in-memory trace with it, the job is later reclaimed as
 * stalled, and the turn ends at onConversationDead's plain traceless dead note,
 * exactly as every crash did before A13. In-memory traces cannot survive a
 * process that stops existing; persisting events as they happen would be a
 * write per model call on the hot path, which lesson §5 rules out.
 */
async function noteCrashedTurn(
  conversation: Conversation,
  messageId: string,
  err: unknown,
  job: Job<ConversationJobData>,
): Promise<void> {
  const partial = partialTraceOf(err);
  // No trace = nothing this row could say that the DLQ hook's own note doesn't
  // already say, so the crash path stays untouched for every other failure.
  if (!partial || !isFinalAttempt(job)) return;
  await insertConversationMessage({
    conversationId: conversation.id,
    tenantId: conversation.tenant_id,
    role: 'system',
    content: DEAD_TURN_NOTE,
    dedupeKey: `dead-${messageId}`,
    raw: { trace: partial, crashed: true },
  }).catch((e) => logger.warn({ err: e }, 'failed to record a crashed turn trace'));
}

/** The inbound-turn hop (default kind): dispatch one user turn, apply the reply. */
async function processTurn(data: ConversationJobData, job: Job<ConversationJobData>): Promise<void> {
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

  // D2 BRAIN GATE (LAW): while a human owns the pen (waiting_human/human), the
  // agent must not speak. The inbound user row already persists (inserted before
  // this job was enqueued), so we only refresh the operator's live view and stop
  // — NO model call, NO typing pulse, NO brain side effects. The status here is
  // FRESH: getConversation ran at the top of this job, re-read per attempt, and
  // openConversation no longer forces a human-state thread back to active. The
  // P25 hint carries the customer's new message to the operator's open transcript.
  if (conversation.status === 'waiting_human' || conversation.status === 'human') {
    void emitTenantEvent(tenantId, 'conversation.changed', conversationId);
    logExec({
      tenantId,
      transactionId: `conv-${conversationId}`,
      level: 'info',
      detail: `turn skipped: a human owns the conversation (${conversation.status}) — message forwarded, no model call`,
    });
    return;
  }

  // ---- Phase A10: THE KILL-SWITCH ----
  //
  // One operator, one button, every conversation on this agent stops being
  // answered by a model — WITHOUT the customer hitting a wall and without the
  // incident erasing its own evidence.
  //
  // WHY HERE. Same argument as A8's, and it inherits A8's ruling wholesale:
  // every customer turn on every channel in either runtime IS a default-kind
  // job on QUEUE.CONVERSATION and therefore arrives at this function. A pause
  // enforced here cannot be bypassed by a channel nobody has written yet,
  // because a channel that does not enqueue a turn job is a channel whose agent
  // never answers. There is nothing to remember at nine call sites.
  //
  // WHY NOT AT INGRESS, which is the other obvious answer and the wrong one:
  // refusing the message at the door is what `status = 'disabled'` already
  // does, and it is exactly what a pause must NOT do. During an incident the
  // customer's words are the evidence. A 409 at the widget throws away the
  // sentence that would have told you what the agent got wrong, and it tells
  // the customer the product is broken instead of that a person is coming.
  // Nothing in the API or the webhooks reads `paused_at`; that is a property of
  // the design, asserted by a test, not an accident of where the code landed.
  //
  // ORDER, and each neighbour is a real ruling:
  //   • AFTER the D2 human-pen gate (above). A thread a human already owns is
  //     already held by a stronger claim than this one, and the holding line is
  //     platform prose — shipping it into an operator's live conversation would
  //     talk over the person who is mid-sentence with the customer. D2 wins.
  //   • BEFORE the A8 limiter (below). A paused agent must never send a rate
  //     notice: "you're sending messages faster than I can answer them" is a
  //     sentence about an agent that is answering. Pause wins, and it wins by
  //     position — the limiter's whole block is skipped, so a paused agent does
  //     not even spend the INCR.
  //   • BEFORE the budget check, the canary snapshot, the topic gate, routing
  //     and the brain. None of them are reached while paused; there is nothing
  //     to rank against them because a held turn never gets that far.
  //
  // FREE WHEN LIVE: one null comparison on a row already in hand. A live agent
  // — which is every agent almost all of the time — pays nothing at all.
  let paused = false;
  /**
   * The holding line to ship, or '' — non-empty ONLY on the turn that first
   * tells THIS conversation the agent is paused.
   */
  let pausedNotice = '';
  if (
    agent.paused_at !== null &&
    // The eval driver runs real turns through this function against a synthetic
    // subscriber. Holding those would be actively harmful in two ways: it would
    // push EVAL conversations into the operator's real queue (Sam opens the
    // incident queue and finds robots), and it would make it impossible to
    // verify a fix before resuming — which is the exact sequence a pause
    // exists to enable: pause, diagnose, run the evals, resume. An explicit
    // flag rather than sniffing the caller's shape, the same reasoning as
    // `noRateLimit` and `noCanary` before it.
    !data.noPauseHold
  ) {
    paused = true;
    const replyDedupeKey = `reply-${messageId}`;
    // ONCE PER CONVERSATION, not once per message. An incident is precisely the
    // moment a customer sends four messages in thirty seconds, and four
    // identical apologies is how a system tells someone nobody is home. The
    // claim is the shipped row itself — see pausedHoldNoticeSent for why that,
    // rather than a breadcrumb or a Redis key, is the honest claim.
    const alreadyTold = await pausedHoldNoticeSent(conversationId, replyDedupeKey);
    if (!alreadyTold) pausedNotice = PAUSED_HOLD_NOTE;

    // The breadcrumb, on every turn THIS GATE holds — the topic-gate/rate-limit
    // idiom: a NAMED KEY on a system row, never `raw.action`, because an action
    // row replays to the model as a tool call and a `pause` action would teach
    // the agent a phantom tool.
    //
    // THE HONEST GRANULARITY, stated because it is not what it first looks
    // like: this fires once per HOLD EPISODE, not once per message of a flood.
    // The first held turn routes the conversation to waiting_human, so the
    // customer's next message is stopped by the D2 gate above — which keeps
    // their row, refreshes the operator's view and writes its own exec line —
    // and never reaches this code. A second breadcrumb here therefore means
    // something specific and worth seeing: a human took the conversation, handed
    // it back, and the still-paused agent had to hold it again.
    await systemNote(
      conversation,
      messageId,
      'paused-hold',
      `agent ${agent.identifier} is paused (since ${agent.paused_at}) — message stored, no turn ran`,
      {
        pausedHold: {
          pausedAt: agent.paused_at,
          runtime: agent.runtime,
          // Whether THIS turn is the one that speaks. False on a re-hold after
          // a handback, which is the only way to reach here twice.
          notice: pausedNotice !== '',
        },
      },
    );

    logExec({
      tenantId,
      transactionId: `conv-${conversationId}`,
      level: 'warn',
      detail:
        `agent ${agent.identifier} is paused — message stored, no turn ran; ` +
        `conversation handed to the operator queue` +
        (pausedNotice ? ' (holding line sent)' : ' (already told)'),
    });
  }

  // ---- Phase A8: THE PER-CUSTOMER MESSAGE LIMIT ----
  //
  // WHY HERE, and it is the whole design decision of the phase.
  //
  // The obvious place for a rate limit is ingress — refuse the message at the
  // route, before a job is ever enqueued. That is what the plan originally said,
  // and it is wrong for THIS codebase, because there is no ingress. There are
  // NINE independent enqueue sites (the widget's /messages and /actions, Slack's
  // message and interactivity webhooks, three Telegram paths, Postmark inbound,
  // and the eval driver), each hand-rolling the same
  // open→insert→enqueue ritual, and no shared helper between them. Adding one
  // would make the limit A RULE EVERY CALL SITE MUST REMEMBER — including every
  // channel added after today, whose author has never heard of this file. That
  // is precisely the failure the A5 canary lesson warns about, in the comment
  // above CANARY_ARM_SQL: "not a rule to remember at each call site, but the
  // shape of the statement."
  //
  // So the check rides the shape of the system instead. EVERY customer turn, on
  // EVERY channel, in EITHER runtime, IS a default-kind job on QUEUE.CONVERSATION
  // and therefore arrives HERE. Not by convention — by construction: a channel
  // that does not enqueue a turn job is a channel whose agent never answers, so
  // there is no way for a new inbound path to exist and miss this. A helper can
  // be forgotten; processTurn cannot be bypassed.
  //
  // The same shape excludes what must not be limited, for free and structurally
  // rather than by a list someone has to maintain:
  //   • OPERATOR replies and PROACTIVE/send-agent-reply pushes are kind:'deliver'
  //     jobs. They are routed to processDeliver at the top of processConversation
  //     and never reach this function at all. This limit is on the CUSTOMER's
  //     inbound and nothing else; an operator answering a throttled customer is
  //     unaffected, which matters because throttling is exactly when a human
  //     tends to step in.
  //   • the approval-decision follow-up turn (processToolDecision) enqueues a
  //     real turn job, but its inbound row is role:'system'. The role test below
  //     is what keeps the platform's own follow-ups from being counted against
  //     the customer who is about to receive them.
  //
  // THE COST THIS ACCEPTS, stated plainly: a throttled message still costs one
  // enqueue and one dequeue that an ingress check would have saved. What it does
  // NOT cost is the turn — no brain, no classifier, no tools, no model call, no
  // history read, no typing pulse. A suppressed message is a row insert, a job
  // that returns in a few Redis ops, and nothing else, which keeps the phase's
  // scale claim intact: a throttled flood remains the cheapest thing the
  // platform does.
  //
  // FIRST-THING AND FREE WHEN OFF: the `subscriber_rate !== null` test comes
  // before everything, and the agent row is already in hand, so an unlimited
  // agent — which is every pre-A8 agent and the overwhelming majority of rows —
  // pays one null comparison and not a single Redis round trip. Only a limited
  // agent pays the INCR.
  let rateLimited = false;
  /** The notice to ship, or '' — non-empty ONLY on the first block of a window. */
  let rateNotice = '';
  if (
    // A10: pause wins over the limiter, and it wins by skipping the whole block
    // rather than by suppressing the notice at the end of it — a held turn
    // spends no Redis ops, and a paused agent can never tell a customer it is
    // too busy to answer when the truth is that it has been switched off.
    !paused &&
    agent.subscriber_rate !== null &&
    // Subscriber-authored inbound only. A button/card tap is a user row too (it
    // carries raw.action), and it counts: a tap flood enqueues turns exactly
    // like a typed flood and costs exactly as much, so exempting it would leave
    // the cheapest way to abuse an agent as the only unlimited one.
    message.role === 'user' &&
    !data.noRateLimit
  ) {
    const rate = resolveSubscriberRate(agent.subscriber_rate);
    if (rate) {
      let overCount = 0;
      let suppressedPreviousHour = 0;
      try {
        const count = await incrSubscriberInbound(
          agent.id,
          conversation.subscriber_id,
          rate.windowMinutes,
        );
        if (count > rate.maxMessages) {
          rateLimited = true;
          overCount = count;
          // Every suppressed message feeds the hourly tally, not just the first
          // — the alert's whole job is to say HOW BAD, and a tally that only
          // counted the messages that produced a notice would report the number
          // of windows rather than the number of messages.
          suppressedPreviousHour = (
            await incrSubscriberSuppressed(agent.id, conversation.subscriber_id)
          ).previousHour;
          // Exactly one caller per window wins this, so the customer is told
          // once no matter how many messages they push into a closed window.
          if (await claimSubscriberRateNotice(agent.id, conversation.subscriber_id, rate.windowMinutes)) {
            rateNotice = rate.notice;
          }
        }
      } catch (err) {
        // DEGRADE NEVER BLOCK — the same doctrine as the A7 gates, and worth
        // naming because the asymmetry runs the OPPOSITE way here. A gate that
        // fails open lets an unchecked reply through; a LIMITER that fails open
        // simply does not limit, which is what every agent did before A8. The
        // alternative is genuinely worse than the outage: a broken Redis that
        // throttled instead of skipping would mute every customer of every
        // limited agent, turning a counter's hiccup into a platform outage. A
        // limiter must never be the reason someone cannot talk to support.
        rateLimited = false;
        rateNotice = '';
        logger.warn(
          { err: (err as Error).message, agent: agent.identifier },
          'subscriber rate check unavailable — turn allowed through unlimited',
        );
      }

      if (rateLimited) {
        logExec({
          tenantId,
          transactionId: `conv-${conversationId}`,
          level: 'warn',
          detail: `subscriber ${subscriber.external_id} over the message limit for agent ${agent.identifier} (${overCount}/${rate.maxMessages} in ${rate.windowMinutes}m) — message stored, no turn run`,
        });
      }

      // The receipt and the ops flag, ONCE PER WINDOW (they ride the notice
      // claim). The 2nd..kth suppressed messages of a window deliberately write
      // nothing: their row in the transcript already IS the record that they
      // arrived, and a breadcrumb per message would turn a flood in the
      // conversation into the same flood in the Turn Inspector.
      if (rateNotice) {
        // Same idiom as the topic gate and reply rules: a NAMED KEY on a system
        // row, never `raw.action`. Action rows replay to the model as tool
        // calls, and a rate_limit action would teach the agent a phantom tool.
        // Its own string dedupe slot for the same reason 'reply-rules' has one.
        await systemNote(
          conversation,
          messageId,
          'rate-limit',
          `message limit reached: ${overCount} messages in ${rate.windowMinutes}m (limit ${rate.maxMessages}) — sent the configured notice, no turn ran`,
          {
            rateLimit: {
              maxMessages: rate.maxMessages,
              windowMinutes: rate.windowMinutes,
              count: overCount,
              blocked: true,
            },
          },
        );

        // Reserved ops alert, the P22 lookup-first idiom exactly: BOTH halves of
        // the reserved pair must exist before the hourly claim is spent, or a
        // tenant who never created the workflow silently burns the window.
        const opsApprover = await getApprovalsSubscriber(tenantId);
        const opsWorkflow = opsApprover && (await getWorkflow(tenantId, 'agent-approvals'));
        if (
          opsApprover &&
          opsWorkflow &&
          (await claimSubscriberRateNotify(agent.id, conversation.subscriber_id))
        ) {
          await internalTrigger({
            tenantId,
            workflowKey: 'agent-approvals',
            to: [
              {
                subscriberId: opsApprover.external_id,
                email: opsApprover.email ?? undefined,
                phone: opsApprover.phone ?? undefined,
                pushToken: opsApprover.push_token ?? undefined,
              },
            ],
            // WHO AND HOW MUCH — NEVER WHAT. Not one character of the customer's
            // messages travels in this payload, and that is not squeamishness:
            // this alert is delivered by a workflow the TENANT wrote, whose steps
            // can email or SMS it anywhere. The reply-rules alert omits the
            // matched text for that reason; the argument is stronger here,
            // because a flood is often someone upset, and the thing they are
            // flooding an agent with is frequently the most sensitive thing they
            // have said. Ops gets the person, the conversation, the configured
            // limit, and the size of the last hour — everything needed to decide
            // whether to act, and nothing needed to be indiscreet. The content is
            // in Postgres, where it was already.
            payload: {
              agentIdentifier: agent.identifier,
              subscriberExternalId: subscriber.external_id,
              conversationId,
              maxMessages: rate.maxMessages,
              windowMinutes: rate.windowMinutes,
              // The PREVIOUS hour, for the reason spelled out in
              // incrSubscriberSuppressed: this hour's count is 1 at the moment
              // the alert fires and says nothing at all.
              suppressedPreviousHour,
            },
            transactionId: `subscriber-rate-alert-${messageId}`,
            source: `agent ${agent.identifier} subscriber rate limit`,
          }).catch((err) => {
            // A notification hiccup must not fail a turn that is already
            // finished doing anything a customer can see.
            logger.warn({ err: (err as Error).message }, 'subscriber-rate ops notification failed');
          });
        }
      }
    }
  }

  // THE FLOOD'S EXIT. From the second suppressed message of a window onward
  // there is nothing left to do: the row landed (the transcript stays truthful),
  // the customer has already been told once, and the breadcrumb already exists.
  // Return before the history read and the typing pulse — this is the cheap path
  // a flood spends almost all of its messages on.
  //
  // The FIRST suppressed message does NOT return here. It falls through with the
  // notice in hand so the notice ships on THE ORDINARY REPLY PATH below — same
  // insert, same dedupe key, same deliverReply, same WS and channel behavior —
  // exactly like the topic gate's redirect and the budget note. Nothing
  // downstream needs to know a limiter exists, and no channel needs a special
  // case to deliver a throttle notice.
  //
  // A10 folds into the same shape. `noBrain` is ONE predicate for "this turn
  // runs no model", deliberately named for the consequence rather than for
  // either cause, so a stage added below cannot be guarded against the limiter
  // and forget the kill-switch. `platformNotice` is the single line of canned
  // prose either of them wants to ship; the two can never both be set, because
  // pause skips the limiter's block entirely.
  const noBrain = rateLimited || paused;
  const platformNotice = rateNotice || pausedNotice;

  /**
   * A10: put this conversation in front of a person, reusing P26's real
   * transition rather than writing `status` by hand — that one call is what
   * makes the operator queue list it, the dashboard's live view update, the D2
   * gate hold the customer's NEXT message, and handback work afterwards. A
   * hand-rolled UPDATE would have given the first of those four and quietly
   * broken the rest.
   *
   * Idempotent where it matters: the transition is guarded on `status =
   * 'active'`, so re-asserting a hold on a conversation a human already owns
   * writes nothing and emits nothing. Calling it blind is the correct usage.
   *
   * NOT UNDONE ON RESUME, and that is P26 semantics, unchanged: clearing
   * `paused_at` makes new turns run normally, but a conversation sitting in the
   * queue stays with the human who owns it until they hand it back. A sweep
   * that yanked conversations back from operators the moment someone hit Resume
   * would be a second incident. There is nothing to un-pause.
   */
  const holdForHumans = async (): Promise<void> => {
    if (!(await setConversationWaitingHuman(conversationId))) return;
    logExec({
      tenantId,
      transactionId: `conv-${conversationId}`,
      level: 'info',
      detail: `paused agent ${agent.identifier}: conversation moved to waiting_human for a person to pick up`,
    });
  };

  if (noBrain && !platformNotice) {
    // A HELD turn does not take the cheap exit, because the hold has to be
    // re-asserted whether or not there is anything left to say: the only way to
    // arrive here paused-and-silent is a conversation that was handed back to
    // the agent while the pause was still on, and returning now would strand
    // that customer in an `active` conversation nobody is answering.
    if (!paused) return;
    await holdForHumans();
    return;
  }

  // Skipped for a throttled or held turn: the notice is canned platform text
  // that needs no history to write, and a "composing" pulse would promise a
  // reply the limiter (or the pause) has already decided not to produce.
  const history = noBrain ? [] : await conversationHistoryBefore(conversationId, messageId);

  // Turn-start "composing" pulse for both runtimes; the managed branch pulses
  // again on each model call via the onModelCall hook.
  const emitTyping = typingEmitter(conversation, subscriber.external_id, agent);
  if (!noBrain) emitTyping();

  // The brain branch: who answers this turn. Everything after (reply row,
  // channel delivery, signals, breadcrumbs) is identical for both runtimes.
  let reply: string | undefined;
  let buttons: Array<{ id: string; label: string }> | undefined;
  let card: Card | undefined;
  let signals: BridgeSignal[] = [];
  let turnUsage: TurnUsage | undefined;
  let turnTrace: TurnTrace | undefined;
  // True when the managed turn returned a PLATFORM-authored reply (the
  // reasoning-leak fallback note) — tagged raw.platformNote on the stored row so
  // buildHistory excludes it from replay, exactly like the budget-pause note.
  let replyPlatformNote = false;
  // A8: the throttle notice rides the ordinary reply path from here. Tagged
  // platformNote for the same reason the redirect and the budget note are: it is
  // canned platform prose, not the model's words, so buildHistory must never
  // replay it as an assistant turn — un-tagged, it is exactly the imitable text
  // that got the budget note parroted back verbatim (lesson §13). The tag matters
  // more here than anywhere: an agent that learned to imitate its own throttle
  // notice would start telling unthrottled customers to slow down.
  //
  // A10's holding line rides the identical path for the identical reason, and
  // the tag is load-bearing in the same way: an agent that learned to imitate
  // "our team is taking over this conversation" would start handing off
  // conversations nobody handed off.
  if (platformNotice) {
    reply = platformNotice;
    replyPlatformNote = true;
  }
  // A5 slice B: the canary version that actually served this turn (undefined =
  // the live config did). Declared out here beside replyPlatformNote because
  // the reply row is written below, outside the managed branch that sets it.
  let servedCanaryVersion: number | undefined;
  // A6: what the router did with this turn (undefined = routing was off for it,
  // which is every bridge turn and every managed turn on an unrouted agent).
  // Same per-turn attribution argument as canaryVersion above: the agent's
  // routing CONFIG says what may happen, only the turn says what did — and the
  // difference is the escalation rate, i.e. the whole cost model.
  let turnRouting: TurnRouting | undefined;
  // The streaming plan card (managed, non-email): posts ONE evolving agent
  // message on the first labelable tool call and finalizes it as the reply.
  let planCard: PlanCard | undefined;

  // G2 DAILY TOKEN BUDGET: enforced BEFORE any model call. When the agent's
  // UTC-day token counter has reached its cap, skip the brain entirely and ship
  // a deterministic note through the normal reply path (one job = one finalize).
  // The Redis counter is fast+approximate; Postgres raw.usage stays the truth.
  let budgetExhausted = false;
  // A8/A10: `!noBrain` on every stage from here down. A throttled turn — or a
  // turn held by the kill-switch — has already decided nothing will run;
  // reading the budget, the canary snapshot or the topic classifier for it
  // would spend queries (and, for the gate, tokens) to reach an answer that
  // cannot change the outcome. This is also the line that makes the pause a
  // real pause rather than a suppressed reply: NO brain, NO classifier, NO
  // tools, NO routing, and — in the bridge branch far below — no POST to the
  // customer's own service either.
  if (agent.runtime === 'managed' && !noBrain && agent.max_daily_tokens != null) {
    const used = await getDayTokens(agent.id);
    if (used >= agent.max_daily_tokens) {
      budgetExhausted = true;
      reply = BUDGET_EXHAUSTED_NOTE;
      // Breadcrumb the skip with used/limit in raw (no model call happened, so
      // no usage/trace ride the reply — this system row carries the record).
      await systemNote(
        conversation,
        messageId,
        0,
        `budget exhausted (${used}/${agent.max_daily_tokens} tokens today)`,
        { budgetExhausted: { used, limit: agent.max_daily_tokens } },
      );
      logExec({
        tenantId,
        transactionId: `conv-${conversationId}`,
        level: 'warn',
        detail: `agent ${agent.identifier} daily token budget exhausted (${used}/${agent.max_daily_tokens}) — turn skipped, no model call`,
      });

      // Reserved ops alert (Phase 18 lookup-first pattern): tell the tenant's
      // 'approvals' ops audience the agent went quiet — but ONLY if they opted
      // in by creating BOTH the reserved 'approvals' subscriber and the
      // 'agent-approvals' workflow. NEVER blind-fire: the trigger fanout upserts
      // unknown recipients, so firing without the lookup would mint a phantom,
      // channel-less subscriber (Phase 18 lesson). Debounced to one alert per
      // agent per UTC day via a Redis claim; content-keyed txn makes a job
      // retry a dupe no-op.
      // BOTH halves of the reserved pair must exist BEFORE the day-claim is
      // spent — claiming first and then failing to trigger (e.g. workflow not
      // yet created) silently loses the alert for the whole day. E2E-found.
      const opsApprover = await getApprovalsSubscriber(tenantId);
      const opsWorkflow = opsApprover && (await getWorkflow(tenantId, 'agent-approvals'));
      if (opsApprover && opsWorkflow && (await claimBudgetNotify(agent.id))) {
        await internalTrigger({
          tenantId,
          workflowKey: 'agent-approvals',
          to: [
            {
              subscriberId: opsApprover.external_id,
              email: opsApprover.email ?? undefined,
              phone: opsApprover.phone ?? undefined,
              pushToken: opsApprover.push_token ?? undefined,
            },
          ],
          payload: { agentIdentifier: agent.identifier, usedTokens: used, limit: agent.max_daily_tokens },
          transactionId: `budget-alert-${messageId}`,
          source: `managed agent ${agent.identifier} budget`,
        }).catch((err) => {
          // A notification hiccup must not fail the (already-skipped) turn.
          logger.warn({ err: (err as Error).message }, 'budget-exhausted ops notification failed');
        });
      }
    }
  }

  // ---- A5 slice B: canary injection ----
  // HOISTED (A7) out of the managed branch below, because the topic gate runs
  // BEFORE the brain and has to know which config governs this turn: a candidate
  // may carry its own topic policy. The guard is the branch's own, so a
  // budget-exhausted or bridge turn still resolves nothing and reads nothing.
  let turnCandidate: CandidateConfig | undefined;
  if (agent.runtime === 'managed' && !budgetExhausted && !noBrain) {
    // A canary is not a second override mechanism: it is the A4 candidate knob
    // aimed at real traffic. The arm was decided once when the conversation
    // opened; all that happens per turn is one PK read of the snapshot.
    //
    // REVERT SEMANTICS (deliberate): the condition re-checks the AGENT every
    // turn, not just the conversation's arm. If the trial was stopped or
    // promoted since this thread opened, `agent.canary_version` is null (or now
    // points elsewhere) and this thread silently returns to the live prompt at
    // its very next turn. Stop therefore means stop — immediately and
    // everywhere — instead of leaving already-opened threads stranded on a
    // config the operator has just rejected. The arm column stays as it is:
    // it records what the thread was ENROLLED in, which is what slice C needs
    // to attribute the turns that did run under the trial.
    let canaryCandidate: CandidateConfig | undefined;
    if (conversation.canary_arm === 'canary' && agent.canary_version !== null) {
      const snapshot = await getAgentPromptVersion(agent.id, agent.canary_version);
      // A missing snapshot (version deleted underneath a running trial) is not
      // an error worth failing a customer's turn over — fall through to live.
      if (snapshot) {
        canaryCandidate = {
          systemPrompt: snapshot.system_prompt ?? undefined,
          // The snapshot is reproduced EXACTLY, including "no pinned model":
          // a bare `undefined` here would silently inherit the agent's CURRENT
          // model (see the brain's `candidate.model ?? agent.model ??
          // DEFAULT_MODEL`), so a version saved with no model would be trialled
          // on the wrong one. Resolving the default here keeps the trial honest.
          model: snapshot.model ?? DEFAULT_MODEL,
        };
        servedCanaryVersion = snapshot.version;
      }
    }
    // PRECEDENCE: an eval run's candidate always wins over a canary. The two
    // should not co-occur (eval conversations opt out of canaries at open, so
    // their arm is null), but if one ever did, the run must grade the config it
    // was asked to grade — a trial silently overriding it would corrupt the
    // scores. Never merged field-by-field: a half-canary/half-candidate prompt
    // is a config that no one chose and no one could reproduce.
    turnCandidate = data.evalCandidate ?? canaryCandidate;
    if (data.evalCandidate) servedCanaryVersion = undefined;
  }

  // ---- Phase A7 slice A: THE TOPIC GATE ----
  // One small classifier call, BEFORE the brain — and therefore before A6's
  // router, so a single classification governs the turn no matter which model
  // would then have served it. Off unless the agent (or the candidate under
  // grading) carries a coherent policy, which is every pre-A7 agent.
  //
  // A blocked turn ships the operator's CANNED redirect through the ordinary
  // reply path below — same insert, same dedupe key, same deliverReply, same WS
  // and channel behavior — so nothing downstream needs to know a gate exists.
  // The brain never runs, which is the safety property AND the cost one.
  //
  // Managed only: a bridge agent's brain is the customer's own code behind a
  // signed URL, and we do not stand between them and their own service (the
  // same law routing, versions and canaries state at their own surfaces).
  let topicBlocked = false;
  if (agent.runtime === 'managed' && !budgetExhausted && !noBrain) {
    const gate = resolveTopics(topicsForTurn(agent.topics, turnCandidate));
    if (gate) {
      const model = topicGateModel(agent, turnCandidate);
      // `history` is the user/agent window already loaded for this turn — the
      // gate adds no query. It never throws: a classifier that cannot answer
      // returns 'skipped' and the turn proceeds ungated (see topic-gate.ts).
      const result = await runTopicGate({
        agent,
        gate,
        model,
        message: message.content,
        history,
      });
      if (result.verdict !== 'skipped') {
        // The gate spent the customer's tokens like anything else does; G2's
        // day counter must see them, or a gated agent's cheapest turns would be
        // the only ones its budget cannot feel.
        await incrDayTokens(agent.id, result.usage.inputTokens + result.usage.outputTokens);
      }
      if (result.verdict === 'blocked') {
        topicBlocked = true;
        reply = gate.redirect;
        // The redirect is PLATFORM-authored, not the model's words: tagged
        // platformNote on the row below so buildHistory never replays it as an
        // assistant turn. Un-tagged, it is exactly the imitable prose that got
        // the budget note parroted back verbatim (lesson §13).
        replyPlatformNote = true;
        // WHY this customer got a canned sentence, for the Turn Inspector. NOT
        // written as `raw.action`: that is the TOOL-breadcrumb shape, and the
        // brain replays action rows to the model as tool calls — a topic_gate
        // action would teach the agent it has a tool it does not have. So the
        // budget-note idiom instead: a named key of its own on a system row,
        // which replay correctly ignores.
        await systemNote(
          conversation,
          messageId,
          0,
          `off-topic: classified "${result.label}" (${result.list} list) — sent the configured redirect, no model reply`,
          {
            topicGate: {
              label: result.label,
              list: result.list,
              model: result.model,
              blocked: true,
            },
            // One model call happened even though the brain never ran; the row
            // that records the skip is the row that carries its cost.
            usage: {
              inputTokens: result.usage.inputTokens,
              outputTokens: result.usage.outputTokens,
              modelCalls: 1,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
            },
          },
        );
        logExec({
          tenantId,
          transactionId: `conv-${conversationId}`,
          level: 'info',
          detail: `topic gate: "${result.label}" (${result.list} list) — redirect sent, brain skipped`,
        });
      }
      // AND NOTHING IS WRITTEN WHEN THE MESSAGE IS IN LANE. The asymmetry is
      // deliberate: a blocked turn needs a receipt because the customer got a
      // reply nobody wrote, while an in-lane turn is just a normal turn — and a
      // breadcrumb on every one of those, forever, is a row per turn of storage
      // and a line of noise in every transcript to record that nothing happened.
    }
  }

  if (agent.runtime === 'managed' && !budgetExhausted && !topicBlocked && !noBrain) {
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
      // them in so past tool-backed replies don't look like bare claims. D8:
      // rolling_upto narrows the window to the un-summarized tail (folded turns
      // and their breadcrumbs drop out); rolling_summary rides the system block.
      const fullHistory = await conversationTranscriptBefore(
        conversationId,
        messageId,
        40,
        conversation.rolling_upto,
      );
      const turn = await runManagedTurn(agent, conversation, subscriber, fullHistory, message, {
        // Once the plan card is live it carries the "working" signal; keep the
        // typing pulse only for the pre-card model rounds.
        onModelCall: () => {
          if (!planCard?.posted) emitTyping();
        },
        onToolCall: planCard?.onToolCall,
        onToolResult: planCard?.onToolResult,
        // A4: a candidate eval run's override, or (A5) the canary version this
        // conversation was enrolled in — resolved above, eval wins. Reached
        // only inside this managed branch, so a bridge agent can never be run
        // on a candidate config even if a job somehow carried one.
        ...(turnCandidate ? { candidate: turnCandidate } : {}),
      });
      reply = turn.reply ?? undefined;
      buttons = turn.buttons;
      card = turn.card;
      turnUsage = turn.usage;
      turnTrace = turn.trace;
      turnRouting = turn.routing;
      replyPlatformNote = turn.platformNote ?? false;

      // ---- Phase A7 slice B: REPLY RULES, the outbound gate ----
      // RIGHT HERE, and the position is the design: this is the one point where
      // BOTH reply paths still converge. Below, the turn forks — a posted plan
      // card finalizes into its own row, everything else falls through to the
      // insert further down — and a check on either fork alone would leave the
      // other shipping unchecked. Nothing between the brain returning and this
      // line can send anything to a customer.
      //
      // It reads `reply`/`buttons`/`card`, the locals just assigned from `turn`,
      // and REWRITES them on a block, so both forks below carry the fallback
      // without either needing to know a gate exists (the finalize call was
      // switched from `turn.*` to these locals for exactly that reason).
      //
      // Off unless the agent (or the candidate under grading) carries coherent
      // rules, which is every pre-A7 agent. Managed only, like every other A7
      // gate: a bridge agent's reply is the customer's own code talking, and we
      // do not edit their words on their way out.
      const rules = resolveModeration(moderationForTurn(agent.moderation, turnCandidate));
      const verdict =
        rules && reply
          ? checkReply(reply, rules, { email: subscriber.email, phone: subscriber.phone })
          : { blocked: false as const };
      if (rules && verdict.blocked) {
        // NOT the topic-gate redirect, and not the budget note: both are set
        // before the brain branch and short-circuit past it, so platform-authored
        // canned text never reaches this check. That exemption is deliberate and
        // worth naming — running an operator's own redirect against their own
        // deny phrases is circular, and the one outcome it can produce is an
        // operator whose redirect blocks itself into a second canned sentence.
        // The gate exists to check what the MODEL wrote.
        reply = rules.fallback;
        // Platform-authored, so tagged exactly like the redirect: buildHistory
        // must never replay it as an assistant turn, or the agent learns to
        // imitate its own fallback (the budget-note parroting lesson, §13).
        replyPlatformNote = true;
        // THE BUTTONS AND THE CARD GO WITH IT. They were drafted in the same
        // breath as the blocked sentence and are answers to it — "Yes, refund
        // it" under a fallback that no longer offers a refund is worse than no
        // buttons at all. The fallback ships BARE.
        buttons = undefined;
        card = undefined;
        // THE HONEST TENSION, stated where the code makes the trade: the turn's
        // tools have ALREADY RUN by now. If the model issued a refund and then
        // wrote a sentence that tripped a rule, the refund happened and the
        // customer is about to be told something static that cannot mention it.
        // Suppressing the reply cannot un-issue it, and inventing a sentence
        // about it would be the model freestyle this gate exists to prevent.
        // So the fallback ships as written, and the ONE mitigation is editorial:
        // an operator's fallback must be written knowing actions may have
        // completed. "A teammate will follow up on this" is safe; "I wasn't able
        // to help with that" can be a lie. Slice C's helper copy says so at the
        // point the operator types it. For the same reason nothing here rolls
        // back `turn.resolved` or the tool breadcrumbs: what happened, happened.
        const tally = await incrReplyBlockCount(agent.id);
        // The receipt, and the ONLY place the blocked text survives. Same idiom
        // as the topic gate: a named key on a system row, NOT `raw.action` —
        // action rows replay to the model as tool calls, and a reply_rules
        // action would teach the agent a phantom tool. A string signal index
        // because 0 is the turn-note slot and a managed turn can carry both.
        await systemNote(
          conversation,
          messageId,
          'reply-rules',
          `reply blocked by the ${verdict.rule} rule (${verdict.match}) — sent the configured fallback`,
          {
            replyRules: {
              rule: verdict.rule,
              match: verdict.match,
              // What the model actually wrote. Kept because a fallback with no
              // record of what it replaced is untriageable: the operator cannot
              // tell a leak they were saved from apart from a rule that is too
              // broad, and those need opposite fixes.
              blockedText: turn.reply,
              blocked: true,
            },
          },
        );
        logExec({
          tenantId,
          transactionId: `conv-${conversationId}`,
          level: 'warn',
          detail: `agent ${agent.identifier} reply blocked by reply rules (${verdict.rule}) — fallback sent`,
        });
        // Reserved ops alert, the P22 idiom exactly (Phase 18 lookup-first: both
        // halves of the reserved pair must exist BEFORE the claim is spent, or a
        // tenant who has not created the workflow silently burns the window).
        // Debounced per agent per HOUR, not per day like the budget alert —
        // see claimReplyRulesNotify for why the two windows differ.
        const opsApprover = await getApprovalsSubscriber(tenantId);
        const opsWorkflow = opsApprover && (await getWorkflow(tenantId, 'agent-approvals'));
        if (opsApprover && opsWorkflow && (await claimReplyRulesNotify(agent.id))) {
          await internalTrigger({
            tenantId,
            workflowKey: 'agent-approvals',
            to: [
              {
                subscriberId: opsApprover.external_id,
                email: opsApprover.email ?? undefined,
                phone: opsApprover.phone ?? undefined,
                pushToken: opsApprover.push_token ?? undefined,
              },
            ],
            // A POINTER, NOT THE PAYLOAD. `match` and the blocked text stay in
            // Postgres. This alert is delivered by a workflow the TENANT wrote,
            // whose steps can email or SMS it anywhere; forwarding the matched
            // address would take the phone number we just stopped leaking to one
            // customer and post it somewhere we do not control. Ops gets the
            // rule, the conversation, and how bad the hour before was.
            payload: {
              agentIdentifier: agent.identifier,
              rule: verdict.rule,
              conversationId,
              blockedPreviousHour: tally.previousHour,
            },
            transactionId: `reply-rules-alert-${messageId}`,
            source: `managed agent ${agent.identifier} reply rules`,
          }).catch((err) => {
            // A notification hiccup must not fail a turn whose customer is
            // already getting a safe answer.
            logger.warn({ err: (err as Error).message }, 'reply-rules ops notification failed');
          });
        }
      }

      // If a plan card was posted, its row IS the reply row — finalize it now
      // (the final edit becomes the reply). The locals (post-gate) carry the
      // extras; a no-reply turn (note/refusal/empty) finalizes to the same note
      // string.
      if (planCard?.posted) {
        if (reply) {
          await planCard.finalize(reply, {
            buttons,
            card,
            usage: turn.usage,
            trace: turn.trace,
            platformNote: replyPlatformNote,
            canaryVersion: servedCanaryVersion,
            routing: turn.routing,
          });
        } else {
          await planCard.finalize(turn.note ?? 'the model produced no reply text', {
            usage: turn.usage,
            trace: turn.trace,
            canaryVersion: servedCanaryVersion,
            routing: turn.routing,
          });
        }
      }
      // No reply row to carry the usage/trace? The note breadcrumb carries them.
      if (turn.note) {
        await systemNote(
          conversation,
          messageId,
          0,
          turn.note,
          reply ? undefined : { usage: turn.usage, trace: turn.trace },
        );
      }
      // G2: fold this turn's real spend into the UTC-day counter. Counted per
      // successful model turn — a downstream delivery retry re-runs the model,
      // so re-counting mirrors the tokens actually spent (approximate by design).
      await incrDayTokens(agent.id, turn.usage.inputTokens + turn.usage.outputTokens);
      if (turn.resolved && conversation.channel === 'inapp') {
        await publishConversationEvent(conversation, subscriber.external_id, agent, {
          type: 'conversation.resolved',
        });
      }
      // Phase 23 (D7): a resolved managed conversation gets summarized + embedded
      // off the hot path (idempotent jobId; the job self-filters trivial/bridge).
      if (turn.resolved) await enqueueSummarize(tenantId, conversationId);
      // Phase 25 (slice A): admin dashboard hint, ALL channels (not just inapp) —
      // fire-and-forget after the resolve write (row-then-hint). Slice B sweeps
      // the remaining conversation emit points (reply/status/fold).
      if (turn.resolved) {
        void emitTenantEvent(conversation.tenant_id, 'conversation.changed', conversation.id);
      }

      // Phase 24 (D6/D7): rolling-fold trigger. Reuse the history ALREADY loaded
      // for this turn (already the post-rolling_upto window) — NO second load —
      // and the agent's knobs. When the un-summarized replayable turns exceed the
      // trigger, or their serialized text exceeds the token guard, enqueue an
      // idempotent fold on the knowledge queue. Skip a resolved conversation:
      // episodic summarization owns its close-out, and no more turns will arrive.
      if (!turn.resolved) {
        const knobs = resolveRollingKnobs(agent.context);
        const replayable = fullHistory.filter(isReplayableTurn);
        if (shouldFold(replayable.length, serializeFoldInput(fullHistory, null), knobs)) {
          await enqueueRollingFold(tenantId, conversationId, messageId);
        }
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
        // A13: the note carries how far the turn got, under the SAME `raw.trace`
        // key the successful paths use (the reply row and the turn-note
        // breadcrumb above), so every trace reader is already pointed at it and
        // the inspector needs no second lookup. `crashed` is the flag that says
        // this trace ends in a death rather than a delivery — a raw flag, the
        // reasoningLeak idiom, not a second shape for the trace itself.
        const partial = partialTraceOf(err);
        await systemNote(
          conversation,
          messageId,
          0,
          err.message,
          partial ? { trace: partial, crashed: true } : undefined,
        );
        logExec({
          tenantId,
          transactionId: `conv-${conversationId}`,
          level: 'error',
          detail: `managed brain permanent failure: ${err.message}`,
        });
        return;
      }
      // Retryable: the job must still fail so BullMQ's accounting stays honest.
      // On the LAST attempt, the dead note is written here first — while the
      // trace is still in memory (see noteCrashedTurn).
      await noteCrashedTurn(conversation, messageId, err, job);
      throw err;
    }
    // A8: the limit is INGRESS protection, not brain config, so it applies to a
    // bridge agent too — the one A5-A7-era knob that does. A flood costs the
    // customer's own service its compute and its bill; declining to protect it
    // because the brain is theirs would be a courtesy nobody asked for.
    //
    // A10 lands on the same side, and it is the reason `noBrain` is checked
    // here rather than only in the managed branch above: a bridge agent
    // mid-incident is exactly the agent someone needs to switch off, and the
    // operator holding the button often cannot deploy a fix to the customer
    // code at all. For a bridge agent the pause means precisely one thing —
    // ITS WEBHOOK STOPS BEING CALLED. No POST leaves this process, so whatever
    // the customer's service is doing wrong, it stops doing it to this
    // agent's traffic the moment the button is pressed.
  } else if (agent.runtime === 'bridge' && !noBrain) {
    try {
      const dispatched = await dispatchToBridge(agent, conversation, subscriber, message, history);
      reply = dispatched.reply;
      buttons = dispatched.buttons;
      card = dispatched.card;
      signals = dispatched.signals;
      turnTrace = dispatched.trace;
    } catch (err) {
      // Same doctrine as the managed branch: a config-shaped failure
      // (missing/blocked bridge URL) can't be fixed by retrying — surface
      // it in the transcript and stop, instead of burning attempts.
      if (err instanceof PermanentError) {
        // A13, same contract as the managed branch: raw.trace + raw.crashed.
        // For a bridge agent the trace is the attempted POST (status 0 when the
        // dial itself failed) plus the error — see bridgeFailureTrace.
        const partial = partialTraceOf(err);
        await systemNote(
          conversation,
          messageId,
          0,
          err.message,
          partial ? { trace: partial, crashed: true } : undefined,
        );
        logExec({
          tenantId,
          transactionId: `conv-${conversationId}`,
          level: 'error',
          detail: `bridge dispatch permanent failure: ${err.message}`,
        });
        return;
      }
      await noteCrashedTurn(conversation, messageId, err, job);
      throw err;
    }
  }

  if (reply !== undefined && reply.length > 0) {
    // Hoisted out of both branches so the A5 slice C judge hook below can see
    // the row whichever way it was written (plan-card finalize or fresh insert).
    let replyRow: ConversationMessage | null = null;
    if (planCard?.finalized) {
      // The plan-card row IS the reply row: finalize already set its content,
      // merged raw (usage/buttons/card), and pushed the channel edit. Do NOT
      // re-write raw (that would clobber finalize's merge) — just re-run the
      // send-once delivery guard for retry safety (it no-ops sends already
      // made; the inapp branch republishes conversation.message, which the
      // widget drops as a known id).
      replyRow = await getConversationMessageByDedupe(conversationId, `reply-${messageId}`);
      if (replyRow) {
        await deliverReply(conversation, subscriber.external_id, agent, replyRow, message);
      }
    } else {
      // Retry-safe in two layers: the dedupe key stops a duplicate ROW, and
      // deliverReply's send-once guard stops a duplicate SEND when a prior
      // attempt crashed between inserting the row and delivering it.
      replyRow =
        (await insertConversationMessage({
          conversationId,
          tenantId,
          role: 'agent',
          content: reply,
          dedupeKey: `reply-${messageId}`,
          // Usage + trace from managed turns (trace also carries the bridge_post
          // event on a bridge reply); buttons/card from either runtime.
          // platformNote marks a PLATFORM-authored reply (the budget-pause note)
          // — it is not the model's words, so buildHistory must NOT replay it as
          // an assistant turn (GLM parroted it verbatim on later turns once the
          // budget cleared — the lesson-§13 imitable-prose trap).
          // A5 slice B: which canary version actually SERVED this turn. The
          // conversation's arm alone cannot answer that — a thread enrolled in
          // a trial keeps arm='canary' after the trial is stopped, but its
          // later turns ran the live prompt (see the revert semantics above).
          // Counting those as canary turns would quietly poison slice C's
          // per-arm comparison, so attribution is recorded per turn, here,
          // where the row is written anyway: no new column, no extra write.
          // A6: raw.routing records which model actually SERVED this reply and
          // whether the turn escalated. Additive and ABSENT when routing was off
          // — a pre-A6 row and an unrouted row stay byte-identical.
          // A10: raw.pausedHold marks THE holding line. It is not decoration —
          // this row IS the once-per-conversation claim that pausedHoldNoticeSent
          // reads, so a conversation can never be apologised to twice, and the
          // Turn Inspector can point at the exact message where the kill-switch
          // took over. Absent on every other reply, paused or not.
          raw:
            turnUsage ||
            turnTrace ||
            buttons ||
            card ||
            budgetExhausted ||
            replyPlatformNote ||
            servedCanaryVersion ||
            turnRouting ||
            pausedNotice
              ? {
                  ...(turnUsage ? { usage: turnUsage } : {}),
                  ...(turnTrace ? { trace: turnTrace } : {}),
                  ...(buttons ? { buttons } : {}),
                  ...(card ? { card } : {}),
                  ...(budgetExhausted || replyPlatformNote ? { platformNote: true } : {}),
                  ...(servedCanaryVersion ? { canaryVersion: servedCanaryVersion } : {}),
                  ...(turnRouting ? { routing: turnRouting } : {}),
                  ...(pausedNotice ? { pausedHold: true } : {}),
                }
              : undefined,
        })) ?? (await getConversationMessageByDedupe(conversationId, `reply-${messageId}`));
      if (replyRow) {
        await deliverReply(conversation, subscriber.external_id, agent, replyRow, message);
      }
    }
    // Phase 25 (slice B): the agent reply was persisted — the two slice-A points
    // cover resolve only. Fire-and-forget after the row write (row-then-hint),
    // ALL channels, so the admin transcript + list update live for replies.
    void emitTenantEvent(conversation.tenant_id, 'conversation.changed', conversation.id);

    // A5 slice C: roll for a sampled judgment of THIS reply.
    //
    // Placed here on purpose — after the row is written AND after deliverReply
    // has sent it. The customer's answer is already gone by the time the coin is
    // flipped, so judging cannot delay it. `void` is safe because
    // judgeTurnIfSampled never rejects (it swallows and logs its own failures),
    // so a down Redis or a broken judge queue costs a data point and nothing
    // else. Sampling BOTH arms at the same rate is what makes the two averages
    // comparable; the trial-is-running and enrolled-arm checks live inside.
    if (replyRow) {
      void judgeTurnIfSampled({
        agent,
        arm: conversation.canary_arm,
        tenantId: conversation.tenant_id,
        conversationId: conversation.id,
        messageId: replyRow.id,
        // What ACTUALLY served this turn — the same value stamped into
        // raw.canaryVersion above, so a post-Stop turn in a canary-arm thread
        // is judged (and stored) as the control observation it really is.
        canaryVersion: servedCanaryVersion ?? null,
      });
    }
  }

  // A10: the hold goes in AFTER the holding line has been written and sent, and
  // the order is the whole point. Flipping the conversation to waiting_human
  // first would put it behind the D2 gate at the top of this function, so a
  // crash between the flip and the insert would leave the retry bouncing off D2
  // and the customer never hearing anything at all. Speaking first and holding
  // second makes the failure self-healing instead: the customer has the line,
  // and the very next message re-enters this gate and re-asserts the hold.
  if (paused) await holdForHumans();

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
      // G4: wall-clock the signed POST on the approval-resume path too.
      const postStart = Date.now();
      const { result, isError } = await postCustomToolCall(
        def,
        call.id,
        call.args,
        agent,
        conversation,
        subscriber,
      );
      const durationMs = Date.now() - postStart;
      // Atomic claim from 'approved'; a null loser means a prior attempt already
      // executed — reuse its stored row instead of double-counting the POST.
      const claimed = await finishToolCall(
        call.id,
        isError ? 'failed' : 'executed',
        result,
        'approved',
        durationMs,
      );
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

  // Finalize any channel approval cards posted at pause time: rewrite each to
  // its outcome text-only (which strips the Approve/Deny buttons on Slack, and
  // omits the keyboard on Telegram). WHOLLY best-effort per card — a failed
  // edit is logged and skipped; the decision has already landed in Postgres.
  for (const ref of call.cards ?? []) {
    try {
      const conn = await getConnectionById(ref.connectionId);
      if (!conn || conn.status !== 'active' || conn.tenant_id !== tenantId) continue;
      const { botToken } = JSON.parse(openSecret(conn.credentials)) as { botToken: string };
      let cardText: string;
      if (outcomeWord === 'executed') {
        // finalResult (not call.result): on the fresh-approval path the local
        // call row predates the POST, so its result is still null — finalResult
        // is the freshly computed, accurate execution result.
        const snippet = finalResult.slice(0, 140);
        cardText = `✓ approved by ${call.decided_by} — executed${snippet ? `\n${snippet}` : ''}`;
      } else if (outcomeWord === 'failed') {
        cardText = `✓ approved by ${call.decided_by} — execution failed`;
      } else if (outcomeWord === 'denied') {
        cardText = `✗ denied by ${call.decided_by}${call.note ? `: ${call.note}` : ''}`;
      } else {
        cardText = `⏱ expired (24h) — no decision`;
      }
      if (ref.channel === 'slack') {
        await slack.update(botToken, ref.channelId, ref.ts, cardText);
      } else {
        await telegram.editMessageText(botToken, ref.chatId, ref.messageId, cardText);
      }
    } catch (err) {
      logExec({
        tenantId,
        transactionId: `conv-${conversationId}`,
        level: 'warn',
        detail: `approval card finalize failed (${ref.channel}): ${(err as Error).message}`,
      });
    }
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
  trace?: TurnTrace;
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

  // D4 bridge parity: wall-clock the signed outbound POST and emit a bridge_post
  // event — the bridge runtime's twin of the managed model_call trace.
  //
  // A13: the failure paths are traced too. postSignedToBridge pins a partial
  // trace to everything it throws (see bridgeFailureTrace); this function owns
  // the one failure it can reach on its own — a 2xx whose BODY is not a bridge
  // response — and that trace carries the real bridge_post event plus the error,
  // which is precisely the pair that tells an operator "your service answered,
  // fast, with the wrong shape".
  const postStart = Date.now();
  const response = await postSignedToBridge(agent, rawBody);
  const postMs = Date.now() - postStart;
  const post: TurnTraceEvent = { t: 'bridge_post', ms: postMs, status: response.status, ok: response.ok };
  const trace: TurnTrace = { totalMs: postMs, events: [post] };
  const parsed = BridgeResponseSchema.safeParse(await response.json().catch(() => null));
  if (!parsed.success) {
    const err = new Error(`bridge returned an invalid response for agent ${agent.identifier}`);
    const atMs = Date.now() - postStart;
    throw attachPartialTrace(err, {
      totalMs: atMs,
      events: [post, { t: 'error', atMs, message: err.message }],
    });
  }
  return { ...parsed.data, trace };
}

/**
 * A13 — the partial trace for a bridge POST that never produced a reply.
 *
 * The bridge_post event mirrors the success path's shape EXACTLY: same `t`,
 * same fields, and still no URL and no host. The frozen event has never carried
 * the endpoint, and a failure is not the place to start leaking a tenant's
 * internal hostname into a transcript row the dashboard renders. `status: 0`
 * means "we dialed and got no HTTP answer at all" (connect refused, timeout,
 * DNS); a config fault that never dialed passes `dialed: false` and emits no
 * bridge_post event, because inventing a POST that never left the process is
 * exactly the kind of lie a trace exists to prevent.
 *
 * Wall-clock is measured from the start of the transport call — the only clock
 * this runtime has, since the bridge is a black box between the two.
 */
function bridgeFailureTrace(startedAt: number, message: string, dialed: boolean, status = 0): TurnTrace {
  const ms = Date.now() - startedAt;
  return {
    totalMs: ms,
    events: [
      ...(dialed ? [{ t: 'bridge_post', ms, status, ok: false } as TurnTraceEvent] : []),
      { t: 'error', atMs: ms, message },
    ],
  };
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
  // A13: every throw below leaves with the partial trace of the attempt pinned
  // to it, so the turn's crash note can show what the bridge did (or that it
  // was never dialed). Nothing on the success path changes.
  const started = Date.now();
  const traced = <E extends Error>(err: E, dialed: boolean, status = 0): E =>
    attachPartialTrace(err, bridgeFailureTrace(started, err.message, dialed, status));

  if (!agent.bridge_url) {
    throw traced(new PermanentError(`bridge agent ${agent.identifier} has no bridge URL`), false);
  }
  // SSRF gate, both halves: the assert catches literal private IPs (which
  // bypass custom DNS lookup), the dispatcher re-checks every resolved
  // address at connect time (DNS rebinding). Blocked → no retries.
  try {
    await assertSafeOutboundUrl(agent.bridge_url, { resolve: false });
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      // Refused at write-time: nothing left this process, so no bridge_post.
      throw traced(new PermanentError(`bridge URL blocked: ${err.message}`), false);
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
        // The connect-time half of the gate: the POST WAS attempted and the
        // dispatcher killed it mid-dial, so it is traced as a dialed failure.
        throw traced(new PermanentError(`bridge URL blocked: ${e.message}`), true);
      }
    }
    throw err instanceof Error ? traced(err, true) : err;
  } finally {
    clearTimeout(timer);
  }
  if (!response.ok) {
    throw traced(
      new Error(`bridge responded ${response.status} for agent ${agent.identifier}`),
      true,
      response.status,
    );
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
      // Phase 23 (D7): summarize on resolve. Bridge agents no-op inside the job
      // (episodic is managed-only), but the hook lives at every resolve site.
      await enqueueSummarize(conversation.tenant_id, conversation.id);
      await systemNote(conversation, messageId, signalIndex, `conversation resolved${signal.summary ? `: ${signal.summary}` : ''}`);
      if (conversation.channel === 'inapp') {
        await publishConversationEvent(conversation, subscriber.external_id, agent, {
          type: 'conversation.resolved',
        });
      }
      // Phase 25 (slice A): admin dashboard hint, ALL channels — after the
      // resolveConversation write above (row-then-hint), fire-and-forget.
      void emitTenantEvent(conversation.tenant_id, 'conversation.changed', conversation.id);
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
  trace?: TurnTrace;
  /** Tag the finalized row raw.platformNote (reasoning-leak fallback) so it is
   * excluded from history replay — mirrors the reply-insert path. */
  platformNote?: boolean;
  /** A5 slice B: the canary version that served this turn — same per-turn
   * attribution as the reply-insert path, since a plan-card turn finalizes
   * into the reply row instead of inserting a fresh one. */
  canaryVersion?: number;
  /** A6: which model served this turn (+ escalation) — same per-turn
   * attribution as the reply-insert path, for the plan-card reply row. */
  routing?: TurnRouting;
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
        ...(extras.trace ? { trace: extras.trace } : {}),
        ...(extras.buttons ? { buttons: extras.buttons } : {}),
        ...(extras.card ? { card: extras.card } : {}),
        ...(extras.platformNote ? { platformNote: true } : {}),
        ...(extras.canaryVersion ? { canaryVersion: extras.canaryVersion } : {}),
        ...(extras.routing ? { routing: extras.routing } : {}),
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
  // Phase 26 D5/D9: an operator push carries raw.operator = {name}. The widget
  // renders a "«name» · team" label from operatorName (in-app), and external
  // channels — which have no label affordance — get a "<name> (team): " text
  // prefix so the customer still sees who is speaking. Absent on agent replies.
  const operator = (replyRow.raw as { operator?: { name?: string } } | null)?.operator;
  const operatorName = operator?.name;
  const operatorPrefixed =
    operatorName && conversation.channel !== 'inapp'
      ? `${operatorName} (team): ${replyRow.content}`
      : replyRow.content;

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
        ...(operatorName ? { operatorName } : {}),
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
    const sent = await telegram.sendMessage(botToken, conversation.thread_key, operatorPrefixed, {
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
    let body = operatorPrefixed;
    if (emailRaw.buttons?.length) {
      body =
        `${operatorPrefixed}\n\nOptions (just reply with your choice):\n` +
        emailRaw.buttons.map((b, i) => `${i + 1}) ${b.label}`).join('\n');
    } else if (emailRaw.card?.type === 'select') {
      const card = emailRaw.card;
      body =
        `${operatorPrefixed}` +
        (card.prompt ? `\n\n${card.prompt}` : '') +
        `\n\nOptions (just reply with your choice):\n` +
        card.options.map((o, i) => `${i + 1}) ${o.label}`).join('\n');
    } else if (emailRaw.card?.type === 'text_input') {
      const card = emailRaw.card;
      body =
        `${operatorPrefixed}\n\n${card.prompt ?? 'Just reply with your answer.'}` +
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
    const sent = await slack.postMessage(botToken, channel, operatorPrefixed, {
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

/**
 * The tenant's reserved ops-side subscriber for agent alerts (externalId
 * 'approvals'): find-not-create, so a tenant who never opted in gets no phantom
 * subscriber and no notification (Phase 18 lesson — the trigger fanout upserts
 * unknown recipients). Mirrors managed-brain's approval-notify lookup.
 */
async function getApprovalsSubscriber(
  tenantId: string,
): Promise<{ external_id: string; email: string | null; phone: string | null; push_token: string | null } | null> {
  const { rows } = await pool.query(
    `select external_id, email, phone, push_token
       from subscribers where tenant_id = $1 and external_id = 'approvals'`,
    [tenantId],
  );
  return rows[0] ?? null;
}

/** Transcript breadcrumb for a signal — deduped so retries can't repeat it. */
async function systemNote(
  conversation: Conversation,
  messageId: string,
  /**
   * The dedupe slot this breadcrumb occupies within the turn. Numeric for the
   * original two families — 0 is the turn-note slot, 1..n are the signals — and
   * a STRING for a breadcrumb that belongs to neither and must not collide with
   * either (A7 slice B's 'reply-rules': a managed turn can carry a turn note AND
   * a blocked reply, and sharing slot 0 would silently drop the second one to
   * the dedupe key).
   */
  signalIndex: number | string,
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
    data.kind === 'deliver' ? 'agent message could not be delivered' : DEAD_TURN_NOTE;

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

  // A13: this insert now NO-OPS whenever the final attempt already wrote the
  // same row with its partial trace attached (same dedupe key, dedupe conflict
  // = do nothing). That is the intended outcome — the richer row wins and the
  // transcript still shows exactly one dead note. When the process was killed
  // mid-turn there is no such row and this stays the only record, traceless.
  await insertConversationMessage({
    conversationId: data.conversationId,
    tenantId: data.tenantId,
    role: 'system',
    content: deadNote,
    dedupeKey: `dead-${data.messageId}`,
  }).catch((err) => logger.warn({ err }, 'failed to record dead conversation turn'));
}
