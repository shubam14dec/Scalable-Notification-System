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
    tools?: Array<{ name: string; input_schema: { properties?: Record<string, { enum?: string[] }> } }>;
    messages: Array<{ role: string; content: unknown }>;
  };
}
const seen: SeenRequest[] = [];
/** Behavior switch per test: 'ok' | 'refusal' | 'auth' | 'overloaded'. */
let stubMode: 'ok' | 'refusal' | 'auth' | 'overloaded' = 'ok';
/** Scripted responses (multi-round tool conversations); consumed FIFO. */
let stubQueue: unknown[] = [];

const envelope = (content: unknown[], stopReason: string, model = 'glm-4-test') => ({
  id: 'msg_stub_1',
  type: 'message',
  role: 'assistant',
  model,
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});

const toolUseResponse = (uses: Array<{ id: string; name: string; input: unknown }>) =>
  envelope(uses.map((u) => ({ type: 'tool_use', ...u })), 'tool_use');
const textResponse = (text: string) => envelope([{ type: 'text', text }], 'end_turn');

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as SeenRequest['body'];
      seen.push({ apiKey: req.headers['x-api-key'] as string | undefined, body });
      res.setHeader('content-type', 'application/json');
      if (stubQueue.length > 0) {
        const scripted = stubQueue.shift()!;
        res.end(JSON.stringify(scripted));
        return;
      }
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
      // Echo only the user's words — not the platform-internal reminder.
      const lastText = String(body.messages.at(-1)?.content ?? '').split(
        '\n\n<platform_reminder>',
      )[0];
      res.end(
        JSON.stringify(
          refusal
            ? envelope([], 'refusal', body.model)
            : envelope([{ type: 'text', text: `echo(${lastText})` }], 'end_turn', body.model),
        ),
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

  // A workflow for trigger_workflow to hit (inapp: no provider needed).
  await app.inject({
    method: 'PUT',
    url: '/v1/workflows',
    headers: { 'x-api-key': apiKey },
    payload: {
      key: 'brain-wf',
      name: 'Brain workflow',
      steps: [{ channel: 'inapp', subject: 'Hi {{name}}', body: 'Replacement for {{name}}' }],
    },
  });
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
    expect(String(last.body.messages.at(-1)?.content)).toContain('and again');

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

describe('the tool loop', () => {
  const toolScript = () => [
    toolUseResponse([
      { id: 'toolu_1', name: 'trigger_workflow', input: { workflowKey: 'brain-wf', payload: { name: 'Ana' } } },
      { id: 'toolu_2', name: 'set_metadata', input: { key: 'topic', value: 'missing-order' } },
    ]),
    textResponse('Replacement queued — check your inbox!'),
  ];
  let conversationId = '';
  let toolTurnMessageId = '';

  test('the tool menu carries the tenant workflow enum', async () => {
    const turn = await sendTurn('menu check', 'tool-0');
    conversationId = turn.conversationId;
    await runWorker(turn.conversationId, turn.messageId);
    const tools = seen.at(-1)!.body.tools!;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'present_buttons',
      'resolve_conversation',
      'set_metadata',
      'trigger_workflow',
    ]);
    const trigger = tools.find((t) => t.name === 'trigger_workflow')!;
    expect(trigger.input_schema.properties!.workflowKey.enum).toEqual(['brain-wf']);
  });

  test('tool round-trip: effects apply, results return in ONE user message', async () => {
    stubQueue = toolScript();
    const turn = await sendTurn('where is my order?', 'tool-1');
    toolTurnMessageId = turn.messageId;
    await runWorker(turn.conversationId, turn.messageId);

    // The wire shape the model saw on round 2.
    const round2 = seen.at(-1)!.body.messages;
    const last = round2.at(-1) as { role: string; content: Array<{ type: string; tool_use_id: string; is_error?: boolean }> };
    expect(last.role).toBe('user');
    expect(last.content.map((b) => b.type)).toEqual(['tool_result', 'tool_result']);
    expect(last.content.map((b) => b.tool_use_id)).toEqual(['toolu_1', 'toolu_2']);
    expect(last.content.some((b) => b.is_error)).toBe(false);

    // The effects are real.
    const event = await app.inject({
      method: 'GET',
      url: `/v1/events/conv-${turn.messageId}-brain-wf`,
      headers: { 'x-api-key': apiKey },
    });
    expect(event.statusCode).toBe(200);
    expect(json(event).workflowKey).toBe('brain-wf');

    const t = await transcript(turn.conversationId);
    expect(t.conversation.metadata.topic).toBe('missing-order');
    const system = t.messages.filter((m: { role: string }) => m.role === 'system');
    expect(system.some((m: { content: string }) => m.content.includes('triggered workflow brain-wf'))).toBe(true);
    const replies = t.messages.filter((m: { role: string }) => m.role === 'agent');
    expect(replies.at(-1).content).toBe('Replacement queued — check your inbox!');
  });

  test('a crash-retry cannot double-send: content-keyed idempotency', async () => {
    const before = (await transcript(conversationId)).messages.length;
    // Re-run the SAME turn; the "model" asks for the same tools again.
    stubQueue = toolScript();
    await runWorker(conversationId, toolTurnMessageId);
    // No new rows: reply, breadcrumb, and event all dedupe by content keys.
    expect((await transcript(conversationId)).messages.length).toBe(before);
    const round2 = seen.at(-1)!.body.messages;
    const last = round2.at(-1) as { role: string; content: Array<{ content: string }> };
    // The model was told the workflow already went out.
    expect(last.content[0].content).toContain('already sent');
  });

  test('a bad tool call returns is_error and the model recovers', async () => {
    stubQueue = [
      toolUseResponse([
        { id: 'toolu_3', name: 'trigger_workflow', input: { workflowKey: 'no-such-wf' } },
      ]),
      textResponse('Sorry, I could not send that — but your issue is noted.'),
    ];
    const turn = await sendTurn('send me the thing', 'tool-2');
    await runWorker(turn.conversationId, turn.messageId);

    const round2 = seen.at(-1)!.body.messages;
    const last = round2.at(-1) as { role: string; content: Array<{ is_error?: boolean; content: string }> };
    expect(last.content[0].is_error).toBe(true);
    expect(last.content[0].content).toContain('unknown workflow');

    const t = await transcript(turn.conversationId);
    const replies = t.messages.filter((m: { role: string }) => m.role === 'agent');
    expect(replies.at(-1).content).toContain('your issue is noted');
  });

  test('resolve_conversation closes the thread', async () => {
    stubQueue = [
      toolUseResponse([
        { id: 'toolu_4', name: 'resolve_conversation', input: { summary: 'order handled' } },
      ]),
      textResponse('Anytime! Closing this out.'),
    ];
    const turn = await sendTurn('thanks, all good!', 'tool-3');
    await runWorker(turn.conversationId, turn.messageId);

    const t = await transcript(turn.conversationId);
    expect(t.conversation.status).toBe('resolved');
    expect(t.conversation.summary).toBe('order handled');
    const system = t.messages.filter((m: { role: string }) => m.role === 'system');
    expect(system.some((m: { content: string }) => m.content.includes('conversation resolved: order handled'))).toBe(true);
  });

  test('the loop cap stops a runaway tool spiral at 5 model calls', async () => {
    stubQueue = Array.from({ length: 6 }, (_, i) =>
      toolUseResponse([
        { id: `toolu_loop_${i}`, name: 'set_metadata', input: { key: 'spin', value: i } },
      ]),
    );
    const callsBefore = seen.length;
    const turn = await sendTurn('spiral please', 'tool-4');
    await runWorker(turn.conversationId, turn.messageId);

    expect(seen.length - callsBefore).toBe(5); // hard ceiling
    stubQueue = []; // discard the unused 6th script
    const t = await transcript(turn.conversationId);
    const system = t.messages.filter((m: { role: string }) => m.role === 'system');
    expect(system.at(-1).content).toContain('tool loop limit reached');
  });

  test('replayed history reconstructs REAL tool blocks, not imitable prose', async () => {
    // A turn after the tool round-trip: the model must see the earlier
    // action as native tool_use/tool_result blocks — imitating those means
    // emitting a tool call, so imitation becomes execution.
    const turn = await sendTurn('and my other order?', 'tool-5');
    await runWorker(turn.conversationId, turn.messageId);

    const msgs = seen.at(-1)!.body.messages as Array<{
      role: string;
      content: string | Array<{ type: string; id?: string; name?: string; tool_use_id?: string }>;
    }>;
    const toolUseMsg = msgs.find(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_use' && b.name === 'trigger_workflow'),
    );
    expect(toolUseMsg).toBeDefined();
    const useBlock = (toolUseMsg!.content as Array<{ type: string; id?: string }>).find(
      (b) => b.type === 'tool_use',
    )!;
    // The matching result follows in the next user message.
    const resultMsg = msgs.find(
      (m) =>
        m.role === 'user' &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_result' && b.tool_use_id === useBlock.id),
    );
    expect(resultMsg).toBeDefined();
    // No prose annotations anywhere — the imitable text form is gone.
    const prose = msgs.some(
      (m) => typeof m.content === 'string' && m.content.includes('[action taken:'),
    );
    expect(prose).toBe(false);
  });

  test('the per-turn reminder rides the wire but never the transcript', async () => {
    const turn = await sendTurn('reminder check', 'tool-7');
    await runWorker(turn.conversationId, turn.messageId);

    // On the wire: the CURRENT user message carries the reminder, and it
    // names every tool (a trigger-only version taught the model to skip
    // resolve/metadata).
    const wire = String(seen.at(-1)!.body.messages.at(-1)?.content);
    expect(wire).toContain('<platform_reminder>');
    expect(wire).toContain('trigger_workflow');
    expect(wire).toContain('resolve_conversation');
    expect(wire).toContain('set_metadata');
    expect(wire).toContain('present_buttons');

    // ...but the stored transcript stays clean (nothing to accumulate or
    // imitate on later turns).
    const t = await transcript(turn.conversationId);
    const stored = t.messages.find((m: { content: string }) => m.content.includes('reminder check'));
    expect(stored.content).toBe('reminder check');
  });

  test('a forged [action taken:] line in the reply is stripped and flagged', async () => {
    stubQueue = [
      textResponse(
        '[action taken: triggered workflow brain-wf (txn conv-fake-123)]\n' +
          'I just sent you a confirmation!',
      ),
    ];
    const turn = await sendTurn('did you send it?', 'tool-6');
    await runWorker(turn.conversationId, turn.messageId);

    const t = await transcript(turn.conversationId);
    const reply = t.messages.findLast((m: { role: string }) => m.role === 'agent');
    expect(reply.content).toBe('I just sent you a confirmation!');
    expect(reply.content).not.toContain('[action taken:');
    const system = t.messages.filter((m: { role: string }) => m.role === 'system');
    expect(system.at(-1).content).toContain('fabricated action claim');
  });

  test('usage is recorded per turn and totaled per conversation', async () => {
    // Two model calls in this turn (tool round + final) -> 20 in / 10 out.
    stubQueue = [
      toolUseResponse([
        { id: 'toolu_u1', name: 'set_metadata', input: { key: 'usage_check', value: 1 } },
      ]),
      textResponse('Noted!'),
    ];
    const turn = await sendTurn('note this down', 'usage-1');
    await runWorker(turn.conversationId, turn.messageId);

    const t = await transcript(turn.conversationId);
    const reply = t.messages.findLast((m: { role: string }) => m.role === 'agent');
    expect(reply.usage).toEqual({ inputTokens: 20, outputTokens: 10, modelCalls: 2 });
    // Conversation totals accumulate across every managed turn in the thread.
    expect(t.usage.modelCalls).toBeGreaterThanOrEqual(2);
    expect(t.usage.inputTokens).toBeGreaterThanOrEqual(20);
  });

  test('per-agent max_tokens reaches the wire; bounds are enforced', async () => {
    const tooSmall = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/glm-support',
      headers: { 'x-api-key': apiKey },
      payload: { maxTokens: 100 },
    });
    expect(tooSmall.statusCode).toBe(400);

    const ok = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/glm-support',
      headers: { 'x-api-key': apiKey },
      payload: { maxTokens: 512 },
    });
    expect(json(ok).agent.maxTokens).toBe(512);

    const turn = await sendTurn('cap check', 'usage-2');
    await runWorker(turn.conversationId, turn.messageId);
    expect(seen.at(-1)!.body.max_tokens).toBe(512);
  });

  test('a button click reaches the LLM as readable click text', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/agents/glm-support/actions',
      headers: { 'x-api-key': apiKey },
      payload: { subscriberId: 'ana', actionId: 'resend', label: 'Resend email', actionEventId: 'act-glm-1' },
    });
    expect(res.statusCode).toBe(202);
    const { conversationId: cid, messageId: mid } = json(res);
    await runWorker(cid, mid);

    const wire = String(seen.at(-1)!.body.messages.at(-1)?.content);
    expect(wire).toContain('[user clicked: Resend email]');
  });

  test('a tenant with no workflows gets no trigger tool', async () => {
    // Fresh org: no workflows seeded.
    const email = `brain2-${Date.now()}@itest.local`;
    const signup = await app.inject({
      method: 'POST',
      url: '/auth/signup',
      payload: { name: 'B2', email, password: 'integration-pw-1', organizationName: 'B2 Org' },
    });
    const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
    await app.inject({
      method: 'POST',
      url: '/v1/agents',
      headers: { 'x-api-key': dev.apiKey },
      payload: {
        identifier: 'bare-brain',
        name: 'Bare',
        runtime: 'managed',
        model: 'glm-4-test',
        llm: { apiKey: 'zai-test-key-123456', baseUrl: llmBaseUrl },
      },
    });
    const send = await app.inject({
      method: 'POST',
      url: '/v1/agents/bare-brain/messages',
      headers: { 'x-api-key': dev.apiKey },
      payload: { subscriberId: 'bob', text: 'hi', messageId: 'bare-1' },
    });
    const { conversationId: cid, messageId: mid } = json(send);
    await processConversation({
      data: { tenantId: dev.id, conversationId: cid, messageId: mid },
    } as Job<ConversationJobData>);

    const tools = seen.at(-1)!.body.tools!;
    expect(tools.map((t) => t.name).sort()).toEqual([
      'present_buttons',
      'resolve_conversation',
      'set_metadata',
    ]);
  });
});

describe('present_buttons', () => {
  let conversationId = '';
  let buttonsTurnMessageId = '';

  test('presented buttons ride the reply row and surface in the transcript', async () => {
    stubQueue = [
      toolUseResponse([
        {
          id: 'toolu_b1',
          name: 'present_buttons',
          input: { buttons: [{ id: 'resend', label: 'Resend the order' }, { id: 'human', label: 'Talk to a human' }] },
        },
      ]),
      textResponse('How should we fix this?'),
    ];
    const turn = await sendTurn('order trouble, need choices', 'btn-1');
    conversationId = turn.conversationId;
    buttonsTurnMessageId = turn.messageId;
    await runWorker(turn.conversationId, turn.messageId);

    // The model was told the presentation is pending, not an is_error.
    const round2 = seen.at(-1)!.body.messages;
    const last = round2.at(-1) as { role: string; content: Array<{ is_error?: boolean; content: string }> };
    expect(last.content[0].is_error).toBeUndefined();
    expect(last.content[0].content).toContain('2 button(s)');

    const t = await transcript(turn.conversationId);
    const reply = t.messages.findLast((m: { role: string }) => m.role === 'agent');
    expect(reply.content).toBe('How should we fix this?');
    expect(reply.buttons).toEqual([
      { id: 'resend', label: 'Resend the order' },
      { id: 'human', label: 'Talk to a human' },
    ]);
    // Presentation is not an effect: no breadcrumb row for it.
    const system = t.messages.filter((m: { role: string }) => m.role === 'system');
    expect(system.some((m: { content: string }) => m.content.includes('button'))).toBe(false);
  });

  test('a re-run of the same turn cannot duplicate the buttons reply', async () => {
    const before = (await transcript(conversationId)).messages.length;
    stubQueue = [
      toolUseResponse([
        {
          id: 'toolu_b1r',
          name: 'present_buttons',
          input: { buttons: [{ id: 'resend', label: 'Resend the order' }, { id: 'human', label: 'Talk to a human' }] },
        },
      ]),
      textResponse('How should we fix this?'),
    ];
    await runWorker(conversationId, buttonsTurnMessageId);
    expect((await transcript(conversationId)).messages.length).toBe(before);
  });

  test('replayed history shows the presentation as a REAL tool_use block', async () => {
    const turn = await sendTurn('follow-up question', 'btn-2');
    await runWorker(turn.conversationId, turn.messageId);

    const msgs = seen.at(-1)!.body.messages as Array<{
      role: string;
      content: string | Array<{ type: string; name?: string; input?: { buttons?: unknown } }>;
    }>;
    const useMsg = msgs.find(
      (m) =>
        m.role === 'assistant' &&
        Array.isArray(m.content) &&
        m.content.some((b) => b.type === 'tool_use' && b.name === 'present_buttons'),
    );
    expect(useMsg).toBeDefined();
    const block = (useMsg!.content as Array<{ type: string; name?: string; input?: { buttons?: unknown } }>).find(
      (b) => b.name === 'present_buttons',
    )!;
    expect(block.input?.buttons).toEqual([
      { id: 'resend', label: 'Resend the order' },
      { id: 'human', label: 'Talk to a human' },
    ]);
  });

  test('invalid sets come back as is_error and the model corrects', async () => {
    const seven = Array.from({ length: 7 }, (_, i) => ({ id: `b${i}`, label: `Option ${i}` }));
    stubQueue = [
      toolUseResponse([{ id: 'toolu_b3', name: 'present_buttons', input: { buttons: seven } }]),
      toolUseResponse([
        { id: 'toolu_b4', name: 'present_buttons', input: { buttons: [{ id: 'a', label: 'A' }, { id: 'a', label: 'B' }] } },
      ]),
      textResponse('Here are your options.'),
    ];
    const turn = await sendTurn('lots of choices', 'btn-3');
    await runWorker(turn.conversationId, turn.messageId);

    // Both bad rounds were rejected with is_error and the reasons.
    const secondRound = seen.at(-2)!.body.messages.at(-1) as { content: Array<{ is_error?: boolean; content: string }> };
    expect(secondRound.content[0].is_error).toBe(true);
    expect(secondRound.content[0].content).toContain('at most 6');
    const thirdRound = seen.at(-1)!.body.messages.at(-1) as { content: Array<{ is_error?: boolean; content: string }> };
    expect(thirdRound.content[0].is_error).toBe(true);
    expect(thirdRound.content[0].content).toContain('duplicate button id');

    // Nothing invalid stuck: the reply landed with NO buttons.
    const t = await transcript(turn.conversationId);
    const reply = t.messages.findLast((m: { role: string }) => m.role === 'agent');
    expect(reply.content).toBe('Here are your options.');
    expect(reply.buttons).toBeUndefined();
  });

  test('two calls in one turn: the last set wins', async () => {
    stubQueue = [
      toolUseResponse([
        { id: 'toolu_b5', name: 'present_buttons', input: { buttons: [{ id: 'old', label: 'Old set' }] } },
        { id: 'toolu_b6', name: 'present_buttons', input: { buttons: [{ id: 'final', label: 'Final set' }] } },
      ]),
      textResponse('Pick one:'),
    ];
    const turn = await sendTurn('changing my mind', 'btn-4');
    await runWorker(turn.conversationId, turn.messageId);

    const t = await transcript(turn.conversationId);
    const reply = t.messages.findLast((m: { role: string }) => m.role === 'agent');
    expect(reply.buttons).toEqual([{ id: 'final', label: 'Final set' }]);
  });

  test('buttons without reply text are dropped, not orphaned', async () => {
    stubQueue = [
      toolUseResponse([
        { id: 'toolu_b7', name: 'present_buttons', input: { buttons: [{ id: 'x', label: 'X' }] } },
      ]),
      envelope([], 'end_turn'),
    ];
    const before = (await transcript(conversationId)).messages.length;
    const turn = await sendTurn('silent treatment', 'btn-5');
    await runWorker(turn.conversationId, turn.messageId);

    const t = await transcript(turn.conversationId);
    // One new user row + the "no reply text" note; no agent row, no buttons.
    const replies = t.messages.filter((m: { role: string }) => m.role === 'agent');
    expect(replies.at(-1).content).not.toBe('');
    expect(t.messages.length).toBe(before + 2);
    const system = t.messages.filter((m: { role: string }) => m.role === 'system');
    expect(system.at(-1).content).toContain('no reply text');
  });
});
