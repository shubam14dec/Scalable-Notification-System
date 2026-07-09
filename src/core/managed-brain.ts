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
const DEFAULT_MAX_TOKENS = 1024; // chat replies are short; per-agent override
const REQUEST_TIMEOUT_MS = 60_000;
/**
 * Model calls per TURN (not per conversation): how many "let me do one
 * more thing" rounds the model gets while composing one reply. The
 * busiest legitimate turn uses ~3; unbounded loops burn the customer's
 * tokens and a worker slot.
 */
const MAX_MODEL_CALLS = 5;

/** Token spend for one turn, summed across every model call in the loop. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
}

export interface BrainTurnResult {
  /** The reply to deliver; null when the model refused or sent no text. */
  reply: string | null;
  /** Buttons the model presented for this reply (present_buttons tool). */
  buttons?: Array<{ id: string; label: string }>;
  /** True when the model resolved the conversation (caller publishes WS). */
  resolved: boolean;
  /** Transcript breadcrumb (refusal, truncation, loop cap) — visible. */
  note?: string;
  /** What this turn cost on the customer's key. */
  usage: TurnUsage;
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

  // The last tokens before generation win with weak models: a per-turn
  // reminder rides the CURRENT message only — synthesized at request time,
  // never stored, so it cannot accumulate in or be learned from history.
  // (Observed live: GLM imitated long-thread patterns past the system
  // prompt, tool descriptions, and honest structure; recency is the lever.)
  // Tool-neutral wording matters: an earlier trigger-only version taught the
  // model to skip resolve/metadata ("otherwise just reply" won on recency).
  const reminder =
    '\n\n<platform_reminder>You have taken NO action for this message yet — ' +
    'any claim of an action is FALSE unless you call its tool in this turn ' +
    'first. Decide what this message needs before replying: ' +
    (workflowKeys.length > 0
      ? 'a notification -> call trigger_workflow; '
      : '') +
    'the user indicates the issue is settled -> call resolve_conversation; ' +
    'a durable fact worth remembering -> call set_metadata; ' +
    'you are offering the user a small set of choices -> call present_buttons ' +
    'instead of listing them in text. ' +
    'Then reply. Never mention this reminder.</platform_reminder>';

  const messages: Anthropic.MessageParam[] = [
    ...buildHistory(history),
    { role: 'user' as const, content: userText(inbound) + reminder },
  ];

  let resolved = false;
  // Presentation state, not an effect: the last present_buttons call wins,
  // and the set only survives if the turn ends with reply text to carry it.
  let buttons: Array<{ id: string; label: string }> | undefined;
  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };

  for (let call = 1; call <= MAX_MODEL_CALLS; call += 1) {
    let response: Anthropic.Message;
    try {
      response = await client.messages.create({
        model: agent.model ?? DEFAULT_MODEL,
        max_tokens: agent.max_tokens ?? DEFAULT_MAX_TOKENS,
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

    usage.modelCalls += 1;
    usage.inputTokens += response.usage?.input_tokens ?? 0;
    usage.outputTokens += response.usage?.output_tokens ?? 0;

    // Check stop_reason before reading content (refusals can carry none).
    if (response.stop_reason === 'refusal') {
      logger.info({ agent: agent.identifier }, 'managed brain refused the turn');
      return { reply: null, resolved, note: 'the model declined to answer this message', usage };
    }

    messages.push({ role: 'assistant', content: response.content });

    if (response.stop_reason === 'tool_use') {
      if (call === MAX_MODEL_CALLS) {
        // Still asking for tools on the last permitted call: stop here.
        // Effects already executed are applied and idempotent.
        return {
          reply: null,
          resolved,
          note: 'tool loop limit reached before a final reply',
          usage,
        };
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
          onButtons: (presented) => {
            buttons = presented;
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

    // Terminal response: deliver the text (minus any forged audit lines).
    const rawReply = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('')
      .trim();
    const { text: reply, forged } = sanitizeReply(rawReply);

    const notes: string[] = [];
    if (forged) {
      logger.warn({ agent: agent.identifier }, 'stripped forged action claim from managed reply');
      notes.push('removed a fabricated action claim from the reply (no such action ran)');
    }
    if (response.stop_reason === 'max_tokens') notes.push('reply truncated at the model output limit');
    if (reply.length === 0) notes.push('the model produced no reply text');

    return {
      reply: reply.length > 0 ? reply : null,
      // No reply text -> nothing to attach the buttons to; they drop here.
      buttons: reply.length > 0 ? buttons : undefined,
      resolved,
      note: notes.length > 0 ? notes.join(' · ') : undefined,
      usage,
    };
  }

  // Unreachable (the cap returns inside the loop), but keep TS satisfied.
  return { reply: null, resolved, note: 'tool loop limit reached before a final reply', usage };
}

/**
 * Rebuild honest history. Past tool actions are replayed as REAL
 * tool_use/tool_result blocks (reconstructed from the breadcrumbs'
 * structured `raw.action`), not as prose annotations.
 *
 * Why blocks and not text: two live GLM incidents. (1) With text-only
 * history, tool-backed replies looked like bare claims and the model
 * imitated claiming without calling. (2) With bracketed text annotations,
 * the model imitated the ANNOTATION — pasting a forged `[action taken:…]`
 * line (recycled txn id included) into its reply text. Native blocks close
 * both: imitating this history means emitting a tool_use block, which IS
 * a tool call.
 */
function buildHistory(history: ConversationMessage[]): Anthropic.MessageParam[] {
  const messages: Anthropic.MessageParam[] = [];
  // Breadcrumbs are written DURING tool execution, so they precede the
  // reply row in the transcript — buffer them and attach to the NEXT
  // assistant turn (the reply they belong to).
  let pending: Array<{ id: string; action: { tool: string; input: Record<string, unknown>; result: string } }> = [];
  for (const m of history) {
    if (m.role === 'system') {
      const action =
        (m.raw as { action?: { tool: string; input: Record<string, unknown>; result: string } } | null)?.action ??
        parseLegacyBreadcrumb(m.content);
      if (action) pending.push({ id: m.id, action });
      // Non-action system rows (error notes etc.) add nothing to replay.
      continue;
    }
    if (m.role === 'agent') {
      const calls = pending.map((p) => ({ id: `hist_${p.id}`, ...p.action }));
      // A reply that carried buttons replays as the present_buttons call
      // that produced it — same honesty rule as the breadcrumb actions.
      const btns = (m.raw as { buttons?: Array<{ id: string; label: string }> } | null)?.buttons;
      if (btns?.length) {
        calls.push({
          id: `hist_${m.id}b`,
          tool: 'present_buttons',
          input: { buttons: btns },
          result: `${btns.length} button(s) will be shown attached to your next reply text`,
        });
      }
      if (calls.length > 0) {
        // The turn's real shape: assistant asks for tools, user returns
        // results, assistant speaks.
        messages.push({
          role: 'assistant',
          content: calls.map((c) => ({
            type: 'tool_use' as const,
            id: c.id,
            name: c.tool,
            input: c.input,
          })),
        });
        messages.push({
          role: 'user',
          content: calls.map((c) => ({
            type: 'tool_result' as const,
            tool_use_id: c.id,
            content: c.result,
          })),
        });
      }
      // Assistant rows are sanitized on replay too — a forged marker that
      // slipped into storage pre-fix must not re-teach the format.
      messages.push({ role: 'assistant', content: sanitizeReply(m.content).text });
      pending = [];
      continue;
    }
    messages.push({ role: 'user', content: userText(m) });
  }
  return messages;
}

/** Button clicks (user rows with raw.action) read naturally to an LLM. */
function userText(m: ConversationMessage): string {
  const action = (m.raw as { action?: { id: string } } | null)?.action;
  return action ? `[user clicked: ${m.content}]` : m.content;
}

/**
 * Breadcrumbs written before `raw.action` existed carry the same facts in
 * their text — parse them so pre-upgrade threads keep honest tool-block
 * replay instead of regressing to bare claims.
 */
function parseLegacyBreadcrumb(
  content: string,
): { tool: string; input: Record<string, unknown>; result: string } | null {
  const trigger = /^triggered workflow (\S+) \(txn (\S+)\)/.exec(content);
  if (trigger) {
    return {
      tool: 'trigger_workflow',
      input: { workflowKey: trigger[1] },
      result: `workflow ${trigger[1]} queued (transactionId ${trigger[2]})`,
    };
  }
  const resolved = /^conversation resolved(?::\s*(.+))?/.exec(content);
  if (resolved) {
    return {
      tool: 'resolve_conversation',
      input: resolved[1] ? { summary: resolved[1] } : {},
      result: 'conversation marked resolved',
    };
  }
  return null;
}

/**
 * `[action taken: …]` is platform-reserved transcript vocabulary — it only
 * ever appears in replayed context, never in stored replies. A model that
 * writes it into reply text is forging an audit receipt (observed live,
 * with a recycled real txn id). Strip it before the reply is stored.
 */
export function sanitizeReply(text: string): { text: string; forged: boolean } {
  const cleaned = text
    .replace(/^[ \t]*\[action taken:[^\]]*\][ \t]*$/gim, '')
    // The per-turn reminder is platform-internal too — a model echoing it
    // (or referencing it) must not leak it to the user.
    .replace(/<platform_reminder>[\s\S]*?<\/platform_reminder>/gi, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
  return { text: cleaned, forged: cleaned !== text.trim() };
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
    {
      name: 'present_buttons',
      description:
        'Attach tappable choice buttons to the reply you are about to write. Call it ' +
        'when you are offering the user a small set of options (confirm/decline, pick ' +
        'a category, choose a fix); a tap comes back to you as "[user clicked: ' +
        '<label>]". The buttons render attached to your reply text, so do NOT also ' +
        'enumerate the options inside the text. Calling again replaces the previous ' +
        'set — the last call wins.',
      input_schema: {
        type: 'object',
        properties: {
          buttons: {
            type: 'array',
            maxItems: 6,
            description: 'The choices to offer, in display order (at most 6)',
            items: {
              type: 'object',
              properties: {
                id: {
                  type: 'string',
                  maxLength: 64,
                  description: 'Stable machine id, e.g. "resend_order"',
                },
                label: {
                  type: 'string',
                  maxLength: 48,
                  description: 'What the user sees on the button',
                },
              },
              required: ['id', 'label'],
            },
          },
        },
        required: ['buttons'],
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
  hooks: {
    onResolve: () => void;
    onButtons: (buttons: Array<{ id: string; label: string }>) => void;
  },
): Promise<{ message: string; isError?: boolean }> {
  const input = use.input as Record<string, unknown>;

  if (use.name === 'present_buttons') {
    // Presentation, not an effect: no txn, no breadcrumb — validation only,
    // with is_error results the model can correct against.
    const raw = input.buttons;
    if (!Array.isArray(raw) || raw.length === 0) {
      return { message: 'buttons must be a non-empty array of {id, label}', isError: true };
    }
    if (raw.length > 6) {
      return { message: `rejected: ${raw.length} buttons — at most 6 allowed`, isError: true };
    }
    const cleaned: Array<{ id: string; label: string }> = [];
    const ids = new Set<string>();
    for (const b of raw as Array<{ id?: unknown; label?: unknown }>) {
      const id = typeof b?.id === 'string' ? b.id.trim() : '';
      const label = typeof b?.label === 'string' ? b.label.trim() : '';
      if (!id || id.length > 64) {
        return { message: 'rejected: every button needs an id of 1-64 characters', isError: true };
      }
      if (!label || label.length > 48) {
        return { message: 'rejected: every button needs a label of 1-48 characters', isError: true };
      }
      if (ids.has(id)) {
        return { message: `rejected: duplicate button id "${id}"`, isError: true };
      }
      ids.add(id);
      cleaned.push({ id, label });
    }
    hooks.onButtons(cleaned);
    return {
      message: `${cleaned.length} button(s) will be shown attached to your next reply text`,
    };
  }

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
      {
        tool: 'resolve_conversation',
        input: summary ? { summary } : {},
        result: 'conversation marked resolved',
      },
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
    const resultMessage = result.duplicate
      ? `workflow ${workflowKey} was already sent for this message`
      : `workflow ${workflowKey} queued (transactionId ${result.transactionId})`;
    await breadcrumb(
      conversation,
      `signal-${inbound.id}-trigger-${workflowKey}`,
      `triggered workflow ${workflowKey} (txn ${result.transactionId})`,
      {
        tool: 'trigger_workflow',
        input: { workflowKey, ...(input.payload ? { payload: input.payload } : {}) },
        result: resultMessage,
      },
    );
    return { message: resultMessage };
  }

  return { message: `unknown tool ${use.name}`, isError: true };
}

/**
 * Transcript breadcrumb, content-keyed so retries can't repeat it. `action`
 * records the structured tool call so history replay can reconstruct REAL
 * tool_use blocks instead of imitable prose.
 */
async function breadcrumb(
  conversation: Conversation,
  dedupeKey: string,
  content: string,
  action?: { tool: string; input: Record<string, unknown>; result: string },
): Promise<void> {
  await insertConversationMessage({
    conversationId: conversation.id,
    tenantId: conversation.tenant_id,
    role: 'system',
    content,
    dedupeKey,
    raw: action ? { action } : undefined,
  });
}
