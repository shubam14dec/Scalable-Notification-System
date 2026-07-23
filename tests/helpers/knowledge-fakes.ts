/**
 * Phase 23 slice E — in-process fakes for the two BYO knowledge backends, shared
 * by tests/integration/knowledge.test.ts and retrieval-episodic.test.ts. Not a
 * *.test.ts, so vitest never collects it as a suite.
 *
 *  - Embeddings stub: an OpenAI-shaped POST /embeddings server. Vectors are a
 *    DETERMINISTIC bag-of-words hash so cosine similarity tracks word overlap —
 *    "return policy" ranks a chunk that says "return"/"policy" above one about
 *    shipping. Its dimension is mutable so a test can flip the probed dim and
 *    exercise the mixed-dim guard.
 *  - Pinecone stub: one server that answers BOTH the control plane (describe /
 *    create index) and the data plane (upsert / delete / query) — it binds the
 *    FIXED loopback port pinned in tests/setup.ts as PINECONE_CONTROL_URL (the
 *    control URL is a module-load const in vector-store.ts), and reports THAT
 *    same host from describeIndex so data-plane calls loop back to it too.
 *    query() ranks stored vectors by real cosine within the tenant namespace,
 *    honoring the metadata `$eq` filter the store sends.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/** Deterministic bag-of-words embedding: each token hashed into one of `dim` buckets. */
export function bagOfWords(text: string, dim: number): number[] {
  const v = new Array(dim).fill(0);
  const toks = text.toLowerCase().match(/[a-z0-9]+/g) ?? [];
  for (const t of toks) {
    let h = 0;
    for (let i = 0; i < t.length; i += 1) h = (h * 31 + t.charCodeAt(i)) >>> 0;
    v[h % dim] += 1;
  }
  return v;
}

function cosine(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  for (let i = 0; i < n; i += 1) dot += a[i] * b[i];
  let na = 0;
  for (const x of a) na += x * x;
  let nb = 0;
  for (const x of b) nb += x * x;
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

function readBody(req: import('node:http').IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => resolve(raw));
  });
}

// ── Embeddings stub ─────────────────────────────────────────────────────────

export interface EmbeddingsStub {
  server: Server;
  /** e.g. http://127.0.0.1:PORT/v1 — POST {baseUrl}/embeddings is what the client dials. */
  baseUrl: string;
  /** Current probed dimension; flip with setDim before re-Testing the integration. */
  dim: number;
  setDim(d: number): void;
  /** Every batch of inputs the client sent (order preserved). */
  batches: string[][];
  close(): void;
}

export function startEmbeddingsStub(initialDim = 8): Promise<EmbeddingsStub> {
  const state = { dim: initialDim };
  const batches: string[][] = [];
  const server = createServer(async (req, res) => {
    const raw = await readBody(req);
    let input: string[] = [];
    try {
      input = (JSON.parse(raw) as { input?: string[] }).input ?? [];
    } catch {
      /* leave empty */
    }
    batches.push(input);
    const data = input.map((text, index) => ({ index, embedding: bagOfWords(text, state.dim) }));
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ data }));
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const port = (server.address() as AddressInfo).port;
      resolve({
        server,
        baseUrl: `http://127.0.0.1:${port}/v1`,
        get dim() {
          return state.dim;
        },
        setDim(d: number) {
          state.dim = d;
        },
        batches,
        close: () => server.close(),
      });
    });
  });
}

// ── Pinecone stub (control + data plane on the fixed control port) ───────────

interface StoredVector {
  values: number[];
  meta: Record<string, string>;
}

export interface PineconeStub {
  server: Server;
  /** Bare host (127.0.0.1:PORT) the fake control plane reports — sealed by /test. */
  host: string;
  /** namespace -> id -> vector. */
  namespaces: Map<string, Map<string, StoredVector>>;
  upserts: Array<{ namespace: string; ids: string[] }>;
  deletes: Array<{ namespace: string; ids: string[] }>;
  /** Clear recorded upsert/delete history (state survives) between assertions. */
  resetHistory(): void;
  close(): void;
}

/**
 * Bind the combined Pinecone fake to the fixed port encoded in
 * PINECONE_CONTROL_URL (set in tests/setup.ts). `indexName` is auto-created on
 * first describe-then-create; `createdDim` records the dimension it was made at.
 */
export function startPineconeStub(): Promise<PineconeStub> {
  const control = new URL(process.env.PINECONE_CONTROL_URL ?? 'http://127.0.0.1:51733');
  const port = Number(control.port);
  const bareHost = `${control.hostname}:${port}`;

  const indexes = new Map<string, { dimension: number }>();
  const namespaces = new Map<string, Map<string, StoredVector>>();
  const upserts: Array<{ namespace: string; ids: string[] }> = [];
  const deletes: Array<{ namespace: string; ids: string[] }> = [];

  const ns = (name: string) => {
    let m = namespaces.get(name);
    if (!m) {
      m = new Map();
      namespaces.set(name, m);
    }
    return m;
  };

  const server = createServer(async (req, res) => {
    const url = req.url ?? '';
    const method = req.method ?? 'GET';
    res.setHeader('content-type', 'application/json');

    // Control plane: describe index.
    if (method === 'GET' && url.startsWith('/indexes/')) {
      const name = decodeURIComponent(url.slice('/indexes/'.length));
      const idx = indexes.get(name);
      if (!idx) {
        res.statusCode = 404;
        res.end(JSON.stringify({ error: 'index not found' }));
        return;
      }
      res.end(
        JSON.stringify({
          name,
          host: bareHost,
          dimension: idx.dimension,
          metric: 'cosine',
          status: { ready: true },
        }),
      );
      return;
    }

    const raw = await readBody(req);
    const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};

    // Control plane: create index.
    if (method === 'POST' && url === '/indexes') {
      const name = String(body.name);
      indexes.set(name, { dimension: Number(body.dimension) });
      res.statusCode = 201;
      res.end(JSON.stringify({ name, host: bareHost, status: { ready: true } }));
      return;
    }

    // Data plane: upsert.
    if (method === 'POST' && url === '/vectors/upsert') {
      const namespace = String(body.namespace ?? '');
      const vectors = (body.vectors as Array<{ id: string; values: number[]; metadata?: Record<string, string> }>) ?? [];
      const store = ns(namespace);
      for (const v of vectors) store.set(v.id, { values: v.values, meta: v.metadata ?? {} });
      upserts.push({ namespace, ids: vectors.map((v) => v.id) });
      res.end(JSON.stringify({ upsertedCount: vectors.length }));
      return;
    }

    // Data plane: delete by ids.
    if (method === 'POST' && url === '/vectors/delete') {
      const namespace = String(body.namespace ?? '');
      const ids = (body.ids as string[]) ?? [];
      const store = ns(namespace);
      for (const id of ids) store.delete(id);
      deletes.push({ namespace, ids });
      res.end(JSON.stringify({}));
      return;
    }

    // Data plane: query (cosine over the namespace, honoring the $eq filter).
    if (method === 'POST' && url === '/query') {
      const namespace = String(body.namespace ?? '');
      const vector = (body.vector as number[]) ?? [];
      const topK = Number(body.topK ?? 4);
      const filterRaw = (body.filter as Record<string, { $eq?: string }>) ?? {};
      const filter = Object.fromEntries(
        Object.entries(filterRaw).map(([k, v]) => [k, v.$eq]),
      ) as Record<string, string>;
      const store = ns(namespace);
      const matches = [...store.entries()]
        .filter(([, sv]) => Object.entries(filter).every(([k, val]) => sv.meta[k] === val))
        .map(([id, sv]) => ({ id, score: cosine(vector, sv.values) }))
        .sort((a, b) => b.score - a.score)
        .slice(0, topK);
      res.end(JSON.stringify({ matches }));
      return;
    }

    res.statusCode = 404;
    res.end(JSON.stringify({ error: `unhandled ${method} ${url}` }));
  });

  return new Promise((resolve) => {
    server.listen(port, control.hostname, () =>
      resolve({
        server,
        host: bareHost,
        namespaces,
        upserts,
        deletes,
        resetHistory() {
          upserts.length = 0;
          deletes.length = 0;
        },
        close: () => server.close(),
      }),
    );
  });
}
