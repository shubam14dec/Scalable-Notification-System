import { env } from '../config/env';
import type { ExecLogEntry } from '../db/repositories';

/**
 * Minimal ClickHouse client over its HTTP interface (port 8123) — batch
 * inserts and analytics queries need nothing more, so no extra dependency.
 *
 * Ingestion follows ClickHouse's one hard rule: BATCHES, never row-at-a-time
 * inserts (each insert creates an on-disk part; tiny inserts drown the
 * background merger). Our Redis-buffer -> batch-flush log writer already
 * produces exactly that shape.
 */

const DB = env.clickhouse.database;

async function chExec(query: string, body?: string): Promise<string> {
  const url = new URL(env.clickhouse.url);
  url.searchParams.set('query', query);
  // Accept ISO-8601 timestamps in JSONEachRow input.
  url.searchParams.set('date_time_input_format', 'best_effort');

  const res = await fetch(url, {
    method: 'POST',
    body: body ?? '',
    headers: {
      'X-ClickHouse-User': env.clickhouse.user,
      'X-ClickHouse-Key': env.clickhouse.password,
    },
  });
  if (!res.ok) {
    throw new Error(`clickhouse ${res.status}: ${(await res.text()).slice(0, 500)}`);
  }
  return res.text();
}

export function chEnabled(): boolean {
  return env.clickhouse.enabled;
}

/** Idempotent DDL — called from `npm run migrate`. */
export async function chMigrate(): Promise<void> {
  await chExec(`CREATE DATABASE IF NOT EXISTS ${DB}`);
  await chExec(`
    CREATE TABLE IF NOT EXISTS ${DB}.execution_logs
    (
      tenant_id       String,
      transaction_id  String,
      message_id      String,
      level           LowCardinality(String),
      detail          String,
      raw             String,
      created_at      DateTime64(3) DEFAULT now64(3) CODEC(DoubleDelta, ZSTD),
      INDEX idx_txn transaction_id TYPE bloom_filter GRANULARITY 4
    )
    ENGINE = MergeTree
    PARTITION BY toYYYYMM(created_at)
    ORDER BY (tenant_id, created_at)
    TTL toDateTime(created_at) + INTERVAL 90 DAY
  `);
}

export async function chInsertLogs(entries: ExecLogEntry[]): Promise<void> {
  if (entries.length === 0) return;
  const rows = entries
    .map((e) =>
      JSON.stringify({
        tenant_id: e.tenantId ?? '',
        transaction_id: e.transactionId ?? '',
        message_id: e.messageId ?? '',
        level: e.level,
        detail: e.detail,
        raw: e.raw === undefined ? '' : JSON.stringify(e.raw),
        created_at: e.at ?? new Date().toISOString(),
      }),
    )
    .join('\n');
  await chExec(`INSERT INTO ${DB}.execution_logs FORMAT JSONEachRow`, rows);
}

/** Run a SELECT and return parsed rows (query must NOT include FORMAT). */
export async function chQuery<T = Record<string, unknown>>(select: string): Promise<T[]> {
  const text = await chExec(`${select} FORMAT JSON`);
  const parsed = JSON.parse(text) as { data: T[] };
  return parsed.data;
}

export function chLogStatsQuery(): string {
  return `
    SELECT level, count() AS count, max(created_at) AS latest
    FROM ${DB}.execution_logs
    WHERE created_at > now() - INTERVAL 1 DAY
    GROUP BY level
    ORDER BY count DESC
  `;
}
