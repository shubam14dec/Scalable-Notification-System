/**
 * Turn-trace unit coverage (Phase 21, slice D): runManagedTurn is driven
 * directly against a stub Anthropic Messages API (the agent's llm_base_url) and
 * the returned TurnTrace is asserted on every exit — plain reply, tool round,
 * refusal, loop-limit, failing tool, and an approval-paused tool. The turn is
 * called with a real tenant/agent/conversation (so DB-touching tool paths run),
 * but the assertions are on the in-memory trace the function returns, not on
 * persistence (slice D's integration file owns that).
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
import { runManagedTurn, type TurnTraceEvent } from '../../src/core/managed-brain';
import {
  getAgentById,
  getConversation,
  getSubscriberById,
  type Agent,
  type Conversation,
  type ConversationMessage,
} from '../../src/db/conversations.repo';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let agent: Agent;
let conversation: Conversation;
let subscriber: NonNullable<Awaited<ReturnType<typeof getSubscriberById>>>;
const GATED_TOOL = 'gated_action';

const json = (res: { body: string }) => JSON.parse(res.body);

// ---- stub Anthropic-compatible model server ----
let llmStub: Server;
let llmBaseUrl = '';
let llmQueue: unknown[] = [];
/** When set, every model call answers 529 so the SDK retries once then throws. */
let throwMode = false;
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
const toolUse = (uses: Array<{ id: string; name: string; input: unknown }>) =>
  envelope(uses.map((u) => ({ type: 'tool_use', ...u })), 'tool_use');
const text = (t: string) => envelope([{ type: 'text', text: t }], 'end_turn');

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (throwMode) {
        res.statusCode = 529;
        res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }));
        return;
      }
      res.end(JSON.stringify(llmQueue.length > 0 ? llmQueue.shift() : text('default reply')));
    });
  });
  return new Promise((r) => llmStub.listen(0, () => r()));
}

let inboundSeq = 0;
/** A synthetic inbound user turn — id only feeds dedupe keys, not an FK. */
function inbound(content = 'hello'): ConversationMessage {
  inboundSeq += 1;
  return {
    id: `tt-inbound-${inboundSeq}`,
    conversation_id: conversation.id,
    tenant_id: tenantId,
    role: 'user',
    content,
    dedupe_key: `tt-inbound-${inboundSeq}`,
    raw: null,
    created_at: new Date().toISOString(),
    edited_at: null,
    deleted_at: null,
    deleted_by: null,
  };
}

const modelCalls = (events: TurnTraceEvent[]) => events.filter((e) => e.t === 'model_call');
const toolCalls = (events: TurnTraceEvent[]) => events.filter((e) => e.t === 'tool_call');

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://localhost:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `turn-trace-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Turn Trace IT', email, password: 'integration-pw-1', organizationName: 'Turn Trace Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  const create = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: 'tt-agent',
      name: 'Turn Trace Agent',
      runtime: 'managed',
      model: 'glm-4-test',
      llm: { apiKey: 'tt-key-123456', baseUrl: llmBaseUrl },
    },
  });
  expect(create.statusCode).toBe(201);

  const { rows: agentRows } = await pool.query('select id from agents where tenant_id = $1 and identifier = $2', [
    tenantId,
    'tt-agent',
  ]);
  const agentId = agentRows[0].id;

  // A required-approval custom tool so the paused branch can run for real.
  const tool = await app.inject({
    method: 'POST',
    url: '/v1/agents/tt-agent/tools',
    headers: { 'x-api-key': apiKey },
    payload: {
      name: GATED_TOOL,
      description: 'A gated action that needs approval',
      parameters: { type: 'object', properties: { orderId: { type: 'string' } } },
      endpointUrl: 'http://localhost:9/tool',
      approval: 'required',
    },
  });
  expect(tool.statusCode).toBe(201);

  const { rows: subRows } = await pool.query(
    `insert into subscribers (tenant_id, external_id) values ($1, 'tt-sub') returning id`,
    [tenantId],
  );
  const { rows: convRows } = await pool.query(
    `insert into conversations (tenant_id, agent_id, subscriber_id, thread_key, channel)
     values ($1, $2, $3, 'tt-sub', 'inapp') returning id`,
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

describe('runManagedTurn trace', () => {
  test('(a) a plain reply traces one end_turn model_call with the stub token counts', async () => {
    llmQueue = [text('hi there')];
    const res = await runManagedTurn(agent, conversation, subscriber, [], inbound());
    expect(res.reply).toBe('hi there');
    expect(res.trace.totalMs).toBeGreaterThanOrEqual(0);
    expect(res.trace.events).toHaveLength(1);
    const mc = res.trace.events[0];
    expect(mc).toMatchObject({
      t: 'model_call',
      stopReason: 'end_turn',
      inputTokens: 10,
      outputTokens: 5,
      model: 'glm-4-test',
    });
    expect((mc as { ms: number }).ms).toBeGreaterThanOrEqual(0);
  });

  test('(b) a tool round traces model_call(tool_use) → tool_calls (order kept) → model_call(end_turn)', async () => {
    llmQueue = [
      toolUse([
        { id: 'tb1', name: 'present_buttons', input: { buttons: [{ id: 'a', label: 'A' }] } },
        { id: 'tb2', name: 'present_choices', input: { id: 'p', options: [{ id: 'x', label: 'X' }, { id: 'y', label: 'Y' }] } },
      ]),
      text('done'),
    ];
    const res = await runManagedTurn(agent, conversation, subscriber, [], inbound());
    expect(res.reply).toBe('done');
    expect(res.trace.events.map((e) => e.t)).toEqual(['model_call', 'tool_call', 'tool_call', 'model_call']);
    expect(res.trace.events[0]).toMatchObject({ t: 'model_call', stopReason: 'tool_use' });
    // Tool events preserve the order the model requested them.
    expect(toolCalls(res.trace.events).map((e) => (e as { name: string }).name)).toEqual([
      'present_buttons',
      'present_choices',
    ]);
    expect(toolCalls(res.trace.events).every((e) => (e as { ok: boolean }).ok)).toBe(true);
    expect(res.trace.events[3]).toMatchObject({ t: 'model_call', stopReason: 'end_turn' });
  });

  test('(c) a refusal exit still carries a trace whose model_call stopReason is "refusal"', async () => {
    llmQueue = [envelope([], 'refusal')];
    const res = await runManagedTurn(agent, conversation, subscriber, [], inbound());
    expect(res.reply).toBeNull();
    expect(res.note).toContain('declined');
    expect(res.trace.events).toHaveLength(1);
    expect(res.trace.events[0]).toMatchObject({ t: 'model_call', stopReason: 'refusal' });
  });

  test('(d) the loop-limit exit carries a trace with exactly 5 model_call events', async () => {
    llmQueue = Array.from({ length: 5 }, (_, i) =>
      toolUse([{ id: `td${i}`, name: 'present_buttons', input: { buttons: [{ id: 'a', label: 'A' }] } }]),
    );
    const res = await runManagedTurn(agent, conversation, subscriber, [], inbound());
    expect(res.note).toContain('tool loop limit');
    expect(modelCalls(res.trace.events)).toHaveLength(5); // hard ceiling
    // Rounds 1-4 executed their tool; the 5th short-circuits before executing.
    expect(toolCalls(res.trace.events)).toHaveLength(4);
    expect(res.trace.totalMs).toBeGreaterThanOrEqual(0);
  });

  test('(e) a failing tool traces a tool_call with ok:false and the model recovers', async () => {
    llmQueue = [
      toolUse([{ id: 'te1', name: 'present_buttons', input: { buttons: [] } }]), // empty set -> is_error
      text('recovered'),
    ];
    const res = await runManagedTurn(agent, conversation, subscriber, [], inbound());
    expect(res.reply).toBe('recovered');
    const tool = toolCalls(res.trace.events)[0];
    expect(tool).toMatchObject({ t: 'tool_call', name: 'present_buttons', ok: false });
  });

  test('(f) an approval-paused tool traces tool_call.paused:true and the paused note carries the trace', async () => {
    llmQueue = [toolUse([{ id: 'tf1', name: GATED_TOOL, input: { orderId: '123' } }])];
    const res = await runManagedTurn(agent, conversation, subscriber, [], inbound());
    expect(res.reply).toContain('asked a teammate');
    const tool = toolCalls(res.trace.events)[0];
    expect(tool).toMatchObject({ t: 'tool_call', name: GATED_TOOL, ok: true, paused: true });
    // The paused exit still returns a trace (model round + the paused tool).
    expect(modelCalls(res.trace.events)).toHaveLength(1);
    expect(res.trace.totalMs).toBeGreaterThanOrEqual(0);
  });

  test('(g) a transient model failure propagates; the trace is not returned on a thrown turn', async () => {
    // The catch block pushes a failed model_call event onto the trace, but the
    // turn rethrows (TransientError) — so no trace is returned here. A thrown
    // turn's trace survives only if a later persist point runs, and a crash has
    // none (managed-brain D7). We assert the propagation; there is nothing to
    // skip — this path is reachable.
    throwMode = true;
    try {
      await expect(runManagedTurn(agent, conversation, subscriber, [], inbound())).rejects.toThrow(/brain call failed/);
    } finally {
      throwMode = false;
    }
  });
});
