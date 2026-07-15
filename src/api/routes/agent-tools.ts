import type { FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { authenticate } from '../auth';
import { sealSecret } from '../../auth/secret-box';
import { assertSafeOutboundUrl, UnsafeOutboundUrlError } from '../../core/safe-url';
import { getAgent } from '../../db/conversations.repo';
import {
  createToolDef,
  deleteToolDef,
  getToolDef,
  listToolDefs,
  rotateToolSecret,
  updateToolDef,
  type AgentToolDef,
} from '../../db/agent-tools.repo';

/**
 * The per-agent custom tool registry (Phase 18). Tools are only meaningful for
 * managed-runtime agents — the managed brain is what dispatches them — but we
 * deliberately do NOT block bridge agents here: a bridge agent can be
 * re-pointed to the managed runtime later, and its tool defs shouldn't be
 * stranded (or refused) in the meantime. So: resolve the agent, no runtime gate.
 */

/** Model-facing names we own; a customer tool may never shadow one. */
const RESERVED_TOOL_NAMES = [
  'trigger_workflow',
  'set_metadata',
  'resolve_conversation',
  'present_choices',
  'present_buttons',
  'request_input',
];

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Mutable-field shape shared by create (all required-ish) and patch. */
const descriptionSchema = z.string().min(1).max(1024);
const endpointUrlSchema = z.string().url().max(2048);
const approvalSchema = z.enum(['auto', 'required']);
const timeoutMsSchema = z.number().int().min(1000).max(30000);

const ToolCreateSchema = z.object({
  name: z.string(),
  description: descriptionSchema,
  // Loosely typed here; the JSON-Schema shape is checked explicitly below so
  // the caller always gets the precise message.
  parameters: z.record(z.unknown()),
  endpointUrl: endpointUrlSchema,
  approval: approvalSchema.optional().default('auto'),
  timeoutMs: timeoutMsSchema.optional().default(10000),
});

const ToolPatchSchema = z.object({
  description: descriptionSchema.optional(),
  parameters: z.record(z.unknown()).optional(),
  endpointUrl: endpointUrlSchema.optional(),
  approval: approvalSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  timeoutMs: timeoutMsSchema.optional(),
});

/** Shallow v1 validation: a JSON Schema object must be `{type:'object', ...}`. */
function paramsError(p: unknown): string | null {
  if (typeof p !== 'object' || p === null || Array.isArray(p)) {
    return 'parameters must be a JSON Schema object with type "object"';
  }
  if ((p as { type?: unknown }).type !== 'object') {
    return 'parameters must be a JSON Schema object with type "object"';
  }
  return null;
}

/**
 * SSRF write-time gate for the tool endpoint: our worker dials this URL, so it
 * must never point at private infrastructure. Mirrors agents.ts's unsafeUrlError.
 */
async function unsafeEndpointError(url: string): Promise<string | null> {
  try {
    await assertSafeOutboundUrl(url);
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) return `endpointUrl: ${err.message}`;
    throw err;
  }
  return null;
}

/** Public shape — the sealed secret never leaves the API. */
function toolView(t: AgentToolDef) {
  return {
    id: t.id,
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    endpointUrl: t.endpoint_url,
    approval: t.approval,
    timeoutMs: t.timeout_ms,
    status: t.status,
    createdAt: t.created_at,
  };
}

/** 32-byte call secret, base64url with an `ats_` (agent-tool-secret) prefix. */
function newToolSecret(): string {
  return `ats_${randomBytes(32).toString('base64url')}`;
}

export function registerAgentToolRoutes(app: FastifyInstance) {
  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/tools',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      const parsed = ToolCreateSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const { name, description, parameters, endpointUrl, approval, timeoutMs } = parsed.data;

      if (!NAME_RE.test(name)) {
        return reply.code(400).send({ error: 'tool name must match ^[a-z][a-z0-9_]{0,63}$' });
      }
      if (RESERVED_TOOL_NAMES.includes(name)) {
        return reply.code(400).send({ error: 'tool name is reserved' });
      }
      const paramsMsg = paramsError(parameters);
      if (paramsMsg) return reply.code(400).send({ error: paramsMsg });
      const unsafe = await unsafeEndpointError(endpointUrl);
      if (unsafe) return reply.code(400).send({ error: unsafe });

      const secret = newToolSecret();
      const tool = await createToolDef({
        tenantId: req.tenant.id,
        agentId: agent.id,
        name,
        description,
        parameters: parameters as Record<string, unknown>,
        endpointUrl,
        sealedSecret: sealSecret(secret),
        approval,
        timeoutMs,
      });
      if (!tool) {
        return reply
          .code(409)
          .send({ error: 'a tool with this name already exists on this agent' });
      }
      // The plaintext call secret is shown exactly once, like API keys.
      return reply.code(201).send({ tool: toolView(tool), secret });
    },
  );

  app.get<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/tools',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const tools = await listToolDefs(req.tenant.id, agent.id);
      return { tools: tools.map(toolView) };
    },
  );

  app.patch<{ Params: { identifier: string; toolId: string } }>(
    '/v1/agents/:identifier/tools/:toolId',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      const parsed = ToolPatchSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      if (parsed.data.parameters !== undefined) {
        const paramsMsg = paramsError(parsed.data.parameters);
        if (paramsMsg) return reply.code(400).send({ error: paramsMsg });
      }
      if (parsed.data.endpointUrl !== undefined) {
        const unsafe = await unsafeEndpointError(parsed.data.endpointUrl);
        if (unsafe) return reply.code(400).send({ error: unsafe });
      }

      // The tool must belong to THIS agent (not just this tenant).
      const existing = await getToolDef(req.tenant.id, req.params.toolId);
      if (!existing || existing.agent_id !== agent.id) {
        return reply.code(404).send({ error: 'unknown tool' });
      }

      const tool = await updateToolDef(req.tenant.id, req.params.toolId, {
        description: parsed.data.description,
        parameters: parsed.data.parameters as Record<string, unknown> | undefined,
        endpointUrl: parsed.data.endpointUrl,
        approval: parsed.data.approval,
        status: parsed.data.status,
        timeoutMs: parsed.data.timeoutMs,
      });
      if (!tool) return reply.code(404).send({ error: 'unknown tool' });
      return { tool: toolView(tool) };
    },
  );

  app.delete<{ Params: { identifier: string; toolId: string } }>(
    '/v1/agents/:identifier/tools/:toolId',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const existing = await getToolDef(req.tenant.id, req.params.toolId);
      if (!existing || existing.agent_id !== agent.id) {
        return reply.code(404).send({ error: 'unknown tool' });
      }
      // Call history survives via agent_tool_calls.tool_def_id ON DELETE SET NULL.
      await deleteToolDef(req.tenant.id, req.params.toolId);
      return { deleted: true };
    },
  );

  app.post<{ Params: { identifier: string; toolId: string } }>(
    '/v1/agents/:identifier/tools/:toolId/rotate-secret',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const existing = await getToolDef(req.tenant.id, req.params.toolId);
      if (!existing || existing.agent_id !== agent.id) {
        return reply.code(404).send({ error: 'unknown tool' });
      }
      const secret = newToolSecret();
      await rotateToolSecret(req.tenant.id, req.params.toolId, sealSecret(secret));
      return { secret };
    },
  );
}
