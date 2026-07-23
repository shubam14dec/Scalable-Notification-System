/**
 * Phase 23: episodic memory writer — on conversation resolve, summarize the
 * transcript with the agent's OWN LLM (managed runtime only, >=2 user turns),
 * embed the summary, store the row (Postgres) + vector (the tenant's store).
 *
 * FROZEN CONTRACT: the knowledge queue processor (slice B) dispatches
 * {kind:'summarize'} jobs to this function; slice C implements it.
 * Must be a silent no-op when the tenant lacks embeddings/vector config,
 * the agent is bridge-runtime, or the conversation is trivial.
 */

import Anthropic from '@anthropic-ai/sdk';
import { logger } from '../shared/logger';
import { getQueue, QUEUE } from '../shared/queues';
import { pool } from '../db/pool';
import {
  getConversation,
  getAgentById,
  conversationTranscript,
  type Agent,
  type ConversationMessage,
} from '../db/conversations.repo';
import { getEmbeddingsConfig, embedTexts } from './embeddings';
import { getVectorStore } from './vector-store';
import { buildManagedClient, DEFAULT_MODEL } from './managed-brain';

/** Neutral, third-person, ~1-paragraph summary. No PII beyond what's in-thread. */
const SUMMARY_SYSTEM =
  'You write a short, neutral, third-person summary of a resolved customer ' +
  'support conversation, for the agent to recall in future contact with the ' +
  'same customer. One paragraph, at most ~60 words: what the customer needed ' +
  "and how it was resolved. Do not invent details, and do not add any personal " +
  'information that is not already present in the transcript.';

/**
 * Enqueue a summarize job for a resolved conversation. Idempotent by jobId
 * (summarize-<convId>) so every resolve site can fire freely — the processor
 * (slice B) dispatches to summarizeAndEmbedConversation, which itself no-ops on
 * a duplicate (unique conversation_id). Managed-only work, but bridge/other
 * resolves may enqueue too: the function silently no-ops for them.
 */
export async function enqueueSummarize(tenantId: string, conversationId: string): Promise<void> {
  await getQueue(QUEUE.KNOWLEDGE).add(
    `summarize-${conversationId}`,
    { kind: 'summarize', tenantId, conversationId },
    { jobId: `summarize-${conversationId}`, attempts: 5 },
  );
}

/**
 * Summarize + embed one resolved conversation. Silent no-op (each with a debug
 * log) when: the conversation/agent is gone, the agent is not managed runtime,
 * the agent has no LLM config, the tenant lacks embeddings/vector config, the
 * conversation has <2 user turns, or a summary already exists.
 *
 * Idempotency + crash-safety: the row (unique conversation_id) is the system of
 * record and its id doubles as the vector id. A fully-written row carries
 * embedding_dim; a row with a null embedding_dim is a prior crash between the
 * INSERT and the vector upsert — a retry RESUMES from the embed step (reusing
 * the stored summary, no second LLM call, no duplicate row, no orphan vector).
 */
export async function summarizeAndEmbedConversation(job: {
  tenantId: string;
  conversationId: string;
}): Promise<void> {
  const { tenantId, conversationId } = job;

  const conversation = await getConversation(tenantId, conversationId);
  if (!conversation) {
    logger.debug({ conversationId }, 'episodic: conversation gone, skipping');
    return;
  }
  const agent = await getAgentById(conversation.agent_id);
  if (!agent || agent.runtime !== 'managed') {
    logger.debug({ conversationId, runtime: agent?.runtime }, 'episodic: not a managed agent, skipping');
    return;
  }
  if (!agent.llm_credentials) {
    logger.debug({ conversationId, agent: agent.identifier }, 'episodic: agent has no LLM config, skipping');
    return;
  }

  const cfg = await getEmbeddingsConfig(tenantId);
  const store = cfg ? await getVectorStore(tenantId) : null;
  if (!cfg || !store) {
    logger.debug({ conversationId, tenantId }, 'episodic: tenant lacks embeddings/vector config, skipping');
    return;
  }

  // A completed summary (embedding_dim set) means fully done — idempotent.
  const prior = await pool.query<{ id: string; summary: string; embedding_dim: number | null }>(
    `select id, summary, embedding_dim from conversation_summaries where conversation_id = $1`,
    [conversationId],
  );
  if (prior.rows[0]?.embedding_dim != null) {
    logger.debug({ conversationId }, 'episodic: summary already exists, skipping');
    return;
  }

  let rowId: string;
  let summaryText: string;
  if (prior.rows[0]) {
    // A prior crash left the row without its vector — resume from the embed step.
    rowId = prior.rows[0].id;
    summaryText = prior.rows[0].summary;
  } else {
    const transcript = await conversationTranscript(conversationId);
    const userTurns = transcript.filter((m) => m.role === 'user' && !m.deleted_at).length;
    if (userTurns < 2) {
      logger.debug({ conversationId, userTurns }, 'episodic: <2 user turns, nothing worth remembering');
      return;
    }
    summaryText = await summarize(agent, transcript);
    if (!summaryText) {
      logger.debug({ conversationId }, 'episodic: empty summary, skipping');
      return;
    }
    const ins = await pool.query<{ id: string }>(
      `insert into conversation_summaries
         (tenant_id, conversation_id, agent_id, subscriber_id, summary)
       values ($1, $2, $3, $4, $5)
       on conflict (conversation_id) do nothing
       returning id`,
      [tenantId, conversationId, agent.id, conversation.subscriber_id, summaryText],
    );
    if (ins.rows[0]) {
      rowId = ins.rows[0].id;
    } else {
      // A concurrent job won the insert — resume against its row.
      const re = await pool.query<{ id: string; summary: string; embedding_dim: number | null }>(
        `select id, summary, embedding_dim from conversation_summaries where conversation_id = $1`,
        [conversationId],
      );
      if (!re.rows[0] || re.rows[0].embedding_dim != null) return;
      rowId = re.rows[0].id;
      summaryText = re.rows[0].summary;
    }
  }

  // Vector id == row id, so upsert is idempotent under retry. embedTexts throws
  // transiently -> BullMQ retries -> the null-dim row resumes here next time.
  const [vec] = await embedTexts(cfg, [summaryText]);
  await store.upsert([
    { id: rowId, values: vec, meta: { agentId: agent.id, subscriberId: conversation.subscriber_id } },
  ]);
  await pool.query(`update conversation_summaries set embedding_dim = $1 where id = $2`, [cfg.dim, rowId]);
  logger.debug({ conversationId, rowId, dim: cfg.dim }, 'episodic: summary embedded and stored');
}

/**
 * One cheap summary call on the agent's own LLM (reusing the managed-brain
 * client construction, so SSRF-pinning + sealed creds behave identically).
 * A brain CONFIG error (bad key/model) is a silent skip; a transient blip
 * throws so BullMQ retries the whole job.
 */
async function summarize(agent: Agent, transcript: ConversationMessage[]): Promise<string> {
  const convoText = transcript
    .filter((m) => (m.role === 'user' || m.role === 'agent') && !m.deleted_at)
    .map((m) => `${m.role === 'user' ? 'Customer' : 'Agent'}: ${m.content}`)
    .join('\n')
    // Bound the prompt — a summary needs the gist, not every token of a long thread.
    .slice(0, 12_000);

  const client = await buildManagedClient(agent);
  try {
    const resp = await client.messages.create({
      model: agent.model ?? DEFAULT_MODEL,
      max_tokens: 200, // ~150-token summary; a little headroom so it isn't clipped mid-sentence
      system: SUMMARY_SYSTEM,
      messages: [{ role: 'user', content: `Summarize this resolved support conversation:\n\n${convoText}` }],
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
        'episodic: summary skipped on brain config error',
      );
      return '';
    }
    throw err; // transient — let BullMQ retry the job
  }
}
