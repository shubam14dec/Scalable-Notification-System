/**
 * Phase 23: the narrow vector-store seam. v1 backend = Pinecone (BYO, per
 * tenant, sealed key — user decision 2026-07-24); a self-contained backend
 * is a later-bucket item that slots in behind this same interface.
 *
 * CONSISTENCY RULE: Postgres rows own the ids (chunk/summary row id = vector
 * id). Deletes are driven from our rows via retryable jobs — never external
 * filter-deletes.
 *
 * Config lives as an integrations row (channel 'vectorstore', provider
 * 'pinecone'), sealed {apiKey, indexName}. The integrations table has no
 * non-secret config column, so the index HOST that the control plane returns
 * is sealed alongside the credentials at Test time (ensurePineconeIndex) and
 * every data-plane call reads it back — the control plane is never touched on
 * the hot path.
 *
 * Trust model: the only tenant-supplied values are apiKey + indexName. The
 * control-plane host (api.pinecone.io) and the data-plane host both come from
 * Pinecone itself, not from the tenant, so these dials do NOT go through the
 * SSRF dispatcher (which would also, correctly, refuse the localhost fake used
 * in tests). Isolation is by namespace = tenantId on every call.
 *
 * FROZEN CONTRACT (slices B/C import these signatures; slice A implements).
 */
import { fetch as undiciFetch } from 'undici';
import type { Channel } from '../shared/queues';
import { integrationsForChannel } from '../db/integrations.repo';
import { openSecret } from '../auth/secret-box';
import { PermanentError, TransientError } from '../shared/errors';

export interface VectorItem {
  id: string;
  values: number[];
  /** Small metadata only (e.g. { agentId }) — the text stays in Postgres. */
  meta?: Record<string, string>;
}

export interface VectorMatch {
  id: string;
  score: number;
}

export interface VectorStore {
  upsert(items: VectorItem[]): Promise<void>;
  query(opts: {
    vector: number[];
    topK: number;
    /** Restrict matches by metadata equality (e.g. { agentId }). */
    filter?: Record<string, string>;
  }): Promise<VectorMatch[]>;
  deleteByIds(ids: string[]): Promise<void>;
}

// ── Pinecone control plane ────────────────────────────────────────────────
// api.pinecone.io is fixed in prod; the env override is a test / self-host
// seam (the in-process fake control plane binds a localhost port), mirroring
// how OUTBOUND_URL_ALLOW is a documented dev seam for safe-url.
const PINECONE_CONTROL_URL = process.env.PINECONE_CONTROL_URL ?? 'https://api.pinecone.io';
const PINECONE_API_VERSION = '2025-01';
/** Serverless index defaults (cheapest broadly-available region). */
const DEFAULT_CLOUD = 'aws';
const DEFAULT_REGION = 'us-east-1';
/** Batch limits from the Pinecone data-plane docs. */
const UPSERT_BATCH = 100;
const DELETE_BATCH = 1000;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function pineconeHeaders(apiKey: string): Record<string, string> {
  return {
    'Api-Key': apiKey,
    'content-type': 'application/json',
    'X-Pinecone-API-Version': PINECONE_API_VERSION,
  };
}

/** Same taxonomy as the send pipeline: 429/5xx retry, everything else is config. */
function classifyPinecone(status: number, detail: string): Error {
  const msg = `Pinecone returned ${status}${detail ? `: ${detail.slice(0, 300)}` : ''}`;
  return status === 429 || status >= 500 ? new TransientError(msg) : new PermanentError(msg);
}

interface IndexDescription {
  name: string;
  host: string;
  dimension: number;
  metric: string;
  ready: boolean;
}

async function describeIndex(apiKey: string, name: string): Promise<IndexDescription | null> {
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(`${PINECONE_CONTROL_URL}/indexes/${encodeURIComponent(name)}`, {
      method: 'GET',
      headers: pineconeHeaders(apiKey),
    });
  } catch (err) {
    throw new TransientError(`Pinecone describe failed: ${(err as Error).message}`, err);
  }
  if (res.status === 404) return null;
  if (!res.ok) throw classifyPinecone(res.status, await res.text().catch(() => ''));
  const j = (await res.json()) as {
    name?: string;
    host?: string;
    dimension?: number;
    metric?: string;
    status?: { ready?: boolean };
  };
  return {
    name: j.name ?? name,
    host: j.host ?? '',
    dimension: typeof j.dimension === 'number' ? j.dimension : 0,
    metric: j.metric ?? '',
    ready: Boolean(j.status?.ready),
  };
}

async function createIndex(apiKey: string, name: string, dim: number): Promise<void> {
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(`${PINECONE_CONTROL_URL}/indexes`, {
      method: 'POST',
      headers: pineconeHeaders(apiKey),
      body: JSON.stringify({
        name,
        dimension: dim,
        metric: 'cosine',
        spec: { serverless: { cloud: DEFAULT_CLOUD, region: DEFAULT_REGION } },
      }),
    });
  } catch (err) {
    throw new TransientError(`Pinecone create failed: ${(err as Error).message}`, err);
  }
  // 201 Created is the success code; some deployments answer 200/202.
  if (!res.ok && res.status !== 201) {
    throw classifyPinecone(res.status, await res.text().catch(() => ''));
  }
}

async function waitForIndexHost(apiKey: string, name: string): Promise<IndexDescription> {
  for (let i = 0; i < 30; i++) {
    const d = await describeIndex(apiKey, name);
    if (d && d.host && d.ready) return d;
    await sleep(1000);
  }
  throw new TransientError(
    `Pinecone index "${name}" was created but did not become ready in time — click Test again in a moment.`,
  );
}

/**
 * Test-button flow: describe the index; create it (serverless, cosine, the
 * embeddings dimension) if absent, or validate the dimension matches if
 * present. Returns the durable HOST to seal into the row's credentials.
 * Dimension mismatch and (upstream) a missing embeddings config are
 * PermanentError → the route maps them to 400s.
 */
export async function ensurePineconeIndex(
  apiKey: string,
  indexName: string,
  dim: number,
): Promise<{ host: string; dimension: number; created: boolean }> {
  const existing = await describeIndex(apiKey, indexName);
  if (existing) {
    if (existing.dimension !== dim) {
      throw new PermanentError(
        `Pinecone index "${indexName}" has dimension ${existing.dimension}, but this tenant's embeddings config produces ${dim}-dimensional vectors. Point the integration at an index of dimension ${dim}, or re-create it.`,
      );
    }
    if (!existing.host) {
      throw new TransientError(
        `Pinecone index "${indexName}" exists but is not ready yet — click Test again in a moment.`,
      );
    }
    return { host: existing.host, dimension: existing.dimension, created: false };
  }
  await createIndex(apiKey, indexName, dim);
  const ready = await waitForIndexHost(apiKey, indexName);
  return { host: ready.host, dimension: dim, created: true };
}

// ── Pinecone data plane ───────────────────────────────────────────────────

/**
 * Real Pinecone hosts are bare https names with no port; the localhost fake
 * carries a port, which is the tell for an http self-host/test endpoint.
 */
function dataPlaneBase(host: string): string {
  const bare = host.replace(/^https?:\/\//, '');
  const hostname = bare.split(':')[0];
  const local =
    hostname === 'localhost' ||
    hostname === '127.0.0.1' ||
    hostname === '0.0.0.0' ||
    hostname === '::1';
  return `${local ? 'http' : 'https'}://${bare}`;
}

class PineconeStore implements VectorStore {
  private readonly base: string;

  constructor(
    private readonly apiKey: string,
    host: string,
    private readonly namespace: string,
  ) {
    this.base = dataPlaneBase(host);
  }

  async upsert(items: VectorItem[]): Promise<void> {
    for (let i = 0; i < items.length; i += UPSERT_BATCH) {
      const batch = items.slice(i, i + UPSERT_BATCH);
      await this.post('/vectors/upsert', {
        namespace: this.namespace,
        vectors: batch.map((it) => ({
          id: it.id,
          values: it.values,
          ...(it.meta ? { metadata: it.meta } : {}),
        })),
      });
    }
  }

  async query(opts: {
    vector: number[];
    topK: number;
    filter?: Record<string, string>;
  }): Promise<VectorMatch[]> {
    const body: Record<string, unknown> = {
      namespace: this.namespace,
      vector: opts.vector,
      topK: opts.topK,
      includeMetadata: false,
      includeValues: false,
    };
    if (opts.filter && Object.keys(opts.filter).length > 0) {
      body.filter = Object.fromEntries(
        Object.entries(opts.filter).map(([k, v]) => [k, { $eq: v }]),
      );
    }
    const j = (await this.post('/query', body)) as {
      matches?: { id: string; score: number }[];
    };
    return (j.matches ?? []).map((m) => ({ id: m.id, score: m.score }));
  }

  async deleteByIds(ids: string[]): Promise<void> {
    if (ids.length === 0) return;
    for (let i = 0; i < ids.length; i += DELETE_BATCH) {
      await this.post('/vectors/delete', {
        namespace: this.namespace,
        ids: ids.slice(i, i + DELETE_BATCH),
      });
    }
  }

  private async post(path: string, body: unknown): Promise<unknown> {
    let res: Awaited<ReturnType<typeof undiciFetch>>;
    try {
      res = await undiciFetch(`${this.base}${path}`, {
        method: 'POST',
        headers: pineconeHeaders(this.apiKey),
        body: JSON.stringify(body),
      });
    } catch (err) {
      throw new TransientError(`Pinecone request failed: ${(err as Error).message}`, err);
    }
    if (!res.ok) {
      throw classifyPinecone(res.status, await res.text().catch(() => ''));
    }
    return res.json().catch(() => ({}));
  }
}

/** The sealed credential blob for a channel-'vectorstore' integration row. */
interface SealedPinecone {
  apiKey: string;
  indexName: string;
  /** Recorded by the Test button (ensurePineconeIndex); absent = not tested. */
  host?: string;
}

/**
 * The tenant's configured store, or null when not configured / not yet tested.
 * Loaded per call for the same reason as getEmbeddingsConfig — off the hot
 * path, staleness-free.
 */
export async function getVectorStore(tenantId: string): Promise<VectorStore | null> {
  const rows = await integrationsForChannel(tenantId, 'vectorstore' as Channel);
  if (rows.length === 0) return null;
  const creds = JSON.parse(openSecret(rows[0].credentials)) as SealedPinecone;
  if (!creds.host) return null; // created but never Tested → host unknown
  return new PineconeStore(creds.apiKey, creds.host, tenantId);
}
