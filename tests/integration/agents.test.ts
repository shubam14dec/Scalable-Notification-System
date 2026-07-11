/**
 * Conversations/Agents integration: the real Fastify app in-process + the
 * real @asyncify-hq/agent SDK serving as the bridge, with the conversation
 * processor invoked directly (tests run without the worker fleet). This is
 * the full two-way loop: inbound turn → signed dispatch → reply + signals
 * applied — exactly what production does, minus the queue hop.
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
import { createHandler, defineAgent } from '../../packages/agent/src/index';

let app: FastifyInstance;
let bridge: Server;
let bridgeUrl = '';
let apiKey = '';
let tenantId = '';
let signingSecret = '';

const email = `agents-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
const json = (res: { body: string }) => JSON.parse(res.body);

/** The customer-side brain, built with the real SDK. */
const brain = defineAgent({
  onMessage(ctx) {
    const text = ctx.message.text.toLowerCase();
    if (text.includes('order')) {
      ctx.metadata.set('topic', 'missing-order');
      ctx.trigger('itest-workflow', { payload: { name: 'Ana' } });
      return 'Replacement on the way!';
    }
    if (text.includes('options')) {
      ctx.reply('Pick one:', {
        buttons: [
          { id: 'resend', label: 'Resend email' },
          { id: 'human', label: 'Talk to human' },
        ],
      });
      return;
    }
    if (text.includes('thanks')) {
      ctx.resolve('handled');
      return 'Anytime!';
    }
    return `heard: ${ctx.message.text} (history ${ctx.history.length})`;
  },
  onAction(ctx) {
    return `clicked:${ctx.action?.id}:${ctx.message.text}`;
  },
});

async function runWorkerFor(send: { conversationId: string; messageId: string }) {
  const data: ConversationJobData = { tenantId, ...send };
  await processConversation({ data } as Job<ConversationJobData>);
}

async function sendTurn(text: string, messageId?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents/itest-support/messages',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId: 'ana', text, ...(messageId ? { messageId } : {}) },
  });
  return { status: res.statusCode, body: json(res) };
}

async function transcript(conversationId: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/conversations/${conversationId}`,
    headers: { 'x-api-key': apiKey },
  });
  return json(res);
}

beforeAll(async () => {
  app = await buildApp();

  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Agents IT', email, password: 'integration-pw-1', organizationName: 'Agents IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  // A workflow for the brain's ctx.trigger to hit (inapp: no provider needed).
  await app.inject({
    method: 'PUT',
    url: '/v1/workflows',
    headers: { 'x-api-key': apiKey },
    payload: {
      key: 'itest-workflow',
      name: 'IT workflow',
      steps: [{ channel: 'inapp', subject: 'Hi {{name}}', body: 'Replacement for {{name}}' }],
    },
  });

  bridge = createServer((req, res) =>
    createHandler(brain, { signingSecret })(req, res),
  );
  await new Promise<void>((r) => bridge.listen(0, r));
  bridgeUrl = `http://localhost:${(bridge.address() as AddressInfo).port}/`;
});

afterAll(async () => {
  bridge?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('agent management', () => {
  test('create returns the secret exactly once; reads never leak it', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-api-key': apiKey },
      payload: { identifier: 'itest-support', name: 'IT Support', bridgeUrl },
    });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.signingSecret).toMatch(/^ags_[0-9a-f]{48}$/);
    signingSecret = body.signingSecret;

    const list = await app.inject({
      method: 'GET',
      url: '/v1/agents',
      headers: { 'x-api-key': apiKey },
    });
    expect(JSON.stringify(json(list))).not.toContain('ags_');
  });

  test('duplicate identifier is rejected', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-api-key': apiKey },
      payload: { identifier: 'itest-support', name: 'Again', bridgeUrl },
    });
    expect(res.statusCode).toBe(409);
  });

  test('SSRF guard rejects private bridge URLs on create and patch', async () => {
    for (const url of [
      'http://192.168.1.1/bridge',
      'http://169.254.169.254/latest/meta-data/',
      'http://10.0.0.5:4100/',
      'http://internal-api.internal/',
      'http://user:pass@example.com/',
    ]) {
      const res = await app.inject({
        method: 'POST',
        url: '/v1/agents',
        headers: { 'x-api-key': apiKey },
        payload: { identifier: 'itest-ssrf', name: 'SSRF', bridgeUrl: url },
      });
      expect(res.statusCode, url).toBe(400);
      expect(json(res).error).toContain('bridgeUrl');
    }

    const patched = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/itest-support',
      headers: { 'x-api-key': apiKey },
      payload: { bridgeUrl: 'http://127.0.0.2:6379/' },
    });
    expect(patched.statusCode).toBe(400);
  });

  test('SSRF guard rejects a private llm.baseUrl on create', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-api-key': apiKey },
      payload: {
        identifier: 'itest-ssrf-llm',
        name: 'SSRF LLM',
        runtime: 'managed',
        llm: { apiKey: 'sk-test-123', baseUrl: 'http://169.254.169.254/v1' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toContain('llmBaseUrl');
  });

  test('SSRF guard rejects a private SMTP host on integration create', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/integrations',
      headers: { 'x-api-key': apiKey },
      payload: {
        channel: 'email',
        provider: 'smtp',
        credentials: { host: '192.168.0.10', port: 587, from: 'x@example.com' },
      },
    });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toContain('credentials.host');
  });

  test('allowlisted localhost bridge URLs still work (dev path)', async () => {
    // bridgeUrl above IS localhost — the 201 in the first test proves the
    // allowlist path; this asserts the same explicitly for 127.0.0.1.
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-api-key': apiKey },
      payload: {
        identifier: 'itest-allowlisted',
        name: 'Allowlisted',
        bridgeUrl: bridgeUrl.replace('localhost', '127.0.0.1'),
      },
    });
    expect(res.statusCode).toBe(201);
  });
});

describe('the two-way loop', () => {
  let conversationId = '';

  test('inbound turn is accepted and deduped by client messageId', async () => {
    const first = await sendTurn('hello there', 'turn-1');
    expect(first.status).toBe(202);
    conversationId = first.body.conversationId;

    const dup = await sendTurn('hello there', 'turn-1');
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    expect(dup.body.conversationId).toBe(conversationId);
  });

  test('dispatch delivers the signed event and records the reply', async () => {
    const first = await sendTurn('hello again', 'turn-2');
    await runWorkerFor(first.body);
    const t = await transcript(conversationId);
    const replies = t.messages.filter((m: { role: string }) => m.role === 'agent');
    expect(replies.at(-1).content).toBe('heard: hello again (history 1)');
  });

  test('a re-run job cannot duplicate the reply (dedupe wall)', async () => {
    const before = (await transcript(conversationId)).messages.length;
    const turn = await sendTurn('re-run me', 'turn-3');
    await runWorkerFor(turn.body);
    await runWorkerFor(turn.body); // crash-retry simulation
    const after = (await transcript(conversationId)).messages.length;
    expect(after).toBe(before + 2); // one user turn + one reply, not two replies
  });

  test('signals: metadata lands, trigger creates a real event, breadcrumbs logged', async () => {
    const turn = await sendTurn('where is my order #1042?', 'turn-4');
    await runWorkerFor(turn.body);

    const t = await transcript(conversationId);
    expect(t.conversation.metadata.topic).toBe('missing-order');
    const system = t.messages.filter((m: { role: string }) => m.role === 'system');
    expect(system.at(-1).content).toContain('triggered workflow itest-workflow');

    const txn = `conv-${turn.body.messageId}-2`;
    const event = await app.inject({
      method: 'GET',
      url: `/v1/events/${txn}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(event.statusCode).toBe(200);
    expect(json(event).workflowKey).toBe('itest-workflow');
  });

  test('resolve closes the conversation; a new message reopens it', async () => {
    const thanks = await sendTurn('thanks!', 'turn-5');
    await runWorkerFor(thanks.body);
    let t = await transcript(conversationId);
    expect(t.conversation.status).toBe('resolved');
    expect(t.conversation.summary).toBe('handled');

    const again = await sendTurn('one more thing', 'turn-6');
    expect(again.body.status).toBe('active');
    t = await transcript(conversationId);
    expect(t.conversation.status).toBe('active');
  });
});

describe('buttons + onAction', () => {
  let conversationId = '';

  test('a bridge reply carries buttons end to end', async () => {
    const turn = await sendTurn('show me options', 'btn-1');
    conversationId = turn.body.conversationId;
    await runWorkerFor(turn.body);

    const t = await transcript(conversationId);
    const reply = t.messages.findLast((m: { role: string }) => m.role === 'agent');
    expect(reply.content).toBe('Pick one:');
    expect(reply.buttons).toEqual([
      { id: 'resend', label: 'Resend email' },
      { id: 'human', label: 'Talk to human' },
    ]);
  });

  test('a click flows back as an onAction event with the right id', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/itest-support/actions',
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId: 'ana', actionId: 'resend', label: 'Resend email', actionEventId: 'act-1' },
    });
    expect(res.statusCode).toBe(202);
    const { messageId } = json(res);
    await runWorkerFor({ conversationId, messageId });

    const t = await transcript(conversationId);
    // The click reads naturally in the transcript...
    const clickRow = t.messages.find((m: { id: string }) => m.id === messageId);
    expect(clickRow.content).toBe('Resend email');
    // ...and the bridge's onAction saw the structured action.
    const reply = t.messages.findLast((m: { role: string }) => m.role === 'agent');
    expect(reply.content).toBe('clicked:resend:Resend email');
  });

  test('a double-click is one action', async () => {
    const again = await app.inject({
      method: 'POST',
      url: '/v1/agents/itest-support/actions',
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId: 'ana', actionId: 'resend', label: 'Resend email', actionEventId: 'act-1' },
    });
    expect(json(again).duplicate).toBe(true);
  });
});

describe('widget transcript endpoint', () => {
  test('returns the thread without system rows; token-scoped', async () => {
    const mint = await app.inject({
      method: 'POST',
      url: '/v1/subscriber-tokens',
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId: 'ana' },
    });
    const token = json(mint).token;

    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/itest-support/conversation?subscriberId=ana',
      headers: { 'x-subscriber-token': token },
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.conversation.status).toBeDefined();
    expect(body.messages.length).toBeGreaterThan(0);
    expect(body.messages.every((m: { role: string }) => m.role !== 'system')).toBe(true);

    const other = await app.inject({
      method: 'GET',
      url: '/v1/agents/itest-support/conversation?subscriberId=bob',
      headers: { 'x-subscriber-token': token },
    });
    expect(other.statusCode).toBe(403);
  });

  test('no conversation yet returns an empty thread, not an error', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/itest-support/conversation?subscriberId=never-spoke',
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ conversation: null, messages: [] });
  });
});

describe('subscriber-token inbound auth', () => {
  test('widget credential works and is scoped to its subscriber', async () => {
    const mint = await app.inject({
      method: 'POST',
      url: '/v1/subscriber-tokens',
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId: 'ana' },
    });
    const token = json(mint).token;

    const ok = await app.inject({
      method: 'POST',
      url: '/v1/agents/itest-support/messages',
      headers: { 'x-subscriber-token': token },
      payload: { subscriberId: 'ana', text: 'via widget', messageId: 'turn-7' },
    });
    expect(ok.statusCode).toBe(202);

    const forged = await app.inject({
      method: 'POST',
      url: '/v1/agents/itest-support/messages',
      headers: { 'x-subscriber-token': token },
      payload: { subscriberId: 'bob', text: 'as someone else', messageId: 'turn-8' },
    });
    expect(forged.statusCode).toBe(403);
  });
});
