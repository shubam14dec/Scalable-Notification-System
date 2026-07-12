/**
 * Argument parsing for the two commands. Kept pure (no process/env reads
 * beyond the documented ASYNCIFY_API_KEY default) so it can be unit-tested by
 * the main repo the way it tests packages/agent/src.
 */

export interface DevArgs {
  command: 'dev';
  port: number;
  apiUrl: string;
  apiKey: string;
  /** True when apiKey fell back to the dev seed default (no env, no flag). */
  apiKeyIsSeedDefault: boolean;
  /** When true, never touch ./.env even if it exists. */
  envWrite: boolean;
}

export interface CreateAgentArgs {
  command: 'create-agent';
  dir: string;
  identifier: string;
}

export type ParsedArgs = DevArgs | CreateAgentArgs;

/** The dev seed API key baked into the local stack (see MEMORY: agent:demo). */
export const SEED_API_KEY = 'dev-api-key-123';

/** Turn an arbitrary string into a safe [a-z0-9-] agent identifier. */
export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || 'agent';
}

function parseIntFlag(name: string, raw: string | undefined): number {
  if (raw === undefined) throw new Error(`${name} requires a value`);
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || String(n) !== raw.trim()) {
    throw new Error(`${name} expects an integer, got "${raw}"`);
  }
  return n;
}

/**
 * Parse `argv` (the full process.argv). argv[2] selects the command; the rest
 * are flags/positionals. Unknown flags throw with the offending flag name.
 */
export function parseArgs(argv: string[]): ParsedArgs {
  const command = argv[2];
  const rest = argv.slice(3);

  if (command === 'dev') return parseDev(rest);
  if (command === 'create-agent') return parseCreateAgent(rest);
  throw new Error(`unknown command: ${command ?? '(none)'}`);
}

function parseDev(rest: string[]): DevArgs {
  let port = 3000;
  let apiUrl = 'http://localhost:3000';
  let apiKey: string | undefined;
  let envWrite = true;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    switch (arg) {
      case '--port':
        port = parseIntFlag('--port', rest[++i]);
        break;
      case '--api-url':
        if (rest[i + 1] === undefined) throw new Error('--api-url requires a value');
        apiUrl = rest[++i];
        break;
      case '--api-key':
        if (rest[i + 1] === undefined) throw new Error('--api-key requires a value');
        apiKey = rest[++i];
        break;
      case '--no-env-write':
        envWrite = false;
        break;
      default:
        throw new Error(`unknown flag: ${arg}`);
    }
  }

  const envKey = process.env.ASYNCIFY_API_KEY;
  const resolvedKey = apiKey ?? envKey ?? SEED_API_KEY;
  const apiKeyIsSeedDefault = apiKey === undefined && !envKey;

  return {
    command: 'dev',
    port,
    apiUrl,
    apiKey: resolvedKey,
    apiKeyIsSeedDefault,
    envWrite,
  };
}

function parseCreateAgent(rest: string[]): CreateAgentArgs {
  let dir: string | undefined;
  let identifier: string | undefined;

  for (let i = 0; i < rest.length; i++) {
    const arg = rest[i];
    if (arg === '--identifier') {
      if (rest[i + 1] === undefined) throw new Error('--identifier requires a value');
      identifier = rest[++i];
    } else if (arg.startsWith('--')) {
      throw new Error(`unknown flag: ${arg}`);
    } else if (dir === undefined) {
      dir = arg;
    } else {
      throw new Error(`unexpected argument: ${arg}`);
    }
  }

  if (dir === undefined) throw new Error('create-agent requires a target directory');

  // Default identifier is the slugified basename of the target dir.
  const basename = dir.replace(/[/\\]+$/, '').split(/[/\\]/).pop() ?? dir;
  return {
    command: 'create-agent',
    dir,
    identifier: identifier ? slugify(identifier) : slugify(basename),
  };
}
