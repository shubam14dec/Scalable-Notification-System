import { pool } from './pool';
import type { Subscriber } from './repositories';

/**
 * Channel identities + link tokens: how a channel-local stranger
 * (`tg-8123991`, a bare sender email) becomes the customer's REAL
 * subscriber. Mappings are additive — subscriber rows are never merged or
 * deleted, so unlink is just dropping the mapping.
 *
 * Scale shape: resolution is one unique-index hit per inbound message;
 * linking repoints only that thread's conversations; token cleanup is one
 * indexed delete on the sweep tick.
 */

export interface LinkToken {
  id: string;
  tenant_id: string;
  subscriber_id: string;
  channel: string;
  token_hash: string;
  expires_at: string;
  used_at: string | null;
}

export async function createLinkToken(t: {
  tenantId: string;
  subscriberId: string;
  channel: string;
  tokenHash: string;
  expiresAt: Date;
}): Promise<LinkToken> {
  const { rows } = await pool.query(
    `insert into subscriber_link_tokens
       (tenant_id, subscriber_id, channel, token_hash, expires_at)
     values ($1, $2, $3, $4, $5)
     returning *`,
    [t.tenantId, t.subscriberId, t.channel, t.tokenHash, t.expiresAt],
  );
  return rows[0];
}

/**
 * Atomic single-use: the UPDATE is the lock. A second consume (redelivered
 * webhook, re-tapped link, guessed token) returns null — never a throw.
 */
export async function consumeLinkToken(
  tokenHash: string,
  tenantId: string,
): Promise<LinkToken | null> {
  const { rows } = await pool.query(
    `update subscriber_link_tokens
        set used_at = now()
      where token_hash = $1 and tenant_id = $2
        and used_at is null and expires_at > now()
      returning *`,
    [tokenHash, tenantId],
  );
  return rows[0] ?? null;
}

/** Re-linking the same identity to a new subscriber: last link wins. */
export async function upsertChannelIdentity(i: {
  tenantId: string;
  channel: string;
  externalKey: string;
  subscriberId: string;
}): Promise<void> {
  await pool.query(
    `insert into channel_identities (tenant_id, channel, external_key, subscriber_id)
     values ($1, $2, $3, $4)
     on conflict (tenant_id, channel, external_key)
       do update set subscriber_id = excluded.subscriber_id`,
    [i.tenantId, i.channel, i.externalKey, i.subscriberId],
  );
}

/** The inbound hot path: mapping hit -> the real subscriber row. */
export async function resolveChannelIdentity(
  tenantId: string,
  channel: string,
  externalKey: string,
): Promise<Subscriber | null> {
  const { rows } = await pool.query(
    `select s.* from channel_identities ci
       join subscribers s on s.id = ci.subscriber_id
      where ci.tenant_id = $1 and ci.channel = $2 and ci.external_key = $3`,
    [tenantId, channel, externalKey],
  );
  return rows[0] ?? null;
}

export async function listChannelIdentities(
  tenantId: string,
  subscriberId: string,
): Promise<Array<{ channel: string; external_key: string; created_at: string }>> {
  const { rows } = await pool.query(
    `select ci.channel, ci.external_key, ci.created_at
       from channel_identities ci
       join subscribers s on s.id = ci.subscriber_id
      where ci.tenant_id = $1 and s.external_id = $2
      order by ci.created_at`,
    [tenantId, subscriberId],
  );
  return rows;
}

export async function deleteChannelIdentity(
  tenantId: string,
  channel: string,
  externalKey: string,
): Promise<boolean> {
  const { rowCount } = await pool.query(
    `delete from channel_identities
      where tenant_id = $1 and channel = $2 and external_key = $3`,
    [tenantId, channel, externalKey],
  );
  return (rowCount ?? 0) > 0;
}

/**
 * Email auto-match: an inbound sender address that equals an existing REAL
 * subscriber's email. Oldest row wins when several share the address (dev
 * data has legitimate duplicates); the channel-local email row itself
 * (external_id = the address) is excluded — matching it would be a no-op
 * identity pointing at the stranger we're trying to replace.
 */
export async function findSubscriberByEmail(
  tenantId: string,
  email: string,
): Promise<Subscriber | null> {
  const { rows } = await pool.query(
    `select * from subscribers
      where tenant_id = $1 and email = $2 and external_id <> $2
      order by created_at
      limit 1`,
    [tenantId, email],
  );
  return rows[0] ?? null;
}

/**
 * History follows the person: repoint the thread's conversations to the
 * real subscriber. Tenant-wide on purpose — a telegram user's chat id is
 * the same across every bot of the tenant.
 */
export async function repointConversations(
  tenantId: string,
  channel: string,
  threadKey: string,
  subscriberId: string,
): Promise<number> {
  const { rowCount } = await pool.query(
    `update conversations set subscriber_id = $4
      where tenant_id = $1 and channel = $2 and thread_key = $3
        and subscriber_id <> $4`,
    [tenantId, channel, threadKey, subscriberId],
  );
  return rowCount ?? 0;
}

/** Sweep-tick hygiene: one indexed delete, nothing per-user. */
export async function purgeDeadLinkTokens(): Promise<number> {
  const { rowCount } = await pool.query(
    `delete from subscriber_link_tokens
      where expires_at < now() - interval '7 days'`,
  );
  return rowCount ?? 0;
}
