# @asyncify-hq/agent

Build the brain; Asyncify handles the channels. This SDK receives
normalized conversation events from Asyncify (any channel — in-app today,
more coming), lets your code reply, and batches **signals** — conversation
metadata, workflow triggers, resolution — into the single HTTP response.

Zero dependencies. Works with plain Node `http`, Express, Fastify, or any
framework that exposes the raw request.

## Quickstart

1. Register an agent (dashboard → Agents, or the API) with the URL your
   handler will listen on. Copy the signing secret — it is shown once.

2. Write the brain:

```ts
import http from 'node:http';
import { defineAgent, createHandler } from '@asyncify-hq/agent';

const support = defineAgent({
  async onMessage(ctx) {
    // ctx.history is pre-shaped for LLM SDKs: [{ role, content }, ...]
    if (ctx.message.text.toLowerCase().includes('order')) {
      ctx.metadata.set('topic', 'orders');
      // fire a real notification workflow, mid-conversation
      ctx.trigger('order-replacement', { payload: { order: '#1042' } });
      return 'So sorry! A replacement is on the way — confirmation email incoming.';
    }
    if (ctx.message.text.toLowerCase().includes('thanks')) {
      ctx.resolve('customer satisfied');
      return 'Anytime!';
    }
    return `You said: ${ctx.message.text}`;
  },
});

http
  .createServer(createHandler(support, { signingSecret: process.env.ASYNCIFY_AGENT_SECRET! }))
  .listen(4100);
```

3. Send a message from the `<AgentChat />` widget (`@asyncify-hq/react`)
   or the API — your handler answers, Asyncify delivers.

## Adding an LLM

`ctx.history` maps directly onto chat-completion messages:

```ts
const { text } = await generateText({
  model: openai('gpt-4o-mini'),
  system: 'You are a support agent for Acme.',
  messages: [...ctx.history, { role: 'user', content: ctx.message.text }],
});
return text;
```

## Security

Every request is HMAC-SHA256 signed (`x-asyncify-signature` over
`timestamp.body`, replay-protected by `x-asyncify-timestamp`). The handler
rejects anything unsigned or stale; `verifySignature` is exported if you
need to verify manually.
