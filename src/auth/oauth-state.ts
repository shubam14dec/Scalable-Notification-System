import { createHmac, hkdfSync, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env';

/**
 * HMAC-signed OAuth `state` for the Slack install flow. state binds the OAuth
 * callback to the connection + tenant it was minted for (so a stray/forged
 * callback can't attach a workspace to someone else's connection) and expires
 * in 5 minutes. Format: base64url(JSON payload) '.' base64url(hmac). No new
 * env var: the signing key is HKDF-derived from CREDENTIALS_ENCRYPTION_KEY with
 * a distinct info label, so it never collides with the credential-sealing key.
 */
const key = Buffer.from(
  hkdfSync('sha256', env.credentialsEncryptionKey, Buffer.alloc(0), 'slack-oauth-state', 32),
);

const EXP_MS = 5 * 60 * 1000;

export interface OauthStatePayload {
  connectionId: string;
  tenantId: string;
}

interface SignedBlob extends OauthStatePayload {
  exp: number;
}

export function mintOauthState(payload: OauthStatePayload): string {
  const blob: SignedBlob = { ...payload, exp: Date.now() + EXP_MS };
  const body = Buffer.from(JSON.stringify(blob), 'utf8');
  const mac = createHmac('sha256', key).update(body).digest();
  return `${body.toString('base64url')}.${mac.toString('base64url')}`;
}

/** Returns the payload when the signature is valid and unexpired, else null. */
export function verifyOauthState(state: string): OauthStatePayload | null {
  const dot = state.indexOf('.');
  if (dot < 1 || dot === state.length - 1) return null;

  const body = Buffer.from(state.slice(0, dot), 'base64url');
  const provided = Buffer.from(state.slice(dot + 1), 'base64url');
  const expected = createHmac('sha256', key).update(body).digest();
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return null;
  }

  let blob: Partial<SignedBlob>;
  try {
    blob = JSON.parse(body.toString('utf8')) as Partial<SignedBlob>;
  } catch {
    return null;
  }
  if (
    typeof blob.connectionId !== 'string' ||
    typeof blob.tenantId !== 'string' ||
    typeof blob.exp !== 'number' ||
    Date.now() > blob.exp
  ) {
    return null;
  }
  return { connectionId: blob.connectionId, tenantId: blob.tenantId };
}
