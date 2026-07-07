/**
 * @asyncify-hq/agent — build the brain, Asyncify handles the channels.
 *
 *   import { defineAgent, createHandler } from '@asyncify-hq/agent';
 *
 *   const support = defineAgent({
 *     async onMessage(ctx) {
 *       if (ctx.message.text.includes('order')) {
 *         ctx.metadata.set('topic', 'orders');
 *         ctx.trigger('order-shipped', { payload: { order: '#1042' } });
 *         return 'A replacement is on the way — confirmation email incoming.';
 *       }
 *       return `You said: ${ctx.message.text}`;
 *     },
 *   });
 *
 *   http.createServer(createHandler(support, {
 *     signingSecret: process.env.ASYNCIFY_AGENT_SECRET!,
 *   })).listen(4100);
 *
 * Asyncify POSTs each normalized conversation turn (any channel) to this
 * handler; the reply and any signals (metadata / trigger / resolve) are
 * batched into the single HTTP response. Zero dependencies.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

// ---- the event Asyncify sends ----

export interface AgentEventMessage {
  id: string;
  text: string;
  createdAt: string;
}

export interface AgentEventConversation {
  id: string;
  channel: string;
  status: 'active' | 'resolved';
  metadata: Record<string, unknown>;
  messageCount: number;
}

export interface AgentEventSubscriber {
  subscriberId: string;
  email: string | null;
  phone: string | null;
}

/** Prior turns, pre-shaped for LLM SDKs (drop straight into messages[]). */
export interface HistoryEntry {
  role: 'user' | 'assistant';
  content: string;
}

export interface AgentEvent {
  type: 'message';
  agent: { identifier: string; name: string };
  conversation: AgentEventConversation;
  subscriber: AgentEventSubscriber;
  message: AgentEventMessage;
  history: HistoryEntry[];
}

// ---- what the handler sends back ----

export type Priority = 'p0' | 'p1' | 'p2';

export type Signal =
  | { type: 'metadata.set'; key: string; value: unknown }
  | { type: 'trigger'; workflowKey: string; payload?: Record<string, unknown>; priority?: Priority }
  | { type: 'resolve'; summary?: string };

export interface BridgeResponse {
  reply?: string;
  signals: Signal[];
}

// ---- the developer surface ----

export interface AgentContext {
  /** The inbound turn being handled. */
  message: AgentEventMessage;
  conversation: AgentEventConversation;
  subscriber: AgentEventSubscriber;
  /** Prior user/assistant turns, oldest first. */
  history: HistoryEntry[];
  /** Send a reply to the user (last call wins; returning a string does the same). */
  reply(text: string): void;
  metadata: {
    /** Persist a key on the conversation (survives across turns, 64KB total). */
    set(key: string, value: unknown): void;
    get(key: string): unknown;
  };
  /** Fire a normal Asyncify notification workflow, mid-conversation. */
  trigger(
    workflowKey: string,
    options?: { payload?: Record<string, unknown>; priority?: Priority },
  ): void;
  /** Mark the conversation resolved (a new message reopens it). */
  resolve(summary?: string): void;
}

export type MessageHandler = (
  ctx: AgentContext,
) => string | void | undefined | Promise<string | void | undefined>;

export interface AgentDefinition {
  onMessage: MessageHandler;
  /** Reserved for platform-dispatched resolve events (not sent yet). */
  onResolve?: (ctx: AgentContext) => void | Promise<void>;
}

export function defineAgent(definition: AgentDefinition): AgentDefinition {
  if (typeof definition.onMessage !== 'function') {
    throw new Error('defineAgent requires an onMessage handler');
  }
  return definition;
}

// ---- signature verification (same scheme the server signs with) ----

export function verifySignature(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  toleranceSec = 300,
): boolean {
  if (!timestamp || !signature) return false;
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts) || Math.abs(Date.now() / 1000 - ts) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return false;
  }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

// ---- run one event through the agent (transport-agnostic core) ----

export async function handleEvent(
  agent: AgentDefinition,
  event: AgentEvent,
): Promise<BridgeResponse> {
  const signals: Signal[] = [];
  let reply: string | undefined;
  const metadata = { ...event.conversation.metadata };

  const ctx: AgentContext = {
    message: event.message,
    conversation: event.conversation,
    subscriber: event.subscriber,
    history: event.history,
    reply(text) {
      reply = text;
    },
    metadata: {
      set(key, value) {
        metadata[key] = value;
        signals.push({ type: 'metadata.set', key, value });
      },
      get(key) {
        return metadata[key];
      },
    },
    trigger(workflowKey, options) {
      signals.push({
        type: 'trigger',
        workflowKey,
        payload: options?.payload,
        priority: options?.priority,
      });
    },
    resolve(summary) {
      signals.push({ type: 'resolve', summary });
    },
  };

  const returned = await agent.onMessage(ctx);
  if (typeof returned === 'string') reply = returned;

  return { reply, signals };
}

// ---- plain Node HTTP handler (works in Express/Fastify/Next route shims) ----

/** Structural subset of http.IncomingMessage / ServerResponse. */
export interface RequestLike {
  headers: Record<string, string | string[] | undefined>;
  on(event: 'data', cb: (chunk: unknown) => void): unknown;
  on(event: 'end', cb: () => void): unknown;
  on(event: 'error', cb: (err: Error) => void): unknown;
}

export interface ResponseLike {
  statusCode: number;
  setHeader(name: string, value: string): unknown;
  end(body?: string): unknown;
}

export interface HandlerOptions {
  /** The signing secret shown once when the agent was created (ags_...). */
  signingSecret: string;
  /** Clock-skew tolerance for the signed timestamp, seconds. */
  toleranceSec?: number;
}

export function createHandler(
  agent: AgentDefinition,
  options: HandlerOptions,
): (req: RequestLike, res: ResponseLike) => void {
  if (!options.signingSecret) throw new Error('createHandler requires signingSecret');

  return (req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)));
    req.on('error', () => respond(res, 400, { error: 'read error' }));
    req.on('end', () => {
      void (async () => {
        const rawBody = Buffer.concat(chunks).toString('utf8');
        const header = (name: string): string | undefined => {
          const v = req.headers[name];
          return Array.isArray(v) ? v[0] : v;
        };
        const ok = verifySignature(
          options.signingSecret,
          header('x-asyncify-timestamp'),
          header('x-asyncify-signature'),
          rawBody,
          options.toleranceSec,
        );
        if (!ok) return respond(res, 401, { error: 'invalid signature' });

        let event: AgentEvent;
        try {
          event = JSON.parse(rawBody) as AgentEvent;
        } catch {
          return respond(res, 400, { error: 'invalid JSON' });
        }
        if (event.type !== 'message') return respond(res, 200, { signals: [] });

        try {
          respond(res, 200, await handleEvent(agent, event));
        } catch (err) {
          respond(res, 500, { error: (err as Error).message });
        }
      })();
    });
  };
}

function respond(res: ResponseLike, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body));
}
