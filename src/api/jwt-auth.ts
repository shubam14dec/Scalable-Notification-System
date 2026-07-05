import type { FastifyReply, FastifyRequest } from 'fastify';
import { getEnvironment, membershipRole } from '../db/accounts.repo';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { sub: string; type: 'access' | 'refresh' };
    user: { sub: string; type: 'access' | 'refresh' };
  }
}

declare module 'fastify' {
  interface FastifyRequest {
    userId: string;
  }
}

/**
 * Guard for dashboard/user routes: verifies the JWT access token and
 * attaches userId. Machine traffic keeps using x-api-key (authenticate) —
 * the two auth worlds never mix.
 */
export async function requireUser(req: FastifyRequest, reply: FastifyReply) {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: 'missing or invalid access token' });
  }
  if (req.user.type !== 'access') {
    return reply.code(401).send({ error: 'access token required (got refresh token)' });
  }
  req.userId = req.user.sub;
}

/**
 * Authorize the current user for an environment: the env must belong to an
 * organization the user is a member of. Returns the role, or replies 403.
 */
export async function requireEnvAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  envId: string,
): Promise<{ envId: string; role: string } | null> {
  const environment = await getEnvironment(envId);
  if (!environment?.organization_id) {
    reply.code(404).send({ error: 'unknown environment' });
    return null;
  }
  const role = await membershipRole(environment.organization_id, req.userId);
  if (!role) {
    reply.code(403).send({ error: 'not a member of this organization' });
    return null;
  }
  return { envId, role };
}
