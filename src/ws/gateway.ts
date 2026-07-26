import { createServer } from 'node:http';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { env } from '../config/env';
import { logger } from '../shared/logger';
import { createRedis, redis } from '../shared/redis';
import { pool } from '../db/pool';
import { getTenantByApiKey, unreadCount, type Tenant } from '../db/repositories';
import { isOrgMemberForEnvironment } from '../db/accounts.repo';
import { verifySubscriberToken } from '../auth/subscriber-token';
import { inAppPubSubChannel } from '../providers/inapp';
import { tenantEventsChannel } from '../core/tenant-events';
import { queueDepths } from '../shared/queues';

/**
 * WebSocket gateway. Two planes on one port (:3001):
 *
 *  - END-USER plane (subscriber tokens): per-subscriber Redis channels carry
 *    inbox pushes to the widget. Byte-identical to before Phase 25.
 *  - ADMIN plane (Phase 25, dashboard JWT + env id): a per-tenant hint channel
 *    (`tenant-events:<envId>`) carries tiny invalidation hints to the dashboard
 *    (server->client only). See src/core/tenant-events.ts for the hint doctrine.
 *
 * Scaling model — run any number of these behind a load balancer:
 *  - The gateway is STATELESS: no message ever lives only here. The inbox
 *    row in Postgres is the durable copy; the gateway is purely a live-push
 *    accelerator. A crashed node loses connections, never notifications —
 *    clients reconnect (to any node) and re-fetch via REST.
 *  - Delivery workers PUBLISH to one Redis pub/sub channel per subscriber;
 *    write sites PUBLISH tenant hints to one channel per tenant. Each node
 *    SUBSCRIBEs only to channels it has a live socket for, so Redis fan-out
 *    work scales with connected clients per node, not with total traffic.
 *  - Heartbeat ping/pong reaps dead connections so subscriptions don't leak.
 */

interface AuthedSocket extends WebSocket {
  isAlive: boolean;
  channel: string;
}

// channel -> sockets on THIS node subscribed to it
const sockets = new Map<string, Set<AuthedSocket>>();

// Admin sockets on THIS node (across all tenant channels) — tracked separately
// so the queue.depths sampler runs once per node while >=1 admin is watching.
const adminSockets = new Set<AuthedSocket>();

// Dedicated connection: a Redis connection in subscriber mode can't run
// regular commands, so pub/sub gets its own client.
const subClient = createRedis();

subClient.on('messageBuffer', (channelBuf: Buffer, messageBuf: Buffer) => {
  const set = sockets.get(channelBuf.toString());
  if (!set) return;
  const payload = messageBuf.toString();
  for (const ws of set) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
});

// Small tenant cache so a reconnect storm doesn't hammer Postgres.
const tenantCache = new Map<string, { tenant: Tenant | null; expiresAt: number }>();
async function tenantFor(apiKey: string): Promise<Tenant | null> {
  const hit = tenantCache.get(apiKey);
  if (hit && hit.expiresAt > Date.now()) return hit.tenant;
  const tenant = await getTenantByApiKey(apiKey);
  tenantCache.set(apiKey, { tenant, expiresAt: Date.now() + 60_000 });
  return tenant;
}

async function attach(ws: AuthedSocket, channel: string): Promise<void> {
  let set = sockets.get(channel);
  if (!set) {
    set = new Set();
    sockets.set(channel, set);
    await subClient.subscribe(channel);
  }
  set.add(ws);
  ws.channel = channel;
}

async function detach(ws: AuthedSocket): Promise<void> {
  const set = sockets.get(ws.channel);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) {
    sockets.delete(ws.channel);
    await subClient.unsubscribe(ws.channel).catch(() => undefined);
  }
}

// ---------- admin plane (Phase 25) ----------

/**
 * Verify a dashboard access JWT the SAME way the API does. @fastify/jwt
 * (src/api/app.ts) registers `{ secret: env.jwtSecret }`; the auth route signs
 * `{ sub, type: 'access' }` as HS256 (fast-jwt's default for a string secret).
 * The gateway must NOT import fastify, so we verify the HS256 signature + `exp`
 * with node crypto and return the claims. Returns null on ANY failure (bad
 * shape, wrong signature, wrong alg, expired). Signature check is constant-time.
 */
function verifyAccessToken(token: string): { sub: string; type: string } | null {
  const parts = token.split('.');
  if (parts.length !== 3) return null;
  const [headerB64, payloadB64, sigB64] = parts;

  const expected = createHmac('sha256', env.jwtSecret)
    .update(`${headerB64}.${payloadB64}`)
    .digest();
  const provided = Buffer.from(sigB64, 'base64url');
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let header: { alg?: string };
  let payload: { sub?: unknown; type?: unknown; exp?: unknown };
  try {
    header = JSON.parse(Buffer.from(headerB64, 'base64url').toString('utf8'));
    payload = JSON.parse(Buffer.from(payloadB64, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  if (header.alg !== 'HS256') return null;
  if (typeof payload.exp === 'number' && payload.exp * 1000 <= Date.now()) return null;
  if (typeof payload.sub !== 'string' || typeof payload.type !== 'string') return null;
  return { sub: payload.sub, type: payload.type };
}

// queue.depths sampler: one interval per node while >=1 admin is connected.
// Pushes ONLY when the counts differ from the last push. queueDepths() walks a
// fixed queue list and getJobCounts returns keys in a fixed order, so its
// JSON serialization is canonical — string compare here IS a deep-equal.
let depthsTimer: ReturnType<typeof setInterval> | null = null;
let lastDepths: string | null = null;
const DEPTHS_INTERVAL_MS = 5_000;

async function sampleDepths(): Promise<void> {
  let counts: Awaited<ReturnType<typeof queueDepths>>;
  try {
    counts = await queueDepths();
  } catch (err) {
    logger.warn({ err }, 'queue.depths sample failed');
    return;
  }
  const serialized = JSON.stringify(counts);
  if (serialized === lastDepths) return; // unchanged -> stay silent
  lastDepths = serialized;
  const payload = JSON.stringify({ type: 'queue.depths', counts, at: new Date().toISOString() });
  for (const ws of adminSockets) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

function startDepthsTimer(): void {
  if (depthsTimer) return;
  lastDepths = null; // force a push on the first sample after 0->1
  void sampleDepths(); // push once immediately on connect
  depthsTimer = setInterval(() => void sampleDepths(), DEPTHS_INTERVAL_MS);
}

function stopDepthsTimer(): void {
  if (depthsTimer) {
    clearInterval(depthsTimer);
    depthsTimer = null;
  }
  lastDepths = null;
}

async function attachAdmin(ws: AuthedSocket, channel: string): Promise<void> {
  await attach(ws, channel); // refcounted redis subscribe (shared with subscriber plane)
  adminSockets.add(ws);
  if (adminSockets.size === 1) startDepthsTimer(); // 0 -> 1
}

async function detachAdmin(ws: AuthedSocket): Promise<void> {
  if (!adminSockets.delete(ws)) return;
  await detach(ws);
  if (adminSockets.size === 0) stopDepthsTimer(); // 1 -> 0
}

/**
 * Admin connect: `?admin=1&token=<dashboard JWT>&env=<envId>`. Verify the JWT
 * (HS256, same secret as the API), require type='access', then ONE indexed
 * query proving `sub` is a member of the org owning `env`. Success -> subscribe
 * the socket to `tenant-events:<envId>` (relayed verbatim). Any failure -> 4401.
 * Inbound frames are ignored (server->client only). Returns true if it handled
 * the connection as an admin attempt (success OR rejection).
 */
async function handleAdmin(ws: AuthedSocket, url: URL): Promise<boolean> {
  if (url.searchParams.get('admin') !== '1') return false;

  const token = url.searchParams.get('token');
  const envId = url.searchParams.get('env');
  if (!token || !envId) {
    ws.close(4401, 'admin token and env required');
    return true;
  }
  const claims = verifyAccessToken(token);
  if (!claims || claims.type !== 'access') {
    ws.close(4401, 'invalid admin token');
    return true;
  }
  if (!(await isOrgMemberForEnvironment(envId, claims.sub))) {
    ws.close(4401, 'not a member of this environment');
    return true;
  }

  await attachAdmin(ws, tenantEventsChannel(envId));
  ws.isAlive = true;
  ws.on('pong', () => {
    ws.isAlive = true;
  });
  // Server->client only: never process anything an admin socket sends.
  ws.on('message', () => logger.warn('ignoring inbound frame on admin socket'));
  ws.on('close', () => void detachAdmin(ws));
  ws.on('error', (err) => logger.warn({ err }, 'admin socket error'));
  ws.send(JSON.stringify({ type: 'connected', admin: true }));
  return true;
}

export function startGateway(port: number = env.wsPort) {
  const server = createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', connections: wss.clients.size }));
      return;
    }
    res.writeHead(404).end();
  });

  const wss = new WebSocketServer({ server, maxPayload: 64 * 1024 });

  wss.on('connection', (socket, req) => {
    void (async () => {
      const ws = socket as AuthedSocket;
      const url = new URL(req.url ?? '/', 'ws://localhost');

      // Admin plane (dashboard) takes priority when ?admin=1 is present.
      if (await handleAdmin(ws, url)) return;

      // Preferred: short-lived subscriber token (browser-safe, minted by
      // the customer's backend). Fallback: apiKey + subscriberId, for
      // server-side/dev connections only — never ship an api key to a browser.
      let tenantId: string;
      let subscriberId: string;

      const token = url.searchParams.get('token');
      if (token) {
        const payload = verifySubscriberToken(token);
        if (!payload) {
          ws.close(4401, 'invalid or expired subscriber token');
          return;
        }
        tenantId = payload.tenantId;
        subscriberId = payload.subscriberId;
      } else {
        const apiKey = url.searchParams.get('apiKey');
        const sub = url.searchParams.get('subscriberId');
        if (!apiKey || !sub) {
          ws.close(4400, 'token, or apiKey and subscriberId query params required');
          return;
        }
        const tenant = await tenantFor(apiKey);
        if (!tenant) {
          ws.close(4401, 'invalid api key');
          return;
        }
        tenantId = tenant.id;
        subscriberId = sub;
      }

      await attach(ws, inAppPubSubChannel(tenantId, subscriberId));

      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('close', () => void detach(ws));
      ws.on('error', (err) => logger.warn({ err }, 'socket error'));

      const unread = await unreadCount(tenantId, subscriberId);
      ws.send(JSON.stringify({ type: 'connected', subscriberId, unreadCount: unread }));
    })().catch((err) => {
      logger.error({ err }, 'connection setup failed');
      socket.close(1011, 'internal error');
    });
  });

  // Reap dead connections every 30s so channel subscriptions don't leak.
  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      const ws = client as AuthedSocket;
      if (!ws.isAlive) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, 30_000);

  server.listen(port, () => {
    logger.info({ port }, 'ws gateway listening');
  });

  const stop = async (): Promise<void> => {
    clearInterval(heartbeat);
    stopDepthsTimer();
    for (const client of wss.clients) client.close(1001, 'server shutting down');
    wss.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };

  return { server, wss, stop };
}

function main() {
  const { stop } = startGateway();
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'ws gateway shutting down');
    await stop();
    await subClient.quit();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

// Auto-start only when run as the entrypoint (`tsx src/ws/gateway.ts`); importing
// this module (tests, the proof script) gets startGateway without binding :3001.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
