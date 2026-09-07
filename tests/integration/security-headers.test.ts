/**
 * S1.3 — browser & transport hardening on the API side, against the real app.
 *
 * Two things are proven here:
 *
 *  1. Every response carries the hand-rolled hardening headers (onSend hook in
 *     src/api/app.ts) — nosniff and Referrer-Policy everywhere, no-store on the
 *     token-bearing /auth/* replies, and a CSP chosen from the OUTGOING content
 *     type so the API's real HTML pages (the phone-facing bot-setup handoff)
 *     keep their styling instead of being flattened by `default-src 'none'`.
 *
 *  2. The JWT algorithm pin actually bites. A token forged with HS512 and the
 *     SAME secret must be rejected by both jwtVerify guards (requireUser and
 *     authenticate). The HS256 twin of that forgery is asserted to be ACCEPTED
 *     first — otherwise a broken forge helper would make the HS512 case pass
 *     for the wrong reason and the pin could silently not be wired at all.
 *
 * Requires: `docker compose up -d postgres redis` and `npm run migrate`.
 */
import { createHmac } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, test } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/api/app';
import { closeQueues } from '../../src/shared/queues';
import { redis } from '../../src/shared/redis';
import { pool } from '../../src/db/pool';
import { env } from '../../src/config/env';

let app: FastifyInstance;
let apiKey = '';
let tenantId = '';
let userId = '';
let accessToken = '';
let email = '';

const PASSWORD = 'integration-pw-1';
const json = (res: { body: string }) => JSON.parse(res.body);

const b64url = (value: object) => Buffer.from(JSON.stringify(value)).toString('base64url');

/**
 * Mint a JWT by hand with an arbitrary `alg`, signed with the app's own
 * secret. @fastify/jwt would never produce the HS512 variant now that signing
 * is pinned, which is exactly why the forgery is built from node crypto.
 */
function forgeToken(alg: 'HS256' | 'HS512', payload: Record<string, unknown>): string {
  const header = b64url({ alg, typ: 'JWT' });
  const body = b64url({ ...payload, exp: Math.floor(Date.now() / 1000) + 600 });
  const signature = createHmac(alg === 'HS512' ? 'sha512' : 'sha256', env.jwtSecret)
    .update(`${header}.${body}`)
    .digest('base64url');
  return `${header}.${body}.${signature}`;
}

/** Both JWT-verifying guards: requireUser (/auth/me) and authenticate (/v1/*). */
const asUser = (token: string) =>
  app.inject({ method: 'GET', url: '/auth/me', headers: { authorization: `Bearer ${token}` } });
const asTenant = (token: string) =>
  app.inject({
    method: 'GET',
    url: '/v1/subscribers',
    headers: { authorization: `Bearer ${token}`, 'x-environment-id': tenantId },
  });

beforeAll(async () => {
  app = await buildApp();

  const suffix = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  email = `sec-headers-${suffix}@itest.local`;
  const signup = await app.inject({
    method: 'POST',
    url: '/auth/signup',
    payload: {
      name: 'Sec Headers IT',
      email,
      password: PASSWORD,
      organizationName: 'Sec Headers IT Org',
    },
  });
  expect(signup.statusCode).toBe(201);
  const body = json(signup);
  userId = body.user.id;
  accessToken = body.accessToken;
  const dev = body.environments.find((e: { name: string }) => e.name === 'Development');
  apiKey = dev.apiKey;
  tenantId = dev.id;
});

afterAll(async () => {
  await pool.query('delete from setup_handoffs where tenant_id = $1', [tenantId]);
  await app.close();
  await closeQueues();
  await redis.quit();
  await pool.end();
});

describe('response hardening headers', () => {
  test('every response carries nosniff and a strict Referrer-Policy', async () => {
    const health = await app.inject({ method: 'GET', url: '/health' });
    expect(health.headers['x-content-type-options']).toBe('nosniff');
    expect(health.headers['referrer-policy']).toBe('no-referrer');

    // Error paths go through onSend too — a 401 must not be a bare body.
    const denied = await app.inject({ method: 'GET', url: '/v1/subscribers' });
    expect(denied.statusCode).toBe(401);
    expect(denied.headers['x-content-type-options']).toBe('nosniff');
    expect(denied.headers['referrer-policy']).toBe('no-referrer');
  });

  test('JSON responses get the no-document CSP', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['content-security-policy']).toBe(
      "default-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
  });

  test('token-bearing /auth/* responses are no-store', async () => {
    const login = await app.inject({
      method: 'POST',
      url: '/auth/login',
      payload: { email, password: PASSWORD },
    });
    expect(login.statusCode).toBe(200);
    expect(json(login).accessToken).toBeTruthy();
    expect(login.headers['cache-control']).toBe('no-store');
  });

  test('non-/auth responses are left alone by the no-store rule', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.headers['cache-control']).toBeUndefined();
  });
});

describe('the handoff HTML page survives the API CSP', () => {
  test('renders as before, with the HTML CSP rather than default-src none', async () => {
    const mint = await app.inject({
      method: 'POST',
      url: '/v1/ops/handoffs',
      headers: { 'x-api-key': apiKey },
      payload: {},
    });
    expect(mint.statusCode).toBe(201);
    const token = String(json(mint).url).split('/handoff/')[1];

    const page = await app.inject({ method: 'GET', url: `/handoff/${token}` });

    // Status and content type exactly as before the hook existed.
    expect(page.statusCode).toBe(200);
    expect(page.headers['content-type']).toBe('text/html; charset=utf-8');
    // And it is still the real paste form, not a blank shell.
    expect(page.body).toContain('<form method="post"');
    expect(page.body).toContain('<style>');

    // The HTML CSP: styles allowed (the page has a <style> block), the form can
    // still post home, and scripts stay denied via the default-src fallback.
    const csp = page.headers['content-security-policy'];
    expect(csp).toBe(
      "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
    );
    expect(csp).not.toContain("script-src");
    expect(page.headers['x-content-type-options']).toBe('nosniff');
  });
});

describe('JWT algorithm pinning', () => {
  test('the app still accepts its own HS256 tokens', async () => {
    const res = await asUser(accessToken);
    expect(res.statusCode).toBe(200);
    expect(json(res).user.id).toBe(userId);
  });

  /**
   * Control for the test below: the hand-forged token is well-formed enough to
   * authenticate when its alg is the pinned one. Without this, an HS512
   * rejection would prove nothing about the pin.
   */
  test('a hand-forged HS256 token is accepted (the forge helper is sound)', async () => {
    const res = await asUser(forgeToken('HS256', { sub: userId, type: 'access' }));
    expect(res.statusCode).toBe(200);
    expect(json(res).user.id).toBe(userId);
  });

  test('the same claims signed HS512 are rejected by requireUser', async () => {
    const res = await asUser(forgeToken('HS512', { sub: userId, type: 'access' }));
    expect(res.statusCode).toBe(401);
    expect(json(res).error).toContain('access token');
  });

  test('the same claims signed HS512 are rejected by authenticate', async () => {
    // Sanity: the HS256 twin gets past the JWT gate on this route too.
    const ok = await asTenant(forgeToken('HS256', { sub: userId, type: 'access' }));
    expect(ok.statusCode).toBe(200);

    const res = await asTenant(forgeToken('HS512', { sub: userId, type: 'access' }));
    expect(res.statusCode).toBe(401);
    expect(json(res).error).toBe('invalid access token');
  });
});
