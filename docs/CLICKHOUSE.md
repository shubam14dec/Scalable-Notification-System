# ClickHouse for Execution Logs — Deep Dive

Why, when, and how to move this system's `execution_logs` (and message analytics)
from Postgres to ClickHouse.

---

## 1. The problem ClickHouse solves

Every notification produces **10–50× more audit rows than message rows**: accepted,
fan-out, queued per step, each send attempt, each provider callback. At 1M
notifications/day that's easily 20–50M log rows/day, ~1B/month. These rows are:

- **append-only** — never updated, never deleted individually
- **write-heavy, read-rarely** — written constantly, queried only for debugging
  ("why didn't user X get the email?") and analytics (success rate per provider)
- **queried by scan + aggregate** — "p99 send latency per channel last 7 days"
  touches millions of rows but only 2–3 columns

This is exactly the workload row-store OLTP databases (Postgres, MongoDB) are worst
at, and exactly what a **columnar OLAP** store is built for. It's why large
notification platforms move their trace logs to columnar stores or stream them
into data lakes instead of writing them to their OLTP databases.

## 2. Why Postgres eventually breaks on this workload

| Pressure point | What happens at ~1B rows |
|---|---|
| B-tree index maintenance | Every insert updates every index; write amplification grows with table size; insert throughput sags |
| Storage | Row storage + indexes ≈ 200–500 bytes/row → hundreds of GB fast; ClickHouse compresses the same data 10–30× |
| VACUUM / bloat | Even append-only tables need vacuum for transaction-id wraparound; giant tables make it painful |
| Analytics queries | `GROUP BY provider, day` over 30 days = scanning hundreds of GB of rows to read 3 columns |
| The real killer | Log I/O competes with the **hot path** (messages/events tables) for the same disk IOPS and buffer cache — the classic notification-platform bottleneck in a different costume |

Batched inserts (which we already do) delay this wall; they don't remove it.

## 3. How ClickHouse works (the parts that matter here)

- **Columnar storage:** each column is stored (and compressed) separately. A query
  reading `status` and `created_at` touches only those two column files —
  a few GB instead of hundreds.
- **MergeTree engine:** inserts write immutable sorted "parts"; background threads
  merge them. Sequential I/O only — sustained **hundreds of thousands to millions of
  rows/sec** on one node. No B-trees to update.
- **Sparse primary index:** one index mark per ~8192 rows. Tiny, always in memory,
  perfect for range scans on `(tenant, time)`; useless for point lookups —
  which is fine, that's what Postgres remains for.
- **Compression:** columns of similar values (statuses, provider names, timestamps)
  compress brutally well — 10–30× typical, more with per-column codecs
  (`DoubleDelta` for timestamps, `LowCardinality` for enums).
- **Native TTL:** `TTL created_at + INTERVAL 90 DAY` — old data removed by
  background merges. Free retention policy, no cron jobs, no `DELETE` storms.
- **What it does NOT do:** no real UPDATE/DELETE, no transactions, weak point
  lookups, mediocre JOINs, and it **hates tiny inserts** (each insert = a new
  part on disk; thousands of one-row inserts/sec will crush the merge process).

That last point is why our architecture is already ClickHouse-shaped: the
Redis-buffer → batch-writer pattern in `src/workers/log-writer.ts` is precisely
the ingestion pattern ClickHouse wants.

## 4. The schema (drop-in for our execution_logs)

```sql
CREATE TABLE execution_logs
(
    tenant_id       UUID,
    transaction_id  String,
    message_id      Nullable(UUID),
    level           LowCardinality(String),          -- 'info' | 'warn' | 'error'
    detail          String,
    raw             String,                          -- JSON as string; JSON type also an option
    created_at      DateTime64(3) CODEC(DoubleDelta, ZSTD)
)
ENGINE = MergeTree
PARTITION BY toYYYYMM(created_at)                    -- drop whole months instantly
ORDER BY (tenant_id, created_at, transaction_id)     -- the sort/index key
TTL toDateTime(created_at) + INTERVAL 90 DAY         -- automatic retention
SETTINGS index_granularity = 8192;

-- Point-ish lookups by transaction ("why didn't user X get the email?")
-- stay fast thanks to a skip index:
ALTER TABLE execution_logs
  ADD INDEX idx_txn transaction_id TYPE bloom_filter GRANULARITY 4;
```

Design choices:
- `ORDER BY (tenant_id, created_at, ...)` clusters each tenant's timeline
  together → tenant-scoped time-range queries read almost nothing else.
- `PARTITION BY` month → `ALTER TABLE ... DROP PARTITION` deletes a month in
  milliseconds if you ever need manual cleanup or GDPR-style purges.
- `LowCardinality(String)` dictionary-encodes repetitive values (levels,
  provider names) — big compression + speed win.

## 5. Ingestion: three patterns, in order of adoption

1. **Batch INSERT from our log-writer (start here).** Keep the exact
   Redis-buffer flow; the writer flushes 500–5000 rows per insert to ClickHouse
   over HTTP instead of (or alongside) Postgres. One code change behind a flag.
2. **`async_insert=1`.** ClickHouse buffers small inserts server-side and flushes
   them itself (`wait_for_async_insert=0` for fire-and-forget). Lets many
   writers insert without coordinating batches.
3. **Kafka → ClickHouse (at very high scale).** Workers produce log events to a
   Kafka topic; ClickHouse consumes via a Kafka engine table + materialized view.
   Gives you replay, backpressure isolation, and multiple consumers (data lake,
   alerting) from the same stream. This pairs with the "move ingestion to Kafka"
   step in the scaling roadmap — same topic infrastructure, two uses.

## 6. What the queries look like

```sql
-- Delivery success rate per provider, last 7 days (runs in ms over billions of rows)
SELECT provider,
       countIf(status = 'delivered') / count() AS delivery_rate
FROM message_events
WHERE created_at > now() - INTERVAL 7 DAY
GROUP BY provider;

-- p50/p95/p99 time from accepted to sent, per channel, per day
SELECT toDate(created_at) AS day, channel,
       quantiles(0.5, 0.95, 0.99)(sent_ms - accepted_ms) AS latency
FROM notification_timings
GROUP BY day, channel ORDER BY day;

-- Everything that happened to one notification (bloom filter makes this cheap)
SELECT created_at, level, detail
FROM execution_logs
WHERE transaction_id = 'inapp-test-1'
ORDER BY created_at;
```

Add a `SummingMergeTree`/`AggregatingMergeTree` **materialized view** for the
dashboard counters (sends per tenant per hour, etc.) and those queries become
reads of pre-aggregated rows — effectively free.

## 7. Division of labor (nothing breaks because nothing is misused)

| Store | Owns | Never asked to do |
|---|---|---|
| **Postgres** | Source of truth: tenants, subscribers, workflows, events, messages, read/unread. Transactions + unique constraints = idempotency. | Mass analytics scans, unbounded log growth |
| **Redis** | Queues, rate limits, dedupe keys, log buffer, in-app pub/sub | Being a system of record |
| **ClickHouse** | Execution logs, delivery analytics, dashboards, long-tail debugging history | Point updates, transactional writes, hot-path reads |

## 8. When to actually adopt it (signals, not vibes)

Adopt ClickHouse when **any** of these appear:
- `execution_logs` in Postgres exceeds ~100–200 GB or ~500M rows
- log inserts measurably compete with message-table IOPS (rising p99 on the send path)
- analytics/debug queries take seconds+ or need aggressive pre-aggregation
- you need >30–90 days of history without paying row-store prices for it

Until then, batched Postgres inserts (what we built) are the right call —
one less system to operate. The migration is cheap later precisely because
the write path is already batch-shaped and behind one function
(`insertExecutionLogs`).
