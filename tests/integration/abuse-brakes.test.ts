/**
 * Phase S1.2 — abuse brakes, end to end against the real app.
 *
 * Four surfaces, one theme: every door a stranger (or a stolen widget token)
 * can knock on now has a wall behind it.
 *
 *  1. /auth/login + /auth/signup — per-IP credential brakes.
 *  2. the widget's inbound-turn routes — per-IP AND per-(tenant, subscriber),
 *     because every accepted turn buys a paid brain job.
 *  3. /v1/subscriber-tokens — the 6h TTL ceiling, and per-tenant token keying.
 *  4. /webhooks/providers/:provider/:tenantId — per-tenant signing key, a
 *     tenant-scoped worker update, and jobId replay collapse.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import type { Job } from 'bullmq';
import { buildApp } from '../../src/api/app';
import { closeQueues, getQueue, QUEUE } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { env } from '../../src/config/env';
import { signWebhook, tenantWebhookSecret } from '../../src/api/webhook-signature';
import { statusJobId } from '../../src/api/routes/webhooks';
import { mintSubscriberToken } from '../../src/auth/subscriber-token';
import { processStatus } from '../../src/workers/processors/status.processor';
import {
  insertEvent,
  insertMessage,
  updateMessage,
  upsertSubscriber,
} from '../../src/db/repositories';
import { SUBSCRIBER_TURNS_PER_MIN } from '../../src/api/rate-limit';

const AGENT_ID = 'brake-agent';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let otherApiKey = '';
let otherTenantId = '';
const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const originalWebhookSecret = env.webhookSigningSecret;

const json = (res: { body: string }) => JSON.parse(res.body);

/** Reset one named per-IP budget — the suite shares an IP with itself. */
async function clearBrake(name: string): Promise<void> {
  const keys = await redis.keys(`${name}-rl:*`);
  if (keys.length) await redis.del(...keys);
}

/** Reset the per-(tenant, subscriber) turn budgets. */
async function clearTurnBudgets(): Promise<void> {
  const keys = await redis.keys('agent-turns-rl:*');
  if (keys.length) await redis.del(...keys);
}

async function signup(name: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name,
      email: `${name}-${suffix}@itest.local`,
      password: 'integration-pw-1',
      organizationName: `${name} Org`,
    },
  });
  expect(res.statusCode).toBe(201);
  return json(res).environments.find((e: { name: string }) => e.name === 'Development');
}

async function sendTurn(subscriberId: string, i: number, headers: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: `/v1/agents/${AGENT_ID}/messages`,
    headers,
    payload: { subscriberId, text: `turn ${i}`, messageId: `brake-${subscriberId}-${i}` },
  });
}

/** Run the shared status processor in-process (no worker fleet under test). */
type StatusJobData = {
  provider: string;
  tenantId?: string;
  providerMessageId: string;
  status: string;
};
async function runStatusJob(data: StatusJobData): Promise<void> {
  await processStatus({ data } as Job<StatusJobData>);
}

/** A signed provider status callback for one tenant, with an optional wrong key. */
async function postProviderWebhook(
  targetTenantId: string,
  body: Record<string, unknown>,
  signingTenantId = targetTenantId,
) {
  const raw = JSON.stringify(body);
  const ts = String(Math.floor(Date.now() / 1000));
  return app.inject({
    method: 'POST',
    url: `/webhooks/providers/smtp/${targetTenantId}`,
    headers: {
      'content-type': 'application/json',
      'x-webhook-timestamp': ts,
      'x-webhook-signature': signWebhook(
        tenantWebhookSecret(env.webhookSigningSecret, signingTenantId),
        ts,
        raw,
      ),
    },
    payload: raw,
  });
}

beforeAll(async () => {
  app = await buildApp();
  // The route reads the secret per request, so pinning it here makes the
  // webhook cases deterministic whether or not .env sets one.
  env.webhookSigningSecret = 'itest-webhook-root-secret';

  const dev = await signup('brakes');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  const dev2 = await signup('brakes-other');
  otherApiKey = dev2.apiKey;
  otherTenantId = dev2.id;

  // A bridge agent whose bridge is never dialled: the turn routes only need
  // the agent to exist and be active, and no worker fleet runs under test.
  const created = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: { identifier: AGENT_ID, name: 'Brake Agent', bridgeUrl: 'http://localhost:9/' },
  });
  expect(created.statusCode).toBe(201);
});

afterAll(async () => {
  env.webhookSigningSecret = originalWebhookSecret;
  await clearBrake('login');
  await clearBrake('signup');
  await clearBrake('agent-msg');
  await clearTurnBudgets();
  await getQueue(QUEUE.STATUS).obliterate({ force: true });
  for (const id of [tenantId, otherTenantId]) {
    if (!id) continue;
    await pool.query('delete from conversation_messages where tenant_id = $1', [id]);
    await pool.query('delete from conversations where tenant_id = $1', [id]);
    await pool.query('delete from agents where tenant_id = $1', [id]);
    await pool.query('delete from messages where tenant_id = $1', [id]);
    await pool.query('delete from events where tenant_id = $1', [id]);
    await pool.query('delete from subscribers where tenant_id = $1', [id]);
  }
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('credential brakes (per IP)', () => {
  test('the 11th login attempt in a minute is a 429', async () => {
    await clearBrake('login');
    const attempt = () =>
      app.inject({
        method: 'POST',
        url: '/auth/login',
        payload: { email: `nobody-${suffix}@itest.local`, password: 'wrong-password' },
      });

    for (let i = 0; i < 10; i += 1) {
      // Wrong credentials: a 401 still spends budget — that is the point.
      expect((await attempt()).statusCode).toBe(401);
    }
    const over = await attempt();
    expect(over.statusCode).toBe(429);
    expect(json(over)).toEqual({ error: 'too many requests' });
  });

  test('the 4th signup in a minute is a 429 (and never reaches the handler)', async () => {
    await clearBrake('signup');
    // Invalid bodies: the brake runs BEFORE the handler, so no junk orgs are
    // created while still spending the budget.
    const attempt = () => app.inject({ method: 'POST', url: '/auth/signup', payload: {} });

    for (let i = 0; i < 3; i += 1) expect((await attempt()).statusCode).toBe(400);
    expect((await attempt()).statusCode).toBe(429);
  });

  test('budgets are per surface: a blown signup budget still allows login', async () => {
    await clearBrake('signup');
    await clearBrake('login');
    for (let i = 0; i < 4; i += 1) {
      await app.inject({ method: 'POST', url: '/auth/signup', payload: {} });
    }
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email: `nobody-${suffix}@itest.local`, password: 'wrong-password' },
    });
    expect(login.statusCode).toBe(401);
  });
});

describe('widget inbound turns', () => {
  test(`the ${SUBSCRIBER_TURNS_PER_MIN + 1}th turn from one subscriber in a minute is a 429`, async () => {
    await clearBrake('agent-msg');
    await clearTurnBudgets();
    const subscriberId = 'brake-flooder';
    const token = mintSubscriberToken(tenantId, subscriberId).token;
    const headers = { 'x-subscriber-token': token };

    for (let i = 0; i < SUBSCRIBER_TURNS_PER_MIN; i += 1) {
      const res = await sendTurn(subscriberId, i, headers);
      expect(res.statusCode).toBe(202);
    }

    const over = await sendTurn(subscriberId, SUBSCRIBER_TURNS_PER_MIN, headers);
    expect(over.statusCode).toBe(429);
    const body = json(over);
    expect(body.error).toBe('rate limited');
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.retryAfterSeconds).toBeLessThanOrEqual(60);
    expect(over.headers['retry-after']).toBe(String(body.retryAfterSeconds));
  });

  test('the budget is per subscriber: another customer is unaffected', async () => {
    // The flooder above is still over budget in this same minute.
    const flooder = await sendTurn('brake-flooder', 99, {
      'x-subscriber-token': mintSubscriberToken(tenantId, 'brake-flooder').token,
    });
    expect(flooder.statusCode).toBe(429);

    const other = await sendTurn('brake-bystander', 0, {
      'x-subscriber-token': mintSubscriberToken(tenantId, 'brake-bystander').token,
    });
    expect(other.statusCode).toBe(202);
  });

  test('the button-click route shares the same budget (no bypass door)', async () => {
    await clearTurnBudgets();
    const subscriberId = 'brake-clicker';
    const headers = { 'x-subscriber-token': mintSubscriberToken(tenantId, subscriberId).token };

    // Spend the whole budget through /messages...
    for (let i = 0; i < SUBSCRIBER_TURNS_PER_MIN; i += 1) {
      expect((await sendTurn(subscriberId, i, headers)).statusCode).toBe(202);
    }
    // ...then try the other door.
    const action = await app.inject({
      method: 'POST',
      url: `/v1/agents/${AGENT_ID}/actions`,
      headers,
      payload: { subscriberId, actionId: 'a1', label: 'Yes', actionEventId: 'brake-act-1' },
    });
    expect(action.statusCode).toBe(429);
    expect(json(action).error).toBe('rate limited');
  });

  test('an api-key caller (the tenant itself) is not bound by the per-customer budget', async () => {
    await clearBrake('agent-msg');
    await clearTurnBudgets();
    const subscriberId = 'brake-server-side';
    const headers = { 'x-api-key': apiKey };
    // Past the widget's allowance, through the tenant's own credential.
    for (let i = 0; i <= SUBSCRIBER_TURNS_PER_MIN; i += 1) {
      expect((await sendTurn(subscriberId, i, headers)).statusCode).toBe(202);
    }
  });

  test('an over-budget turn writes nothing: the refused text never enters the transcript', async () => {
    await clearBrake('agent-msg');
    await clearTurnBudgets();
    const subscriberId = 'brake-writer';
    const headers = { 'x-subscriber-token': mintSubscriberToken(tenantId, subscriberId).token };
    for (let i = 0; i < SUBSCRIBER_TURNS_PER_MIN; i += 1) {
      expect((await sendTurn(subscriberId, i, headers)).statusCode).toBe(202);
    }

    const res = await sendTurn(subscriberId, 12_345, headers);
    expect(res.statusCode).toBe(429);
    const { rows } = await pool.query(
      `select count(*)::int as n from conversation_messages
        where tenant_id = $1 and content = $2`,
      [tenantId, 'turn 12345'],
    );
    expect(rows[0].n).toBe(0);
  });
});

describe('subscriber tokens', () => {
  test('a TTL above the 6h ceiling is a 400 that names the limit', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/subscriber-tokens',
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId: 'ttl-probe', ttlSeconds: 86_400 },
    });
    expect(res.statusCode).toBe(400);
    expect(JSON.stringify(json(res))).toContain('21600');
  });

  test('the ceiling itself is accepted, and the default is one hour', async () => {
    const capped = await app.inject({
      method: 'POST',
      url: '/v1/subscriber-tokens',
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId: 'ttl-probe', ttlSeconds: 21_600 },
    });
    expect(capped.statusCode).toBe(200);

    const now = Math.floor(Date.now() / 1000);
    const dflt = await app.inject({
      method: 'POST',
      url: '/v1/subscriber-tokens',
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId: 'ttl-probe' },
    });
    expect(json(dflt).expiresAt - now).toBeLessThanOrEqual(3600);
    expect(json(dflt).expiresAt - now).toBeGreaterThan(3500);
  });

  test("another tenant's token is rejected on this tenant's inbox", async () => {
    // Minted for a subscriber id that exists in BOTH tenants' namespaces; only
    // the signing key differs, and that is what must decide.
    const foreign = mintSubscriberToken(otherTenantId, 'shared-id').token;
    const res = await app.inject({
      method: 'GET',
      url: '/v1/inbox/shared-id',
      headers: { 'x-subscriber-token': foreign },
    });
    // Accepted as tenant B's own token (200) — never as tenant A's data.
    expect(res.statusCode).toBe(200);
    expect(json(res).messages).toEqual([]);

    // Re-pointing that token's payload at tenant A invalidates its signature.
    const [head, sig] = foreign.split('.');
    const forged = Buffer.from(
      JSON.stringify({
        t: tenantId,
        s: 'shared-id',
        e: Math.floor(Date.now() / 1000) + 600,
      }),
    ).toString('base64url');
    expect(head.startsWith('nst_')).toBe(true);
    const attack = await app.inject({
      method: 'GET',
      url: '/v1/inbox/shared-id',
      headers: { 'x-subscriber-token': `nst_${forged}.${sig}` },
    });
    expect(attack.statusCode).toBe(401);
  });
});

describe('provider status webhook (per tenant)', () => {
  test("a callback signed with the tenant's derived key is accepted and carries the tenant", async () => {
    const providerMessageId = `pm-ok-${suffix}`;
    const res = await postProviderWebhook(tenantId, { providerMessageId, status: 'delivered' });
    expect(res.statusCode).toBe(200);

    const job = await getQueue(QUEUE.STATUS).getJob(
      statusJobId(tenantId, providerMessageId, 'delivered'),
    );
    expect(job).toBeTruthy();
    expect(job!.data.tenantId).toBe(tenantId);
  });

  test("another tenant's key is rejected with 401", async () => {
    const res = await postProviderWebhook(
      tenantId,
      { providerMessageId: `pm-forge-${suffix}`, status: 'bounced' },
      otherTenantId, // signed with the WRONG tenant's key
    );
    expect(res.statusCode).toBe(401);
    expect(json(res).error).toContain('signature mismatch');
  });

  test('the tenant-less legacy path is gone (404, never silently unscoped)', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/webhooks/providers/smtp',
      payload: { providerMessageId: 'x', status: 'bounced' },
    });
    expect(res.statusCode).toBe(404);
  });

  test('a replayed delivery is a no-op: the same jobId, one job', async () => {
    const providerMessageId = `pm-replay-${suffix}`;
    const body = { providerMessageId, status: 'complaint' as const };
    expect((await postProviderWebhook(tenantId, body)).statusCode).toBe(200);
    expect((await postProviderWebhook(tenantId, body)).statusCode).toBe(200);
    expect((await postProviderWebhook(tenantId, body)).statusCode).toBe(200);

    const jobs = await getQueue(QUEUE.STATUS).getJobs([
      'waiting',
      'prioritized',
      'delayed',
      'active',
      'completed',
      'failed',
    ]);
    const mine = jobs.filter((j) => j.data?.providerMessageId === providerMessageId);
    expect(mine).toHaveLength(1);
    expect(mine[0].id).toBe(statusJobId(tenantId, providerMessageId, 'complaint'));
  });

  test('the worker resolves the message SCOPED to the tenant', async () => {
    const providerMessageId = `pm-scope-${suffix}`;
    const sub = await upsertSubscriber(tenantId, { subscriberId: 'scope-target' });
    const event = await insertEvent({
      tenantId,
      transactionId: `scope-txn-${suffix}`,
      workflowKey: 'brake-scope',
      priority: 'p1',
      payload: {},
      recipients: [{ subscriberId: sub.external_id }],
    });
    const msg = await insertMessage({
      tenantId,
      eventId: event!.id,
      subscriberId: sub.id,
      transactionId: `scope-txn-${suffix}`,
      channel: 'email',
      stepIndex: 0,
      priority: 'p1',
      content: { body: 'hi', to: { email: 'scope@itest.local' } },
      status: 'sent',
    });
    await updateMessage(msg.id, { status: 'sent', provider: 'smtp', providerMessageId });

    // The OTHER tenant claiming this provider id finds nothing — the update is
    // scoped, so the row cannot be flipped to bounced from outside its tenant.
    await expect(
      runStatusJob({
        provider: 'smtp',
        tenantId: otherTenantId,
        providerMessageId,
        status: 'bounced',
      }),
    ).rejects.toThrow(/no message with provider_message_id/);
    let row = await pool.query('select status from messages where id = $1', [msg.id]);
    expect(row.rows[0].status).toBe('sent');

    // The owning tenant's callback applies normally.
    await runStatusJob({ provider: 'smtp', tenantId, providerMessageId, status: 'delivered' });
    row = await pool.query('select status from messages where id = $1', [msg.id]);
    expect(row.rows[0].status).toBe('delivered');
  });
});
