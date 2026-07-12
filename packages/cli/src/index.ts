#!/usr/bin/env node
/**
 * @asyncify-hq/cli — `asyncify dev` (managed tunnel + webhook rewiring) and
 * `asyncify create-agent` (bridge-agent scaffolder). Zero runtime deps.
 */

import { parseArgs } from './args';
import { runDev } from './dev';
import { runCreateAgent } from './create-agent';

const HELP = `asyncify — dev tooling for Asyncify agents

Usage:
  asyncify dev [options]                Managed cloudflared tunnel + webhook rewiring
  asyncify create-agent <dir> [options] Scaffold a bridge-agent starter project

Commands:
  dev
    --port <n>        Local port the Asyncify stack listens on (default 3000)
    --api-url <url>   Asyncify API base URL (default http://localhost:3000)
    --api-key <key>   Tenant API key (default: $ASYNCIFY_API_KEY, else dev seed)
    --no-env-write    Do not update PUBLIC_URL in ./.env

  create-agent <dir>
    --identifier <id> Agent identifier (default: slugified <dir> basename)

  -h, --help          Show this help
`;

async function main(): Promise<void> {
  const sub = process.argv[2];

  if (sub === '-h' || sub === '--help' || sub === 'help' || sub === undefined) {
    process.stdout.write(HELP);
    process.exit(0);
  }

  if (sub !== 'dev' && sub !== 'create-agent') {
    process.stderr.write(`Unknown command: ${sub}\n\n${HELP}`);
    process.exit(1);
  }

  const args = parseArgs(process.argv);
  if (args.command === 'dev') {
    await runDev(args);
  } else {
    await runCreateAgent(args.dir, args.identifier);
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
