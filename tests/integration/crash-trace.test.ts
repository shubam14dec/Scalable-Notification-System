/**
 * Crashed-turn traces (Phase A13, slice A): a turn that DIES leaves the partial
 * trace behind — how far it got, plus what killed it.
 *
 * Both runtimes are driven through the real conversation processor:
 *   • a PermanentError (config-shaped) lands the partial trace on the turn's
 *     system note, under the same raw.trace key a successful turn uses;
 *   • a transient failure on the job's FINAL attempt lands it on the dead note,
 *     under the same `dead-<messageId>` dedupe key the DLQ hook uses — so the
 *     DLQ hook's own insert no-ops and the transcript shows exactly one;
 *   • a non-final attempt writes nothing, so retry-then-succeed is untouched;
 *   • the success path still carries a trace with no error event.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { PermanentError } from '../../src/shared/errors';
import {
  attachPartialTrace,
  partialTraceOf,
  type TurnTrace,
  type TurnTraceEvent,
} from '../../src/core/managed-brain';
import {
  processConversation,
  onConversationDead,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';

const json = (res: { body: string }) => JSON.parse(res.body);
const DEAD_NOTE = 'agent unreachable — this message was not answered';

// ---- stub Anthropic-compatible model server ----
// `failFrom` is the 1-based model call at which the stub starts answering
// `failStatus` forever (the SDK retries 5xx internally, so a sticky failure is
// the only honest way to simulate an outage).
let llmStub: Server;
let llmBaseUrl = '';
let llmQueue: unknown[] = [];
let llmCalls = 0;
let failFrom = 0;
let failStatus = 400;

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
const llmText = (text: string) => envelope([{ type: 'text', text }], 'end_turn');
const llmToolUse = (id: string, name: string, input: unknown) =>
  envelope([{ type: 'tool_use', id, name, input }], 'tool_use');

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      llmCalls += 1;
      res.setHeader('content-type', 'application/json');
      if (failFrom > 0 && llmCalls >= failFrom) {
        res.statusCode = failStatus;
        res.end(JSON.stringify({ type: 'error', error: { type: 'stub_error', message: 'stub failure' } }));
        return;
      }
      res.end(JSON.stringify(llmQueue.length > 0 ? llmQueue.shift() : llmText('default reply')));
    });
  });
  return new Promise((r) => llmStub.listen(0, () => r()));
}

// ---- stub bridge server (status is per-test) ----
let bridge: Server;
let bridgeUrl = '';
let bridgeStatus = 200;
function startBridge(): Promise<void> {
  bridge = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(Buffer.from(c as Uint8Array)));
    req.on('end', () => {
      res.statusCode = bridgeStatus;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(bridgeStatus === 200 ? { reply: 'bridge reply', signals: [] } : { error: 'boom' }));
    });
  });
  return new Promise((r) => bridge.listen(0, () => r()));
}

async function send(identifier: string, subscriberId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  expect(res.statusCode).toBe(202);
  return json(res) as { conversationId: string; messageId: string };
}

/** A turn job whose attempt position is explicit — the whole point of A13's write. */
function turnJob(
  conversationId: string,
  messageId: string,
  attemptsMade: number,
  attempts = 5,
): Job<ConversationJobData> {
  return {
    data: { tenantId, conversationId, messageId },
    attemptsMade,
    opts: { attempts },
  } as Job<ConversationJobData>;
}

async function rowByDedupe(conversationId: string, dedupeKey: string) {
  const { rows } = await pool.query(
    'select role, content, raw from conversation_messages where conversation_id = $1 and dedupe_key = $2',
    [conversationId, dedupeKey],
  );
  return rows[0] as { role: string; content: string; raw: Record<string, unknown> | null } | undefined;
}

async function countRows(conversationId: string, content: string): Promise<number> {
  const { rows } = await pool.query(
    'select count(*)::int as n from conversation_messages where conversation_id = $1 and content = $2',
    [conversationId, content],
  );
  return rows[0].n as number;
}

const traceOf = (raw: Record<string, unknown> | null | undefined) => raw?.trace as TurnTrace | undefined;
const kinds = (trace: TurnTrace) => trace.events.map((e) => e.t);
const errorEvent = (trace: TurnTrace) =>
  trace.events.find((e): e is Extract<TurnTraceEvent, { t: 'error' }> => e.t === 'error');

beforeAll(async () => {
  await startLlmStub();
  await startBridge();
  llmBaseUrl = `http://localhost:${(llmStub.address() as AddressInfo).port}`;
  bridgeUrl = `http://localhost:${(bridge.address() as AddressInfo).port}/`;

  app = await buildApp();
  const email = `crash-trace-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Crash Trace IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Crash Trace Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  for (const payload of [
    {
      identifier: 'ct-managed',
      name: 'CT Managed',
      runtime: 'managed',
      model: 'glm-4-test',
      llm: { apiKey: 'ct-key-123456', baseUrl: llmBaseUrl },
    },
    { identifier: 'ct-bridge', name: 'CT Bridge', bridgeUrl },
    { identifier: 'ct-nourl', name: 'CT No URL', bridgeUrl },
  ]) {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-api-key': apiKey },
      payload,
    });
    expect(res.statusCode).toBe(201);
  }
  // A bridge agent whose URL went missing after creation: the one failure that
  // is refused BEFORE anything is dialed.
  await pool.query('update agents set bridge_url = null where tenant_id = $1 and identifier = $2', [
    tenantId,
    'ct-nourl',
  ]);
});

afterAll(async () => {
  bridge?.close();
  llmStub?.close();
  await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('the partial-trace carrier', () => {
  test('an error keeps its class and message; a plain error carries no trace', () => {
    const err = attachPartialTrace(new PermanentError('config is wrong'), {
      totalMs: 3,
      events: [{ t: 'error', atMs: 3, message: 'config is wrong' }],
    });
    expect(err).toBeInstanceOf(PermanentError);
    expect(err.message).toBe('config is wrong');
    // Symbol-keyed and non-enumerable: nothing that logs an error starts
    // emitting a whole trace.
    expect(Object.keys(err)).not.toContain('trace');
    expect(JSON.stringify({ ...err })).not.toContain('atMs');
    expect(partialTraceOf(err)?.events).toHaveLength(1);
    expect(partialTraceOf(new Error('untraced'))).toBeUndefined();
    expect(partialTraceOf('not an error')).toBeUndefined();
  });
});

describe('managed turn crashes', () => {
  test('a PermanentError note carries the completed model calls plus a trailing error event', async () => {
    llmCalls = 0;
    failFrom = 2; // round 1 succeeds (a tool round), round 2 is a config 400
    failStatus = 400;
    llmQueue = [llmToolUse('ct1', 'present_buttons', { buttons: [{ id: 'a', label: 'A' }] })];

    const turn = await send('ct-managed', 'ct-sub-1', 'crash me', 'ct-1');
    // A PermanentError is handled in-band: the processor returns normally.
    await processConversation(turnJob(turn.conversationId, turn.messageId, 0));

    const note = await rowByDedupe(turn.conversationId, `signal-${turn.messageId}-0`);
    expect(note?.role).toBe('system');
    expect(note?.content).toMatch(/brain config error \(400\)/);
    const trace = traceOf(note?.raw)!;
    expect(trace).toBeDefined();
    expect(note?.raw?.crashed).toBe(true);
    // How far it got: a completed tool round, then the failed call, then death.
    expect(kinds(trace)).toEqual(['model_call', 'tool_call', 'model_call', 'error']);
    expect(trace.events[0]).toMatchObject({ t: 'model_call', stopReason: 'tool_use', inputTokens: 10 });
    expect(trace.events[2]).toMatchObject({ t: 'model_call', stopReason: 'error' });
    expect(errorEvent(trace)!.message).toMatch(/brain config error \(400\)/);
    expect(errorEvent(trace)!.atMs).toBeGreaterThanOrEqual(0);
    // A crashed turn writes NO reply row.
    expect(await rowByDedupe(turn.conversationId, `reply-${turn.messageId}`)).toBeUndefined();
  });

  test('a transient failure on the FINAL attempt writes the dead note with the partial trace', async () => {
    llmCalls = 0;
    failFrom = 1; // the whole turn is an outage
    failStatus = 529;
    llmQueue = [];

    const turn = await send('ct-managed', 'ct-sub-2', 'outage', 'ct-2');
    // The job must still FAIL — BullMQ's accounting stays truthful.
    await expect(
      processConversation(turnJob(turn.conversationId, turn.messageId, 4)),
    ).rejects.toThrow(/brain call failed/);

    const dead = await rowByDedupe(turn.conversationId, `dead-${turn.messageId}`);
    expect(dead?.role).toBe('system');
    expect(dead?.content).toBe(DEAD_NOTE);
    expect(dead?.raw?.crashed).toBe(true);
    const trace = traceOf(dead?.raw)!;
    expect(kinds(trace)).toEqual(['model_call', 'error']);
    expect(trace.events[0]).toMatchObject({ t: 'model_call', stopReason: 'error' });
    expect(errorEvent(trace)!.message).toMatch(/brain call failed/);
  });

  test('the DLQ hook adds no second dead note over the traced one', async () => {
    llmCalls = 0;
    failFrom = 1;
    failStatus = 529;
    llmQueue = [];

    const turn = await send('ct-managed', 'ct-sub-3', 'outage then dlq', 'ct-3');
    await expect(
      processConversation(turnJob(turn.conversationId, turn.messageId, 4)),
    ).rejects.toThrow();

    await onConversationDead({
      data: { tenantId, conversationId: turn.conversationId, messageId: turn.messageId },
    } as Job);

    expect(await countRows(turn.conversationId, DEAD_NOTE)).toBe(1);
    // And the row that survived is the one carrying the trace.
    const dead = await rowByDedupe(turn.conversationId, `dead-${turn.messageId}`);
    expect(traceOf(dead?.raw)).toBeDefined();
  });

  test('retry-then-succeed leaves no crash note and replies normally', async () => {
    llmCalls = 0;
    failFrom = 1;
    failStatus = 529;
    llmQueue = [];

    const turn = await send('ct-managed', 'ct-sub-4', 'flaky', 'ct-4');
    // Attempt 1 of 5: the failure is retryable and nothing is written.
    await expect(
      processConversation(turnJob(turn.conversationId, turn.messageId, 0)),
    ).rejects.toThrow();
    expect(await rowByDedupe(turn.conversationId, `dead-${turn.messageId}`)).toBeUndefined();
    expect(await countRows(turn.conversationId, DEAD_NOTE)).toBe(0);

    // Attempt 2: the provider is back.
    llmCalls = 0;
    failFrom = 0;
    llmQueue = [llmText('recovered on retry')];
    await processConversation(turnJob(turn.conversationId, turn.messageId, 1));

    const reply = await rowByDedupe(turn.conversationId, `reply-${turn.messageId}`);
    expect(reply?.content).toBe('recovered on retry');
    expect(reply?.raw?.crashed).toBeUndefined();
    // The success path is untouched: a trace, and no error event in it.
    const trace = traceOf(reply?.raw)!;
    expect(kinds(trace)).toEqual(['model_call']);
    expect(errorEvent(trace)).toBeUndefined();
    expect(await rowByDedupe(turn.conversationId, `signal-${turn.messageId}-0`)).toBeUndefined();
  });
});

describe('bridge turn crashes', () => {
  test('a non-2xx on the final attempt lands the attempted bridge_post plus the error', async () => {
    bridgeStatus = 500;
    const turn = await send('ct-bridge', 'ct-bridge-sub-1', 'hi bridge', 'ct-b-1');
    await expect(
      processConversation(turnJob(turn.conversationId, turn.messageId, 4)),
    ).rejects.toThrow(/bridge responded 500/);
    bridgeStatus = 200;

    const dead = await rowByDedupe(turn.conversationId, `dead-${turn.messageId}`);
    expect(dead?.content).toBe(DEAD_NOTE);
    expect(dead?.raw?.crashed).toBe(true);
    const trace = traceOf(dead?.raw)!;
    expect(kinds(trace)).toEqual(['bridge_post', 'error']);
    expect(trace.events[0]).toMatchObject({ t: 'bridge_post', status: 500, ok: false });
    // The endpoint never appears in a trace — not on success, not on failure.
    expect(JSON.stringify(trace)).not.toContain('localhost');
    expect(errorEvent(trace)!.message).toMatch(/bridge responded 500/);
  });

  test('a non-2xx on a NON-final attempt writes nothing (the retry may still win)', async () => {
    bridgeStatus = 500;
    const turn = await send('ct-bridge', 'ct-bridge-sub-2', 'flaky bridge', 'ct-b-2');
    await expect(
      processConversation(turnJob(turn.conversationId, turn.messageId, 1)),
    ).rejects.toThrow(/bridge responded 500/);
    bridgeStatus = 200;

    expect(await rowByDedupe(turn.conversationId, `dead-${turn.messageId}`)).toBeUndefined();
    expect(await rowByDedupe(turn.conversationId, `signal-${turn.messageId}-0`)).toBeUndefined();
  });

  test('a config fault that never dialed traces the error alone — no invented POST', async () => {
    const turn = await send('ct-nourl', 'ct-nourl-sub', 'no url', 'ct-b-3');
    // PermanentError: handled in-band, no throw.
    await processConversation(turnJob(turn.conversationId, turn.messageId, 0));

    const note = await rowByDedupe(turn.conversationId, `signal-${turn.messageId}-0`);
    expect(note?.content).toMatch(/has no bridge URL/);
    expect(note?.raw?.crashed).toBe(true);
    const trace = traceOf(note?.raw)!;
    expect(kinds(trace)).toEqual(['error']);
    expect(errorEvent(trace)!.message).toMatch(/has no bridge URL/);
  });
});
