/**
 * @asyncify-hq/agent unit tests: the signature scheme must round-trip with
 * the server's signer, and handleEvent must batch replies + signals exactly
 * as the conversation worker expects them.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, test } from 'vitest';
import { signWebhook } from '../../src/api/webhook-signature';
import {
  createHandler,
  defineAgent,
  handleEvent,
  verifySignature,
  type AgentEvent,
  type AgentResolvedEvent,
  type ResolveContext,
} from '../../packages/agent/src/index';

const SECRET = 'ags_test_secret';

function makeEvent(text: string, overrides: Partial<AgentEvent> = {}): AgentEvent {
  return {
    type: 'message',
    agent: { identifier: 'support', name: 'Support' },
    conversation: { id: 'c1', channel: 'inapp', status: 'active', metadata: {}, messageCount: 1 },
    subscriber: { subscriberId: 'ana', email: 'ana@example.com', phone: null },
    message: { id: 'm1', text, createdAt: new Date().toISOString() },
    history: [],
    ...overrides,
  };
}

function makeResolvedEvent(overrides: Partial<AgentResolvedEvent> = {}): AgentResolvedEvent {
  return {
    type: 'resolved',
    resolvedBy: 'operator',
    agent: { identifier: 'support', name: 'Support' },
    conversation: {
      id: 'c1',
      channel: 'inapp',
      status: 'resolved',
      metadata: { key: 'value' },
      messageCount: 3,
      summary: 'handled',
    },
    subscriber: { subscriberId: 'ana', email: 'ana@example.com', phone: null },
    ...overrides,
  };
}

describe('signature verification', () => {
  const body = '{"hello":"world"}';
  const now = () => String(Math.floor(Date.now() / 1000));

  test('accepts what the server signs', () => {
    const ts = now();
    expect(verifySignature(SECRET, ts, signWebhook(SECRET, ts, body), body)).toBe(true);
  });

  test('rejects a tampered body', () => {
    const ts = now();
    const sig = signWebhook(SECRET, ts, body);
    expect(verifySignature(SECRET, ts, sig, body + 'x')).toBe(false);
  });

  test('rejects the wrong secret', () => {
    const ts = now();
    expect(verifySignature('ags_other', ts, signWebhook(SECRET, ts, body), body)).toBe(false);
  });

  test('rejects a stale timestamp (replay)', () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    expect(verifySignature(SECRET, stale, signWebhook(SECRET, stale, body), body)).toBe(false);
  });

  test('rejects missing headers', () => {
    expect(verifySignature(SECRET, undefined, 'abc', body)).toBe(false);
    expect(verifySignature(SECRET, now(), undefined, body)).toBe(false);
  });
});

describe('handleEvent', () => {
  test('returning a string is the reply', async () => {
    const agent = defineAgent({ onMessage: (ctx) => `echo: ${ctx.message.text}` });
    const res = await handleEvent(agent, makeEvent('hi'));
    expect(res.reply).toBe('echo: hi');
    expect(res.signals).toEqual([]);
  });

  test('signals are batched in call order; metadata.get sees pending sets', async () => {
    const agent = defineAgent({
      onMessage(ctx) {
        ctx.metadata.set('topic', 'orders');
        expect(ctx.metadata.get('topic')).toBe('orders');
        ctx.trigger('order-shipped', { payload: { order: '#1' }, priority: 'p0' });
        ctx.resolve('done');
        ctx.reply('all set');
      },
    });
    const res = await handleEvent(agent, makeEvent('where is my order'));
    expect(res.reply).toBe('all set');
    expect(res.signals).toEqual([
      { type: 'metadata.set', key: 'topic', value: 'orders' },
      { type: 'trigger', workflowKey: 'order-shipped', payload: { order: '#1' }, priority: 'p0' },
      { type: 'resolve', summary: 'done' },
    ]);
  });

  test('metadata.get reads what the platform sent', async () => {
    const agent = defineAgent({
      onMessage: (ctx) => `topic is ${ctx.metadata.get('topic')}`,
    });
    const event = makeEvent('hi', {
      conversation: {
        id: 'c1',
        channel: 'inapp',
        status: 'active',
        metadata: { topic: 'billing' },
        messageCount: 3,
      },
    });
    expect((await handleEvent(agent, event)).reply).toBe('topic is billing');
  });

  test('no reply leaves reply undefined (signals still sent)', async () => {
    const agent = defineAgent({
      onMessage(ctx) {
        ctx.metadata.set('seen', true);
      },
    });
    const res = await handleEvent(agent, makeEvent('hi'));
    expect(res.reply).toBeUndefined();
    expect(res.signals).toHaveLength(1);
  });
});

describe('handleEvent: resolved lifecycle events', () => {
  test('resolved event invokes onResolve once with resolvedBy/summary/metadata, returns empty signals', async () => {
    const seen: ResolveContext[] = [];
    const agent = defineAgent({
      onMessage: () => 'unused',
      onResolve(ctx) {
        seen.push(ctx);
      },
    });
    const res = await handleEvent(agent, makeResolvedEvent({ resolvedBy: 'bridge' }));
    expect(res).toEqual({ signals: [] });
    expect(seen).toHaveLength(1);
    expect(seen[0].resolvedBy).toBe('bridge');
    expect(seen[0].conversation.summary).toBe('handled');
    expect(seen[0].subscriber.subscriberId).toBe('ana');
    expect(seen[0].metadata.get('key')).toBe('value');
  });

  test('resolved event with no onResolve handler returns empty signals without throwing', async () => {
    const agent = defineAgent({ onMessage: () => 'unused' });
    const res = await handleEvent(agent, makeResolvedEvent());
    expect(res).toEqual({ signals: [] });
  });

  test('REGRESSION: an unknown event type returns empty signals without reaching onMessage', async () => {
    let called = false;
    const agent = defineAgent({
      onMessage(ctx) {
        called = true;
        return `echo: ${ctx.message?.text}`;
      },
    });
    const weird = { type: 'weird' } as unknown as AgentEvent;
    const res = await handleEvent(agent, weird);
    expect(res).toEqual({ signals: [] });
    expect(called).toBe(false);
  });
});

describe('createHandler over real HTTP', () => {
  const agent = defineAgent({ onMessage: (ctx) => `pong: ${ctx.message.text}` });
  let server: Server;
  let url: string;

  afterAll(() => server?.close());

  async function start() {
    server = createServer(createHandler(agent, { signingSecret: SECRET }));
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://localhost:${(server.address() as AddressInfo).port}/`;
  }

  test('signed request gets the reply; unsigned gets 401', async () => {
    await start();
    const body = JSON.stringify(makeEvent('ping'));
    const ts = String(Math.floor(Date.now() / 1000));

    const ok = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-asyncify-timestamp': ts,
        'x-asyncify-signature': signWebhook(SECRET, ts, body),
      },
      body,
    });
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ reply: 'pong: ping', signals: [] });

    const unsigned = await fetch(url, { method: 'POST', body });
    expect(unsigned.status).toBe(401);
  });
});

describe('createHandler over real HTTP: resolved + unknown event types', () => {
  const resolvedSeen: ResolveContext[] = [];
  let messageCalled = false;
  const agent = defineAgent({
    onMessage(ctx) {
      messageCalled = true;
      return `pong: ${ctx.message.text}`;
    },
    onResolve(ctx) {
      resolvedSeen.push(ctx);
    },
  });
  let server: Server;
  let url: string;

  afterAll(() => server?.close());

  async function start() {
    server = createServer(createHandler(agent, { signingSecret: SECRET }));
    await new Promise<void>((r) => server.listen(0, r));
    url = `http://localhost:${(server.address() as AddressInfo).port}/`;
  }

  async function signedPost(body: string) {
    const ts = String(Math.floor(Date.now() / 1000));
    return fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-asyncify-timestamp': ts,
        'x-asyncify-signature': signWebhook(SECRET, ts, body),
      },
      body,
    });
  }

  test('signed resolved event gets 200 and fires onResolve', async () => {
    await start();
    const body = JSON.stringify(makeResolvedEvent({ resolvedBy: 'operator' }));
    const res = await signedPost(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signals: [] });
    expect(resolvedSeen).toHaveLength(1);
    expect(resolvedSeen[0].resolvedBy).toBe('operator');
  });

  test('unsigned or bad-signature resolved event gets 401', async () => {
    const body = JSON.stringify(makeResolvedEvent());
    const unsigned = await fetch(url, { method: 'POST', body });
    expect(unsigned.status).toBe(401);

    const ts = String(Math.floor(Date.now() / 1000));
    const badSig = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-asyncify-timestamp': ts,
        'x-asyncify-signature': 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef',
      },
      body,
    });
    expect(badSig.status).toBe(401);
  });

  test('signed unknown event type gets 200 {signals:[]} without invoking any handler', async () => {
    const before = resolvedSeen.length;
    const body = JSON.stringify({ type: 'future-thing', foo: 'bar' });
    const res = await signedPost(body);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ signals: [] });
    expect(messageCalled).toBe(false);
    expect(resolvedSeen).toHaveLength(before);
  });
});
