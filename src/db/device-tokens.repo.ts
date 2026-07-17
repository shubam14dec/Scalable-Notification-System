/**
 * Multi-device push tokens (Phase 20). One row per (tenant, token); a
 * subscriber holds up to MAX_DEVICES_PER_SUBSCRIBER rows (oldest last_seen
 * evicted on insert past the cap). Upsert re-points subscriber_id on
 * conflict: a shared device that logs into a different account moves with
 * the login. The legacy subscribers.push_token column is write-mirrored by
 * callers and read by NOTHING in the send path — fan-out reads this table.
 */
import { pool } from './pool';

export const MAX_DEVICES_PER_SUBSCRIBER = 10;

export interface DeviceToken {
  id: string;
  tenant_id: string;
  subscriber_id: string;
  token: string;
  platform: 'web' | 'android' | 'ios' | null;
  created_at: string;
  last_seen_at: string;
}

export async function upsertDeviceToken(
  tenantId: string,
  subscriberId: string,
  token: string,
  platform?: DeviceToken['platform'],
): Promise<DeviceToken> {
  const { rows } = await pool.query(
    `insert into device_tokens (tenant_id, subscriber_id, token, platform)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, token) do update set
       subscriber_id = excluded.subscriber_id,
       platform      = coalesce(excluded.platform, device_tokens.platform),
       last_seen_at  = now()
     returning *`,
    [tenantId, subscriberId, token, platform ?? null],
  );
  // Cap enforcement: evict beyond the newest N by last_seen (set-based; the
  // subquery touches only this subscriber's rows via the subscriber index).
  await pool.query(
    `delete from device_tokens
     where tenant_id = $1 and subscriber_id = $2
       and id not in (
         select id from device_tokens
         where tenant_id = $1 and subscriber_id = $2
         order by last_seen_at desc, id desc
         limit $3
       )`,
    [tenantId, subscriberId, MAX_DEVICES_PER_SUBSCRIBER],
  );
  return rows[0];
}

export async function listDeviceTokens(
  tenantId: string,
  subscriberId: string,
): Promise<DeviceToken[]> {
  const { rows } = await pool.query(
    `select * from device_tokens
     where tenant_id = $1 and subscriber_id = $2
     order by last_seen_at desc`,
    [tenantId, subscriberId],
  );
  return rows;
}

/**
 * Fan-out's batch read: every device for a set of subscribers in ONE query
 * (never per-subscriber-per-tick). Rows come back newest-first per subscriber.
 */
export async function listDeviceTokensForSubscribers(
  tenantId: string,
  subscriberIds: string[],
): Promise<Map<string, DeviceToken[]>> {
  const out = new Map<string, DeviceToken[]>();
  if (subscriberIds.length === 0) return out;
  const { rows } = await pool.query(
    `select * from device_tokens
     where tenant_id = $1 and subscriber_id = any($2::uuid[])
     order by subscriber_id, last_seen_at desc`,
    [tenantId, subscriberIds],
  );
  for (const row of rows as DeviceToken[]) {
    const list = out.get(row.subscriber_id);
    if (list) list.push(row);
    else out.set(row.subscriber_id, [row]);
  }
  return out;
}

/**
 * Remove a device by token (unregister / dead-token cleanup). Also nulls a
 * matching legacy subscribers.push_token so the schema backfill can never
 * resurrect an explicitly-removed device.
 */
export async function deleteDeviceToken(tenantId: string, token: string): Promise<boolean> {
  const { rowCount } = await pool.query(
    'delete from device_tokens where tenant_id = $1 and token = $2',
    [tenantId, token],
  );
  await pool.query(
    'update subscribers set push_token = null where tenant_id = $1 and push_token = $2',
    [tenantId, token],
  );
  return (rowCount ?? 0) > 0;
}
