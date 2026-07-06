import type { FastifyReply, FastifyRequest } from 'fastify';
import { getTenantByApiKey, type Tenant } from '../db/repositories';
import { getEnvironment, hashApiKey, membershipRole } from '../db/accounts.repo';

declare module 'fastify' {
  interface FastifyRequest {
    tenant: Tenant;
  }
}

// Tiny in-process cache (keyed by key HASH) so auth doesn't hit Postgres on
// every request. Revocation calls invalidateApiKeyCache so a revoked key
// dies instantly in this process; across replicas the TTL bounds it to 60s.
const cache = new Map<string, { tenant: Tenant; expiresAt: number }>();
const CACHE_TTL_MS = 60_000;

export function invalidateApiKeyCache(keyHash: string): void {
  cache.delete(keyHash);
}

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
    const keyHash = hashApiKey(apiKey);
    const cached = cache.get(keyHash);
    if (cached && cached.expiresAt > Date.now()) {
      req.tenant = cached.tenant;
      return;
    }
    const tenant = await getTenantByApiKey(apiKey);
    if (!tenant) {
      return reply.code(401).send({ error: 'invalid api key' });
    }
    cache.set(keyHash, { tenant, expiresAt: Date.now() + CACHE_TTL_MS });
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
