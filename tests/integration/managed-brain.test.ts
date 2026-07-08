/**
 * Managed LLM brain integration: real app + real conversation core + the
 * real @anthropic-ai/sdk pointed (via the agent's llm_base_url — the same
 * field a customer uses for an Anthropic-compatible provider) at a stub
 * Messages API. Only the model server is fake.
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
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';

// ---- stub Anthropic-compatible server ----
let llmStub: Server;
let llmBaseUrl = '';
interface SeenRequest {
  apiKey: string | undefined;
  body: {
    model: string;
    system?: string;
    max_tokens: number;
    messages: Array<{ role: string; content: string }>;
  };
}
const seen: SeenRequest[] = [];
/** Behavior switch per test: 'ok' | 'refusal' | 'auth' | 'overloaded'. */
let stubMode: 'ok' | 'refusal' | 'auth' | 'overloaded' = 'ok';

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as SeenRequest['body'];
      seen.push({ apiKey: req.headers['x-api-key'] as string | undefined, body });
      res.setHeader('content-type', 'application/json');
      if (stubMode === 'auth') {
        res.statusCode = 401;
        res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
        return;
      }
      if (stubMode === 'overloaded') {
        res.statusCode = 529;
        res.end(JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'overloaded' } }));
        return;
      }
      const refusal = stubMode === 'refusal';
      res.end(
        JSON.stringify({
          id: 'msg_stub_1',
          type: 'message',
          role: 'assistant',
          model: body.model,
          content: refusal ? [] : [{ type: 'text', text: `echo(${body.messages.at(-1)?.content})` }],
          stop_reason: refusal ? 'refusal' : 'end_turn',
          stop_sequence: null,
          usage: { input_tokens: 10, output_tokens: 5 },
        }),
      );
    });
  });
  return new Promise((r) => llmStub.listen(0, () => r()));
}

const json = (res: { body: string }) => JSON.parse(res.body);

async function sendTurn(text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents/glm-support/messages',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId: 'ana', text, messageId },
  });
  return json(res) as { conversationId: string; messageId: string };
}

async function transcript(conversationId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/conversations/${conversationId}`,
    headers: { 'x-api-key': apiKey },
  });
  return json(res);
}

async function runWorker(conversationId: string, messageId: string) {
  const data: ConversationJobData = { tenantId, conversationId, messageId };
  await processConversation({ data } as Job<ConversationJobData>);
}

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://localhost:${(llmStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `brain-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Brain IT', email, password: 'integration-pw-1', organizationName: 'Brain IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;
});

afterAll(async () => {
  llmStub?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('managed agent management', () => {
  test('create requires an apiKey for the managed runtime', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-api-key': apiKey },
      payload: { identifier: 'glm-support', name: 'GLM Support', runtime: 'managed' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('creates a managed agent; the key never comes back', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-api-key': apiKey },
      payload: {
        identifier: 'glm-support',
        name: 'GLM Support',
        runtime: 'managed',
        model: 'glm-4-test',
        systemPrompt: 'You are the Acme support agent. Be brief.',
        llm: { apiKey: 'zai-test-key-123456', baseUrl: llmBaseUrl },
      },
    });
    expect(res.statusCode).toBe(201);
    const view = json(res).agent;
    expect(view.runtime).toBe('managed');
    expect(view.model).toBe('glm-4-test');
    expect(view.llmBaseUrl).toBe(llmBaseUrl);
    expect(view.hasLlmKey).toBe(true);
    expect(JSON.stringify(json(res))).not.toContain('zai-test-key');
  });

  test('bridge runtime still requires a bridgeUrl', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-api-key': apiKey },
      payload: { identifier: 'plain-bridge', name: 'Plain', runtime: 'bridge' },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('the managed turn', () => {
  let conversationId = '';

  test('system prompt + history reach the model; reply lands in the transcript', async () => {
    const t1 = await sendTurn('hello there', 'brain-1');
    conversationId = t1.conversationId;
    await runWorker(t1.conversationId, t1.messageId);

    const t2 = await sendTurn('and again', 'brain-2');
    await runWorker(t2.conversationId, t2.messageId);

    const last = seen.at(-1)!;
    expect(last.apiKey).toBe('zai-test-key-123456');
    expect(last.body.model).toBe('glm-4-test');
    expect(last.body.system).toBe('You are the Acme support agent. Be brief.');
    // Second turn carries the full history: user, assistant, then the new turn.
    expect(last.body.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(last.body.messages.at(-1)?.content).toBe('and again');

    const t = await transcript(conversationId);
    const replies = t.messages.filter((m: { role: string }) => m.role === 'agent');
    expect(replies.at(-1).content).toBe('echo(and again)');
  });

  test('a re-run job cannot duplicate the reply', async () => {
    const before = (await transcript(conversationId)).messages.length;
    const turn = await sendTurn('re-run me', 'brain-3');
    await runWorker(turn.conversationId, turn.messageId);
    await runWorker(turn.conversationId, turn.messageId);
    const after = (await transcript(conversationId)).messages.length;
    expect(after).toBe(before + 2); // one user turn + one reply
  });

  test('a refusal becomes a visible breadcrumb, not a reply', async () => {
    stubMode = 'refusal';
    const turn = await sendTurn('something refused', 'brain-4');
    await runWorker(turn.conversationId, turn.messageId);
    stubMode = 'ok';

    const t = await transcript(conversationId);
    const system = t.messages.filter((m: { role: string }) => m.role === 'system');
    expect(system.at(-1).content).toContain('declined');
    const replies = t.messages.filter((m: { role: string }) => m.role === 'agent');
    expect(replies.at(-1).content).not.toContain('something refused');
  });

  test('a bad key is a breadcrumb and does NOT retry', async () => {
    stubMode = 'auth';
    const callsBefore = seen.length;
    const turn = await sendTurn('who am i', 'brain-5');
    // Must resolve (no throw) — a config error should never DLQ-loop.
    await runWorker(turn.conversationId, turn.messageId);
    stubMode = 'ok';

    // SDK maxRetries=1 means at most 2 calls; 401 is not retried by the SDK.
    expect(seen.length - callsBefore).toBe(1);
    const t = await transcript(conversationId);
    const system = t.messages.filter((m: { role: string }) => m.role === 'system');
    expect(system.at(-1).content).toContain('brain config error');
  });

  test('an overloaded model throws so BullMQ retries', async () => {
    stubMode = 'overloaded';
    const turn = await sendTurn('busy time', 'brain-6');
    await expect(runWorker(turn.conversationId, turn.messageId)).rejects.toThrow(/brain call failed/);
    stubMode = 'ok';
    // The retry then succeeds and the reply is delivered exactly once.
    await runWorker(turn.conversationId, turn.messageId);
    const t = await transcript(conversationId);
    const replies = t.messages.filter((m: { role: string }) => m.role === 'agent');
    expect(replies.at(-1).content).toBe('echo(busy time)');
  });
});
