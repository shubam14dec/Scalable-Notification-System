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

/**
 * S1.2 — THE PER-TENANT PROVIDER-WEBHOOK KEY.
 *
 * The generic provider status webhook used to verify against one global
 * secret for the whole platform, and the body it accepted named a message by
 * provider id with no tenant anywhere. Anyone holding that single secret
 * could flip ANY tenant's message to bounced/complaint — which writes a
 * suppression and silently stops that address being mailed again. One
 * credential, platform-wide blast radius.
 *
 * The fix derives a distinct key per tenant from the same root secret:
 *
 *   tenantKey = hex( HMAC-SHA256( WEBHOOK_SIGNING_SECRET, `tenant:${id}` ) )
 *
 * Standard KDF shape, deliberately NOT a new signing scheme: the wire format,
 * the headers and the tolerance window are untouched, so anything that
 * already speaks this webhook keeps working once it is pointed at the
 * tenant's own URL with the tenant's own key. A holder of tenant A's key can
 * forge only for tenant A, and the URL's tenantId is what selects the key —
 * so a request aimed at another tenant is verified with a key the sender does
 * not have.
 *
 * The root secret never leaves the server; only derived keys are handed out.
 */
export function tenantWebhookSecret(globalSecret: string, tenantId: string): string {
  return createHmac('sha256', globalSecret).update(`tenant:${tenantId}`).digest('hex');
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
