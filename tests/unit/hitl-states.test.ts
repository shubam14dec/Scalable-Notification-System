/**
 * Phase 26 slice D — the HITL handoff STATE MACHINE, at the helper level.
 *
 * Two halves:
 *  1. The conversations.repo transition helpers (setConversationWaitingHuman,
 *     setConversationHuman, handbackConversation, resolveConversation) as a
 *     legal/illegal transition MATRIX (D1). Each helper is a guarded, once-only
 *     flip whose boolean return doubles as "THIS call did it" — so an illegal
 *     source state must return false AND leave the row untouched. These hit a
 *     real Postgres (the guards ARE SQL), so the file seeds a throwaway
 *     tenant/agent/subscriber and a fresh conversation per case.
 *  2. The pure fold-boundary rules (rolling.ts): serializeFoldInput attributes an
 *     operator (raw.operator) row to the human teammate, and isReplayableTurn
 *     EXCLUDES operator rows from verbatim replay (D6 imitation boundary). No
 *     infra — deterministic output for hand-built rows.
 *
 * Requires: `docker compose up -d postgres redis` (the transition matrix does
 * real SQL; the repo helpers also fire a fire-and-forget redis hint).
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import { pool } from '../../src/db/pool';
import { redis } from '../../src/shared/redis';
import { closeQueues } from '../../src/shared/queues';
import {
  setConversationWaitingHuman,
  setConversationHuman,
  handbackConversation,
  resolveConversation,
  type ConversationMessage,
} from '../../src/db/conversations.repo';
import { serializeFoldInput, isReplayableTurn } from '../../src/core/rolling';

// ---------------------------------------------------------------------------
// Part 1 — the transition matrix (real SQL guards)
// ---------------------------------------------------------------------------

type Status = 'active' | 'waiting_human' | 'human' | 'resolved';

let tenantId = '';
let agentId = '';
let subscriberId = '';
let seq = 0;

/** Seed a fresh conversation pinned at `status`; returns its id. */
async function seed(status: Status): Promise<string> {
  seq += 1;
  const { rows } = await pool.query<{ id: string }>(
    `insert into conversations (tenant_id, agent_id, subscriber_id, channel, thread_key, status)
     values ($1, $2, $3, 'inapp', $4, $5) returning id`,
    [tenantId, agentId, subscriberId, `hitl-unit-${seq}`, status],
  );
  return rows[0].id;
}

async function rowOf(id: string): Promise<{ status: string; had_human: boolean }> {
  const { rows } = await pool.query<{ status: string; had_human: boolean }>(
    'select status, had_human from conversations where id = $1',
    [id],
  );
  return rows[0];
}

beforeAll(async () => {
  const t = await pool.query<{ id: string }>(
    `insert into tenants (name) values ($1) returning id`,
    [`hitl-unit-tenant-${Date.now()}-${Math.floor(Math.random() * 1e6)}`],
  );
  tenantId = t.rows[0].id;
  const a = await pool.query<{ id: string }>(
    `insert into agents (tenant_id, identifier, name, signing_secret)
     values ($1, 'hitl-unit-agent', 'HITL Unit Agent', 'sealed-noop') returning id`,
    [tenantId],
  );
  agentId = a.rows[0].id;
  const s = await pool.query<{ id: string }>(
    `insert into subscribers (tenant_id, external_id) values ($1, 'hitl-unit-sub') returning id`,
    [tenantId],
  );
  subscriberId = s.rows[0].id;
});

afterAll(async () => {
  try {
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
    await pool.query('delete from agents where tenant_id = $1', [tenantId]);
    await pool.query('delete from tenants where id = $1', [tenantId]);
  } catch {
    /* best-effort */
  }
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('setConversationWaitingHuman — only from active (the handoff flip)', () => {
  test('active → waiting_human returns true and writes the status', async () => {
    const id = await seed('active');
    expect(await setConversationWaitingHuman(id)).toBe(true);
    expect((await rowOf(id)).status).toBe('waiting_human');
  });

  test.each<Status>(['waiting_human', 'human', 'resolved'])(
    'from %s it is a no-op (false, status unchanged)',
    async (from) => {
      const id = await seed(from);
      expect(await setConversationWaitingHuman(id)).toBe(false);
      expect((await rowOf(id)).status).toBe(from);
    },
  );
});

describe('setConversationHuman — only from waiting_human (first operator reply)', () => {
  test('waiting_human → human returns true, writes status AND stamps had_human', async () => {
    const id = await seed('waiting_human');
    expect((await rowOf(id)).had_human).toBe(false);
    expect(await setConversationHuman(id)).toBe(true);
    const after = await rowOf(id);
    expect(after.status).toBe('human');
    expect(after.had_human).toBe(true);
  });

  test.each<Status>(['active', 'human', 'resolved'])(
    'from %s it is a no-op (false, status unchanged, had_human not forced)',
    async (from) => {
      const id = await seed(from);
      expect(await setConversationHuman(id)).toBe(false);
      const after = await rowOf(id);
      expect(after.status).toBe(from);
      expect(after.had_human).toBe(false);
    },
  );
});

describe('handbackConversation — from waiting_human OR human (Return to agent)', () => {
  test.each<Status>(['waiting_human', 'human'])(
    'from %s → active returns true',
    async (from) => {
      const id = await seed(from);
      expect(await handbackConversation(id)).toBe(true);
      expect((await rowOf(id)).status).toBe('active');
    },
  );

  test.each<Status>(['active', 'resolved'])(
    'from %s it is a no-op (false, status unchanged)',
    async (from) => {
      const id = await seed(from);
      expect(await handbackConversation(id)).toBe(false);
      expect((await rowOf(id)).status).toBe(from);
    },
  );
});

describe('resolveConversation — from any NON-resolved state', () => {
  test.each<Status>(['active', 'waiting_human', 'human'])(
    'from %s → resolved returns true',
    async (from) => {
      const id = await seed(from);
      expect(await resolveConversation(id, 'closed in test')).toBe(true);
      expect((await rowOf(id)).status).toBe('resolved');
    },
  );

  test('from resolved it is a no-op (false, already resolved)', async () => {
    const id = await seed('resolved');
    expect(await resolveConversation(id)).toBe(false);
    expect((await rowOf(id)).status).toBe('resolved');
  });
});

describe('had_human is durable across the full loop', () => {
  test('active → waiting_human → human (had_human set) → handback keeps had_human true', async () => {
    const id = await seed('active');
    await setConversationWaitingHuman(id);
    await setConversationHuman(id);
    expect((await rowOf(id)).had_human).toBe(true);
    // Return to agent: the flag must survive the handback and the later
    // folding-away of the operator turns (it powers the post-handback D7 advice).
    expect(await handbackConversation(id)).toBe(true);
    const after = await rowOf(id);
    expect(after.status).toBe('active');
    expect(after.had_human).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Part 2 — the fold boundary (pure; mirrors rolling unit style)
// ---------------------------------------------------------------------------

let m = 0;
function msg(over: Partial<ConversationMessage>): ConversationMessage {
  m += 1;
  return {
    id: over.id ?? `u-${m}`,
    conversation_id: 'c-1',
    tenant_id: 't-1',
    role: 'user',
    content: '',
    dedupe_key: `d-${m}`,
    raw: null,
    created_at: new Date(m * 1000).toISOString(),
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
    ...over,
  };
}

describe('serializeFoldInput — operator turns are attributed to the human (D6)', () => {
  test('an operator (raw.operator) agent row renders as the teammate, NEVER as "Agent:"', () => {
    const rows: ConversationMessage[] = [
      msg({ role: 'user', content: 'is my refund coming?' }),
      msg({
        role: 'agent',
        content: 'Hi, this is Sam. I have processed your refund today.',
        raw: { operator: { name: 'Sam Rivera' } },
      }),
    ];
    const out = serializeFoldInput(rows, null);
    expect(out).toContain(
      'A human teammate (Sam Rivera) told the customer: "Hi, this is Sam. I have processed your refund today."',
    );
    // The operator's words are never folded in under the model's own voice.
    expect(out).not.toContain('Agent: Hi, this is Sam');
    expect(out).toContain('Customer: is my refund coming?');
  });

  test('an operator row with no name falls back to "teammate"', () => {
    const out = serializeFoldInput(
      [msg({ role: 'agent', content: 'On it.', raw: { operator: {} } })],
      null,
    );
    expect(out).toBe('A human teammate (teammate) told the customer: "On it."');
  });
});

describe('isReplayableTurn — operator rows are excluded from verbatim replay (D6)', () => {
  test('an agent row carrying raw.operator is NOT replayable', () => {
    expect(
      isReplayableTurn(
        msg({ role: 'agent', content: 'human says hi', raw: { operator: { name: 'Sam' } } }),
      ),
    ).toBe(false);
  });

  test('a normal agent row (even with unrelated raw) stays replayable', () => {
    expect(isReplayableTurn(msg({ role: 'agent', content: 'ok', raw: { usage: {} } }))).toBe(true);
    expect(isReplayableTurn(msg({ role: 'user', content: 'hi' }))).toBe(true);
  });
});
