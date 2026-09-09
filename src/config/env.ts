import 'dotenv/config';

function int(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

function float(name: string, fallback: number): number {
  const v = process.env[name];
  const n = v ? Number.parseFloat(v) : NaN;
  return Number.isFinite(n) ? n : fallback;
}

/**
 * B1 — how the front door behaves. `open` is self-serve signup exactly as it
 * has always worked; `invite` puts an operator between a stranger and an
 * account (POST /auth/request-access -> the Requests page -> an emailed code).
 *
 * Anything unrecognized reads as OPEN and says so loudly at boot. Failing the
 * other way would be worse in both directions: a typo'd `SIGNUP_MODE=Invite`
 * that silently locked every real customer out would look exactly like an
 * outage, and a mode nobody chose is not a security posture. The warn is the
 * thing that gets it fixed — console.warn rather than the pino logger because
 * this file must stay importable by anything (the logger never reads config,
 * but a config->logger edge is a cycle waiting to happen).
 */
function signupMode(): 'open' | 'invite' {
  const raw = (process.env.SIGNUP_MODE ?? 'open').trim().toLowerCase();
  if (raw === 'open' || raw === 'invite') return raw;
  console.warn(
    `[config] SIGNUP_MODE=${process.env.SIGNUP_MODE} is not 'open' or 'invite' — ` +
      'reading it as open (self-serve signup is ON).',
  );
  return 'open';
}

/** A comma-separated env list, trimmed, lowercased, empties dropped. */
function csvLower(name: string): string[] {
  return (process.env[name] ?? '')
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part) => part.length > 0);
}

export const env = {
  port: int('PORT', 3000),

  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/notifications',

  redisHost: process.env.REDIS_HOST ?? 'localhost',
  redisPort: int('REDIS_PORT', 6379),
  // Nonzero only in tests (vitest setup pins 15): isolates test queues,
  // dedupe keys and rate limits from a dev worker fleet on the same Redis.
  redisDb: int('REDIS_DB', 0),

  smtpHost: process.env.SMTP_HOST ?? 'localhost',
  smtpPort: int('SMTP_PORT', 1025),
  smtpFrom: process.env.SMTP_FROM ?? 'notifications@example.com',
  // S1.7a: the operator relay needs credentials in production (Resend's SMTP
  // mode wants user `resend` + the API key). Empty in dev — Mailpit takes
  // anything — and an empty user leaves `auth` undefined, which is exactly the
  // unauthenticated transport this file described before the pair existed.
  smtpUser: process.env.SMTP_USER ?? '',
  smtpPass: process.env.SMTP_PASS ?? '',
  /**
   * S1.7a rider: whether tenants WITHOUT an email integration may fall back to
   * the env SMTP transport. Default true (dev/Mailpit convenience, historical
   * behavior). Production sets 'false': the env SMTP there is the PLATFORM's
   * own Resend identity (reset emails, notifications@asyncify.org), and with
   * open signup an armed fallback would let any stranger send mail through our
   * domain. Platform emails (src/core/platform-email.ts) ignore this flag —
   * they are the reason the transport exists.
   */
  smtpTenantFallback: (process.env.SMTP_TENANT_FALLBACK ?? 'true') !== 'false',

  emailChaosRate: float('EMAIL_CHAOS_RATE', 0),

  deliveryConcurrency: {
    p0: int('DELIVERY_CONCURRENCY_P0', 30),
    p1: int('DELIVERY_CONCURRENCY_P1', 15),
    p2: int('DELIVERY_CONCURRENCY_P2', 5),
  },

  sendsPerSec: {
    email: int('EMAIL_SENDS_PER_SEC', 50),
    sms: int('SMS_SENDS_PER_SEC', 20),
    push: int('PUSH_SENDS_PER_SEC', 100),
    // In-app is internal (Redis publish + DB row), no vendor cap to respect.
    inapp: int('INAPP_SENDS_PER_SEC', 1000),
  },

  wsPort: int('WS_PORT', 3001),

  // Public base URL of the API — used in email open-tracking pixel links.
  publicUrl: (process.env.PUBLIC_URL ?? 'http://localhost:3000').replace(/\/$/, ''),

  triggerConcurrency: int('TRIGGER_CONCURRENCY', 20),
  fanoutConcurrency: int('FANOUT_CONCURRENCY', 20),
  statusConcurrency: int('STATUS_CONCURRENCY', 10),

  logFlushIntervalMs: int('LOG_FLUSH_INTERVAL_MS', 500),
  logFlushBatch: int('LOG_FLUSH_BATCH', 500),

  // Broadcast fan-out: page size through the subscribers table, and the
  // backpressure watermark — paging pauses while fanout + delivery queues
  // hold more than this many waiting jobs, so Redis memory stays bounded
  // no matter how large the blast is.
  broadcastBatchSize: int('BROADCAST_BATCH_SIZE', 100),
  fanoutHighWatermark: int('FANOUT_HIGH_WATERMARK', 50_000),

  // Tenant overflow (burst QoS): bursts between 1x and HARD_LIMIT_MULTIPLIER x
  // the tenant's rate limit are accepted but diverted to the overflow queue
  // and trickled back in; beyond the hard cap the API returns 429.
  hardLimitMultiplier: int('HARD_LIMIT_MULTIPLIER', 5),
  overflowConcurrency: int('OVERFLOW_CONCURRENCY', 5),
  overflowReplayPerSec: int('OVERFLOW_REPLAY_PER_SEC', 20),

  // Shared secret for provider status webhooks. Empty string disables
  // verification (dev only — always set this in production).
  webhookSigningSecret: process.env.WEBHOOK_SIGNING_SECRET ?? '',

  // Operator-only secret gating GLOBAL ops writes (PUT /v1/ops/public-url —
  // one value shared by every tenant). NOT a tenant API key: no tenant
  // credential can substitute for it in production. Empty in dev, where
  // requireOperator falls back to ordinary tenant auth so `asyncify dev`
  // works with nothing configured. Preflight refuses to boot without it in
  // production. NOTE: the request-time check in src/api/auth.ts reads
  // process.env directly (this object is a module-load snapshot).
  opsAdminToken: process.env.OPS_ADMIN_TOKEN ?? '',

  // Master key for encrypting provider credentials at rest (AES-256-GCM).
  // Always override in production; source from KMS/secret manager.
  credentialsEncryptionKey:
    process.env.CREDENTIALS_ENCRYPTION_KEY ?? 'dev-credentials-key-change-me',

  /**
   * S1.6 — "Continue with Google" (server-side authorization-code + OIDC).
   *
   * OPTIONAL FEATURE, OFF BY DEFAULT: both id and secret empty = the routes
   * 404 and the dashboard hides the button, so nothing here is a preflight
   * requirement — a deployment without a Google project keeps working exactly
   * as it does today with email + password.
   *
   * postLoginOrigin is the origin the callback bounces the browser back to
   * with the one-time login code. Empty = same origin (production: the SPA and
   * the API are one origin behind Caddy). Dev sets http://localhost:5173,
   * because the callback lands on the API at :3000 while the SPA runs on the
   * vite port — and only the SPA's own origin can write its localStorage.
   */
  google: {
    clientId: process.env.GOOGLE_CLIENT_ID ?? '',
    clientSecret: process.env.GOOGLE_CLIENT_SECRET ?? '',
    postLoginOrigin: (process.env.GOOGLE_POST_LOGIN_ORIGIN ?? '').replace(/\/$/, ''),
  },

  /**
   * B1 — THE BETA GATE.
   *
   * `signupMode` decides whether /auth/signup (and the CREATE branch of the
   * Google door) is self-serve or needs an invite. Default 'open': a fresh
   * clone and every existing deployment behave exactly as they did before this
   * slice existed. Flipping it back to 'open' in production IS the launch.
   *
   * `operatorEmails` is the HUMAN operator seat — the addresses that may read
   * the Requests page, approve/decline access requests, and receive the "someone
   * asked for access" notification. It is NOT `opsAdminToken` above: that one is
   * a machine credential on a header for global ops writes; this one names
   * people who are already signed in with their own account. Default empty =
   * nobody, so a deployment that never sets it simply has no operator plane
   * rather than an implicitly privileged first user.
   *
   * Both are read at REQUEST time off this object (never re-snapshotted), which
   * is what lets a test flip them the way S1.6's suite flips `google`.
   */
  signupMode: signupMode() as 'open' | 'invite',
  operatorEmails: csvLower('OPERATOR_EMAILS'),

  // Dashboard/user auth (JWT). Always override the secret in production.
  jwtSecret: process.env.JWT_SECRET ?? 'dev-jwt-secret-change-me',
  accessTokenTtl: process.env.ACCESS_TOKEN_TTL ?? '15m',
  refreshTokenTtl: process.env.REFRESH_TOKEN_TTL ?? '7d',

  workerMetricsPort: int('WORKER_METRICS_PORT', 3002),

  otel: {
    enabled: (process.env.OTEL_ENABLED ?? 'false') === 'true',
    endpoint: process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? 'http://localhost:4318',
  },

  clickhouse: {
    enabled: (process.env.CLICKHOUSE_ENABLED ?? 'true') === 'true',
    url: process.env.CLICKHOUSE_URL ?? 'http://localhost:8123',
    database: process.env.CLICKHOUSE_DB ?? 'notifications',
    user: process.env.CLICKHOUSE_USER ?? 'default',
    password: process.env.CLICKHOUSE_PASSWORD ?? 'clickhouse',
  },
};
