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
  // Phase 23 built-ins: a custom def with these names would SHADOW the
  // built-in (custom dispatch is checked first in executeTool).
  'search_knowledge',
  'search_history',
  // Phase 24 long-term memory built-in.
  'remember',
  // Phase 26 HITL handoff built-in (always offered on managed agents).
  'handoff_to_human',
];

const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;

/** Mutable-field shape shared by create (all required-ish) and patch. */
const descriptionSchema = z.string().min(1).max(1024);
const endpointUrlSchema = z.string().url().max(2048);
const approvalSchema = z.enum(['auto', 'required']);
const timeoutMsSchema = z.number().int().min(1000).max(30000);

/**
 * Phase 22 per-tool guardrails (null clears; absent leaves untouched). The
 * repeat-action rule needs BOTH maxAutoCalls and windowDays, so they're set
 * together; maxCallsPerHour is independent. Enforcement lives in the managed
 * brain's executeCustomTool — this only persists the config.
 */
const guardSchema = z
  .object({
    maxAutoCalls: z.number().int().min(1).optional(),
    windowDays: z.number().int().min(1).max(365).optional(),
    maxCallsPerHour: z.number().int().min(1).optional(),
  })
  .refine((g) => (g.maxAutoCalls === undefined) === (g.windowDays === undefined), {
    message: 'maxAutoCalls and windowDays must be set together',
  })
  .nullable()
  .optional();

const ToolCreateSchema = z.object({
  name: z.string(),
  description: descriptionSchema,
  // Loosely typed here; the JSON-Schema shape is checked explicitly below so
  // the caller always gets the precise message.
  parameters: z.record(z.unknown()),
  endpointUrl: endpointUrlSchema,
  approval: approvalSchema.optional().default('auto'),
  timeoutMs: timeoutMsSchema.optional().default(10000),
  guard: guardSchema,
});

const ToolPatchSchema = z.object({
  description: descriptionSchema.optional(),
  parameters: z.record(z.unknown()).optional(),
  endpointUrl: endpointUrlSchema.optional(),
  approval: approvalSchema.optional(),
  status: z.enum(['active', 'disabled']).optional(),
  timeoutMs: timeoutMsSchema.optional(),
  guard: guardSchema,
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
    guard: t.guard,
    createdAt: t.created_at,
  };
}

/** 32-byte call secret, base64url with an `ats_` (agent-tool-secret) prefix. */
function newToolSecret(): string {
  return `ats_${randomBytes(32).toString('base64url')}`;
}

/* -------------------------------------------------------------------------- */
/* Shared with the A10 config importer                                         */
/* -------------------------------------------------------------------------- */

/**
 * A10: the registration LAWS, extracted so that a tool arriving in a config
 * file meets exactly the ones a tool arriving on this route meets — the same
 * schema object, the same name rules, the same JSON-Schema check, the same SSRF
 * guard, in the same order. The import path does not get its own gentler copy;
 * it calls these.
 *
 * Validation is separated from the WRITE on purpose: an import validates every
 * tool in the file before it creates any of them, so a file with one bad
 * endpoint is refused whole rather than half-applied.
 */
export type ToolInputResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; details?: unknown };

export type ToolCreateInput = z.infer<typeof ToolCreateSchema>;
export type ToolPatchInput = z.infer<typeof ToolPatchSchema>;

export async function validateToolCreate(
  body: unknown,
): Promise<ToolInputResult<z.infer<typeof ToolCreateSchema>>> {
  const parsed = ToolCreateSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: 'invalid body', details: parsed.error.issues };
  }
  const { name, parameters, endpointUrl } = parsed.data;
  if (!NAME_RE.test(name)) {
    return { ok: false, error: 'tool name must match ^[a-z][a-z0-9_]{0,63}$' };
  }
  if (RESERVED_TOOL_NAMES.includes(name)) return { ok: false, error: 'tool name is reserved' };
  const paramsMsg = paramsError(parameters);
  if (paramsMsg) return { ok: false, error: paramsMsg };
  const unsafe = await unsafeEndpointError(endpointUrl);
  if (unsafe) return { ok: false, error: unsafe };
  return { ok: true, data: parsed.data };
}

export async function validateToolPatch(
  body: unknown,
): Promise<ToolInputResult<z.infer<typeof ToolPatchSchema>>> {
  const parsed = ToolPatchSchema.safeParse(body);
  if (!parsed.success) {
    return { ok: false, error: 'invalid body', details: parsed.error.issues };
  }
  if (parsed.data.parameters !== undefined) {
    const paramsMsg = paramsError(parsed.data.parameters);
    if (paramsMsg) return { ok: false, error: paramsMsg };
  }
  if (parsed.data.endpointUrl !== undefined) {
    const unsafe = await unsafeEndpointError(parsed.data.endpointUrl);
    if (unsafe) return { ok: false, error: unsafe };
  }
  return { ok: true, data: parsed.data };
}

/**
 * Mint the call secret and store the def. Returns null on the unique-name
 * conflict, which both callers map to their own answer (409 here; "it already
 * exists, patch it instead" in the importer).
 */
export async function createValidatedTool(
  tenantId: string,
  agentId: string,
  data: z.infer<typeof ToolCreateSchema>,
): Promise<{ tool: AgentToolDef; secret: string } | null> {
  const secret = newToolSecret();
  const tool = await createToolDef({
    tenantId,
    agentId,
    name: data.name,
    description: data.description,
    parameters: data.parameters as Record<string, unknown>,
    endpointUrl: data.endpointUrl,
    sealedSecret: sealSecret(secret),
    approval: data.approval,
    timeoutMs: data.timeoutMs,
    guard: data.guard ?? null,
  });
  return tool ? { tool, secret } : null;
}


export function registerAgentToolRoutes(app: FastifyInstance) {
  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/tools',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      const valid = await validateToolCreate(req.body);
      if (!valid.ok) {
        return reply
          .code(400)
          .send({ error: valid.error, ...(valid.details ? { details: valid.details } : {}) });
      }

      const created = await createValidatedTool(req.tenant.id, agent.id, valid.data);
      if (!created) {
        return reply
          .code(409)
          .send({ error: 'a tool with this name already exists on this agent' });
      }
      // The plaintext call secret is shown exactly once, like API keys.
      return reply.code(201).send({ tool: toolView(created.tool), secret: created.secret });
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

      const valid = await validateToolPatch(req.body);
      if (!valid.ok) {
        return reply
          .code(400)
          .send({ error: valid.error, ...(valid.details ? { details: valid.details } : {}) });
      }
      // The tool must belong to THIS agent (not just this tenant).
      const existing = await getToolDef(req.tenant.id, req.params.toolId);
      if (!existing || existing.agent_id !== agent.id) {
        return reply.code(404).send({ error: 'unknown tool' });
      }

      const tool = await updateToolDef(req.tenant.id, req.params.toolId, {
        description: valid.data.description,
        parameters: valid.data.parameters as Record<string, unknown> | undefined,
        endpointUrl: valid.data.endpointUrl,
        approval: valid.data.approval,
        status: valid.data.status,
        timeoutMs: valid.data.timeoutMs,
        guard: valid.data.guard,
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
