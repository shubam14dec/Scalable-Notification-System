/**
 * Phase 19 (channel approval cards) end to end — the production path with only
 * the outside worlds stubbed: an Anthropic-compatible model server, the Slack
 * Web API (SLACK_API_BASE), the Telegram Bot API (TELEGRAM_API_BASE), and the
 * customer's tool endpoint. Everything between them — the settings route, the
 * managed brain's card poster, the signed slack interactivity / telegram
 * callback tap branches, and the tool-decision finalizer — is the exact code
 * production runs.
 *
 * Covers the four merged slices A/B/C:
 *   1. GET/PUT /v1/settings/approvals (merge, explicit-null cascade, validation
 *      matrix, telegramApproverCount).
 *   2. The poster: a gated tool call posts a Slack card + one Telegram card per
 *      approver, records both ref shapes on the call row; unset settings post
 *      nothing; a Slack not_in_channel leaves the pause intact and still posts
 *      the Telegram card.
 *   3. Taps: signed Slack interactivity / Telegram callback decide a pending
 *      call, enqueue the frozen tool-decision job, optimistically edit the card;
 *      a pre-decided call edits "already …" with NO job; a non-approval action
 *      still flows through the old ingest pipeline.
 *   4. The finalizer: processToolDecision executes an approved call and rewrites
 *      every card to its outcome text; a denied call rewrites without executing.
 *   5. Full loop: pending → Slack tap → tool-decision job → one endpoint POST →
 *      cards finalized → follow-up turn enqueued.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createHmac } from 'node:crypto';
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, getQueue, QUEUE } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { sealSecret } from '../../src/auth/secret-box';
import { verifyWebhook } from '../../src/api/webhook-signature';
import { putTenantSetting } from '../../src/db/tenant-settings.repo';
import { upsertChannelIdentity } from '../../src/db/identities.repo';
import type { ApprovalCardRef } from '../../src/db/agent-tools.repo';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';

const AGENT = 'ca-agent';
const REQUIRED_TOOL = 'gated_ship';
const SLACK_CHANNEL = 'C0APPROVE';
const APPROVER_CHAT_ID = '900900900';
const SLACK_BOT = 'xoxb-approvals-0123456789ABCDEFGH';
const SLACK_SIGNING = 'itest-approvals-signing-secret-abc';
const TG_BOT = '7100001:AAapprovals-token_0123456789ABCDEF';
const TG_SECRET = 'f'.repeat(48);

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let agentId = '';
let toolDefId = '';
let slackConnId = '';
let tgConnId = '';

const json = (res: { body: string }) => JSON.parse(res.body);
const headers = () => ({ 'x-api-key': apiKey });

// ---- stub Anthropic-compatible model server ----
let llmStub: Server;
let llmBaseUrl = '';
let llmQueue: unknown[] = [];
const envelope = (content: unknown[], stopReason: string) => ({
  id: 'msg_stub',
  type: 'message',
  role: 'assistant',
  model: 'glm-4-test',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const llmToolUse = (uses: Array<{ id: string; name: string; input: unknown }>) =>
  envelope(uses.map((u) => ({ type: 'tool_use', ...u })), 'tool_use');
const llmText = (text: string) => envelope([{ type: 'text', text }], 'end_turn');
function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(llmQueue.length > 0 ? llmQueue.shift() : llmText('default reply')));
    });
  });
  return new Promise((r) => llmStub.listen(0, () => r()));
}

// ---- stub Slack Web API ----
interface SlackCall {
  method: string;
  body: Record<string, unknown>;
  token: string;
}
let slackStub: Server;
const slackCalls: SlackCall[] = [];
let slackTs = 0;
/** When set, the next chat.postMessage is rejected once as not_in_channel. */
let notInChannelOnce = false;
function startSlackStub(): Promise<void> {
  slackStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const stubUrl = new URL(String(req.url), 'http://stub');
      const method = stubUrl.pathname.split('/').pop() ?? '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      const token = String(req.headers.authorization ?? '').replace(/^Bearer\s+/, '');
      slackCalls.push({ method, body, token });
      res.setHeader('content-type', 'application/json; charset=utf-8');
      if (method === 'chat.postMessage') {
        if (notInChannelOnce) {
          notInChannelOnce = false;
          return res.end(JSON.stringify({ ok: false, error: 'not_in_channel' }));
        }
        return res.end(
          JSON.stringify({ ok: true, channel: body.channel, ts: `1730000000.${++slackTs}` }),
        );
      }
      if (method === 'chat.update') {
        return res.end(JSON.stringify({ ok: true, channel: body.channel, ts: body.ts }));
      }
      if (method === 'users.info') {
        return res.end(
          JSON.stringify({
            ok: true,
            user: { id: stubUrl.searchParams.get('user') ?? body.user, profile: {} },
          }),
        );
      }
      res.statusCode = 404;
      res.end(JSON.stringify({ ok: false, error: 'unknown_method' }));
    });
  });
  return new Promise((r) => slackStub.listen(0, () => r()));
}
const slackPosts = (channel: string) =>
  slackCalls.filter((c) => c.method === 'chat.postMessage' && c.body.channel === channel);
const slackUpdates = (channel: string) =>
  slackCalls.filter((c) => c.method === 'chat.update' && c.body.channel === channel);

// ---- stub Telegram Bot API ----
let tgStub: Server;
const tgCalls: Array<{ method: string; body: Record<string, unknown> }> = [];
let tgMessageId = 8000;
function startTgStub(): Promise<void> {
  tgStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const method = String(req.url).split('/').pop() ?? '';
      const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
      tgCalls.push({ method, body });
      const results: Record<string, unknown> = {
        sendMessage: { message_id: ++tgMessageId },
        editMessageText: true,
        answerCallbackQuery: true,
      };
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ ok: method in results, result: results[method] }));
    });
  });
  return new Promise((r) => tgStub.listen(0, () => r()));
}
const tgSends = (chatId: string) =>
  tgCalls.filter((c) => c.method === 'sendMessage' && String(c.body.chat_id) === chatId);
const tgEdits = (messageId: number) =>
  tgCalls.filter((c) => c.method === 'editMessageText' && c.body.message_id === messageId);

// ---- stub customer tool endpoint (verifies our HMAC) ----
let toolStub: Server;
let toolUrl = '';
const toolSecrets: string[] = [];
interface ToolHit {
  idem?: string;
  sigValid: boolean;
  body: Record<string, unknown>;
}
const toolSeen: ToolHit[] = [];
const OK_BODY = JSON.stringify({ status: 'shipped', ref: 'ref_1' });
function startToolStub(): Promise<void> {
  toolStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const timestamp = req.headers['x-asyncify-timestamp'] as string | undefined;
      const signature = req.headers['x-asyncify-signature'] as string | undefined;
      const idem = req.headers['x-asyncify-idempotency-key'] as string | undefined;
      const sigValid = toolSecrets.some((s) => verifyWebhook(s, timestamp, signature, raw).ok);
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(raw);
      } catch {
        /* leave empty */
      }
      toolSeen.push({ idem, sigValid, body });
      res.statusCode = 200;
      res.setHeader('content-type', 'application/json');
      res.end(OK_BODY);
    });
  });
  return new Promise((r) => toolStub.listen(0, () => r()));
}

// ---- signed injectors ----
function slackSignedHeaders(rawBody: string, ts = Math.floor(Date.now() / 1000)) {
  const sig = 'v0=' + createHmac('sha256', SLACK_SIGNING).update(`v0:${ts}:${rawBody}`).digest('hex');
  return { 'x-slack-request-timestamp': String(ts), 'x-slack-signature': sig };
}
async function postSlackInteractivity(payload: unknown) {
  const form = 'payload=' + encodeURIComponent(JSON.stringify(payload));
  return app.inject({
    method: 'POST',
    url: `/webhooks/slack/${slackConnId}/interactivity`,
    headers: { ...slackSignedHeaders(form), 'content-type': 'application/x-www-form-urlencoded' },
    payload: form,
  });
}
async function postTgCallback(update: unknown) {
  return app.inject({
    method: 'POST',
    url: `/webhooks/telegram/${tgConnId}`,
    headers: { 'x-telegram-bot-api-secret-token': TG_SECRET },
    payload: update as Record<string, unknown>,
  });
}

// ---- helpers ----
async function send(subscriberId: string, text: string, messageId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${AGENT}/messages`,
    headers: headers(),
    payload: { subscriberId, text, messageId },
  });
  return json(res).conversationId as string;
}
async function runTurn(conversationId: string): Promise<void> {
  const { rows } = await pool.query(
    `select id from conversation_messages where conversation_id = $1 and role = 'user'
      order by created_at desc limit 1`,
    [conversationId],
  );
  await processConversation({
    data: { tenantId, conversationId, messageId: rows[0].id },
  } as Job<ConversationJobData>);
}
async function latestCall(conversationId: string): Promise<{
  id: string;
  status: string;
  decided_by: string | null;
  cards: ApprovalCardRef[];
}> {
  const { rows } = await pool.query(
    `select id, status, decided_by, cards from agent_tool_calls
      where conversation_id = $1 order by requested_at desc limit 1`,
    [conversationId],
  );
  return rows[0];
}
async function callById(id: string) {
  const { rows } = await pool.query('select status, decided_by, cards from agent_tool_calls where id = $1', [id]);
  return rows[0] as { status: string; decided_by: string | null; cards: ApprovalCardRef[] };
}
async function latestAgentContent(conversationId: string): Promise<string | undefined> {
  const { rows } = await pool.query(
    `select content from conversation_messages where conversation_id = $1 and role = 'agent'
      order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0]?.content;
}
let dedupeSeq = 0;
async function insertCall(o: {
  conversationId: string;
  status: string;
  decidedBy?: string;
  note?: string;
  cards?: ApprovalCardRef[];
  args?: Record<string, unknown>;
}): Promise<string> {
  dedupeSeq += 1;
  const { rows } = await pool.query(
    `insert into agent_tool_calls
       (tenant_id, agent_id, conversation_id, tool_def_id, tool_name, args, dedupe_key,
        status, decided_by, note, cards, expires_at, decided_at)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now() + interval '24 hours',
             case when $8 = 'pending' then null else now() end)
     returning id`,
    [
      tenantId,
      agentId,
      o.conversationId,
      toolDefId,
      REQUIRED_TOOL,
      JSON.stringify(o.args ?? { orderId: '#fab' }),
      `tc-fab-${Date.now()}-${dedupeSeq}`,
      o.status,
      o.decidedBy ?? null,
      o.note ?? null,
      JSON.stringify(o.cards ?? []),
    ],
  );
  return rows[0].id as string;
}
async function insertConnection(
  channel: 'slack' | 'telegram',
  credentials: Record<string, string>,
  config: Record<string, unknown>,
): Promise<string> {
  const { rows } = await pool.query(
    `insert into agent_connections (tenant_id, agent_id, channel, credentials, config, status)
     values ($1,$2,$3,$4,$5,'active') returning id`,
    [tenantId, agentId, channel, sealSecret(JSON.stringify(credentials)), JSON.stringify(config)],
  );
  return rows[0].id as string;
}

beforeAll(async () => {
  await Promise.all([startLlmStub(), startSlackStub(), startTgStub(), startToolStub()]);
  llmBaseUrl = `http://localhost:${(llmStub.address() as AddressInfo).port}`;
  process.env.SLACK_API_BASE = `http://localhost:${(slackStub.address() as AddressInfo).port}`;
  process.env.TELEGRAM_API_BASE = `http://localhost:${(tgStub.address() as AddressInfo).port}`;
  toolUrl = `http://localhost:${(toolStub.address() as AddressInfo).port}/tool`;

  app = await buildApp();
  const email = `channel-appr-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'CA IT', email, password: 'integration-pw-1', organizationName: 'CA Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  // The reserved ops-notification workflow (approval alerts route to it).
  await app.inject({
    method: 'PUT',
    url: '/v1/workflows',
    headers: headers(),
    payload: {
      key: 'agent-approvals',
      name: 'Approvals',
      steps: [{ channel: 'inapp', subject: 'Approval needed', body: 'Tool {{toolName}}' }],
    },
  });

  const create = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: headers(),
    payload: {
      identifier: AGENT,
      name: 'Channel Approvals Agent',
      runtime: 'managed',
      model: 'glm-4-test',
      llm: { apiKey: 'managed-test-key', baseUrl: llmBaseUrl },
    },
  });
  expect(create.statusCode).toBe(201);
  agentId = (
    await pool.query('select id from agents where tenant_id = $1 and identifier = $2', [tenantId, AGENT])
  ).rows[0].id;

  const tool = await app.inject({
    method: 'POST',
    url: `/v1/agents/${AGENT}/tools`,
    headers: headers(),
    payload: {
      name: REQUIRED_TOOL,
      description: 'Ship an order (gated)',
      parameters: { type: 'object', properties: { orderId: { type: 'string' } } },
      endpointUrl: toolUrl,
      approval: 'required',
    },
  });
  expect(tool.statusCode).toBe(201);
  toolDefId = json(tool).tool.id;
  toolSecrets.push(json(tool).secret);

  // Active Slack + Telegram connections the settings + poster + taps read.
  slackConnId = await insertConnection(
    'slack',
    { botToken: SLACK_BOT, signingSecret: SLACK_SIGNING },
    { teamId: 'TAPPROVE', botUserId: 'UBOTAPV' },
  );
  tgConnId = await insertConnection(
    'telegram',
    { botToken: TG_BOT, webhookSecret: TG_SECRET },
    { botId: 7100001, botUsername: 'itest_apv_bot' },
  );
});

afterAll(async () => {
  try {
    await pool.query('delete from agent_tool_calls where tenant_id = $1', [tenantId]);
    await pool.query('delete from agent_tool_defs where tenant_id = $1', [tenantId]);
    await pool.query('delete from tenant_settings where tenant_id = $1', [tenantId]);
    await pool.query('delete from channel_identities where tenant_id = $1', [tenantId]);
    await pool.query('delete from agent_connections where tenant_id = $1', [tenantId]);
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await pool.query('delete from events where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
    await getQueue(QUEUE.CONVERSATION).obliterate({ force: true });
    const keys = await redis.keys(`txn:${tenantId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    /* best-effort cleanup */
  }
  delete process.env.SLACK_API_BASE;
  delete process.env.TELEGRAM_API_BASE;
  slackStub?.close();
  tgStub?.close();
  llmStub?.close();
  toolStub?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

// ---------------------------------------------------------------------------

describe('1. settings API', () => {
  const get = () =>
    app.inject({ method: 'GET', url: '/v1/settings/approvals', headers: headers() });
  const put = (body: Record<string, unknown>) =>
    app.inject({ method: 'PUT', url: '/v1/settings/approvals', headers: headers(), payload: body });

  test('defaults to all-null with a zero telegram approver count', async () => {
    const res = await get();
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.settings).toEqual({
      slackConnectionId: null,
      slackChannelId: null,
      telegramConnectionId: null,
    });
    expect(body.telegramApproverCount).toBe(0);
  });

  test('validation: unknown uuid → 400 not-an-active-slack-connection', async () => {
    const res = await put({ slackConnectionId: '00000000-0000-4000-8000-000000000000' });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('slackConnectionId: not an active slack connection');
  });

  test('validation: a telegram connection id under slackConnectionId → 400 (wrong channel)', async () => {
    const res = await put({ slackConnectionId: tgConnId });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('slackConnectionId: not an active slack connection');
  });

  test('validation: a channel id with no slack connection → 400 requires-a-slack-connection', async () => {
    const res = await put({ slackChannelId: SLACK_CHANNEL });
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toBe('slackChannelId: requires an active slack connection');
  });

  test('a valid full set is merged and echoed back', async () => {
    const res = await put({
      slackConnectionId: slackConnId,
      slackChannelId: SLACK_CHANNEL,
      telegramConnectionId: tgConnId,
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).settings).toEqual({
      slackConnectionId: slackConnId,
      slackChannelId: SLACK_CHANNEL,
      telegramConnectionId: tgConnId,
    });
  });

  test('GET reflects the stored set, and the count reflects a linked telegram identity', async () => {
    // Wire the reserved 'approvals' ops subscriber + one telegram approver.
    const sub = await pool.query(
      "insert into subscribers (tenant_id, external_id) values ($1, 'approvals') returning id",
      [tenantId],
    );
    await upsertChannelIdentity({
      tenantId,
      channel: 'telegram',
      externalKey: APPROVER_CHAT_ID,
      subscriberId: sub.rows[0].id,
    });

    const res = await get();
    const body = json(res);
    expect(body.settings).toEqual({
      slackConnectionId: slackConnId,
      slackChannelId: SLACK_CHANNEL,
      telegramConnectionId: tgConnId,
    });
    expect(body.telegramApproverCount).toBe(1);
  });

  test('explicit-null on the slack connection cascades to the channel id', async () => {
    const res = await put({ slackConnectionId: null });
    expect(res.statusCode).toBe(200);
    // slackChannelId is nulled alongside; telegram is untouched (merge keeps it).
    expect(json(res).settings).toEqual({
      slackConnectionId: null,
      slackChannelId: null,
      telegramConnectionId: tgConnId,
    });
    const after = json(await get()).settings;
    expect(after.slackConnectionId).toBeNull();
    expect(after.slackChannelId).toBeNull();
    expect(after.telegramConnectionId).toBe(tgConnId);
  });
});

// ---------------------------------------------------------------------------

describe('2. card poster (managed brain)', () => {
  const setSettings = (v: Record<string, unknown> | null) =>
    v
      ? putTenantSetting(tenantId, 'approvals', v)
      : pool.query("delete from tenant_settings where tenant_id = $1 and key = 'approvals'", [tenantId]);

  test('a gated tool call posts a Slack card + one Telegram card per approver, saving both ref shapes', async () => {
    await setSettings({
      slackConnectionId: slackConnId,
      slackChannelId: SLACK_CHANNEL,
      telegramConnectionId: tgConnId,
    });
    slackCalls.length = 0;
    tgCalls.length = 0;
    toolSeen.length = 0;

    llmQueue = [llmToolUse([{ id: 'p1', name: REQUIRED_TOOL, input: { orderId: '#p1' } }])];
    const conv = await send('poster-user-1', 'ship it', 'poster-1');
    await runTurn(conv);

    const call = await latestCall(conv);
    expect(call.status).toBe('pending');
    expect(toolSeen).toHaveLength(0); // gated — the endpoint was never dialed

    // --- Slack card: text contract + Approve/Deny action ids ---
    const posts = slackPosts(SLACK_CHANNEL);
    expect(posts).toHaveLength(1);
    const text = String(posts[0].body.text);
    expect(text).toBe(
      `Approval needed\n${AGENT} wants to run ${REQUIRED_TOOL}\n` +
        `Customer: poster-user-1\n` +
        `{"orderId":"#p1"}\nAlso in the dashboard → Approvals.`,
    );
    const blocks = posts[0].body.blocks as Array<{ type: string; elements?: Array<{ action_id: string }> }>;
    const actions = blocks.find((b) => b.type === 'actions')!;
    expect(actions.elements!.map((e) => e.action_id)).toEqual([
      `approval:approve:${call.id}`,
      `approval:deny:${call.id}`,
    ]);

    // --- Telegram card: one sendMessage per approver, apv:a/apv:d callbacks ---
    const sends = tgSends(APPROVER_CHAT_ID);
    expect(sends).toHaveLength(1);
    expect(String(sends[0].body.text)).toContain('Approval needed');
    const kb = (sends[0].body.reply_markup as { inline_keyboard: Array<Array<{ callback_data: string }>> })
      .inline_keyboard;
    expect(kb.map((row) => row[0].callback_data)).toEqual([`apv:a:${call.id}`, `apv:d:${call.id}`]);

    // --- both ref shapes recorded on the call row ---
    const slackRef = call.cards.find((c) => c.channel === 'slack');
    expect(slackRef).toMatchObject({ channel: 'slack', connectionId: slackConnId, channelId: SLACK_CHANNEL });
    expect(typeof (slackRef as { ts: string }).ts).toBe('string');
    const tgRef = call.cards.find((c) => c.channel === 'telegram');
    expect(tgRef).toMatchObject({ channel: 'telegram', connectionId: tgConnId, chatId: APPROVER_CHAT_ID });
    expect(typeof (tgRef as { messageId: number }).messageId).toBe('number');
  });

  test('with settings unset: no cards post and the pause stays intact', async () => {
    await setSettings(null);
    slackCalls.length = 0;
    tgCalls.length = 0;

    llmQueue = [llmToolUse([{ id: 'p2', name: REQUIRED_TOOL, input: { orderId: '#p2' } }])];
    const conv = await send('poster-user-2', 'ship it', 'poster-2');
    await runTurn(conv);

    expect(slackCalls).toHaveLength(0);
    expect(tgCalls).toHaveLength(0);
    const call = await latestCall(conv);
    expect(call.status).toBe('pending');
    expect(call.cards).toEqual([]);
    expect(await latestAgentContent(conv)).toBe(
      `I've asked a teammate to approve ${REQUIRED_TOOL} — I'll follow up here as soon as it's decided.`,
    );
  });

  test('a Slack not_in_channel leaves the pause intact and still posts the Telegram card (telegram ref only)', async () => {
    await setSettings({
      slackConnectionId: slackConnId,
      slackChannelId: SLACK_CHANNEL,
      telegramConnectionId: tgConnId,
    });
    slackCalls.length = 0;
    tgCalls.length = 0;
    notInChannelOnce = true;

    llmQueue = [llmToolUse([{ id: 'p3', name: REQUIRED_TOOL, input: { orderId: '#p3' } }])];
    const conv = await send('poster-user-3', 'ship it', 'poster-3');
    await runTurn(conv);

    // Slack was attempted (and rejected); Telegram still landed.
    expect(slackPosts(SLACK_CHANNEL)).toHaveLength(1);
    expect(tgSends(APPROVER_CHAT_ID)).toHaveLength(1);

    const call = await latestCall(conv);
    expect(call.status).toBe('pending'); // pause survives the channel hiccup
    // Only the telegram ref persisted — the failed slack post recorded nothing.
    expect(call.cards).toHaveLength(1);
    expect(call.cards[0]).toMatchObject({ channel: 'telegram', connectionId: tgConnId, chatId: APPROVER_CHAT_ID });
  });
});

// ---------------------------------------------------------------------------

describe('3. approval taps', () => {
  test('a signed Slack approve tap decides the call, enqueues the frozen job, edits the card to processing', async () => {
    const conv = await send('tap-slack-1', 'hi', 'tap-slack-1');
    const callId = await insertCall({ conversationId: conv, status: 'pending' });
    slackCalls.length = 0;

    const res = await postSlackInteractivity({
      type: 'block_actions',
      user: { id: 'U0APV1' },
      channel: { id: SLACK_CHANNEL },
      message: { ts: '1730000000.5' },
      actions: [{ action_id: `approval:approve:${callId}`, action_ts: '1730000000.999' }],
    });
    expect(res.statusCode).toBe(200);
    expect(json(res).ok).toBe(true);

    const call = await callById(callId);
    expect(call.status).toBe('approved');
    expect(call.decided_by).toBe('slack:U0APV1');

    const jobPromise = getQueue(QUEUE.CONVERSATION).getJob(`tool-decision-${callId}`);
    const job = (await jobPromise) as Job;
    expect(job).toBeTruthy();
    expect(job.data).toEqual({
      kind: 'tool-decision',
      tenantId,
      conversationId: conv,
      toolCallId: callId,
    });
    expect(job.opts.attempts).toBe(5);

    const upd = slackUpdates(SLACK_CHANNEL);
    expect(upd).toHaveLength(1);
    expect(String(upd[0].body.text)).toContain('processing');
    expect(String(upd[0].body.text)).toContain('slack:U0APV1');
  });

  test('a tap on an already-decided call edits "already …" and enqueues NO job', async () => {
    const conv = await send('tap-slack-2', 'hi', 'tap-slack-2');
    // Pre-decided directly (never enqueued) so no tool-decision job can pre-exist.
    const callId = await insertCall({ conversationId: conv, status: 'approved', decidedBy: 'slack:UEARLY' });
    slackCalls.length = 0;

    const res = await postSlackInteractivity({
      type: 'block_actions',
      user: { id: 'U0APV2' },
      channel: { id: SLACK_CHANNEL },
      message: { ts: '1730000000.6' },
      actions: [{ action_id: `approval:approve:${callId}`, action_ts: '1730000000.998' }],
    });
    expect(json(res).ok).toBe(true);

    // The row is untouched by the losing tap.
    expect((await callById(callId)).decided_by).toBe('slack:UEARLY');
    const upd = slackUpdates(SLACK_CHANNEL);
    expect(String(upd.at(-1)!.body.text)).toBe('already approved by slack:UEARLY');
    // No decision job was created for this call.
    expect(await getQueue(QUEUE.CONVERSATION).getJob(`tool-decision-${callId}`)).toBeFalsy();
  });

  test('a Telegram approve callback decides the call; a loser mirror shows "already …"', async () => {
    const conv = await send('tap-tg-1', 'hi', 'tap-tg-1');
    const callId = await insertCall({ conversationId: conv, status: 'pending' });
    tgCalls.length = 0;

    const winner = await postTgCallback({
      update_id: 91001,
      callback_query: {
        id: 'cbq-apv-1',
        from: { id: 555111, is_bot: false, first_name: 'Ops' },
        message: { message_id: 4242, chat: { id: 555111, type: 'private' } },
        data: `apv:a:${callId}`,
      },
    });
    expect(json(winner).ok).toBe(true);

    const call = await callById(callId);
    expect(call.status).toBe('approved');
    expect(call.decided_by).toBe('telegram:555111');
    expect(await getQueue(QUEUE.CONVERSATION).getJob(`tool-decision-${callId}`)).toBeTruthy();
    const winEdit = tgEdits(4242).at(-1)!;
    expect(String(winEdit.body.text)).toContain('processing');
    expect(String(winEdit.body.text)).toContain('telegram:555111');

    // Loser mirror: a second tap on the now-approved call edits "already …".
    const loser = await postTgCallback({
      update_id: 91002,
      callback_query: {
        id: 'cbq-apv-2',
        from: { id: 555222, is_bot: false },
        message: { message_id: 4243, chat: { id: 555222, type: 'private' } },
        data: `apv:a:${callId}`,
      },
    });
    expect(json(loser).ok).toBe(true);
    expect(String(tgEdits(4243).at(-1)!.body.text)).toBe('already approved by telegram:555111');
  });

  test('a non-approval Slack action still flows through the old ingest pipeline', async () => {
    const dm = 'D0REGRESS1';
    const res = await postSlackInteractivity({
      type: 'block_actions',
      user: { id: 'U0REG01' },
      channel: { id: dm },
      message: { ts: '1730000000.7', text: 'Choose:' },
      actions: [{ action_id: 'opt_regress', action_ts: '1730000000.777', text: { text: 'Option R' } }],
    });
    expect(json(res).ok).toBe(true);

    // A conversation was opened for the DM and the click ingested as a user row.
    const { rows } = await pool.query(
      `select cm.id from conversations c
         join conversation_messages cm on cm.conversation_id = c.id
        where c.connection_id = $1 and c.thread_key = $2
          and cm.role = 'user' and cm.raw->'action'->>'id' = 'opt_regress' limit 1`,
      [slackConnId, dm],
    );
    expect(rows).toHaveLength(1);
    // …and it was enqueued for the brain (not short-circuited like an approval tap).
    expect(await getQueue(QUEUE.CONVERSATION).getJob(`conv-${rows[0].id}`)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------

describe('4. finalizer (processToolDecision)', () => {
  test('an approved call executes once and rewrites both cards to the executed outcome', async () => {
    const conv = await send('fin-user-1', 'hi', 'fin-1');
    const cards: ApprovalCardRef[] = [
      { channel: 'slack', connectionId: slackConnId, channelId: 'C0FIN', ts: '1730000000.10' },
      { channel: 'telegram', connectionId: tgConnId, chatId: '555333', messageId: 7777 },
    ];
    const callId = await insertCall({
      conversationId: conv,
      status: 'approved',
      decidedBy: 'slack:UFIN (ops)',
      cards,
    });
    slackCalls.length = 0;
    tgCalls.length = 0;
    toolSeen.length = 0;

    await processConversation({
      data: { tenantId, conversationId: conv, toolCallId: callId, kind: 'tool-decision' },
    } as Job<ConversationJobData>);

    // The POST fired exactly once (signed, idempotency-keyed to the call id).
    expect(toolSeen).toHaveLength(1);
    expect(toolSeen[0].sigValid).toBe(true);
    expect(toolSeen[0].idem).toBe(callId);
    expect((await callById(callId)).status).toBe('executed');

    // Slack card rewritten to '✓ approved by … — executed' + the result snippet.
    const su = slackUpdates('C0FIN').at(-1)!;
    expect(String(su.body.text)).toBe(`✓ approved by slack:UFIN (ops) — executed\n${OK_BODY}`);
    // Telegram card rewritten to the same outcome text.
    const te = tgEdits(7777).at(-1)!;
    expect(String(te.body.text)).toBe(`✓ approved by slack:UFIN (ops) — executed\n${OK_BODY}`);
    expect(te.body.reply_markup).toBeUndefined(); // no keyboard on the finalized card
  });

  test('a denied call rewrites both cards to the denial text WITHOUT executing', async () => {
    const conv = await send('fin-user-2', 'hi', 'fin-2');
    const cards: ApprovalCardRef[] = [
      { channel: 'slack', connectionId: slackConnId, channelId: 'C0FIN2', ts: '1730000000.11' },
      { channel: 'telegram', connectionId: tgConnId, chatId: '555444', messageId: 7788 },
    ];
    const callId = await insertCall({
      conversationId: conv,
      status: 'denied',
      decidedBy: 'telegram:42',
      note: 'no budget',
      cards,
    });
    slackCalls.length = 0;
    tgCalls.length = 0;
    toolSeen.length = 0;

    await processConversation({
      data: { tenantId, conversationId: conv, toolCallId: callId, kind: 'tool-decision' },
    } as Job<ConversationJobData>);

    expect(toolSeen).toHaveLength(0); // a denial never dials the endpoint
    expect(String(slackUpdates('C0FIN2').at(-1)!.body.text)).toBe('✗ denied by telegram:42: no budget');
    expect(String(tgEdits(7788).at(-1)!.body.text)).toBe('✗ denied by telegram:42: no budget');
  });
});

// ---------------------------------------------------------------------------

describe('5. full loop', () => {
  test('pending → slack tap → decision job → one POST → cards finalized → follow-up turn enqueued', async () => {
    const conv = await send('loop-user', 'ship it', 'loop-1');
    const cards: ApprovalCardRef[] = [
      { channel: 'slack', connectionId: slackConnId, channelId: 'C0LOOP', ts: '1730000000.20' },
      { channel: 'telegram', connectionId: tgConnId, chatId: '555555', messageId: 9999 },
    ];
    const callId = await insertCall({ conversationId: conv, status: 'pending', cards });

    // --- the tap decides it and enqueues the tool-decision job ---
    slackCalls.length = 0;
    await postSlackInteractivity({
      type: 'block_actions',
      user: { id: 'U0LOOP' },
      channel: { id: SLACK_CHANNEL },
      message: { ts: '1730000000.30' },
      actions: [{ action_id: `approval:approve:${callId}`, action_ts: '1730000000.888' }],
    });
    expect((await callById(callId)).status).toBe('approved');

    // --- run the decision job: one POST, cards finalized ---
    slackCalls.length = 0;
    tgCalls.length = 0;
    toolSeen.length = 0;
    const job = (await getQueue(QUEUE.CONVERSATION).getJob(`tool-decision-${callId}`)) as Job;
    expect(job).toBeTruthy();
    await processConversation(job as Job<ConversationJobData>);

    expect(toolSeen).toHaveLength(1); // endpoint POSTed exactly once
    expect((await callById(callId)).status).toBe('executed');
    expect(String(slackUpdates('C0LOOP').at(-1)!.body.text)).toContain('✓ approved by slack:U0LOOP');
    expect(String(tgEdits(9999).at(-1)!.body.text)).toContain('executed');

    // --- the follow-up turn was threaded off the decision row ---
    const decision = await pool.query(
      `select id from conversation_messages where conversation_id = $1
         and content = $2`,
      [conv, `[approval decided: ${REQUIRED_TOOL} — executed]`],
    );
    expect(decision.rows).toHaveLength(1);
    const followUp = await getQueue(QUEUE.CONVERSATION).getJob(`conv-${decision.rows[0].id}`);
    expect(followUp).toBeTruthy();
    expect((followUp as Job).data.messageId).toBe(decision.rows[0].id);
  });
});
