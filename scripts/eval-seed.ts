/**
 * Eval seed — provisions the CI eval gate's tenant + fixture agent.
 *
 *   npm run eval:seed
 *
 * Reads `evals/agents/support-demo.agent.json` (the versioned fixture) and
 * creates, on a blank or already-seeded install:
 *
 *   1. a dedicated CI tenant (its own environment + api key),
 *   2. the workflows the fixture's prompt names,
 *   3. the fixture agent (managed runtime, prompt verbatim, LLM creds from env),
 *   4. the fixture's custom tools, pointed at the repo-resident demo backend.
 *
 * Then it prints the tenant's api key so the next CI step can export it as
 * ASYNCIFY_API_KEY for `npm run eval`.
 *
 * ## Everything goes through the real API
 *
 * There are ZERO direct database writes here. The tenant is born the same way a
 * real signup is born (POST /auth/signup), and every later object is created
 * with the same endpoints the dashboard calls. That is deliberate: if a route
 * regresses, the seed fails and the gate goes red — which is the whole point of
 * a gate. It also means this script needs no DATABASE_URL.
 *
 * ## Idempotency
 *
 * Safe to re-run against the same install:
 *   - signup 409 (email taken) -> log in and mint a fresh api key on the same
 *     environment (the "re-key" pattern from scripts/agent-demo.ts);
 *   - PUT /v1/workflows is an upsert by key;
 *   - agent create 409 -> PATCH the mutable fields;
 *   - tool create 409 -> look the tool up by name and PATCH it.
 * A second run therefore converges the install onto the fixture rather than
 * erroring or duplicating.
 *
 * ## Env contract
 *
 *   ASYNCIFY_API_URL    default http://localhost:3000 — the API to seed
 *   EVAL_LLM_API_KEY    REQUIRED — LLM key stored on the agent (never logged)
 *   EVAL_LLM_BASE_URL   optional — Anthropic-compatible base URL (z.ai style);
 *                       omitted leaves the agent on the platform default
 *   EVAL_LLM_MODEL      default: the fixture's `model`
 *   ACME_TOOLS_URL      default http://localhost:4400 — substituted into every
 *                       fixture tool's ${ACME_TOOLS_URL} endpoint template
 *   EVAL_SEED_EMAIL     default ci-evals@asyncify.local — CI tenant's owner
 *   EVAL_SEED_PASSWORD  default (throwaway constant below)
 *   EVAL_SEED_ORG       default "Asyncify CI"
 *
 * No secret is ever written into the fixture file; creds only travel from env
 * to the API. The LLM key is NOT verified at save time — the API stores it
 * sealed (agents.llm_credentials) and the first real call happens at turn time
 * in buildManagedClient. So a bogus EVAL_LLM_API_KEY seeds "successfully" and
 * only fails when scenarios actually run.
 *
 * ## SSRF and localhost tool URLs
 *
 * Tool endpoints are SSRF-checked on write (src/core/safe-url.ts, called from
 * the agent-tools route) and again at connect time via a DNS-guarded
 * dispatcher. `localhost` is in the blocked-host list, so http://localhost:4400
 * is rejected with 400 "endpointUrl: localhost points at internal
 * infrastructure" UNLESS the hostname is allowlisted.
 *
 * The allowance is env-only and lives on the API SERVER's process, not this
 * script's: OUTBOUND_URL_ALLOW, a comma-separated list of EXACT hostnames
 * (suffixes are not matched, and 127.0.0.1 must be listed separately). There is
 * no NODE_ENV branch — 'test', 'production' and unset behave identically, so CI
 * gets exactly the local behaviour as long as it exports the same var. The repo
 * already ships that expectation: .env.example uses
 * `localhost,127.0.0.1,host.docker.internal` and tests/setup.ts uses
 * `localhost,127.0.0.1`. CI must start the API with OUTBOUND_URL_ALLOW
 * including `localhost`; this script fails loudly with that hint if a tool
 * write is rejected for it.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

const API_URL = (process.env.ASYNCIFY_API_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
const ACME_TOOLS_URL = (process.env.ACME_TOOLS_URL ?? 'http://localhost:4400').replace(/\/+$/, '');
const SEED_EMAIL = process.env.EVAL_SEED_EMAIL ?? 'ci-evals@asyncify.local';
/** Throwaway credential for a throwaway CI tenant; override in any shared install. */
const SEED_PASSWORD = process.env.EVAL_SEED_PASSWORD ?? 'ci-evals-local-only';
const SEED_ORG = process.env.EVAL_SEED_ORG ?? 'Asyncify CI';
/** The seed provisions the Development environment of the CI organization. */
const SEED_ENV_NAME = 'Development';

const FIXTURE_PATH = fileURLToPath(
  new URL('../evals/agents/support-demo.agent.json', import.meta.url),
);

// ---------------------------------------------------------------------------
// Fixture
// ---------------------------------------------------------------------------

/**
 * Mirrors what the fixture file is allowed to say. `_comment` blocks are
 * documentation for humans, so they are accepted and ignored; unknown keys are
 * stripped rather than rejected so a future field can land in the fixture
 * before the seed learns to use it.
 */
const FixtureSchema = z.object({
  identifier: z.string().min(1),
  name: z.string().min(1),
  description: z.string().optional(),
  runtime: z.literal('managed'),
  model: z.string().min(1),
  systemPrompt: z.string().min(1),
  context: z.object({ triggerTurns: z.number().int(), tailTurns: z.number().int() }).optional(),
  welcomeMessage: z.string().nullable().optional(),
  suggestedPrompts: z.array(z.object({ title: z.string(), message: z.string() })).optional(),
  workflows: z
    .array(
      z.object({
        key: z.string().min(1),
        name: z.string().min(1),
        steps: z.array(z.record(z.unknown())).min(1),
      }),
    )
    .default([]),
  tools: z
    .array(
      z.object({
        name: z.string().min(1),
        description: z.string().min(1),
        parameters: z.record(z.unknown()),
        endpointUrl: z.string().min(1),
        approval: z.enum(['auto', 'required']).default('auto'),
        timeoutMs: z.number().int().optional(),
        guard: z.record(z.unknown()).nullable().optional(),
      }),
    )
    .default([]),
});

type Fixture = z.infer<typeof FixtureSchema>;

function loadFixture(): Fixture {
  const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as unknown;
  const parsed = FixtureSchema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(
      `fixture ${FIXTURE_PATH} is invalid:\n${JSON.stringify(parsed.error.issues, null, 2)}`,
    );
  }
  return parsed.data;
}

/** `${ACME_TOOLS_URL}/refund` -> `http://localhost:4400/refund`. */
function resolveEndpoint(template: string): string {
  const url = template.replaceAll('${ACME_TOOLS_URL}', ACME_TOOLS_URL);
  if (url.includes('${')) {
    throw new Error(`tool endpointUrl has an unresolved template: ${url}`);
  }
  return url;
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

type Res = { status: number; json: Record<string, unknown> };

async function call(
  method: string,
  path: string,
  opts: { body?: unknown; apiKey?: string; bearer?: string } = {},
): Promise<Res> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.apiKey) headers['x-api-key'] = opts.apiKey;
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`;
  const res = await fetch(`${API_URL}${path}`, {
    method,
    headers,
    body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { status: res.status, json };
}

function fail(what: string, res: Res): never {
  throw new Error(`${what}: HTTP ${res.status} ${JSON.stringify(res.json)}`);
}

/** Human-readable progress goes to stderr; stdout carries only machine lines. */
function log(msg: string): void {
  process.stderr.write(`[eval-seed] ${msg}\n`);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

type Environment = { id: string; name: string; apiKey?: string };

/**
 * Births the CI tenant through the signup route a real user goes through.
 * On a re-run the email already exists (409), so we log in and mint a fresh key
 * on the same environment instead — the tenant is reused, never duplicated.
 */
async function ensureTenant(): Promise<{ tenantId: string; apiKey: string; created: boolean }> {
  const signup = await call('POST', '/auth/signup', {
    body: {
      name: 'Asyncify CI',
      email: SEED_EMAIL,
      password: SEED_PASSWORD,
      organizationName: SEED_ORG,
    },
  });

  if (signup.status === 201) {
    const envs = signup.json.environments as Environment[];
    const env = envs.find((e) => e.name === SEED_ENV_NAME) ?? envs[0];
    if (!env?.apiKey) fail('signup returned no api key', signup);
    log(`created CI tenant ${env.id} (${SEED_ENV_NAME}) for ${SEED_EMAIL}`);
    return { tenantId: env.id, apiKey: env.apiKey, created: true };
  }

  if (signup.status !== 409) fail('signup failed', signup);

  log(`${SEED_EMAIL} already exists — logging in and re-keying`);
  const login = await call('POST', '/auth/login', {
    body: { email: SEED_EMAIL, password: SEED_PASSWORD },
  });
  if (login.status !== 200) {
    fail(
      `login failed for the existing ${SEED_EMAIL} (set EVAL_SEED_PASSWORD, or use a different EVAL_SEED_EMAIL)`,
      login,
    );
  }

  const orgs = login.json.organizations as Array<{ name: string; environments: Environment[] }>;
  const org = orgs.find((o) => o.name === SEED_ORG) ?? orgs[0];
  const env = org?.environments.find((e) => e.name === SEED_ENV_NAME) ?? org?.environments[0];
  if (!env) throw new Error(`user ${SEED_EMAIL} has no environment to seed`);

  const bearer = login.json.accessToken as string;
  const minted = await call('POST', `/v1/account/environments/${env.id}/api-keys`, {
    bearer,
    body: { name: 'eval-seed' },
  });
  if (minted.status !== 201) fail('could not mint an api key', minted);

  log(`reusing CI tenant ${env.id} with a fresh api key`);
  return { tenantId: env.id, apiKey: minted.json.apiKey as string, created: false };
}

/**
 * The fixture's prompt names workflows by key, and the managed brain only
 * offers `trigger_workflow` when the tenant has at least one — with the keys as
 * an enum. No workflow, no tool, and the order-flow scenarios can never pass.
 * PUT is an upsert, so this is naturally idempotent.
 */
async function ensureWorkflows(fixture: Fixture, apiKey: string): Promise<void> {
  for (const wf of fixture.workflows) {
    const res = await call('PUT', '/v1/workflows', { apiKey, body: wf });
    if (res.status !== 200) fail(`could not upsert workflow "${wf.key}"`, res);
    log(`workflow "${wf.key}" ready`);
  }
}

function agentBody(fixture: Fixture, forCreate: boolean) {
  const llmKey = process.env.EVAL_LLM_API_KEY as string;
  const baseUrl = process.env.EVAL_LLM_BASE_URL;
  return {
    ...(forCreate ? { identifier: fixture.identifier } : {}),
    name: fixture.name,
    description: fixture.description,
    runtime: 'managed' as const,
    model: process.env.EVAL_LLM_MODEL ?? fixture.model,
    systemPrompt: fixture.systemPrompt,
    ...(fixture.context ? { context: fixture.context } : {}),
    ...(fixture.welcomeMessage === undefined ? {} : { welcomeMessage: fixture.welcomeMessage }),
    ...(fixture.suggestedPrompts ? { suggestedPrompts: fixture.suggestedPrompts } : {}),
    // The API stores this sealed and never echoes it back; it is not validated
    // until a turn actually runs.
    llm: { apiKey: llmKey, ...(baseUrl ? { baseUrl } : {}) },
  };
}

async function ensureAgent(fixture: Fixture, apiKey: string): Promise<void> {
  const created = await call('POST', '/v1/agents', {
    apiKey,
    body: agentBody(fixture, true),
  });
  if (created.status === 201) {
    log(`created agent "${fixture.identifier}"`);
    return;
  }
  if (created.status !== 409) fail(`could not create agent "${fixture.identifier}"`, created);

  // Re-run: converge the existing agent onto the fixture. `identifier` is not
  // patchable, everything else is — including a prompt edited in this commit.
  const patched = await call('PATCH', `/v1/agents/${fixture.identifier}`, {
    apiKey,
    body: agentBody(fixture, false),
  });
  if (patched.status !== 200) fail(`could not update agent "${fixture.identifier}"`, patched);
  log(`agent "${fixture.identifier}" already existed — updated to match the fixture`);
}

async function ensureTools(fixture: Fixture, apiKey: string): Promise<void> {
  const base = `/v1/agents/${fixture.identifier}/tools`;
  for (const tool of fixture.tools) {
    const body = {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
      endpointUrl: resolveEndpoint(tool.endpointUrl),
      approval: tool.approval,
      ...(tool.timeoutMs === undefined ? {} : { timeoutMs: tool.timeoutMs }),
      ...(tool.guard === undefined ? {} : { guard: tool.guard }),
    };

    const created = await call('POST', base, { apiKey, body });
    if (created.status === 201) {
      log(`registered tool "${tool.name}" -> ${body.endpointUrl}`);
      continue;
    }
    if (created.status === 400 && String(created.json.error ?? '').includes('internal infrastructure')) {
      throw new Error(
        `tool "${tool.name}" endpoint ${body.endpointUrl} was refused by the SSRF guard.\n` +
          `Start the API with OUTBOUND_URL_ALLOW including this hostname, e.g.\n` +
          `  OUTBOUND_URL_ALLOW=localhost,127.0.0.1`,
      );
    }
    if (created.status !== 409) fail(`could not register tool "${tool.name}"`, created);

    // Names are immutable and unique per agent, so a 409 means "it is already
    // there" — find its id and patch the mutable fields onto it.
    const listed = await call('GET', base, { apiKey });
    if (listed.status !== 200) fail(`could not list tools for "${fixture.identifier}"`, listed);
    const existing = (listed.json.tools as Array<{ id: string; name: string }>).find(
      (t) => t.name === tool.name,
    );
    if (!existing) fail(`tool "${tool.name}" reported 409 but is not in the list`, listed);

    const { name: _ignored, ...patchable } = body;
    const patched = await call('PATCH', `${base}/${existing.id}`, {
      apiKey,
      body: { ...patchable, status: 'active' },
    });
    if (patched.status !== 200) fail(`could not update tool "${tool.name}"`, patched);
    log(`tool "${tool.name}" already existed — updated to match the fixture`);
  }
}

/**
 * Reads the seeded state back through the API and proves it matches the file.
 * The prompt check is byte-for-byte: a prompt that round-trips through the DB
 * with so much as a changed newline is a different thing under test.
 */
async function verify(fixture: Fixture, apiKey: string): Promise<void> {
  const got = await call('GET', `/v1/agents/${fixture.identifier}`, { apiKey });
  if (got.status !== 200) fail(`agent "${fixture.identifier}" is not readable back`, got);
  const agent = got.json.agent as Record<string, unknown>;

  const seeded = Buffer.from(String(agent.systemPrompt), 'utf8');
  const wanted = Buffer.from(fixture.systemPrompt, 'utf8');
  if (Buffer.compare(seeded, wanted) !== 0) {
    throw new Error(
      `seeded system prompt differs from the fixture (${seeded.length} vs ${wanted.length} bytes)`,
    );
  }
  if (agent.runtime !== 'managed') throw new Error(`agent runtime is ${String(agent.runtime)}`);
  if (agent.hasLlmKey !== true) throw new Error('agent has no LLM key stored');

  const expectedModel = process.env.EVAL_LLM_MODEL ?? fixture.model;
  if (agent.model !== expectedModel) {
    throw new Error(`agent model is ${String(agent.model)}, expected ${expectedModel}`);
  }

  const listed = await call('GET', `/v1/agents/${fixture.identifier}/tools`, { apiKey });
  if (listed.status !== 200) fail('could not list tools', listed);
  const names = new Set((listed.json.tools as Array<{ name: string }>).map((t) => t.name));
  for (const tool of fixture.tools) {
    if (!names.has(tool.name)) throw new Error(`tool "${tool.name}" is missing after seeding`);
  }

  const workflows = await call('GET', '/v1/workflows', { apiKey });
  if (workflows.status !== 200) fail('could not list workflows', workflows);
  const keys = new Set((workflows.json.workflows as Array<{ key: string }>).map((w) => w.key));
  for (const wf of fixture.workflows) {
    if (!keys.has(wf.key)) throw new Error(`workflow "${wf.key}" is missing after seeding`);
  }

  log(
    `verified: prompt ${wanted.length}B identical, model ${expectedModel}, ` +
      `${fixture.tools.length} tool(s), ${fixture.workflows.length} workflow(s)`,
  );
}

// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  if (!process.env.EVAL_LLM_API_KEY) {
    throw new Error(
      'EVAL_LLM_API_KEY is required — the fixture agent is a managed runtime and the ' +
        'API refuses a managed agent without an LLM key.',
    );
  }

  const fixture = loadFixture();
  log(`seeding "${fixture.identifier}" into ${API_URL}`);

  const { tenantId, apiKey } = await ensureTenant();
  await ensureWorkflows(fixture, apiKey);
  await ensureAgent(fixture, apiKey);
  await ensureTools(fixture, apiKey);
  await verify(fixture, apiKey);

  // Machine-readable block — CI exports these for the eval step.
  process.stdout.write(`ASYNCIFY_API_KEY=${apiKey}\n`);
  process.stdout.write(`ASYNCIFY_EVAL_TENANT_ID=${tenantId}\n`);
  process.stdout.write(`ASYNCIFY_EVAL_AGENT=${fixture.identifier}\n`);
}

main().catch((err: unknown) => {
  process.stderr.write(`[eval-seed] FAILED: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
