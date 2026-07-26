/**
 * Phase 25 slice D — the WS gateway ADMIN plane. Boots the real gateway
 * (startGateway on an ephemeral port — the module's entrypoint guard means
 * importing it never binds :3001) and drives it with real dashboard JWTs minted
 * by an in-process signup, against the real Postgres + Redis.
 *
 * Covers: a valid JWT + own env connects and relays a published hint verbatim;
 * a garbage token and a valid-token-but-other-tenant's-env both close 4401; an
 * inbound frame on an admin socket is ignored (server->client only, socket stays
 * open); and the subscriber plane still works on the SAME server instance
 * (a widget-style apiKey socket connects alongside).
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { WebSocket } from 'ws';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { startGateway } from '../../src/ws/gateway';
import { emitTenantEvent, tenantEventsChannel } from '../../src/core/tenant-events';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';

let app: FastifyInstance;
let gateway: ReturnType<typeof startGateway>;
let port = 0;

// tenant A (the connecting user) and tenant B (a stranger's env)
let tokenA = '';
let envA = '';
let apiKeyA = '';
let envB = '';

const json = (res: { body: string }) => JSON.parse(res.body);
const openSockets = new Set<WebSocket>();

function connect(query: string): WebSocket {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?${query}`);
  openSockets.add(ws);
  ws.on('close', () => openSockets.delete(ws));
  return ws;
}

/** Resolve with the first parsed frame matching `pred` (skips others, e.g. queue.depths). */
function nextFrame(
  ws: WebSocket,
  pred: (f: Record<string, unknown>) => boolean,
  timeoutMs = 4000,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timeout waiting for frame'));
    }, timeoutMs);
    function onMsg(data: unknown) {
      let frame: Record<string, unknown>;
      try {
        frame = JSON.parse(String(data)) as Record<string, unknown>;
      } catch {
        return;
      }
      if (pred(frame)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(frame);
      }
    }
    ws.on('message', onMsg);
  });
}

/** Resolve with the first RAW message string matching `match` (for verbatim checks). */
function nextRaw(ws: WebSocket, match: (s: string) => boolean, timeoutMs = 4000): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('timeout waiting for raw'));
    }, timeoutMs);
    function onMsg(data: unknown) {
      const s = String(data);
      if (match(s)) {
        clearTimeout(timer);
        ws.off('message', onMsg);
        resolve(s);
      }
    }
    ws.on('message', onMsg);
  });
}

function nextClose(ws: WebSocket, timeoutMs = 4000): Promise<number> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout waiting for close')), timeoutMs);
    ws.on('close', (code: number) => {
      clearTimeout(timer);
      resolve(code);
    });
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function signup(tag: string) {
  const email = `${tag}-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: `${tag} IT`, email, password: 'integration-pw-1', organizationName: `${tag} Org` },
  });
  const body = json(res);
  const dev = body.environments.find((e: { name: string }) => e.name === 'Development');
  return { accessToken: body.accessToken as string, envId: dev.id as string, apiKey: dev.apiKey as string };
}

beforeAll(async () => {
  app = await buildApp();
  const a = await signup('wsA');
  const b = await signup('wsB');
  tokenA = a.accessToken;
  envA = a.envId;
  apiKeyA = a.apiKey;
  envB = b.envId;

  gateway = startGateway(0);
  await new Promise<void>((resolve) => {
    if (gateway.server.address()) return resolve();
    gateway.server.once('listening', () => resolve());
  });
  port = (gateway.server.address() as AddressInfo).port;
});

afterAll(async () => {
  for (const ws of openSockets) {
    try {
      ws.terminate();
    } catch {
      /* ignore */
    }
  }
  await gateway.stop();
  try {
    await pool.query('delete from subscribers where tenant_id = $1', [envA]);
  } catch {
    /* best-effort */
  }
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('admin plane', () => {
  test('a valid JWT + own env connects and relays a published hint verbatim', async () => {
    const ws = connect(`admin=1&token=${encodeURIComponent(tokenA)}&env=${encodeURIComponent(envA)}`);
    const connected = await nextFrame(ws, (f) => f.type === 'connected');
    expect(connected).toEqual({ type: 'connected', admin: true });

    // Publish a known envelope on the tenant channel; expect it relayed byte-for-byte.
    const raw = JSON.stringify({ type: 'message.changed', id: 'ws-verbatim-1', at: '2026-01-01T00:00:00.000Z' });
    const got = nextRaw(ws, (s) => s.includes('ws-verbatim-1'));
    await redis.publish(tenantEventsChannel(envA), raw);
    expect(await got).toBe(raw);

    ws.close();
  });

  test('a garbage token closes with 4401', async () => {
    const ws = connect(`admin=1&token=not-a-real-jwt&env=${encodeURIComponent(envA)}`);
    expect(await nextClose(ws)).toBe(4401);
  });

  test("a valid token but ANOTHER tenant's env closes with 4401", async () => {
    const ws = connect(`admin=1&token=${encodeURIComponent(tokenA)}&env=${encodeURIComponent(envB)}`);
    expect(await nextClose(ws)).toBe(4401);
  });

  test('an inbound frame on an admin socket is ignored — socket stays open, hints still flow', async () => {
    const ws = connect(`admin=1&token=${encodeURIComponent(tokenA)}&env=${encodeURIComponent(envA)}`);
    await nextFrame(ws, (f) => f.type === 'connected');

    // Server->client only: sending frames must be ignored, never crash the node.
    ws.send('garbage from a client');
    ws.send(JSON.stringify({ hello: 'world' }));
    await sleep(150);
    expect(ws.readyState).toBe(WebSocket.OPEN);

    // The socket is still healthy: a subsequent hint is still delivered.
    const got = nextFrame(ws, (f) => f.type === 'approval.changed');
    await emitTenantEvent(envA, 'approval.changed', 'ws-after-inbound');
    expect((await got).id).toBe('ws-after-inbound');

    ws.close();
  });
});

describe('subscriber plane regression (same server instance)', () => {
  test('a widget-style apiKey socket connects alongside a live admin socket', async () => {
    // An admin socket is live on this same gateway instance...
    const admin = connect(`admin=1&token=${encodeURIComponent(tokenA)}&env=${encodeURIComponent(envA)}`);
    await nextFrame(admin, (f) => f.type === 'connected');

    // ...and the unchanged subscriber path still works beside it.
    const widget = connect(`apiKey=${encodeURIComponent(apiKeyA)}&subscriberId=ws-widget-user`);
    const connected = await nextFrame(widget, (f) => f.type === 'connected');
    expect(connected.subscriberId).toBe('ws-widget-user');
    expect(connected).toHaveProperty('unreadCount');
    expect(typeof connected.unreadCount).toBe('number');
    expect(connected.admin).toBeUndefined(); // NOT an admin frame

    admin.close();
    widget.close();
  });
});
