/**
 * Phase 24 slice E — long-term subscriber memory, end to end: the real Fastify
 * app + real conversation core + the @anthropic-ai/sdk pointed (via the agent's
 * llm_base_url) at a stub Messages API. Only the model server is fake.
 *
 * Covers:
 *  - the `remember` built-in: a stubbed turn that calls it persists a row with
 *    source 'agent', and the NEXT turn for the SAME subscriber carries that fact
 *    in the <customer_profile> system block (the D4 injection);
 *  - the operator memory API (D11): GET wrapped {memories:[...]}, PUT with
 *    source 'operator', DELETE ?key= (one) and DELETE (whole profile), the 409
 *    cap shape {error, reason, currentKeys, limits}, and 404 on unknown
 *    subscriber;
 *  - GDPR: deleting the subscriber row cascades the memories away (SQL count 0).
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
let agentId = '';
const AGENT = 'mem-support';

// ---- stub Anthropic-compatible server ----
let llmStub: Server;
let llmBaseUrl = '';
interface SeenRequest {
  system?: unknown;
  messages: Array<{ role: string; content: unknown }>;
}
const seen: SeenRequest[] = [];
let stubQueue: unknown[] = [];

const envelope = (content: unknown[], stopReason: string) => ({
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: 'glm-4-test',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const toolUseResponse = (uses: Array<{ id: string; name: string; input: unknown }>) =>
  envelope(uses.map((u) => ({ type: 'tool_use', ...u })), 'tool_use');
const textResponse = (text: string) => envelope([{ type: 'text', text }], 'end_turn');

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

/** The brain sends `system` as a cache_control blocks array; flatten to text. */
const lastSystemText = (): string => {
  const s = seen.at(-1)!.system as unknown;
  if (Array.isArray(s)) return s.map((b: { text?: string }) => b.text ?? '').join('\n\n');
  return String(s ?? '');
};

async function runTurn(subscriberId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${AGENT}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  const turn = json(res) as { conversationId: string; messageId: string };
  await processConversation({
    data: { tenantId, conversationId: turn.conversationId, messageId: turn.messageId },
  } as Job<ConversationJobData>);
  return turn;
}

async function subscriberUuid(externalId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    'select id from subscribers where tenant_id = $1 and external_id = $2',
    [tenantId, externalId],
  );
  return rows[0].id;
}

async function insertSubscriber(externalId: string): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    `insert into subscribers (tenant_id, external_id) values ($1, $2)
     on conflict (tenant_id, external_id) do update set updated_at = now()
     returning id`,
    [tenantId, externalId],
  );
  return rows[0].id;
}

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `mem-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Mem IT', email, password: 'integration-pw-1', organizationName: 'Mem IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  const create = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: AGENT,
      name: 'Memory Support',
      runtime: 'managed',
      model: 'glm-4-test',
      systemPrompt: 'You are the Acme support agent.',
      llm: { apiKey: 'mem-test-key-123456', baseUrl: llmBaseUrl },
    },
  });
  expect(create.statusCode).toBe(201);
  const { rows } = await pool.query<{ id: string }>(
    'select id from agents where tenant_id = $1 and identifier = $2',
    [tenantId, AGENT],
  );
  agentId = rows[0].id;
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

describe('the remember tool + profile injection', () => {
  test('a stubbed turn that calls remember persists a row with source agent', async () => {
    stubQueue = [
      toolUseResponse([
        { id: 'rem1', name: 'remember', input: { key: 'channel_preference', value: 'prefers email over sms' } },
      ]),
      textResponse('Noted — I will reach you by email.'),
    ];
    await runTurn('mem-cust', 'btw I always prefer email over sms', 'mem-r1');

    const { rows } = await pool.query<{ key: string; value: string; source: string }>(
      `select m.key, m.value, m.source from subscriber_memories m
         join subscribers s on s.id = m.subscriber_id
        where m.agent_id = $1 and s.external_id = 'mem-cust'`,
      [agentId],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      key: 'channel_preference',
      value: 'prefers email over sms',
      source: 'agent',
    });
  });

  test("the NEXT turn's system block carries the fact in <customer_profile>", async () => {
    stubQueue = [textResponse('Sure, happy to help.')];
    await runTurn('mem-cust', 'which channel will you contact me on?', 'mem-r2');

    const system = lastSystemText();
    expect(system).toContain('<customer_profile>');
    expect(system).toContain('channel_preference: prefers email over sms');
    expect(system).toContain('do not recite this list');
  });

  test('a subscriber with NO memories gets NO <customer_profile> block', async () => {
    stubQueue = [textResponse('Hello!')];
    await runTurn('mem-empty', 'hi', 'mem-empty-1');
    expect(lastSystemText()).not.toContain('<customer_profile>');
  });
});

describe('the operator memory API (D11)', () => {
  const base = () => `/v1/agents/${AGENT}/memories`;

  test('PUT writes with source operator; GET returns the wrapped list', async () => {
    await insertSubscriber('api-cust');
    const put = await app.inject({
      method: 'PUT',
      url: `${base()}/api-cust`,
      headers: { 'x-api-key': apiKey },
      payload: { key: 'plan', value: 'Pro' },
    });
    expect(put.statusCode).toBe(200);
    expect(json(put).memory).toMatchObject({ key: 'plan', value: 'Pro', source: 'operator' });

    const get = await app.inject({
      method: 'GET',
      url: `${base()}/api-cust`,
      headers: { 'x-api-key': apiKey },
    });
    expect(get.statusCode).toBe(200);
    const body = json(get);
    expect(body).toHaveProperty('memories');
    expect(body.memories).toEqual([{ key: 'plan', value: 'Pro', source: 'operator', updatedAt: expect.any(String) }]);
  });

  test('DELETE ?key= removes one fact; DELETE removes the whole profile', async () => {
    await insertSubscriber('del-cust');
    for (const [k, v] of [['a', '1'], ['b', '2'], ['c', '3']]) {
      await app.inject({
        method: 'PUT',
        url: `${base()}/del-cust`,
        headers: { 'x-api-key': apiKey },
        payload: { key: k, value: v },
      });
    }
    const one = await app.inject({
      method: 'DELETE',
      url: `${base()}/del-cust?key=b`,
      headers: { 'x-api-key': apiKey },
    });
    expect(json(one).deleted).toBe(1);

    const afterOne = await app.inject({
      method: 'GET',
      url: `${base()}/del-cust`,
      headers: { 'x-api-key': apiKey },
    });
    expect(json(afterOne).memories.map((m: { key: string }) => m.key)).toEqual(['a', 'c']);

    const all = await app.inject({
      method: 'DELETE',
      url: `${base()}/del-cust`,
      headers: { 'x-api-key': apiKey },
    });
    expect(json(all).deleted).toBe(2);
    const empty = await app.inject({
      method: 'GET',
      url: `${base()}/del-cust`,
      headers: { 'x-api-key': apiKey },
    });
    expect(json(empty).memories).toEqual([]);
  });

  test('a full profile returns 409 with {reason, currentKeys, limits}', async () => {
    const subId = await insertSubscriber('full-cust');
    // Seed exactly 32 keys directly (fast) so the API PUT is the 33rd.
    for (let i = 0; i < 32; i += 1) {
      await pool.query(
        `insert into subscriber_memories (tenant_id, agent_id, subscriber_id, key, value, source)
         values ($1, $2, $3, $4, 'v', 'operator')`,
        [tenantId, agentId, subId, `full_${String(i).padStart(2, '0')}`],
      );
    }
    const res = await app.inject({
      method: 'PUT',
      url: `${base()}/full-cust`,
      headers: { 'x-api-key': apiKey },
      payload: { key: 'one_too_many', value: 'v' },
    });
    expect(res.statusCode).toBe(409);
    const body = json(res);
    expect(body.reason).toBe('too_many_keys');
    expect(body.currentKeys).toHaveLength(32);
    expect(body.limits).toMatchObject({ maxKeys: 32, maxKeyLen: 64, maxValueLen: 300 });

    // Overwriting an EXISTING key still succeeds at the cap (200, not 409).
    const overwrite = await app.inject({
      method: 'PUT',
      url: `${base()}/full-cust`,
      headers: { 'x-api-key': apiKey },
      payload: { key: 'full_00', value: 'updated' },
    });
    expect(overwrite.statusCode).toBe(200);
  });

  test('an unknown subscriber is a 404 on GET / PUT / DELETE', async () => {
    const get = await app.inject({
      method: 'GET',
      url: `${base()}/nobody-here`,
      headers: { 'x-api-key': apiKey },
    });
    expect(get.statusCode).toBe(404);
    const put = await app.inject({
      method: 'PUT',
      url: `${base()}/nobody-here`,
      headers: { 'x-api-key': apiKey },
      payload: { key: 'k', value: 'v' },
    });
    expect(put.statusCode).toBe(404);
    const del = await app.inject({
      method: 'DELETE',
      url: `${base()}/nobody-here`,
      headers: { 'x-api-key': apiKey },
    });
    expect(del.statusCode).toBe(404);
  });
});

describe('GDPR — deleting the subscriber cascades the memories away', () => {
  test('the subscriber_memories rows vanish when the subscriber row is deleted', async () => {
    const subId = await insertSubscriber('gdpr-cust');
    await pool.query(
      `insert into subscriber_memories (tenant_id, agent_id, subscriber_id, key, value, source)
       values ($1, $2, $3, 'name', 'Dana', 'operator')`,
      [tenantId, agentId, subId],
    );
    const before = await pool.query('select count(*)::int as n from subscriber_memories where subscriber_id = $1', [subId]);
    expect(before.rows[0].n).toBe(1);

    // The GDPR erase: drop the subscriber row.
    await pool.query('delete from subscribers where id = $1', [subId]);

    const after = await pool.query('select count(*)::int as n from subscriber_memories where subscriber_id = $1', [subId]);
    expect(after.rows[0].n).toBe(0);
  });
});
