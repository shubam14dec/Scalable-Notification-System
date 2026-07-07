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
