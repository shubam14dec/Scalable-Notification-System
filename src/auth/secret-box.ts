import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { env } from '../config/env';

/**
 * AES-256-GCM for provider credentials at rest. GCM is authenticated
 * encryption: tampered ciphertext fails to decrypt instead of yielding
 * garbage. Format: "v1:" + base64(iv[12] | authTag[16] | ciphertext).
 *
 * The 32-byte key is derived from CREDENTIALS_ENCRYPTION_KEY — in
 * production, source that from a secret manager/KMS, and rotating it means
 * re-encrypting rows (the v1 prefix leaves room for versioned rotation).
 */
const key = createHash('sha256').update(env.credentialsEncryptionKey).digest();

export function sealSecret(plaintext: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return `v1:${Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64')}`;
}

export function openSecret(sealed: string): string {
  if (!sealed.startsWith('v1:')) throw new Error('unknown secret format');
  const raw = Buffer.from(sealed.slice(3), 'base64');
  const iv = raw.subarray(0, 12);
  const tag = raw.subarray(12, 28);
  const data = raw.subarray(28);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}
