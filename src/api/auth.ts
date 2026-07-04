import type { FastifyReply, FastifyRequest } from 'fastify';
import { getTenantByApiKey, type Tenant } from '../db/repositories';

declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant;
  }
}

// Tiny in-process cache so auth doesn't hit Postgres on every request.
const cache = new Map<string, { tenant: Tenant; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey !== 'string' || apiKey.length === 0) {
    return reply.code(401).send({ error: 'missing x-api-key header' });
  }

  const cached = cache.get(apiKey);
  if (cached && cached.expiresAt > Date.now()) {
    req.tenant = cached.tenant;
    return;
  }

  const tenant = await getTenantByApiKey(apiKey);
  if (!tenant) {
    return reply.code(401).send({ error: 'invalid api key' });
  }
  cache.set(apiKey, { tenant, expiresAt: Date.now() + CACHE_TTL_MS });
  req.tenant = tenant;
}
