import type { FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
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

/** Constant-time secret comparison; length is checked first (timingSafeEqual throws on a mismatch). */
function secretsMatch(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

/**
 * Operator plane auth — for routes whose write is GLOBAL, not per-tenant.
 *
 * WHY this exists: PUT /v1/ops/public-url writes ONE value shared by every
 * tenant (redis `config:public-url`), so guarding it with `authenticate` meant
 * any signed-up tenant's api key could repoint every other tenant's webhooks
 * and tracking pixels at a host they control. Signup is open, so that was a
 * platform-takeover primitive, not a tenant-scoped privilege.
 *
 * In production the ONLY accepted credential is the `x-operator-token` header
 * matching `OPS_ADMIN_TOKEN` — a tenant api key or a dashboard JWT is not
 * enough, no matter how privileged its holder is inside their own org.
 *
 * Outside production it falls through to ordinary tenant auth, so the
 * `asyncify dev` CLI keeps publishing tunnel URLs locally with nothing extra
 * configured. Both NODE_ENV and the token are read at REQUEST time (not from
 * the module-load `env` snapshot) so a test can exercise the production branch
 * by flipping process.env.
 */
export async function requireOperator(req: FastifyRequest, reply: FastifyReply) {
  if (process.env.NODE_ENV !== 'production') {
    return authenticate(req, reply);
  }

  const expected = process.env.OPS_ADMIN_TOKEN ?? '';
  const provided = req.headers['x-operator-token'];
  if (
    expected.length === 0 ||
    typeof provided !== 'string' ||
    !secretsMatch(provided, expected)
  ) {
    return reply.code(401).send({ error: 'operator token required' });
  }
}
