import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { getAgent } from '../../db/conversations.repo';
import { getQueue, QUEUE } from '../../shared/queues';
import { getEmbeddingsConfig } from '../../core/embeddings';
import { getVectorStore } from '../../core/vector-store';
import { assertSafeOutboundUrl, UnsafeOutboundUrlError } from '../../core/safe-url';
import {
  createSource,
  deleteSource,
  getSource,
  listSources,
  setStatus,
  type KnowledgeSource,
} from '../../db/knowledge.repo';
import type { KnowledgeJobData } from '../../workers/processors/knowledge.processor';
import { logExec } from '../../core/execution-log';

/**
 * Phase 23 Slice B: per-agent knowledge sources — CRUD + re-index under
 * /v1/agents/:identifier/knowledge.
 *
 * KIND-TEXT CONTENT TRANSPORT (D3/D4 decision): a text source's raw text is
 * NOT persisted (meta stays {}) — the chunks are the only retained copy. The
 * full text rides inline in the 'index' job payload on the initial POST. A
 * reindex has no text to carry (the reindex endpoint takes no body), so the
 * processor re-embeds a text source's EXISTING chunks in place instead of
 * re-chunking (see knowledge.processor.ts). URL sources always re-fetch.
 */

/** 1 MB text cap (D4). Chars, not bytes — the estimate is close enough here. */
const MAX_TEXT_CHARS = 1024 * 1024;

const CreateSourceSchema = z
  .object({
    name: z.string().min(1).max(255),
    kind: z.enum(['text', 'url']),
    text: z.string().min(1).max(MAX_TEXT_CHARS).optional(),
    url: z.string().url().max(2048).optional(),
  })
  .refine((s) => s.kind !== 'text' || (s.text && s.text.trim().length > 0), {
    message: 'kind "text" requires non-empty text',
    path: ['text'],
  })
  .refine((s) => s.kind !== 'url' || Boolean(s.url), {
    message: 'kind "url" requires url',
    path: ['url'],
  });

function sourceView(s: KnowledgeSource) {
  return {
    id: s.id,
    name: s.name,
    kind: s.kind,
    status: s.status,
    error: s.error,
    chunkCount: s.chunk_count,
    createdAt: s.created_at,
    updatedAt: s.updated_at,
  };
}

/**
 * The feature politely REQUIRES both a per-tenant embeddings config and a
 * vector store (lookup-first, like every channel needs its provider). Returns
 * a tenant-facing message naming which is missing, or null when both exist.
 */
async function missingConfigError(tenantId: string): Promise<string | null> {
  const [embeddings, store] = await Promise.all([
    getEmbeddingsConfig(tenantId),
    getVectorStore(tenantId),
  ]);
  const missing: string[] = [];
  if (!embeddings) missing.push('an embeddings integration');
  if (!store) missing.push('a vector store integration');
  if (missing.length === 0) return null;
  return `knowledge requires ${missing.join(' and ')} — add ${
    missing.length > 1 ? 'them' : 'it'
  } on the Integrations page first`;
}

async function enqueueIndex(data: KnowledgeJobData, jobId: string): Promise<void> {
  await getQueue(QUEUE.KNOWLEDGE).add('knowledge', data, { jobId });
}

export function registerKnowledgeRoutes(app: FastifyInstance) {
  app.get<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/knowledge',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const sources = await listSources(req.tenant.id, agent.id);
      return { sources: sources.map(sourceView) };
    },
  );

  app.post<{ Params: { identifier: string } }>(
    '/v1/agents/:identifier/knowledge',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = CreateSourceSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });

      // Lookup-first: the feature needs both credentials before we accept a
      // source we could never index.
      const configError = await missingConfigError(req.tenant.id);
      if (configError) return reply.code(400).send({ error: configError });

      // SSRF gate at save time for URL sources (write-time half; the worker's
      // fetch adds the connect-time dispatcher half).
      const { name, kind, text, url } = parsed.data;
      if (kind === 'url') {
        try {
          await assertSafeOutboundUrl(url!, { resolve: false });
        } catch (err) {
          if (err instanceof UnsafeOutboundUrlError) {
            return reply.code(400).send({ error: `url rejected: ${err.message}` });
          }
          throw err;
        }
      }

      const source = await createSource({
        tenantId: req.tenant.id,
        agentId: agent.id,
        name,
        kind,
        meta: kind === 'url' ? { url } : {},
      });
      if (!source) {
        return reply.code(409).send({ error: `a source named "${name}" already exists` });
      }

      // kind text: carry the raw text inline in the job (not persisted).
      await enqueueIndex(
        { kind: 'index', tenantId: req.tenant.id, sourceId: source.id, ...(kind === 'text' ? { text } : {}) },
        `knowledge-index-${source.id}`,
      );

      logExec({
        tenantId: req.tenant.id,
        transactionId: `knowledge-${source.id}`,
        level: 'info',
        detail: `knowledge source created: agent=${agent.identifier} name=${name} kind=${kind}`,
      });

      return reply.code(201).send({ source: sourceView(source) });
    },
  );

  app.post<{ Params: { identifier: string; sourceId: string } }>(
    '/v1/agents/:identifier/knowledge/:sourceId/reindex',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const source = await getSource(req.tenant.id, req.params.sourceId);
      if (!source || source.agent_id !== agent.id) {
        return reply.code(404).send({ error: 'unknown source' });
      }

      // Deleting old chunks + vectors happens INSIDE the job, not here (the
      // consistency rule). Back to pending for immediate UI feedback.
      await setStatus(source.id, 'pending');
      // Nonce in the jobId: a source-scoped id would be swallowed as a dupe of
      // the still-retained completed index job (the jobId-dedupe gotcha) — a
      // reindex is an intentional replay, so it must carry a fresh id.
      await enqueueIndex(
        { kind: 'index', tenantId: req.tenant.id, sourceId: source.id },
        `knowledge-index-${source.id}-${Date.now()}`,
      );

      return reply.code(202).send({ status: 'pending' });
    },
  );

  app.delete<{ Params: { identifier: string; sourceId: string } }>(
    '/v1/agents/:identifier/knowledge/:sourceId',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const agent = await getAgent(req.tenant.id, req.params.identifier);
      if (!agent) return reply.code(404).send({ error: 'unknown agent' });
      const source = await getSource(req.tenant.id, req.params.sourceId);
      if (!source || source.agent_id !== agent.id) {
        return { deleted: false };
      }

      // Postgres row deletion is the truth; the external vector delete is a
      // retryable job driven from the ids we just removed.
      const result = await deleteSource(req.tenant.id, source.id);
      if (result && result.chunkIds.length > 0) {
        await getQueue(QUEUE.KNOWLEDGE).add(
          'knowledge',
          { kind: 'cleanup', tenantId: req.tenant.id, ids: result.chunkIds },
          { jobId: `knowledge-cleanup-${source.id}` },
        );
      }

      logExec({
        tenantId: req.tenant.id,
        transactionId: `knowledge-${source.id}`,
        level: 'info',
        detail: `knowledge source deleted: agent=${agent.identifier} name=${source.name} chunks=${result?.chunkIds.length ?? 0}`,
      });

      return { deleted: Boolean(result) };
    },
  );
}
