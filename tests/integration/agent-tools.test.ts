/**
 * Phase 18 agent-tools CRUD + the human-in-the-loop approval queue API, driven
 * through the real Fastify app in-process. This file is the API surface only —
 * the execution/pause lifecycle lives in tool-execution.test.ts. Pending rows
 * here are fabricated directly (a real conversation + agent), since the CREATE
 * side of the queue is the worker's job, not the approvals module's.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import type { Job } from 'bullmq';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues, getQueue, QUEUE } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let agentId = '';
let toolId = '';
let createSecret = '';

const json = (res: { body: string }) => JSON.parse(res.body);

function createTool(identifier: string, body: Record<string, unknown>) {
  return app.inject({
    method: 'POST',
    url: `/v1/agents/${identifier}/tools`,
    headers: { 'x-api-key': apiKey },
    payload: body,
  });
}

const validTool = (overrides: Record<string, unknown> = {}) => ({
  name: 'refund_order',
  description: 'Issue a refund for an order',
  parameters: { type: 'object', properties: { orderId: { type: 'string' } } },
  endpointUrl: 'http://localhost:5599/refund',
  ...overrides,
});

/** Fabricate a pending approval row against a real conversation + agent. */
async function insertPendingCall(
  conversationId: string,
  toolName: string,
  args: Record<string, unknown>,
  dedupeKey: string,
): Promise<{ id: string }> {
  const { rows } = await pool.query(
    `insert into agent_tool_calls
       (tenant_id, agent_id, conversation_id, tool_def_id, tool_name, args,
        dedupe_key, status, expires_at)
     values ($1,$2,$3,$4,$5,$6,$7,'pending', now() + interval '24 hours')
     returning id`,
    [tenantId, agentId, conversationId, toolId, toolName, JSON.stringify(args), dedupeKey],
  );
  return rows[0];
}

async function openConversation(subscriberId: string, messageId: string): Promise<string> {
  const res = await app.inject({
    method: 'POST',
    url: '/v1/agents/tools-agent/messages',
    headers: { 'x-api-key': apiKey },
    payload: { subscriberId, text: 'hi', messageId },
  });
  expect(res.statusCode).toBe(202);
  return json(res).conversationId as string;
}

beforeAll(async () => {
  app = await buildApp();
  const email = `agent-tools-${Date.now()}-${Math.floor(Math.random() * 1e6)}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'Tools IT', email, password: 'integration-pw-1', organizationName: 'Tools IT Org' },
  });
  const dev = json(signup).environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;

  // A bridge agent to hang tools + a fabricated approval queue off of. The
  // tool routes resolve the agent but never gate on runtime, so bridge is fine.
  const create = await app.inject({
    method: 'POST',
    url: '/v1/agents',
    headers: { 'x-api-key': apiKey },
    payload: { identifier: 'tools-agent', name: 'Tools Agent', bridgeUrl: 'http://localhost:59999/' },
  });
  expect(create.statusCode).toBe(201);
  const { rows } = await pool.query('select id from agents where tenant_id = $1 and identifier = $2', [
    tenantId,
    'tools-agent',
  ]);
  agentId = rows[0].id;
});

afterAll(async () => {
  // Hygiene: drop this tenant's tool defs/calls, conversations, subscribers,
  // events, and the txn dedupe keys the approval jobs left in Redis db 15.
  try {
    await pool.query('delete from agent_tool_calls where tenant_id = $1', [tenantId]);
    await pool.query('delete from agent_tool_defs where tenant_id = $1', [tenantId]);
    await pool.query('delete from conversations where tenant_id = $1', [tenantId]);
    await pool.query('delete from events where tenant_id = $1', [tenantId]);
    await pool.query('delete from subscribers where tenant_id = $1', [tenantId]);
    const keys = await redis.keys(`txn:${tenantId}:*`);
    if (keys.length > 0) await redis.del(...keys);
  } catch {
    /* best-effort cleanup */
  }
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('tool CRUD', () => {
  test('create returns the plaintext secret exactly once (ats_ prefix); the view carries no secret', async () => {
    const res = await createTool('tools-agent', validTool());
    expect(res.statusCode).toBe(201);
    const body = json(res);
    expect(body.secret).toMatch(/^ats_[A-Za-z0-9_-]+$/);
    createSecret = body.secret;
    toolId = body.tool.id;

    // The tool view never carries a secret field, sealed or plaintext.
    expect(body.tool.secret).toBeUndefined();
    expect(body.tool.name).toBe('refund_order');
    expect(body.tool.approval).toBe('auto'); // default
    expect(body.tool.timeoutMs).toBe(10000); // default
    expect(body.tool.status).toBe('active');
  });

  test('unknown agent → 404', async () => {
    const res = await createTool('no-such-agent', validTool({ name: 'x_tool' }));
    expect(res.statusCode).toBe(404);
  });

  test('400: name failing ^[a-z][a-z0-9_]{0,63}$', async () => {
    for (const name of ['Refund', '1refund', 'refund-order', 'refund order', '', 'a'.repeat(65), '_refund']) {
      const res = await createTool('tools-agent', validTool({ name }));
      expect(res.statusCode, name).toBe(400);
    }
  });

  test('400: a reserved built-in name', async () => {
    for (const name of [
      'trigger_workflow',
      'set_metadata',
      'resolve_conversation',
      'present_choices',
      'present_buttons',
      'request_input',
    ]) {
      const res = await createTool('tools-agent', validTool({ name }));
      expect(res.statusCode, name).toBe(400);
      expect(json(res).error).toContain('reserved');
    }
  });

  test('400: parameters that are not a JSON Schema object', async () => {
    // A well-formed record that is not type:"object".
    const wrongType = await createTool('tools-agent', validTool({ name: 'p_type', parameters: { type: 'string' } }));
    expect(wrongType.statusCode).toBe(400);
    expect(json(wrongType).error).toContain('type "object"');

    // Not an object at all (fails the Zod record gate first).
    const notObject = await createTool('tools-agent', validTool({ name: 'p_arr', parameters: ['nope'] }));
    expect(notObject.statusCode).toBe(400);
  });

  test('400: an SSRF-unsafe endpoint (cloud metadata IP)', async () => {
    const res = await createTool(
      'tools-agent',
      validTool({ name: 'ssrf_tool', endpointUrl: 'http://169.254.169.254/latest/meta-data/' }),
    );
    expect(res.statusCode).toBe(400);
    expect(json(res).error).toContain('endpointUrl');
  });

  test('400: timeoutMs outside [1000, 30000]', async () => {
    for (const timeoutMs of [999, 30001, 0, -1]) {
      const res = await createTool('tools-agent', validTool({ name: 'to_tool', timeoutMs }));
      expect(res.statusCode, String(timeoutMs)).toBe(400);
    }
  });

  test('409: a duplicate name on the same agent', async () => {
    const res = await createTool('tools-agent', validTool()); // same name as the first create
    expect(res.statusCode).toBe(409);
  });

  test('GET list never leaks a secret (sweep the whole body)', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/agents/tools-agent/tools',
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    const body = json(res);
    expect(body.tools.some((t: { name: string }) => t.name === 'refund_order')).toBe(true);
    // No plaintext prefix, no sealed-secret field name, anywhere in the payload.
    expect(res.body).not.toContain('ats_');
    expect(res.body).not.toContain('"secret"');
  });

  test('PATCH flips approval + status; name is immutable (ignored, not an error)', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/tools-agent/tools/${toolId}`,
      headers: { 'x-api-key': apiKey },
      // name is not in the patch schema — Zod strips it, so this is a silent
      // no-op on identity, NOT a 400. (Pinned: implementation ignores it.)
      payload: { approval: 'required', status: 'disabled', name: 'renamed_tool' },
    });
    expect(res.statusCode).toBe(200);
    const view = json(res).tool;
    expect(view.approval).toBe('required');
    expect(view.status).toBe('disabled');
    expect(view.name).toBe('refund_order'); // unchanged

    // Restore active/auto for later reads (approval flip is exercised elsewhere).
    await app.inject({
      method: 'PATCH',
      url: `/v1/agents/tools-agent/tools/${toolId}`,
      headers: { 'x-api-key': apiKey },
      payload: { approval: 'auto', status: 'active' },
    });
  });

  test('rotate-secret returns a NEW ats_ secret, distinct from the create secret', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/agents/tools-agent/tools/${toolId}/rotate-secret`,
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    const rotated = json(res).secret;
    expect(rotated).toMatch(/^ats_[A-Za-z0-9_-]+$/);
    expect(rotated).not.toBe(createSecret);
  });

  test('DELETE removes the tool; a second DELETE/PATCH is 404', async () => {
    // A disposable tool so the shared `toolId` (used by the approval queue
    // fabrication below) survives.
    const created = json(await createTool('tools-agent', validTool({ name: 'temp_tool' })));
    const tempId = created.tool.id;

    const del = await app.inject({
      method: 'DELETE',
      url: `/v1/agents/tools-agent/tools/${tempId}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(del.statusCode).toBe(200);
    expect(json(del).deleted).toBe(true);

    const list = await app.inject({
      method: 'GET',
      url: '/v1/agents/tools-agent/tools',
      headers: { 'x-api-key': apiKey },
    });
    expect(json(list).tools.some((t: { id: string }) => t.id === tempId)).toBe(false);

    const again = await app.inject({
      method: 'DELETE',
      url: `/v1/agents/tools-agent/tools/${tempId}`,
      headers: { 'x-api-key': apiKey },
    });
    expect(again.statusCode).toBe(404);

    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/agents/tools-agent/tools/${tempId}`,
      headers: { 'x-api-key': apiKey },
      payload: { status: 'disabled' },
    });
    expect(patch.statusCode).toBe(404);
  });
});

describe('the approval queue API', () => {
  let conversationId = '';
  let pendingId = '';

  test('a fabricated pending row surfaces in GET pending with its agentIdentifier joined', async () => {
    conversationId = await openConversation('appr-ana', 'appr-open-1');
    const call = await insertPendingCall(
      conversationId,
      'refund_order',
      { orderId: '#1042' },
      `tc-approval-a-${Date.now()}`,
    );
    pendingId = call.id;

    const res = await app.inject({
      method: 'GET',
      url: '/v1/approvals?status=pending',
      headers: { 'x-api-key': apiKey },
    });
    expect(res.statusCode).toBe(200);
    const mine = json(res).approvals.find((a: { id: string }) => a.id === pendingId);
    expect(mine).toBeTruthy();
    expect(mine.agentIdentifier).toBe('tools-agent');
    expect(mine.toolName).toBe('refund_order');
    expect(mine.args).toEqual({ orderId: '#1042' });
    expect(mine.conversationId).toBe(conversationId);
    expect(mine.status).toBe('pending');
  });

  test('approve → 200 and the frozen tool-decision job lands with an exact data shape', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${pendingId}/decision`,
      headers: { 'x-api-key': apiKey },
      payload: { decision: 'approve' },
    });
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ id: pendingId, status: 'approved' });

    const job = (await getQueue(QUEUE.CONVERSATION).getJob(`tool-decision-${pendingId}`)) as Job;
    expect(job, 'expected a queued tool-decision job').toBeTruthy();
    expect(job.data).toEqual({
      kind: 'tool-decision',
      tenantId,
      conversationId,
      toolCallId: pendingId,
    });
    expect(job.opts.attempts).toBe(5);
  });

  test('a second decision on the same row is 409 already-decided', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${pendingId}/decision`,
      headers: { 'x-api-key': apiKey },
      payload: { decision: 'deny' },
    });
    expect(res.statusCode).toBe(409);
    expect(json(res).error).toContain('already decided');
  });

  test('the decided list now carries the row with its new status', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/v1/approvals?status=decided',
      headers: { 'x-api-key': apiKey },
    });
    const mine = json(res).approvals.find((a: { id: string }) => a.id === pendingId);
    expect(mine).toBeTruthy();
    expect(mine.status).toBe('approved');
    // And it has left the pending list.
    const pending = await app.inject({
      method: 'GET',
      url: '/v1/approvals?status=pending',
      headers: { 'x-api-key': apiKey },
    });
    expect(json(pending).approvals.some((a: { id: string }) => a.id === pendingId)).toBe(false);
  });

  test('a note over 500 chars is rejected (row stays pending)', async () => {
    const call = await insertPendingCall(
      conversationId,
      'refund_order',
      { orderId: '#2' },
      `tc-approval-note-${Date.now()}`,
    );
    const tooLong = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${call.id}/decision`,
      headers: { 'x-api-key': apiKey },
      payload: { decision: 'deny', note: 'x'.repeat(501) },
    });
    expect(tooLong.statusCode).toBe(400);

    // Exactly 500 is accepted.
    const ok = await app.inject({
      method: 'POST',
      url: `/v1/approvals/${call.id}/decision`,
      headers: { 'x-api-key': apiKey },
      payload: { decision: 'deny', note: 'x'.repeat(500) },
    });
    expect(ok.statusCode).toBe(200);
    expect(json(ok).status).toBe('denied');
  });

  test('decision id validation: non-uuid → 400, unknown uuid → 404', async () => {
    const badId = await app.inject({
      method: 'POST',
      url: '/v1/approvals/not-a-uuid/decision',
      headers: { 'x-api-key': apiKey },
      payload: { decision: 'approve' },
    });
    expect(badId.statusCode).toBe(400);

    const unknown = await app.inject({
      method: 'POST',
      url: '/v1/approvals/00000000-0000-0000-0000-000000000000/decision',
      headers: { 'x-api-key': apiKey },
      payload: { decision: 'approve' },
    });
    expect(unknown.statusCode).toBe(404);
  });
});
