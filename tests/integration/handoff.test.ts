/**
 * QR-code bot-setup handoff, end to end against the real app: the dashboard
 * mints a single-use 5-minute token, the phone opens the public page and pastes
 * BotFather's message, and the authed dashboard poll reads the parsed bot token
 * back exactly once. Covers the parse-first-then-consume rule, the one-shot
 * read, expiry, cross-tenant isolation, and the per-IP paste rate limit.
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
let otherApiKey = '';
let otherTenantId = '';

const json = (res: { body: string }) => JSON.parse(res.body);
const auth = (key = apiKey) => ({ 'x-api-key': key });

// A real-shaped telegram token for the "valid paste" cases.
const TOKEN = '7000009:AAhandoff-real-shaped-token_0123456789AB';
const TOKEN_2 = '8222222:BBhandoff-second-shaped-token_ABCDEFGHIJ';

/** Flush the per-IP paste-rate-limit keys (db 15) so counts start clean. */
async function flushRateLimitKeys(): Promise<void> {
  const keys = await redis.keys('handoff-rl:*');
  if (keys.length) await redis.del(...keys);
}

async function mint(key = apiKey): Promise<{ handoffId: string; url: string; token: string; expiresAt: string }> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/ops/handoffs',
    headers: auth(key),
    payload: {},
  });
  expect(res.statusCode).toBe(201);
  const body = json(res);
  return { ...body, token: String(body.url).split('/handoff/')[1] };
}

async function getPage(token: string) {
  return app.inject({ method: 'GET', url: `/handoff/${token}` });
}
async function postPaste(token: string, message: unknown) {
  return app.inject({ method: 'POST', url: `/handoff/${token}`, payload: { message } });
}
async function poll(handoffId: string, key = apiKey) {
  return app.inject({ method: 'GET', url: `/v1/ops/handoffs/${handoffId}`, headers: auth(key) });
}

beforeAll(async () => {
  await flushRateLimitKeys();
  app = await buildApp();

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Handoff IT',
      email: `handoff-${suffix}@itest.local`,
      password: 'integration-pw-1',
      organizationName: 'Handoff IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  const signup2 = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Handoff Other',
      email: `handoff-other-${suffix}@itest.local`,
      password: 'integration-pw-1',
      organizationName: 'Handoff Other Org',
    },
  });
  const dev2 = json(signup2).environments.find((e: { name: string }) => e.name === 'Development');
  otherApiKey = dev2.apiKey;
  otherTenantId = dev2.id;
});

afterAll(async () => {
  await pool.query('delete from setup_handoffs where tenant_id = any($1)', [
    [tenantId, otherTenantId],
  ]);
  await flushRateLimitKeys();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('mint', () => {
  test('returns a 201 with a phone URL on the current public URL', async () => {
    const m = await mint();
    expect(m.handoffId).toMatch(/^[0-9a-f-]{36}$/);
    expect(m.url).toBe(`http://localhost:3000/handoff/${m.token}`);
    expect(new Date(m.expiresAt).getTime()).toBeGreaterThan(Date.now());
  });
});

describe('the public paste page', () => {
  test('a live token serves the paste form; polling stays pending', async () => {
    const m = await mint();
    const page = await getPage(m.token);
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toContain('text/html');
    expect(page.body).toContain('<form');
    expect(page.body).toContain('BotFather');

    expect(json(await poll(m.handoffId)).status).toBe('pending');
  });
});

describe('parse-first-then-consume', () => {
  test('garbage paste is a 422 and leaves the token unconsumed', async () => {
    const m = await mint();
    const res = await postPaste(m.token, 'no token anywhere in here, sorry');
    expect(res.statusCode).toBe(422);

    // Not consumed: the page still serves the form and the poll is still pending.
    expect((await getPage(m.token)).statusCode).toBe(200);
    expect(json(await poll(m.handoffId)).status).toBe('pending');
  });

  test('two DISTINCT tokens is a 422 (ambiguous) and leaves it unconsumed', async () => {
    const m = await mint();
    const res = await postPaste(m.token, `here is ${TOKEN} and also ${TOKEN_2}`);
    expect(res.statusCode).toBe(422);
    expect(json(await poll(m.handoffId)).status).toBe('pending');
  });

  test('a valid paste consumes once: poll yields the token, then consumed, page 410s', async () => {
    const m = await mint();
    const paste = await postPaste(m.token, `Done! Congratulations. Token:\n${TOKEN}`);
    expect(paste.statusCode).toBe(200);
    expect(paste.body).toContain('Received');

    // First poll hands out the token exactly once.
    const first = await poll(m.handoffId);
    expect(json(first).status).toBe('received');
    expect(json(first).botToken).toBe(TOKEN);

    // Second poll: the sealed payload was nulled on read.
    expect(json(await poll(m.handoffId)).status).toBe('consumed');

    // The single-use token is spent — the page reports it dead.
    const page = await getPage(m.token);
    expect(page.statusCode).toBe(410);
    expect(page.body).toContain('expired');
  });
});

describe('expiry + isolation', () => {
  test('an expired handoff polls as expired', async () => {
    const m = await mint();
    await pool.query(
      `update setup_handoffs set expires_at = now() - interval '1 minute' where id = $1`,
      [m.handoffId],
    );
    expect(json(await poll(m.handoffId)).status).toBe('expired');
  });

  test('polling another tenant\'s handoff is a 404', async () => {
    const m = await mint();
    const res = await poll(m.handoffId, otherApiKey);
    expect(res.statusCode).toBe(404);
  });

  test('an invalid handoff id is a 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ops/handoffs/not-a-uuid',
      headers: auth(),
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('paste rate limit (per IP, 10/min)', () => {
  test('the 11th paste in a minute is a 429', async () => {
    // Isolate this test's budget from the pastes above (same IP + minute).
    await flushRateLimitKeys();
    const m = await mint();

    // 10 pastes are within budget (garbage → 422, but each still counts).
    for (let i = 0; i < 10; i += 1) {
      const res = await postPaste(m.token, `attempt ${i} with no token`);
      expect(res.statusCode).toBe(422);
    }
    // The 11th trips the wall before the body is even parsed.
    const over = await postPaste(m.token, `attempt 11 ${TOKEN}`);
    expect(over.statusCode).toBe(429);

    // The token was never consumed (the 429 short-circuits the consume).
    expect(json(await poll(m.handoffId)).status).toBe('pending');
  });
});
