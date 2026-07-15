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

## API surface

| Method | Purpose |
|---|---|
| `trigger(workflowKey, { to, payload, priority?, transactionId? })` | Fire a workflow (recipients and/or `{ topic }` refs) |
| `broadcast(workflowKey, { payload? })` | Send to every subscriber (bulk tier) |
| `events.get(transactionId)` | Per-channel delivery status |
| `subscribers.upsert({ subscriberId, email?, phone?, pushToken? })` | Create/update a subscriber |
| `topics.upsert / addSubscribers / removeSubscribers / list / delete` | Manage segments |
| `workflows.upsert / list` · `templates.upsert / get / list / delete` | Manage workflows & MJML templates |
| `agents.create / list / get / update / rotateSecret / delete / linkToken` | Manage AI agents |
| `agents.tools.create / list / update / delete / rotateSecret` | Per-agent custom tool registry |
| `approvals.list / decide` | Human-in-the-loop tool-call queue |
| `settings.getApprovals / putApprovals` | Which channels carry approval cards |
| `subscriberToken(subscriberId, ttlSeconds?)` | Browser-safe inbox token |

Errors throw `AsyncifyError` with `status` and the API's message.

MIT © Shubam Patil
