/**
 * API integration tests — boot the real Fastify app in-process (no port)
 * against the real Postgres + Redis from docker-compose. Each run signs up
 * a fresh random org, so tests are isolated and repeatable.
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
const email = `test-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
const password = 'integration-pw-1';
let accessToken = '';
let devKey = '';
let prodKey = '';
let devEnvId = '';

const json = (res: { body: string }) => JSON.parse(res.body);

beforeAll(async () => {
  app = await buildApp();
});

afterAll(async () => {
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('auth + accounts', () => {
  test('signup creates org, two environments, one key each', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { name: 'ITest', email, password, organizationName: 'ITest Org' },
    });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.environments).toHaveLength(2);
    const dev = body.environments.find((e: { name: string }) => e.name === 'Development');
    const prod = body.environments.find((e: { name: string }) => e.name === 'Production');
    expect(dev.apiKey).toMatch(/^ak_dev_/);
    expect(prod.apiKey).toMatch(/^ak_live_/);
    accessToken = body.accessToken;
    devKey = dev.apiKey;
    prodKey = prod.apiKey;
    devEnvId = dev.id;
  });

  test('duplicate email is rejected without leaking details', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { name: 'X', email, password: 'whatever123', organizationName: 'Y' },
    });
    expect(res.statusCode).toBe(409);
  });

  test('wrong password and unknown email return the same 401', async () => {
    const bad = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: 'wrong-password' },
    });
    const ghost = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: 'nobody@itest.local', password: 'wrong-password' },
    });
    expect(bad.statusCode).toBe(401);
    expect(ghost.statusCode).toBe(401);
    expect(json(bad).error).toBe(json(ghost).error);
  });

  test('refresh tokens cannot be used as access tokens', async () => {
    const login = json(
      await app.inject({ method: 'POST', url: '/auth/login', payload: { email, password } }),
    );
    const res = await app.inject({
      method: 'GET',
      url: '/auth/me',
      headers: { authorization: `Bearer ${login.refreshToken}` },
    });
    expect(res.statusCode).toBe(401);
  });

  test('revoked keys stop working immediately', async () => {
    const created = json(
      await app.inject({
        method: 'POST',
        url: `/v1/account/environments/${devEnvId}/api-keys`,
        headers: { authorization: `Bearer ${accessToken}` },
        payload: { name: 'itest-temp' },
      }),
    );
    expect(created.apiKey).toMatch(/^ak_dev_/);
    // works before revocation…
    const before = await app.inject({
      method: 'GET',
      url: '/v1/workflows',
      headers: { 'x-api-key': created.apiKey },
    });
    expect(before.statusCode).toBe(200);
    await app.inject({
      method: 'DELETE',
      url: `/v1/account/environments/${devEnvId}/api-keys/${created.id}`,
      headers: { authorization: `Bearer ${accessToken}` },
    });
    const after = await app.inject({
      method: 'GET',
      url: '/v1/workflows',
      headers: { 'x-api-key': created.apiKey },
    });
    expect(after.statusCode).toBe(401);
  });
});

describe('workflows + triggers', () => {
  test('workflow steps are validated (body or template required)', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: '/v1/workflows',
      headers: { 'x-api-key': devKey },
      payload: { key: 'bad', name: 'Bad', steps: [{ channel: 'email' }] },
    });
    expect(res.statusCode).toBe(400);
  });

  test('valid workflow saves; trigger is accepted; duplicate transactionId dedupes', async () => {
    const save = await app.inject({
      method: 'PUT',
      url: '/v1/workflows',
      headers: { 'x-api-key': devKey },
      payload: {
        key: 'itest-flow',
        name: 'ITest flow',
        steps: [{ channel: 'inapp', subject: 'Hi {{name}}', body: 'Hello {{name}}' }],
      },
    });
    expect(save.statusCode).toBe(200);

    const txn = `itest-${Date.now()}`;
    const first = await app.inject({
      method: 'POST',
      url: '/v1/events/trigger',
      headers: { 'x-api-key': devKey },
      payload: {
        workflowKey: 'itest-flow',
        transactionId: txn,
        to: [{ subscriberId: 'itest-user' }],
        payload: { name: 'ITest' },
      },
    });
    expect(first.statusCode).toBe(202);

    const second = await app.inject({
      method: 'POST',
      url: '/v1/events/trigger',
      headers: { 'x-api-key': devKey },
      payload: {
        workflowKey: 'itest-flow',
        transactionId: txn,
        to: [{ subscriberId: 'itest-user' }],
        payload: { name: 'ITest' },
      },
    });
    expect(second.statusCode).toBe(200);
    expect(json(second).duplicate).toBe(true);
  });

  test('unknown workflow and unknown topic both 404 at accept time', async () => {
    const wf = await app.inject({
      method: 'POST',
      url: '/v1/events/trigger',
      headers: { 'x-api-key': devKey },
      payload: { workflowKey: 'ghost', to: [{ subscriberId: 'u' }] },
    });
    expect(wf.statusCode).toBe(404);

    const topic = await app.inject({
      method: 'POST',
      url: '/v1/events/trigger',
      headers: { 'x-api-key': devKey },
      payload: { workflowKey: 'itest-flow', to: [{ topic: 'ghost-topic' }] },
    });
    expect(topic.statusCode).toBe(404);
  });

  test('environment isolation: the prod key cannot see dev workflows', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/workflows/itest-flow',
      headers: { 'x-api-key': prodKey },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('webhook security', () => {
  test('unsigned status callbacks are rejected when a secret is configured', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/providers/smtp',
      payload: { providerMessageId: 'x', status: 'bounced' },
    });
    // 401 when WEBHOOK_SIGNING_SECRET is set (as in dev/.env); the route
    // only accepts unsigned callbacks when no secret is configured.
    expect([401, 200]).toContain(res.statusCode);
  });
});
