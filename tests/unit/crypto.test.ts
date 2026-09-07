import { describe, expect, test } from 'vitest';
import { sealSecret, openSecret } from '../../src/auth/secret-box';
import { hashPassword, verifyPassword } from '../../src/auth/password';
import {
  mintSubscriberToken,
  SUBSCRIBER_TOKEN_DEFAULT_TTL_S,
  SUBSCRIBER_TOKEN_MAX_TTL_S,
  verifySubscriberToken,
} from '../../src/auth/subscriber-token';
import { signWebhook, tenantWebhookSecret, verifyWebhook } from '../../src/api/webhook-signature';

describe('secret-box (AES-256-GCM)', () => {
  test('round-trips arbitrary payloads', () => {
    const secret = JSON.stringify({ apiKey: 'SG.abc123', from: 'a@b.co' });
    expect(openSecret(sealSecret(secret))).toBe(secret);
  });

  test('every seal is unique (fresh IV)', () => {
    expect(sealSecret('same')).not.toBe(sealSecret('same'));
  });

  test('tampered ciphertext throws (authenticated encryption)', () => {
    const sealed = sealSecret('credentials');
    const raw = Buffer.from(sealed.slice(3), 'base64');
    raw[raw.length - 1] ^= 0xff; // flip a ciphertext bit
    expect(() => openSecret(`v1:${raw.toString('base64')}`)).toThrow();
  });

  test('unknown format rejected', () => {
    expect(() => openSecret('v9:whatever')).toThrow('unknown secret format');
  });
});

describe('password hashing (scrypt)', () => {
  test('verifies the right password and rejects the wrong one', async () => {
    const hash = await hashPassword('supersecret1');
    expect(await verifyPassword('supersecret1', hash)).toBe(true);
    expect(await verifyPassword('supersecret2', hash)).toBe(false);
  });

  test('hashes are salted (same password, different hashes)', async () => {
    expect(await hashPassword('pw12345678')).not.toBe(await hashPassword('pw12345678'));
  });

  test('malformed stored hash returns false, never throws', async () => {
    expect(await verifyPassword('x', 'not-a-hash')).toBe(false);
    expect(await verifyPassword('x', 'bcrypt:something')).toBe(false);
  });
});

describe('subscriber tokens', () => {
  test('mint → verify round-trips tenant and subscriber', () => {
    const { token } = mintSubscriberToken('tenant-1', 'user-42', 3600);
    const payload = verifySubscriberToken(token);
    expect(payload).toMatchObject({ tenantId: 'tenant-1', subscriberId: 'user-42' });
  });

  test('tampering the payload or signature invalidates the token', () => {
    const { token } = mintSubscriberToken('tenant-1', 'user-42');
    const flipped = token.slice(0, token.length - 2) + (token.endsWith('aa') ? 'bb' : 'aa');
    expect(verifySubscriberToken(flipped)).toBeNull();
    // swap the subscriber inside the payload without re-signing
    const [head, sig] = token.split('.');
    const forged = Buffer.from(
      JSON.stringify({ t: 'tenant-1', s: 'admin', e: Math.floor(Date.now() / 1000) + 999 }),
    ).toString('base64url');
    expect(verifySubscriberToken(`nst_${forged}.${sig}`)).toBeNull();
    expect(head.startsWith('nst_')).toBe(true);
  });

  test('expired tokens are rejected', () => {
    const { token } = mintSubscriberToken('tenant-1', 'user-42', -10);
    expect(verifySubscriberToken(token)).toBeNull();
  });

  test('garbage input is rejected', () => {
    expect(verifySubscriberToken('nope')).toBeNull();
    expect(verifySubscriberToken('nst_abc')).toBeNull();
  });

  // S1.2 — the signing key is derived per tenant, so the signature BINDS the
  // tenant instead of merely accompanying a claim about it.
  test('a token minted under tenant A can never verify as tenant B', () => {
    const { token } = mintSubscriberToken('tenant-A', 'user-42', 3600);
    const [, sig] = token.split('.');
    // Re-point the payload at another tenant, keeping A's signature — the
    // exact move the old single-key scheme could not detect.
    const forged = Buffer.from(
      JSON.stringify({ t: 'tenant-B', s: 'user-42', e: Math.floor(Date.now() / 1000) + 999 }),
    ).toString('base64url');
    expect(verifySubscriberToken(`nst_${forged}.${sig}`)).toBeNull();

    // The genuine token still verifies, and reports the tenant it was signed for.
    expect(verifySubscriberToken(token)).toMatchObject({ tenantId: 'tenant-A' });
  });

  test('two tenants minting for the same subscriber produce different signatures', () => {
    const a = mintSubscriberToken('tenant-A', 'user-42', 3600).token.split('.')[1];
    const b = mintSubscriberToken('tenant-B', 'user-42', 3600).token.split('.')[1];
    expect(a).not.toBe(b);
  });

  test('TTL is capped at 6h even when a caller asks for more', () => {
    const now = Math.floor(Date.now() / 1000);
    const { expiresAt } = mintSubscriberToken('tenant-1', 'user-42', 86_400);
    expect(expiresAt - now).toBeLessThanOrEqual(SUBSCRIBER_TOKEN_MAX_TTL_S);
    expect(expiresAt - now).toBeGreaterThan(SUBSCRIBER_TOKEN_MAX_TTL_S - 5);
  });

  test('the default TTL is one hour', () => {
    const now = Math.floor(Date.now() / 1000);
    expect(SUBSCRIBER_TOKEN_DEFAULT_TTL_S).toBe(3600);
    const { expiresAt } = mintSubscriberToken('tenant-1', 'user-42');
    expect(expiresAt - now).toBeGreaterThan(3595);
    expect(expiresAt - now).toBeLessThanOrEqual(3600);
  });
});

describe('webhook signatures', () => {
  const secret = 'test-secret';
  const body = '{"providerMessageId":"x","status":"bounced"}';

  test('valid signature within tolerance passes', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signWebhook(secret, ts, body);
    expect(verifyWebhook(secret, ts, sig, body).ok).toBe(true);
  });

  test('modified body fails', () => {
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signWebhook(secret, ts, body);
    expect(verifyWebhook(secret, ts, sig, body.replace('bounced', 'delivered')).ok).toBe(false);
  });

  test('old timestamp rejected (replay protection)', () => {
    const stale = String(Math.floor(Date.now() / 1000) - 3600);
    const sig = signWebhook(secret, stale, body);
    const verdict = verifyWebhook(secret, stale, sig, body);
    expect(verdict.ok).toBe(false);
    expect(verdict.reason).toContain('tolerance');
  });

  test('missing headers rejected', () => {
    expect(verifyWebhook(secret, undefined, undefined, body).ok).toBe(false);
  });

  // S1.2 — per-tenant derivation. Same scheme, one key per tenant, so holding
  // one tenant's key forges nothing for anybody else.
  describe('per-tenant derivation', () => {
    const A = '11111111-1111-1111-1111-111111111111';
    const B = '22222222-2222-2222-2222-222222222222';

    test('each tenant gets a distinct key, and none of them is the root secret', () => {
      const ka = tenantWebhookSecret(secret, A);
      const kb = tenantWebhookSecret(secret, B);
      expect(ka).not.toBe(kb);
      expect(ka).not.toBe(secret);
      expect(ka).toMatch(/^[0-9a-f]{64}$/);
      // Deterministic: the same inputs always derive the same key.
      expect(tenantWebhookSecret(secret, A)).toBe(ka);
    });

    test("a signature made with tenant A's key fails under tenant B's", () => {
      const ts = String(Math.floor(Date.now() / 1000));
      const sig = signWebhook(tenantWebhookSecret(secret, A), ts, body);
      expect(verifyWebhook(tenantWebhookSecret(secret, A), ts, sig, body).ok).toBe(true);
      expect(verifyWebhook(tenantWebhookSecret(secret, B), ts, sig, body).ok).toBe(false);
    });
  });
});
