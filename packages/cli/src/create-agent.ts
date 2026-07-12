/**
 * `asyncify create-agent <dir>` — scaffold a runnable bridge-agent starter:
 * a self-registering agent.ts, the package.json to run it, and the docs a
 * newcomer needs. Refuses to overwrite a non-empty directory.
 */

import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Human-friendly display name derived from an identifier ("my-bot" → "My Bot"). */
function displayName(identifier: string): string {
  return identifier
    .split('-')
    .filter(Boolean)
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ') || identifier;
}

export async function runCreateAgent(dir: string, identifier: string): Promise<void> {
  // Refuse to scaffold into a non-empty directory.
  let existing: string[] = [];
  try {
    existing = await readdir(dir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  if (existing.length > 0) {
    console.error(`✖ ${dir} already exists and is not empty — pick an empty directory.`);
    process.exit(1);
  }

  await mkdir(dir, { recursive: true });

  const name = displayName(identifier);
  const files: Record<string, string> = {
    'package.json': packageJson(identifier),
    'agent.ts': agentTs(identifier, name),
    '.env.example': envExample(),
    'README.md': readme(identifier),
    '.gitignore': 'node_modules\n.env\n',
  };

  for (const [file, content] of Object.entries(files)) {
    await writeFile(join(dir, file), content, 'utf8');
  }

  console.log(`✔ Scaffolded agent "${identifier}" in ${dir}\n`);
  console.log('Next steps:');
  console.log(`  1. cd ${dir} && npm install`);
  console.log('  2. cp .env.example .env   # then set ASYNCIFY_API_KEY');
  console.log('  3. npm run dev            # registers the agent and serves the bridge');
}

function packageJson(identifier: string): string {
  return (
    JSON.stringify(
      {
        name: identifier,
        private: true,
        type: 'module',
        scripts: {
          dev: 'tsx --env-file=.env agent.ts',
        },
        dependencies: {
          '@asyncify-hq/agent': '^0.4.0',
        },
        devDependencies: {
          tsx: '^4.19.2',
          typescript: '^5.7.2',
          '@types/node': '^20',
        },
        engines: {
          node: '>=20.6',
        },
      },
      null,
      2,
    ) + '\n'
  );
}

function envExample(): string {
  return [
    '# Where your Asyncify API lives (the running notification stack).',
    'ASYNCIFY_API_URL=http://localhost:3000',
    '# Your tenant API key — the agent self-registers with it. Required.',
    'ASYNCIFY_API_KEY=dev-api-key-123',
    '# Local port this bridge listens on for signed events from Asyncify.',
    'PORT=4200',
    '',
  ].join('\n');
}

function readme(identifier: string): string {
  return `# ${identifier}

A bridge agent for [Asyncify](https://asyncify.org), scaffolded with
\`asyncify create-agent\`. Your code is the brain; Asyncify handles the
channels (in-app, Telegram, email, Slack) and delivers each conversation turn
here as a signed webhook.

## Run it

1. \`npm install\`
2. \`cp .env.example .env\` and set \`ASYNCIFY_API_KEY\` to your tenant key.
3. \`npm run dev\` — the agent registers itself with Asyncify and starts
   listening. (Needs Node >= 20.6 for \`--env-file\`.)

## Talk to it

\`\`\`bash
curl -X POST http://localhost:3000/v1/agents/${identifier}/messages \\
  -H 'content-type: application/json' \\
  -H 'x-api-key: dev-api-key-123' \\
  -d '{ "subscriberId": "ana", "text": "hello" }'
\`\`\`

Edit \`agent.ts\` to build your brain — the commented \`onAction\` and
\`onResolve\` stubs show buttons, cards, and lifecycle handling.
`;
}

function agentTs(identifier: string, name: string): string {
  // Note: literal ${...} and backticks below are escaped so they survive into
  // the generated file verbatim.
  return `/**
 * ${name} — an Asyncify bridge agent. Build the brain; Asyncify handles the
 * channels. Run with: npm run dev   (tsx --env-file=.env agent.ts)
 */
import http from 'node:http';
import { defineAgent, createHandler } from '@asyncify-hq/agent';

const API_URL = process.env.ASYNCIFY_API_URL ?? 'http://localhost:3000';
const API_KEY = process.env.ASYNCIFY_API_KEY;
const PORT = Number(process.env.PORT ?? 4200);
const IDENTIFIER = '${identifier}';
const NAME = '${name}';

if (!API_KEY) {
  console.error('ASYNCIFY_API_KEY is required — copy .env.example to .env and set it.');
  process.exit(1);
}

async function api(method: string, path: string, body?: unknown) {
  const res = await fetch(\`\${API_URL}\${path}\`, {
    method,
    headers: { 'content-type': 'application/json', 'x-api-key': API_KEY! },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

/** Create this agent, or re-key it if it already exists (bridge runtime). */
async function registerAgent(): Promise<string> {
  const bridgeUrl = \`http://localhost:\${PORT}\`;
  const created = await api('POST', '/v1/agents', {
    identifier: IDENTIFIER,
    name: NAME,
    bridgeUrl,
  });
  if (created.status === 201) {
    return (created.json as { signingSecret: string }).signingSecret;
  }
  if (created.status === 409) {
    // Already exists — make sure it points here, then rotate the secret.
    await api('PATCH', \`/v1/agents/\${IDENTIFIER}\`, { runtime: 'bridge', bridgeUrl });
    const rotated = await api('POST', \`/v1/agents/\${IDENTIFIER}/rotate-secret\`);
    if (rotated.status === 200) {
      return (rotated.json as { signingSecret: string }).signingSecret;
    }
  }
  throw new Error(\`could not register agent: \${created.status} \${JSON.stringify(created.json)}\`);
}

const brain = defineAgent({
  // Called for every user message on any channel.
  async onMessage(ctx) {
    // ctx.history is pre-shaped for LLM SDKs: [{ role, content }, ...].
    // Drop in generateText({ messages: [...ctx.history, ...] }) to add an LLM.
    return \`\${NAME} here — you said: "\${ctx.message.text}"\`;
  },

  // Uncomment to offer tappable choices and handle the clicks. Reply with
  // buttons or a card, and the user's answer comes back here as an action.
  //
  // async onMessage(ctx) {
  //   ctx.reply('How can I help?', {
  //     buttons: [
  //       { id: 'order', label: 'Track my order' },
  //       { id: 'human', label: 'Talk to a human' },
  //     ],
  //   });
  //   // Or a card instead of buttons:
  //   // ctx.reply('Pick a plan', {
  //   //   card: { type: 'select', id: 'plan',
  //   //     options: [{ id: 'pro', label: 'Pro' }, { id: 'team', label: 'Team' }] },
  //   // });
  // },
  //
  // async onAction(ctx) {
  //   if (ctx.action?.id === 'order') {
  //     ctx.trigger('order-status', { payload: { order: '#1042' } });
  //     return 'On it — a status update is on the way.';
  //   }
  //   return 'A teammate will pick this up shortly.';
  // },
  //
  // Fires when a conversation is resolved (by you, an operator, or the sweep).
  // onResolve(ctx) {
  //   console.log(\`resolved \${ctx.conversation.id} by \${ctx.resolvedBy}\`);
  // },
});

async function main() {
  const signingSecret = await registerAgent();
  http.createServer(createHandler(brain, { signingSecret })).listen(PORT, () => {
    console.log(\`[\${IDENTIFIER}] bridge listening on :\${PORT}\`);
    console.log('Talk to it:');
    console.log(
      \`  curl -X POST \${API_URL}/v1/agents/\${IDENTIFIER}/messages \\\\\n\` +
        \`    -H 'content-type: application/json' -H 'x-api-key: \${API_KEY}' \\\\\n\` +
        \`    -d '{ "subscriberId": "ana", "text": "hello" }'\`,
    );
  });
}

main().catch((err) => {
  console.error('agent failed to start:', err);
  process.exit(1);
});
`;
}
