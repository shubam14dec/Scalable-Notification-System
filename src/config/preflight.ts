import { env } from './env';
import { logger } from '../shared/logger';

/**
 * Production config preflight — the guard that stops a silently-degraded boot.
 *
 * WHY this exists: `env.ts` deliberately gives every variable a fallback so a
 * fresh clone runs with zero setup. That same property is a production hazard —
 * a missing secret does not crash anything, it boots a fully working system on
 * values that are published in this repo. The failure modes are all quiet:
 *
 *  - JWT_SECRET missing → api and ws each fall back to the SAME dev default, so
 *    nothing breaks visibly, but anyone who has read this repo can mint a valid
 *    dashboard session. And when only one of the two is set, the mismatch is
 *    quieter still: the ws gateway rejects the dashboard with close code 4401
 *    and the UI degrades to 60s polling. Nothing errors; it just feels slow.
 *  - CREDENTIALS_ENCRYPTION_KEY missing → provider credentials get encrypted at
 *    rest with a key from this repo, and (worse) once real credentials have
 *    been stored under a key, LOSING that key is unrecoverable: every stored
 *    provider credential is bricked and every channel must be reconnected.
 *  - WEBHOOK_SIGNING_SECRET empty → signature verification on provider status
 *    webhooks is DISABLED (see env.ts), so anyone can post delivery statuses.
 *  - OPS_ADMIN_TOKEN missing → PUT /v1/ops/public-url has no operator
 *    credential to check against, so the one global setting every tenant's
 *    webhooks and tracking pixels are built from cannot be rotated at all.
 *    Booting without it would leave the operator plane locked out and the
 *    lockout invisible until a tunnel rotation needed it.
 *  - OUTBOUND_URL_ALLOW non-empty → the SSRF guard (src/core/safe-url.ts) has
 *    holes punched in it. That list exists for local development, where tool
 *    URLs point at private addresses; in production it must be empty.
 *
 * So: in production only, refuse to start on any of the above. A loud crash at
 * boot is the cheapest possible version of every one of these bugs.
 *
 * Called as the FIRST statement of each entrypoint's main() — never inside
 * buildApp()/startGateway(), which tests construct directly.
 */
export function assertProductionConfig(role: string): void {
  if (process.env.NODE_ENV !== 'production') return;

  const fatal = (variable: string, why: string): never => {
    logger.fatal(
      { role, variable },
      `[preflight] ${role} refusing to start: ${variable} ${why}`,
    );
    process.exit(1);
  };

  if (
    env.jwtSecret === 'dev-jwt-secret-change-me' ||
    env.jwtSecret.length < 32
  ) {
    fatal(
      'JWT_SECRET',
      'is the published dev default or shorter than 32 chars. Generate one ' +
        '(openssl rand -base64 48) and set the SAME value for api and ws.',
    );
  }

  if (
    env.credentialsEncryptionKey === 'dev-credentials-key-change-me' ||
    env.credentialsEncryptionKey.length < 32
  ) {
    fatal(
      'CREDENTIALS_ENCRYPTION_KEY',
      'is the published dev default or shorter than 32 chars. Generate one ' +
        '(openssl rand -base64 48), then back it up off-box — losing it ' +
        'bricks every stored provider credential.',
    );
  }

  if (env.webhookSigningSecret === '') {
    fatal(
      'WEBHOOK_SIGNING_SECRET',
      'is empty, which DISABLES signature verification on provider status ' +
        'webhooks. Generate one (openssl rand -hex 32).',
    );
  }

  if (env.opsAdminToken === '' || env.opsAdminToken.length < 32) {
    fatal(
      'OPS_ADMIN_TOKEN',
      'is empty or shorter than 32 chars. It is the ONLY credential accepted ' +
        'by PUT /v1/ops/public-url in production — the global setting every ' +
        'tenant webhook and tracking pixel is built from. Generate one ' +
        '(openssl rand -hex 32); it is an operator secret, never a tenant key.',
    );
  }

  if ((process.env.OUTBOUND_URL_ALLOW ?? '') !== '') {
    fatal(
      'OUTBOUND_URL_ALLOW',
      'is non-empty. The SSRF allow-list is a local-development escape hatch ' +
        'and must be empty in production.',
    );
  }

  // Not fatal: PUBLIC_URL is only the boot-time fallback (the live value lives
  // in Redis, see config/public-url.ts), so a localhost value is recoverable
  // with one PUT — but every webhook URL and open-tracking pixel minted before
  // that PUT points at nothing.
  if (env.publicUrl.includes('localhost')) {
    console.warn(
      `[preflight] ${role}: PUBLIC_URL is ${env.publicUrl} — webhook URLs and ` +
        'open-tracking pixels minted from it are unreachable. Publish the real ' +
        'URL with PUT /v1/ops/public-url.',
    );
  }
}
