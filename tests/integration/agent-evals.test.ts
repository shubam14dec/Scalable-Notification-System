/**
 * Phase 22 slice B — per-agent evals: CRUD API + the run lifecycle driven THROUGH
 * the real queue. A bridge agent points at a local stub that echoes a fixed
 * reply; the eval-run processor's in-process driver enqueues conversation jobs
 * which a real conversation Worker (spun up here) services — exactly the
 * production pipeline (queue -> brain), no HTTP api key involved.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker } from 'bullmq';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, QUEUE } from '../../src/shared/queues';
import { createRedis, redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { processConversation } from '../../src/workers/processors/conversation.processor';
import { processEvalRun } from '../../src/workers/processors/eval-run.processor';

let app: FastifyInstance;
let apiKey = '';
let convWorker: Worker;

// A stub bridge that echoes a fixed reply for every turn.
let bridge: Server;
let bridgeUrl = '';

const json = (res: { body: string }) => JSON.parse(res.body);

function startBridge(): Promise<void> {
  return new Promise((resolve) => {
    bridge = createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ reply: 'hello there, how can I help?' }));
      });
    });
    bridge.listen(0, '127.0.0.1', () => resolve());
  });
}

beforeAll(async () => {
  await startBridge();
  bridgeUrl = `http://127.0.0.1:${(bridge.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `evals-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Evals IT', email, password: 'integration-pw-1', organizationName: 'Evals IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;

  await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: { identifier: 'evals-agent', name: 'Evals Agent', runtime: 'bridge', bridgeUrl },
  });

  // A live conversation worker to service the jobs the eval-run driver enqueues.
  convWorker = new Worker(QUEUE.CONVERSATION, processConversation as unknown as (job: Job) => Promise<void>, {
    connection: createRedis(),
    concurrency: 5,
  });
});

afterAll(async () => {
  await convWorker?.close();
  bridge?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

const evalUrl = (suffix = '') => `/v1/agents/evals-agent/evals${suffix}`;

describe('eval CRUD', () => {
  let evalId = '';

  test('create → list → update → delete', async () => {
    const scenario = { turns: [{ user: 'hi' }, { expect: { replyContains: 'help' } }] };
    const created = await app.inject({
      method: 'POST',
      url: evalUrl(),
      headers: { 'x-api-key': apiKey },
      payload: { name: 'greeting', scenario },
    });
    expect(created.statusCode).toBe(201);
    evalId = json(created).eval.id;
    expect(json(created).eval).toMatchObject({ name: 'greeting', enabled: true });

    // Duplicate name → 409.
    const dup = await app.inject({
      method: 'POST',
      url: evalUrl(),
      headers: { 'x-api-key': apiKey },
      payload: { name: 'greeting', scenario },
    });
    expect(dup.statusCode).toBe(409);

    // Bad scenario (no turns) → 400.
    const bad = await app.inject({
      method: 'POST',
      url: evalUrl(),
      headers: { 'x-api-key': apiKey },
      payload: { name: 'broken', scenario: { turns: [] } },
    });
    expect(bad.statusCode).toBe(400);

    const list = await app.inject({ method: 'GET', url: evalUrl(), headers: { 'x-api-key': apiKey } });
    expect(json(list).evals).toHaveLength(1);

    const updated = await app.inject({
      method: 'PUT',
      url: evalUrl(`/${evalId}`),
      headers: { 'x-api-key': apiKey },
      payload: { enabled: false },
    });
    expect(json(updated).eval.enabled).toBe(false);

    const del = await app.inject({
      method: 'DELETE',
      url: evalUrl(`/${evalId}`),
      headers: { 'x-api-key': apiKey },
    });
    expect(json(del).deleted).toBe(true);
  });

  test('unknown agent → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/nope/evals',
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('eval run lifecycle (through the queue)', () => {
  test('enqueue → drive turns → results populated', async () => {
    await app.inject({
      method: 'POST',
      url: evalUrl(),
      headers: { 'x-api-key': apiKey },
      payload: {
        name: 'run-greeting',
        scenario: { turns: [{ user: 'hi' }, { expect: { replyContains: 'help' } }] },
      },
    });

    const started = await app.inject({
      method: 'POST',
      url: evalUrl('/run'),
      headers: { 'x-api-key': apiKey },
      payload: { trigger: 'manual' },
    });
    expect(started.statusCode).toBe(202);
    const runId = json(started).runId as string;

    // Row is 'running' before the worker touches it.
    const before = await app.inject({
      method: 'GET',
      url: evalUrl(`/runs/${runId}`),
      headers: { 'x-api-key': apiKey },
    });
    expect(json(before).run.status).toBe('running');

    // Drive the run in-process; its driver enqueues conversation jobs the live
    // convWorker services, and it polls the transcript for the reply.
    await processEvalRun({ data: { runId } } as Job<{ runId: string }>);

    const after = await app.inject({
      method: 'GET',
      url: evalUrl(`/runs/${runId}`),
      headers: { 'x-api-key': apiKey },
    });
    const run = json(after).run;
    expect(run.status).toBe('passed');
    expect(run.finishedAt).not.toBeNull();
    expect(run.results).toHaveLength(1);
    expect(run.results[0]).toMatchObject({ name: 'run-greeting', passed: true, failures: [] });

    const list = await app.inject({
      method: 'GET',
      url: evalUrl('/runs'),
      headers: { 'x-api-key': apiKey },
    });
    expect(json(list).runs.length).toBeGreaterThanOrEqual(1);
  }, 90_000);
});
