/**
 * Auto-resolve on inactivity: the platform backstop for conversations that
 * trail off. The sweep is the exact code production runs — tests only
 * backdate last_message_at (faking the clock, never the path).
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { runInactivitySweep } from '../../src/workers/inactivity-sweep';

let app: FastifyInstance;
let apiKey = '';

const json = (res: { body: string }) => JSON.parse(res.body);

async function createAgent(identifier: string, autoResolveHours?: number) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier,
      name: identifier,
      bridgeUrl: 'http://localhost:59999/', // never called — the sweep has no brain
      ...(autoResolveHours ? { autoResolveHours } : {}),
    },
  });
  expect(res.statusCode).toBe(201);
  return json(res).agent;
}

/** A conversation is born from a message; returns its id. */
async function openConversation(agent: string, subscriberId: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${agent}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text: 'hello?', messageId },
  });
  expect(res.statusCode).toBe(202);
  return json(res).conversationId as string;
}

async function backdate(conversationId: string, hours: number) {
  await pool.query(
    `update conversations set last_message_at = now() - make_interval(hours => $2)
     where id = $1`,
    [conversationId, hours],
  );
}

async function conversationDetail(id: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/conversations/${id}`,
    headers: { 'x-api-key': apiKey },
  });
  return json(res);
}

beforeAll(async () => {
  app = await buildApp();
  const email = `sweep-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Sweep IT', email, password: 'integration-pw-1', organizationName: 'Sweep IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
});

afterAll(async () => {
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('the agent knob', () => {
  test('accepted on create, exposed in the view, PATCHable, nullable to disable', async () => {
    const agent = await createAgent('sweep-agent', 24);
    expect(agent.autoResolveHours).toBe(24);

    const patched = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/sweep-agent',
      headers: { 'x-api-key': apiKey },
      payload: { autoResolveHours: 48 },
    });
    expect(json(patched).agent.autoResolveHours).toBe(48);

    const cleared = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/sweep-agent',
      headers: { 'x-api-key': apiKey },
      payload: { autoResolveHours: null },
    });
    expect(json(cleared).agent.autoResolveHours).toBeNull();

    // Back on for the sweep tests below.
    await app.inject({
      method: 'PATCH',
      url: '/v1/agents/sweep-agent',
      headers: { 'x-api-key': apiKey },
      payload: { autoResolveHours: 24 },
    });
  });

  test('bounds are enforced', async () => {
    for (const bad of [0, 721, -5, 1.5]) {
      const res = await app.inject({
        method: 'PATCH',
        url: '/v1/agents/sweep-agent',
        headers: { 'x-api-key': apiKey },
        payload: { autoResolveHours: bad },
      });
      expect(res.statusCode).toBe(400);
    }
  });
});

describe('the sweep', () => {
  let staleId = '';

  test('a stale conversation resolves with summary + breadcrumb; fresh ones survive', async () => {
    staleId = await openConversation('sweep-agent', 'idle-ana', 'sw-1');
    const freshId = await openConversation('sweep-agent', 'busy-bob', 'sw-2');
    await backdate(staleId, 25); // past the 24h knob
    await backdate(freshId, 23); // not yet

    const resolved = await runInactivitySweep();
    expect(resolved).toBeGreaterThanOrEqual(1);

    const stale = await conversationDetail(staleId);
    expect(stale.conversation.status).toBe('resolved');
    expect(stale.conversation.summary).toBe('auto-resolved after 24 hours of inactivity');
    const crumbs = stale.messages.filter((m: { role: string }) => m.role === 'system');
    expect(crumbs.at(-1).content).toBe('auto-resolved after 24 hours of inactivity');

    expect((await conversationDetail(freshId)).conversation.status).toBe('active');
  });

  test('a re-run is a no-op: no duplicate breadcrumb, status untouched', async () => {
    const before = (await conversationDetail(staleId)).messages.length;
    await runInactivitySweep();
    const after = await conversationDetail(staleId);
    expect(after.conversation.status).toBe('resolved');
    expect(after.messages.length).toBe(before);
  });

  test('agents without the knob are never swept, however stale', async () => {
    await createAgent('sweep-off-agent'); // no autoResolveHours
    const id = await openConversation('sweep-off-agent', 'idle-carl', 'sw-3');
    await backdate(id, 24 * 90); // three months idle

    await runInactivitySweep();
    expect((await conversationDetail(id)).conversation.status).toBe('active');
  });

  test('a new message reopens an auto-resolved conversation', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/sweep-agent/messages',
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId: 'idle-ana', text: 'me again!', messageId: 'sw-4' },
    });
    expect(res.statusCode).toBe(202);
    expect(json(res).conversationId).toBe(staleId); // same thread
    expect((await conversationDetail(staleId)).conversation.status).toBe('active');
  });

  test('manually resolved conversations are not re-touched by the sweep', async () => {
    const id = await openConversation('sweep-agent', 'manual-mia', 'sw-5');
    await app.inject({
      method: 'POST',
      url: `/v1/conversations/${id}/resolve`,
      headers: { 'x-api-key': apiKey },
    });
    await backdate(id, 100);
    await runInactivitySweep();
    const detail = await conversationDetail(id);
    // Still resolved, but with NO auto-resolve breadcrumb/summary rewrite.
    expect(detail.conversation.status).toBe('resolved');
    expect(detail.messages.some((m: { content: string }) => m.content.includes('auto-resolved'))).toBe(false);
  });
});
