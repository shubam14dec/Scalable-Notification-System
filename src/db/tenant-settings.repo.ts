/**
 * Tenant-wide key/value settings — the first tenant-level config store
 * (everything earlier is per-agent or per-connection). Values are plain
 * jsonb; callers own their shape. Phase 19 uses key 'approvals':
 * {slackConnectionId, slackChannelId, telegramConnectionId}.
 */
import { pool } from './pool';

export async function getTenantSetting<T = Record<string, unknown>>(
  tenantId: string,
  key: string,
): Promise<T | null> {
  const { rows } = await pool.query(
    'select value from tenant_settings where tenant_id = $1 and key = $2',
    [tenantId, key],
  );
  return (rows[0]?.value as T) ?? null;
}

export async function putTenantSetting(
  tenantId: string,
  key: string,
  value: Record<string, unknown>,
): Promise<void> {
  await pool.query(
    `insert into tenant_settings (tenant_id, key, value)
     values ($1, $2, $3)
     on conflict (tenant_id, key) do update set value = $3, updated_at = now()`,
    [tenantId, key, JSON.stringify(value)],
  );
}
