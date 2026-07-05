import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireUser, requireEnvAccess } from '../jwt-auth';
import {
  createApiKey,
  getEnvironment,
  listApiKeys,
  revokeApiKey,
} from '../../db/accounts.repo';

const CreateKeySchema = z.object({ name: z.string().min(1).max(255).default('default') });

/** Environment + API-key management for the dashboard (JWT-auth'd). */
export function registerAccountRoutes(app: FastifyInstance) {
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
      const revoked = await revokeApiKey(req.params.keyId, req.params.envId);
      return { revoked: revoked > 0 };
    },
  );
}
