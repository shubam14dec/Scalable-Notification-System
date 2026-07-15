import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../auth';
import { getTenantSetting, putTenantSetting } from '../../db/tenant-settings.repo';
import { getConnection } from '../../db/conversations.repo';
import { listChannelIdentities } from '../../db/identities.repo';

/**
 * Tenant-level settings (Phase 19). Slice A owns the approvals config: which
 * slack/telegram connections (and slack channel) carry the human-in-the-loop
 * approval cards. Stored under tenant_settings key 'approvals' as
 * {slackConnectionId, slackChannelId, telegramConnectionId}.
 *
 * The subscriber with external_id 'approvals' is the shared approver identity —
 * its linked telegram channel identities are the humans a telegram card can
 * reach, surfaced here as telegramApproverCount so the dashboard can warn when
 * a telegram connection is set but no approver is linked.
 */

/** The stored shape for key 'approvals'; all three keys nullable. */
interface ApprovalsSettings {
  slackConnectionId: string | null;
  slackChannelId: string | null;
  telegramConnectionId: string | null;
}

const DEFAULTS: ApprovalsSettings = {
  slackConnectionId: null,
  slackChannelId: null,
  telegramConnectionId: null,
};

const PutSchema = z.object({
  slackConnectionId: z.string().uuid().nullable().optional(),
  slackChannelId: z.string().min(1).max(64).nullable().optional(),
  telegramConnectionId: z.string().uuid().nullable().optional(),
});

/** Read the stored setting, coercing any legacy/partial value to the full shape. */
function readSettings(raw: Partial<ApprovalsSettings> | null): ApprovalsSettings {
  return {
    slackConnectionId: raw?.slackConnectionId ?? null,
    slackChannelId: raw?.slackChannelId ?? null,
    telegramConnectionId: raw?.telegramConnectionId ?? null,
  };
}

export function registerSettingsRoutes(app: FastifyInstance) {
  app.get('/v1/settings/approvals', { preHandler: [authenticate] }, async (req) => {
    const settings = readSettings(
      await getTenantSetting<Partial<ApprovalsSettings>>(req.tenant.id, 'approvals'),
    );

    // Telegram approvers = telegram identities linked to the 'approvals'
    // subscriber. listChannelIdentities returns [] when no such subscriber.
    const identities = await listChannelIdentities(req.tenant.id, 'approvals');
    const telegramApproverCount = identities.filter((i) => i.channel === 'telegram').length;

    return { settings, telegramApproverCount };
  });

  app.put('/v1/settings/approvals', { preHandler: [authenticate] }, async (req, reply) => {
    const parsed = PutSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'invalid body', details: parsed.error.issues });
    }
    const body = parsed.data;

    // Merge the provided fields onto the current setting (absent = keep).
    const current = readSettings(
      await getTenantSetting<Partial<ApprovalsSettings>>(req.tenant.id, 'approvals'),
    );
    const merged: ApprovalsSettings = { ...current };
    if (body.slackConnectionId !== undefined) merged.slackConnectionId = body.slackConnectionId;
    if (body.slackChannelId !== undefined) merged.slackChannelId = body.slackChannelId;
    if (body.telegramConnectionId !== undefined) {
      merged.telegramConnectionId = body.telegramConnectionId;
    }

    // Explicitly nulling the slack connection cascades to its channel id — the
    // channel can't outlive the workspace it belonged to.
    if (body.slackConnectionId === null) merged.slackChannelId = null;

    // Validate each non-null connection id against the tenant's connections.
    const checks: Array<{ field: keyof ApprovalsSettings; channel: 'slack' | 'telegram' }> = [
      { field: 'slackConnectionId', channel: 'slack' },
      { field: 'telegramConnectionId', channel: 'telegram' },
    ];
    for (const { field, channel } of checks) {
      const id = merged[field];
      if (id === null) continue;
      const conn = await getConnection(req.tenant.id, id);
      if (!conn || conn.channel !== channel || conn.status !== 'active') {
        return reply.code(400).send({ error: `${field}: not an active ${channel} connection` });
      }
    }

    // A slack channel id is meaningless without a slack connection.
    if (merged.slackChannelId !== null && merged.slackConnectionId === null) {
      return reply
        .code(400)
        .send({ error: 'slackChannelId: requires an active slack connection' });
    }

    await putTenantSetting(req.tenant.id, 'approvals', { ...merged });
    return { settings: merged };
  });
}
