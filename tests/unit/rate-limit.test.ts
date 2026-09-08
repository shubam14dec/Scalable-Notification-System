/**
 * S1.2 — the shared per-IP brake (src/api/rate-limit.ts), driven through a
 * bare Fastify instance so the preHandler is exercised exactly as a route
 * mounts it, with the real Redis counter behind it (db 15, per tests/setup.ts).
 *
 * The "fresh minute resets" case deletes the current bucket key rather than
 * sleeping: the key IS the minute, so removing it is indistinguishable from
 * the clock rolling over — and it keeps the suite fast.
 *
 * Requires: `docker compose up -d redis`.
 */
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeEach, describe, expect, test } from 'vitest';
import {
  countSubscriberTurn,
  ipRateLimit,
  ipRateLimitKey,
  SUBSCRIBER_TURNS_PER_MIN,
  withinIpBudget,
} from '../../src/api/rate-limit';
import { redis } from '../../src/shared/redis';

/** Every inject() call reports this ip, so one budget covers a whole test. */
const IP = '127.0.0.1';

async function clear(name: string): Promise<void> {
  const keys = await redis.keys(`${name}-rl:*`);
  if (keys.length) await redis.del(...keys);
}

function appWith(name: string, max: number, opts?: Parameters<typeof ipRateLimit>[2]) {
  const app: FastifyInstance = Fastify();
  app.post('/probe', { preHandler: [ipRateLimit(name, max, opts)] }, async () => ({ ok: true }));
  return app;
}

beforeEach(async () => {
  await clear('unit-brake');
  await clear('unit-html');
});

afterAll(async () => {
  await clear('unit-brake');
  await clear('unit-html');
  await redis.quit();
});

describe('ipRateLimit', () => {
  test('the 11th call in a minute is a 429; a fresh minute lets it through again', async () => {
    const app = appWith('unit-brake', 10);

    for (let i = 0; i < 10; i += 1) {
      const res = await app.inject({ method: 'POST', url: '/probe' });
      expect(res.statusCode).toBe(200);
    }

    const over = await app.inject({ method: 'POST', url: '/probe' });
    expect(over.statusCode).toBe(429);
    expect(JSON.parse(over.body)).toEqual({ error: 'too many requests' });
    expect(over.headers['retry-after']).toBe('60');

    // Roll the minute over: the bucket key is the minute, so dropping it is
    // exactly what the clock does at the boundary.
    await redis.del(ipRateLimitKey('unit-brake', IP));
    const after = await app.inject({ method: 'POST', url: '/probe' });
    expect(after.statusCode).toBe(200);

    await app.close();
  });

  test('the counter expires on its own (TTL set on the first hit of a bucket)', async () => {
    await withinIpBudget('unit-brake', IP, 10);
    const ttl = await redis.ttl(ipRateLimitKey('unit-brake', IP));
    expect(ttl).toBeGreaterThan(0);
    expect(ttl).toBeLessThanOrEqual(61);
  });

  test('budgets are namespaced: exhausting one surface never blocks another', async () => {
    for (let i = 0; i < 10; i += 1) await withinIpBudget('unit-brake', IP, 10);
    expect(await withinIpBudget('unit-brake', IP, 10)).toBe(false);
    // A different name is a different key, so it is untouched.
    expect(await withinIpBudget('unit-html', IP, 10)).toBe(true);
  });

  test('onLimit replaces the JSON body (the handoff page keeps its HTML 429)', async () => {
    const app = appWith('unit-html', 1, {
      onLimit: (_req, reply) => reply.code(429).type('text/html').send('<h1>Too many</h1>'),
    });
    expect((await app.inject({ method: 'POST', url: '/probe' })).statusCode).toBe(200);
    const over = await app.inject({ method: 'POST', url: '/probe' });
    expect(over.statusCode).toBe(429);
    expect(over.headers['content-type']).toContain('text/html');
    expect(over.body).toContain('Too many');
    await app.close();
  });
});

describe('countSubscriberTurn', () => {
  test('counts per (tenant, subscriber) and reports seconds until the bucket rolls', async () => {
    const tenant = `t-${Date.now()}`;
    const first = await countSubscriberTurn(tenant, 'sub-a');
    expect(first.count).toBe(1);
    expect(first.retryAfterSeconds).toBeGreaterThan(0);
    expect(first.retryAfterSeconds).toBeLessThanOrEqual(60);

    expect((await countSubscriberTurn(tenant, 'sub-a')).count).toBe(2);
    // A different subscriber under the same tenant has its own allowance.
    expect((await countSubscriberTurn(tenant, 'sub-b')).count).toBe(1);
    // ...and so does the same subscriber id under a different tenant.
    expect((await countSubscriberTurn(`${tenant}-other`, 'sub-a')).count).toBe(1);

    expect(SUBSCRIBER_TURNS_PER_MIN).toBe(20);
  });
});
