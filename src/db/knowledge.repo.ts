/**
 * Data layer for Phase 23 knowledge (RAG): per-agent knowledge_sources and
 * their knowledge_chunks. Postgres is the SYSTEM OF RECORD — it owns the chunk
 * TEXT, the statuses, and the vector ids (a chunk row id doubles as its
 * Pinecone vector id). External (Pinecone) deletes are driven FROM these rows
 * via retryable queue jobs, never external filter-deletes (the D2 consistency
 * rule), so delete/reindex return the affected chunk ids for vector cleanup.
 */
import { pool } from './pool';

export interface KnowledgeSource {
  id: string;
  tenant_id: string;
  agent_id: string;
  name: string;
  kind: 'text' | 'url';
  meta: Record<string, unknown>;
  status: 'pending' | 'indexing' | 'ready' | 'error';
  error: string | null;
  chunk_count: number;
  created_at: string;
  updated_at: string;
}

export interface KnowledgeChunk {
  id: string;
  tenant_id: string;
  source_id: string;
  agent_id: string;
  seq: number;
  content: string;
  token_count: number;
  embedding_dim: number | null;
  created_at: string;
}

/* ---------------- sources ---------------- */

/**
 * Create a source in status 'pending'. Returns null when the name is already
 * taken on this agent (unique (agent_id, name)) — the route maps that to 409.
 */
export async function createSource(s: {
  tenantId: string;
  agentId: string;
  name: string;
  kind: 'text' | 'url';
  meta?: Record<string, unknown>;
}): Promise<KnowledgeSource | null> {
  const { rows } = await pool.query(
    `insert into knowledge_sources (tenant_id, agent_id, name, kind, meta, status)
     values ($1,$2,$3,$4,$5,'pending')
     on conflict (agent_id, name) do nothing
     returning *`,
    [s.tenantId, s.agentId, s.name, s.kind, JSON.stringify(s.meta ?? {})],
  );
  return rows[0] ?? null;
}

export async function listSources(
  tenantId: string,
  agentId: string,
): Promise<KnowledgeSource[]> {
  const { rows } = await pool.query(
    `select * from knowledge_sources
      where tenant_id = $1 and agent_id = $2
      order by created_at asc`,
    [tenantId, agentId],
  );
  return rows;
}

export async function getSource(
  tenantId: string,
  sourceId: string,
): Promise<KnowledgeSource | null> {
  const { rows } = await pool.query(
    'select * from knowledge_sources where tenant_id = $1 and id = $2',
    [tenantId, sourceId],
  );
  return rows[0] ?? null;
}

/**
 * Delete a source and (via cascade) its chunks. Returns the deleted chunk ids
 * so the caller can enqueue a vector-cleanup job, or null when the source did
 * not exist. Postgres row deletion is the truth; the external delete is a job.
 */
export async function deleteSource(
  tenantId: string,
  sourceId: string,
): Promise<{ chunkIds: string[] } | null> {
  const existing = await pool.query(
    'select id from knowledge_sources where tenant_id = $1 and id = $2',
    [tenantId, sourceId],
  );
  if (existing.rowCount === 0) return null;
  const chunks = await pool.query<{ id: string }>(
    'select id from knowledge_chunks where source_id = $1',
    [sourceId],
  );
  // Cascade FK drops the chunk rows; delete the parent explicitly.
  await pool.query('delete from knowledge_sources where tenant_id = $1 and id = $2', [
    tenantId,
    sourceId,
  ]);
  return { chunkIds: chunks.rows.map((r) => r.id) };
}

/** Set status (+ optional error text). error is cleared unless provided. */
export async function setStatus(
  sourceId: string,
  status: KnowledgeSource['status'],
  error?: string | null,
): Promise<void> {
  await pool.query(
    `update knowledge_sources set status = $2, error = $3, updated_at = now()
      where id = $1`,
    [sourceId, status, error ?? null],
  );
}

export async function bumpChunkCount(sourceId: string, count: number): Promise<void> {
  await pool.query(
    'update knowledge_sources set chunk_count = $2, updated_at = now() where id = $1',
    [sourceId, count],
  );
}

/* ---------------- chunks ---------------- */

/**
 * Bulk-insert chunks for a source in one round-trip; returns the inserted rows
 * (id + seq) in seq order so the caller can upsert vectors keyed by row id.
 */
export async function bulkInsert(
  chunks: {
    tenantId: string;
    sourceId: string;
    agentId: string;
    seq: number;
    content: string;
    tokenCount: number;
  }[],
): Promise<{ id: string; seq: number }[]> {
  if (chunks.length === 0) return [];
  const values: string[] = [];
  const params: unknown[] = [];
  chunks.forEach((c, i) => {
    const b = i * 6;
    values.push(`($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6})`);
    params.push(c.tenantId, c.sourceId, c.agentId, c.seq, c.content, c.tokenCount);
  });
  const { rows } = await pool.query<{ id: string; seq: number }>(
    `insert into knowledge_chunks
       (tenant_id, source_id, agent_id, seq, content, token_count)
     values ${values.join(',')}
     returning id, seq`,
    params,
  );
  return rows.sort((a, b) => a.seq - b.seq);
}

export async function listIdsBySource(sourceId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    'select id from knowledge_chunks where source_id = $1 order by seq asc',
    [sourceId],
  );
  return rows.map((r) => r.id);
}

/**
 * Fetch chunks by id, preserving the CALLER's id order (retrieval formats
 * excerpts in ranked order, which is not the DB's natural order). Missing ids
 * are skipped.
 */
export async function getByIds(ids: string[]): Promise<KnowledgeChunk[]> {
  if (ids.length === 0) return [];
  const { rows } = await pool.query<KnowledgeChunk>(
    'select * from knowledge_chunks where id = any($1::uuid[])',
    [ids],
  );
  const byId = new Map(rows.map((r) => [r.id, r]));
  return ids.map((id) => byId.get(id)).filter((r): r is KnowledgeChunk => r !== undefined);
}

/** All chunks of a source in seq order (reindex re-embed reads these). */
export async function listChunksBySource(sourceId: string): Promise<KnowledgeChunk[]> {
  const { rows } = await pool.query<KnowledgeChunk>(
    'select * from knowledge_chunks where source_id = $1 order by seq asc',
    [sourceId],
  );
  return rows;
}

/**
 * Delete every chunk of a source; returns the deleted ids so the caller can
 * drop their vectors (reindex rebuild path).
 */
export async function deleteBySource(sourceId: string): Promise<string[]> {
  const { rows } = await pool.query<{ id: string }>(
    'delete from knowledge_chunks where source_id = $1 returning id',
    [sourceId],
  );
  return rows.map((r) => r.id);
}

/** Stamp the embedding dimension on chunks once their vectors are stored. */
export async function setEmbeddingDim(ids: string[], dim: number): Promise<void> {
  if (ids.length === 0) return;
  await pool.query(
    'update knowledge_chunks set embedding_dim = $2 where id = any($1::uuid[])',
    [ids, dim],
  );
}
