import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { requireUser, requireEnvAccess } from '../jwt-auth';
import { invalidateApiKeyCache } from '../auth';
import {
  createApiKey,
  getEnvironment,
  listApiKeys,
  membershipRole,
  organizationsForUser,
  renameOrganization,
  revokeApiKey,
} from '../../db/accounts.repo';

const CreateKeySchema = z.object({ name: z.string().min(1).max(255).default('default') });

/** U2 — the organization name. Trimmed BEFORE the length checks, so a body of
 *  spaces is the empty string it really is rather than a legal 3-char name. */
const RenameOrgSchema = z.object({ name: z.string().trim().min(1).max(120) });

/**
 * U2 — which organization is "mine" for a route that names no environment.
 *
 * The dashboard puts the selected environment on every request
 * (`x-environment-id`, see dashboard/src/lib/api.ts), and an environment
 * belongs to exactly one organization — so for a user who belongs to several,
 * the org they are LOOKING at is the one the header points to. Without the
 * header (a bare API client), a single membership is unambiguous and is used;
 * more than one is genuinely ambiguous and says so rather than guessing.
 *
 * Authorization is the same membership check `requireEnvAccess` makes, and the
 * role it returns is what the caller gates on — an environment id the user is
 * not a member of resolves to nothing, exactly as it does everywhere else.
 */
async function resolveCallerOrganization(
  req: FastifyRequest,
  reply: FastifyReply,
): Promise<{ orgId: string; role: string } | null> {
  const headerEnvId = req.headers['x-environment-id'];
  if (typeof headerEnvId === 'string' && headerEnvId) {
    const environment = await getEnvironment(headerEnvId);
    if (!environment?.organization_id) {
      reply.code(404).send({ error: 'unknown environment' });
      return null;
    }
    const role = await membershipRole(environment.organization_id, req.userId);
    if (!role) {
      reply.code(403).send({ error: 'not a member of this organization' });
      return null;
    }
    return { orgId: environment.organization_id, role };
  }

  const orgs = await organizationsForUser(req.userId);
  if (orgs.length === 0) {
    reply.code(403).send({ error: 'not a member of any organization' });
    return null;
  }
  if (orgs.length > 1) {
    reply.code(400).send({ error: 'send x-environment-id to say which organization' });
    return null;
  }
  return { orgId: orgs[0].id, role: orgs[0].role };
}

/** Environment + API-key management for the dashboard (JWT-auth'd). */
export function registerAccountRoutes(app: FastifyInstance) {
  /**
   * U2 — rename the caller's organization. The name is what the environment
   * switcher shows, and it is read straight off `organizations.name` by
   * /auth/me, so the next ['me'] fetch shows the new one everywhere with no
   * cache or schema of its own.
   */
  app.patch('/v1/account/organization', { preHandler: [requireUser] }, async (req, reply) => {
    const parsed = RenameOrgSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'name must be 1-120 characters' });
    }
    const caller = await resolveCallerOrganization(req, reply);
    if (!caller) return;
    // Same gate as revoking an API key: renaming is an org-wide change every
    // member sees, so it belongs to the people who run the org, not everyone in it.
    if (!['owner', 'admin'].includes(caller.role)) {
      return reply.code(403).send({ error: 'only an owner or admin can rename the organization' });
    }
    const organization = await renameOrganization(caller.orgId, parsed.data.name);
    if (!organization) return reply.code(404).send({ error: 'unknown organization' });
    return { organization: { id: organization.id, name: organization.name } };
  });

  app.get<{ Params: { envId: string } }>(
    '/v1/account/environments/:envId/api-keys',
    { preHandler: [requireUser] },
    async (req, reply) => {
      const access = await requireEnvAccess(req, reply, req.params.envId);
      if (!access) return;
      const keys = await listApiKeys(req.params.envId);
      return {
        apiKeys: keys.map((k) => ({
          id: k.id,
          name: k.name,
          prefix: `${k.key_prefix}...`,
          createdAt: k.created_at,
          revokedAt: k.revoked_at,
        })),
      };
    },
  );

  app.post<{ Params: { envId: string } }>(
    '/v1/account/environments/:envId/api-keys',
    { preHandler: [requireUser] },
    async (req, reply) => {
      const access = await requireEnvAccess(req, reply, req.params.envId);
      if (!access) return;
      const parsed = CreateKeySchema.safeParse(req.body ?? {});
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body' });
      }
      const environment = await getEnvironment(req.params.envId);
      const key = await createApiKey(
        req.params.envId,
        parsed.data.name,
        environment?.name ?? '',
        req.userId,
      );
      return reply.code(201).send({
        id: key.row.id,
        name: key.row.name,
        apiKey: key.plaintext, // shown once
      });
    },
  );

  app.delete<{ Params: { envId: string; keyId: string } }>(
    '/v1/account/environments/:envId/api-keys/:keyId',
    { preHandler: [requireUser] },
    async (req, reply) => {
      const access = await requireEnvAccess(req, reply, req.params.envId);
      if (!access) return;
      if (!['owner', 'admin'].includes(access.role)) {
        return reply.code(403).send({ error: 'owner or admin role required' });
      }
      const revokedHash = await revokeApiKey(req.params.keyId, req.params.envId);
      if (revokedHash) invalidateApiKeyCache(revokedHash);
      return { revoked: revokedHash !== null };
    },
  );
}
