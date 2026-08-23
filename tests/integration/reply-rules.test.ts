/**
 * Phase A7 slice B — REPLY RULES, driven through the real path.
 *
 * Real app, real queue, real conversation worker, real @anthropic-ai/sdk pointed
 * (via the agent's llm_base_url) at a stub Messages API — only the model server
 * is fake, so what the customer RECEIVES is the proof of what the gate did.
 *
 * The properties under test are the gate's whole contract:
 *   1. a blocked reply ships the CONFIGURED fallback, verbatim and tagged;
 *   2. the transcript keeps what the model actually wrote, and why it went;
 *   3. buttons and cards drafted with a blocked reply do not ship either;
 *   4. ops is flagged through the P22 machinery — once per agent per hour;
 *   5. a clean reply is byte-identical to an ungated one, and writes nothing;
 *   6. BOTH reply paths are covered: the ordinary insert AND the plan card,
 *      which finalizes its own row and would otherwise bypass the check;
 *   7. candidate.moderation: object overrides, null disables, ABSENT = the
 *      agent's own rules apply (topics' semantics, not routing's);
 *   8. the TOPIC GATE'S REDIRECT IS EXEMPT — checking an operator's canned text
 *      against that same operator's rules is circular;
 *   9. a bridge agent has no gate: its reply is the customer's own code talking.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Worker, type Job } from 'bullmq';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, QUEUE } from '../../src/shared/queues';
import { createRedis, redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import {
  processConversation,
  type ConversationJobData,
} from '../../src/workers/processors/conversation.processor';
import { processEvalRun } from '../../src/workers/processors/eval-run.processor';
import { IN_LANE } from '../../src/core/topic-gate';

const MODEL = 'strong-model-1';
const FALLBACK = 'Let me get a teammate to follow up on this for you.';
/** The operator's rule, and the word the scripted brain keeps reaching for. */
const DENY = 'guarantee';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let agentId = '';
let convWorker: Worker;
const createdAgentIds: string[] = [];

// ---- stub Anthropic-compatible server ---------------------------------------
let llmStub: Server;
let llmBaseUrl = '';
interface SeenRequest {
  model: string;
  messages: Array<{ role: string; content: unknown }>;
  tool_choice?: { type: string; name: string };
}
const seen: SeenRequest[] = [];
/** Scripted BRAIN responses consumed FIFO; empty = the default echo reply. */
let script: unknown[] = [];
/** The label the stubbed topic classifier reports (only test 8 turns it on). */
let classifyLabel = IN_LANE;
/** When set, the stub holds the final text round until this promise resolves. */
let holdFinalText: Promise<void> | null = null;

const isClassify = (r: SeenRequest) => r.tool_choice?.name === 'classify_topic';

const envelope = (content: unknown[], stopReason: string) => ({
  id: 'msg_stub_1',
  type: 'message',
  role: 'assistant',
  model: 'scripted',
  content,
  stop_reason: stopReason,
  stop_sequence: null,
  usage: { input_tokens: 10, output_tokens: 5 },
});
const textReply = (text: string) => envelope([{ type: 'text', text }], 'end_turn');
const toolUse = (calls: Array<{ id: string; name: string; input: Record<string, unknown> }>) =>
  envelope(
    calls.map((c) => ({ type: 'tool_use', id: c.id, name: c.name, input: c.input })),
    'tool_use',
  );

function startLlmStub(): Promise<void> {
  llmStub = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as SeenRequest;
      seen.push(body);
      res.setHeader('content-type', 'application/json');
      if (isClassify(body)) {
        res.end(
          JSON.stringify(
            envelope(
              [{ type: 'tool_use', id: 'toolu_cls', name: 'classify_topic', input: { label: classifyLabel } }],
              'tool_use',
            ),
          ),
        );
        return;
      }
      const lastText = String(body.messages.at(-1)?.content ?? '').split('\n\n<platform_reminder>')[0];
      const payload = script.length > 0 ? script.shift() : textReply(`echo(${lastText})`);
      const respond = () => res.end(JSON.stringify(payload));
      // When armed, the FINAL text round is held open until the test releases
      // it — that pause is what lets a test observe the plan-card row while it
      // is still a progress card, i.e. prove the reply went out through
      // finalize rather than the ordinary insert.
      if (holdFinalText && (payload as { stop_reason?: string }).stop_reason === 'end_turn') {
        void holdFinalText.then(respond);
        return;
      }
      respond();
    });
  });
  return new Promise((r) => llmStub.listen(0, '127.0.0.1', () => r()));
}

// ---- a bridge agent's own server (never an LLM) -----------------------------
let bridgeStub: Server;
let bridgeUrl = '';
let bridgeHits = 0;
function startBridgeStub(): Promise<void> {
  bridgeStub = createServer((req, res) => {
    req.on('data', () => undefined);
    req.on('end', () => {
      bridgeHits += 1;
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ reply: `we ${DENY} the bridge answered` }));
    });
  });
  return new Promise((r) => bridgeStub.listen(0, '127.0.0.1', () => r()));
}

const json = (res: { body: string }) => JSON.parse(res.body);

/** See the note in topic-gate.test.ts: a real worker on a loaded machine. */
const TURN_TIMEOUT = { timeout: 45_000 };

async function waitFor(pred: () => Promise<boolean>, ms = 35_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('timed out waiting for the turn to finish');
}

/** Write the rules the way slice C's API will (null = no policy row). */
async function setModeration(moderation: Record<string, unknown> | null, identifier = 'rules-agent') {
  await pool.query('update agents set moderation = $2 where tenant_id = $1 and identifier = $3', [
    tenantId,
    moderation ? JSON.stringify(moderation) : null,
    identifier,
  ]);
}

async function setTopics(topics: Record<string, unknown> | null, identifier = 'rules-agent') {
  await pool.query('update agents set topics = $2 where tenant_id = $1 and identifier = $3', [
    tenantId,
    topics ? JSON.stringify(topics) : null,
    identifier,
  ]);
}

/**
 * A FINISHED reply row: a managed reply carries `usage`, a bridge reply carries
 * only `trace`, and a platform-authored reply (the fallback, the redirect)
 * carries `platformNote`.
 */
const FINISHED_REPLY_RAW = `(raw->'usage' is not null or raw->'trace' is not null
                             or raw->'platformNote' is not null)`;

async function finishedReply(
  conversationId: string,
): Promise<{ content: string; raw: Record<string, unknown> } | undefined> {
  const { rows } = await pool.query(
    `select content, raw from conversation_messages
      where conversation_id = $1 and role = 'agent' and ${FINISHED_REPLY_RAW}
      order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0];
}

/** The gate's breadcrumb for a conversation, if it wrote one. */
async function rulesBreadcrumb(
  conversationId: string,
): Promise<{ content: string; raw: Record<string, unknown> } | undefined> {
  const { rows } = await pool.query(
    `select content, raw from conversation_messages
      where conversation_id = $1 and role = 'system' and raw->'replyRules' is not null
      order by created_at desc limit 1`,
    [conversationId],
  );
  return rows[0];
}

async function send(identifier: string, subscriberId: string, text: string, messageId: string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/messages`,
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text, messageId },
  });
  return json(res) as { conversationId: string; messageId: string };
}

/** One turn end to end as a FRESH subscriber (its own conversation + reply). */
async function turn(subscriberId: string, text: string, identifier = 'rules-agent') {
  const sent = await send(identifier, subscriberId, text, `${subscriberId}-1`);
  await waitFor(async () => (await finishedReply(sent.conversationId)) !== undefined);
  return { ...sent, reply: (await finishedReply(sent.conversationId))! };
}

/** Create a managed agent via the API; returns its DB id. */
async function createManagedAgent(identifier: string, name: string): Promise<string> {
  await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: {
      identifier,
      name,
      runtime: 'managed',
      model: MODEL,
      systemPrompt: 'You are the Acme support agent. Be brief.',
      llm: { apiKey: 'zai-test-key-123456', baseUrl: llmBaseUrl },
    },
  });
  const { rows } = await pool.query('select id from agents where tenant_id = $1 and identifier = $2', [
    tenantId,
    identifier,
  ]);
  createdAgentIds.push(rows[0].id);
  return rows[0].id;
}

/** Start an eval run and drive it in-process, exactly as the A4/A6/A7a suites do. */
async function runEvals(payload: Record<string, unknown>) {
  const started = await app.inject({
    method: 'POST',
    url: '/v1/agents/rules-agent/evals/run',
    headers: { 'x-api-key': apiKey },
    payload,
  });
  expect(started.statusCode).toBe(202);
  const runId = json(started).runId as string;
  await processEvalRun({ data: { runId } } as Job<{ runId: string }>);
  const after = await app.inject({
    method: 'GET',
    url: `/v1/agents/rules-agent/evals/runs/${runId}`,
    headers: { 'x-api-key': apiKey },
  });
  return json(after).run as { status: string };
}

beforeAll(async () => {
  await startLlmStub();
  llmBaseUrl = `http://127.0.0.1:${(llmStub.address() as AddressInfo).port}`;
  await startBridgeStub();
  bridgeUrl = `http://127.0.0.1:${(bridgeStub.address() as AddressInfo).port}`;

  app = await buildApp();
  const email = `rules-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Reply Rules IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Reply Rules IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  agentId = await createManagedAgent('rules-agent', 'Rules Agent');

  await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: { identifier: 'rules-bridge', name: 'Rules Bridge', runtime: 'bridge', bridgeUrl },
  });

  // The scenario's expectation is 'echo' — i.e. THE MODEL'S OWN WORDS. A blocked
  // turn ships the fallback instead, so the gate is what the run experiences.
  await app.inject({
    method: 'POST',
    url: '/v1/agents/rules-agent/evals',
    headers: { 'x-api-key': apiKey },
    payload: {
      name: 'guarantee-check',
      scenario: {
        turns: [{ user: `do you ${DENY} this` }, { expect: { replyContains: 'echo' } }],
      },
    },
  });

  // The reserved ops-notification workflow + audience (the P22 opt-in pair).
  await app.inject({
    method: 'PUT',
    url: '/v1/workflows',
    headers: { 'x-api-key': apiKey },
    payload: {
      key: 'agent-approvals',
      name: 'Approvals',
      steps: [{ channel: 'inapp', subject: 'Ops', body: 'Agent {{agentIdentifier}} needs attention' }],
    },
  });
  await pool.query(
    "insert into subscribers (tenant_id, external_id, email) values ($1, 'approvals', 'ops@example.com')",
    [tenantId],
  );

  convWorker = new Worker(
    QUEUE.CONVERSATION,
    async (job: Job) => processConversation(job as Job<ConversationJobData>),
    { connection: createRedis(), concurrency: 1 },
  );
});

afterAll(async () => {
  await convWorker?.close();
  try {
    // Delete every counter key this file minted (shared redis, db 15) — without
    // this, the hourly debounce leaks into the next run inside the same hour.
    const patterns = createdAgentIds.flatMap((id) => [
      `replyblocks:${id}:*`,
      `replyrules-notified:${id}:*`,
      `agent:${id}:tokens:*`,
    ]);
    for (const p of patterns) {
      const keys = await redis.keys(p);
      if (keys.length > 0) await redis.del(...keys);
    }
    const txnKeys = await redis.keys(`txn:${tenantId}:*`);
    if (txnKeys.length > 0) await redis.del(...txnKeys);
  } catch {
    /* best-effort cleanup */
  }
  llmStub?.close();
  bridgeStub?.close();
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

beforeEach(async () => {
  script = [];
  classifyLabel = IN_LANE;
  holdFinalText = null;
  await setTopics(null);
  await setModeration({ denyPhrases: [DENY], fallback: FALLBACK });
});

// ---- 1-2. the block, the fallback, the receipt -------------------------------

describe('A7b: a blocked reply ships the operator’s fallback, not the model’s words', TURN_TIMEOUT, () => {
  test('the fallback ships VERBATIM and platform-tagged; the model’s text never does', async () => {
    script = [textReply(`Absolutely — we ${DENY} a full refund.`)];

    const { conversationId, reply } = await turn('block-1', 'will you refund me');

    expect(reply.content).toBe(FALLBACK);
    expect(reply.content).not.toContain(DENY);
    // Tagged like the topic redirect: platform-authored, never replayed to the
    // model as an assistant turn (the budget-note parroting lesson).
    expect(reply.raw.platformNote).toBe(true);
  });

  test('the transcript keeps WHAT was blocked and WHY — raw.replyRules, not raw.action', async () => {
    const drafted = `Absolutely — we ${DENY} a full refund.`;
    script = [textReply(drafted)];

    const { conversationId } = await turn('block-2', 'will you refund me');

    const crumb = await rulesBreadcrumb(conversationId);
    expect(crumb).toBeDefined();
    expect(crumb!.raw.replyRules).toEqual({
      rule: 'phrase',
      match: DENY,
      blockedText: drafted,
      blocked: true,
    });
    expect(crumb!.content).toContain('phrase');
    // NOT the tool-breadcrumb shape: an action row replays to the model as a
    // tool call, which would teach the agent a tool it does not have.
    expect(crumb!.raw.action).toBeUndefined();
  });

  test('a PII hit blocks too, and names the address it found', async () => {
    await setModeration({ blockPii: true, fallback: FALLBACK });
    script = [textReply('Sure — email my colleague at priya@acme.com.')];

    const { conversationId, reply } = await turn('block-pii', 'who else can help');

    expect(reply.content).toBe(FALLBACK);
    const crumb = await rulesBreadcrumb(conversationId);
    expect(crumb!.raw.replyRules).toMatchObject({ rule: 'pii', match: 'priya@acme.com' });
  });
});

// ---- 3. buttons and cards ride the blocked reply down -----------------------

describe('A7b: a blocked reply takes its buttons and card with it', TURN_TIMEOUT, () => {
  test('buttons drafted in the same breath as a blocked reply do not ship', async () => {
    // The buttons are answers to the sentence that was just replaced. "Yes,
    // refund it" under a fallback that no longer offers a refund is worse than
    // no buttons at all — the fallback ships BARE.
    script = [toolUse([{ id: 'toolu_pb', name: 'present_buttons', input: { buttons: [{ id: 'yes', label: 'Yes, refund it' }] } }]),
      textReply(`We ${DENY} it. Shall I proceed?`),
    ];

    const { reply } = await turn('block-buttons', 'refund me please');

    expect(reply.content).toBe(FALLBACK);
    expect(reply.raw.buttons).toBeUndefined();
    expect(reply.raw.card).toBeUndefined();
  });

  test('a card goes the same way', async () => {
    script = [
      toolUse([
        {
          id: 'toolu_pc',
          name: 'present_choices',
          input: {
            id: 'pick',
            prompt: 'Which one?',
            options: [
              { id: 'a', label: 'Refund' },
              { id: 'b', label: 'Replace' },
            ],
          },
        },
      ]),
      textReply(`We ${DENY} whichever you pick.`),
    ];

    const { reply } = await turn('block-card', 'refund or replace');

    expect(reply.content).toBe(FALLBACK);
    expect(reply.raw.card).toBeUndefined();
    expect(reply.raw.buttons).toBeUndefined();
  });

  test('a CLEAN reply keeps its buttons — suppression is the block, not the gate', async () => {
    script = [
      toolUse([{ id: 'toolu_ok', name: 'present_buttons', input: { buttons: [{ id: 'yes', label: 'Yes' }] } }]),
      textReply('Shall I look into that for you?'),
    ];

    const { reply } = await turn('clean-buttons', 'can you check');

    expect(reply.content).toBe('Shall I look into that for you?');
    expect(reply.raw.buttons).toEqual([{ id: 'yes', label: 'Yes' }]);
  });
});

// ---- 6. THE OTHER REPLY PATH: the plan card ---------------------------------

describe('A7b: the plan-card path is gated too', TURN_TIMEOUT, () => {
  // A posted plan card finalizes into its OWN row and never reaches the insert
  // below it. A check placed on either fork alone would leave the other shipping
  // unchecked, which is why the gate sits at the one point where both still
  // converge — right after the brain returns. `set_metadata` is the cheapest
  // labelable built-in, so scripting it is what posts the card.
  const postCard = { id: 'toolu_meta', name: 'set_metadata', input: { key: 'topic', value: 'refund' } };

  test('a blocked reply finalizes the card to the FALLBACK, not the model’s words', async () => {
    const drafted = `We ${DENY} a full refund today.`;
    script = [toolUse([postCard]), textReply(drafted)];

    // Hold the final text round open. Both reply paths write the SAME dedupe
    // key, so the only honest proof that this turn took the plan-card fork is
    // to catch the row existing while the model has not yet produced a reply
    // at all — nothing but a posted plan card can do that.
    let release!: () => void;
    holdFinalText = new Promise<void>((r) => (release = r));
    const sent = await send('rules-agent', 'card-block', 'refund me', 'card-block-1');

    const cardRow = async () => {
      const { rows } = await pool.query(
        'select content from conversation_messages where conversation_id = $1 and dedupe_key = $2',
        [sent.conversationId, `reply-${sent.messageId}`],
      );
      return rows[0] as { content: string } | undefined;
    };
    await waitFor(async () => (await cardRow()) !== undefined);
    const progress = (await cardRow())!.content;
    expect(progress).not.toBe(FALLBACK);
    expect(progress).not.toContain(DENY);

    release();
    holdFinalText = null;
    await waitFor(async () => (await finishedReply(sent.conversationId)) !== undefined);

    // The SAME row, finalized to the fallback — not a second row.
    const reply = (await finishedReply(sent.conversationId))!;
    expect(reply.content).toBe(FALLBACK);
    expect(reply.raw.platformNote).toBe(true);
    const { rows } = await pool.query(
      'select content from conversation_messages where conversation_id = $1 and dedupe_key = $2',
      [sent.conversationId, `reply-${sent.messageId}`],
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].content).toBe(FALLBACK);
    // And the receipt is written on this path too.
    const crumb = await rulesBreadcrumb(sent.conversationId);
    expect(crumb!.raw.replyRules).toMatchObject({ rule: 'phrase', blockedText: drafted });
  });

  test('buttons drafted alongside a blocked plan-card reply do not ship either', async () => {
    script = [
      toolUse([postCard]),
      toolUse([{ id: 'toolu_pb2', name: 'present_buttons', input: { buttons: [{ id: 'y', label: 'Yes' }] } }]),
      textReply(`We ${DENY} it.`),
    ];

    const { reply } = await turn('card-buttons', 'refund me');

    expect(reply.content).toBe(FALLBACK);
    expect(reply.raw.buttons).toBeUndefined();
  });

  test('a clean plan-card turn finalizes to the model’s words, untouched', async () => {
    const clean = 'Saved — your replacement is on the way.';
    script = [toolUse([postCard]), textReply(clean)];

    const { conversationId, reply } = await turn('card-clean', 'send a replacement');

    expect(reply.content).toBe(clean);
    expect(reply.raw.platformNote).toBeUndefined();
    expect(await rulesBreadcrumb(conversationId)).toBeUndefined();
  });
});

// ---- 4. the ops flag --------------------------------------------------------

describe('A7b: ops is flagged through the P22 machinery, hourly', TURN_TIMEOUT, () => {
  test('first block alerts the reserved audience; a second in the hour is debounced', async () => {
    // A FRESH agent so its hourly claim is clean (the guardrails idiom).
    const opsAgentId = await createManagedAgent('rules-ops-agent', 'Rules Ops Agent');
    await setModeration({ denyPhrases: [DENY], fallback: FALLBACK }, 'rules-ops-agent');
    script = [textReply(`We ${DENY} it.`), textReply(`We ${DENY} it again.`)];

    const t1 = await turn('ops-1', 'refund me', 'rules-ops-agent');
    expect(t1.reply.content).toBe(FALLBACK);

    const evt1 = await pool.query<{
      recipients: Array<{ subscriberId: string }>;
      payload: Record<string, unknown>;
    }>('select recipients, payload from events where tenant_id = $1 and transaction_id = $2', [
      tenantId,
      `reply-rules-alert-${t1.messageId}`,
    ]);
    expect(evt1.rowCount).toBe(1);
    expect(evt1.rows[0].recipients.map((r) => r.subscriberId)).toEqual(['approvals']);
    // A POINTER, NOT THE PAYLOAD: the rule and where to look, never the matched
    // text — a tenant-authored workflow could email it anywhere.
    expect(evt1.rows[0].payload).toEqual({
      agentIdentifier: 'rules-ops-agent',
      rule: 'phrase',
      conversationId: t1.conversationId,
      blockedPreviousHour: 0,
    });
    expect(JSON.stringify(evt1.rows[0].payload)).not.toContain(DENY);
    // The end customer is never told their agent was gagged.
    expect(evt1.rows[0].recipients.some((r) => r.subscriberId === 'ops-1')).toBe(false);

    // Second block, same UTC hour, different message → debounced. NOT once a
    // day like the budget alert, but not one alert per block either: a broken
    // prompt can block every turn, and an ops channel that cries wolf a
    // thousand times before lunch is an ops channel nobody reads.
    const t2 = await turn('ops-2', 'refund me too', 'rules-ops-agent');
    expect(t2.reply.content).toBe(FALLBACK);
    const evt2 = await pool.query(
      'select 1 from events where tenant_id = $1 and transaction_id = $2',
      [tenantId, `reply-rules-alert-${t2.messageId}`],
    );
    expect(evt2.rowCount).toBe(0);

    // But the BLOCK itself is never debounced: every one writes its receipt.
    expect(await rulesBreadcrumb(t2.conversationId)).toBeDefined();
  });
});

// ---- 5. the untouched path --------------------------------------------------

describe('A7b: a clean reply is byte-identical to an ungated one', TURN_TIMEOUT, () => {
  test('no hit = the model’s words ship exactly, and nothing is written', async () => {
    const clean = 'Your order shipped this morning and arrives Tuesday.';
    script = [textReply(clean)];

    const { conversationId, reply } = await turn('clean-1', 'where is my order');

    expect(reply.content).toBe(clean);
    expect(reply.raw.platformNote).toBeUndefined();
    // The asymmetry is deliberate: a blocked turn needs a receipt because the
    // customer got a reply nobody wrote. A clean turn is just a turn, and a row
    // on every one of those forever is storage and transcript noise to record
    // that nothing happened.
    expect(await rulesBreadcrumb(conversationId)).toBeUndefined();
  });

  test('an agent with no rules is untouched, and so is an incoherent row', async () => {
    const clean = `We ${DENY} it — no rules are configured here.`;
    await setModeration(null);
    script = [textReply(clean)];
    const a = await turn('clean-2', 'hello');
    expect(a.reply.content).toBe(clean);

    // Deny phrases but NO fallback is not a policy, it is a mute button.
    await setModeration({ denyPhrases: [DENY] });
    script = [textReply(clean)];
    const b = await turn('clean-3', 'hello');
    expect(b.reply.content).toBe(clean);
    expect(await rulesBreadcrumb(b.conversationId)).toBeUndefined();

    // A fallback with nothing that can match is not a policy either.
    await setModeration({ fallback: FALLBACK });
    script = [textReply(clean)];
    const c = await turn('clean-4', 'hello');
    expect(c.reply.content).toBe(clean);
  });
});

// ---- 8. the topic gate's redirect is exempt ---------------------------------

describe('A7b: the topic-gate redirect is NOT checked against the reply rules', TURN_TIMEOUT, () => {
  test('a redirect containing a denied phrase still ships, untouched', async () => {
    // Circular by construction: the redirect is the OPERATOR'S OWN canned text,
    // and running it against that same operator's deny list can only produce an
    // operator whose redirect blocks itself into a second canned sentence. This
    // gate exists to check what the MODEL wrote. The exemption is structural —
    // a redirect short-circuits past the brain branch entirely — and this test
    // is what stops a future refactor from quietly moving the check.
    const redirect = `I can only help with orders — but I ${DENY} a teammate will follow up.`;
    await setTopics({ deny: ['medical advice'], redirect });
    classifyLabel = 'medical advice';

    const { conversationId, reply } = await turn('exempt-1', 'advise me about this rash');

    expect(reply.content).toBe(redirect);
    expect(reply.raw.platformNote).toBe(true);
    expect(await rulesBreadcrumb(conversationId)).toBeUndefined();
  });
});

// ---- 7. the candidate trichotomy, through real eval runs --------------------

describe('A7b: candidate.moderation carries TOPICS’ semantics, not routing’s', TURN_TIMEOUT, () => {
  test('ABSENT = the agent’s own rules apply, so the run meets the gate', async () => {
    // The heart of the asymmetry with A6: routing changes WHO answers, so an
    // unopinionated candidate must not be rerouted. Moderation changes WHAT MAY
    // SHIP, and a prompt edit is graded AS THIS AGENT: if the live rules would
    // replace the scenario's reply with the fallback, the check has to meet that
    // too, or it passes an agent that does not exist.
    const run = await runEvals({
      trigger: 'pre_save',
      candidate: { systemPrompt: 'You are the DRAFT agent.' },
    });
    // The scenario expects 'echo' (the model's own words); it got the fallback.
    expect(run.status).toBe('failed');
  }, 90_000);

  test('null = graded with the rules OFF', async () => {
    const run = await runEvals({
      trigger: 'pre_save',
      candidate: { systemPrompt: 'You are the DRAFT agent.', moderation: null },
    });
    expect(run.status).toBe('passed');
  }, 90_000);

  test('an object = graded with THOSE rules, not the agent’s', async () => {
    // The candidate's list does not contain the agent's phrase, so the same
    // reply that the live agent would block sails through this run.
    const run = await runEvals({
      trigger: 'pre_save',
      candidate: {
        systemPrompt: 'You are the DRAFT agent.',
        moderation: { denyPhrases: ['a word nobody says'], fallback: 'Draft fallback.' },
      },
    });
    expect(run.status).toBe('passed');

    // And an object that DOES match blocks the run's reply, proving the
    // candidate's own rules are the ones in force.
    const blocked = await runEvals({
      trigger: 'pre_save',
      candidate: {
        systemPrompt: 'You are the DRAFT agent.',
        moderation: { denyPhrases: ['echo'], fallback: 'Draft fallback.' },
      },
    });
    expect(blocked.status).toBe('failed');
  }, 120_000);
});

// ---- 9. bridge agents -------------------------------------------------------

describe('A7b: a bridge agent has no reply rules', TURN_TIMEOUT, () => {
  test('rules on a bridge row change nothing — its reply is the customer’s own code', async () => {
    await setModeration({ denyPhrases: [DENY], fallback: FALLBACK }, 'rules-bridge');
    const hitsBefore = bridgeHits;

    const { conversationId, reply } = await turn('bridge-turn', 'anything', 'rules-bridge');

    expect(bridgeHits).toBeGreaterThan(hitsBefore);
    expect(reply.content).toBe(`we ${DENY} the bridge answered`);
    expect(await rulesBreadcrumb(conversationId)).toBeUndefined();
  });
});
