/**
 * The Ana demo — a complete customer-side agent using @asyncify-hq/agent.
 * Rule-based brain (no LLM key needed); swapping in a real LLM is the
 * three-line ctx.history snippet in the package README.
 *
 * Self-registering: creates (or re-keys) the `support-demo` agent via the
 * API, then serves the bridge on :4100. Talk to it via <AgentChat /> or:
 *
 *   npm run agent:demo            # uses dev-api-key-123 / localhost:3000
 *   $env:API_KEY='ak_...'; npx tsx scripts/agent-demo.ts
 */
import http from 'node:http';
import { defineAgent, createHandler } from '../packages/agent/src/index';

const API_URL = process.env.API_URL ?? 'http://localhost:3000';
const API_KEY = process.env.API_KEY ?? 'dev-api-key-123';
const PORT = Number(process.env.AGENT_DEMO_PORT ?? 4100);
const IDENTIFIER = 'support-demo';
/** Workflow the brain fires mid-conversation (exists in the dev seed). */
const WORKFLOW = process.env.AGENT_DEMO_WORKFLOW ?? 'welcome';

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** Create the demo agent, or rotate its secret if it already exists. */
async function registerAgent(): Promise<string> {
  const created = await api('POST', '/v1/agents', {
    identifier: IDENTIFIER,
    name: 'Support Demo',
    description: 'Rule-based demo brain from scripts/agent-demo.ts',
    bridgeUrl: `http://localhost:${PORT}/`,
  });
  if (created.status === 201) {
    return (created.json as { signingSecret: string }).signingSecret;
  }
  if (created.status === 409) {
    // Reclaim fully: the agent may have been flipped to runtime=managed
    // in the dashboard since the last demo run.
    await api('PATCH', `/v1/agents/${IDENTIFIER}`, {
      runtime: 'bridge',
      bridgeUrl: `http://localhost:${PORT}/`,
    });
    const rotated = await api('POST', `/v1/agents/${IDENTIFIER}/rotate-secret`);
    if (rotated.status === 200) {
      return (rotated.json as { signingSecret: string }).signingSecret;
    }
  }
  throw new Error(`could not register agent: ${created.status} ${JSON.stringify(created.json)}`);
}

const brain = defineAgent({
  async onMessage(ctx) {
    const text = ctx.message.text.toLowerCase();
    console.log(
      `[${IDENTIFIER}] ${ctx.subscriber.subscriberId}: "${ctx.message.text}"` +
        ` (history: ${ctx.history.length} turns, topic: ${ctx.metadata.get('topic') ?? '-'})`,
    );

    if (text.includes('order')) {
      ctx.metadata.set('topic', 'missing-order');
      // Buttons: the human-in-the-loop building block. Clicks come back
      // through onAction below (widget click or Telegram inline keyboard).
      ctx.reply(
        'So sorry about that! I checked and your package is stuck in transit. How should we fix this?',
        {
          buttons: [
            { id: 'resend', label: 'Resend the order' },
            { id: 'human', label: 'Talk to a human' },
          ],
        },
      );
      return;
    }
    if (text.includes('thanks') || text.includes('thank you')) {
      ctx.resolve('order issue handled');
      return 'Anytime! Closing this out — message me again if anything else comes up.';
    }
    if (ctx.history.length === 0) {
      return `Hi ${ctx.subscriber.subscriberId}! I'm the support demo. Ask me about your order.`;
    }
    return 'I can help with orders — try asking "where is my order #1042?"';
  },

  async onAction(ctx) {
    console.log(`[${IDENTIFIER}] ${ctx.subscriber.subscriberId} clicked: ${ctx.action?.id}`);
    if (ctx.action?.id === 'resend') {
      ctx.trigger(WORKFLOW, {
        payload: { name: ctx.subscriber.subscriberId, company: 'Asyncify Demo' },
      });
      return 'Done — a replacement is on the way and a confirmation email is incoming.';
    }
    if (ctx.action?.id === 'human') {
      ctx.metadata.set('escalated', 'true');
      return 'You got it — a teammate will pick this up shortly. Anything to add meanwhile?';
    }
    return `Got your choice: ${ctx.message.text}`;
  },
});

async function main() {
  const secret = await registerAgent();
  http
    .createServer(createHandler(brain, { signingSecret: secret }))
    .listen(PORT, () =>
      console.log(
        `[${IDENTIFIER}] bridge up on :${PORT} — send a message:\n` +
          `  POST ${API_URL}/v1/agents/${IDENTIFIER}/messages\n` +
          `  { "subscriberId": "ana", "text": "where is my order #1042?" }`,
      ),
    );
}

main().catch((err) => {
  console.error('agent demo failed:', err);
  process.exit(1);
});
