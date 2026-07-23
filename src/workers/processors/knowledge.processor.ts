import { UnrecoverableError, type Job } from 'bullmq';
import { fetch as safeFetch } from 'undici';
import { logger } from '../../shared/logger';
import { logExec } from '../../core/execution-log';
import { PermanentError } from '../../shared/errors';
import {
  assertSafeOutboundUrl,
  safeDispatcher,
  UnsafeOutboundUrlError,
} from '../../core/safe-url';
import { getEmbeddingsConfig, embedTexts, type EmbeddingsConfig } from '../../core/embeddings';
import { getVectorStore, type VectorStore } from '../../core/vector-store';
import { summarizeAndEmbedConversation } from '../../core/episodic';
import { chunkText } from '../../core/chunker';
import {
  bulkInsert,
  bumpChunkCount,
  deleteBySource,
  getSource,
  listChunksBySource,
  listIdsBySource,
  setEmbeddingDim,
  setStatus,
} from '../../db/knowledge.repo';

/**
 * Phase 23 Slice B: the knowledge queue processor (QUEUE.KNOWLEDGE). Three job
 * kinds share the queue (concurrency 1 keeps a tenant's ingestion serial):
 *
 *  - 'index'     — chunk + embed + upsert a source's content (this file).
 *  - 'summarize' — episodic memory on conversation resolve (slice C owns the
 *                  body; we just dispatch to summarizeAndEmbedConversation).
 *  - 'cleanup'   — drive the external vector delete from Postgres-owned ids
 *                  (the D2 consistency rule — GDPR deletes never depend on a
 *                  filter-delete; the row deletion already happened).
 */

const EMBED_BATCH_SIZE = 96;
const FETCH_TIMEOUT_MS = 15_000;
/** Cap a fetched document so one huge page can't blow the worker's memory. */
const MAX_FETCH_BYTES = 5 * 1024 * 1024;

export interface KnowledgeJobData {
  kind: 'index' | 'summarize' | 'cleanup';
  tenantId: string;
  /** index/reindex: the source to (re)build. */
  sourceId?: string;
  /**
   * index of a kind='text' source: the raw text, carried inline (never
   * persisted). Absent on a reindex — the processor then re-embeds the
   * source's existing chunks in place.
   */
  text?: string;
  /** cleanup: the vector ids (= deleted chunk row ids) to drop. */
  ids?: string[];
  /** summarize: the resolved conversation to summarize + embed. */
  conversationId?: string;
}

export async function processKnowledge(job: Job<KnowledgeJobData>): Promise<void> {
  const { kind } = job.data;
  if (kind === 'summarize') {
    if (!job.data.conversationId) return;
    await summarizeAndEmbedConversation({
      tenantId: job.data.tenantId,
      conversationId: job.data.conversationId,
    });
    return;
  }
  if (kind === 'cleanup') return processCleanup(job.data);
  return processIndex(job.data);
}

/** Load the tenant's embeddings + vector configs, or a PermanentError. */
async function loadConfigs(
  tenantId: string,
): Promise<{ cfg: EmbeddingsConfig; store: VectorStore }> {
  const [cfg, store] = await Promise.all([
    getEmbeddingsConfig(tenantId),
    getVectorStore(tenantId),
  ]);
  if (!cfg || !store) {
    const missing = [!cfg && 'embeddings', !store && 'vector store'].filter(Boolean).join(' + ');
    throw new PermanentError(`knowledge ${missing} config missing — cannot index`);
  }
  return { cfg, store };
}

/** Embed contents in batches (order preserved) and upsert vectors + stamp dim. */
async function embedAndUpsert(
  cfg: EmbeddingsConfig,
  store: VectorStore,
  agentId: string,
  chunks: { id: string; content: string }[],
): Promise<void> {
  for (let i = 0; i < chunks.length; i += EMBED_BATCH_SIZE) {
    const batch = chunks.slice(i, i + EMBED_BATCH_SIZE);
    const vectors = await embedTexts(cfg, batch.map((c) => c.content));
    await store.upsert(
      batch.map((c, j) => ({ id: c.id, values: vectors[j], meta: { agentId } })),
    );
    await setEmbeddingDim(batch.map((c) => c.id), cfg.dim);
  }
}

async function processIndex(data: KnowledgeJobData): Promise<void> {
  const { tenantId, sourceId } = data;
  if (!sourceId) return;
  const source = await getSource(tenantId, sourceId);
  if (!source) return; // deleted underneath us — nothing to index

  try {
    const { cfg, store } = await loadConfigs(tenantId);
    await setStatus(sourceId, 'indexing');

    // A text source with no inline text is a reindex: re-embed the EXISTING
    // chunks in place (the raw text was never retained). This is the whole
    // point of reindexing a pasted-text source — pick up a new embeddings /
    // dimension config — so re-chunking is neither possible nor needed.
    if (source.kind === 'text' && data.text === undefined) {
      const existing = await listChunksBySource(sourceId);
      if (existing.length === 0) {
        await setStatus(sourceId, 'ready');
        await bumpChunkCount(sourceId, 0);
        return;
      }
      await store.deleteByIds(existing.map((c) => c.id));
      await embedAndUpsert(
        cfg,
        store,
        source.agent_id,
        existing.map((c) => ({ id: c.id, content: c.content })),
      );
      await setStatus(sourceId, 'ready');
      await bumpChunkCount(sourceId, existing.length);
      return;
    }

    // Rebuild path. A retry (or a genuine reindex) may find chunks from a prior
    // run — delete their rows + vectors first so the rebuild is idempotent.
    const staleIds = await listIdsBySource(sourceId);
    if (staleIds.length > 0) {
      await deleteBySource(sourceId);
      await store.deleteByIds(staleIds);
    }

    const content =
      source.kind === 'url'
        ? await fetchUrlText(String((source.meta as { url?: string }).url ?? ''))
        : (data.text ?? '');
    if (!content.trim()) {
      throw new PermanentError('source has no indexable content');
    }

    const pieces = chunkText(content);
    if (pieces.length === 0) {
      throw new PermanentError('source produced no chunks');
    }
    const inserted = await bulkInsert(
      pieces.map((p, seq) => ({
        tenantId,
        sourceId,
        agentId: source.agent_id,
        seq,
        content: p.content,
        tokenCount: p.tokenCount,
      })),
    );
    // inserted is seq-ordered; pieces line up 1:1 by seq.
    await embedAndUpsert(
      cfg,
      store,
      source.agent_id,
      inserted.map((row) => ({ id: row.id, content: pieces[row.seq].content })),
    );

    await setStatus(sourceId, 'ready');
    await bumpChunkCount(sourceId, inserted.length);
    logExec({
      tenantId,
      transactionId: `knowledge-${sourceId}`,
      level: 'info',
      detail: `indexed "${source.name}": ${inserted.length} chunks @ dim ${cfg.dim}`,
    });
  } catch (err) {
    const reason = (err as Error).message;
    if (err instanceof PermanentError) {
      // Config-shaped / content failures can't be fixed by retrying: record
      // the error on the source (the user-facing signal) and stop.
      await setStatus(sourceId, 'error', reason);
      logExec({
        tenantId,
        transactionId: `knowledge-${sourceId}`,
        level: 'error',
        detail: `index permanent failure: ${reason}`,
      });
      throw new UnrecoverableError(reason);
    }
    // Transient (embeddings 5xx, vector store 5xx, network): leave status
    // 'indexing' and let BullMQ retry; onKnowledgeDead marks it 'error' if the
    // retries are ultimately exhausted.
    logExec({
      tenantId,
      transactionId: `knowledge-${sourceId}`,
      level: 'warn',
      detail: `index attempt failed, will retry: ${reason}`,
    });
    throw err;
  }
}

/**
 * The vector-cleanup hop: drop vectors whose Postgres rows are already gone.
 * Throws on failure so BullMQ retries — the rows are the truth, so an orphaned
 * vector is a temporary inconsistency the retry resolves. If the tenant's
 * vector store is gone entirely, there is nothing left to delete against.
 */
async function processCleanup(data: KnowledgeJobData): Promise<void> {
  const ids = data.ids ?? [];
  if (ids.length === 0) return;
  const store = await getVectorStore(data.tenantId);
  if (!store) {
    logger.warn(
      { tenantId: data.tenantId, count: ids.length },
      'knowledge cleanup skipped: no vector store configured',
    );
    return;
  }
  await store.deleteByIds(ids);
  logExec({
    tenantId: data.tenantId,
    transactionId: 'knowledge-cleanup',
    level: 'info',
    detail: `vector cleanup: dropped ${ids.length} vectors`,
  });
}

/**
 * SSRF-gated GET of a URL source, reduced to plain text. BOTH SSRF layers: the
 * assert catches literal private IPs (which bypass the custom DNS lookup), the
 * dispatcher re-checks every resolved address at connect time (DNS rebinding).
 *
 * HTML→TEXT BOUNDARY: a small tag-strip (drop script/style, remove tags,
 * decode a handful of common entities, collapse whitespace) — NOT a real HTML
 * parser. Good enough for policy/FAQ pages; a proper parser (and PDF) is a
 * documented bucket item (D4).
 */
async function fetchUrlText(rawUrl: string): Promise<string> {
  if (!rawUrl) throw new PermanentError('url source has no url');
  try {
    await assertSafeOutboundUrl(rawUrl, { resolve: false });
  } catch (err) {
    if (err instanceof UnsafeOutboundUrlError) {
      throw new PermanentError(`url blocked: ${err.message}`);
    }
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  let res: Awaited<ReturnType<typeof safeFetch>>;
  try {
    res = await safeFetch(rawUrl, {
      method: 'GET',
      headers: { accept: 'text/html,text/plain,*/*', 'user-agent': 'asyncify-knowledge/1.0' },
      signal: controller.signal,
      dispatcher: safeDispatcher(),
      redirect: 'manual', // a vetted public host must not bounce us to a private one
    });
  } catch (err) {
    for (let e: unknown = err; e instanceof Error; e = e.cause) {
      if (e instanceof UnsafeOutboundUrlError) throw new PermanentError(`url blocked: ${e.message}`);
    }
    throw err; // network hiccup — transient, let it retry
  } finally {
    clearTimeout(timer);
  }

  // 4xx is permanent (bad URL); 3xx (manual) and 5xx are worth a retry.
  if (res.status >= 400 && res.status < 500) {
    throw new PermanentError(`fetch returned ${res.status}`);
  }
  if (!res.ok) throw new Error(`fetch returned ${res.status}`);

  const buf = Buffer.from(await res.arrayBuffer()).subarray(0, MAX_FETCH_BYTES);
  const contentType = res.headers.get('content-type') ?? '';
  const raw = buf.toString('utf8');
  return contentType.includes('text/html') || /<[a-z!/]/i.test(raw) ? htmlToText(raw) : raw.trim();
}

/** Minimal, dependency-free HTML→text (see fetchUrlText's boundary note). */
export function htmlToText(html: string): string {
  return html
    .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    // Turn block-level closings into paragraph breaks so chunking keeps structure.
    .replace(/<\/(p|div|section|article|h[1-6]|li|tr|table|ul|ol|br)\s*\/?>/gi, '\n\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .split('\n')
    .map((l) => l.trim())
    .join('\n')
    .trim();
}

/**
 * DLQ hook: retries exhausted on an index job — flip the source to 'error' so
 * the user sees a failed state instead of a permanent 'indexing' spinner.
 * (cleanup/summarize dead jobs leave no user-facing row to update.)
 */
export async function onKnowledgeDead(job: Job): Promise<void> {
  const data = job.data as Partial<KnowledgeJobData>;
  if (data.kind !== 'index' || !data.tenantId || !data.sourceId) return;
  const source = await getSource(data.tenantId, data.sourceId).catch(() => null);
  if (source && source.status !== 'ready') {
    await setStatus(data.sourceId, 'error', 'indexing failed after repeated retries').catch((err) =>
      logger.warn({ err }, 'failed to mark knowledge source errored on dead job'),
    );
  }
}
