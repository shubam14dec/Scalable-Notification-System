import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { pool } from '../../db/pool';
import { upsertSubscriber } from '../../db/repositories';
import {
  deleteDeviceToken,
  listDeviceTokens,
  upsertDeviceToken,
} from '../../db/device-tokens.repo';

/**
 * Phase 20: device registration (api-key side). POST/GET/DELETE
 * /v1/subscribers/:subscriberId/devices — the backend path; the subscriber's
 * own browser/app uses the /v1/me/devices twins in me.ts instead.
 */

const RegisterSchema = z.object({
  token: z.string().min(1).max(4096),
  platform: z.enum(['web', 'android', 'ios']).optional(),
});

const RemoveSchema = z.object({ token: z.string().min(1).max(4096) });

/**
 * External id → row id WITHOUT create: read paths (GET/DELETE) treat an
 * unknown subscriber as "no devices" rather than materializing an empty row.
 * The get-or-create path (POST) uses upsertSubscriber instead.
 */
async function resolveSubscriberRowId(
  tenantId: string,
  externalId: string,
): Promise<string | null> {
  const { rows } = await pool.query(
    'select id from subscribers where tenant_id = $1 and external_id = $2',
    [tenantId, externalId],
  );
  return rows[0]?.id ?? null;
}

export function registerDeviceRoutes(app: FastifyInstance) {
  app.post<{ Params: { subscriberId: string } }>(
    '/v1/subscribers/:subscriberId/devices',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = RegisterSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      const sub = await upsertSubscriber(req.tenant.id, { subscriberId: req.params.subscriberId });
      const device = await upsertDeviceToken(
        req.tenant.id,
        sub.id,
        parsed.data.token,
        parsed.data.platform,
      );
      reply.code(201);
      return { deviceId: device.id, platform: device.platform };
    },
  );

  app.get<{ Params: { subscriberId: string } }>(
    '/v1/subscribers/:subscriberId/devices',
    { preHandler: [authenticate] },
    async (req) => {
      const rowId = await resolveSubscriberRowId(req.tenant.id, req.params.subscriberId);
      if (!rowId) return { devices: [] };
      const devices = await listDeviceTokens(req.tenant.id, rowId);
      return {
        devices: devices.map((d) => ({
          id: d.id,
          token: d.token,
          platform: d.platform,
          createdAt: d.created_at,
          lastSeenAt: d.last_seen_at,
        })),
      };
    },
  );

  app.delete<{ Params: { subscriberId: string } }>(
    '/v1/subscribers/:subscriberId/devices',
    { preHandler: [authenticate] },
    async (req, reply) => {
      const parsed = RemoveSchema.safeParse(req.body);
      if (!parsed.success) {
        return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
      }
      // Scope the delete to the named subscriber: a token owned by a different
      // subscriber (or none) returns { deleted: false } rather than deleting.
      const rowId = await resolveSubscriberRowId(req.tenant.id, req.params.subscriberId);
      if (!rowId) return { deleted: false };
      const owned = await listDeviceTokens(req.tenant.id, rowId);
      if (!owned.some((d) => d.token === parsed.data.token)) return { deleted: false };
      const deleted = await deleteDeviceToken(req.tenant.id, parsed.data.token);
      return { deleted };
    },
  );
}
