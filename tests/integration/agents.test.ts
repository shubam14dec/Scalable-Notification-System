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
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, getQueue, QUEUE } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import { createHandler, defineAgent, type ResolveContext } from '../../packages/agent/src/index';

let app: FastifyInstance;
let bridge: Server;
let bridgeUrl = '';
let apiKey = '';
let tenantId = '';
let signingSecret = '';

const email = `agents-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
const json = (res: { body: string }) => JSON.parse(res.body);

/** Captures every onResolve call the brain sees; reset between tests. */
const resolvedContexts: ResolveContext[] = [];

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
  onResolve(ctx) {
    resolvedContexts.push(ctx);
  },
});

beforeEach(() => {
  resolvedContexts.length = 0;
});

async function runWorkerFor(send: { conversationId: string; messageId: string }) {
  const data: ConversationJobData = { tenantId, ...send };
  await processConversation({ data } as Job<ConversationJobData>);
}

/** Fetch a real queued job by its deterministic jobId and run it for real. */
async function runJob(jobId: string) {
  const job = await getQueue(QUEUE.CONVERSATION).getJob(jobId);
  expect(job, `expected queued job ${jobId}`).toBeTruthy();
  await processConversation(job as Job<ConversationJobData>);
  return job!;
}

async function sendTurn(text: string, messageId?: string) {
  return sendTurnAs('ana', text, messageId);
}

/**
 * Thread key = subscriberId (agent+channel+threadKey is the conversation's
 * conflict target) — a distinct subscriberId opens a genuinely separate
 * conversation, which several tests below need to avoid deterministic
 * jobId collisions with the shared 'ana' thread used elsewhere in this file.
 */
async function sendTurnAs(subscriberId: string, text: string, messageId?: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents/itest-support/messages',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, ...(messageId ? { messageId } : {}) },
  });
  return { status: res.statusCode, body: json(res) };
}

async function pushMessage(conversationId: string, body: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${conversationId}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: body,
  });
  return { status: res.statusCode, body: json(res) };
}

async function resolveViaOperator(conversationId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/conversations/${conversationId}/resolve`,
    headers: { 'x-api-key': apiKey },
  });
  return { status: res.statusCode, body: json(res) };
}

async function patchAgentStatus(identifier: string, status: 'active' | 'disabled') {
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${identifier}`,
    headers: { 'x-api-key': apiKey },
    payload: { status },
  });
  expect(res.statusCode).toBe(200);
}

/** Resolved jobs for a conversation among waiting/prioritized/delayed/completed. */
async function resolvedJobsFor(conversationId: string) {
  const jobs = await getQueue(QUEUE.CONVERSATION).getJobs([
    'waiting',
    'prioritized',
    'delayed',
    'completed',
  ]);
  return jobs.filter((j) => j.data.conversationId === conversationId && j.data.kind === 'resolved');
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

describe('push endpoint (operator/API outbound)', () => {
  test('happy path: 202, deliver once, re-run job is a no-op, repeat push dedupes', async () => {
    const opened = await sendTurnAs('push-sub-1', 'hi there', 'push-open-1');
    const conversationId = opened.body.conversationId;

    const push = await pushMessage(conversationId, { text: 'Here is an update', messageId: 'push-e2e-1' });
    expect(push.status).toBe(202);
    const rowId = push.body.messageId;
    expect(rowId).not.toBe('push-e2e-1');

    const rowsById = async () =>
      (await transcript(conversationId)).messages.filter((m: { id: string }) => m.id === rowId);

    await runJob(`conv-deliver-${rowId}`);
    let rows = await rowsById();
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe('Here is an update');

    // crash-retry simulation: same job re-run must not duplicate the row.
    await runJob(`conv-deliver-${rowId}`);
    rows = await rowsById();
    expect(rows).toHaveLength(1);

    // Repeating the same HTTP push with the same client messageId dedupes.
    const dup = await pushMessage(conversationId, { text: 'Here is an update', messageId: 'push-e2e-1' });
    expect(dup.status).toBe(200);
    expect(dup.body.duplicate).toBe(true);
    rows = await rowsById();
    expect(rows).toHaveLength(1);
  });

  test('buttons ride along on the delivered transcript row', async () => {
    const opened = await sendTurnAs('push-sub-2', 'hi again', 'push-open-2');
    const conversationId = opened.body.conversationId;

    const push = await pushMessage(conversationId, {
      text: 'Choose one:',
      buttons: [
        { id: 'a', label: 'Option A' },
        { id: 'b', label: 'Option B' },
      ],
    });
    expect(push.status).toBe(202);
    await runJob(`conv-deliver-${push.body.messageId}`);

    const t = await transcript(conversationId);
    const row = t.messages.find((m: { id: string }) => m.id === push.body.messageId);
    expect(row.buttons).toEqual([
      { id: 'a', label: 'Option A' },
      { id: 'b', label: 'Option B' },
    ]);
  });

  test('pushing to a resolved conversation keeps it resolved; reopen:true flips it active', async () => {
    const opened = await sendTurnAs('push-sub-3', 'hi', 'push-open-3');
    const conversationId = opened.body.conversationId;
    const thanks = await sendTurnAs('push-sub-3', 'thanks!', 'push-thanks-3');
    await runWorkerFor(thanks.body);
    expect((await transcript(conversationId)).conversation.status).toBe('resolved');

    const push = await pushMessage(conversationId, { text: 'still here?' });
    expect(push.status).toBe(202);
    expect(push.body.status).toBe('resolved');
    expect((await transcript(conversationId)).conversation.status).toBe('resolved');

    const reopened = await pushMessage(conversationId, { text: 'reopening', reopen: true });
    expect(reopened.status).toBe(202);
    expect(reopened.body.status).toBe('active');
    expect((await transcript(conversationId)).conversation.status).toBe('active');
  });

  test('validation: non-uuid id -> 400, unknown uuid -> 404, disabled agent -> 409', async () => {
    const badId = await pushMessage('not-a-uuid', { text: 'x' });
    expect(badId.status).toBe(400);

    const unknownId = await pushMessage('00000000-0000-0000-0000-000000000000', { text: 'x' });
    expect(unknownId.status).toBe(404);

    const opened = await sendTurnAs('push-sub-4', 'hi', 'push-open-4');
    const conversationId = opened.body.conversationId;

    await patchAgentStatus('itest-support', 'disabled');
    const disabled = await pushMessage(conversationId, { text: 'x' });
    expect(disabled.status).toBe(409);

    await patchAgentStatus('itest-support', 'active');
    const ok = await pushMessage(conversationId, { text: 'back online' });
    expect(ok.status).toBe(202);
  });
});

describe('bridge-signal resolved event, end to end', () => {
  test('a "thanks" turn resolves via the bridge signal; onResolve sees resolvedBy bridge', async () => {
    const opened = await sendTurnAs('resolve-sub-1', 'hi', 'resolve-open-1');
    const conversationId = opened.body.conversationId;
    const thanks = await sendTurnAs('resolve-sub-1', 'thanks!', 'resolve-thanks-1');
    await runWorkerFor(thanks.body);
    expect((await transcript(conversationId)).conversation.status).toBe('resolved');

    const jobId = `conv-resolved-${conversationId}-${thanks.body.messageId}`;
    await runJob(jobId);

    expect(resolvedContexts).toHaveLength(1);
    expect(resolvedContexts[0].resolvedBy).toBe('bridge');
    expect(resolvedContexts[0].conversation.summary).toBe('handled');
    expect(resolvedContexts[0].conversation.status).toBe('resolved');
  });
});

describe('operator resolve enqueues the resolved event exactly once', () => {
  test('first resolve enqueues one job; a second resolve enqueues none', async () => {
    const opened = await sendTurnAs('op-resolve-sub-1', 'hi', 'op-resolve-open-1');
    const conversationId = opened.body.conversationId;

    const first = await resolveViaOperator(conversationId);
    expect(first.status).toBe(200);
    expect(first.body.status).toBe('resolved');
    expect(await resolvedJobsFor(conversationId)).toHaveLength(1);

    const second = await resolveViaOperator(conversationId);
    expect(second.status).toBe(200);
    expect(await resolvedJobsFor(conversationId)).toHaveLength(1);
  });
});

describe('reopened before the resolved job dispatches', () => {
  test('a pending resolved job is a no-op once the conversation reopened', async () => {
    const opened = await sendTurnAs('reopen-sub-1', 'hi', 'reopen-open-1');
    const conversationId = opened.body.conversationId;

    const resolve = await resolveViaOperator(conversationId);
    expect(resolve.status).toBe(200);
    const jobs = await resolvedJobsFor(conversationId);
    expect(jobs).toHaveLength(1);
    const pendingJob = jobs[0];

    const reopened = await sendTurnAs('reopen-sub-1', 'one more thing', 'reopen-turn-1');
    expect(reopened.body.conversationId).toBe(conversationId);
    expect(reopened.body.status).toBe('active');
    expect((await transcript(conversationId)).conversation.status).toBe('active');

    const before = resolvedContexts.length;
    await processConversation(pendingJob as Job<ConversationJobData>);
    expect(resolvedContexts.length).toBe(before); // onResolve NOT called
  });
});

describe('old-SDK compat: a bridge that only ever answers {signals:[]}', () => {
  let oldServer: Server;
  let oldUrl = '';

  afterAll(() => oldServer?.close());

  test('resolving its conversation runs the resolved job without throwing', async () => {
    oldServer = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (chunk) => chunks.push(Buffer.from(chunk as Uint8Array)));
      req.on('end', () => {
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ signals: [] }));
      });
    });
    await new Promise<void>((r) => oldServer.listen(0, r));
    oldUrl = `http://localhost:${(oldServer.address() as AddressInfo).port}/`;

    const create = await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-api-key': apiKey },
      payload: { identifier: 'itest-old-sdk', name: 'Old SDK', bridgeUrl: oldUrl },
    });
    expect(create.statusCode).toBe(201);

    const turn = await app.inject({
      method: 'POST',
      url: '/v1/agents/itest-old-sdk/messages',
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId: 'old-sdk-user', text: 'hi', messageId: 'old-sdk-1' },
    });
    expect(turn.statusCode).toBe(202);
    const conversationId = json(turn).conversationId;

    const resolve = await resolveViaOperator(conversationId);
    expect(resolve.status).toBe(200);
    const jobs = await resolvedJobsFor(conversationId);
    expect(jobs).toHaveLength(1);

    await expect(
      processConversation(jobs[0] as Job<ConversationJobData>),
    ).resolves.not.toThrow();
  });
});
