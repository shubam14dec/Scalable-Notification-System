# @asyncify-hq/node

Server-side SDK for [Asyncify](https://asyncify.org) — multi-channel
notification infrastructure. One trigger call fans out to email, SMS, push
and in-app, with priority queues, retries, digests and delivery tracking
handled for you.

## Install

```bash
npm install @asyncify-hq/node
```

## Quickstart

```ts
import { AsyncifyClient } from '@asyncify-hq/node';

const asyncify = new AsyncifyClient({
  apiKey: process.env.ASYNCIFY_API_KEY!,
  baseUrl: 'https://api.your-deployment.com',
});

// Fire a workflow for a user
await asyncify.trigger('order-shipped', {
  to: [{ subscriberId: 'user-42', email: 'user42@example.com' }],
  payload: { orderId: 'ORD-1', eta: 'Tuesday' },
});

// Idempotent retries: same transactionId can never double-send
await asyncify.trigger('otp', {
  to: [{ subscriberId: 'user-42', phone: '+15550001111' }],
  payload: { code: '123456' },
  priority: 'p0',
  transactionId: `otp-${loginAttemptId}`,
});

// Send to a topic (named segment) or to everyone
await asyncify.trigger('changelog', { to: [{ topic: 'beta-users' }] });
await asyncify.broadcast('maintenance-notice');
```

## The inbox widget token

Mint a short-lived, single-subscriber token in your backend and hand it to
[`@asyncify-hq/react`](https://www.npmjs.com/package/@asyncify-hq/react) in
your frontend — API keys never reach the browser:

```ts
const { token } = await asyncify.subscriberToken('user-42');
```

## Agent tools & approvals

Give a managed agent a custom tool, then review the calls it wants to make:

```ts
// Register a tool — the secret is returned ONCE; store it to verify our
// signed calls to your endpoint.
const { secret } = await asyncify.agents.tools.create('acme-support', {
  name: 'lookup_order',
  description: 'Fetch an order by id',
  parameters: { type: 'object', properties: { orderId: { type: 'string' } } },
  endpointUrl: 'https://api.acme.com/tools/lookup-order',
  approval: 'required',
});

// Work the human-in-the-loop queue
const { approvals } = await asyncify.approvals.list({ status: 'pending' });
await asyncify.approvals.decide(approvals[0].id, 'approve');

// Route approval cards to a Slack channel
await asyncify.settings.putApprovals({ slackConnectionId, slackChannelId: 'C0123' });
```

## Grounding an agent in your own knowledge

Give a managed agent material to answer from — pasted text or a URL. Indexing
runs async, so poll `list` until the source is `ready` (needs the tenant's
embeddings + vector-store integrations configured first):

```ts
const { source } = await asyncify.agents.knowledge.create('acme-support', {
  name: 'returns-policy',
  kind: 'text',
  text: 'Opened electronics can be returned within 14 days…',
});

// poll until ready
const { sources } = await asyncify.agents.knowledge.list('acme-support');

// re-embed after the underlying page/text changes, or drop a source
await asyncify.agents.knowledge.reindex('acme-support', source.id);
await asyncify.agents.knowledge.remove('acme-support', source.id);
```

Once a source is `ready`, the managed brain is offered a `search_knowledge`
tool and cites what it finds as `[source: returns-policy]`.

## Long-term memory (per customer)

Knowledge is what your business knows; **memory** is the durable facts an agent
keeps about *one* customer — a preference, their plan, a constraint — loaded
into every future conversation with them. The agent writes these itself (its
`remember` built-in), and you can read or edit them by the subscriber's external
id:

```ts
// what the agent remembers about this customer
const { memories } = await asyncify.agents.memories.list('acme-support', 'user-42');
// → [{ key: 'channel_pref', value: 'prefers email over SMS', source: 'agent', updatedAt: '…' }]

// set/correct a fact yourself (tagged source: 'operator')
await asyncify.agents.memories.put('acme-support', 'user-42', {
  key: 'plan',
  value: 'Pro',
});

// forget one fact, or the whole profile (omit the key)
await asyncify.agents.memories.remove('acme-support', 'user-42', 'plan');
await asyncify.agents.memories.remove('acme-support', 'user-42');
```

Caps are enforced: ≤32 keys per customer, key ≤64 chars, value ≤300 chars. A new
key on a full profile → `AsyncifyError` (409) — overwrite an existing key
instead. Never store secrets or payment data here.

## Testing a prompt change before it ships (evals)

An eval is a scripted conversation plus assertions about what the agent *did* —
which tools it called — and, optionally, **LLM-judged dimensions** for what a
tool trace can't see: `groundedness`, `tone`, `refusal`, scored 1–5 against a bar
you set. Runs drive the real pipeline (queue → worker → brain → tools), so a
green run is about the agent your customers actually reach:

```ts
await asyncify.agents.evals.create('acme-support', {
  name: 'refund-window',
  scenario: {
    turns: [
      { user: 'my headphones broke — can I get a refund?' },
      { expect: { tool: 'lookup_order' } },
      { expect: { judge: { groundedness: { min: 4 } } } },
    ],
  },
});

// Grade the agent as it is live right now…
const { runId } = await asyncify.agents.evals.run('acme-support');

// …or grade an edit you have NOT saved yet: the real agent, tools, guardrails
// and knowledge, with only the prompt and/or model swapped in for the run.
// Nothing is written to the agent — this is what the dashboard's pre-save
// check does. Managed agents only; a candidate on a bridge agent is a 400.
const { runId: preSaveRun } = await asyncify.agents.evals.run('acme-support', {
  trigger: 'pre_save',
  candidate: { systemPrompt: 'You are Acme support. Refunds within 14 days…' },
});

// Runs are async — poll until it leaves 'running'
const { run } = await asyncify.agents.evals.getRun('acme-support', preSaveRun);
// run.status  → 'running' | 'passed' | 'failed' | 'error'
// run.results → [{ name, passed, attempts, failures, judged? }]
//   failures: ['judge.groundedness: 2/5 < 4 — "30 days" appears in no source']
//   judged:   [{ turn, dim: 'groundedness', verdict: 'fail', score: 2, rationale }]
```

A judged dimension comes back as `verdict: 'skipped'` when no judge was
available (the agent has no model, or its LLM client couldn't be built) — never
a silent pass. Compare `run.results` against the previous run's to show a delta
rather than a wall of green.

## Versioning and canary (managed agents)

Every save that changes a managed agent's prompt or model snapshots itself, so
the history is append-only — **restore doesn't rewind it, it publishes**:

```ts
const { versions } = await asyncify.agents.versions.list('acme-support');
// [{ version: 7, model, promptLength, promptHead, current: true, createdAt }, …]

const { version } = await asyncify.agents.versions.get('acme-support', 5);
// version.systemPrompt → the full text of that snapshot

// Roll back = a new save carrying v5's content. v6 and v7 stay in the history.
const restored = await asyncify.agents.versions.restore('acme-support', 5);
// restored.restoredFrom → 5, restored.version → 8
```

A new version can also **trial on a share of real conversations** before it
takes over. The arm is picked when a conversation opens and sticks for its whole
life — nobody meets two personalities in one thread — and a canary-arm turn runs
on the trial snapshot through the same candidate mechanism the pre-save check
uses. Nothing about the live agent changes:

```ts
await asyncify.agents.canary.start('acme-support', {
  version: 8,
  percent: 10,        // 1–99 of NEWLY OPENED conversations join the trial arm
  samplePercent: 20,  // 0–100 (default 20) of replies judged in BOTH arms
});

const report = await asyncify.agents.canary.report('acme-support');
// report.arms → exactly two, 'canary' and 'control', zeros before traffic lands
//   { arm, conversations, turns, resolutions, handoffs, guardPauses,
//     avgTokensPerTurn, judged: { groundedness: { avg: 4.3, n: 31 }, tone: {…} } }

await asyncify.agents.canary.promote('acme-support'); // …or .stop(…)
```

Both arms are judged at the **same** rate on purpose — an unjudged control arm
is not a control. The judged numbers are **averages, not verdicts**: live
traffic carries no scenario author's declaration of what the reply should have
been, so there is no bar to pass here, only canary's average against control's.
`promote` ends the trial by publishing the winner as an ordinary new version;
`stop` ends it with no change, and enrolled conversations return to the live
prompt at their next turn. One trial per agent — starting a second is a `409`.

Careful with the control arm: saving an edit to the live prompt **while a trial
is running** changes what the control arm is serving, so the comparison from
that point measures against a different baseline than it started with.

### Model routing

`agents.update(id, { routing })` puts a managed agent's simple replies on a
cheaper model. Every routed turn runs on `cheapModel` first; the moment that
attempt reaches for a consequential tool — a workflow, one of your own tools, a
knowledge lookup — the whole turn is discarded and re-run on the agent's main
model, so a small model is trusted to talk and never to act. `cheapModel` must
be an id your own endpoint serves (routing rides this agent's key and base URL);
a wrong id is safe — the cheap call fails, the turn escalates, and every reply
still lands. `routing: null` switches it off. Managed agents only; a bridge
agent answers `400`.

```ts
await asyncify.agents.update('acme-support', {
  routing: { enabled: true, cheapModel: 'claude-haiku-4-5' },
});
```

An eval run can grade the router before you save it — pass `routing` inside
`candidate` and the run really executes through it (`null` grades the agent with
routing off).

### Topic rules and reply rules

`agents.update(id, { topics })` decides **what a managed agent will discuss**:
one small classifier call in front of the brain names the topic of each message,
and anything you denied (or anything outside `allow`, when you fill it in) gets
your `redirect` sent back word for word, without the brain ever running.
`agents.update(id, { moderation })` decides **what may ship**: every drafted
reply is checked in-process — no model, no latency — against `denyPhrases`
(case-insensitive substrings) and, with `blockPii`, against emails and phone
numbers that are not the customer's own; a blocked reply is replaced by your
`fallback`. Write that fallback carefully: the turn's tools have already run by
then, so "a teammate will follow up" is safe where "I couldn't help" may be
false. `null` switches either off. Managed agents only; a bridge agent answers
`400`.

```ts
await asyncify.agents.update('acme-support', {
  topics: {
    deny: ['medical advice', 'legal advice'],
    redirect: 'I can only help with orders and returns here.',
  },
  moderation: {
    denyPhrases: ['guarantee', 'risk-free'],
    blockPii: true,
    fallback: 'Let me get a teammate to confirm that — someone will follow up shortly.',
  },
});
```

Both gates take `candidate` overrides on an eval run, with one difference from
`routing` worth knowing: **omitting** them leaves the agent's own gates in force
for the run (a check grades the agent you have, boundaries included), so `null`
is how you ask "do these still pass with the gate off?".

### Per-customer message limits

`agents.update(id, { subscriberRate })` caps how many messages **one end user**
may send inside a fixed window. Past the cap that person stops getting replies
until the window ends and receives your `notice` **once** — never on every
message, since a limit that answered a flood would be an amplifier. Their
messages still land in the conversation exactly as they sent them; only the turn
is skipped, so the transcript stays true. Everyone else is unaffected, which is
the difference from the daily token budget: that one goes quiet for *all* your
customers, so using it as the defense against one abusive user lets that user
mute the agent for everybody. `subscriberRate: null` switches it off. This is the
one agent config that works on **both runtimes** — it protects your own handler's
compute, not a brain we run.

```ts
await asyncify.agents.update('acme-support', {
  subscriberRate: {
    maxMessages: 20,
    windowMinutes: 5,
    notice: "You're sending messages faster than I can answer — I'll pick this up shortly.",
  },
});
```

A config outside the bounds (`maxMessages` 1–1000, `windowMinutes` 1–1440,
`notice` 1–2000) is rejected on save and read as **off** if one ever reaches the
row another way — never clamped, because a limiter throttling at a number you did
not choose is worse than none. There is deliberately **no `candidate` override**:
an eval scenario is a burst of messages from one synthetic subscriber by
construction, so a gradeable message limit would throttle the check itself.

## API surface

| Method | Purpose |
|---|---|
| `trigger(workflowKey, { to, payload, priority?, transactionId? })` | Fire a workflow (recipients and/or `{ topic }` refs) |
| `broadcast(workflowKey, { payload? })` | Send to every subscriber (bulk tier) |
| `events.get(transactionId)` | Per-channel delivery status |
| `subscribers.upsert({ subscriberId, email?, phone?, pushToken? })` | Create/update a subscriber |
| `subscribers.registerDevice / listDevices / removeDevice` | Multi-device push tokens per subscriber |
| `topics.upsert / addSubscribers / removeSubscribers / list / delete` | Manage segments |
| `workflows.upsert / list` · `templates.upsert / get / list / delete` | Manage workflows & MJML templates |
| `agents.create / list / get / update / rotateSecret / delete / linkToken` | Manage AI agents |
| `agents.tools.create / list / update / delete / rotateSecret` | Per-agent custom tool registry |
| `agents.knowledge.create / list / reindex / remove` | Per-agent knowledge sources for grounded answers |
| `agents.memories.list / put / remove` | Per-customer long-term memory (durable facts, by subscriber external id) |
| `agents.evals.list / create / update / remove` | Per-agent eval scenarios (scripted turns + tool-trace and judged expectations) |
| `agents.evals.run / runs / getRun` | Run the enabled scenarios — live config, or an unsaved `candidate` — and poll the verdict |
| `agents.versions.list / get / restore` | Prompt history for a managed agent; restore publishes an old snapshot as a new version |
| `agents.canary.start / stop / promote / report` | Trial a version on a share of real conversations, then read the per-arm comparison |
| `approvals.list / decide` | Human-in-the-loop tool-call queue |
| `settings.getApprovals / putApprovals` | Which channels carry approval cards |
| `subscriberToken(subscriberId, ttlSeconds?)` | Browser-safe inbox token |

Errors throw `AsyncifyError` with `status` and the API's message.

MIT © Shubam Patil
