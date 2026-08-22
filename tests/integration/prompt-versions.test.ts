/**
 * Phase A5 slice A — PROMPT VERSIONING: every managed prompt/model save mints
 * an immutable, restorable snapshot (the template-versioning pattern applied to
 * an agent's brain).
 *
 * Real app in-process, real Postgres. No LLM and no worker: versioning is a
 * property of the SAVE, so the whole surface under test is the agents API plus
 * the rows behind it. The properties:
 *   1. a managed agent is born at version 1 (its birth prompt is history);
 *   2. a prompt edit mints the next version and the OLD snapshot is untouched;
 *   3. a save that changes something else mints NOTHING (no version churn);
 *   4. restore is a SAVE — it copies an old snapshot forward as a NEW version
 *      and updates the live agent row; it never rewrites or deletes history;
 *   5. an agent that predates versioning has its pre-edit prompt seeded as v1
 *      on its first edit, so the original is never lost;
 *   6. bridge agents have no prompt to version: no rows, 400 on all three routes.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';

const P1 = 'You are v1. Quote the 14-day return window.';
const P2 = 'You are v2. Quote the 30-day return window.';
const M1 = 'model-one';
const M2 = 'model-two';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';

const json = (res: { body: string }) => JSON.parse(res.body);

function headers() {
  return { 'x-api-key': apiKey };
}

async function createAgent(payload: Record<string, unknown>) {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: headers(),
    payload,
  });
  expect(res.statusCode, res.body).toBe(201);
  return json(res).agent;
}

async function createManaged(identifier: string, extra: Record<string, unknown> = {}) {
  return createAgent({
    identifier,
    name: identifier,
    runtime: 'managed',
    systemPrompt: P1,
    model: M1,
    llm: { apiKey: 'zai-test-key-123456' },
    ...extra,
  });
}

async function patchAgent(identifier: string, payload: Record<string, unknown>) {
  const res = await app.inject({
    method: 'PATCH',
    url: `/v1/agents/${identifier}`,
    headers: headers(),
    payload,
  });
  return { status: res.statusCode, body: json(res) };
}

interface VersionSummary {
  version: number;
  model: string | null;
  promptLength: number;
  promptHead: string;
  current: boolean;
  createdAt: string;
}

async function listVersions(identifier: string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/agents/${identifier}/versions`,
    headers: headers(),
  });
  return {
    status: res.statusCode,
    body: json(res) as { currentVersion: number; versions: VersionSummary[] },
  };
}

async function getVersion(identifier: string, version: number | string) {
  const res = await app.inject({
    method: 'GET',
    url: `/v1/agents/${identifier}/versions/${version}`,
    headers: headers(),
  });
  return { status: res.statusCode, body: json(res) };
}

async function restore(identifier: string, version: number | string) {
  const res = await app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/versions/${version}/restore`,
    headers: headers(),
  });
  return { status: res.statusCode, body: json(res) };
}

/** The live row, straight from the DB — agentView can't lie about it. */
async function agentRow(identifier: string) {
  const { rows } = await pool.query(
    'select id, prompt_version, system_prompt, model from agents where tenant_id = $1 and identifier = $2',
    [tenantId, identifier],
  );
  return rows[0] as {
    id: string;
    prompt_version: number;
    system_prompt: string | null;
    model: string | null;
  };
}

async function versionRowCount(agentId: string): Promise<number> {
  const { rows } = await pool.query(
    'select count(*)::int as n from agent_prompt_versions where agent_id = $1',
    [agentId],
  );
  return rows[0].n;
}

beforeAll(async () => {
  app = await buildApp();
  const email = `ver-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Versions IT',
      email,
      password: 'integration-pw-1',
      organizationName: 'Versions IT Org',
    },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;
});

afterAll(async () => {
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('A5 prompt versioning: every save is history, restore is a new save', () => {
  test('a managed agent is born at version 1', async () => {
    const agent = await createManaged('ver-main');
    expect(agent.promptVersion).toBe(1);

    const { status, body } = await listVersions('ver-main');
    expect(status).toBe(200);
    expect(body.currentVersion).toBe(1);
    expect(body.versions).toHaveLength(1);
    expect(body.versions[0]).toMatchObject({
      version: 1,
      model: M1,
      promptLength: P1.length,
      current: true,
    });
    // Lists stay light: a head, never the whole prompt.
    expect(body.versions[0].promptHead).toBe(P1);
    expect(body.versions[0]).not.toHaveProperty('systemPrompt');

    expect(await agentRow('ver-main')).toMatchObject({
      prompt_version: 1,
      system_prompt: P1,
      model: M1,
    });
  });

  test('editing the prompt mints v2 and leaves v1 exactly as it was', async () => {
    const { status, body } = await patchAgent('ver-main', { systemPrompt: P2 });
    expect(status).toBe(200);
    expect(body.agent.promptVersion).toBe(2);

    expect(await agentRow('ver-main')).toMatchObject({
      prompt_version: 2,
      system_prompt: P2,
      model: M1,
    });

    const list = await listVersions('ver-main');
    expect(list.body.currentVersion).toBe(2);
    // Newest first.
    expect(list.body.versions.map((v) => v.version)).toEqual([2, 1]);
    expect(list.body.versions.find((v) => v.current)?.version).toBe(2);

    // The old snapshot is IMMUTABLE — the edit did not reach backwards.
    const v1 = await getVersion('ver-main', 1);
    expect(v1.status).toBe(200);
    expect(v1.body.version).toMatchObject({
      version: 1,
      systemPrompt: P1,
      model: M1,
      current: false,
    });

    const v2 = await getVersion('ver-main', 2);
    expect(v2.body.version).toMatchObject({ version: 2, systemPrompt: P2, model: M1, current: true });
  });

  test('a save that touches neither prompt nor model mints nothing', async () => {
    const before = await listVersions('ver-main');

    const renamed = await patchAgent('ver-main', { name: 'Renamed Agent', description: 'x' });
    expect(renamed.status).toBe(200);
    expect(renamed.body.agent.name).toBe('Renamed Agent');
    expect(renamed.body.agent.promptVersion).toBe(2);

    // Re-sending the SAME prompt is also not a change — the trigger is the
    // outcome, not the request body.
    const resent = await patchAgent('ver-main', { systemPrompt: P2, model: M1 });
    expect(resent.status).toBe(200);
    expect(resent.body.agent.promptVersion).toBe(2);

    const after = await listVersions('ver-main');
    expect(after.body.versions).toHaveLength(before.body.versions.length);
    expect(after.body.currentVersion).toBe(2);
  });

  test('restoring v1 is a NEW save: v3 carries v1 content and goes live', async () => {
    const res = await restore('ver-main', 1);
    expect(res.status).toBe(200);
    expect(res.body.restoredFrom).toBe(1);
    expect(res.body.version).toBe(3);
    expect(res.body.agent.systemPrompt).toBe(P1);
    expect(res.body.agent.promptVersion).toBe(3);

    // The live row moved back to v1's content under a NEW version number.
    expect(await agentRow('ver-main')).toMatchObject({
      prompt_version: 3,
      system_prompt: P1,
      model: M1,
    });

    // History never rewrites: v2 still exists, untouched, and v3 is a copy.
    const list = await listVersions('ver-main');
    expect(list.body.versions.map((v) => v.version)).toEqual([3, 2, 1]);
    expect((await getVersion('ver-main', 2)).body.version.systemPrompt).toBe(P2);
    expect((await getVersion('ver-main', 3)).body.version).toMatchObject({
      systemPrompt: P1,
      model: M1,
      current: true,
    });
  });

  test('a model-only change is a version too (the brain changed)', async () => {
    const res = await patchAgent('ver-main', { model: M2 });
    expect(res.status).toBe(200);
    expect(res.body.agent.promptVersion).toBe(4);

    const v4 = await getVersion('ver-main', 4);
    expect(v4.body.version).toMatchObject({ model: M2, systemPrompt: P1 });
  });

  test('unknown versions 404, malformed ones never coerce', async () => {
    expect((await getVersion('ver-main', 999)).status).toBe(404);
    expect((await getVersion('ver-main', 'abc')).status).toBe(404);
    expect((await getVersion('ver-main', 0)).status).toBe(404);
    expect((await restore('ver-main', 999)).status).toBe(404);

    const unknownAgent = await app.inject({
      method: 'GET',
      url: '/v1/agents/ver-nope/versions',
      headers: headers(),
    });
    expect(unknownAgent.statusCode).toBe(404);
  });

  test('restoring a snapshot that had no model clears the model back to default', async () => {
    // Born WITHOUT a model (the platform default applies at turn time).
    const agent = await createManaged('ver-nomodel', { model: undefined });
    expect(agent.model).toBeNull();

    await patchAgent('ver-nomodel', { model: M2 });
    expect(await agentRow('ver-nomodel')).toMatchObject({ prompt_version: 2, model: M2 });

    // Restoring v1 must reproduce v1 EXACTLY — including the absence of a model.
    const res = await restore('ver-nomodel', 1);
    expect(res.status).toBe(200);
    expect(res.body.version).toBe(3);
    expect(res.body.agent.model).toBeNull();
    expect(await agentRow('ver-nomodel')).toMatchObject({ prompt_version: 3, model: null });
  });

  test('an agent that predates versioning seeds v1 from its pre-edit prompt', async () => {
    const agent = await createManaged('ver-legacy');
    const row = await agentRow('ver-legacy');

    // Simulate a row created BEFORE this slice: the API has no way to make a
    // managed agent without a v1 (that is the point of the create-path
    // snapshot), so the legacy state is reproduced directly — delete the
    // version rows and reset the counter to the column default.
    await pool.query('delete from agent_prompt_versions where agent_id = $1', [row.id]);
    await pool.query('update agents set prompt_version = 1 where id = $1', [row.id]);
    expect(await versionRowCount(row.id)).toBe(0);
    expect(agent.promptVersion).toBe(1);

    // The first edit must not crash, and must not swallow the original prompt.
    const edited = await patchAgent('ver-legacy', { systemPrompt: P2 });
    expect(edited.status).toBe(200);
    expect(edited.body.agent.promptVersion).toBe(2);

    const list = await listVersions('ver-legacy');
    expect(list.body.versions.map((v) => v.version)).toEqual([2, 1]);
    // v1 is the prompt the agent HAD before the edit — recovered, not invented.
    expect((await getVersion('ver-legacy', 1)).body.version).toMatchObject({
      systemPrompt: P1,
      model: M1,
    });
    expect((await getVersion('ver-legacy', 2)).body.version.systemPrompt).toBe(P2);
  });

  test('bridge agents have no prompt to version: no rows, 400 on every route', async () => {
    await createAgent({
      identifier: 'ver-bridge',
      name: 'ver-bridge',
      runtime: 'bridge',
      bridgeUrl: 'http://localhost:4599/',
    });
    const row = await agentRow('ver-bridge');
    expect(await versionRowCount(row.id)).toBe(0);

    // A bridge save cannot mint one either.
    const patched = await patchAgent('ver-bridge', { name: 'ver-bridge renamed' });
    expect(patched.status).toBe(200);
    expect(await versionRowCount(row.id)).toBe(0);

    for (const res of [
      await listVersions('ver-bridge'),
      await getVersion('ver-bridge', 1),
      await restore('ver-bridge', 1),
    ]) {
      expect(res.status).toBe(400);
      expect(String(res.body.error)).toContain('managed');
    }
  });
});
