/**
 * Slack quick-setup, install, OAuth callback, and manifest-refresh reconnect —
 * the production path end to end, with a stub standing in for the Slack Web API
 * (SLACK_API_BASE). The stub answers the four form-urlencoded methods this flow
 * adds (apps.manifest.create / apps.manifest.update / tooling.tokens.rotate /
 * oauth.v2.access), records every call in order, and can be toggled per test to
 * reproduce Slack's error shapes.
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
import { sealSecret, openSecret } from '../../src/auth/secret-box';
import { mintOauthState } from '../../src/auth/oauth-state';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let agentId = '';

const json = (res: { body: string }) => JSON.parse(res.body);
const headers = () => ({ 'x-api-key': apiKey });

// ---- stub Slack Web API (form-urlencoded methods) ----
interface SlackFormCall {
  method: string;
  params: Record<string, string>;
  contentType: string;
  bearer: string;
}
let slackStub: Server;
const slackCalls: SlackFormCall[] = [];
let createMode: 'ok' | 'invalid_auth' | 'invalid_manifest' = 'ok';
let rotateMode: 'ok' | 'fail' = 'ok';
let manifestUpdateMode: 'ok' | 'fail' = 'ok';
let rotateCounter = 0;
// The workspace the stubbed oauth.v2.access "installs" into — swappable so the
// duplicate-workspace collision test can steer the callback onto a taken teamId.
let oauthTeamId = 'T0INSTALL';

function startSlackStub(): Promise<void> {
  slackStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = new URL(String(req.url), 'http://stub').pathname.split('/').pop() ?? '';
      const params = Object.fromEntries(new URLSearchParams(raw)) as Record<string, string>;
      slackCalls.push({
        method,
        params,
        contentType: String(req.headers['content-type'] ?? ''),
        bearer: String(req.headers.authorization ?? '').replace(/^Bearer\s+/, ''),
      });
      res.setHeader('content-type', 'application/json; charset=utf-8');
      const send = (o: unknown) => res.end(JSON.stringify(o));

      if (method === 'apps.manifest.create') {
        if (createMode === 'invalid_auth') return send({ ok: false, error: 'invalid_auth' });
        if (createMode === 'invalid_manifest') {
          return send({
            ok: false,
            error: 'invalid_manifest',
            errors: [{ pointer: '/display_information/name', message: 'name is too long' }],
          });
        }
        return send({
          ok: true,
          app_id: 'A0QUICK01',
          credentials: {
            client_id: 'CID.123456',
            client_secret: 'client-secret-xyz',
            signing_secret: 'signing-secret-abcdef012345',
            verification_token: 'verif-tok',
          },
        });
      }
      if (method === 'apps.manifest.update') {
        if (manifestUpdateMode === 'fail') return send({ ok: false, error: 'internal_error' });
        return send({ ok: true, app_id: params.app_id });
      }
      if (method === 'tooling.tokens.rotate') {
        if (rotateMode === 'fail') return send({ ok: false, error: 'invalid_refresh_token' });
        const n = ++rotateCounter;
        return send({
          ok: true,
          token: `xoxe-access-${n}`,
          refresh_token: `xoxe-refresh-${n}`,
          exp: Math.floor(Date.now() / 1000) + 43_200,
        });
      }
      if (method === 'oauth.v2.access') {
        return send({
          ok: true,
          access_token: 'xoxb-installed-token-0123456789',
          team: { id: oauthTeamId, name: 'Installed Team' },
          bot_user_id: 'UBOTQS',
        });
      }
      res.statusCode = 404;
      send({ ok: false, error: 'unknown_method' });
    });
  });
  return new Promise((r) => slackStub.listen(0, () => r()));
}

async function connectionCount(): Promise<number> {
  const list = json(await app.inject({ method: 'GET', url: '/v1/connections', headers: headers() }));
  return list.connections.length;
}
async function connectionById(id: string) {
  const list = json(await app.inject({ method: 'GET', url: '/v1/connections', headers: headers() }));
  return list.connections.find((c: { id: string }) => c.id === id);
}
async function unsealCreds(connectionId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query('select credentials from agent_connections where id = $1', [
    connectionId,
  ]);
  return JSON.parse(openSecret(rows[0].credentials));
}
async function configOf(connectionId: string): Promise<Record<string, unknown>> {
  const { rows } = await pool.query('select config from agent_connections where id = $1', [
    connectionId,
  ]);
  return rows[0].config;
}

let quickConnId = '';
let legacyConnId = '';

beforeAll(async () => {
  await startSlackStub();
  process.env.SLACK_API_BASE = `http://localhost:${(slackStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `slackqs-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Slack QS IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Slack QS Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  // A bridge agent whose name/description/prompts the manifest builder reads.
  const created = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: headers(),
    payload: {
      identifier: 'qs-agent',
      name: 'QS Agent',
      description: 'Quick setup agent',
      bridgeUrl: 'http://localhost:9/',
      suggestedPrompts: [{ title: 'Help', message: 'I need help' }],
    },
  });
  expect(created.statusCode).toBe(201);
  agentId = (
    await pool.query('select id from agents where tenant_id = $1 and identifier = $2', [
      tenantId,
      'qs-agent',
    ])
  ).rows[0].id;
});

afterAll(async () => {
  delete process.env.SLACK_API_BASE;
  slackStub?.close();
  for (const sql of [
    `delete from agent_connections where tenant_id = $1`,
    `delete from agents where tenant_id = $1`,
  ]) {
    await pool.query(sql, [tenantId]).catch(() => {});
  }
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('quick-setup happy path', () => {
  test('creates a pending connection with sealed creds and returns the install URL', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/slack/quick-setup',
      headers: headers(),
      payload: {
        configToken: 'xoxe-config-token-abcdef',
        configRefreshToken: 'xoxe-refresh-0',
        agentIdentifier: 'qs-agent',
      },
    });
    expect(res.statusCode).toBe(201);
    const body = json(res);
    quickConnId = body.connectionId;
    expect(body.installUrl).toBe(`/v1/connections/${quickConnId}/slack/install`);
    expect(body.eventsUrl).toContain(`/webhooks/slack/${quickConnId}/events`);
    expect(body.interactivityUrl).toContain(`/webhooks/slack/${quickConnId}/interactivity`);

    // The create call was form-urlencoded, bearer=config token, manifest a JSON
    // string whose URLs are baked with this connection id.
    const createCall = slackCalls.find((c) => c.method === 'apps.manifest.create')!;
    expect(createCall.contentType).toContain('application/x-www-form-urlencoded');
    expect(createCall.bearer).toBe('xoxe-config-token-abcdef');
    const manifest = JSON.parse(createCall.params.manifest);
    expect(manifest.settings.event_subscriptions.request_url).toContain(
      `/webhooks/slack/${quickConnId}/events`,
    );

    // The row is persisted pending with the app id in config; creds are sealed.
    const row = await connectionById(quickConnId);
    expect(row.channel).toBe('slack');
    expect(row.status).toBe('pending');
    expect(row.config.appId).toBe('A0QUICK01');
    expect(row.config.manifestAutoUpdate).toBe('on');
    const creds = await unsealCreds(quickConnId);
    expect(creds.clientId).toBe('CID.123456');
    expect(creds.appId).toBe('A0QUICK01');
    expect(creds.configRefreshToken).toBe('xoxe-refresh-0');
  });
});

describe('quick-setup config-token error mapping', () => {
  test('invalid_auth → friendly 12-hours 400, stub row removed', async () => {
    const before = await connectionCount();
    createMode = 'invalid_auth';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/slack/quick-setup',
      headers: headers(),
      payload: { configToken: 'xoxe-stale-token', agentIdentifier: 'qs-agent' },
    });
    createMode = 'ok';
    expect(res.statusCode).toBe(400);
    expect(String(json(res).error)).toContain('12 hours');
    expect(await connectionCount()).toBe(before); // stub row deleted on failure
  });

  test('invalid_manifest → 400 with the validation detail surfaced, stub row removed', async () => {
    const before = await connectionCount();
    createMode = 'invalid_manifest';
    const res = await app.inject({
      method: 'POST',
      url: '/v1/connections/slack/quick-setup',
      headers: headers(),
      payload: { configToken: 'xoxe-config-token-abcdef', agentIdentifier: 'qs-agent' },
    });
    createMode = 'ok';
    expect(res.statusCode).toBe(400);
    expect(json(res).code).toBe('invalid_manifest');
    expect(String(json(res).detail)).toContain('name is too long');
    expect(await connectionCount()).toBe(before);
  });
});

describe('install redirect', () => {
  test('redirects to Slack authorize with client_id + state (302)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/connections/${quickConnId}/slack/install`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(302);
    const loc = String(res.headers.location);
    expect(loc).toContain('oauth/v2/authorize');
    expect(loc).toContain('client_id=CID.123456');
    expect(loc).toContain('state=');
    expect(loc).toContain('redirect_uri=');
  });

  test('Accept: application/json returns 200 {authorizeUrl} instead of the 302', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/v1/connections/${quickConnId}/slack/install`,
      headers: { ...headers(), accept: 'application/json' },
    });
    expect(res.statusCode).toBe(200);
    const url = String(json(res).authorizeUrl);
    expect(url).toContain('slack.com/oauth/v2/authorize');
    expect(url).toContain('client_id=CID.123456');
    // redirect_uri arrives URL-encoded, pointing at the public OAuth callback.
    expect(url).toContain('redirect_uri=');
    expect(url).toContain(encodeURIComponent('/webhooks/slack/oauth/callback'));
    expect(url).toContain('state=');
  });

  test('a legacy (pasted-token) slack connection is a 409', async () => {
    // A raw connection carrying botToken+signingSecret but no OAuth clientId.
    legacyConnId = (
      await pool.query(
        `insert into agent_connections (tenant_id, agent_id, channel, credentials, config, status)
         values ($1, $2, 'slack', $3, '{}'::jsonb, 'active') returning id`,
        [
          tenantId,
          agentId,
          sealSecret(
            JSON.stringify({ botToken: 'xoxb-legacy-0123456789ABCDEFGH', signingSecret: 'legacy-signing-secret' }),
          ),
        ],
      )
    ).rows[0].id;
    const res = await app.inject({
      method: 'GET',
      url: `/v1/connections/${legacyConnId}/slack/install`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(409);
  });
});

describe('oauth callback', () => {
  test('a bad state renders a 400 HTML page', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/webhooks/slack/oauth/callback?state=not-a-valid-state&code=abc123',
    });
    expect(res.statusCode).toBe(400);
    expect(String(res.headers['content-type'])).toContain('text/html');
  });

  test('a valid state + oauth exchange flips the connection active with the team name', async () => {
    const state = mintOauthState({ connectionId: quickConnId, tenantId });
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/slack/oauth/callback?code=the-oauth-code&state=${encodeURIComponent(state)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(String(res.headers['content-type'])).toContain('text/html');

    const row = await connectionById(quickConnId);
    expect(row.status).toBe('active');
    expect(row.config.teamName).toBe('Installed Team');
    // The exchanged bot token was sealed onto the row.
    expect((await unsealCreds(quickConnId)).botToken).toBe('xoxb-installed-token-0123456789');
  });

  test('a workspace already connected elsewhere → 409 HTML, pending row + creds intact', async () => {
    // An ACTIVE legacy slack connection already owning workspace T-DUP — the
    // partial unique index (tenant_id, teamId) where active is what collides.
    const takenId = (
      await pool.query(
        `insert into agent_connections (tenant_id, agent_id, channel, credentials, config, status)
         values ($1, $2, 'slack', $3, $4::jsonb, 'active') returning id`,
        [
          tenantId,
          agentId,
          sealSecret(
            JSON.stringify({ botToken: 'xoxb-taken-0123456789ABCDEFGH', signingSecret: 'taken-signing-secret' }),
          ),
          JSON.stringify({ teamId: 'T-DUP', teamName: 'Taken Team' }),
        ],
      )
    ).rows[0].id as string;

    // A fresh quick-setup pending connection, then an install landing on T-DUP.
    const setup = await app.inject({
      method: 'POST',
      url: '/v1/connections/slack/quick-setup',
      headers: headers(),
      payload: { configToken: 'xoxe-config-token-abcdef', agentIdentifier: 'qs-agent' },
    });
    expect(setup.statusCode).toBe(201);
    const dupConnId = json(setup).connectionId as string;

    oauthTeamId = 'T-DUP';
    const state = mintOauthState({ connectionId: dupConnId, tenantId });
    const res = await app.inject({
      method: 'GET',
      url: `/webhooks/slack/oauth/callback?code=dup-code&state=${encodeURIComponent(state)}`,
    });
    oauthTeamId = 'T0INSTALL';

    expect(res.statusCode).toBe(409);
    expect(String(res.headers['content-type'])).toContain('text/html');
    expect(res.body.toLowerCase()).toContain('already connected');

    // The pending row survived the collision, sealed OAuth creds intact — the
    // admin can retry the install into a free workspace on the same link.
    const row = await connectionById(dupConnId);
    expect(row.status).toBe('pending');
    expect((await unsealCreds(dupConnId)).clientId).toBe('CID.123456');

    // Cleanup: this test's extra rows must not trip the identity index later.
    await pool.query('delete from agent_connections where id = any($1)', [[takenId, dupConnId]]);
  });
});

describe('reconnect: rotate + manifest refresh', () => {
  test('rotates BEFORE updating the manifest and persists the NEW refresh token', async () => {
    const mark = slackCalls.length;
    const res = await app.inject({
      method: 'POST',
      url: `/v1/connections/${quickConnId}/reconnect`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).updated).toBe(true);

    // Order: the single-use rotate must precede the manifest update.
    const after = slackCalls.slice(mark);
    const rotateIdx = after.findIndex((c) => c.method === 'tooling.tokens.rotate');
    const updateIdx = after.findIndex((c) => c.method === 'apps.manifest.update');
    expect(rotateIdx).toBeGreaterThanOrEqual(0);
    expect(updateIdx).toBeGreaterThan(rotateIdx);

    // The manifest update carried the freshly rotated ACCESS token as bearer.
    expect(after[updateIdx].bearer).toBe(`xoxe-access-${rotateCounter}`);

    // The rotated (single-use) refresh token was persisted before the manifest call.
    const creds = await unsealCreds(quickConnId);
    expect(creds.configRefreshToken).toBe(`xoxe-refresh-${rotateCounter}`);
  });

  test('a broken refresh chain → 409 refresh-expired and manifestAutoUpdate flips to broken', async () => {
    rotateMode = 'fail';
    const res = await app.inject({
      method: 'POST',
      url: `/v1/connections/${quickConnId}/reconnect`,
      headers: headers(),
    });
    rotateMode = 'ok';
    expect(res.statusCode).toBe(409);
    expect(json(res).code).toBe('refresh-expired');
    expect((await configOf(quickConnId)).manifestAutoUpdate).toBe('broken');
  });

  test('a connection with no refresh chain → 400 code manual', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/connections/${legacyConnId}/reconnect`,
      headers: headers(),
    });
    expect(res.statusCode).toBe(400);
    expect(json(res).code).toBe('manual');
    expect(json(res).error).toBe('slack URLs must be pasted manually for this connection');
  });
});

describe('config-token chain repair (PUT .../slack/config-token)', () => {
  const putToken = (id: string, configRefreshToken: string) =>
    app.inject({
      method: 'PUT',
      url: `/v1/connections/${id}/slack/config-token`,
      headers: headers(),
      payload: { configRefreshToken },
    });
  /** The raw sealed credentials string — byte-compare proves "row unchanged". */
  const sealedCredsOf = async (id: string): Promise<string> =>
    (await pool.query('select credentials from agent_connections where id = $1', [id])).rows[0]
      .credentials as string;

  test('happy path: pasted token rotated, successor stored, flag broken → on', async () => {
    // Precondition from the reconnect describe: the chain flag is 'broken'.
    expect((await configOf(quickConnId)).manifestAutoUpdate).toBe('broken');

    const mark = slackCalls.length;
    const res = await putToken(quickConnId, 'xoxe-pasted-fresh-refresh');
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.updated).toBe(true);
    expect(body.eventsUrl).toContain(`/webhooks/slack/${quickConnId}/events`);
    expect(body.interactivityUrl).toContain(`/webhooks/slack/${quickConnId}/interactivity`);

    // The PASTED token (not the stored one) was spent on rotate, and the
    // manifest update rode the freshly minted access token, in that order.
    const after = slackCalls.slice(mark);
    const rotateIdx = after.findIndex((c) => c.method === 'tooling.tokens.rotate');
    const updateIdx = after.findIndex((c) => c.method === 'apps.manifest.update');
    expect(rotateIdx).toBeGreaterThanOrEqual(0);
    expect(after[rotateIdx].params.refresh_token).toBe('xoxe-pasted-fresh-refresh');
    expect(updateIdx).toBeGreaterThan(rotateIdx);
    expect(after[updateIdx].bearer).toBe(`xoxe-access-${rotateCounter}`);

    // The successor was persisted and the broken flag cleared to 'on'.
    expect((await unsealCreds(quickConnId)).configRefreshToken).toBe(`xoxe-refresh-${rotateCounter}`);
    expect((await configOf(quickConnId)).manifestAutoUpdate).toBe('on');
  });

  test('a spent/invalid pasted token → 422, row byte-unchanged', async () => {
    const credsBefore = await sealedCredsOf(quickConnId);
    const configBefore = await configOf(quickConnId);

    rotateMode = 'fail';
    const res = await putToken(quickConnId, 'xoxe-already-spent-token');
    rotateMode = 'ok';

    expect(res.statusCode).toBe(422);
    expect(String(json(res).error)).toContain('generate a fresh token pair');
    // Nothing persisted: sealed creds byte-identical, flag untouched.
    expect(await sealedCredsOf(quickConnId)).toBe(credsBefore);
    expect(await configOf(quickConnId)).toEqual(configBefore);
  });

  test('a legacy (pasted-token) slack connection → 409 not a quick-setup connection', async () => {
    const res = await putToken(legacyConnId, 'xoxe-whatever-token');
    expect(res.statusCode).toBe(409);
    expect(json(res).error).toBe('not a quick-setup connection');
  });

  test('manifest update fails → 502, but the chain advanced and the flag is still on', async () => {
    // Re-break the flag so the 502 path proving it flips to 'on' is meaningful.
    await pool.query(
      `update agent_connections
          set config = config || '{"manifestAutoUpdate":"broken"}'::jsonb
        where id = $1`,
      [quickConnId],
    );
    const refreshBefore = (await unsealCreds(quickConnId)).configRefreshToken;

    manifestUpdateMode = 'fail';
    const res = await putToken(quickConnId, 'xoxe-second-pasted-refresh');
    manifestUpdateMode = 'ok';

    expect(res.statusCode).toBe(502);
    // Deliberate semantics: the rotate succeeded, so the STORED successor is
    // healthy and the pasted token is spent — the chain advanced regardless.
    const refreshAfter = (await unsealCreds(quickConnId)).configRefreshToken;
    expect(refreshAfter).toBe(`xoxe-refresh-${rotateCounter}`);
    expect(refreshAfter).not.toBe(refreshBefore);
    expect((await configOf(quickConnId)).manifestAutoUpdate).toBe('on');
  });
});
