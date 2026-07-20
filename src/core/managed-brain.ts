import { createHash } from 'node:crypto';
import Anthropic from '@anthropic-ai/sdk';
import { fetch as undiciFetch } from 'undici';
import { openSecret } from '../auth/secret-box';
import { signWebhook } from '../api/webhook-signature';
import { assertSafeOutboundUrl, safeDispatcher, UnsafeOutboundUrlError } from './safe-url';
import { PermanentError, TransientError } from '../shared/errors';
import { logger } from '../shared/logger';
import { withSpan } from '../shared/tracing';
import { listWorkflows } from '../db/repositories';
import { pool } from '../db/pool';
import { internalTrigger } from './internal-trigger';
import {
  listToolDefs,
  recordToolCall,
  finishToolCall,
  setToolCallBreadcrumb,
  setToolCallCards,
  setToolCallNote,
  countExecutedCalls,
  type AgentToolDef,
  type ApprovalCardRef,
} from '../db/agent-tools.repo';
import { incrToolHourCount } from '../shared/agent-counters';
import { getTenantSetting } from '../db/tenant-settings.repo';
import { listChannelIdentities } from '../db/identities.repo';
import { logExec } from './execution-log';
import { slack, SlackError } from '../channels/slack';
import { telegram } from '../channels/telegram';
import type { Card, CardOption } from '../shared/cards';
import {
  insertConversationMessage,
  getConversationMessageByDedupe,
  getConnectionById,
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
/** How long a `approval='required'` call waits before the sweep expires it. */
const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;
/** Cap a customer tool's response body stored as the model-facing result. */
const CUSTOM_TOOL_RESULT_MAX = 16 * 1024;
/** Cap a failing tool's error body echoed back to the model (self-correction). */
const CUSTOM_TOOL_ERROR_SNIPPET_MAX = 512;
/** Custom-tool POSTs get their own bound (defs also carry a per-tool timeout). */
const CUSTOM_TOOL_DEFAULT_TIMEOUT_MS = 10_000;

/** Token spend for one turn, summed across every model call in the loop. */
export interface TurnUsage {
  inputTokens: number;
  outputTokens: number;
  modelCalls: number;
}

/**
 * One event in a turn's execution trace (FROZEN shape — dashboard + API slices
 * build against it). Discriminated on `t`: a model round, a tool call, or the
 * bridge POST (emitted by the bridge runtime in the conversation processor, not
 * here). A union must be a `type`, not an `interface`.
 */
export type TurnTraceEvent =
  | { t: 'model_call'; ms: number; inputTokens: number; outputTokens: number; stopReason: string | null; model: string }
  | { t: 'tool_call'; name: string; ms: number; ok: boolean; paused?: true }
  | { t: 'bridge_post'; ms: number; status: number; ok: boolean };

/** A turn's execution trace: wall-clock total + the ordered events. */
export interface TurnTrace {
  totalMs: number;
  events: TurnTraceEvent[];
}

/** A single tappable choice attached to a reply (present_buttons tool). */
type ReplyButton = { id: string; label: string };

export interface BrainTurnResult {
  /** The reply to deliver; null when the model refused or sent no text. */
  reply: string | null;
  /** Buttons the model presented for this reply (present_buttons tool). */
  buttons?: ReplyButton[];
  /** A card the model presented (present_choices/request_input tool). */
  card?: Card;
  /** True when the model resolved the conversation (caller publishes WS). */
  resolved: boolean;
  /** Transcript breadcrumb (refusal, truncation, loop cap) — visible. */
  note?: string;
  /** What this turn cost on the customer's key. */
  usage: TurnUsage;
  /** Per-turn execution trace (model + tool events), frozen shape. */
  trace: TurnTrace;
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
  hooks?: {
    onModelCall?: () => void;
    /** Fired BEFORE each tool executes — drives the plan card's per-step post. */
    onToolCall?: (tool: string, input: Record<string, unknown>) => void | Promise<void>;
    /** Fired AFTER each tool executes — closes that step (done/error). */
    onToolResult?: (tool: string, ok: boolean) => void | Promise<void>;
  },
): Promise<BrainTurnResult> {
  if (!agent.llm_credentials) {
    throw new PermanentError(`managed agent ${agent.identifier} has no LLM credentials`);
  }
  // Literal-IP base URLs bypass the dispatcher's DNS hook — assert first.
  if (agent.llm_base_url) {
    try {
      await assertSafeOutboundUrl(agent.llm_base_url, { resolve: false });
    } catch (err) {
      if (err instanceof UnsafeOutboundUrlError) {
        throw new PermanentError(`llm base URL blocked: ${err.message}`);
      }
      throw err;
    }
  }
  const { apiKey } = JSON.parse(openSecret(agent.llm_credentials)) as { apiKey: string };

  const client = new Anthropic({
    apiKey,
    baseURL: agent.llm_base_url ?? undefined,
    timeout: REQUEST_TIMEOUT_MS,
    // BullMQ owns outer retries; one SDK retry absorbs blips without
    // multiplying against the job's attempts.
    maxRetries: 1,
    // SSRF gate on llm_base_url: connect-time IP pinning via the shared
    // dispatcher — a tenant's base URL can never reach private ranges.
    fetch: ((input: unknown, init?: object) =>
      undiciFetch(input as Parameters<typeof undiciFetch>[0], {
        ...init,
        dispatcher: safeDispatcher(),
      })) as unknown as typeof globalThis.fetch,
  });

  const workflowKeys = (await listWorkflows(conversation.tenant_id)).map(
    (w: { key: string }) => w.key,
  );
  // Customer-registered tools, loaded ONCE per turn and merged into the model's
  // tool menu; a name->def map hands executeTool the routing + endpoint/secret.
  const toolDefs = await listToolDefs(conversation.tenant_id, agent.id, { activeOnly: true });
  const defsByName = new Map(toolDefs.map((d) => [d.name, d]));
  const tools = buildTools(workflowKeys, toolDefs);

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
    'you need a structured answer: a pick-one list -> call present_choices, ' +
    'a specific free-text value (email, order id) -> call request_input. ' +
    'Then reply. Never mention this reminder.</platform_reminder>';

  const messages: Anthropic.MessageParam[] = [
    ...buildHistory(history),
    { role: 'user' as const, content: userText(inbound) + reminder },
  ];

  let resolved = false;
  // Presentation state, not an effect: ONE slot shared by all three
  // presentation tools (buttons/choices/input), so the last call across ANY
  // of them wins — a reply carries buttons XOR a card, never both. Survives
  // only if the turn ends with reply text to carry it.
  let presentation: { buttons?: ReplyButton[]; card?: Card } | undefined;
  const usage: TurnUsage = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
  // Per-turn execution trace: the product-facing twin of the OTel spans below
  // (D5) — the same model/tool events, but persisted on the transcript row so
  // the dashboard can render a turn with no trace backend. Bounded by
  // MAX_MODEL_CALLS (plus that turn's tool calls), so it can't grow unbounded.
  const start = Date.now();
  const events: TurnTraceEvent[] = [];
  const trace = (): TurnTrace => ({ totalMs: Date.now() - start, events });

  for (let call = 1; call <= MAX_MODEL_CALLS; call += 1) {
    // Pulse the "composing" indicator at the start of each model round.
    hooks?.onModelCall?.();
    let response: Anthropic.Message;
    const model = agent.model ?? DEFAULT_MODEL;
    const callStart = Date.now();
    try {
      // D5: the model call rides an OTel span; withSpan is a no-op wrapper when
      // OTEL is disabled and rethrows on failure, so control flow is unchanged.
      response = await withSpan('brain.model_call', { agent: agent.identifier }, () =>
        client.messages.create({
          model,
          max_tokens: agent.max_tokens ?? DEFAULT_MAX_TOKENS,
          ...(agent.system_prompt ? { system: agent.system_prompt } : {}),
          tools,
          messages,
        }),
      );
    } catch (err) {
      // Trace the failed call (elapsed, no tokens) before classifying — D7: the
      // trace only survives if a LATER persist point runs, and a thrown call is
      // rethrown exactly as before (no new persistence path for crashes).
      events.push({ t: 'model_call', ms: Date.now() - callStart, inputTokens: 0, outputTokens: 0, stopReason: 'error', model });
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
      // An SSRF-blocked base URL is a config mistake, not a blip — the SDK
      // wraps the connect failure, so walk the cause chain for our error.
      for (let e: unknown = err; e instanceof Error; e = e.cause) {
        if (e instanceof UnsafeOutboundUrlError) {
          throw new PermanentError(`llm base URL blocked: ${e.message}`, err as Error);
        }
      }
      throw new TransientError(`brain call failed: ${(err as Error).message}`, err);
    }

    usage.modelCalls += 1;
    usage.inputTokens += response.usage?.input_tokens ?? 0;
    usage.outputTokens += response.usage?.output_tokens ?? 0;
    events.push({
      t: 'model_call',
      ms: Date.now() - callStart,
      inputTokens: response.usage?.input_tokens ?? 0,
      outputTokens: response.usage?.output_tokens ?? 0,
      stopReason: response.stop_reason ?? null,
      model,
    });

    // Check stop_reason before reading content (refusals can carry none).
    if (response.stop_reason === 'refusal') {
      logger.info({ agent: agent.identifier }, 'managed brain refused the turn');
      return { reply: null, resolved, note: 'the model declined to answer this message', usage, trace: trace() };
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
          trace: trace(),
        };
      }
      const toolUses = response.content.filter(
        (block): block is Anthropic.ToolUseBlock => block.type === 'tool_use',
      );
      // Execute ALL requested tools; return ALL results in ONE user message
      // (splitting them trains the model out of parallel calls).
      const results: Anthropic.ToolResultBlockParam[] = [];
      // A `approval='required'` custom tool records a pending row and forces the
      // turn to END after this round (no reply the model composes — a
      // deterministic "asked a teammate" note ships instead).
      const pausedTools: string[] = [];
      for (const use of toolUses) {
        // Per-tool interleave (call → exec → result) so the plan card's
        // "close the last pending step" always lands on THIS tool's step.
        await hooks?.onToolCall?.(use.name, use.input as Record<string, unknown>);
        const toolStart = Date.now();
        // D5: the tool execution rides an OTel span (no-op when OTEL is off).
        // executeTool never throws, but withSpan would rethrow if it did — so
        // control flow is unchanged either way.
        const outcome = await withSpan(
          'brain.tool',
          { agent: agent.identifier, tool: use.name },
          () =>
            executeTool(use, agent, conversation, subscriber, inbound, defsByName, {
              onResolve: () => {
                resolved = true;
              },
              onButtons: (presented) => {
                presentation = { buttons: presented };
              },
              onCard: (presented) => {
                presentation = { card: presented };
              },
            }),
        );
        events.push({
          t: 'tool_call',
          name: use.name,
          ms: Date.now() - toolStart,
          ok: !outcome.isError,
          ...(outcome.pausedToolName ? { paused: true as const } : {}),
        });
        await hooks?.onToolResult?.(use.name, !outcome.isError);
        results.push({
          type: 'tool_result',
          tool_use_id: use.id,
          content: outcome.message,
          ...(outcome.isError ? { is_error: true } : {}),
        });
        if (outcome.pausedToolName) pausedTools.push(outcome.pausedToolName);
      }
      messages.push({ role: 'user', content: results });
      // Force-exit: one or more approval-gated tools paused this turn. Ship the
      // deterministic note as the reply through the normal reply/plan-card path
      // (one job = one finalize); the follow-up turn runs at decision time.
      if (pausedTools.length > 0) {
        const names = [...new Set(pausedTools)];
        const note =
          names.length === 1
            ? `I've asked a teammate to approve ${names[0]} — I'll follow up here as soon as it's decided.`
            : `I've asked a teammate to approve these actions (${names.join(', ')}) — ` +
              `I'll follow up here as soon as they're decided.`;
        return { reply: note, resolved, usage, trace: trace() };
      }
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
      // No reply text -> nothing to attach the presentation to; it drops here.
      buttons: reply.length > 0 ? presentation?.buttons : undefined,
      card: reply.length > 0 ? presentation?.card : undefined,
      resolved,
      note: notes.length > 0 ? notes.join(' · ') : undefined,
      usage,
      trace: trace(),
    };
  }

  // Unreachable (the cap returns inside the loop), but keep TS satisfied.
  return { reply: null, resolved, note: 'tool loop limit reached before a final reply', usage, trace: trace() };
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
    if (m.deleted_at) {
      if (m.role === 'agent') pending = [];
      continue;
    }
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
      // A reply that carried a card replays as the present_choices/request_input
      // call that produced it — same honesty rule as buttons above.
      const card = (m.raw as { card?: Card } | null)?.card;
      if (card?.type === 'select') {
        calls.push({
          id: `hist_${m.id}c`,
          tool: 'present_choices',
          input: {
            id: card.id,
            ...(card.prompt ? { prompt: card.prompt } : {}),
            options: card.options,
          },
          result: `a ${card.options.length}-option choice list will be shown attached to your next reply text`,
        });
      } else if (card?.type === 'text_input') {
        calls.push({
          id: `hist_${m.id}c`,
          tool: 'request_input',
          input: {
            id: card.id,
            ...(card.prompt ? { prompt: card.prompt } : {}),
            ...(card.placeholder ? { placeholder: card.placeholder } : {}),
          },
          result: 'a text input field will be shown attached to your next reply text',
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

/** Button clicks / card answers (user rows with raw.action) read naturally to an LLM. */
function userText(m: ConversationMessage): string {
  const action = (m.raw as { action?: { id: string; kind?: string } } | null)?.action;
  if (!action) return m.content;
  return action.kind === 'input' ? `[user entered: ${m.content}]` : `[user clicked: ${m.content}]`;
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
function buildTools(workflowKeys: string[], toolDefs: AgentToolDef[] = []): Anthropic.Tool[] {
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
    {
      name: 'present_choices',
      description:
        'Offer the user a single-choice list attached to the reply you are about to ' +
        'write. Call when the answer should be picked from known options (2-25). The ' +
        'choices render as a native dropdown/keyboard attached to your reply. Do not ' +
        'also enumerate the options in your reply text. Calling again replaces the ' +
        'previous presentation — the last call wins.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 64, description: 'Stable machine id for this choice, e.g. "pick_size"' },
          prompt: { type: 'string', maxLength: 200, description: 'Optional label shown above/inside the picker' },
          options: {
            type: 'array',
            minItems: 2,
            maxItems: 25,
            description: 'The choices to offer, in display order (2-25)',
            items: {
              type: 'object',
              properties: {
                id: { type: 'string', maxLength: 64, description: 'Stable machine id, e.g. "small"' },
                label: { type: 'string', maxLength: 48, description: 'What the user sees for this option' },
              },
              required: ['id', 'label'],
            },
          },
        },
        required: ['id', 'options'],
      },
    },
    {
      name: 'request_input',
      description:
        'Ask the user for one short free-text value (an email, an order id…). Renders ' +
        'as a native input field attached to your reply. Do not use for open-ended ' +
        'conversation — only for a specific value you need. Calling again replaces the ' +
        'previous presentation — the last call wins.',
      input_schema: {
        type: 'object',
        properties: {
          id: { type: 'string', maxLength: 64, description: 'Stable machine id for this input, e.g. "order_id"' },
          prompt: { type: 'string', maxLength: 200, description: 'Optional label shown next to the field' },
          placeholder: { type: 'string', maxLength: 64, description: 'Optional grey hint inside the empty field' },
        },
        required: ['id'],
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

  // Customer-registered tools ride the same menu. `parameters` IS the JSON
  // schema the customer stored; a name collision with a built-in never happens
  // in practice (the built-ins own their names), and if it did the built-in
  // dispatch wins in executeTool — so the customer entry would just be inert.
  for (const def of toolDefs) {
    tools.push({
      name: def.name,
      description: def.description,
      input_schema: def.parameters as Anthropic.Tool.InputSchema,
    });
  }
  return tools;
}

/** The outcome of one tool call. `pausedToolName` is set only when an
 * approval-gated custom tool recorded a pending row and the turn must end. */
interface ToolOutcome {
  message: string;
  isError?: boolean;
  pausedToolName?: string;
}

/** Execute one tool call; failures come back as is_error results, not throws. */
async function executeTool(
  use: Anthropic.ToolUseBlock,
  agent: Agent,
  conversation: Conversation,
  subscriber: Subscriber,
  inbound: ConversationMessage,
  defsByName: Map<string, AgentToolDef>,
  hooks: {
    onResolve: () => void;
    onButtons: (buttons: ReplyButton[]) => void;
    onCard: (card: Card) => void;
  },
): Promise<ToolOutcome> {
  const input = use.input as Record<string, unknown>;

  // Customer-registered tools dispatch here (built-ins above own their names).
  const def = defsByName.get(use.name);
  if (def) {
    return executeCustomTool(use, def, agent, conversation, subscriber, inbound);
  }

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

  if (use.name === 'present_choices') {
    // Presentation, not an effect: no txn, no breadcrumb — validation only,
    // with is_error results the model can correct against.
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id || id.length > 64) {
      return { message: 'present_choices needs an id of 1-64 characters', isError: true };
    }
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : undefined;
    if (prompt !== undefined && (prompt.length === 0 || prompt.length > 200)) {
      return { message: 'prompt must be 1-200 characters', isError: true };
    }
    const rawOptions = input.options;
    if (!Array.isArray(rawOptions) || rawOptions.length < 2 || rawOptions.length > 25) {
      return { message: 'present_choices needs 2-25 options', isError: true };
    }
    const options: CardOption[] = [];
    const ids = new Set<string>();
    for (const o of rawOptions as Array<{ id?: unknown; label?: unknown }>) {
      const oid = typeof o?.id === 'string' ? o.id.trim() : '';
      const label = typeof o?.label === 'string' ? o.label.trim() : '';
      if (!oid || oid.length > 64) {
        return { message: 'every option needs an id of 1-64 characters', isError: true };
      }
      if (!label || label.length > 48) {
        return { message: 'every option needs a label of 1-48 characters', isError: true };
      }
      if (ids.has(oid)) {
        return { message: `duplicate option ids: ${oid}`, isError: true };
      }
      ids.add(oid);
      options.push({ id: oid, label });
    }
    const card: Card = { type: 'select', id, ...(prompt ? { prompt } : {}), options };
    hooks.onCard(card);
    return {
      message: `a ${options.length}-option choice list will be shown attached to your next reply text`,
    };
  }

  if (use.name === 'request_input') {
    const id = typeof input.id === 'string' ? input.id.trim() : '';
    if (!id || id.length > 64) {
      return { message: 'request_input needs an id of 1-64 characters', isError: true };
    }
    const prompt = typeof input.prompt === 'string' ? input.prompt.trim() : undefined;
    if (prompt !== undefined && (prompt.length === 0 || prompt.length > 200)) {
      return { message: 'prompt must be 1-200 characters', isError: true };
    }
    const placeholder = typeof input.placeholder === 'string' ? input.placeholder.trim() : undefined;
    if (placeholder !== undefined && (placeholder.length === 0 || placeholder.length > 64)) {
      return { message: 'placeholder must be 64 chars or fewer', isError: true };
    }
    const card: Card = {
      type: 'text_input',
      id,
      ...(prompt ? { prompt } : {}),
      ...(placeholder ? { placeholder } : {}),
    };
    hooks.onCard(card);
    return { message: 'a text input field will be shown attached to your next reply text' };
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
 * A customer tool call. `auto` tools POST immediately; `required` tools record
 * a pending approval, breadcrumb the pause, notify staff, and force the turn to
 * end. Either way the breadcrumb stays pair-complete so history replay reads as
 * a real tool_use/tool_result pair (never a bare claim or imitable prose).
 *
 * Idempotency rides the agent_tool_calls dedupe_key (tc-<inboundId>-<tool>-
 * <argsHash16>): a retried job reuses the ORIGINAL row instead of double-POSTing
 * a side effect.
 */
async function executeCustomTool(
  use: Anthropic.ToolUseBlock,
  def: AgentToolDef,
  agent: Agent,
  conversation: Conversation,
  subscriber: Subscriber,
  inbound: ConversationMessage,
): Promise<ToolOutcome> {
  const args = use.input as Record<string, unknown>;
  // stableStringify, NOT JSON.stringify: a job retry re-invokes a
  // NONDETERMINISTIC model, which may emit the same args with a different
  // object key order — insertion-ordered serialization would mint a second
  // dedupe key and double-fire a side-effecting customer POST.
  const argsHash = createHash('sha256').update(stableStringify(args)).digest('hex');
  const dedupeKey = `tc-${inbound.id}-${def.name}-${argsHash.slice(0, 16)}`;
  const crumbKey = `signal-${inbound.id}-tool-${def.name}-${argsHash.slice(0, 8)}`;
  const guard = def.guard ?? undefined;

  // G3 RATE CAP: a coarse per-tool, per-subscriber hourly ceiling, checked
  // before ANY execution or approval (auto OR required). The counter bumps on
  // every attempt; over the cap returns an is_error the model explains politely
  // and records NOTHING — no tool-call row, no POST, no approval spam. The
  // rejection still flows out as a tool_call ok:false in the turn trace.
  if (guard?.maxCallsPerHour && guard.maxCallsPerHour > 0) {
    const hourCount = await incrToolHourCount(def.id, conversation.subscriber_id);
    if (hourCount > guard.maxCallsPerHour) {
      return { message: 'rate limit reached for this action — try again later', isError: true };
    }
  }

  // G1 REPEAT-ACTION: an auto tool armed with maxAutoCalls+windowDays flips to
  // the approval path once this subscriber's EXECUTED calls in the window reach
  // the ceiling. The agent detects, the rule decides, a human judges — and the
  // approval card gains a history line so the judge sees the pattern.
  let effectiveApproval: 'auto' | 'required' = def.approval;
  let guardHistory: string | null = null;
  if (
    def.approval === 'auto' &&
    guard?.maxAutoCalls &&
    guard.maxAutoCalls > 0 &&
    guard?.windowDays &&
    guard.windowDays > 0
  ) {
    const { count, recent } = await countExecutedCalls(
      def.id,
      conversation.subscriber_id,
      guard.windowDays,
    );
    if (count >= guard.maxAutoCalls) {
      effectiveApproval = 'required';
      guardHistory = guardHistoryLine(def.name, count, guard.windowDays, recent);
    }
  }

  if (effectiveApproval === 'required') {
    const { call, fresh } = await recordToolCall({
      tenantId: conversation.tenant_id,
      agentId: agent.id,
      conversationId: conversation.id,
      toolDefId: def.id,
      toolName: def.name,
      args,
      dedupeKey,
      status: 'pending',
      expiresAt: new Date(Date.now() + APPROVAL_TTL_MS),
    });
    // A retried job whose row was already decided returns the stored outcome as
    // a completed pair (no second pause, no duplicate notification).
    if (!fresh) {
      if (call.status === 'executed' || call.status === 'failed') {
        return { message: call.result ?? '', isError: call.status === 'failed' };
      }
      if (call.status === 'denied') {
        return { message: deniedResult(call.decided_by, call.note) };
      }
      if (call.status === 'expired') {
        return { message: 'approval expired' };
      }
      // still pending (or approved but not yet executed by the decision job):
      // re-pause on the SAME row without re-notifying.
      return { message: `pending human approval (${call.id})`, pausedToolName: def.name };
    }

    const result = `pending human approval (${call.id})`;
    // G1: stamp the repeat-action history on the paused row so the dashboard's
    // pending entry can show why it paused (the channel cards carry it too).
    if (guardHistory) await setToolCallNote(call.id, guardHistory);
    const crumbId = await breadcrumb(conversation, crumbKey, result, {
      tool: def.name,
      input: args,
      result,
    });
    if (crumbId) await setToolCallBreadcrumb(call.id, crumbId);

    // Reserved staff notification — convention over config, mirroring the
    // reserved workflow key: it fires at the tenant's OPS audience, the
    // reserved subscriber externalId 'approvals' (NEVER the conversation
    // subscriber — the end customer must not be told their own refund needs
    // approval). A tenant opts in by creating BOTH the 'agent-approvals'
    // workflow and an 'approvals' subscriber wired to their channels; missing
    // either is a silent no-op. Lookup-first because the trigger pipeline
    // upserts unknown recipients — firing blind would mint a phantom,
    // channel-less 'approvals' subscriber for tenants who never opted in.
    // Content-keyed (approval-note-<call.id>) so retries dedupe.
    const approver = await getApprovalsSubscriber(conversation.tenant_id);
    if (approver) {
      await internalTrigger({
        tenantId: conversation.tenant_id,
        workflowKey: 'agent-approvals',
        to: [
          {
            subscriberId: approver.external_id,
            email: approver.email ?? undefined,
            phone: approver.phone ?? undefined,
            pushToken: approver.push_token ?? undefined,
          },
        ],
        payload: {
          approvalId: call.id,
          agentIdentifier: agent.identifier,
          toolName: def.name,
          argsSummary: JSON.stringify(args).slice(0, 280),
          requestedAt: call.requested_at,
          conversationId: conversation.id,
        },
        transactionId: `approval-note-${call.id}`,
        source: `managed agent ${agent.identifier} approval`,
      }).catch((err) => {
        // A notification hiccup must not fail the pause — the row is the record.
        logger.warn({ err: (err as Error).message }, 'agent-approvals notification failed');
      });
    }

    // Channel approval cards: post an in-channel Approve/Deny card to the
    // tenant's configured Slack channel and/or Telegram approvers, tracking
    // each posted message on the call row so a tap correlates and the card can
    // later be edited to the outcome (slice B finalizer). WHOLLY best-effort —
    // every failure is swallowed so no channel hiccup can break the pause; the
    // agent_tool_calls row is the record, the cards are only an accelerator.
    try {
      const settings = await getTenantSetting<{
        slackConnectionId?: string;
        slackChannelId?: string;
        telegramConnectionId?: string;
      }>(conversation.tenant_id, 'approvals');
      if (settings) {
        const argsSummary = JSON.stringify(args).slice(0, 280);
        // Keep the Customer: line intact (Phase 19 lesson); the guard history
        // rides just under it when the repeat-action rule tripped the pause.
        const cardText =
          `Approval needed\n${agent.identifier} wants to run ${def.name}\n` +
          `Customer: ${subscriber.external_id}\n` +
          (guardHistory ? `${guardHistory}\n` : '') +
          `${argsSummary}\nAlso in the dashboard → Approvals.`;
        const cards: ApprovalCardRef[] = [];

        // --- Slack: one card in the configured channel ---
        if (settings.slackConnectionId && settings.slackChannelId) {
          const channelId = settings.slackChannelId;
          try {
            const conn = await getConnectionById(settings.slackConnectionId);
            if (
              conn &&
              conn.tenant_id === conversation.tenant_id &&
              conn.channel === 'slack' &&
              conn.status === 'active'
            ) {
              const { botToken } = JSON.parse(openSecret(conn.credentials)) as { botToken: string };
              const sent = await slack.postMessage(botToken, channelId, cardText, {
                buttons: [
                  { id: `approval:approve:${call.id}`, label: 'Approve' },
                  { id: `approval:deny:${call.id}`, label: 'Deny' },
                ],
              });
              cards.push({ channel: 'slack', connectionId: conn.id, channelId, ts: sent.ts });
            }
          } catch (err) {
            const code = err instanceof SlackError ? err.error : '';
            const detail =
              code === 'not_in_channel' || code === 'channel_not_found'
                ? `slack approval card failed: invite the bot to ${channelId} (${code})`
                : `slack approval card failed: ${(err as Error).message}`;
            logExec({
              tenantId: conversation.tenant_id,
              transactionId: `conv-${conversation.id}`,
              level: 'warn',
              detail,
            });
          }
        }

        // --- Telegram: one card per registered approver (private chat) ---
        if (settings.telegramConnectionId) {
          try {
            const conn = await getConnectionById(settings.telegramConnectionId);
            if (
              conn &&
              conn.tenant_id === conversation.tenant_id &&
              conn.channel === 'telegram' &&
              conn.status === 'active'
            ) {
              const { botToken } = JSON.parse(openSecret(conn.credentials)) as { botToken: string };
              const approvers = (
                await listChannelIdentities(conversation.tenant_id, 'approvals')
              ).filter((i) => i.channel === 'telegram');
              for (const ident of approvers) {
                // external_key is the approver's private chat id (== their user id).
                try {
                  const sent = await telegram.sendMessage(botToken, ident.external_key, cardText, {
                    buttons: [
                      { id: `apv:a:${call.id}`, label: 'Approve' },
                      { id: `apv:d:${call.id}`, label: 'Deny' },
                    ],
                  });
                  cards.push({
                    channel: 'telegram',
                    connectionId: conn.id,
                    chatId: ident.external_key,
                    messageId: sent.message_id,
                  });
                } catch (err) {
                  // Bot not /start'ed by this approver, blocked, etc. — skip them.
                  logExec({
                    tenantId: conversation.tenant_id,
                    transactionId: `conv-${conversation.id}`,
                    level: 'warn',
                    detail: `telegram approval card failed for ${ident.external_key}: ${(err as Error).message}`,
                  });
                }
              }
            }
          } catch (err) {
            logExec({
              tenantId: conversation.tenant_id,
              transactionId: `conv-${conversation.id}`,
              level: 'warn',
              detail: `telegram approval cards failed: ${(err as Error).message}`,
            });
          }
        }

        if (cards.length) await setToolCallCards(call.id, cards);
      }
    } catch (err) {
      // Belt-and-braces: even a settings-read blip must not break the pause.
      logger.warn({ err: (err as Error).message }, 'approval card posting failed');
    }

    return { message: result, pausedToolName: def.name };
  }

  // approval === 'auto': record as pre-approved, then POST now.
  const { call, fresh } = await recordToolCall({
    tenantId: conversation.tenant_id,
    agentId: agent.id,
    conversationId: conversation.id,
    toolDefId: def.id,
    toolName: def.name,
    args,
    dedupeKey,
    status: 'approved',
  });
  if (!fresh && (call.status === 'executed' || call.status === 'failed')) {
    // Completed on a prior attempt — reuse the stored result, no second POST.
    return { message: call.result ?? '', isError: call.status === 'failed' };
  }

  // G4: wall-clock the signed POST and persist it on the executed/failed row.
  const postStart = Date.now();
  const { result, isError } = await postCustomToolCall(def, call.id, args, agent, conversation, subscriber);
  const durationMs = Date.now() - postStart;
  // Atomic claim from 'approved'; a null loser (already executed) reuses stored.
  const claimed = await finishToolCall(call.id, isError ? 'failed' : 'executed', result, 'approved', durationMs);
  const finalResult = claimed?.result ?? result;
  const finalIsError = (claimed?.status ?? (isError ? 'failed' : 'executed')) === 'failed';
  const crumbId = await breadcrumb(conversation, crumbKey, finalResult, {
    tool: def.name,
    input: args,
    result: finalResult,
  });
  if (crumbId) await setToolCallBreadcrumb(call.id, crumbId);
  return { message: finalResult, isError: finalIsError };
}

/** The result string stored/replayed when an approval is denied. */
export function deniedResult(decidedBy: string | null, note: string | null): string {
  return `denied by ${decidedBy ?? 'unknown'}${note ? `: ${note}` : ''}`;
}

/** English ordinal for a positive integer: 1->1st, 2->2nd, 3->3rd, 11->11th. */
function ordinal(n: number): string {
  const rem100 = n % 100;
  if (rem100 >= 11 && rem100 <= 13) return `${n}th`;
  switch (n % 10) {
    case 1:
      return `${n}st`;
    case 2:
      return `${n}nd`;
    case 3:
      return `${n}rd`;
    default:
      return `${n}th`;
  }
}

/**
 * The repeat-action history line for an approval card / pending row (Phase 22
 * G1). `count` is this subscriber's prior EXECUTED calls in the window, so this
 * attempt is the (count+1)th. `recent` is up to 3 most-recent execution
 * timestamps, shown as UTC dates. FROZEN format — the dashboard + tests read it.
 * e.g. "⚠ 2nd refund_customer in 30d for this customer — prior: 2026-07-20"
 */
export function guardHistoryLine(
  tool: string,
  count: number,
  windowDays: number,
  recent: string[],
): string {
  const dates = recent.map((iso) => new Date(iso).toISOString().slice(0, 10)).join(', ');
  const prior = dates ? ` — prior: ${dates}` : '';
  return `⚠ ${ordinal(count + 1)} ${tool} in ${windowDays}d for this customer${prior}`;
}

/**
 * Canonical JSON for content hashing: object keys recursively sorted, arrays
 * keep their order, primitives serialize as JSON.stringify would. Only for
 * JSON-shaped values (tool args are parsed JSON — no Dates/functions/cycles).
 * Exists because the dedupe key must be identical across job retries even
 * when the re-invoked model emits the same args in a different key order.
 */
export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) {
    // JSON semantics: undefined inside an array serializes as null.
    return `[${value.map((v) => (v === undefined ? 'null' : stableStringify(v))).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const entries = Object.keys(obj)
      .sort()
      // JSON semantics: undefined-valued keys are omitted.
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * The tenant's reserved ops-side subscriber for approval notifications
 * (externalId 'approvals'): find-not-create, so a tenant who never opted in
 * gets no phantom subscriber and no notification. Inline query (not a repo
 * addition) because the data layer is frozen for this slice.
 */
async function getApprovalsSubscriber(tenantId: string): Promise<Subscriber | null> {
  const { rows } = await pool.query(
    `select external_id, email, phone, push_token
       from subscribers where tenant_id = $1 and external_id = 'approvals'`,
    [tenantId],
  );
  return rows[0] ?? null;
}

/**
 * POST a customer tool's invocation to its endpoint, signed exactly like the
 * bridge transport (x-asyncify-timestamp + -signature over `${ts}.${body}`),
 * plus an idempotency key (the call id) so the customer can dedupe our retries.
 * NEVER throws: every failure (non-2xx, network, timeout, blocked URL) comes
 * back as {isError:true} so the model self-corrects — side-effecting POSTs are
 * not auto-retried within a turn. Shared with the tool-decision resume path.
 */
export async function postCustomToolCall(
  def: Pick<AgentToolDef, 'name' | 'endpoint_url' | 'secret' | 'timeout_ms'>,
  callId: string,
  args: Record<string, unknown>,
  agent: Pick<Agent, 'identifier'>,
  conversation: Pick<Conversation, 'id'>,
  subscriber: Pick<Subscriber, 'external_id'>,
): Promise<{ result: string; isError: boolean }> {
  // Defense in depth: the endpoint was SSRF-checked at registration, re-check
  // literal private IPs here (they bypass the dispatcher's DNS hook).
  try {
    await assertSafeOutboundUrl(def.endpoint_url, { resolve: false });
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      return { result: `endpoint blocked: ${err.message}`, isError: true };
    }
    return { result: `endpoint check failed: ${(err as Error).message}`, isError: true };
  }

  const rawBody = JSON.stringify({
    toolCallId: callId,
    tool: def.name,
    arguments: args,
    agent: { identifier: agent.identifier },
    conversation: { id: conversation.id, subscriberId: subscriber.external_id },
  });
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = signWebhook(openSecret(def.secret), timestamp, rawBody);

  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(),
    def.timeout_ms > 0 ? def.timeout_ms : CUSTOM_TOOL_DEFAULT_TIMEOUT_MS,
  );
  try {
    const response = await undiciFetch(def.endpoint_url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-asyncify-timestamp': timestamp,
        'x-asyncify-signature': signature,
        'x-asyncify-idempotency-key': callId,
      },
      body: rawBody,
      signal: controller.signal,
      dispatcher: safeDispatcher(),
      // A tool endpoint must answer directly; a redirect could bounce us to a
      // private host (SSRF), so never follow one.
      redirect: 'manual',
    });
    const text = await response.text().catch(() => '');
    if (!response.ok) {
      return {
        result: `HTTP ${response.status}: ${text.slice(0, CUSTOM_TOOL_ERROR_SNIPPET_MAX)}`,
        isError: true,
      };
    }
    return { result: text.slice(0, CUSTOM_TOOL_RESULT_MAX), isError: false };
  } catch (err) {
    // undici wraps connect-time SSRF blocks in the cause chain.
    for (let e: unknown = err; e instanceof Error; e = e.cause) {
      if (e instanceof UnsafeOutboundUrlError) {
        return { result: `endpoint blocked: ${e.message}`, isError: true };
      }
    }
    const msg = controller.signal.aborted ? `timed out after ${def.timeout_ms}ms` : (err as Error).message;
    return { result: `tool request failed: ${msg}`, isError: true };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Transcript breadcrumb, content-keyed so retries can't repeat it. `action`
 * records the structured tool call so history replay can reconstruct REAL
 * tool_use blocks instead of imitable prose. Returns the breadcrumb row id
 * (recovered from the dedupe key on a retry that lost the insert) so a caller
 * can point an agent_tool_calls row at it for in-place result updates.
 */
async function breadcrumb(
  conversation: Conversation,
  dedupeKey: string,
  content: string,
  action?: { tool: string; input: Record<string, unknown>; result: string },
): Promise<string | null> {
  const row =
    (await insertConversationMessage({
      conversationId: conversation.id,
      tenantId: conversation.tenant_id,
      role: 'system',
      content,
      dedupeKey,
      raw: action ? { action } : undefined,
    })) ?? (await getConversationMessageByDedupe(conversation.id, dedupeKey));
  return row?.id ?? null;
}
