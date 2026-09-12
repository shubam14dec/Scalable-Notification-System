/**
 * GET /v1/ops/tenant-stats — the tenant-truth replacement for the Overview's
 * two platform gauges (user-found, 2026-09-13: "Queue backlog" and
 * "Dead-lettered" read the shared BullMQ queues, so every tenant saw the same
 * platform numbers, including a constant 182 dead-lettered jobs from traffic
 * that was never theirs).
 *
 * The subject is isolation and bucketing, so this suite seeds message rows
 * DIRECTLY (upsertSubscriber + insertEvent + insertMessage — the same factory
 * shape tests/integration/sms-receipts.test.ts uses): the statuses being
 * counted are terminal ones a real trigger would take a provider round-trip and
 * a status callback to reach, and the endpoint counts rows, not history.
 *
 * Two tenants are real signups, so "only the caller's rows" is proven against
 * two independent orgs rather than a filtered query.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import {
  insertEvent,
  insertMessage,
  upsertSubscriber,
  FAILED_MESSAGE_STATUSES,
  IN_FLIGHT_MESSAGE_STATUSES,
  TERMINAL_MESSAGE_STATUSES,
} from '../../src/db/repositories';

let app: FastifyInstance;

const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const json = (res: { body: string }) => JSON.parse(res.body);

interface Tenant {
  envId: string;
  apiKey: string;
}
let alpha: Tenant;
let beta: Tenant;

async function signup(tag: string): Promise<Tenant> {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: `${tag} IT`,
      email: `stats-${tag}-${stamp}@itest.local`,
      password: 'integration-pw-1',
      organizationName: `Stats ${tag} Org ${stamp}`,
    },
  });
  expect(res.statusCode).toBe(201);
  const dev = json(res).environments.find((e: { name: string }) => e.name === 'Development');
  return { envId: dev.id, apiKey: dev.apiKey };
}

/** One message row in `status`, on its own event so the unique key never bites. */
async function seedMessage(tenant: Tenant, tag: string, status: string): Promise<void> {
  const sub = await upsertSubscriber(tenant.envId, {
    subscriberId: `stats-sub-${tag}`,
    email: `stats-${tag}@itest.local`,
  });
  const transactionId = `stats-txn-${tag}`;
  const event = await insertEvent({
    tenantId: tenant.envId,
    transactionId,
    workflowKey: 'tenant-stats-test',
    priority: 'p1',
    payload: {},
    recipients: [{ subscriberId: sub.external_id }],
  });
  await insertMessage({
    tenantId: tenant.envId,
    eventId: event!.id,
    subscriberId: sub.id,
    transactionId,
    channel: 'email',
    stepIndex: 0,
    priority: 'p1',
    content: { body: 'hi', to: { email: `stats-${tag}@itest.local` } },
    status,
  });
}

const statsFor = (tenant: Tenant) =>
  app.inject({ method: 'GET', url: '/v1/ops/tenant-stats', headers: { 'x-api-key': tenant.apiKey } });

beforeAll(async () => {
  app = await buildApp();
  alpha = await signup('alpha');
  beta = await signup('beta');

  // Alpha: 2 in flight, 3 failed, and one of every status that is neither.
  await seedMessage(alpha, `a-q-${stamp}`, 'queued');
  await seedMessage(alpha, `a-s-${stamp}`, 'sending');
  await seedMessage(alpha, `a-f1-${stamp}`, 'failed');
  await seedMessage(alpha, `a-f2-${stamp}`, 'failed');
  await seedMessage(alpha, `a-b-${stamp}`, 'bounced');
  for (const neither of ['sent', 'delivered', 'skipped', 'merged', 'complaint']) {
    await seedMessage(alpha, `a-${neither}-${stamp}`, neither);
  }

  // Beta: a deliberately different pair — 1 in flight, 1 failed.
  await seedMessage(beta, `b-q-${stamp}`, 'queued');
  await seedMessage(beta, `b-f-${stamp}`, 'failed');
});

afterAll(async () => {
  for (const tenant of [alpha, beta]) {
    if (!tenant) continue;
    await pool.query('delete from messages where tenant_id = $1', [tenant.envId]);
    await pool.query('delete from events where tenant_id = $1', [tenant.envId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenant.envId]);
  }
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('GET /v1/ops/tenant-stats', () => {
  test('requires authentication', async () => {
    const anon = await app.inject({ method: 'GET', url: '/v1/ops/tenant-stats' });
    expect(anon.statusCode).toBe(401);
  });

  test('each tenant sees ONLY its own counts', async () => {
    const a = await statsFor(alpha);
    expect(a.statusCode).toBe(200);
    expect(json(a)).toEqual({ inFlight: 2, failed: 3 });

    const b = await statsFor(beta);
    expect(b.statusCode).toBe(200);
    expect(json(b)).toEqual({ inFlight: 1, failed: 1 });
  });

  test("one tenant's new failure never moves another tenant's numbers", async () => {
    const before = json(await statsFor(beta));
    await seedMessage(alpha, `a-f3-${stamp}`, 'failed');

    expect(json(await statsFor(alpha))).toEqual({ inFlight: 2, failed: 4 });
    expect(json(await statsFor(beta))).toEqual(before);
  });

  test('delivered, skipped, merged and complaint rows are in neither bucket', async () => {
    // Alpha carries one of each (seeded above) and its numbers are still the
    // 2 + 4 the two buckets account for — so nothing else is being counted.
    const { rows } = await pool.query(
      'select count(*)::int as count from messages where tenant_id = $1',
      [alpha.envId],
    );
    expect(rows[0].count).toBe(11); // 2 in flight + 4 failed + 5 neither
    expect(json(await statsFor(alpha))).toEqual({ inFlight: 2, failed: 4 });
  });
});

/**
 * The bucket lists are a partition of the message-status universe, asserted
 * here rather than trusted: IN_FLIGHT is deliberately an explicit list (a
 * `status <> all(terminal)` negation cannot use an index — see the doc in
 * src/db/repositories.ts), which means a new status added to the schema without
 * a bucket would silently vanish from the Overview. This is the tripwire.
 */
describe('message-status buckets', () => {
  /**
   * Every status this codebase can write to messages.status, gathered by hand
   * from: the schema comment (src/db/schema.sql), insertMessage's default
   * ('queued'), the delivery processor ('sending' | 'sent' | 'failed' |
   * 'skipped'), the worker's exhausted-retries hook ('failed'), the status
   * processor's STATUS_MAP ('delivered' | 'bounced' | 'failed' | 'complaint')
   * and the digest merge ('merged'). Adding a status to the code means adding
   * it here AND to a bucket.
   */
  const ALL_MESSAGE_STATUSES = [
    'queued',
    'sending',
    'sent',
    'delivered',
    'failed',
    'skipped',
    'bounced',
    'complaint',
    'merged',
  ];

  test('in-flight and failed never overlap', () => {
    const overlap = IN_FLIGHT_MESSAGE_STATUSES.filter((s) => FAILED_MESSAGE_STATUSES.includes(s));
    expect(overlap).toEqual([]);
  });

  test('in-flight is exactly the complement of terminal', () => {
    // The two definitions of "done" must agree: a status is either terminal
    // (settleCompletedEvents can complete its event) or in flight, never both
    // and never neither.
    expect([...IN_FLIGHT_MESSAGE_STATUSES].sort()).toEqual(
      ALL_MESSAGE_STATUSES.filter((s) => !TERMINAL_MESSAGE_STATUSES.includes(s)).sort(),
    );
  });

  test('failed is a subset of terminal', () => {
    for (const status of FAILED_MESSAGE_STATUSES) {
      expect(TERMINAL_MESSAGE_STATUSES, status).toContain(status);
    }
  });

  test('every known status is bucketed: in flight, failed, or terminal-but-fine', () => {
    for (const status of ALL_MESSAGE_STATUSES) {
      const bucketed =
        IN_FLIGHT_MESSAGE_STATUSES.includes(status) ||
        FAILED_MESSAGE_STATUSES.includes(status) ||
        TERMINAL_MESSAGE_STATUSES.includes(status);
      expect(bucketed, `${status} belongs to no bucket`).toBe(true);
    }
  });
});
