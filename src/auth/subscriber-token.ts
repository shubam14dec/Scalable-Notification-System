import { createHmac, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * Short-lived subscriber tokens for browser/mobile clients (the inbox
 * widget). API keys must never reach a browser; instead the customer's
 * backend mints one of these per user session:
 *
 *   token = nst_ + base64url({ t: tenantId, s: subscriberId, e: expiresAt })
 *           + "." + HMAC-SHA256(payload)
 *
 * The token can ONLY read/mark that one subscriber's inbox and open their
 * WebSocket — nothing else in the API accepts it.
 */

export interface SubscriberTokenPayload {
  tenantId: string;
  subscriberId: string;
  expiresAt: number; // unix seconds
}

/**
 * S1.2 — TTL BOUNDS. A subscriber token is a bearer credential living in a
 * browser: whoever copies it out of devtools, a shared machine, or a log is
 * that user until it expires, and there is no revocation list. So the ceiling
 * is set by how long a stolen one stays useful, not by convenience — the
 * widget re-mints silently from the customer's own session, which is a cheap
 * call the user never sees.
 *
 * Default one hour (a working session); hard cap six hours (a long shift on a
 * kiosk or support desk, the longest sitting anyone actually described). The
 * previous 24h ceiling meant a token lifted at 9am was still live the next
 * morning. Both bounds are enforced HERE, in the minting function, not only
 * in the route's zod schema — the route is one caller and the rule belongs to
 * the credential.
 */
export const SUBSCRIBER_TOKEN_DEFAULT_TTL_S = 3600;
export const SUBSCRIBER_TOKEN_MAX_TTL_S = 21_600;

const b64url = (buf: Buffer) => buf.toString('base64url');

/**
 * S1.2 — PER-TENANT SIGNING KEY. Under the old single global key the tenant
 * binding was sound (the signed payload carries `t`, and minting is server-
 * side only) — but the blast radius wasn't: one key authenticated every
 * subscriber of every tenant, so any single leak or oracle anywhere meant
 * platform-wide forgery, and there was no way to reason about one tenant's
 * tokens in isolation.
 *
 * Deriving the key from the tenant confines a compromise to one tenant:
 * verification reads the CLAIMED tenantId out of the payload, derives that
 * tenant's key, and checks the HMAC against it. A token re-pointed at tenant
 * B is verified with B's key, which A's signature cannot satisfy.
 *
 * The global secret stays the root — one env var, no new key management,
 * no per-tenant storage — and HMAC over it is a standard KDF shape (the same
 * "derive, don't redesign" move as the per-tenant provider-webhook key).
 */
function signingKey(tenantId: string): string {
  return `subscriber:${env.jwtSecret}:${tenantId}`;
}

function sign(tenantId: string, payload: string): string {
  return createHmac('sha256', signingKey(tenantId)).update(payload).digest('base64url');
}

export function mintSubscriberToken(
  tenantId: string,
  subscriberId: string,
  ttlSeconds = SUBSCRIBER_TOKEN_DEFAULT_TTL_S,
): { token: string; expiresAt: number } {
  // Negative TTLs are used by tests to mint an already-expired token; only the
  // upper bound is a security rule, so clamp that end only.
  const ttl = Math.min(ttlSeconds, SUBSCRIBER_TOKEN_MAX_TTL_S);
  const expiresAt = Math.floor(Date.now() / 1000) + ttl;
  const payload = b64url(
    Buffer.from(JSON.stringify({ t: tenantId, s: subscriberId, e: expiresAt })),
  );
  return { token: `nst_${payload}.${sign(tenantId, payload)}`, expiresAt };
}

export function verifySubscriberToken(token: string): SubscriberTokenPayload | null {
  if (!token.startsWith('nst_')) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(4, dot);
  const signature = token.slice(dot + 1);

  // Parse BEFORE verifying, because the signing key depends on the tenant the
  // token claims. Nothing parsed here is trusted yet — the claimed tenantId is
  // used only to pick which key must validate the HMAC, and a wrong claim
  // simply produces a key the signature fails under.
  let parsed: { t: string; s: string; e: number };
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString());
  } catch {
    return null;
  }
  if (typeof parsed?.t !== 'string' || typeof parsed?.s !== 'string') return null;

  const expected = Buffer.from(sign(parsed.t, payload));
  const provided = Buffer.from(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  if (!(parsed.e >= Date.now() / 1000)) return null; // expired (or non-numeric)
  return { tenantId: parsed.t, subscriberId: parsed.s, expiresAt: parsed.e };
}
