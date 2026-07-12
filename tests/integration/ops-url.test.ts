/**
 * Runtime public-URL rotation (Phase 16): PUT/GET /v1/ops/public-url plus the
 * drill-elimination guarantee — rotating the base URL makes every webhook URL
 * (telegram + email) recompute on the new base with NO restart, because all
 * consumers read config/public-url.getPublicUrl() live. Everything here runs
 * the production path (buildApp + app.inject); a stub stands in for
 * api.telegram.org (TELEGRAM_API_BASE) and the real @asyncify-hq/agent SDK is
 * the bridge.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { env } from '../../src/config/env';
import { getPublicUrl, clearPublicUrlCache } from '../../src/config/public-url';
import { createHandler, defineAgent } from '../../packages/agent/src/index';

const PUBLIC_URL_KEY = 'config:public-url';

let app: FastifyInstance;
let apiKey = '';
const bridges: Server[] = [];

const json = (res: { body: string }) => JSON.parse(res.body);
const headers = () => ({ 'x-api-key': apiKey });

/** A BotFather-shaped token whose numeric prefix IS the bot id. */
function tok(botId: number): string {
  return `${botId}:AA${'testtoken0123456789ABCDEFGHIJKLM'}`;
}

// ---- Telegram stub: identity derived from the token, every call recorded ----
let tgStub: Server;
interface TgCall {
  method: string;
  body: Record<string, unknown>;
}
const tgCalls: TgCall[] = [];
const setWebhooks = () => tgCalls.filter((c) => c.method === 'setWebhook');

function startTelegramStub(): Promise<void> {
  tgStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const m = /^\/bot(.+)\/([^/]+)$/.exec(String(req.url));
      const token = m?.[1] ?? '';
      const method = m?.[2] ?? '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const botId = Number(token.split(':')[0]);
      const results: Record<string, unknown> = {
        getMe: { id: botId, is_bot: true, username: `bot${botId}` },
        setWebhook: true,
        deleteWebhook: true,
        getWebhookInfo: { url: 'https://example.test/hook', pending_update_count: 0 },
      };
      tgCalls.push({ method, body });
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          ok: method in results,
          result: results[method],
          description: method in results ? undefined : 'unknown method',
        }),
      );
    });
  });
  return new Promise((r) => tgStub.listen(0, () => r()));
}

const brain = defineAgent({ onMessage: (ctx) => `reply to: ${ctx.message.text}` });

/** Create a bridge agent (its listening server is patched with the real secret). */
async function createAgent(identifier: string): Promise<void> {
  const holder = { secret: 'placeholder-until-created' };
  const server = createServer((req, res) =>
    createHandler(brain, { signingSecret: holder.secret })(req, res),
  );
  await new Promise<void>((r) => server.listen(0, r));
  bridges.push(server);
  const url = `http://localhost:${(server.address() as AddressInfo).port}/`;
  const created = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: headers(),
    payload: { identifier, name: identifier, bridgeUrl: url },
  });
  expect(created.statusCode).toBe(201);
  holder.secret = json(created).signingSecret;
}

async function connectTelegram(agentIdentifier: string, botId: number): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/connections/telegram',
    headers: headers(),
    payload: { botToken: tok(botId), agentIdentifier },
  });
  expect(res.statusCode).toBe(201);
  return String(json(res).webhookUrl ?? '').split('/').pop() ?? '';
}

async function connectEmail(agentIdentifier: string, address: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/connections/email',
    headers: headers(),
    payload: { address, agentIdentifier },
  });
  expect(res.statusCode).toBe(201);
  return /\/webhooks\/email\/([0-9a-f-]{36})/.exec(String(json(res).webhookUrl))?.[1] ?? '';
}

// R1 HYGIENE: a leaked config:public-url key silently breaks the expectedUrl
// assertions in the telegram/connections suites, so both hooks scrub it.
async function scrub(): Promise<void> {
  await redis.del(PUBLIC_URL_KEY);
  clearPublicUrlCache();
}

beforeAll(async () => {
  await startTelegramStub();
  process.env.TELEGRAM_API_BASE = `http://localhost:${(tgStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `ops-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Ops IT', email, password: 'integration-pw-1', organizationName: 'Ops IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;

  await scrub();
});

afterAll(async () => {
  delete process.env.TELEGRAM_API_BASE;
  await scrub();
  tgStub?.close();
  for (const b of bridges) b.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('1. auth', () => {
  test('GET and PUT both require authentication', async () => {
    const get = await app.inject({ method: 'GET', url: '/v1/ops/public-url' });
    expect(get.statusCode).toBe(401);
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/ops/public-url',
      payload: { url: 'https://x.test' },
    });
    expect(put.statusCode).toBe(401);
  });
});

describe('2. PUT validation', () => {
  async function put(url: string) {
    return app.inject({ method: 'PUT', url: '/v1/ops/public-url', headers: headers(), payload: { url } });
  }

  test('rejects non-http(s), pathful, query, fragment, and unparseable URLs', async () => {
    expect(json(await put('ftp://x.test')).error).toBe('url must be http or https');
    expect(json(await put('https://x.test/path')).error).toBe('url must not contain a path');
    expect(json(await put('https://x.test?q=1')).error).toBe('url must not contain a query string');
    expect(json(await put('https://x.test#frag')).error).toBe('url must not contain a fragment');
    expect(json(await put('not a url')).error).toBe('invalid url');

    for (const bad of ['ftp://x.test', 'https://x.test/path', 'not a url']) {
      expect((await put(bad)).statusCode).toBe(400);
    }
  });
});

describe('3. PUT + GET round-trip', () => {
  test('trailing slash is normalized on store and read back as source=runtime', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/ops/public-url',
      headers: headers(),
      payload: { url: 'https://new-base.example.test/' },
    });
    expect(put.statusCode).toBe(200);
    expect(json(put).url).toBe('https://new-base.example.test');

    const get = await app.inject({ method: 'GET', url: '/v1/ops/public-url', headers: headers() });
    expect(json(get)).toEqual({ url: 'https://new-base.example.test', source: 'runtime' });
  });
});

describe('4. env fallback', () => {
  test('with no runtime key, GET reports the env PUBLIC_URL and source=env', async () => {
    await scrub();
    const get = await app.inject({ method: 'GET', url: '/v1/ops/public-url', headers: headers() });
    expect(json(get)).toEqual({ url: env.publicUrl, source: 'env' });
  });
});

describe('5. drill elimination — rotation reaches every webhook with no restart', () => {
  test('after PUT, connection listing + telegram reconnect both use the new base', async () => {
    await scrub();
    await createAgent('ops-agent');
    const tgId = await connectTelegram('ops-agent', 91_000);
    const emId = await connectEmail('ops-agent', 'ops5@inbound.postmarkapp.com');

    const NEW_BASE = 'https://drill.example.test';
    const put = await app.inject({
      method: 'PUT',
      url: '/v1/ops/public-url',
      headers: headers(),
      payload: { url: NEW_BASE },
    });
    expect(put.statusCode).toBe(200);
    // PUT is write-through in-process — no cache wait needed.

    // (a) The live connection listing now reports both webhooks on the new base.
    const list = json(
      await app.inject({ method: 'GET', url: '/v1/connections', headers: headers() }),
    );
    const tgRow = list.connections.find((c: { id: string }) => c.id === tgId);
    expect(tgRow.webhook.expectedUrl).toBe(`${NEW_BASE}/webhooks/telegram/${tgId}`);
    const emRow = list.connections.find((c: { id: string }) => c.id === emId);
    expect(String(emRow.webhook.url).startsWith(`${NEW_BASE}/webhooks/email/${emId}`)).toBe(true);

    // (b) Reconnect drives Telegram setWebhook with a URL on the new base.
    const before = setWebhooks().length;
    const re = await app.inject({
      method: 'POST',
      url: `/v1/connections/${tgId}/reconnect`,
      headers: headers(),
    });
    expect(re.statusCode).toBe(200);
    expect(String(json(re).webhookUrl).startsWith(NEW_BASE)).toBe(true);
    const newSetWebhooks = setWebhooks().slice(before);
    expect(newSetWebhooks.length).toBe(1);
    expect(String(newSetWebhooks[0].body.url)).toBe(`${NEW_BASE}/webhooks/telegram/${tgId}`);
  });
});

describe('6. worker-side getPublicUrl', () => {
  test('a direct redis write (after clearing the cache) is what getPublicUrl serves; DEL falls back to env', async () => {
    await redis.set(PUBLIC_URL_KEY, 'https://direct.example.test');
    clearPublicUrlCache();
    expect(await getPublicUrl()).toBe('https://direct.example.test');

    await redis.del(PUBLIC_URL_KEY);
    clearPublicUrlCache();
    expect(await getPublicUrl()).toBe(env.publicUrl);
  });
});
