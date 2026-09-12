import type { FastifyReply, FastifyRequest } from 'fastify';
import { env } from '../config/env';
import { getEnvironment, getUserById, membershipRole } from '../db/accounts.repo';

declare module '@fastify/jwt' {
  /**
   * S1.7 added `jti` and `family` — both OPTIONAL, and both present only on
   * REFRESH tokens. Access tokens stay exactly what they were, `{ sub, type }`
   * and nothing else: they are checked by signature alone on every request, so
   * giving them a handle would mean a database lookup per request, which is the
   * one thing a stateless access token exists to avoid. Optional (rather than a
   * union of two payload shapes) because pre-S1.7 refresh tokens carry neither
   * and are still honoured — see the grandfathering note in routes/auth.ts.
   */
  interface FastifyJWT {
    payload: { sub: string; type: 'access' | 'refresh'; jti?: string; family?: string };
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
 * B1 — the deployment's human operator seat, normalized.
 *
 * THE ONLY reader of `env.operatorEmails`, which is what makes normalization a
 * property of the seat rather than a habit at each call site: the env parser
 * already trims and lowercases, but a test (or a future config surface) can
 * assign the array directly, and the two consequences of a stray capital —
 * an operator locked out of their own page, and a notification addressed to
 * `  OP@X.COM  ` — would both be miserable ways to find that out.
 */
export function operatorEmails(): string[] {
  return env.operatorEmails.map((candidate) => candidate.trim().toLowerCase()).filter(Boolean);
}

/** Is this address one of them? */
export function isOperatorEmail(email: string): boolean {
  return operatorEmails().includes(email.trim().toLowerCase());
}

/**
 * THE HUMAN OPERATOR GATE (B1) — not to be confused with `requireOperator` in
 * src/api/auth.ts, which is a different plane entirely:
 *
 *   requireOperator      MACHINE. An `x-operator-token` header matching
 *   (src/api/auth.ts)    OPS_ADMIN_TOKEN, for global ops WRITES a script or the
 *                        CLI performs (PUT /v1/ops/public-url). No user, no
 *                        session, no identity beyond possession of the secret.
 *
 *   requireOperatorUser  HUMAN. A signed-in dashboard account whose email is
 *   (here)               listed in OPERATOR_EMAILS. It gates screens a PERSON
 *                        uses — the Requests page and its approve/decline
 *                        buttons — and every action taken through it is
 *                        attributable to a named human being.
 *
 * They are deliberately not interchangeable in either direction: the machine
 * token must not open a human screen (it is a shared secret that lives in a
 * deploy file), and a dashboard session must not perform global ops writes (any
 * stranger can create one while signup is open). A route takes exactly one.
 *
 * Runs `requireUser` first and returns whatever it returned — on failure that
 * is the already-sent 401, which is the signal to stop; on success it is
 * undefined and `req.userId` is set.
 */
export async function requireOperatorUser(req: FastifyRequest, reply: FastifyReply) {
  const rejected = await requireUser(req, reply);
  if (rejected) return rejected;

  // The JWT carries only { sub, type } — never an email — so the address is
  // read from the row on every request. That is also what makes removing
  // someone from OPERATOR_EMAILS (or deleting their account) take effect on
  // their very next click, with no session to revoke.
  const user = await getUserById(req.userId);
  if (!user) return reply.code(401).send({ error: 'user no longer exists' });
  if (!isOperatorEmail(user.email)) {
    return reply.code(403).send({ error: 'operator access required' });
  }
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
