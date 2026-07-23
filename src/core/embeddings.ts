/**
 * Phase 23: per-tenant embeddings client — one pluggable interface, the
 * "OpenAI-shaped /embeddings endpoint" (covers OpenAI, Zhipu/bigmodel,
 * local Ollama, and most compat providers). Config lives as an
 * integrations row (channel 'embeddings', provider 'openai-compat'),
 * credentials sealed.
 *
 * The integrations table has no non-secret config column (channel/provider/
 * credentials/flags only), so the probed dimension is sealed alongside the
 * credentials and surfaced through getEmbeddingsConfig — a row without a
 * recorded dim has not passed its Test yet and is treated as "not configured".
 *
 * SSRF: baseUrl is gated with assertSafeOutboundUrl at CONFIG time (in the
 * integrations route, mirroring the agent llm.baseUrl policy — localhost is
 * reached only via OUTBOUND_URL_ALLOW, so local Ollama works with no code
 * branch), and safeDispatcher() is the connect-time boundary on every dial.
 *
 * FROZEN CONTRACT (slices B/C import these signatures; slice A implements).
 */
import { fetch as undiciFetch } from 'undici';
import type { Channel } from '../shared/queues';
import { integrationsForChannel } from '../db/integrations.repo';
import { openSecret } from '../auth/secret-box';
import { safeDispatcher, UnsafeOutboundUrlError } from './safe-url';
import { PermanentError, TransientError } from '../shared/errors';

export interface EmbeddingsConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Recorded by the probe at config time; every embed must match it. */
  dim: number;
}

/** OpenAI-shaped endpoints cap batch size; loop for anything larger. */
const MAX_BATCH = 64;

/** The sealed credential blob for a channel-'embeddings' integration row. */
interface SealedEmbeddings {
  baseUrl: string;
  apiKey: string;
  model: string;
  /** Present only after a successful Test/probe recorded it. */
  dim?: number;
}

/**
 * The tenant's ACTIVE embeddings config, or null when not configured / not yet
 * probed. Lookup-first, like every channel needs its provider.
 *
 * Loaded per call: this rides retrieval tool invocations and ingestion jobs
 * (0-1 per turn, off the hot path — D10), so a single indexed SELECT is
 * cheaper than a cross-process cache with its staleness/invalidation cost.
 */
export async function getEmbeddingsConfig(tenantId: string): Promise<EmbeddingsConfig | null> {
  const rows = await integrationsForChannel(tenantId, 'embeddings' as Channel);
  if (rows.length === 0) return null; // primary-first ordering → [0] is the active one
  const creds = JSON.parse(openSecret(rows[0].credentials)) as SealedEmbeddings;
  if (typeof creds.dim !== 'number') return null; // created but never Tested → dim unknown
  return { baseUrl: creds.baseUrl, apiKey: creds.apiKey, model: creds.model, dim: creds.dim };
}

/** Embed a batch of texts; returns one vector per input, order preserved. */
export async function embedTexts(cfg: EmbeddingsConfig, texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const out: number[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH) {
    const batch = texts.slice(i, i + MAX_BATCH);
    const vectors = await embedBatch(cfg, batch);
    out.push(...vectors);
  }
  return out;
}

/** Config-time probe: one test embed; returns the endpoint's dimension. */
export async function probeEmbeddings(
  cfg: Omit<EmbeddingsConfig, 'dim'>,
): Promise<{ dim: number }> {
  const [vector] = await embedBatch(cfg, ['ping']);
  if (!vector || vector.length === 0) {
    throw new PermanentError('embeddings endpoint returned no vector for the probe');
  }
  return { dim: vector.length };
}

interface EmbeddingsResponse {
  data?: { embedding?: number[]; index?: number }[];
}

/** One request to POST {baseUrl}/embeddings, OpenAI request/response shape. */
async function embedBatch(
  cfg: Omit<EmbeddingsConfig, 'dim'>,
  input: string[],
): Promise<number[][]> {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/embeddings`;
  let res: Awaited<ReturnType<typeof undiciFetch>>;
  try {
    res = await undiciFetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify({ model: cfg.model, input }),
      dispatcher: safeDispatcher(),
      // Our servers dial this; a redirect could bounce us to a private host.
      redirect: 'manual',
    });
  } catch (err) {
    // undici wraps connect-time SSRF blocks in the cause chain → not retryable.
    for (let e: unknown = err; e instanceof Error; e = e.cause) {
      if (e instanceof UnsafeOutboundUrlError) {
        throw new PermanentError(`embeddings endpoint blocked: ${e.message}`, err);
      }
    }
    throw new TransientError(`embeddings request failed: ${(err as Error).message}`, err);
  }

  if (!res.ok) {
    const detail = (await res.text().catch(() => '')).slice(0, 300);
    const msg = `embeddings endpoint returned ${res.status}${detail ? `: ${detail}` : ''}`;
    // 429/5xx → retry; every other status (401/403/404/400…) is a config fault.
    throw res.status === 429 || res.status >= 500
      ? new TransientError(msg)
      : new PermanentError(msg);
  }

  let json: EmbeddingsResponse;
  try {
    json = (await res.json()) as EmbeddingsResponse;
  } catch (err) {
    throw new PermanentError(`embeddings response was not JSON: ${(err as Error).message}`, err);
  }
  const data = json.data;
  if (!Array.isArray(data) || data.length !== input.length) {
    throw new PermanentError(
      `embeddings response had ${Array.isArray(data) ? data.length : 'no'} vectors for ${input.length} inputs`,
    );
  }

  // Place each vector at its declared index so ordering is guaranteed even if
  // the endpoint returns them out of order; fall back to array position.
  const vectors: number[][] = new Array(input.length);
  data.forEach((item, position) => {
    const idx = typeof item.index === 'number' ? item.index : position;
    if (!Array.isArray(item.embedding)) {
      throw new PermanentError('embeddings response entry had no embedding array');
    }
    vectors[idx] = item.embedding;
  });
  if (vectors.some((v) => !Array.isArray(v))) {
    throw new PermanentError('embeddings response had a gap in vector indices');
  }
  return vectors;
}
