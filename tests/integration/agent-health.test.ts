/**
 * Agent health aggregate (Phase 21, slice D): the real Fastify app +
 * GET /v1/agents/:identifier/health over a hand-seeded window of turns and
 * tool calls. The fixture is inserted straight into Postgres so the totalMs
 * values are deterministic (p95 is unambiguous) and rows can be backdated to
 * probe the window boundary — nothing here needs the model or the worker.
 *
 * The health route caches per (tenant, agent, days) for 60s, so assertions
 * that must see different windows use DISTINCT `days` values (7 vs 30); the
 * default-days call reuses the days=7 key deliberately (same value, no stale
 * mismatch).
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let agentId = '';
let conversationId = '';
const identifier = 'health-agent';

const json = (res: { body: string }) => JSON.parse(res.body);

/** A traced turn's raw: usage + a trace whose totalMs drives the latency stats. */
const tracedRaw = (totalMs: number) => ({
  usage: { inputTokens: 10, outputTokens: 5, modelCalls: 1 },
  trace: {
    totalMs,
    events: [
      { t: 'model_call', ms: totalMs, inputTokens: 10, outputTokens: 5, stopReason: 'end_turn', model: 'health-model' },
    ],
  },
});
/** An untraced turn's raw: usage only (counts as a turn, drops out of latency). */
const untracedRaw = () => ({ usage: { inputTokens: 10, outputTokens: 5, modelCalls: 1 } });

let dedupeSeq = 0;
async function insertMessage(role: 'agent' | 'system', raw: unknown, ageDays = 0): Promise<void> {
  dedupeSeq += 1;
  await pool.query(
    `insert into conversation_messages
       (conversation_id, tenant_id, role, content, dedupe_key, raw, created_at)
     values ($1, $2, $3, $4, $5, $6::jsonb, now() - make_interval(days => $7))`,
    [conversationId, tenantId, role, `${role} row ${dedupeSeq}`, `health-${dedupeSeq}`, JSON.stringify(raw), ageDays],
  );
}

async function insertToolCall(name: string, status: string, ageDays = 0): Promise<void> {
  dedupeSeq += 1;
  await pool.query(
    `insert into agent_tool_calls
       (tenant_id, agent_id, conversation_id, tool_name, args, dedupe_key, status, requested_at)
     values ($1, $2, $3, $4, '{}'::jsonb, $5, $6, now() - make_interval(days => $7))`,
    [tenantId, agentId, conversationId, name, `tc-health-${dedupeSeq}`, status, ageDays],
  );
}

async function healthRes(qs: string) {
  return app.inject({
    method: 'GET',
    url: `/v1/agents/${identifier}/health${qs}`,
    headers: { 'x-api-key': apiKey },
  });
}
async function health(days: number) {
  return json(await healthRes(`?days=${days}`));
}

beforeAll(async () => {
  app = await buildApp();
  const email = `health-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Health IT', email, password: 'integration-pw-1', organizationName: 'Health IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  const create = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier,
      name: 'Health Agent',
      runtime: 'managed',
      model: 'health-model',
      llm: { apiKey: 'health-key-123456', baseUrl: 'http://localhost:9999' },
    },
  });
  expect(create.statusCode).toBe(201);

  const { rows: agentRows } = await pool.query('select id from agents where tenant_id = $1 and identifier = $2', [
    tenantId,
    identifier,
  ]);
  agentId = agentRows[0].id;

  const { rows: subRows } = await pool.query(
    `insert into subscribers (tenant_id, external_id) values ($1, 'health-sub') returning id`,
    [tenantId],
  );
  const subscriberId = subRows[0].id;
  const { rows: convRows } = await pool.query(
    `insert into conversations (tenant_id, agent_id, subscriber_id, thread_key, channel)
     values ($1, $2, $3, 'health-sub', 'inapp') returning id`,
    [tenantId, agentId, subscriberId],
  );
  conversationId = convRows[0].id;

  // ---- in-window fixture (created just now) ----
  // Four traced agent replies + one untraced agent reply + one traced system
  // note. Traced totalMs values [100,200,300,400,500] give avg=300 and an
  // unambiguous percentile_cont(0.95)=480 (interp between 400 and 500 at 0.8).
  await insertMessage('agent', tracedRaw(100));
  await insertMessage('agent', tracedRaw(200));
  await insertMessage('agent', tracedRaw(300));
  await insertMessage('agent', tracedRaw(400));
  await insertMessage('agent', untracedRaw()); // counts in turns/replies, not latency
  await insertMessage('system', tracedRaw(500)); // a refusal/limit/paused note stamps usage+trace

  // Tool calls in-window: refund ×2 (one failed), lookup ×1.
  await insertToolCall('refund', 'executed');
  await insertToolCall('refund', 'failed');
  await insertToolCall('lookup', 'executed');

  // ---- backdated fixture (20 days old): inside a 30-day window, outside 7 ----
  await insertMessage('agent', tracedRaw(999), 20);
  await insertToolCall('refund', 'executed', 20);
});

afterAll(async () => {
  await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('agent health aggregate', () => {
  test('7-day window: exact counts, latency, token means, and per-tool tallies', async () => {
    const h = await health(7);
    expect(h.windowDays).toBe(7);
    expect(h.turns).toBe(6);
    expect(h.replies).toBe(5);
    expect(h.notes).toBe(1);
    // Latency from the five traced rows only [100,200,300,400,500].
    expect(h.avgMs).toBe(300);
    expect(h.p95Ms).toBe(480);
    expect(h.avgInputTokens).toBe(10);
    expect(h.avgOutputTokens).toBe(5);
    expect(h.toolCalls).toBe(3);
    expect(h.toolFailures).toBe(1);
    // Ordered by calls desc, then name; avgMs is always null (no per-call duration).
    expect(h.tools).toEqual([
      { name: 'refund', calls: 2, failures: 1, avgMs: null },
      { name: 'lookup', calls: 1, failures: 0, avgMs: null },
    ]);
  });

  test('window boundary: a 30-day window admits the 20-day-old turn and tool call', async () => {
    const h = await health(30); // distinct cache key from days=7
    expect(h.turns).toBe(7); // + the backdated agent reply
    expect(h.replies).toBe(6);
    expect(h.toolCalls).toBe(4); // + the backdated refund
    expect(h.tools.find((t: { name: string }) => t.name === 'refund')).toMatchObject({ calls: 3 });
  });

  test('days clamp: 0 and 99 are 400; the default is windowDays 7', async () => {
    expect((await healthRes('?days=0')).statusCode).toBe(400);
    expect((await healthRes('?days=99')).statusCode).toBe(400);
    const def = await healthRes(''); // reuses the days=7 key/value
    expect(def.statusCode).toBe(200);
    expect(json(def).windowDays).toBe(7);
  });

  test('an unknown agent is a 404', async () => {
    const unknown = await app.inject({
      method: 'GET',
      url: '/v1/agents/does-not-exist/health',
      headers: { 'x-api-key': apiKey },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
