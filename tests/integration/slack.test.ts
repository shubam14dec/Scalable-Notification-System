/**
 * Slack channel integration: the production path end to end, with a stub
 * standing in for slack.com/api (SLACK_API_BASE) and the real
 * @asyncify-hq/agent SDK as the bridge. Everything else — the standalone
 * connect flow, the signed events + interactivity webhooks, subscriber
 * resolution, scope routing, the conversation processor, and reply delivery
 * — is the exact code production runs.
 *
 * Slack signs every inbound request (the v0 HMAC scheme over the raw bytes),
 * so — unlike telegram.test.ts — the webhook helpers inject the exact signed
 * STRING as the body (an object would re-serialize and break rawBody).
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac, createHash } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, getQueue, QUEUE } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import { createHandler, defineAgent } from '../../packages/agent/src/index';

// A realistic bot token: "xoxb-" then an unbroken run of [A-Za-z0-9-] (the
// connect route validates this shape before ever calling Slack).
const TOKEN_MAIN = 'xoxb-itestmain-0123456789ABCDEFGH';
const SIGNING_SECRET = 'itest-slack-signing-secret-abcdef';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let connectionId = '';
const bridges: Server[] = [];

const json = (res: { body: string }) => JSON.parse(res.body);
const headers = () => ({ 'x-api-key': apiKey });

// ---- stub Slack Web API: records every call, answers like the real one ----
interface SlackCall {
  method: string;
  path: string;
  body: Record<string, unknown>;
  token: string;
}
let slackStub: Server;
const slackCalls: SlackCall[] = [];
let tsCounter = 0;

// Per-test toggles for the two responses that vary by scenario.
const authTest = { ok: true };
const usersInfo = { mode: 'ok' as 'ok' | 'not_found' | 'error', email: null as string | null };

/** Deterministic workspace id per token — same token = same team, always. */
function teamIdForToken(token: string): string {
  return 'T' + createHash('sha1').update(token).digest('hex').slice(0, 8).toUpperCase();
}

function startSlackStub(): Promise<void> {
  slackStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = String(req.url).split('/').pop() ?? '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
      slackCalls.push({ method, path: String(req.url), body, token });
      res.setHeader('content-type', 'application/json; charset=utf-8');

      if (method === 'auth.test') {
        if (!authTest.ok) return res.end(JSON.stringify({ ok: false, error: 'invalid_auth' }));
        return res.end(
          JSON.stringify({
            ok: true,
            team_id: teamIdForToken(token),
            team: 'Test Team',
            user_id: 'UBOT001',
            bot_id: 'B001',
          }),
        );
      }
      if (method === 'chat.postMessage') {
        return res.end(
          JSON.stringify({ ok: true, channel: body.channel, ts: `1720000000.${++tsCounter}` }),
        );
      }
      if (method === 'chat.update' || method === 'chat.delete') {
        return res.end(JSON.stringify({ ok: true, channel: body.channel, ts: body.ts }));
      }
      if (method === 'users.info') {
        if (usersInfo.mode === 'error') {
          res.statusCode = 500;
          return res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
        }
        if (usersInfo.mode === 'not_found') {
          return res.end(JSON.stringify({ ok: false, error: 'user_not_found' }));
        }
        return res.end(
          JSON.stringify({
            ok: true,
            user: { id: body.user, profile: usersInfo.email ? { email: usersInfo.email } : {} },
          }),
        );
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'unknown_method' }));
    });
  });
  return new Promise((r) => slackStub.listen(0, () => r()));
}

// ---- signing: the v0 HMAC scheme over the exact bytes Slack would sign ----
function signedHeaders(
  signingSecret: string,
  rawBody: string,
  ts = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const sig =
    'v0=' + createHmac('sha256', signingSecret).update(`v0:${ts}:${rawBody}`).digest('hex');
  return { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig };
}

// ---- webhook injectors: sign the STRING, send the STRING (rawBody-exact) ----
async function postEvent(
  envelope: unknown,
  opts: { ts?: number; secret?: string; connId?: string } = {},
) {
  const body = JSON.stringify(envelope);
  const hdrs = signedHeaders(opts.secret ?? SIGNING_SECRET, body, opts.ts);
  return app.inject({
    method: 'POST',
    url: `/webhooks/slack/${opts.connId ?? connectionId}/events`,
    headers: { ...hdrs, 'content-type': 'application/json' },
    payload: body,
  });
}

async function postInteractivity(
  payload: unknown,
  opts: { ts?: number; secret?: string; connId?: string } = {},
) {
  const form = 'payload=' + encodeURIComponent(JSON.stringify(payload));
  const hdrs = signedHeaders(opts.secret ?? SIGNING_SECRET, form, opts.ts);
  return app.inject({
    method: 'POST',
    url: `/webhooks/slack/${opts.connId ?? connectionId}/interactivity`,
    headers: { ...hdrs, 'content-type': 'application/x-www-form-urlencoded' },
    payload: form,
  });
}

// ---- envelope + id builders ----
let evSeq = 0;
let tsSeq = 0;
/** A fresh, unique Slack message ts (dedupe wall is per (channel, ts)). */
function newTs(): string {
  tsSeq += 1;
  return `1720000${String(tsSeq).padStart(4, '0')}.000100`;
}
function messageEnvelope(event: Record<string, unknown>) {
  evSeq += 1;
  return { type: 'event_callback', event_id: `ev-${evSeq}`, event: { type: 'message', ...event } };
}

// ---- bridge brain: echoes; the "buttons" keyword returns an actions reply ----
const brain = defineAgent({
  onMessage(ctx) {
    if (ctx.message.text.includes('buttons')) {
      ctx.reply('Choose an option:', {
        buttons: [
          { id: 'opt_a', label: 'Option A' },
          { id: 'opt_b', label: 'Option B' },
        ],
      });
      return;
    }
    return `echo: ${ctx.message.text}`;
  },
  onAction(ctx) {
    return `clicked:${ctx.action?.id}`;
  },
});

/** Stand up a bridge agent whose signing secret the handler reads per-request. */
async function createAgent(identifier: string): Promise<void> {
  const holder = { secret: 'placeholder-until-created' };
  const server = createServer((req, res) =>
    createHandler(brain, { signingSecret: holder.secret })(req, res),
  );
  await new Promise<void>((r) => server.listen(0, r));
  bridges.push(server);
  const url = `http://localhost:${(server.address() as AddressInfo).port}/`;
  const created = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: headers(),
    payload: { identifier, name: identifier, bridgeUrl: url },
  });
  expect(created.statusCode).toBe(201);
  holder.secret = json(created).signingSecret;
}

// ---- small DB helpers (the transcript API doesn't surface `raw`) ----
async function convByThread(
  threadKey: string,
): Promise<{ id: string; agent_id: string; subscriber_id: string } | undefined> {
  const { rows } = await pool.query(
    'select id, agent_id, subscriber_id from conversations where connection_id = $1 and thread_key = $2',
    [connectionId, threadKey],
  );
  return rows[0];
}
async function convAgentIdentifier(conversationId: string): Promise<string> {
  const { rows } = await pool.query(
    'select a.identifier from conversations c join agents a on a.id = c.agent_id where c.id = $1',
    [conversationId],
  );
  return rows[0]?.identifier;
}
async function convSubscriberExternalId(conversationId: string): Promise<string> {
  const { rows } = await pool.query(
    'select s.external_id from conversations c join subscribers s on s.id = c.subscriber_id where c.id = $1',
    [conversationId],
  );
  return rows[0]?.external_id;
}
async function rowBySlackTs(
  conversationId: string,
  ts: string,
): Promise<{ id: string; content: string; role: string; raw: Record<string, unknown>; edited_at: string | null; deleted_by: string | null } | undefined> {
  const { rows } = await pool.query(
    `select id, content, role, raw, edited_at, deleted_by from conversation_messages
      where conversation_id = $1 and raw->>'slackTs' = $2 limit 1`,
    [conversationId, ts],
  );
  return rows[0];
}
async function userRowCount(conversationId: string): Promise<number> {
  const { rows } = await pool.query(
    `select count(*)::int as n from conversation_messages where conversation_id = $1 and role = 'user'`,
    [conversationId],
  );
  return rows[0].n;
}
async function latestAgentRow(
  conversationId: string,
): Promise<{ id: string; content: string; raw: Record<string, unknown> }> {
  const { rows } = await pool.query(
    `select id, content, raw from conversation_messages
      where conversation_id = $1 and role = 'agent' order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0];
}
/** Drive the real processor over a conversation's latest inbound user turn. */
async function driveLatestTurn(conversationId: string): Promise<void> {
  const detail = json(
    await app.inject({
      method: 'GET',
      url: `/v1/conversations/${conversationId}`,
      headers: headers(),
    }),
  );
  const turn = detail.messages.findLast((m: { role: string }) => m.role === 'user');
  const data: ConversationJobData = { tenantId, conversationId, messageId: turn.id };
  await processConversation({ data } as Job<ConversationJobData>);
}
const postMessagesTo = (channel: string) =>
  slackCalls.filter((c) => c.method === 'chat.postMessage' && c.body.channel === channel);
const updatesTo = (channel: string) =>
  slackCalls.filter((c) => c.method === 'chat.update' && c.body.channel === channel);

beforeAll(async () => {
  await startSlackStub();
  process.env.SLACK_API_BASE = `http://localhost:${(slackStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `slack-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Slack IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Slack IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  await createAgent('slack-default');
  await createAgent('slack-billing');
  await createAgent('slack-disabled');
});

afterAll(async () => {
  delete process.env.SLACK_API_BASE;
  slackStub?.close();
  for (const b of bridges) b.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('1. connect', () => {
  test('a bad bot-token shape is rejected before Slack is called', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/slack',
      headers: headers(),
      payload: { botToken: 'xoxb-tooshort', signingSecret: SIGNING_SECRET, agentIdentifier: 'slack-default' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('a missing signing secret is a 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/slack',
      headers: headers(),
      payload: { botToken: TOKEN_MAIN, agentIdentifier: 'slack-default' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('a token Slack rejects (auth.test ok:false) is a 422', async () => {
    authTest.ok = false;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/slack',
      headers: headers(),
      payload: { botToken: TOKEN_MAIN, signingSecret: SIGNING_SECRET, agentIdentifier: 'slack-default' },
    });
    expect(res.statusCode).toBe(422);
    authTest.ok = true;
  });

  test('connect validates the token and returns both paste-in URLs', async () => {
    const before = slackCalls.filter((c) => c.method === 'auth.test').length;
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/slack',
      headers: headers(),
      payload: { botToken: TOKEN_MAIN, signingSecret: SIGNING_SECRET, agentIdentifier: 'slack-default' },
    });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.channel).toBe('slack');
    expect(body.teamName).toBe('Test Team');
    expect(body.eventsUrl).toContain('/webhooks/slack/');
    expect(body.eventsUrl).toMatch(/\/events$/);
    expect(body.interactivityUrl).toMatch(/\/interactivity$/);
    // auth.test was actually called against the stub.
    expect(slackCalls.filter((c) => c.method === 'auth.test').length).toBe(before + 1);

    connectionId = body.eventsUrl.match(/\/webhooks\/slack\/([0-9a-f-]{36})\/events/)![1];
    expect(body.eventsUrl).toBe(`http://localhost:3000/webhooks/slack/${connectionId}/events`);
    expect(body.interactivityUrl).toBe(
      `http://localhost:3000/webhooks/slack/${connectionId}/interactivity`,
    );
  });

  test('the listing surfaces the slack row with both webhook URLs', async () => {
    const list = json(
      await app.inject({ method: 'GET', url: '/v1/connections', headers: headers() }),
    );
    const row = list.connections.find((c: { id: string }) => c.id === connectionId);
    expect(row.channel).toBe('slack');
    expect(row.status).toBe('active');
    expect(row.config.teamName).toBe('Test Team');
    expect(row.webhook.eventsUrl).toContain(`/webhooks/slack/${connectionId}/events`);
    expect(row.webhook.interactivityUrl).toContain(`/webhooks/slack/${connectionId}/interactivity`);
  });

  test('re-connecting the same workspace to a new agent keeps the id and moves live threads', async () => {
    // A live DM thread under the current default (slack-default).
    const chan = 'D0MOVE01';
    const res = await postEvent(
      messageEnvelope({ channel: chan, channel_type: 'im', user: 'U0MOVE01', text: 'hi', ts: newTs() }),
    );
    expect(res.statusCode).toBe(200);
    const conv = await convByThread(chan);
    expect(conv).toBeDefined();
    expect(await convAgentIdentifier(conv!.id)).toBe('slack-default');

    // Same token, different agent → identity-upsert hits the same row.
    const re = await app.inject({
      method: 'POST',
      url: '/v1/connections/slack',
      headers: headers(),
      payload: { botToken: TOKEN_MAIN, signingSecret: SIGNING_SECRET, agentIdentifier: 'slack-billing' },
    });
    expect(re.statusCode).toBe(201);
    // Only one slack connection exists, and it is the same id.
    const list = json(
      await app.inject({ method: 'GET', url: '/v1/connections', headers: headers() }),
    );
    const slackRows = list.connections.filter((c: { channel: string }) => c.channel === 'slack');
    expect(slackRows.length).toBe(1);
    expect(slackRows[0].id).toBe(connectionId);
    // The live thread followed the connection onto slack-billing.
    expect(await convAgentIdentifier(conv!.id)).toBe('slack-billing');

    // Re-point back so the rest of the suite runs on the default agent again.
    const back = await app.inject({
      method: 'POST',
      url: '/v1/connections/slack',
      headers: headers(),
      payload: { botToken: TOKEN_MAIN, signingSecret: SIGNING_SECRET, agentIdentifier: 'slack-default' },
    });
    expect(back.statusCode).toBe(201);
    expect(await convAgentIdentifier(conv!.id)).toBe('slack-default');
  });
});

describe('2. url_verification + signature', () => {
  test('a signed handshake echoes the challenge', async () => {
    const res = await postEvent({ type: 'url_verification', challenge: 'chg-abc-123' });
    expect(res.statusCode).toBe(200);
    expect(json(res).challenge).toBe('chg-abc-123');
  });

  test('a body that does not match its signature is 401', async () => {
    const signed = JSON.stringify({ type: 'url_verification', challenge: 'chg-signed' });
    const sent = JSON.stringify({ type: 'url_verification', challenge: 'chg-TAMPERED' });
    const hdrs = signedHeaders(SIGNING_SECRET, signed);
    const res = await app.inject({
      method: 'POST',
      url: `/webhooks/slack/${connectionId}/events`,
      headers: { ...hdrs, 'content-type': 'application/json' },
      payload: sent,
    });
    expect(res.statusCode).toBe(401);
  });

  test('a stale timestamp (outside tolerance) is 401', async () => {
    const res = await postEvent(
      { type: 'url_verification', challenge: 'chg-stale' },
      { ts: Math.floor(Date.now() / 1000) - 400 },
    );
    expect(res.statusCode).toBe(401);
  });

  test('a non-uuid connection is 404 (before any signature work)', async () => {
    const res = await postEvent({ type: 'url_verification', challenge: 'x' }, { connId: 'not-a-uuid' });
    expect(res.statusCode).toBe(404);
  });
});

describe('3. DM turn', () => {
  test('a DM opens a conversation keyed by the channel, stores slack crumbs, enqueues a job', async () => {
    usersInfo.mode = 'ok';
    usersInfo.email = null;
    const chan = 'D0TEST01';
    const ts = newTs();
    const res = await postEvent(
      messageEnvelope({ channel: chan, channel_type: 'im', user: 'U0USER01', text: 'hello slack', ts }),
    );
    expect(res.statusCode).toBe(200);
    expect(json(res).ok).toBe(true);

    const conv = await convByThread(chan);
    expect(conv).toBeDefined();
    expect(await convSubscriberExternalId(conv!.id)).toBe('slack-U0USER01');

    const row = await rowBySlackTs(conv!.id, ts);
    expect(row).toBeDefined();
    expect(row!.content).toBe('hello slack');
    expect(row!.raw.slackTs).toBe(ts);
    expect(row!.raw.slackChannel).toBe(chan);

    // The turn was enqueued for the brain under the standard conv-<rowId> id.
    const job = await getQueue(QUEUE.CONVERSATION).getJob(`conv-${row!.id}`);
    expect(job).toBeTruthy();
  });
});

describe('4. email auto-match', () => {
  test('users.info email that equals a real subscriber links the DM to that subscriber', async () => {
    const matchEmail = 'match4@example.com';
    await pool.query(
      `insert into subscribers (tenant_id, external_id, email) values ($1, $2, $3)`,
      [tenantId, 'real-person-4', matchEmail],
    );
    const seededId = (
      await pool.query('select id from subscribers where tenant_id = $1 and external_id = $2', [
        tenantId,
        'real-person-4',
      ])
    ).rows[0].id as string;

    usersInfo.mode = 'ok';
    usersInfo.email = matchEmail;
    const chan = 'D0TEST04';
    const res = await postEvent(
      messageEnvelope({ channel: chan, channel_type: 'im', user: 'U0USER04', text: 'hi from slack', ts: newTs() }),
    );
    expect(res.statusCode).toBe(200);

    const conv = await convByThread(chan);
    expect(await convSubscriberExternalId(conv!.id)).toBe('real-person-4');

    // The mapping was written so future turns skip the lookup.
    const identity = await pool.query(
      `select subscriber_id from channel_identities where tenant_id = $1 and channel = 'slack' and external_key = $2`,
      [tenantId, 'U0USER04'],
    );
    expect(identity.rows[0].subscriber_id).toBe(seededId);
  });

  test('a users.info 500 falls back to the channel-local slack-<userId> without erroring', async () => {
    usersInfo.mode = 'error';
    usersInfo.email = null;
    const chan = 'D0TEST05';
    const res = await postEvent(
      messageEnvelope({ channel: chan, channel_type: 'im', user: 'U0USER05', text: 'still lands', ts: newTs() }),
    );
    expect(res.statusCode).toBe(200);
    const conv = await convByThread(chan);
    expect(await convSubscriberExternalId(conv!.id)).toBe('slack-U0USER05');
    usersInfo.mode = 'ok';
  });
});

describe('5. channel matrix', () => {
  const CHAN = 'C0CHAN01';

  test('a top-level channel message without a mention is skipped, no conversation', async () => {
    const ts = newTs();
    const res = await postEvent(
      messageEnvelope({ channel: CHAN, channel_type: 'channel', user: 'U0USER01', text: 'just chatting', ts }),
    );
    expect(json(res).skipped).toBe(true);
    expect(await convByThread(`${CHAN}:${ts}`)).toBeUndefined();
  });

  let parentTs = '';
  test('a mention opens a thread conversation with the mention stripped', async () => {
    parentTs = newTs();
    const res = await postEvent(
      messageEnvelope({ channel: CHAN, channel_type: 'channel', user: 'U0USER01', text: '<@UBOT001> help me', ts: parentTs }),
    );
    expect(res.statusCode).toBe(200);
    const conv = await convByThread(`${CHAN}:${parentTs}`);
    expect(conv).toBeDefined();
    const row = await rowBySlackTs(conv!.id, parentTs);
    expect(row!.content).toBe('help me');
  });

  test('a threaded reply without a mention follows the same conversation', async () => {
    const replyTs = newTs();
    const res = await postEvent(
      messageEnvelope({ channel: CHAN, channel_type: 'channel', user: 'U0USER02', text: 'more info', ts: replyTs, thread_ts: parentTs }),
    );
    expect(res.statusCode).toBe(200);
    const conv = await convByThread(`${CHAN}:${parentTs}`);
    expect(await userRowCount(conv!.id)).toBe(2);
  });

  test('a threaded reply to an unknown thread is skipped', async () => {
    const res = await postEvent(
      messageEnvelope({ channel: CHAN, channel_type: 'channel', user: 'U0USER03', text: 'orphan', ts: newTs(), thread_ts: '9999999999.999999' }),
    );
    expect(json(res).skipped).toBe(true);
    expect(await convByThread(`${CHAN}:9999999999.999999`)).toBeUndefined();
  });
});

describe('6. scope routing rules', () => {
  test('a scope rule steers a mention to its agent while a DM keeps the default', async () => {
    const put = await app.inject({
      method: 'PUT',
      url: `/v1/connections/${connectionId}/routes`,
      headers: headers(),
      payload: { scopeKey: 'C0BILL001', agentIdentifier: 'slack-billing' },
    });
    expect(put.statusCode).toBe(200);

    const billTs = newTs();
    await postEvent(
      messageEnvelope({ channel: 'C0BILL001', channel_type: 'channel', user: 'U0USER01', text: '<@UBOT001> billing help', ts: billTs }),
    );
    const billConv = await convByThread(`C0BILL001:${billTs}`);
    expect(await convAgentIdentifier(billConv!.id)).toBe('slack-billing');

    const dmChan = 'D0TEST06';
    await postEvent(
      messageEnvelope({ channel: dmChan, channel_type: 'im', user: 'U0USER06', text: 'a dm', ts: newTs() }),
    );
    const dmConv = await convByThread(dmChan);
    expect(await convAgentIdentifier(dmConv!.id)).toBe('slack-default');
  });

  test('GET routes lists the rule', async () => {
    const res = json(
      await app.inject({
        method: 'GET',
        url: `/v1/connections/${connectionId}/routes`,
        headers: headers(),
      }),
    );
    const rule = res.routes.find((r: { scopeKey: string }) => r.scopeKey === 'C0BILL001');
    expect(rule.agent.identifier).toBe('slack-billing');
  });

  test('after DELETE, a new thread in that scope falls back to the default', async () => {
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/connections/${connectionId}/routes/C0BILL001`,
      headers: headers(),
    });
    expect(json(del).deleted).toBe(true);

    const ts = newTs();
    await postEvent(
      messageEnvelope({ channel: 'C0BILL001', channel_type: 'channel', user: 'U0USER01', text: '<@UBOT001> new thread', ts }),
    );
    const conv = await convByThread(`C0BILL001:${ts}`);
    expect(await convAgentIdentifier(conv!.id)).toBe('slack-default');
  });

  test('a rule pointing at a disabled agent falls back to the default', async () => {
    await app.inject({
      method: 'PUT',
      url: `/v1/connections/${connectionId}/routes`,
      headers: headers(),
      payload: { scopeKey: 'C0DEAD001', agentIdentifier: 'slack-disabled' },
    });
    const patched = await app.inject({
      method: 'PATCH',
      url: '/v1/agents/slack-disabled',
      headers: headers(),
      payload: { status: 'disabled' },
    });
    expect(patched.statusCode).toBe(200);

    const ts = newTs();
    await postEvent(
      messageEnvelope({ channel: 'C0DEAD001', channel_type: 'channel', user: 'U0USER01', text: '<@UBOT001> anyone', ts }),
    );
    const conv = await convByThread(`C0DEAD001:${ts}`);
    expect(await convAgentIdentifier(conv!.id)).toBe('slack-default');
  });

  test('routing rules on a non-slack connection are a 400', async () => {
    // A bare telegram connection row — the route rejects on channel before it
    // ever reads credentials, so a dummy sealed value is fine.
    const agentId = (
      await pool.query('select id from agents where tenant_id = $1 and identifier = $2', [
        tenantId,
        'slack-default',
      ])
    ).rows[0].id as string;
    const tgId = (
      await pool.query(
        `insert into agent_connections (tenant_id, agent_id, channel, credentials, config)
         values ($1, $2, 'telegram', 'dummy', '{}') returning id`,
        [tenantId, agentId],
      )
    ).rows[0].id as string;
    const res = await app.inject({
      method: 'PUT',
      url: `/v1/connections/${tgId}/routes`,
      headers: headers(),
      payload: { scopeKey: 'C0BILL001', agentIdentifier: 'slack-default' },
    });
    expect(res.statusCode).toBe(400);
  });

  test('an unknown agent is a 404 and a malformed scopeKey is a 400', async () => {
    const unknown = await app.inject({
      method: 'PUT',
      url: `/v1/connections/${connectionId}/routes`,
      headers: headers(),
      payload: { scopeKey: 'C0BILL001', agentIdentifier: 'nobody' },
    });
    expect(unknown.statusCode).toBe(404);

    const bad = await app.inject({
      method: 'PUT',
      url: `/v1/connections/${connectionId}/routes`,
      headers: headers(),
      payload: { scopeKey: 'banana', agentIdentifier: 'slack-default' },
    });
    expect(bad.statusCode).toBe(400);
  });
});

describe('7. dedupe', () => {
  test('a re-posted event acks as duplicate and never doubles the row', async () => {
    const chan = 'D0TEST07';
    const ts = newTs();
    const envelope = messageEnvelope({ channel: chan, channel_type: 'im', user: 'U0USER07', text: 'once please', ts });
    const first = await postEvent(envelope);
    expect(json(first).ok).toBe(true);

    const retry = await app.inject({
      method: 'POST',
      url: `/webhooks/slack/${connectionId}/events`,
      headers: {
        ...signedHeaders(SIGNING_SECRET, JSON.stringify(envelope)),
        'content-type': 'application/json',
        'x-slack-retry-num': '1',
      },
      payload: JSON.stringify(envelope),
    });
    expect(json(retry).duplicate).toBe(true);

    const conv = await convByThread(chan);
    expect(await userRowCount(conv!.id)).toBe(1);

    // The app_mention echo of the same message is skipped, no extra row.
    const mention = await postEvent({
      type: 'event_callback',
      event_id: `ev-appm`,
      event: { type: 'app_mention', channel: chan, channel_type: 'channel', user: 'U0USER07', text: 'once please', ts },
    });
    expect(json(mention).skipped).toBe(true);
    expect(await userRowCount(conv!.id)).toBe(1);
  });
});

describe('8. bot echo guard', () => {
  test('a message carrying bot_id is skipped with no row', async () => {
    const chan = 'D0TEST08';
    const res = await postEvent(
      messageEnvelope({ channel: chan, channel_type: 'im', bot_id: 'B999', text: 'i am a bot', ts: newTs() }),
    );
    expect(json(res).skipped).toBe(true);
    expect(await convByThread(chan)).toBeUndefined();
  });

  test('a message from our own bot user id is skipped', async () => {
    const chan = 'D0TEST08b';
    const res = await postEvent(
      messageEnvelope({ channel: chan, channel_type: 'im', user: 'UBOT001', text: 'my own echo', ts: newTs() }),
    );
    expect(json(res).skipped).toBe(true);
    expect(await convByThread(chan)).toBeUndefined();
  });
});

describe('9. buttons round-trip', () => {
  test('a reply with buttons posts an actions block and a click ingests + retires it', async () => {
    const chan = 'D0TEST09';
    await postEvent(
      messageEnvelope({ channel: chan, channel_type: 'im', user: 'U0USER09', text: 'give me buttons', ts: newTs() }),
    );
    const conv = await convByThread(chan);
    await driveLatestTurn(conv!.id);

    // The reply went out as a section + actions block; action_id == value == id.
    const pm = postMessagesTo(chan).at(-1)!;
    const blocks = pm.body.blocks as Array<{ type: string; elements?: Array<{ action_id: string; value: string }> }>;
    const actions = blocks.find((b) => b.type === 'actions')!;
    expect(actions.elements!.map((e) => ({ action_id: e.action_id, value: e.value }))).toEqual([
      { action_id: 'opt_a', value: 'opt_a' },
      { action_id: 'opt_b', value: 'opt_b' },
    ]);

    const replyRow = await latestAgentRow(conv!.id);
    const sentTs = replyRow.raw.slackTs as string;

    // The button press comes back on the interactivity webhook.
    const actionTs = '1720000099.222333';
    const payload = {
      type: 'block_actions',
      user: { id: 'U0USER09' },
      channel: { id: chan },
      message: { ts: sentTs, text: replyRow.content },
      actions: [{ action_id: 'opt_a', action_ts: actionTs, text: { type: 'plain_text', text: 'Option A' } }],
    };
    const click = await postInteractivity(payload);
    expect(click.statusCode).toBe(200);
    expect(json(click).ok).toBe(true);

    // The click was stored as a user row carrying the label + the action id.
    const actionRow = (
      await pool.query(
        `select content, raw from conversation_messages
          where conversation_id = $1 and raw->'action'->>'id' = 'opt_a' limit 1`,
        [conv!.id],
      )
    ).rows[0];
    expect(actionRow.content).toBe('Option A');
    expect(actionRow.raw.action.id).toBe('opt_a');

    // The button set retired via chat.update (choice appended).
    const upd = updatesTo(chan);
    expect(upd.length).toBe(1);
    expect(String(upd[0].body.text)).toContain('✓ Option A');

    // A duplicate click (same action_ts) acks as duplicate; still one update.
    const dup = await postInteractivity(payload);
    expect(json(dup).duplicate).toBe(true);
    expect(updatesTo(chan).length).toBe(1);
  });
});

describe('10. edits and deletes', () => {
  const chan = 'D0TEST10';
  let editTs = '';

  test('a message_changed rewrites the row in place, sets edited_at, no new turn', async () => {
    editTs = newTs();
    await postEvent(
      messageEnvelope({ channel: chan, channel_type: 'im', user: 'U0USER10', text: 'original text', ts: editTs }),
    );
    const conv = await convByThread(chan);
    const before = await userRowCount(conv!.id);

    const res = await postEvent(
      messageEnvelope({
        channel: chan,
        channel_type: 'im',
        subtype: 'message_changed',
        message: { ts: editTs, text: 'edited text', user: 'U0USER10' },
      }),
    );
    expect(json(res).edited).toBe(true);

    const row = await rowBySlackTs(conv!.id, editTs);
    expect(row!.content).toBe('edited text');
    expect(row!.edited_at).toBeTruthy();
    // An edit is not a new turn.
    expect(await userRowCount(conv!.id)).toBe(before);
  });

  test('a message_changed for a bot message is skipped', async () => {
    const res = await postEvent(
      messageEnvelope({
        channel: chan,
        channel_type: 'im',
        subtype: 'message_changed',
        message: { ts: editTs, text: 'nope', bot_id: 'B999' },
      }),
    );
    expect(json(res).skipped).toBe(true);
  });

  test('a message_deleted tombstones the row as deleted_by user', async () => {
    const res = await postEvent(
      messageEnvelope({
        channel: chan,
        channel_type: 'im',
        subtype: 'message_deleted',
        deleted_ts: editTs,
        previous_message: { ts: editTs },
      }),
    );
    expect(json(res).deleted).toBe(true);
    const conv = await convByThread(chan);
    const row = await rowBySlackTs(conv!.id, editTs);
    expect(row!.content).toBe('');
    expect(row!.deleted_by).toBe('user');
  });
});

let sendOnceConvId = '';
describe('11. reply send-once', () => {
  test('re-driving a delivered turn never posts the reply twice', async () => {
    const chan = 'D0TEST11';
    await postEvent(
      messageEnvelope({ channel: chan, channel_type: 'im', user: 'U0USER11', text: 'hello once', ts: newTs() }),
    );
    const conv = await convByThread(chan);
    sendOnceConvId = conv!.id;

    await driveLatestTurn(conv!.id);
    expect(postMessagesTo(chan).length).toBe(1);
    expect(String(postMessagesTo(chan)[0].body.text)).toBe('echo: hello once');

    // Crash-retry simulation: the send-once guard holds.
    await driveLatestTurn(conv!.id);
    expect(postMessagesTo(chan).length).toBe(1);
  });
});

describe('12. operator delete', () => {
  test('deleting an agent reply calls chat.delete with the stored channel + ts', async () => {
    const reply = await latestAgentRow(sendOnceConvId);
    const chan = reply.raw.slackChannel as string;
    const ts = reply.raw.slackTs as string;

    const before = slackCalls.filter((c) => c.method === 'chat.delete').length;
    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/conversations/${sendOnceConvId}/messages/${reply.id}`,
      headers: headers(),
    });
    expect(json(del).deleted).toBe(true);

    const deletes = slackCalls.filter((c) => c.method === 'chat.delete');
    expect(deletes.length).toBe(before + 1);
    expect(deletes.at(-1)!.body.channel).toBe(chan);
    expect(deletes.at(-1)!.body.ts).toBe(ts);
  });
});

describe('13. reconnect is a static 400', () => {
  test('reconnect on a slack connection reports the URLs are static', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/connections/${connectionId}/reconnect`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(400);
    expect(String(json(res).error)).toContain('static');
  });
});
