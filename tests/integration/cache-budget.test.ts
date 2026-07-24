/**
 * Phase 24 slice E — prompt caching (D9) + budget intelligence (D10).
 *
 * Caching: with a non-empty volatile block (a customer profile), the brain sends
 * system as TWO cache_control blocks — the marker on the STABLE block [0] only.
 * When the stub reports cache_read_input_tokens / cache_creation_input_tokens,
 * they flow to TurnUsage.cacheReadTokens/Write, the persisted raw.usage, and the
 * model_call trace event's OPTIONAL cacheRead/cacheWrite fields. With no cache
 * fields (the z.ai case) those stay 0 and the trace fields are absent; with no
 * volatile block the system is a SINGLE block.
 *
 * Budget: agent-health.repo's fixed 30-day daily-token stats. Eight distinct
 * days of reply-row usage summing to [10k..80k] give p95DailyTokens 76500 and
 * suggestedDailyTokens 250000 (p95 × 3, rounded UP to the nearest 50k); fewer
 * than 7 distinct days yields a null suggestion (no budget from noise); system
 * rows are excluded (reply rows only).
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';

// ---- stub Anthropic-compatible server ----
let llmStub: Server;
let llmBaseUrl = '';
interface SeenRequest {
  system?: unknown;
  messages: Array<{ role: string; content: unknown }>;
}
const seen: SeenRequest[] = [];
let stubQueue: unknown[] = [];

interface StubUsage {
  input_tokens: number;
  output_tokens: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
}
const envelope = (
  content: unknown[],
  stopReason: string,
  usage: StubUsage = { input_tokens: 10, output_tokens: 5 },
) => ({
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: 'glm-4-test',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage,
});
const textResponse = (text: string, usage?: StubUsage) =>
  envelope([{ type: 'text', text }], 'end_turn', usage);

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      seen.push(JSON.parse(raw) as SeenRequest);
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(stubQueue.length > 0 ? stubQueue.shift() : textResponse('ok')));
    });
  });
  return new Promise((r) => llmStub.listen(0, '127.0.0.1', () => r()));
}

const json = (res: { body: string }) => JSON.parse(res.body);

async function createManagedAgent(identifier: string, systemPrompt = 'You are the Acme support agent.') {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier,
      name: identifier,
      runtime: 'managed',
      model: 'glm-4-test',
      systemPrompt,
      llm: { apiKey: 'cb-test-key-123456', baseUrl: llmBaseUrl },
    },
  });
  expect(res.statusCode, `create agent ${identifier}`).toBe(201);
  const { rows } = await pool.query<{ id: string }>(
    'select id from agents where tenant_id = $1 and identifier = $2',
    [tenantId, identifier],
  );
  return rows[0].id;
}

async function runTurn(identifier: string, subscriberId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  const turn = json(res) as { conversationId: string; messageId: string };
  await processConversation({
    data: { tenantId, conversationId: turn.conversationId, messageId: turn.messageId },
  } as Job<ConversationJobData>);
  return turn;
}

async function latestAgentRaw(conversationId: string) {
  const { rows } = await pool.query<{ raw: Record<string, unknown> }>(
    `select raw from conversation_messages where conversation_id = $1 and role = 'agent'
      order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0].raw;
}

async function replyUsage(conversationId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/conversations/${conversationId}`,
    headers: { 'x-api-key': apiKey },
  });
  const t = json(res);
  return t.messages.filter((m: { role: string }) => m.role === 'agent').at(-1).usage;
}

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `cb-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'CB IT', email, password: 'integration-pw-1', organizationName: 'CB IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;
});

afterAll(async () => {
  try {
    await pool.query('delete from subscriber_memories where tenant_id = $1', [tenantId]);
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
  } catch {
    /* best-effort */
  }
  llmStub?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('prompt caching (D9)', () => {
  const AGENT = 'cache-agent';
  let agentId = '';

  test('WITH a profile + cache usage: two blocks (marker on [0] only), fields flow through', async () => {
    agentId = await createManagedAgent(AGENT);

    // Turn 1 creates the subscriber; then seed a memory so turn 2 has a VOLATILE block.
    await runTurn(AGENT, 'cache-cust', 'hi', 'cache-1');
    const { rows: sub } = await pool.query<{ id: string }>(
      "select id from subscribers where tenant_id = $1 and external_id = 'cache-cust'",
      [tenantId],
    );
    await pool.query(
      `insert into subscriber_memories (tenant_id, agent_id, subscriber_id, key, value, source)
       values ($1, $2, $3, 'plan', 'Pro', 'operator')`,
      [tenantId, agentId, sub[0].id],
    );

    stubQueue = [
      textResponse('Here to help.', {
        input_tokens: 10,
        output_tokens: 5,
        cache_read_input_tokens: 100,
        cache_creation_input_tokens: 40,
      }),
    ];
    const turn = await runTurn(AGENT, 'cache-cust', 'what plan am I on?', 'cache-2');

    // The wire system is TWO blocks; the cache marker is on the STABLE block only.
    const system = seen.at(-1)!.system as Array<{ text: string; cache_control?: unknown }>;
    expect(Array.isArray(system)).toBe(true);
    expect(system).toHaveLength(2);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1].cache_control).toBeUndefined();
    expect(system[1].text).toContain('<customer_profile>'); // the volatile half

    // TurnUsage (from the API view) carries the cache counters.
    const usage = await replyUsage(turn.conversationId);
    expect(usage).toMatchObject({ cacheReadTokens: 100, cacheWriteTokens: 40 });

    // Persisted raw.usage carries them too.
    const raw = await latestAgentRaw(turn.conversationId);
    expect((raw.usage as Record<string, number>).cacheReadTokens).toBe(100);
    expect((raw.usage as Record<string, number>).cacheWriteTokens).toBe(40);

    // The model_call trace event carries the OPTIONAL cacheRead/cacheWrite fields.
    const events = (raw.trace as { events: Array<Record<string, unknown>> }).events;
    const modelCall = events.find((e) => e.t === 'model_call')!;
    expect(modelCall.cacheRead).toBe(100);
    expect(modelCall.cacheWrite).toBe(40);
  });

  test('WITHOUT cache usage + no profile: single block, zeros, trace fields absent', async () => {
    // A fresh subscriber has no memories -> no volatile block -> single system block.
    stubQueue = [textResponse('Hello there.')]; // default usage: no cache_* fields
    const turn = await runTurn(AGENT, 'nocache-cust', 'hi', 'nocache-1');

    const system = seen.at(-1)!.system as Array<{ text: string; cache_control?: unknown }>;
    expect(system).toHaveLength(1);
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });

    const usage = await replyUsage(turn.conversationId);
    expect(usage).toMatchObject({ cacheReadTokens: 0, cacheWriteTokens: 0 });

    const raw = await latestAgentRaw(turn.conversationId);
    const events = (raw.trace as { events: Array<Record<string, unknown>> }).events;
    const modelCall = events.find((e) => e.t === 'model_call')!;
    // Optional fields are set ONLY when > 0 (frozen-union rule) — absent here.
    expect('cacheRead' in modelCall).toBe(false);
    expect('cacheWrite' in modelCall).toBe(false);
  });
});

describe('budget suggestion (D10)', () => {
  let budgetSeq = 0;

  /** Seed one reply/system row with a given per-row token spend on a UTC day. */
  async function seedUsageRow(
    conversationId: string,
    role: 'agent' | 'system',
    tokens: number,
    ageDays: number,
  ) {
    budgetSeq += 1;
    await pool.query(
      `insert into conversation_messages
         (conversation_id, tenant_id, role, content, dedupe_key, raw, created_at)
       values ($1, $2, $3, 'r', $4, $5::jsonb, now() - make_interval(days => $6))`,
      [
        conversationId,
        tenantId,
        role,
        `budget-${budgetSeq}`,
        JSON.stringify({ usage: { inputTokens: tokens, outputTokens: 0 } }),
        ageDays,
      ],
    );
  }

  async function seedAgentWithConversation(identifier: string) {
    const agentId = await createManagedAgent(identifier);
    const { rows: sub } = await pool.query<{ id: string }>(
      `insert into subscribers (tenant_id, external_id) values ($1, $2) returning id`,
      [tenantId, `${identifier}-sub`],
    );
    const { rows: conv } = await pool.query<{ id: string }>(
      `insert into conversations (tenant_id, agent_id, subscriber_id, thread_key, channel)
       values ($1, $2, $3, $4, 'inapp') returning id`,
      [tenantId, agentId, sub[0].id, `${identifier}-thread`],
    );
    return conv[0].id;
  }

  async function health(identifier: string) {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/agents/${identifier}/health`,
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    return json(res);
  }

  test('8 distinct days of [10k..80k] -> p95DailyTokens 76500, suggestedDailyTokens 250000', async () => {
    const conversationId = await seedAgentWithConversation('budget-8d');
    // One reply per day: day d (0..7) sums to (d+1)*10_000.
    for (let d = 0; d < 8; d += 1) {
      await seedUsageRow(conversationId, 'agent', (d + 1) * 10_000, d);
    }
    // A system-note row with a huge spend on day 0 must be EXCLUDED (reply rows only).
    await seedUsageRow(conversationId, 'system', 5_000_000, 0);

    const h = await health('budget-8d');
    // percentile_cont(0.95) over [10k,20k,…,80k] = 70k + 0.65×10k = 76_500.
    expect(h.p95DailyTokens).toBe(76_500);
    // 76_500 × 3 = 229_500 -> ceil to nearest 50k = 250_000.
    expect(h.suggestedDailyTokens).toBe(250_000);
  });

  test('6 distinct days -> suggestedDailyTokens null (no budget from noise), p95 still reported', async () => {
    const conversationId = await seedAgentWithConversation('budget-6d');
    for (let d = 0; d < 6; d += 1) {
      await seedUsageRow(conversationId, 'agent', (d + 1) * 10_000, d);
    }
    const h = await health('budget-6d');
    expect(h.suggestedDailyTokens).toBeNull();
    expect(h.p95DailyTokens).not.toBeNull();
  });

  test('an agent with no usage -> both budget fields null', async () => {
    await seedAgentWithConversation('budget-0d');
    const h = await health('budget-0d');
    expect(h.p95DailyTokens).toBeNull();
    expect(h.suggestedDailyTokens).toBeNull();
  });
});
