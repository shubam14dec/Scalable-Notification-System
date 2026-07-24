/**
 * Phase 24 slice B — rolling summarization. As a managed conversation grows,
 * replay is a hard window (conversationTranscriptBefore's backstop) that
 * silently forgets turn 1. This folds the OLDER turns into a compact system
 * summary so nothing important is lost AND the per-turn prompt stays cheap.
 *
 * Managed agents ONLY: bridge agents own their brain (same gate as episodic).
 *
 * Idempotency (last-writer-wins recompute): the fold job carries no target
 * boundary — it loads the replayable rows AFTER the conversation's current
 * rolling_upto, keeps the newest tailTurns verbatim, folds the rest, and writes
 * rolling_summary + rolling_upto = the newest FOLDED message id. A BullMQ retry
 * re-runs against the ALREADY-advanced rolling_upto, finds only the tail left
 * (≤ tailTurns), and no-ops — so a re-run produces an identical result. The
 * conversation keeps answering on the old window while a fold is pending/failing.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../shared/logger';
import { getQueue, QUEUE } from '../shared/queues';
import { pool } from '../db/pool';
import { estimateTokens } from './chunker';
import { buildManagedClient, DEFAULT_MODEL, sanitizeReply } from './managed-brain';
import {
  getConversation,
  getAgentById,
  conversationRowsAfter,
  type Agent,
  type AgentContext,
  type ConversationMessage,
} from '../db/conversations.repo';

/** D6 defaults, applied at read time (never stored) — a plain, un-configured agent folds here. */
export const DEFAULT_TRIGGER_TURNS = 20;
export const DEFAULT_TAIL_TURNS = 10;
/** D6 token guard: fold also fires when the replay text estimate crosses this (constant, not a knob in v1). */
export const ROLLING_TOKEN_GUARD = 4000;
/** Output cap: ~150 words ≈ 200 tokens, a little headroom so it isn't clipped mid-sentence. */
const ROLLING_SUMMARY_MAX_TOKENS = 260;

/**
 * The fold summarizer's system prompt. Weak-model rules (§13, GLM lessons): no
 * meta, no echoed instructions, third person, keep the concrete facts. The
 * OUTPUT lands in a <prior_conversation_summary> SYSTEM block — never replayed
 * as an assistant turn — so it is not an imitation surface.
 */
const ROLLING_SUMMARY_SYSTEM =
  'You maintain a running summary of an ongoing customer support conversation ' +
  'so the agent keeps the earlier context after older turns scroll out of the ' +
  'window. Write at most 150 words, third person, plain prose. Keep every ' +
  'concrete fact: ids, order/ticket numbers, amounts, dates, decisions, and ' +
  'promises made. Do not invent anything, do not add instructions or meta ' +
  'commentary, and do not address the customer — only state what has happened ' +
  'so far.';

export interface RollingKnobs {
  triggerTurns: number;
  tailTurns: number;
}

/**
 * Resolve the D6 knobs from the agent's `context`, applying defaults and a
 * safety clamp: tailTurns must stay strictly below triggerTurns so a fold that
 * fires always leaves something to fold (an out-of-order pair from a partial
 * dashboard edit can't degenerate the fold). Non-numeric / non-positive values
 * fall back to the defaults.
 */
export function resolveRollingKnobs(context: AgentContext | null | undefined): RollingKnobs {
  const c = context ?? {};
  const trigger = intOr(c.triggerTurns, DEFAULT_TRIGGER_TURNS);
  let tail = intOr(c.tailTurns, DEFAULT_TAIL_TURNS);
  if (tail >= trigger) tail = Math.max(1, trigger - 1);
  return { triggerTurns: trigger, tailTurns: tail };
}

function intOr(value: number | undefined, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

/**
 * A replayable "turn" for counting/tail purposes — mirrors buildHistory's
 * exclusions exactly: only user/agent rows, never a deleted row, never a
 * platform-authored (raw.platformNote) agent note. System breadcrumbs are NOT
 * turns (they fold into the neighbouring reply), but they DO ride along in the
 * fold input via serializeFoldInput.
 */
export function isReplayableTurn(m: ConversationMessage): boolean {
  if (m.deleted_at) return false;
  if (m.role !== 'user' && m.role !== 'agent') return false;
  if (m.role === 'agent' && (m.raw as { platformNote?: boolean } | null)?.platformNote) return false;
  return true;
}

/**
 * The trigger test (pure, unit-testable). Fold when the un-summarized replayable
 * turn count exceeds triggerTurns OR the serialized replay text estimate exceeds
 * the token guard. `replayableTurns` is counted over the POST-rolling_upto window
 * only (the loader already excludes folded rows — "already-folded not recounted").
 */
export function shouldFold(
  replayableTurns: number,
  replayText: string,
  knobs: RollingKnobs,
): boolean {
  if (replayableTurns > knobs.triggerTurns) return true;
  if (estimateTokens(replayText) > ROLLING_TOKEN_GUARD) return true;
  return false;
}

/**
 * Serialize the folded rows to plain text for the summarizer. Tool actions
 * render as bracketed prose — acceptable here because the fold OUTPUT is a
 * system-block summary, never replayed as assistant prose (the imitation
 * surface is the assistant role, not this input). Exclusions mirror
 * buildHistory: deleted rows dropped, platform-note agent rows dropped, system
 * rows contribute only when they carry a structured raw.action. A prior
 * rolling_summary is prepended so the fold is cumulative.
 */
export function serializeFoldInput(
  foldedRows: ConversationMessage[],
  priorSummary: string | null,
): string {
  const lines: string[] = [];
  if (priorSummary && priorSummary.trim()) {
    lines.push(`Summary so far: ${priorSummary.trim()}`);
  }
  for (const m of foldedRows) {
    if (m.deleted_at) continue;
    if (m.role === 'user') {
      lines.push(`Customer: ${m.content}`);
    } else if (m.role === 'agent') {
      if ((m.raw as { platformNote?: boolean } | null)?.platformNote) continue;
      lines.push(`Agent: ${sanitizeReply(m.content).text}`);
    } else {
      const action = (m.raw as { action?: { tool: string; result: string } } | null)?.action;
      if (action) lines.push(`[Agent used ${action.tool}: ${action.result}]`);
    }
  }
  return lines.join('\n');
}

/**
 * Enqueue a rolling-fold recompute on the KNOWLEDGE queue (rides beside
 * index/cleanup/summarize; concurrency 1 keeps it off the brain's latency).
 * Dedup jobId `roll-<conversationId>-<lastMessageId>`: dashes, never colons
 * (BullMQ rejects >3-part colon ids). Retry-safe by construction (see file top).
 */
export async function enqueueRollingFold(
  tenantId: string,
  conversationId: string,
  lastMessageId: string,
): Promise<void> {
  await getQueue(QUEUE.KNOWLEDGE).add(
    `roll-${conversationId}`,
    { kind: 'summarize-rolling', tenantId, conversationId },
    { jobId: `roll-${conversationId}-${lastMessageId}`, attempts: 5 },
  );
}

/**
 * Recompute the rolling summary for one conversation. Silent no-op (each with a
 * debug log) when: the conversation/agent is gone, the agent is not managed
 * runtime (bridge owns its brain), the agent has no LLM config, or nothing older
 * than the tail remains to fold. Idempotent + crash-safe (see file top).
 */
export async function foldRollingSummary(job: {
  tenantId: string;
  conversationId: string;
}): Promise<void> {
  const { tenantId, conversationId } = job;

  const conversation = await getConversation(tenantId, conversationId);
  if (!conversation) {
    logger.debug({ conversationId }, 'rolling: conversation gone, skipping');
    return;
  }
  const agent = await getAgentById(conversation.agent_id);
  if (!agent || agent.runtime !== 'managed') {
    logger.debug({ conversationId, runtime: agent?.runtime }, 'rolling: not a managed agent, skipping');
    return;
  }
  if (!agent.llm_credentials) {
    logger.debug({ conversationId, agent: agent.identifier }, 'rolling: agent has no LLM config, skipping');
    return;
  }

  const knobs = resolveRollingKnobs(agent.context);
  const rows = await conversationRowsAfter(conversationId, conversation.rolling_upto);
  const replayable = rows.filter(isReplayableTurn);
  if (replayable.length <= knobs.tailTurns) {
    // Nothing older than the tail — a retry after a prior successful fold lands
    // here (rolling_upto already advanced), which is what makes re-runs identical.
    logger.debug(
      { conversationId, replayable: replayable.length, tail: knobs.tailTurns },
      'rolling: at or under the tail, nothing to fold',
    );
    return;
  }

  // Keep the newest tailTurns replayable rows verbatim; fold everything up to
  // (and including) the last row before the tail. rolling_upto = that boundary
  // row's id, so replay takes rows strictly after it (its own breadcrumbs, which
  // precede it, fold away too).
  const boundary = replayable[replayable.length - knobs.tailTurns - 1];
  const boundaryIdx = rows.findIndex((r) => r.id === boundary.id);
  const foldedRows = rows.slice(0, boundaryIdx + 1);

  const input = serializeFoldInput(foldedRows, conversation.rolling_summary);
  const summary = await summarizeRolling(agent, input);
  if (!summary) {
    // A brain CONFIG error (bad key/model) already logged; skip rather than loop.
    // The conversation keeps working on the old window.
    logger.debug({ conversationId }, 'rolling: empty summary, leaving state unchanged');
    return;
  }

  await pool.query(`update conversations set rolling_summary = $2, rolling_upto = $3 where id = $1`, [
    conversationId,
    summary,
    boundary.id,
  ]);
  logger.debug(
    { conversationId, uptoMessageId: boundary.id, folded: foldedRows.length },
    'rolling: summary folded',
  );
}

/**
 * One cheap summary call on the agent's OWN LLM (buildManagedClient, so
 * SSRF-pinning + sealed creds behave identically to the brain and episodic). A
 * brain CONFIG error (bad key/model) is a silent skip (returns ''); a transient
 * blip throws so BullMQ retries the whole job.
 */
async function summarizeRolling(agent: Agent, input: string): Promise<string> {
  // Bound the prompt — the gist, not every token of a long thread.
  const bounded = input.slice(0, 12_000);
  const client = await buildManagedClient(agent);
  try {
    const resp = await client.messages.create({
      model: agent.model ?? DEFAULT_MODEL,
      max_tokens: ROLLING_SUMMARY_MAX_TOKENS,
      system: ROLLING_SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: `Update the running summary from this conversation so far:\n\n${bounded}` }],
    });
    return resp.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('')
      .trim();
  } catch (err) {
    if (
      err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.PermissionDeniedError ||
      err instanceof Anthropic.NotFoundError ||
      err instanceof Anthropic.BadRequestError
    ) {
      logger.debug(
        { agent: agent.identifier, err: (err as Error).message },
        'rolling: summary skipped on brain config error',
      );
      return '';
    }
    throw err; // transient — let BullMQ retry the job
  }
}
