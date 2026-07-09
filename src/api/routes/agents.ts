import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { authenticate } from '../auth';
import { verifySubscriberToken } from '../../auth/subscriber-token';
import { sealSecret } from '../../auth/secret-box';
import { getEnvironment } from '../../db/accounts.repo';
import { upsertSubscriber } from '../../db/repositories';
import {
  conversationTranscript,
  createAgent,
  deleteAgent,
  findConversationByThread,
  getAgent,
  getConversation,
  insertConversationMessage,
  listAgents,
  listConversations,
  openConversation,
  resolveConversation,
  rotateAgentSecret,
  updateAgent,
  type Agent,
} from '../../db/conversations.repo';
import { getQueue, QUEUE } from '../../shared/queues';
import { logExec } from '../../core/execution-log';

/** Managed-runtime brain config; apiKey is write-only (sealed at rest). */
const LlmConfigSchema = z.object({
  apiKey: z.string().min(8).max(512).optional(),
  /** Anthropic-compatible endpoint; omit for api.anthropic.com. */
  baseUrl: z.string().url().max(2048).nullable().optional(),
});

const AgentSchema = z
  .object({
    identifier: z
      .string()
      .min(1)
      .max(255)
      .regex(/^[a-z0-9-_]+$/, 'lowercase letters, digits, - _ only'),
    name: z.string().min(1).max(255),
    description: z.string().max(2048).optional(),
    runtime: z.enum(['bridge', 'managed']).default('bridge'),
    bridgeUrl: z.string().url().max(2048).optional(),
    model: z.string().min(1).max(255).optional(),
    systemPrompt: z.string().max(100_000).optional(),
    maxTokens: z.number().int().min(256).max(8192).optional(),
    autoResolveMinutes: z.number().int().min(1).max(43_200).optional(),
    llm: LlmConfigSchema.optional(),
  })
  .refine((a) => a.runtime !== 'bridge' || Boolean(a.bridgeUrl), {
    message: 'bridgeUrl is required for the bridge runtime',
    path: ['bridgeUrl'],
  })
  .refine((a) => a.runtime !== 'managed' || Boolean(a.llm?.apiKey), {
    message: 'llm.apiKey is required for the managed runtime',
    path: ['llm', 'apiKey'],
  });

const AgentPatchSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  description: z.string().max(2048).optional(),
  runtime: z.enum(['bridge', 'managed']).optional(),
  bridgeUrl: z.string().url().max(2048).optional(),
  status: z.enum(['active', 'disabled']).optional(),
  model: z.string().min(1).max(255).optional(),
  systemPrompt: z.string().max(100_000).optional(),
  maxTokens: z.number().int().min(256).max(8192).optional(),
  /** null switches the idle-timeout backstop off. */
  autoResolveMinutes: z.number().int().min(1).max(43_200).nullable().optional(),
  llm: LlmConfigSchema.optional(),
});

const InboundMessageSchema = z.object({
  subscriberId: z.string().min(1).max(255),
  text: z.string().min(1).max(8192),
  /** Client-supplied id makes retries idempotent (same doctrine as transactionId). */
  messageId: z.string().min(1).max(255).optional(),
});

const InboundActionSchema = z.object({
  subscriberId: z.string().min(1).max(255),
  /** The clicked button, as offered on the agent reply. */
  actionId: z.string().min(1).max(64),
  label: z.string().min(1).max(48),
  /** Client-supplied id: a double-click can never become two actions. */
  actionEventId: z.string().min(1).max(255).optional(),
});

/** Public shape — sealed secrets (signing, LLM key) never leave the API. */
function agentView(agent: Agent) {
  return {
    identifier: agent.identifier,
    name: agent.name,
    description: agent.description,
    runtime: agent.runtime,
    bridgeUrl: agent.bridge_url,
    model: agent.model,
    systemPrompt: agent.system_prompt,
    llmBaseUrl: agent.llm_base_url,
    maxTokens: agent.max_tokens,
    autoResolveMinutes: agent.auto_resolve_minutes,
    hasLlmKey: Boolean(agent.llm_credentials),
    status: agent.status,
    createdAt: agent.created_at,
    updatedAt: agent.updated_at,
  };
}

function newAgentSecret(): string {
  return `ags_${randomBytes(24).toString('hex')}`;
}

/**
 * Inbound turns accept the widget's credential (x-subscriber-token, scoped
 * to exactly one subscriber) besides api-key/JWT — same pattern as inbox.
 */
async function authenticateSender(
  req: FastifyRequest,
  reply: FastifyReply,
  subscriberId: string,
): Promise<boolean> {
  const token = req.headers['x-subscriber-token'];
  if (typeof token === 'string' && token.length > 0) {
    const payload = verifySubscriberToken(token);
    if (!payload) {
      await reply.code(401).send({ error: 'invalid or expired subscriber token' });
      return false;
    }
    if (payload.subscriberId !== subscriberId) {
      await reply.code(403).send({ error: 'token is for a different subscriber' });
      return false;
    }
    const environment = await getEnvironment(payload.tenantId);
    if (!environment) {
      await reply.code(401).send({ error: 'unknown environment' });
      return false;
    }
    req.tenant = environment;
    return true;
  }
  await authenticate(req, reply);
  return Boolean(req.tenant) && !reply.sent;
}

export function registerAgentRoutes(app: FastifyInstance) {
  // ---- agent management (dashboard / server credentials) ----

  app.post('/v1/agents', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = AgentSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const secret = newAgentSecret();
    const agent = await createAgent({
      tenantId: req.tenant.id,
      identifier: parsed.data.identifier,
      name: parsed.data.name,
      description: parsed.data.description,
      runtime: parsed.data.runtime,
      bridgeUrl: parsed.data.bridgeUrl,
      sealedSecret: sealSecret(secret),
      model: parsed.data.model,
      systemPrompt: parsed.data.systemPrompt,
      maxTokens: parsed.data.maxTokens,
      autoResolveMinutes: parsed.data.autoResolveMinutes,
      llmBaseUrl: parsed.data.llm?.baseUrl ?? undefined,
      sealedLlmCredentials: parsed.data.llm?.apiKey
        ? sealSecret(JSON.stringify({ apiKey: parsed.data.llm.apiKey }))
        : undefined,
    });
    if (!agent) {
      return reply.code(409).send({ error: `agent "${parsed.data.identifier}" already exists` });
    }
    // The plaintext secret is shown exactly once, like API keys.
    return reply.code(201).send({ agent: agentView(agent), signingSecret: secret });
  });

  app.get('/v1/agents', { preHandler: [authenticate] }, async (req) => ({
    agents: (await listAgents(req.tenant.id)).map(agentView),
  }));

  app.get<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      return { agent: agentView(agent) };
    },
  );

  app.patch<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = AgentPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const existing = await getAgent(req.tenant.id, req.params.identifier);
      if (!existing) return reply.code(404).send({ error: 'unknown agent' });

      // Switching runtimes must not leave a broken agent behind.
      const nextRuntime = parsed.data.runtime ?? existing.runtime;
      if (nextRuntime === 'bridge' && !(parsed.data.bridgeUrl ?? existing.bridge_url)) {
        return reply.code(400).send({ error: 'bridge runtime requires a bridgeUrl' });
      }
      if (
        nextRuntime === 'managed' &&
        !(parsed.data.llm?.apiKey || existing.llm_credentials)
      ) {
        return reply.code(400).send({ error: 'managed runtime requires llm.apiKey' });
      }

      const agent = await updateAgent(req.tenant.id, req.params.identifier, {
        name: parsed.data.name,
        description: parsed.data.description,
        runtime: parsed.data.runtime,
        bridgeUrl: parsed.data.bridgeUrl,
        status: parsed.data.status,
        model: parsed.data.model,
        systemPrompt: parsed.data.systemPrompt,
        maxTokens: parsed.data.maxTokens,
        autoResolveMinutes: parsed.data.autoResolveMinutes,
        llmBaseUrl: parsed.data.llm === undefined ? undefined : parsed.data.llm.baseUrl,
        sealedLlmCredentials: parsed.data.llm?.apiKey
          ? sealSecret(JSON.stringify({ apiKey: parsed.data.llm.apiKey }))
          : undefined,
      });
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      return { agent: agentView(agent) };
    },
  );

  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/rotate-secret',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const secret = newAgentSecret();
      const rotated = await rotateAgentSecret(req.tenant.id, req.params.identifier, sealSecret(secret));
      if (!rotated) return reply.code(404).send({ error: 'unknown agent' });
      return { signingSecret: secret };
    },
  );

  app.delete<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier',
    { preHandler: [authenticate] },
    async (req) => ({ deleted: (await deleteAgent(req.tenant.id, req.params.identifier)) > 0 }),
  );

  // ---- inbound turns (the widget's send button) ----

  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/messages',
    async (req, reply) => {
      const parsed = InboundMessageSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      if (!(await authenticateSender(req, reply, parsed.data.subscriberId))) return;

      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      if (agent.status !== 'active') {
        return reply.code(409).send({ error: 'agent is disabled' });
      }

      const subscriber = await upsertSubscriber(req.tenant.id, {
        subscriberId: parsed.data.subscriberId,
      });
      const conversation = await openConversation({
        tenantId: req.tenant.id,
        agentId: agent.id,
        subscriberId: subscriber.id,
        channel: 'inapp',
        threadKey: parsed.data.subscriberId,
      });

      const message = await insertConversationMessage({
        conversationId: conversation.id,
        tenantId: req.tenant.id,
        role: 'user',
        content: parsed.data.text,
        dedupeKey: parsed.data.messageId ?? `user-${crypto.randomUUID()}`,
      });
      if (!message) {
        // Same client messageId seen before — accepted once, never twice.
        return reply.code(200).send({ conversationId: conversation.id, duplicate: true });
      }

      await getQueue(QUEUE.CONVERSATION).add(
        message.id,
        { tenantId: req.tenant.id, conversationId: conversation.id, messageId: message.id },
        { jobId: `conv-${message.id}`, attempts: 5 },
      );

      logExec({
        tenantId: req.tenant.id,
        transactionId: `conv-${conversation.id}`,
        level: 'info',
        detail: `inbound turn accepted: agent=${agent.identifier} subscriber=${parsed.data.subscriberId}`,
      });

      return reply.code(202).send({
        conversationId: conversation.id,
        messageId: message.id,
        status: conversation.status,
      });
    },
  );

  /** A button click — same pipeline as a message, structured as an action. */
  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/actions',
    async (req, reply) => {
      const parsed = InboundActionSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      if (!(await authenticateSender(req, reply, parsed.data.subscriberId))) return;

      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      if (agent.status !== 'active') {
        return reply.code(409).send({ error: 'agent is disabled' });
      }

      const subscriber = await upsertSubscriber(req.tenant.id, {
        subscriberId: parsed.data.subscriberId,
      });
      const conversation = await openConversation({
        tenantId: req.tenant.id,
        agentId: agent.id,
        subscriberId: subscriber.id,
        channel: 'inapp',
        threadKey: parsed.data.subscriberId,
      });

      // Stored as a user row whose text is the label — transcripts read
      // naturally everywhere; raw.action marks it as a click for the brain.
      const row = await insertConversationMessage({
        conversationId: conversation.id,
        tenantId: req.tenant.id,
        role: 'user',
        content: parsed.data.label,
        dedupeKey: parsed.data.actionEventId ?? `action-${crypto.randomUUID()}`,
        raw: { action: { id: parsed.data.actionId } },
      });
      if (!row) {
        return reply.code(200).send({ conversationId: conversation.id, duplicate: true });
      }

      await getQueue(QUEUE.CONVERSATION).add(
        row.id,
        { tenantId: req.tenant.id, conversationId: conversation.id, messageId: row.id },
        { jobId: `conv-${row.id}`, attempts: 5 },
      );

      logExec({
        tenantId: req.tenant.id,
        transactionId: `conv-${conversation.id}`,
        level: 'info',
        detail: `action accepted: agent=${agent.identifier} action=${parsed.data.actionId}`,
      });

      return reply.code(202).send({ conversationId: conversation.id, messageId: row.id });
    },
  );

  /**
   * The widget's own thread (subscriber-token friendly). System rows are
   * internal breadcrumbs — end users only see user/agent turns.
   */
  app.get<{ Params: { identifier: string }; Querystring: { subscriberId?: string } }>(
    '/v1/agents/:identifier/conversation',
    async (req, reply) => {
      const subscriberId = req.query.subscriberId ?? '';
      if (!subscriberId) return reply.code(400).send({ error: 'subscriberId is required' });
      if (!(await authenticateSender(req, reply, subscriberId))) return;

      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      const conversation = await findConversationByThread(agent.id, 'inapp', subscriberId);
      if (!conversation) return { conversation: null, messages: [] };
      const messages = await conversationTranscript(conversation.id);
      return {
        conversation: { id: conversation.id, status: conversation.status },
        messages: messages
          .filter((m) => m.role !== 'system')
          .map((m) => ({
            id: m.id,
            role: m.role,
            content: m.content,
            createdAt: m.created_at,
            buttons: (m.raw as { buttons?: unknown } | null)?.buttons,
          })),
      };
    },
  );

  // ---- conversation reads (dashboard + API) ----

  app.get<{ Querystring: { agent?: string; status?: string; limit?: string } }>(
    '/v1/conversations',
    { preHandler: [authenticate] },
    async (req) => {
      const limit = Math.min(Number.parseInt(req.query.limit ?? '50', 10) || 50, 200);
      const rows = await listConversations(req.tenant.id, {
        agentIdentifier: req.query.agent,
        status: req.query.status,
        limit,
      });
      return {
        conversations: rows.map((c) => ({
          id: c.id,
          agent: { identifier: c.agent_identifier, name: c.agent_name },
          subscriberId: c.subscriber_external_id,
          channel: c.channel,
          status: c.status,
          messageCount: c.message_count,
          lastMessagePreview: c.last_message_preview,
          lastMessageAt: c.last_message_at,
          createdAt: c.created_at,
        })),
      };
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/conversations/:id',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(400).send({ error: 'invalid conversation id' });
      }
      const conversation = await getConversation(req.tenant.id, req.params.id);
      if (!conversation) return reply.code(404).send({ error: 'unknown conversation' });
      const messages = await conversationTranscript(conversation.id);

      // Managed turns record their model spend on the row; sum for the panel.
      const totals = { inputTokens: 0, outputTokens: 0, modelCalls: 0 };
      const usageOf = (m: { raw: unknown }) => {
        const usage = (m.raw as { usage?: typeof totals } | null)?.usage;
        if (usage) {
          totals.inputTokens += usage.inputTokens ?? 0;
          totals.outputTokens += usage.outputTokens ?? 0;
          totals.modelCalls += usage.modelCalls ?? 0;
        }
        return usage;
      };

      return {
        conversation: {
          id: conversation.id,
          channel: conversation.channel,
          status: conversation.status,
          metadata: conversation.metadata,
          summary: conversation.summary,
          messageCount: conversation.message_count,
          lastMessageAt: conversation.last_message_at,
          createdAt: conversation.created_at,
        },
        messages: messages.map((m) => ({
          id: m.id,
          role: m.role,
          content: m.content,
          createdAt: m.created_at,
          usage: usageOf(m),
          buttons: (m.raw as { buttons?: unknown } | null)?.buttons,
          clicked: Boolean((m.raw as { action?: unknown } | null)?.action),
        })),
        usage: totals,
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/conversations/:id/resolve',
    { preHandler: [authenticate] },
    async (req, reply) => {
      if (!z.string().uuid().safeParse(req.params.id).success) {
        return reply.code(400).send({ error: 'invalid conversation id' });
      }
      const conversation = await getConversation(req.tenant.id, req.params.id);
      if (!conversation) return reply.code(404).send({ error: 'unknown conversation' });
      await resolveConversation(conversation.id, 'resolved manually');
      return { status: 'resolved' };
    },
  );
}
