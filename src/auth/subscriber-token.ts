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

const b64url = (buf: Buffer) => buf.toString('base64url');

function sign(payload: string): string {
  return createHmac('sha256', `subscriber:${env.jwtSecret}`).update(payload).digest('base64url');
}

export function mintSubscriberToken(
  tenantId: string,
  subscriberId: string,
  ttlSeconds = 3600,
): { token: string; expiresAt: number } {
  const expiresAt = Math.floor(Date.now() / 1000) + ttlSeconds;
  const payload = b64url(
    Buffer.from(JSON.stringify({ t: tenantId, s: subscriberId, e: expiresAt })),
  );
  return { token: `nst_${payload}.${sign(payload)}`, expiresAt };
}

export function verifySubscriberToken(token: string): SubscriberTokenPayload | null {
  if (!token.startsWith('nst_')) return null;
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(4, dot);
  const signature = token.slice(dot + 1);

  const expected = Buffer.from(sign(payload));
  const provided = Buffer.from(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) return null;

  try {
    const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString()) as {
      t: string;
      s: string;
      e: number;
    };
    if (parsed.e < Date.now() / 1000) return null; // expired
    return { tenantId: parsed.t, subscriberId: parsed.s, expiresAt: parsed.e };
  } catch {
    return null;
  }
}
