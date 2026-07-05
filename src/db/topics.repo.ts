import { pool } from './pool';
import type { Subscriber } from './repositories';

export interface TopicRow {
  id: string;
  tenant_id: string;
  key: string;
  name: string;
  created_at: string;
}

export async function upsertTopic(
  tenantId: string,
  key: string,
  name: string,
): Promise<TopicRow> {
  const { rows } = await pool.query(
    `insert into topics (tenant_id, key, name) values ($1, $2, $3)
     on conflict (tenant_id, key) do update set name = excluded.name
     returning *`,
    [tenantId, key, name],
  );
  return rows[0];
}

export async function getTopicByKey(tenantId: string, key: string): Promise<TopicRow | null> {
  const { rows } = await pool.query(
    'select * from topics where tenant_id = $1 and key = $2',
    [tenantId, key],
  );
  return rows[0] ?? null;
}

export async function listTopics(tenantId: string) {
  const { rows } = await pool.query(
    `select t.id, t.key, t.name, t.created_at, count(ts.subscriber_id)::int as member_count
     from topics t
     left join topic_subscribers ts on ts.topic_id = t.id
     where t.tenant_id = $1
     group by t.id
     order by t.key`,
    [tenantId],
  );
  return rows;
}

export async function deleteTopic(tenantId: string, key: string): Promise<number> {
  const { rowCount } = await pool.query(
    'delete from topics where tenant_id = $1 and key = $2',
    [tenantId, key],
  );
  return rowCount ?? 0;
}

/**
 * Bulk-attach members by external subscriber id. Unknown subscribers are
 * created as bare records (they get contact details whenever a trigger or
 * upsert later fills them in) — so "add these 10k user ids to beta-users"
 * is one call, no pre-registration dance.
 */
export async function addTopicSubscribers(
  tenantId: string,
  topicId: string,
  externalIds: string[],
): Promise<number> {
  if (externalIds.length === 0) return 0;
  const { rowCount } = await pool.query(
    `with subs as (
       insert into subscribers (tenant_id, external_id)
       select $1, unnest($2::text[])
       on conflict (tenant_id, external_id) do update set updated_at = now()
       returning id
     )
     insert into topic_subscribers (topic_id, subscriber_id)
     select $3, id from subs
     on conflict do nothing`,
    [tenantId, externalIds, topicId],
  );
  return rowCount ?? 0;
}

export async function removeTopicSubscribers(
  tenantId: string,
  topicId: string,
  externalIds: string[],
): Promise<number> {
  if (externalIds.length === 0) return 0;
  const { rowCount } = await pool.query(
    `delete from topic_subscribers ts
     using subscribers s
     where ts.topic_id = $1
       and s.id = ts.subscriber_id
       and s.tenant_id = $2
       and s.external_id = any($3::text[])`,
    [topicId, tenantId, externalIds],
  );
  return rowCount ?? 0;
}

export async function listTopicMembers(topicId: string, limit = 100) {
  const { rows } = await pool.query(
    `select s.external_id, s.email, s.phone, ts.created_at as added_at
     from topic_subscribers ts
     join subscribers s on s.id = ts.subscriber_id
     where ts.topic_id = $1
     order by ts.created_at desc
     limit $2`,
    [topicId, limit],
  );
  return rows;
}

/** Keyset pagination over members — topic fan-out streams through this. */
export async function pageTopicMembers(
  topicId: string,
  afterSubscriberId: string | null,
  limit: number,
): Promise<Subscriber[]> {
  const { rows } = await pool.query(
    `select s.* from topic_subscribers ts
     join subscribers s on s.id = ts.subscriber_id
     where ts.topic_id = $1 and ($2::uuid is null or s.id > $2)
     order by s.id
     limit $3`,
    [topicId, afterSubscriberId, limit],
  );
  return rows;
}
