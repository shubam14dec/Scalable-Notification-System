import { createServer } from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { env } from '../config/env';
import { logger } from '../shared/logger';
import { createRedis, redis } from '../shared/redis';
import { pool } from '../db/pool';
import { getTenantByApiKey, unreadCount, type Tenant } from '../db/repositories';
import { inAppPubSubChannel } from '../providers/inapp';

/**
 * WebSocket gateway for the in-app channel.
 *
 * Scaling model — run any number of these behind a load balancer:
 *  - The gateway is STATELESS: no message ever lives only here. The inbox
 *    row in Postgres is the durable copy; the gateway is purely a live-push
 *    accelerator. A crashed node loses connections, never notifications —
 *    clients reconnect (to any node) and re-fetch the inbox via REST.
 *  - Delivery workers PUBLISH to one Redis pub/sub channel per subscriber.
 *    Each node SUBSCRIBEs only to channels for subscribers connected to it,
 *    so Redis fan-out work scales with connected users per node, not with
 *    total traffic. Redis pub/sub handles millions of channels comfortably.
 *  - Heartbeat ping/pong reaps dead connections so subscriptions don't leak.
 */

interface AuthedSocket extends WebSocket {
  isAlive: boolean;
  channel: string;
}

// channel -> sockets on THIS node subscribed to it
const sockets = new Map<string, Set<AuthedSocket>>();

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

function main() {
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
      const apiKey = url.searchParams.get('apiKey');
      const subscriberId = url.searchParams.get('subscriberId');

      // Production note: replace the raw api key with a short-lived signed
      // token minted by your backend — api keys should not reach browsers.
      if (!apiKey || !subscriberId) {
        ws.close(4400, 'apiKey and subscriberId query params required');
        return;
      }
      const tenant = await tenantFor(apiKey);
      if (!tenant) {
        ws.close(4401, 'invalid api key');
        return;
      }

      await attach(ws, inAppPubSubChannel(tenant.id, subscriberId));

      ws.isAlive = true;
      ws.on('pong', () => {
        ws.isAlive = true;
      });
      ws.on('close', () => void detach(ws));
      ws.on('error', (err) => logger.warn({ err }, 'socket error'));

      const unread = await unreadCount(tenant.id, subscriberId);
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

  server.listen(env.wsPort, () => {
    logger.info({ port: env.wsPort }, 'ws gateway listening');
  });

  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'ws gateway shutting down');
    clearInterval(heartbeat);
    for (const client of wss.clients) client.close(1001, 'server shutting down');
    wss.close();
    server.close();
    await subClient.quit();
    await redis.quit();
    await pool.end();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main();
