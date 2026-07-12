/**
 * The /v1/me self-service family (Phase 15): a subscriber's OWN browser/app
 * calling with its short-lived subscriber token (x-subscriber-token) to see
 * which channels it can link, mint a link/redirect for one, and unlink an
 * identity. The token IS the identity — no api key is ever accepted here.
 *
 * Everything runs the production path: real signup, real telegram + slack
 * connects (stubs stand in for the telegram/slack HTTP APIs), the real
 * /start linking handshake, and the real me routes. Nothing is faked but the
 * two upstream APIs and the (negative-ttl) expired token.
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
import { createHandler, defineAgent } from '../../packages/agent/src/index';
import { mintSubscriberToken } from '../../src/auth/subscriber-token';
import { upsertSubscriber } from '../../src/db/repositories';
import { upsertChannelIdentity } from '../../src/db/identities.repo';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let bridge: Server;

const json = (res: { body: string }) => JSON.parse(res.body);

// ---- stub Telegram API (getMe / setWebhook / sendMessage) ----
let tgStub: Server;
const tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
let webhookSecretSeen = '';
const BOT_USERNAME = 'me_link_bot';

function startTelegramStub(): Promise<void> {
  tgStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = String(req.url).split('/').pop() ?? '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      tgCalls.push({ method, body });
      if (method === 'setWebhook') webhookSecretSeen = String(body.secret_token ?? '');
      const results: Record<string, unknown> = {
        getMe: { id: 7_300_000, is_bot: true, username: BOT_USERNAME },
        setWebhook: true,
        deleteWebhook: true,
        getWebhookInfo: { url: 'https://example.test/hook', pending_update_count: 0 },
        sendMessage: { message_id: 1000 + tgCalls.length },
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: method in results, result: results[method] }));
    });
  });
  return new Promise((r) => tgStub.listen(0, () => r()));
}
const sends = () => tgCalls.filter((c) => c.method === 'sendMessage');

// ---- stub Slack Web API (auth.test / bots.info), records every call ----
let slackStub: Server;
const slackCalls: Array<{ method: string; token: string }> = [];
let botsInfoMode: 'ok' | 'error' = 'ok';
const SLACK_APP_ID = 'A0TESTAPP';

function startSlackStub(): Promise<void> {
  slackStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const url = new URL(String(req.url), 'http://stub');
      const method = url.pathname.split('/').pop() ?? '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
      slackCalls.push({ method, token });
      res.setHeader('content-type', 'application/json; charset=utf-8');
      if (method === 'auth.test') {
        return res.end(
          JSON.stringify({
            ok: true,
            team_id: 'T0ME00001',
            team: 'Me Test Team',
            user_id: 'UBOT001',
            bot_id: 'B001',
          }),
        );
      }
      if (method === 'bots.info') {
        if (botsInfoMode === 'error') {
          res.statusCode = 500;
          return res.end(JSON.stringify({ ok: false, error: 'internal_error' }));
        }
        // bots.info takes its arg as a QUERY param (Slack ignores JSON bodies here).
        const botId = url.searchParams.get('bot') ?? body.bot;
        return res.end(JSON.stringify({ ok: true, bot: { id: botId, app_id: SLACK_APP_ID } }));
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'unknown_method' }));
    });
  });
  return new Promise((r) => slackStub.listen(0, () => r()));
}

// ---- a trivial bridge agent (never actually invoked — me routes don't
// dispatch to the brain; the /start handshake replies via the tg stub) ----
const brain = defineAgent({
  onMessage(ctx) {
    return `echo: ${ctx.message.text}`;
  },
});

let tgConnId = '';
let slackConnId = '';

// ---- me-route helpers (x-subscriber-token auth) ----
async function mintToken(subscriberId: string, ttlSeconds = 3600): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/subscriber-tokens',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, ttlSeconds },
  });
  return json(res).token as string;
}

interface ChannelRow {
  connectionId: string | null;
  channel: string;
  label: string;
  linked: boolean;
  identities: Array<{ externalKey: string; linkedAt: string }>;
}
async function meChannels(token: string): Promise<{ status: number; channels: ChannelRow[] }> {
  const res = await app.inject({
    method: 'GET',
    url: '/v1/me/channels',
    headers: { 'x-subscriber-token': token },
  });
  return { status: res.statusCode, channels: json(res).channels };
}
async function meLink(token: string, connectionId: string) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/me/link-tokens',
    headers: { 'x-subscriber-token': token },
    payload: { connectionId },
  });
  return { status: res.statusCode, body: json(res) };
}
async function meUnlink(token: string, body: unknown) {
  const res = await app.inject({
    method: 'DELETE',
    url: '/v1/me/identities',
    headers: { 'x-subscriber-token': token },
    payload: body as Record<string, unknown>,
  });
  return { status: res.statusCode, body: json(res) };
}

/** Post a `/start <token>` update to the telegram webhook as a given tg user. */
async function postStart(startToken: string, tgUserId: number) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/telegram/${tgConnId}`,
    headers: { 'x-telegram-bot-api-secret-token': webhookSecretSeen },
    payload: {
      update_id: tgUserId,
      message: {
        message_id: tgUserId * 10,
        date: 1_700_000_000,
        text: `/start ${startToken}`,
        from: { id: tgUserId, is_bot: false, first_name: 'U' },
        chat: { id: tgUserId, type: 'private' },
      },
    },
  });
}

/** Mint a me link token as the subscriber, then complete the /start handshake. */
async function linkTelegram(subscriberId: string, tgUserId: number): Promise<string> {
  const token = await mintToken(subscriberId);
  const minted = await meLink(token, tgConnId);
  expect(minted.status).toBe(201);
  const startToken = /start=([0-9a-f]{48})/.exec(minted.body.url)![1];
  const res = await postStart(startToken, tgUserId);
  expect(json(res).linked).toBe(true);
  return token;
}

beforeAll(async () => {
  await startTelegramStub();
  await startSlackStub();
  process.env.TELEGRAM_API_BASE = `http://localhost:${(tgStub.address() as AddressInfo).port}`;
  process.env.SLACK_API_BASE = `http://localhost:${(slackStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `me-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Me IT', email, password: 'integration-pw-1', organizationName: 'Me IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  // A bridge agent to own the connections (its brain is never invoked here).
  const holder = { secret: 'placeholder' };
  bridge = createServer((req, res) => createHandler(brain, { signingSecret: holder.secret })(req, res));
  await new Promise<void>((r) => bridge.listen(0, r));
  const created = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier: 'me-agent',
      name: 'Me Agent',
      bridgeUrl: `http://localhost:${(bridge.address() as AddressInfo).port}/`,
    },
  });
  holder.secret = json(created).signingSecret;

  // One telegram, one slack, one email connection for the tenant.
  const tg = await app.inject({
    method: 'POST',
    url: '/v1/connections/telegram',
    headers: { 'x-api-key': apiKey },
    payload: { botToken: '7300000:AAme-link-telegram-token_0123456789ABC', agentIdentifier: 'me-agent' },
  });
  tgConnId = json(tg).webhookUrl.split('/').pop();

  const sl = await app.inject({
    method: 'POST',
    url: '/v1/connections/slack',
    headers: { 'x-api-key': apiKey },
    payload: {
      botToken: 'xoxb-me-slack-0123456789ABCDEFGH',
      signingSecret: 'me-slack-signing-secret-abcdef',
      agentIdentifier: 'me-agent',
    },
  });
  slackConnId = json(sl).eventsUrl.match(/\/webhooks\/slack\/([0-9a-f-]{36})\/events/)![1];

  await app.inject({
    method: 'POST',
    url: '/v1/connections/email',
    headers: { 'x-api-key': apiKey },
    payload: { address: 'me-inbound@inbound.postmarkapp.com', agentIdentifier: 'me-agent' },
  });
});

afterAll(async () => {
  delete process.env.TELEGRAM_API_BASE;
  delete process.env.SLACK_API_BASE;
  tgStub?.close();
  slackStub?.close();
  bridge?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('1. auth: only a valid subscriber token is accepted', () => {
  test('a missing header is 401', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/me/channels' });
    expect(res.statusCode).toBe(401);
    expect(json(res).error).toBe('invalid subscriber token');
  });

  test('an api key is NOT a subscriber credential (401)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/channels',
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(401);
  });

  test('a garbage token is 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/channels',
      headers: { 'x-subscriber-token': 'nst_not-a-real-token.deadbeef' },
    });
    expect(res.statusCode).toBe(401);
  });

  test('an expired token is 401', async () => {
    // Built with the real signer but a NEGATIVE ttl: the HMAC is valid, so this
    // exercises the expiry branch specifically (e < now), not a bad signature.
    const { token } = mintSubscriberToken(tenantId, 'me-expired', -60);
    const res = await app.inject({
      method: 'GET',
      url: '/v1/me/channels',
      headers: { 'x-subscriber-token': token },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('2. GET /v1/me/channels shape + strict projection', () => {
  const ALLOWED_ROW_KEYS = ['channel', 'connectionId', 'identities', 'label', 'linked'];

  test('an unlinked subscriber sees the telegram + slack rows, no email row, no leaked fields', async () => {
    const token = await mintToken('me-shape');
    const { status, channels } = await meChannels(token);
    expect(status).toBe(200);

    const tgRow = channels.find((c) => c.channel === 'telegram')!;
    expect(tgRow.connectionId).toBe(tgConnId);
    expect(tgRow.label).toBe('@' + BOT_USERNAME);
    expect(tgRow.linked).toBe(false);
    expect(tgRow.identities).toEqual([]);

    const slackRow = channels.find((c) => c.channel === 'slack')!;
    expect(slackRow.connectionId).toBe(slackConnId);
    expect(slackRow.label).toBe('Me Test Team');
    expect(slackRow.linked).toBe(false);

    // Email connection exists in the tenant but surfaces NO row until an email
    // identity is linked (the identity IS the address).
    expect(channels.some((c) => c.channel === 'email')).toBe(false);
    expect(channels.length).toBe(2);

    // Strict projection: every row carries EXACTLY the allowed keys.
    for (const row of channels) {
      expect(Object.keys(row).sort()).toEqual(ALLOWED_ROW_KEYS);
    }
    // And no upstream secret/id names leak anywhere in the payload.
    const raw = JSON.stringify(channels);
    for (const forbidden of ['webhook', 'botUserId', 'teamId', 'appId', 'credentials', 'botId']) {
      expect(raw.includes(`"${forbidden}"`)).toBe(false);
    }
  });
});

describe('3. telegram link-token full loop', () => {
  test('mint a deep link (no token field), tap /start, then the identity shows linked', async () => {
    const TG_USER = 730_003;
    const token = await mintToken('me-tg-3');

    const minted = await meLink(token, tgConnId);
    expect(minted.status).toBe(201);
    expect(minted.body.kind).toBe('telegram_deeplink');
    expect(minted.body.url).toMatch(new RegExp(`^https://t\\.me/${BOT_USERNAME}\\?start=[0-9a-f]{48}$`));
    expect(minted.body.expiresAt).toBeTruthy();
    expect('token' in minted.body).toBe(false); // the raw token never leaves

    const startToken = /start=([0-9a-f]{48})/.exec(minted.body.url)![1];
    const sendsBefore = sends().length;
    const res = await postStart(startToken, TG_USER);
    expect(json(res).linked).toBe(true);
    // The bot confirmed in-chat.
    expect(sends().length).toBe(sendsBefore + 1);
    expect(String(sends().at(-1)?.body.text)).toContain('me-tg-3');

    const { channels } = await meChannels(token);
    const tgRow = channels.find((c) => c.channel === 'telegram')!;
    expect(tgRow.linked).toBe(true);
    expect(tgRow.identities).toHaveLength(1);
    expect(tgRow.identities[0].externalKey).toBe(String(TG_USER));
    expect(tgRow.identities[0].linkedAt).toBeTruthy();
  });
});

describe('4. slack lazy appId backfill (persist = cache)', () => {
  test('a missing appId is fetched via auth.test + bots.info, persisted, then re-used with no calls', async () => {
    const token = await mintToken('me-slack-4');

    // Simulate a pre-phase row: strip the appId captured at connect time.
    await pool.query(
      `update agent_connections set config = config - 'appId' where tenant_id = $1 and id = $2`,
      [tenantId, slackConnId],
    );
    slackCalls.length = 0;

    const first = await meLink(token, slackConnId);
    expect(first.status).toBe(201);
    expect(first.body.kind).toBe('slack_redirect');
    expect(String(first.body.url)).toContain(`app_redirect?app=${SLACK_APP_ID}`);
    expect(String(first.body.url)).toContain('&team=T');

    // The backfill actually hit Slack...
    expect(slackCalls.some((c) => c.method === 'auth.test')).toBe(true);
    expect(slackCalls.some((c) => c.method === 'bots.info')).toBe(true);
    // ...and persisted the appId.
    const { rows } = await pool.query('select config from agent_connections where id = $1', [
      slackConnId,
    ]);
    expect(rows[0].config.appId).toBe(SLACK_APP_ID);

    // Second call reads the cached appId — ZERO slack calls.
    slackCalls.length = 0;
    const second = await meLink(token, slackConnId);
    expect(second.status).toBe(201);
    expect(second.body.kind).toBe('slack_redirect');
    expect(slackCalls.length).toBe(0);
  });
});

describe('5. slack backfill failure surfaces a 502', () => {
  test('when bots.info fails the appId cannot be determined; config is left unchanged', async () => {
    const token = await mintToken('me-slack-5');
    await pool.query(
      `update agent_connections set config = config - 'appId' where tenant_id = $1 and id = $2`,
      [tenantId, slackConnId],
    );

    botsInfoMode = 'error';
    const failed = await meLink(token, slackConnId);
    expect(failed.status).toBe(502);
    expect(String(failed.body.error)).toContain('reconnect the workspace');
    const stillNull = await pool.query('select config from agent_connections where id = $1', [
      slackConnId,
    ]);
    expect(stillNull.rows[0].config.appId).toBeUndefined();

    // Recover once Slack answers again.
    botsInfoMode = 'ok';
    const ok = await meLink(token, slackConnId);
    expect(ok.status).toBe(201);
    expect(ok.body.kind).toBe('slack_redirect');
  });
});

describe('6. email identities are display-only rows', () => {
  test('an email identity surfaces a {connectionId:null, linked:true} row labelled by the address', async () => {
    const address = 'me-email-6@example.com';
    const sub = await upsertSubscriber(tenantId, { subscriberId: 'me-email-6' });
    await upsertChannelIdentity({
      tenantId,
      channel: 'email',
      externalKey: address,
      subscriberId: sub.id,
    });

    const token = await mintToken('me-email-6');
    const { channels } = await meChannels(token);
    const emailRow = channels.find((c) => c.channel === 'email')!;
    expect(emailRow.connectionId).toBeNull();
    expect(emailRow.linked).toBe(true);
    expect(emailRow.label).toBe(address);
    expect(emailRow.identities[0].externalKey).toBe(address);
  });
});

describe('7. unlink my own identity', () => {
  test('DELETE removes the mapping; the row is gone and the channel reads unlinked', async () => {
    const TG_USER = 730_007;
    const token = await linkTelegram('me-tg-7', TG_USER);

    const del = await meUnlink(token, { channel: 'telegram', externalKey: String(TG_USER) });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(true);

    const { channels } = await meChannels(token);
    expect(channels.find((c) => c.channel === 'telegram')!.linked).toBe(false);
    const { rows } = await pool.query(
      `select 1 from channel_identities where tenant_id = $1 and channel = 'telegram' and external_key = $2`,
      [tenantId, String(TG_USER)],
    );
    expect(rows.length).toBe(0);
  });
});

describe('8. ownership: I cannot unlink someone else’s identity', () => {
  test('B deleting A’s external key returns {deleted:false} and leaves A linked', async () => {
    const TG_USER = 730_081;
    const tokenA = await linkTelegram('me-own-a', TG_USER);
    const tokenB = await mintToken('me-own-b');

    const del = await meUnlink(tokenB, { channel: 'telegram', externalKey: String(TG_USER) });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(false); // indistinguishable from "no such identity"

    // A still owns it.
    const { channels } = await meChannels(tokenA);
    const tgRow = channels.find((c) => c.channel === 'telegram')!;
    expect(tgRow.linked).toBe(true);
    expect(tgRow.identities[0].externalKey).toBe(String(TG_USER));
  });
});

describe('9. unlink edge cases', () => {
  test('a nonexistent identity returns {deleted:false}', async () => {
    const token = await mintToken('me-none-9');
    const del = await meUnlink(token, { channel: 'telegram', externalKey: '999999999' });
    expect(del.status).toBe(200);
    expect(del.body.deleted).toBe(false);
  });

  test('an invalid channel is a 400', async () => {
    const token = await mintToken('me-none-9');
    const del = await meUnlink(token, { channel: 'carrier-pigeon', externalKey: 'x' });
    expect(del.status).toBe(400);
  });
});

describe('10. isolation: one subscriber’s link is invisible to another', () => {
  test('while A is linked, B still sees telegram as unlinked', async () => {
    const TG_USER = 730_010;
    await linkTelegram('me-iso-a', TG_USER);

    const tokenB = await mintToken('me-iso-b');
    const { channels } = await meChannels(tokenB);
    const tgRow = channels.find((c) => c.channel === 'telegram')!;
    expect(tgRow.linked).toBe(false);
    expect(tgRow.identities).toEqual([]);
  });
});
