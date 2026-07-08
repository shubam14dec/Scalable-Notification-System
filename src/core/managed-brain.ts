import Anthropic from '@anthropic-ai/sdk';
import { openSecret } from '../auth/secret-box';
import { PermanentError, TransientError } from '../shared/errors';
import { logger } from '../shared/logger';
import type { Agent, ConversationMessage } from '../db/conversations.repo';

/**
 * The managed brain: for runtime='managed' agents we run the model loop
 * ourselves — the customer supplies an API key, a system prompt, and a
 * model; the conversation core supplies the history. One Messages API
 * call per turn, no tools (v1).
 *
 * llm_base_url makes any Anthropic-compatible endpoint a first-class
 * target (defaults to api.anthropic.com). Tests point it at a stub the
 * same way a customer points it at a compat provider.
 */

export const DEFAULT_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 1024; // chat replies are short; raise per-agent later
const REQUEST_TIMEOUT_MS = 60_000;

export interface BrainTurnResult {
  /** The reply to deliver; null when the model refused. */
  reply: string | null;
  /** Transcript breadcrumb (refusal, truncation) — visible, not silent. */
  note?: string;
}

export async function runManagedTurn(
  agent: Agent,
  history: ConversationMessage[],
  inbound: ConversationMessage,
): Promise<BrainTurnResult> {
  if (!agent.llm_credentials) {
    throw new PermanentError(`managed agent ${agent.identifier} has no LLM credentials`);
  }
  const { apiKey } = JSON.parse(openSecret(agent.llm_credentials)) as { apiKey: string };

  const client = new Anthropic({
    apiKey,
    baseURL: agent.llm_base_url ?? undefined,
    timeout: REQUEST_TIMEOUT_MS,
    // BullMQ owns outer retries; one SDK retry absorbs blips without
    // multiplying against the job's attempts.
    maxRetries: 1,
  });

  const messages: Anthropic.MessageParam[] = [
    ...history.map((m) => ({
      role: m.role === 'agent' ? ('assistant' as const) : ('user' as const),
      content: m.content,
    })),
    { role: 'user' as const, content: inbound.content },
  ];

  let response: Anthropic.Message;
  try {
    response = await client.messages.create({
      model: agent.model ?? DEFAULT_MODEL,
      max_tokens: MAX_TOKENS,
      ...(agent.system_prompt ? { system: agent.system_prompt } : {}),
      messages,
    });
  } catch (err) {
    // Config mistakes must not retry-storm the provider: surface them in
    // the transcript instead. Everything else is worth another attempt.
    if (
      err instanceof Anthropic.AuthenticationError ||
      err instanceof Anthropic.PermissionDeniedError ||
      err instanceof Anthropic.NotFoundError ||
      err instanceof Anthropic.BadRequestError
    ) {
      throw new PermanentError(`brain config error (${err.status}): ${err.message}`, err);
    }
    throw new TransientError(`brain call failed: ${(err as Error).message}`, err);
  }

  // Check stop_reason before reading content (refusals can carry none).
  if (response.stop_reason === 'refusal') {
    logger.info({ agent: agent.identifier }, 'managed brain refused the turn');
    return { reply: null, note: 'the model declined to answer this message' };
  }

  const reply = response.content
    .filter((block): block is Anthropic.TextBlock => block.type === 'text')
    .map((block) => block.text)
    .join('')
    .trim();

  if (reply.length === 0) {
    throw new TransientError(
      `brain returned no text (stop_reason=${response.stop_reason ?? 'unknown'})`,
    );
  }

  return {
    reply,
    note:
      response.stop_reason === 'max_tokens'
        ? 'reply truncated at the model output limit'
        : undefined,
  };
}
