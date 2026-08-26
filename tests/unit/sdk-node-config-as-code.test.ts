/**
 * @asyncify-hq/node (the client SDK) — A10 slice C.
 *
 * WHAT THIS PINS, and why it is not a duplicate of slice B's route tests:
 * those prove the ROUTES behave; this proves the CLIENT asks for the right
 * thing. The SDK's types are hand-kept copies of server shapes and its methods
 * are hand-written paths — the failure mode is a method that posts to the right
 * URL with a subtly wrong body (a bare file instead of `{ file }`, a key that
 * silently never travels), which no server test can catch because the server
 * would never see the call.
 *
 * Same idiom as agent-sdk.test.ts: a real HTTP server on an ephemeral port,
 * the real client pointed at it, and the recorded request inspected.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import {
  AsyncifyClient,
  AsyncifyError,
  type AgentConfigFile,
} from '../../packages/sdk-node/src/index';

interface Recorded {
  method: string;
  url: string;
  apiKey: string | undefined;
  body: unknown;
}

const FILE: AgentConfigFile = {
  formatVersion: 1,
  identifier: 'support-demo',
  name: 'Support',
  runtime: 'managed',
  model: 'claude-opus-4-8',
  systemPrompt: 'Be helpful.',
  tools: [
    {
      name: 'lookup_order',
      description: 'Find an order',
      parameters: { type: 'object', properties: {} },
      endpointUrl: 'https://acme.test/tools/lookup',
    },
  ],
};

let server: Server;
let client: AsyncifyClient;
const seen: Recorded[] = [];
/** What the next request gets back; each test sets what it needs. */
let reply: { status: number; body: unknown } = { status: 200, body: {} };

beforeAll(async () => {
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString();
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        apiKey: req.headers['x-api-key'] as string | undefined,
        body: raw ? JSON.parse(raw) : undefined,
      });
      res.writeHead(reply.status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(reply.body));
    });
  });
  await new Promise<void>((r) => server.listen(0, r));
  client = new AsyncifyClient({
    apiKey: 'test-key',
    baseUrl: `http://localhost:${(server.address() as AddressInfo).port}`,
  });
});

afterAll(() => server?.close());

function lastRequest(): Recorded {
  return seen[seen.length - 1];
}

describe('agents.export', () => {
  test('GETs the export route and returns the file BARE (no envelope to unwrap)', async () => {
    reply = { status: 200, body: FILE };
    const file = await client.agents.export('support-demo');

    const req = lastRequest();
    expect(req.method).toBe('GET');
    expect(req.url).toBe('/v1/agents/support-demo/export');
    expect(req.apiKey).toBe('test-key');
    // The whole point of the bare body: what comes out of export goes straight
    // back into import. A wrapper here would break `curl > file`.
    expect(file).toEqual(FILE);
  });

  test('encodes an identifier that needs it', async () => {
    reply = { status: 200, body: FILE };
    await client.agents.export('acme/support');
    expect(lastRequest().url).toBe('/v1/agents/acme%2Fsupport/export');
  });
});

describe('agents.importPreview', () => {
  test('POSTs the file UNDER `file` — the route reads body.file, not the body', async () => {
    reply = {
      status: 200,
      body: {
        identifier: 'support-demo',
        mode: 'update',
        changes: [{ field: 'systemPrompt', action: 'changed' }],
        toolChanges: { added: [], changed: [], removed: ['old_tool'] },
        removalPolicy: 'kept',
        missingWorkflows: [],
        missingKnowledge: [],
        needsLlmKey: false,
      },
    };
    const preview = await client.agents.importPreview(FILE);

    const req = lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/agents/import/preview');
    expect(req.body).toEqual({ file: FILE });
    // No key is ever invented for a preview.
    expect((req.body as Record<string, unknown>).llmApiKey).toBeUndefined();

    expect(preview.mode).toBe('update');
    expect(preview.removalPolicy).toBe('kept');
    expect(preview.toolChanges.removed).toEqual(['old_tool']);
  });
});

describe('agents.import', () => {
  const applied = {
    mode: 'create',
    agent: { identifier: 'support-demo' },
    signingSecret: 'ags_once',
    tools: { created: [{ name: 'lookup_order', secret: 'ats_once' }], updated: [], kept: [] },
    missingKnowledge: [],
  };

  test('sends only `file` when no key is given — an absent key must not become null', async () => {
    reply = { status: 201, body: applied };
    await client.agents.import(FILE);

    const req = lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/agents/import');
    expect(req.body).toEqual({ file: FILE });
    // `llmApiKey: null` would fail the route's `z.string().min(8)` — the key
    // must be ABSENT, not present-and-empty.
    expect(Object.keys(req.body as object)).toEqual(['file']);
  });

  test('sends the key alongside the file when one is given', async () => {
    reply = { status: 201, body: applied };
    const res = await client.agents.import(FILE, { llmApiKey: 'sk-target-env-key' });

    expect(lastRequest().body).toEqual({ file: FILE, llmApiKey: 'sk-target-env-key' });
    // The once-only secrets have to survive the type layer to be storable.
    expect(res.signingSecret).toBe('ags_once');
    expect(res.tools.created[0]).toEqual({ name: 'lookup_order', secret: 'ats_once' });
  });

  test('an empty key is not sent (it would be refused as too short)', async () => {
    reply = { status: 200, body: { ...applied, signingSecret: undefined } };
    await client.agents.import(FILE, { llmApiKey: '' });
    expect(Object.keys(lastRequest().body as object)).toEqual(['file']);
  });

  test("a refusal surfaces the server's own message, not a generic one", async () => {
    reply = { status: 400, body: { error: 'invalid config file' } };
    await expect(client.agents.import(FILE)).rejects.toThrow(AsyncifyError);
    await expect(client.agents.import(FILE)).rejects.toThrow('invalid config file');
  });
});

describe('agents.pause / agents.resume (A10 slice A rides here)', () => {
  test('pause POSTs the pause route with no body', async () => {
    reply = { status: 200, body: { agent: { identifier: 'support-demo', pausedAt: '2026-08-26T00:00:00Z' } } };
    const res = await client.agents.pause('support-demo');

    const req = lastRequest();
    expect(req.method).toBe('POST');
    expect(req.url).toBe('/v1/agents/support-demo/pause');
    expect(req.body).toBeUndefined();
    // The kill-switch's whole output is this timestamp.
    expect(res.agent.pausedAt).toBe('2026-08-26T00:00:00Z');
  });

  test('resume POSTs the resume route; a live agent reads pausedAt null', async () => {
    reply = { status: 200, body: { agent: { identifier: 'support-demo', pausedAt: null } } };
    const res = await client.agents.resume('support-demo');

    expect(lastRequest().method).toBe('POST');
    expect(lastRequest().url).toBe('/v1/agents/support-demo/resume');
    expect(res.agent.pausedAt).toBeNull();
  });

  test('pause and resume are distinct routes (not one toggle)', async () => {
    reply = { status: 200, body: { agent: { identifier: 'a', pausedAt: null } } };
    await client.agents.pause('a');
    const paused = lastRequest().url;
    await client.agents.resume('a');
    expect(paused).not.toBe(lastRequest().url);
  });
});
