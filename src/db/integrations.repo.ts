import { pool } from './pool';
import type { Channel } from '../shared/queues';

export interface IntegrationRow {
  id: string;
  tenant_id: string;
  channel: Channel;
  provider: string;
  credentials: string; // sealed — decrypt only inside the provider factory
  is_primary: boolean;
  fallback_order: number;
  active: boolean;
  updated_at: string;
}

export async function createIntegration(i: {
  tenantId: string;
  channel: Channel;
  provider: string;
  sealedCredentials: string;
  isPrimary: boolean;
  fallbackOrder: number;
}): Promise<IntegrationRow> {
  const { rows } = await pool.query(
    `insert into integrations (tenant_id, channel, provider, credentials, is_primary, fallback_order)
     values ($1, $2, $3, $4, $5, $6) returning *`,
    [i.tenantId, i.channel, i.provider, i.sealedCredentials, i.isPrimary, i.fallbackOrder],
  );
  if (i.isPrimary) await demoteOtherPrimaries(rows[0]);
  return rows[0];
}

/** Only one primary per tenant+channel. */
async function demoteOtherPrimaries(row: IntegrationRow): Promise<void> {
  await pool.query(
    `update integrations set is_primary = false, updated_at = now()
     where tenant_id = $1 and channel = $2 and id != $3 and is_primary`,
    [row.tenant_id, row.channel, row.id],
  );
}

export async function updateIntegration(
  id: string,
  tenantId: string,
  fields: {
    sealedCredentials?: string;
    isPrimary?: boolean;
    fallbackOrder?: number;
    active?: boolean;
  },
): Promise<IntegrationRow | null> {
  const { rows } = await pool.query(
    `update integrations set
       credentials    = coalesce($3, credentials),
       is_primary     = coalesce($4, is_primary),
       fallback_order = coalesce($5, fallback_order),
       active         = coalesce($6, active),
       updated_at     = now()
     where id = $1 and tenant_id = $2
     returning *`,
    [
      id,
      tenantId,
      fields.sealedCredentials ?? null,
      fields.isPrimary ?? null,
      fields.fallbackOrder ?? null,
      fields.active ?? null,
    ],
  );
  if (rows[0] && fields.isPrimary) await demoteOtherPrimaries(rows[0]);
  return rows[0] ?? null;
}

export async function deleteIntegration(id: string, tenantId: string): Promise<number> {
  const { rowCount } = await pool.query(
    'delete from integrations where id = $1 and tenant_id = $2',
    [id, tenantId],
  );
  return rowCount ?? 0;
}

export async function listIntegrations(tenantId: string): Promise<IntegrationRow[]> {
  const { rows } = await pool.query(
    'select * from integrations where tenant_id = $1 order by channel, is_primary desc, fallback_order',
    [tenantId],
  );
  return rows;
}

export async function getIntegration(
  id: string,
  tenantId: string,
): Promise<IntegrationRow | null> {
  const { rows } = await pool.query(
    'select * from integrations where id = $1 and tenant_id = $2',
    [id, tenantId],
  );
  return rows[0] ?? null;
}

/** Active failover chain for one tenant+channel: primary first, then fallbacks. */
export async function integrationsForChannel(
  tenantId: string,
  channel: Channel,
): Promise<IntegrationRow[]> {
  const { rows } = await pool.query(
    `select * from integrations
     where tenant_id = $1 and channel = $2 and active
     order by is_primary desc, fallback_order, created_at`,
    [tenantId, channel],
  );
  return rows;
}
