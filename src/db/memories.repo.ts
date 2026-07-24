/**
 * Long-term subscriber memory (Phase 24, D1/D2): durable per-(agent,
 * subscriber) key/value facts the agent keeps for FUTURE conversations. The
 * managed brain LOADS the whole profile once per turn (never searches it) and
 * injects it as the <customer_profile> system section; the `remember` built-in
 * and the operator memory API write it.
 *
 * The caps are LAW, enforced here so neither writer can bypass them:
 *   - at most MAX_MEMORY_KEYS keys per (agent, subscriber)
 *   - key <= MAX_MEMORY_KEY_LEN chars
 *   - value <= MAX_MEMORY_VALUE_LEN chars (NO silent truncation — reject)
 * A NEW key on a full profile, or an oversize key/value, throws a typed
 * MemoryCapError carrying the current key list + limits so the caller (the tool
 * result / API response) can instruct the model or operator to overwrite an
 * existing key instead of losing data quietly.
 */
import { pool } from './pool';

/** ≤32 keys per (agent, subscriber) — the profile is a small, curated set. */
export const MAX_MEMORY_KEYS = 32;
/** A key is a short snake_case-ish handle, not a sentence. */
export const MAX_MEMORY_KEY_LEN = 64;
/** A value is one durable fact — a preference, a plan, a constraint. */
export const MAX_MEMORY_VALUE_LEN = 300;

export interface SubscriberMemory {
  id: string;
  tenant_id: string;
  agent_id: string;
  subscriber_id: string;
  key: string;
  value: string;
  source: 'agent' | 'operator';
  updated_at: string;
}

export interface MemoryLimits {
  maxKeys: number;
  maxKeyLen: number;
  maxValueLen: number;
}

const LIMITS: MemoryLimits = {
  maxKeys: MAX_MEMORY_KEYS,
  maxKeyLen: MAX_MEMORY_KEY_LEN,
  maxValueLen: MAX_MEMORY_VALUE_LEN,
};

/**
 * A cap violation on upsert. Carries the CURRENT key list + limits so the
 * caller can turn it into an instructive tool result ("profile full — overwrite
 * one of: …") or an API 409, never a silent drop. `reason` lets callers word a
 * precise message per failure.
 */
export class MemoryCapError extends Error {
  constructor(
    message: string,
    readonly reason: 'key_empty' | 'key_too_long' | 'value_too_long' | 'too_many_keys',
    readonly currentKeys: string[],
    readonly limits: MemoryLimits = LIMITS,
  ) {
    super(message);
    this.name = 'MemoryCapError';
  }
}

/** The whole profile for one (agent, subscriber), ordered by key (stable render). */
export async function listMemories(
  agentId: string,
  subscriberId: string,
): Promise<SubscriberMemory[]> {
  const { rows } = await pool.query<SubscriberMemory>(
    `select id, tenant_id, agent_id, subscriber_id, key, value, source, updated_at
       from subscriber_memories
      where agent_id = $1 and subscriber_id = $2
      order by key`,
    [agentId, subscriberId],
  );
  return rows;
}

/**
 * Upsert one fact, enforcing the D2 caps. An overwrite of an EXISTING key is
 * always allowed (even at the key cap) — that is how a caller frees space or
 * corrects a fact; only a NEW key on a full profile is rejected. Oversize
 * key/value are rejected outright (no truncation).
 */
export async function upsertMemory(m: {
  tenantId: string;
  agentId: string;
  subscriberId: string;
  key: string;
  value: string;
  source: 'agent' | 'operator';
}): Promise<SubscriberMemory> {
  const key = m.key.trim();
  // Load the current profile up front: it bounds the key cap AND supplies the
  // key list every MemoryCapError needs. ≤32 rows, one indexed read.
  const existing = await listMemories(m.agentId, m.subscriberId);
  const currentKeys = existing.map((r) => r.key);

  if (!key) {
    throw new MemoryCapError('key is required', 'key_empty', currentKeys);
  }
  if (key.length > MAX_MEMORY_KEY_LEN) {
    throw new MemoryCapError(
      `key exceeds ${MAX_MEMORY_KEY_LEN} characters`,
      'key_too_long',
      currentKeys,
    );
  }
  if (m.value.length > MAX_MEMORY_VALUE_LEN) {
    throw new MemoryCapError(
      `value exceeds ${MAX_MEMORY_VALUE_LEN} characters`,
      'value_too_long',
      currentKeys,
    );
  }
  const isNewKey = !currentKeys.includes(key);
  if (isNewKey && existing.length >= MAX_MEMORY_KEYS) {
    throw new MemoryCapError(
      `profile is full (${MAX_MEMORY_KEYS} keys)`,
      'too_many_keys',
      currentKeys,
    );
  }

  const { rows } = await pool.query<SubscriberMemory>(
    `insert into subscriber_memories (tenant_id, agent_id, subscriber_id, key, value, source)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (agent_id, subscriber_id, key)
       do update set value = excluded.value, source = excluded.source, updated_at = now()
     returning id, tenant_id, agent_id, subscriber_id, key, value, source, updated_at`,
    [m.tenantId, m.agentId, m.subscriberId, key, m.value, m.source],
  );
  return rows[0];
}

/**
 * Delete one key (when `key` is given) or the WHOLE profile (when omitted).
 * Returns the number of rows removed.
 */
export async function deleteMemory(
  agentId: string,
  subscriberId: string,
  key?: string,
): Promise<number> {
  if (key !== undefined) {
    const { rowCount } = await pool.query(
      `delete from subscriber_memories
        where agent_id = $1 and subscriber_id = $2 and key = $3`,
      [agentId, subscriberId, key],
    );
    return rowCount ?? 0;
  }
  const { rowCount } = await pool.query(
    `delete from subscriber_memories where agent_id = $1 and subscriber_id = $2`,
    [agentId, subscriberId],
  );
  return rowCount ?? 0;
}
