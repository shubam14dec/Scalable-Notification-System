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
| `approvals.list / decide` | Human-in-the-loop tool-call queue |
| `settings.getApprovals / putApprovals` | Which channels carry approval cards |
| `subscriberToken(subscriberId, ttlSeconds?)` | Browser-safe inbox token |

Errors throw `AsyncifyError` with `status` and the API's message.

MIT © Shubam Patil
