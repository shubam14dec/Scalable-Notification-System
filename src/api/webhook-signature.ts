import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * HMAC-SHA256 webhook signing, the scheme most providers use (Stripe-style):
 *
 *   signature = hex( HMAC-SHA256( secret, `${timestamp}.${rawBody}` ) )
 *
 * sent as `x-webhook-signature` with `x-webhook-timestamp` (unix seconds).
 * The timestamp binds the signature to a moment, so a captured request
 * can't be replayed later; the tolerance window absorbs clock skew.
 */
export function signWebhook(secret: string, timestamp: string, rawBody: string): string {
  return createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex');
}

export function verifyWebhook(
  secret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  toleranceSec = 300,
): { ok: boolean; reason?: string } {
  if (!timestamp || !signature) {
    return { ok: false, reason: 'missing x-webhook-timestamp or x-webhook-signature header' };
  }
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'invalid timestamp' };
  }
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) {
    return { ok: false, reason: 'timestamp outside tolerance (possible replay)' };
  }

  const expected = Buffer.from(signWebhook(secret, timestamp, rawBody), 'hex');
  let provided: Buffer;
  try {
    provided = Buffer.from(signature, 'hex');
  } catch {
    return { ok: false, reason: 'malformed signature' };
  }
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}
