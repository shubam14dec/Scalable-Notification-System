/**
 * Phase 24 slice E — the subscriber-memory repo caps (src/db/memories.repo.ts),
 * which are LAW (D2): at most 32 keys per (agent, subscriber), key ≤ 64 chars,
 * value ≤ 300 chars, NO silent truncation. Every violation throws a typed
 * MemoryCapError carrying `reason` + the current key list so the caller (tool
 * result / API 409) can instruct an overwrite instead of losing the fact.
 *
 * This exercises the repo directly (not through the brain), so it seeds a
 * throwaway tenant/agent/subscriber straight into Postgres — the caps logic
 * loads the profile first, so a real FK-valid (agent, subscriber) is required.
 * The <customer_profile> BLOCK builder (buildCustomerProfile, unexported) is
 * verified end-to-end through the brain in tests/integration/memories.test.ts.
 *
 * Requires: `docker compose up -d postgres` and `npm run migrate`.
 */
import { afterAll, afterEach, beforeAll, describe, expect, test } from 'vitest';
import { pool } from '../../src/db/pool';
import {
  listMemories,
  upsertMemory,
  deleteMemory,
  MemoryCapError,
  MAX_MEMORY_KEYS,
  MAX_MEMORY_KEY_LEN,
  MAX_MEMORY_VALUE_LEN,
} from '../../src/db/memories.repo';

let tenantId = '';
let agentId = '';
let subscriberId = '';

beforeAll(async () => {
  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const { rows: t } = await pool.query<{ id: string }>(
    `insert into tenants (name) values ($1) returning id`,
    [`mem-repo-it-${suffix}`],
  );
  tenantId = t[0].id;
  // signing_secret is NOT NULL but the repo never opens it — a dummy string is fine.
  const { rows: a } = await pool.query<{ id: string }>(
    `insert into agents (tenant_id, identifier, name, signing_secret, runtime)
     values ($1, $2, 'Mem Repo Agent', 'dummy-sealed', 'managed') returning id`,
    [tenantId, `mem-agent-${suffix}`],
  );
  agentId = a[0].id;
  const { rows: s } = await pool.query<{ id: string }>(
    `insert into subscribers (tenant_id, external_id) values ($1, $2) returning id`,
    [tenantId, `mem-sub-${suffix}`],
  );
  subscriberId = s[0].id;
});

afterEach(async () => {
  // Each test starts from an empty profile (no reliance on order).
  await pool.query('delete from subscriber_memories where agent_id = $1', [agentId]);
});

afterAll(async () => {
  // R1 cleanup: leave nothing behind. Memories cascade off agent/subscriber, but
  // delete explicitly first so the order never matters.
  await pool.query('delete from subscriber_memories where agent_id = $1', [agentId]);
  await pool.query('delete from agents where id = $1', [agentId]);
  await pool.query('delete from subscribers where id = $1', [subscriberId]);
  await pool.query('delete from tenants where id = $1', [tenantId]);
  await pool.end();
});

const upsert = (key: string, value: string, source: 'agent' | 'operator' = 'agent') =>
  upsertMemory({ tenantId, agentId, subscriberId, key, value, source });

describe('memory repo — the D2 caps are law', () => {
  test('the cap constants are the documented 32 / 64 / 300', () => {
    expect(MAX_MEMORY_KEYS).toBe(32);
    expect(MAX_MEMORY_KEY_LEN).toBe(64);
    expect(MAX_MEMORY_VALUE_LEN).toBe(300);
  });

  test('a 33rd NEW key is rejected with too_many_keys + the current 32 keys', async () => {
    // Fill the profile to exactly the cap.
    for (let i = 0; i < MAX_MEMORY_KEYS; i += 1) {
      await upsert(`key_${String(i).padStart(2, '0')}`, `value ${i}`);
    }
    expect(await listMemories(agentId, subscriberId)).toHaveLength(32);

    // The 33rd DISTINCT key cannot fit.
    let caught: MemoryCapError | undefined;
    try {
      await upsert('key_33_overflow', 'one too many');
    } catch (err) {
      caught = err as MemoryCapError;
    }
    expect(caught).toBeInstanceOf(MemoryCapError);
    expect(caught!.reason).toBe('too_many_keys');
    // The full current key list rides the error so the caller can offer an overwrite.
    expect(caught!.currentKeys).toHaveLength(32);
    expect(caught!.currentKeys).toContain('key_00');
    expect(caught!.limits).toMatchObject({ maxKeys: 32, maxKeyLen: 64, maxValueLen: 300 });
    // Nothing was written (still exactly 32, the overflow key absent).
    const keys = (await listMemories(agentId, subscriberId)).map((m) => m.key);
    expect(keys).toHaveLength(32);
    expect(keys).not.toContain('key_33_overflow');
  });

  test('overwriting an EXISTING key at the cap is allowed (frees no slot, needs none)', async () => {
    for (let i = 0; i < MAX_MEMORY_KEYS; i += 1) {
      await upsert(`key_${String(i).padStart(2, '0')}`, `value ${i}`);
    }
    // Overwrite key_05 even though the profile is full — this is how a caller
    // corrects a fact or frees conceptual space.
    const row = await upsert('key_05', 'corrected value', 'operator');
    expect(row.value).toBe('corrected value');
    expect(row.source).toBe('operator');
    // Still exactly 32 keys (an upsert, not an insert).
    expect(await listMemories(agentId, subscriberId)).toHaveLength(32);
  });

  test('a 301-char value is rejected (value_too_long); 300 is accepted', async () => {
    let caught: MemoryCapError | undefined;
    try {
      await upsert('too_long', 'x'.repeat(MAX_MEMORY_VALUE_LEN + 1));
    } catch (err) {
      caught = err as MemoryCapError;
    }
    expect(caught).toBeInstanceOf(MemoryCapError);
    expect(caught!.reason).toBe('value_too_long');
    // No silent truncation — the row must not exist.
    expect(await listMemories(agentId, subscriberId)).toHaveLength(0);

    // The boundary value (exactly 300) is stored verbatim.
    const ok = await upsert('at_limit', 'y'.repeat(MAX_MEMORY_VALUE_LEN));
    expect(ok.value).toHaveLength(MAX_MEMORY_VALUE_LEN);
  });

  test('key rules: empty rejects key_empty, 65 chars rejects key_too_long, 64 is fine', async () => {
    await expect(upsert('   ', 'v')).rejects.toMatchObject({
      name: 'MemoryCapError',
      reason: 'key_empty',
    });
    await expect(upsert('k'.repeat(MAX_MEMORY_KEY_LEN + 1), 'v')).rejects.toMatchObject({
      reason: 'key_too_long',
    });
    // Exactly 64 chars is the boundary and is accepted.
    const row = await upsert('k'.repeat(MAX_MEMORY_KEY_LEN), 'v');
    expect(row.key).toHaveLength(MAX_MEMORY_KEY_LEN);
    // Whitespace around a key is trimmed before storage and length checks.
    const trimmed = await upsert('  spaced_key  ', 'v');
    expect(trimmed.key).toBe('spaced_key');
  });

  test('listMemories returns the profile ordered by key', async () => {
    await upsert('zebra', 'z');
    await upsert('alpha', 'a');
    await upsert('mango', 'm');
    const keys = (await listMemories(agentId, subscriberId)).map((m) => m.key);
    expect(keys).toEqual(['alpha', 'mango', 'zebra']);
  });

  test('deleteMemory removes one key by name, or the whole profile when key omitted', async () => {
    await upsert('a', '1');
    await upsert('b', '2');
    await upsert('c', '3');

    expect(await deleteMemory(agentId, subscriberId, 'b')).toBe(1);
    expect((await listMemories(agentId, subscriberId)).map((m) => m.key)).toEqual(['a', 'c']);
    // Deleting a key that isn't there removes nothing.
    expect(await deleteMemory(agentId, subscriberId, 'nope')).toBe(0);
    // No key => wipe the whole profile, returning the count removed.
    expect(await deleteMemory(agentId, subscriberId)).toBe(2);
    expect(await listMemories(agentId, subscriberId)).toHaveLength(0);
  });
});
