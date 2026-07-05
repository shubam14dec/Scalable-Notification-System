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

export const env = {
  port: int('PORT', 3000),

  databaseUrl:
    process.env.DATABASE_URL ??
    'postgres://postgres:postgres@localhost:5432/notifications',

  redisHost: process.env.REDIS_HOST ?? 'localhost',
  redisPort: int('REDIS_PORT', 6379),

  smtpHost: process.env.SMTP_HOST ?? 'localhost',
  smtpPort: int('SMTP_PORT', 1025),
  smtpFrom: process.env.SMTP_FROM ?? 'notifications@example.com',

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

  // Master key for encrypting provider credentials at rest (AES-256-GCM).
  // Always override in production; source from KMS/secret manager.
  credentialsEncryptionKey:
    process.env.CREDENTIALS_ENCRYPTION_KEY ?? 'dev-credentials-key-change-me',

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
