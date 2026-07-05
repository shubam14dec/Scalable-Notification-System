import type { FastifyReply, FastifyRequest } from 'fastify';
import { getTenantByApiKey, type Tenant } from '../db/repositories';
import { getEnvironment, membershipRole } from '../db/accounts.repo';

declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant;
  }
}

// Tiny in-process cache so auth doesn't hit Postgres on every request.
const cache = new Map<string, { tenant: Tenant; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

/**
 * Environment auth, two ways in:
 *  - machines: `x-api-key` (hashed lookup)
 *  - dashboard users: `Authorization: Bearer <jwt>` + `x-environment-id`,
 *    authorized through org membership.
 * Both end with req.tenant = the environment; downstream code can't tell
 * the difference and doesn't need to.
 */
export async function authenticate(req: FastifyRequest, reply: FastifyReply) {
  const apiKey = req.headers['x-api-key'];
  if (typeof apiKey === 'string' && apiKey.length > 0) {
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
    return;
  }

  const envId = req.headers['x-environment-id'];
  if (req.headers.authorization?.startsWith('Bearer ') && typeof envId === 'string') {
    try {
      await req.jwtVerify();
    } catch {
      return reply.code(401).send({ error: 'invalid access token' });
    }
    if (req.user.type !== 'access') {
      return reply.code(401).send({ error: 'access token required' });
    }
    const environment = await getEnvironment(envId);
    if (!environment?.organization_id) {
      return reply.code(404).send({ error: 'unknown environment' });
    }
    const role = await membershipRole(environment.organization_id, req.user.sub);
    if (!role) {
      return reply.code(403).send({ error: 'not a member of this organization' });
    }
    req.tenant = environment;
    return;
  }

  return reply
    .code(401)
    .send({ error: 'provide x-api-key, or a Bearer token with x-environment-id' });
}
