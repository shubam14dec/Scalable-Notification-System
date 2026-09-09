/**
 * Slice B1 — the beta gate's REQUEST side, end to end against the real app:
 * asking to be let in, the operator's queue, and the two decisions.
 *
 * Everything is real — real routes, real Postgres rows, real Redis budgets,
 * real per-IP brakes. The ONE seam is the outbound SMTP hop, swapped at
 * `setPlatformEmailSender`, so every assertion about an email is about the mail
 * a human would actually have received, including the invite link inside it.
 *
 * The suite runs in the DEFAULT open signup mode except where a test says
 * otherwise: the gate's read/decide surface exists in both modes, and pinning
 * it here proves that flipping SIGNUP_MODE changes the DOOR, not the queue.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { env } from '../../src/config/env';
import { pool } from '../../src/db/pool';
import { redis } from '../../src/shared/redis';
import { setPlatformEmailSender, type PlatformEmail } from '../../src/core/platform-email';

let app: FastifyInstance;
let restoreSender: () => void;

const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
const emailFor = (who: string) => `ar-${who}-${suffix}@itest.local`;

const OPERATOR_A = `ar-op-a-${suffix}@itest.local`;
const OPERATOR_B = `ar-op-b-${suffix}@itest.local`;
const OUTSIDER = `ar-outsider-${suffix}@itest.local`;

/**
 * Two operators on purpose — "notify EVERY address" is a rule, not a habit —
 * and the second one padded and shouted, because the seat is normalized where
 * it is read, not where it happens to be written.
 */
const OPERATOR_LIST = [OPERATOR_A, `  ${OPERATOR_B.toUpperCase()}  `];

const originalOperators = [...env.operatorEmails];
const originalSignupMode = env.signupMode;

const json = (res: { body: string }) => JSON.parse(res.body);

/** Every platform email the app tried to send, in order. */
const outbox: PlatformEmail[] = [];

let operatorToken = '';
let outsiderToken = '';

/** Reset one named per-IP budget — the whole file injects from one "IP". */
async function clearBrake(name: string): Promise<void> {
  const keys = await redis.keys(`${name}-rl:*`);
  if (keys.length) await redis.del(...keys);
}

async function signup(email: string, password = 'access-request-pw-1') {
  await clearBrake('signup');
  const res = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: { name: 'AR Tester', email, password, organizationName: `AR Org ${email}` },
  });
  expect(res.statusCode).toBe(201);
  return json(res);
}

const requestAccess = (payload: unknown) =>
  app.inject({ method: 'POST', url: '/auth/request-access', payload });

/** Ask, with the per-IP brake cleared first — the ADDRESS rules are the subject. */
async function ask(email: string, name = 'Ada Lovelace', useCase = 'transactional email') {
  await clearBrake('request-access');
  return requestAccess({ name, email, useCase });
}

const listRequests = (token: string, status?: string) =>
  app.inject({
    method: 'GET',
    url: `/v1/ops/access-requests${status === undefined ? '' : `?status=${status}`}`,
    headers: { authorization: `Bearer ${token}` },
  });

const approve = (token: string, id: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/ops/access-requests/${id}/approve`,
    headers: { authorization: `Bearer ${token}` },
  });

const decline = (token: string, id: string) =>
  app.inject({
    method: 'POST',
    url: `/v1/ops/access-requests/${id}/decline`,
    headers: { authorization: `Bearer ${token}` },
  });

async function rowFor(email: string) {
  const { rows } = await pool.query('select * from access_requests where email = $1', [
    email.toLowerCase(),
  ]);
  return rows[0] ?? null;
}

/** Ask + approve in one step; returns the row id and the emailed invite code. */
async function askAndApprove(email: string) {
  await ask(email);
  const id = (await rowFor(email)).id;
  outbox.length = 0;
  expect((await approve(operatorToken, id)).statusCode).toBe(200);
  const code = /[?&]invite=([0-9a-f]{64})/.exec(outbox[0]?.text ?? '')?.[1] ?? '';
  expect(code).toMatch(/^[0-9a-f]{64}$/);
  return { id, code };
}

// ---- lifecycle -------------------------------------------------------------

beforeAll(async () => {
  app = await buildApp();
  restoreSender = setPlatformEmailSender(async (message) => {
    outbox.push(message);
    return true;
  });

  // The two accounts every test authorizes as. Created BEFORE the operator seat
  // is configured, through the ordinary open-mode door.
  operatorToken = (await signup(OPERATOR_A)).accessToken;
  outsiderToken = (await signup(OUTSIDER)).accessToken;

  env.operatorEmails = [...OPERATOR_LIST];
});

beforeEach(async () => {
  const keys = await redis.keys('*-rl:*');
  if (keys.length) await redis.del(...keys);
  outbox.length = 0;
});

afterAll(async () => {
  restoreSender();
  env.operatorEmails = originalOperators;
  env.signupMode = originalSignupMode;

  for (const pattern of ['access-budget:*']) {
    const keys = await redis.keys(pattern);
    if (keys.length) await redis.del(...keys);
  }

  await pool.query('delete from access_requests where email like $1', [`ar-%-${suffix}@itest.local`]);

  const { rows: users } = await pool.query('select id from users where email like $1', [
    `ar-%-${suffix}@itest.local`,
  ]);
  const userIds = users.map((u: { id: string }) => u.id);
  if (userIds.length) {
    const { rows: orgs } = await pool.query(
      'select distinct organization_id as id from org_members where user_id = any($1::uuid[])',
      [userIds],
    );
    const orgIds = orgs.map((o: { id: string }) => o.id);
    if (orgIds.length) {
      await pool.query(
        'delete from api_keys where tenant_id in (select id from tenants where organization_id = any($1::uuid[]))',
        [orgIds],
      );
      await pool.query('delete from tenants where organization_id = any($1::uuid[])', [orgIds]);
    }
    await pool.query('delete from org_members where user_id = any($1::uuid[])', [userIds]);
    if (orgIds.length) {
      await pool.query('delete from organizations where id = any($1::uuid[])', [orgIds]);
    }
    await pool.query('delete from users where id = any($1::uuid[])', [userIds]);
  }

  await app.close();
  await redis.quit();
  await pool.end();
});

// ---- who is an operator ----------------------------------------------------

describe('/auth/me reports the operator seat', () => {
  const me = (token: string) =>
    app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });

  test('an address in OPERATOR_EMAILS reads operator: true', async () => {
    expect(json(await me(operatorToken)).operator).toBe(true);
  });

  test('any other account reads operator: false', async () => {
    expect(json(await me(outsiderToken)).operator).toBe(false);
  });

  test('an empty OPERATOR_EMAILS means nobody, including the first user', async () => {
    env.operatorEmails = [];
    try {
      expect(json(await me(operatorToken)).operator).toBe(false);
    } finally {
      env.operatorEmails = [...OPERATOR_LIST];
    }
  });
});

// ---- POST /auth/request-access ---------------------------------------------

describe('POST /auth/request-access — one answer, whatever it finds', () => {
  test('a first ask records it and emails EVERY operator exactly once', async () => {
    const email = emailFor('first');
    const res = await ask(email, 'Grace Hopper', 'agent replies on telegram');
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true });

    const row = await rowFor(email);
    expect(row.status).toBe('pending');
    expect(row.name).toBe('Grace Hopper');
    expect(row.use_case).toBe('agent replies on telegram');
    expect(row.invite_code_hash).toBeNull();
    expect(row.consumed_at).toBeNull();
    expect(row.decided_at).toBeNull();

    expect(outbox).toHaveLength(2);
    // Trimmed and lowercased out of the env list, not taken verbatim.
    expect(outbox.map((m) => m.to).sort()).toEqual([OPERATOR_A, OPERATOR_B].sort());
    for (const mail of outbox) {
      expect(mail.subject).toBe('Access request from Grace Hopper');
      expect(mail.text).toContain(email);
      expect(mail.text).toContain('agent replies on telegram');
      expect(mail.text).toContain('http://localhost:5173/requests');
    }
  });

  test('asking again while pending is a silent no-op — no second email', async () => {
    const email = emailFor('repeat');
    await ask(email);
    expect(outbox).toHaveLength(2);
    const first = await rowFor(email);

    outbox.length = 0;
    const res = await ask(email, 'Someone Else', 'a different story');
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true });
    expect(outbox).toHaveLength(0);

    // Untouched: the operator's list does not get rewritten by an impatient
    // applicant, and there is still exactly one row for the address.
    const after = await rowFor(email);
    expect(after.id).toBe(first.id);
    expect(after.name).toBe(first.name);
    expect(after.status).toBe('pending');
    const { rows } = await pool.query('select count(*)::int as n from access_requests where email = $1', [email]);
    expect(rows[0].n).toBe(1);
  });

  test('asking again after approval is a no-op too (the invite is already out)', async () => {
    const email = emailFor('after-approve');
    await askAndApprove(email);

    outbox.length = 0;
    expect((await ask(email)).statusCode).toBe(200);
    expect(outbox).toHaveLength(0);
    const row = await rowFor(email);
    expect(row.status).toBe('approved');
    expect(row.invite_code_hash).toBeTruthy(); // the live invite survived
  });

  test('a DECLINED address may ask again: back to pending, operators notified', async () => {
    const email = emailFor('reopen');
    await ask(email);
    const id = (await rowFor(email)).id;
    expect((await decline(operatorToken, id)).statusCode).toBe(200);
    expect((await rowFor(email)).status).toBe('declined');

    outbox.length = 0;
    expect((await ask(email, 'Ada Again', 'we got funding')).statusCode).toBe(200);

    const row = await rowFor(email);
    expect(row.id).toBe(id); // one row per mailbox, forever
    expect(row.status).toBe('pending');
    expect(row.name).toBe('Ada Again');
    expect(row.use_case).toBe('we got funding');
    expect(row.decided_at).toBeNull();
    expect(outbox).toHaveLength(2);
  });

  test('an address that already has an account gets the same 200 and nothing else', async () => {
    const res = await ask(OUTSIDER);
    expect(res.statusCode).toBe(200);
    expect(json(res)).toEqual({ ok: true });
    // No row, no email — "this address is registered" is not a fact this
    // endpoint hands to a stranger.
    expect(await rowFor(OUTSIDER)).toBeNull();
    expect(outbox).toHaveLength(0);
  });

  test('a malformed body is a 400 and records nothing', async () => {
    await clearBrake('request-access');
    const res = await requestAccess({ name: '', email: 'not-an-email', useCase: '' });
    expect(res.statusCode).toBe(400);
    expect(outbox).toHaveLength(0);
  });

  test('whitespace is trimmed and the address is stored lowercased', async () => {
    const email = emailFor('trimmed');
    await clearBrake('request-access');
    const res = await requestAccess({
      name: '  Ada  ',
      email: `  ${email.toUpperCase()}  `,
      useCase: '  digests  ',
    });
    expect(res.statusCode).toBe(200);
    const row = await rowFor(email);
    expect(row.email).toBe(email);
    expect(row.name).toBe('Ada');
    expect(row.use_case).toBe('digests');
  });
});

describe('POST /auth/request-access — the brakes', () => {
  test('the 4th ask for one address in an hour changes nothing (and still says 200)', async () => {
    const email = emailFor('bombed');

    // Three laps of ask -> decline, so each ask is one that WOULD notify.
    for (let i = 0; i < 3; i += 1) {
      outbox.length = 0;
      expect((await ask(email)).statusCode).toBe(200);
      expect(outbox).toHaveLength(2);
      const id = (await rowFor(email)).id;
      expect((await decline(operatorToken, id)).statusCode).toBe(200);
    }

    outbox.length = 0;
    const fourth = await ask(email);
    expect(fourth.statusCode).toBe(200);
    expect(json(fourth)).toEqual({ ok: true });
    expect(outbox).toHaveLength(0);
    // Over budget = nothing happened at all: still declined.
    expect((await rowFor(email)).status).toBe('declined');

    // A different address is unaffected — the budget is per mailbox.
    const bystander = emailFor('bystander');
    expect((await ask(bystander)).statusCode).toBe(200);
    expect(outbox).toHaveLength(2);
  });

  test('the 4th ask from one IP in a minute is a 429', async () => {
    await clearBrake('request-access');
    for (let i = 0; i < 3; i += 1) {
      // Empty bodies: the brake runs BEFORE the handler, so this spends the IP
      // budget without writing rows or sending mail.
      expect((await requestAccess({})).statusCode).toBe(400);
    }
    const over = await requestAccess({});
    expect(over.statusCode).toBe(429);
    expect(json(over)).toEqual({ error: 'too many requests' });
  });
});

// ---- the operator routes ---------------------------------------------------

describe('the operator routes are closed to everyone else', () => {
  let id = '';

  beforeAll(async () => {
    await ask(emailFor('guarded'));
    id = (await rowFor(emailFor('guarded'))).id;
  });

  test('a signed-in NON-operator gets 403 from all three', async () => {
    for (const res of [
      await listRequests(outsiderToken),
      await approve(outsiderToken, id),
      await decline(outsiderToken, id),
    ]) {
      expect(res.statusCode).toBe(403);
      expect(json(res)).toEqual({ error: 'operator access required' });
    }
  });

  test('no token at all is a 401, not a 403 (nothing about the seat leaks)', async () => {
    const res = await app.inject({ method: 'GET', url: '/v1/ops/access-requests' });
    expect(res.statusCode).toBe(401);
  });

  test('the machine operator token does NOT open the human plane', async () => {
    // S1.1's x-operator-token is a different credential for a different plane;
    // it carries no user, so this route cannot attribute anything to a person.
    const res = await app.inject({
      method: 'GET',
      url: '/v1/ops/access-requests',
      headers: { 'x-operator-token': process.env.OPS_ADMIN_TOKEN ?? 'anything' },
    });
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /v1/ops/access-requests', () => {
  test('defaults to pending and filters by status', async () => {
    const pendingEmail = emailFor('list-pending');
    const declinedEmail = emailFor('list-declined');
    await ask(pendingEmail);
    await ask(declinedEmail);
    await decline(operatorToken, (await rowFor(declinedEmail)).id);

    const listed = json(await listRequests(operatorToken)).requests as Array<{
      email: string;
      status: string;
      useCase: string;
    }>;
    expect(listed.every((r) => r.status === 'pending')).toBe(true);
    expect(listed.map((r) => r.email)).toContain(pendingEmail);
    expect(listed.map((r) => r.email)).not.toContain(declinedEmail);

    const declined = json(await listRequests(operatorToken, 'declined')).requests as Array<{
      email: string;
    }>;
    expect(declined.map((r) => r.email)).toContain(declinedEmail);

    // The view is the documented shape, and it never carries the invite code.
    const row = listed.find((r) => r.email === pendingEmail)!;
    expect(Object.keys(row).sort()).toEqual(
      ['consumedAt', 'createdAt', 'decidedAt', 'email', 'id', 'inviteExpiresAt', 'name', 'status', 'useCase'].sort(),
    );
  });

  test('newest first', async () => {
    const older = emailFor('order-1');
    const newer = emailFor('order-2');
    await ask(older);
    await ask(newer);
    const listed = json(await listRequests(operatorToken, 'pending')).requests as Array<{
      email: string;
    }>;
    const emails = listed.map((r) => r.email);
    expect(emails.indexOf(newer)).toBeLessThan(emails.indexOf(older));
  });

  test('an unknown status is a 400', async () => {
    const res = await listRequests(operatorToken, 'whatever');
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /v1/ops/access-requests/:id/approve', () => {
  test('mints an invite, stores only its digest, and emails the link', async () => {
    const email = emailFor('approved');
    await ask(email);
    const id = (await rowFor(email)).id;

    outbox.length = 0;
    const res = await approve(operatorToken, id);
    expect(res.statusCode).toBe(200);
    expect(json(res).request.status).toBe('approved');

    expect(outbox).toHaveLength(1);
    expect(outbox[0].to).toBe(email);
    expect(outbox[0].subject).toBe("You're in — Asyncify access approved");
    expect(outbox[0].text).toContain('7 days');
    expect(outbox[0].text).toContain('once');

    const code = /[?&]invite=([0-9a-f]{64})/.exec(outbox[0].text)?.[1] ?? '';
    expect(code).toMatch(/^[0-9a-f]{64}$/);
    expect(outbox[0].text).toContain(`http://localhost:5173/login?invite=${code}`);

    // Hashed at rest: the raw code is in the email and nowhere else.
    const row = await rowFor(email);
    expect(row.invite_code_hash).toBe(createHash('sha256').update(code).digest('hex'));
    expect(row.status).toBe('approved');
    expect(row.decided_at).toBeTruthy();

    // Seven days, give or take the round trip.
    const ttlMs = new Date(row.invite_expires_at).getTime() - Date.now();
    expect(ttlMs).toBeGreaterThan(6.9 * 24 * 3600 * 1000);
    expect(ttlMs).toBeLessThanOrEqual(7 * 24 * 3600 * 1000);
  });

  test('re-approving is a RESEND: a new code, and the old one is dead', async () => {
    const email = emailFor('resend');
    const { id, code: first } = await askAndApprove(email);
    const firstHash = (await rowFor(email)).invite_code_hash;

    outbox.length = 0;
    expect((await approve(operatorToken, id)).statusCode).toBe(200);
    expect(outbox).toHaveLength(1);
    const second = /[?&]invite=([0-9a-f]{64})/.exec(outbox[0].text)?.[1] ?? '';

    expect(second).not.toBe(first);
    const row = await rowFor(email);
    expect(row.invite_code_hash).not.toBe(firstHash);
    expect(row.invite_code_hash).toBe(createHash('sha256').update(second).digest('hex'));
  });

  test('a DECLINED request cannot be approved — it must be asked for again', async () => {
    const email = emailFor('declined-approve');
    await ask(email);
    const id = (await rowFor(email)).id;
    expect((await decline(operatorToken, id)).statusCode).toBe(200);

    outbox.length = 0;
    const res = await approve(operatorToken, id);
    expect(res.statusCode).toBe(400);
    expect(outbox).toHaveLength(0);
    expect((await rowFor(email)).status).toBe('declined');
  });

  test('an unknown id is a 404, and so is a non-uuid', async () => {
    expect((await approve(operatorToken, '11111111-1111-1111-1111-111111111111')).statusCode).toBe(404);
    expect((await approve(operatorToken, 'not-a-uuid')).statusCode).toBe(404);
  });

  test('a CONSUMED request is a 409 — the seat is spent', async () => {
    const email = emailFor('consumed');
    const { id, code } = await askAndApprove(email);

    // Spend it through the real door, in invite mode, exactly as the invitee
    // would: nothing about this row is faked.
    env.signupMode = 'invite';
    try {
      await clearBrake('signup');
      const created = await app.inject({
        method: 'POST',
        url: '/auth/signup',
        payload: {
          name: 'AR Tester',
          email,
          password: 'access-request-pw-1',
          organizationName: `AR Org ${email}`,
          inviteCode: code,
        },
      });
      expect(created.statusCode).toBe(201);
    } finally {
      env.signupMode = originalSignupMode;
    }

    expect((await rowFor(email)).consumed_at).toBeTruthy();

    outbox.length = 0;
    const res = await approve(operatorToken, id);
    expect(res.statusCode).toBe(409);
    expect(json(res)).toEqual({ error: 'already signed up' });
    expect(outbox).toHaveLength(0);
  });
});

describe('POST /v1/ops/access-requests/:id/decline', () => {
  test('a pending request is declined, silently — no email to the applicant', async () => {
    const email = emailFor('decline');
    await ask(email);
    const id = (await rowFor(email)).id;

    outbox.length = 0;
    const res = await decline(operatorToken, id);
    expect(res.statusCode).toBe(200);
    expect(json(res).request.status).toBe('declined');
    expect(outbox).toHaveLength(0);

    const row = await rowFor(email);
    expect(row.status).toBe('declined');
    expect(row.decided_at).toBeTruthy();
    expect(row.invite_code_hash).toBeNull();
  });

  test('declining twice is a 409, and so is declining an approved row', async () => {
    const email = emailFor('decline-twice');
    await ask(email);
    const id = (await rowFor(email)).id;
    expect((await decline(operatorToken, id)).statusCode).toBe(200);
    expect((await decline(operatorToken, id)).statusCode).toBe(409);

    const approvedEmail = emailFor('decline-approved');
    const approved = await askAndApprove(approvedEmail);
    expect((await decline(operatorToken, approved.id)).statusCode).toBe(409);
    expect((await rowFor(approvedEmail)).status).toBe('approved');
  });

  test('an unknown id is a 404', async () => {
    expect((await decline(operatorToken, '11111111-1111-1111-1111-111111111111')).statusCode).toBe(404);
  });
});
