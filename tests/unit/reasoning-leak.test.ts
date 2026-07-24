/**
 * Reasoning-leak guard (managed-brain LAW layer). Two halves:
 *
 *  1. Pure detector: isReasoningLeak flags ONLY high-confidence leaks (>=2
 *     signals) — the exact bug text trips it, clean replies and single-signal
 *     prose do not (false positives are worse than rare misses).
 *
 *  2. In-turn behavior driven against a stub Anthropic-compatible model server
 *     (the agent's llm_base_url), like turn-trace.test.ts:
 *       - leak then a clean answer on retry -> the customer gets the CLEAN
 *         answer; the trace shows 2 model calls; a breadcrumb raw flag
 *         {reasoningLeak:true} is persisted (psql-verified).
 *       - leak twice -> the deterministic fallback note ships, and the turn
 *         reports platformNote:true so the processor excludes it from replay.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { runManagedTurn, isReasoningLeak, type TurnTraceEvent } from '../../src/core/managed-brain';
import {
  getAgentById,
  getConversation,
  getSubscriberById,
  type Agent,
  type Conversation,
  type ConversationMessage,
} from '../../src/db/conversations.repo';

// The verbatim leak the user found in the Phase 23 E2E (GLM-4.7 via z.ai).
const BUG_LEAK =
  "The user is asking about return policy. I should provide the policy " +
  "information. I don't need to use any tools for this, I can just answer directly.";
const CLEAN_ANSWER = 'You can return any item within 30 days for a full refund.';
const FALLBACK = 'Sorry — I had trouble composing that reply. Could you rephrase your question?';

describe('isReasoningLeak (pure detector)', () => {
  test('flags the exact bug text (>=2 signals)', () => {
    expect(isReasoningLeak(BUG_LEAK)).toBe(true);
  });

  test('does not flag a normal customer-facing reply', () => {
    expect(isReasoningLeak(CLEAN_ANSWER)).toBe(false);
    expect(isReasoningLeak('Hi! Happy to help — what is your order number?')).toBe(false);
    expect(isReasoningLeak('')).toBe(false);
  });

  test('a single signal is NOT enough (conservative bias)', () => {
    // Only the "I should respond" pattern fires — one signal, below the >=2 bar.
    expect(isReasoningLeak('I should respond politely to every customer.')).toBe(false);
    // Only the opening pattern fires; a reply that legitimately names "the user"
    // once must not be suppressed.
    expect(isReasoningLeak('The user guide is attached for your reference.')).toBe(false);
  });

  test('third-person "the user" twice combines with another signal to flag', () => {
    expect(
      isReasoningLeak('The user wants a refund. I should answer the user now.'),
    ).toBe(true);
  });
});

// ---- stub Anthropic-compatible model server (mirrors turn-trace.test.ts) ----
let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let agent: Agent;
let conversation: Conversation;
let subscriber: NonNullable<Awaited<ReturnType<typeof getSubscriberById>>>;
const json = (res: { body: string }) => JSON.parse(res.body);

let llmStub: Server;
let llmBaseUrl = '';
let llmQueue: unknown[] = [];
const envelope = (content: unknown[], stopReason: string) => ({
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: 'glm-4-test',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const text = (t: string) => envelope([{ type: 'text', text: t }], 'end_turn');

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(llmQueue.length > 0 ? llmQueue.shift() : text('default reply')));
    });
  });
  return new Promise((r) => llmStub.listen(0, () => r()));
}

let inboundSeq = 0;
function inbound(content = 'what is your return policy?'): ConversationMessage {
  inboundSeq += 1;
  return {
    id: `rl-inbound-${inboundSeq}`,
    conversation_id: conversation.id,
    tenant_id: tenantId,
    role: 'user',
    content,
    dedupe_key: `rl-inbound-${inboundSeq}`,
    raw: null,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
  };
}

const modelCalls = (events: TurnTraceEvent[]) => events.filter((e) => e.t === 'model_call');

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://localhost:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `reasoning-leak-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Leak IT', email, password: 'integration-pw-1', organizationName: 'Leak Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  const create = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: 'rl-agent',
      name: 'Reasoning Leak Agent',
      runtime: 'managed',
      model: 'glm-4-test',
      llm: { apiKey: 'rl-key-123456', baseUrl: llmBaseUrl },
    },
  });
  expect(create.statusCode).toBe(201);

  const { rows: agentRows } = await pool.query(
    'select id from agents where tenant_id = $1 and identifier = $2',
    [tenantId, 'rl-agent'],
  );
  const agentId = agentRows[0].id;

  const { rows: subRows } = await pool.query(
    `insert into subscribers (tenant_id, external_id) values ($1, 'rl-sub') returning id`,
    [tenantId],
  );
  const { rows: convRows } = await pool.query(
    `insert into conversations (tenant_id, agent_id, subscriber_id, thread_key, channel)
     values ($1, $2, $3, 'rl-sub', 'inapp') returning id`,
    [tenantId, agentId, subRows[0].id],
  );

  agent = (await getAgentById(agentId))!;
  conversation = (await getConversation(tenantId, convRows[0].id))!;
  subscriber = (await getSubscriberById(subRows[0].id))!;
});

afterAll(async () => {
  llmStub?.close();
  await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('runManagedTurn reasoning-leak guard', () => {
  test('leak then clean answer on retry -> customer gets the clean answer; 2 calls + leak flag', async () => {
    llmQueue = [text(BUG_LEAK), text(CLEAN_ANSWER)];
    const msg = inbound();
    const res = await runManagedTurn(agent, conversation, subscriber, [], msg);

    // The customer never sees the leak — the corrective re-ask's clean reply wins.
    expect(res.reply).toBe(CLEAN_ANSWER);
    expect(res.platformNote).toBeUndefined();

    // Trace shows exactly 2 model calls (the leak + the corrective re-ask).
    expect(modelCalls(res.trace.events)).toHaveLength(2);

    // The leak was recorded as a persisted breadcrumb raw flag (Turn Inspector).
    const flag = await pool.query<{ raw: { reasoningLeak?: boolean }; content: string }>(
      `select raw, content from conversation_messages
         where conversation_id = $1 and role = 'system' and dedupe_key = $2`,
      [conversation.id, `signal-${msg.id}-reasoning-leak-1`],
    );
    expect(flag.rows).toHaveLength(1);
    expect(flag.rows[0].raw.reasoningLeak).toBe(true);
  });

  test('leak twice -> deterministic fallback note, reported platformNote:true', async () => {
    llmQueue = [text(BUG_LEAK), text(BUG_LEAK)];
    const msg = inbound();
    const res = await runManagedTurn(agent, conversation, subscriber, [], msg);

    // The retry also leaked -> ship the safe fallback, never the leak.
    expect(res.reply).toBe(FALLBACK);
    expect(res.platformNote).toBe(true);
    expect(res.note).toContain('reasoning leak');

    // Exactly one corrective re-ask was made (2 model calls total, then stop).
    expect(modelCalls(res.trace.events)).toHaveLength(2);

    // Both attempts recorded a leak breadcrumb (call 1 and call 2).
    const flags = await pool.query(
      `select 1 from conversation_messages
         where conversation_id = $1 and role = 'system'
           and dedupe_key like $2 and raw->>'reasoningLeak' = 'true'`,
      [conversation.id, `signal-${msg.id}-reasoning-leak-%`],
    );
    expect(flags.rows.length).toBe(2);
  });

  test('a clean reply is untouched (no leak, no extra calls, no flag)', async () => {
    llmQueue = [text(CLEAN_ANSWER)];
    const msg = inbound();
    const res = await runManagedTurn(agent, conversation, subscriber, [], msg);
    expect(res.reply).toBe(CLEAN_ANSWER);
    expect(res.platformNote).toBeUndefined();
    expect(modelCalls(res.trace.events)).toHaveLength(1);
    const flag = await pool.query(
      `select 1 from conversation_messages
         where conversation_id = $1 and role = 'system' and dedupe_key like $2`,
      [conversation.id, `signal-${msg.id}-reasoning-leak-%`],
    );
    expect(flag.rows.length).toBe(0);
  });
});
