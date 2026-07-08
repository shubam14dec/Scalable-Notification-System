import Anthropic from '@anthropic-ai/sdk';
import { openSecret } from '../auth/secret-box';
import { PermanentError, TransientError } from '../shared/errors';
import { logger } from '../shared/logger';
import { listWorkflows } from '../db/repositories';
import { internalTrigger } from './internal-trigger';
import {
  insertConversationMessage,
  resolveConversation,
  updateConversationMetadata,
  type Agent,
  type Conversation,
  type ConversationMessage,
} from '../db/conversations.repo';

/**
 * The managed brain: for runtime='managed' agents we run the model loop
 * ourselves — the customer supplies an API key, a system prompt, and a
 * model; the conversation core supplies the history.
 *
 * Tool use rides a MANUAL bounded loop over plain messages.create — not
 * the SDK's beta Tool Runner — because llm_base_url may point at any
 * Anthropic-COMPATIBLE endpoint (z.ai, stubs), and only the standard
 * non-beta surface can be assumed there.
 *
 * Retry-safety: a retried job re-runs a NONDETERMINISTIC model, which may
 * order its tool calls differently — so effects are idempotent by CONTENT,
 * not call order: a workflow trigger's transactionId derives from
 * (turn, workflowKey), breadcrumb dedupe keys likewise. A crash-retry
 * re-fires every effect as a duplicate no-op.
 */

export const DEFAULT_MODEL = 'claude-opus-4-8';
const MAX_TOKENS = 1024; // chat replies are short; raise per-agent later
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Model calls per TURN (not per conversation): how many "let me do one
 * more thing" rounds the model gets while composing one reply. The
 * busiest legitimate turn uses ~3; unbounded loops burn the customer's
 * tokens and a worker slot.
 */
const MAX_MODEL_CALLS = 5;

export interface BrainTurnResult {
  /** The reply to deliver; null when the model refused or sent no text. */
  reply: string | null;
  /** True when the model resolved the conversation (caller publishes WS). */
  resolved: boolean;
  /** Transcript breadcrumb (refusal, truncation, loop cap) — visible. */
  note?: string;
}

interface Subscriber {
  external_id: string;
  email: string | null;
  phone: string | null;
  push_token: string | null;
}

export async function runManagedTurn(
  agent: Agent,
  conversation: Conversation,
  subscriber: Subscriber,
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

  const workflowKeys = (await listWorkflows(conversation.tenant_id)).map(
    (w: { key: string }) => w.key,
  );
  const tools = buildTools(workflowKeys);

  const messages: Anthropic.MessageParam[] = [
    ...foldHistory(history),
    { role: 'user' as const, content: inbound.content },
  ];

  let resolved = false;

  for (let call = 1; call <= MAX_MODEL_CALLS; call += 1) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: agent.model ?? DEFAULT_MODEL,
        max_tokens: MAX_TOKENS,
        ...(agent.system_prompt ? { system: agent.system_prompt } : {}),
        tools,
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
      return { reply: null, resolved, note: 'the model declined to answer this message' };
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'tool_use') {
      if (call === MAX_MODEL_CALLS) {
        // Still asking for tools on the last permitted call: stop here.
        // Effects already executed are applied and idempotent.
        return { reply: null, resolved, note: 'tool loop limit reached before a final reply' };
      }
      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      // Execute ALL requested tools; return ALL results in ONE user message
      // (splitting them trains the model out of parallel calls).
      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        const outcome = await executeTool(use, agent, conversation, subscriber, inbound, {
          onResolve: () => {
            resolved = true;
          },
        });
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: outcome.message,
          ...(outcome.isError ? { is_error: true } : {}),
        });
      }
      messages.push({ role: 'user', content: results });
      continue;
    }

    // Terminal response: deliver the text.
    const reply = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();

    return {
      reply: reply.length > 0 ? reply : null,
      resolved,
      note:
        response.stop_reason === 'max_tokens'
          ? 'reply truncated at the model output limit'
          : reply.length === 0
            ? 'the model produced no reply text'
            : undefined,
    };
  }

  // Unreachable (the cap returns inside the loop), but keep TS satisfied.
  return { reply: null, resolved, note: 'tool loop limit reached before a final reply' };
}

/**
 * Rebuild honest history. System rows (tool-action breadcrumbs) are folded
 * into the assistant turn they belong to as bracketed action notes — so a
 * past reply that came with a real tool call LOOKS like it did. Without
 * this, replayed history shows bare "I sent it" claims with no visible
 * action, and the model learns to imitate claiming instead of calling
 * (observed live with GLM: first turn called the tool, every later turn
 * copied the apparent pattern).
 */
function foldHistory(history: ConversationMessage[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  // Breadcrumbs are written DURING tool execution, so they precede the
  // reply row in the transcript — buffer them and attach to the NEXT
  // assistant turn (the reply they belong to).
  let pendingActions: string[] = [];
  for (const m of history) {
    if (m.role === 'system') {
      pendingActions.push(m.content);
      continue;
    }
    if (m.role === 'agent' && pendingActions.length > 0) {
      messages.push({
        role: 'assistant',
        content:
          pendingActions.map((a) => `[action taken: ${a}]`).join('\n') + `\n${m.content}`,
      });
      pendingActions = [];
      continue;
    }
    messages.push({
      role: m.role === 'agent' ? ('assistant' as const) : ('user' as const),
      content: m.content,
    });
  }
  return messages;
}

/** The tool menu — descriptions say WHEN to call, not just what it does. */
function buildTools(workflowKeys: string[]): Anthropic.Tool[] {
  const tools: Anthropic.Tool[] = [
    {
      name: 'set_metadata',
      description:
        'Save a note on this conversation (e.g. topic, order number, sentiment) so ' +
        'support staff and future turns can see it. Call it when you learn a durable ' +
        'fact worth remembering; it is invisible to the user.',
      input_schema: {
        type: 'object',
        properties: {
          key: { type: 'string', description: 'Short snake_case key, e.g. "topic"' },
          value: { description: 'The value to store (string, number, or small object)' },
        },
        required: ['key', 'value'],
      },
    },
    {
      name: 'resolve_conversation',
      description:
        'Mark this conversation resolved. Call it when the user indicates their issue ' +
        'is settled (e.g. they say thanks/goodbye and nothing is pending). A new ' +
        'message from them reopens it automatically.',
      input_schema: {
        type: 'object',
        properties: {
          summary: { type: 'string', description: 'One-line summary of the outcome' },
        },
        required: [],
      },
    },
  ];

  // No workflows -> no trigger tool; the enum stops hallucinated keys.
  if (workflowKeys.length > 0) {
    tools.push({
      name: 'trigger_workflow',
      description:
        'Send the user a real notification (email/SMS/push/in-app) by running one of ' +
        'the listed workflows. Call it when the situation calls for a notification — ' +
        'e.g. a replacement confirmation for a lost order. The user receives NOTHING ' +
        'unless you call this tool: never tell the user a notification was sent or ' +
        'queued unless you called this tool in the CURRENT turn and received a ' +
        'success result. Each new order or issue needs its own fresh call — a send ' +
        'from an earlier turn does not cover this one.',
      input_schema: {
        type: 'object',
        properties: {
          workflowKey: {
            type: 'string',
            enum: workflowKeys,
            description: 'Which workflow to run',
          },
          payload: {
            type: 'object',
            description: 'Template variables for the workflow, e.g. {"name": "Ana"}',
          },
        },
        required: ['workflowKey'],
      },
    });
  }
  return tools;
}

/** Execute one tool call; failures come back as is_error results, not throws. */
async function executeTool(
  use: Anthropic.ToolUseBlock,
  agent: Agent,
  conversation: Conversation,
  subscriber: Subscriber,
  inbound: ConversationMessage,
  hooks: { onResolve: () => void },
): Promise<{ message: string; isError?: boolean }> {
  const input = use.input as Record<string, unknown>;

  if (use.name === 'set_metadata') {
    const key = String(input.key ?? '');
    if (!key) return { message: 'key is required', isError: true };
    const merged = { ...conversation.metadata, [key]: input.value };
    if (Buffer.byteLength(JSON.stringify(merged), 'utf8') > 64 * 1024) {
      return { message: 'rejected: conversation metadata is over the 64KB cap', isError: true };
    }
    conversation.metadata = merged;
    await updateConversationMetadata(conversation.id, merged);
    return { message: `saved ${key}` };
  }

  if (use.name === 'resolve_conversation') {
    const summary = typeof input.summary === 'string' ? input.summary : undefined;
    await resolveConversation(conversation.id, summary);
    hooks.onResolve();
    await breadcrumb(
      conversation,
      `signal-${inbound.id}-resolve`,
      `conversation resolved${summary ? `: ${summary}` : ''}`,
    );
    return { message: 'conversation marked resolved' };
  }

  if (use.name === 'trigger_workflow') {
    const workflowKey = String(input.workflowKey ?? '');
    // Content-keyed idempotency: same turn + same workflow = same txn, so a
    // crash-retry (or a duplicate call within the turn) can never double-send.
    const result = await internalTrigger({
      tenantId: conversation.tenant_id,
      workflowKey,
      to: [
        {
          subscriberId: subscriber.external_id,
          email: subscriber.email ?? undefined,
          phone: subscriber.phone ?? undefined,
          pushToken: subscriber.push_token ?? undefined,
        },
      ],
      payload: (input.payload as Record<string, unknown>) ?? {},
      transactionId: `conv-${inbound.id}-${workflowKey}`,
      source: `managed agent ${agent.identifier}`,
    });
    if (!result.ok) {
      return { message: `workflow not sent: ${result.error}`, isError: true };
    }
    await breadcrumb(
      conversation,
      `signal-${inbound.id}-trigger-${workflowKey}`,
      `triggered workflow ${workflowKey} (txn ${result.transactionId})`,
    );
    return {
      message: result.duplicate
        ? `workflow ${workflowKey} was already sent for this message`
        : `workflow ${workflowKey} queued (transactionId ${result.transactionId})`,
    };
  }

  return { message: `unknown tool ${use.name}`, isError: true };
}

/** Transcript breadcrumb, content-keyed so retries can't repeat it. */
async function breadcrumb(
  conversation: Conversation,
  dedupeKey: string,
  content: string,
): Promise<void> {
  await insertConversationMessage({
    conversationId: conversation.id,
    tenantId: conversation.tenant_id,
    role: 'system',
    content,
    dedupeKey,
  });
}
