# Novu Codebase — Scalability Gap Analysis & Additions Roadmap

Based on a code-level audit of the Novu monorepo (`novu/`), compared against the target
architecture in `ARCHITECTURE.md` and Razorpay's notification-service scaling lessons.

---

## A. What Novu already has (don't rebuild these)

| Capability | Where |
|---|---|
| Queue chain: `trigger-handler` → `process-subscriber` → `standard` → `ws_socket_queue` | `packages/shared/src/config/job-queue.ts`, `libs/application-generic/src/services/queues/` |
| Subscriber fan-out batched 100/job | `libs/application-generic/src/usecases/trigger-base/trigger-base.usecase.ts:47-72` |
| Env-tunable worker concurrency (defaults 200–400/worker) | `libs/application-generic/src/config/workers.ts` |
| API rate limiting: per org+env+category token bucket (Redis Lua) | `apps/api/src/app/rate-limiting/` |
| Idempotency-Key header support (Redis, 24h replay) | `apps/api/src/app/shared/framework/idempotency.interceptor.ts` |
| Delay/digest/throttle steps via BullMQ delayed jobs | `apps/worker/src/app/workflow/usecases/add-job/add-job.usecase.ts` |
| Multi-node WebSockets (`@socket.io/redis-adapter`) | `apps/ws/src/shared/framework/in-memory-io.adapter.ts` |
| Provider status webhook ingestion service | `apps/webhook/` |
| Queue-depth metrics every 30s (waiting/active/delayed → OTel/New Relic) | `apps/worker/src/app/workflow/services/active-jobs-metric.service.ts` |
| Redis Cluster / ElastiCache / MemoryDB support | `libs/application-generic/src/services/in-memory-provider/` |
| Extensive Mongo compound + partial indexes | `libs/dal/src/repositories/*` |

---

## B. Gaps — what to ADD (prioritized)

### P1 — Highest impact on scalability

#### 1. Priority queues / traffic-class separation (Razorpay P0/P1/P2)
- **Finding:** BullMQ's `priority` option is never set anywhere. All traffic — OTPs and
  million-subscriber marketing blasts — shares the same `trigger-handler`, `process-subscriber`
  and `standard` queues. A bulk campaign ahead of an OTP delays the OTP.
- **Add:**
  - Accept a `priority` field on the trigger API (`parse-event-request.usecase.ts`).
  - Either set BullMQ `priority` on job add (quick win, one shared queue), or better:
    split into `standard.p0 / standard.p1 / standard.p2` queues with dedicated worker
    pools per tier (true bulkhead — a P2 backlog can't consume P0 worker slots).
  - Route bulk-trigger endpoint traffic to P2 by default.
- **Touch points:** `job-queue.ts` enum, `queue-base.service.ts`, `add-job.usecase.ts:1061-1097`,
  `worker-init.config.ts`.

#### 2. Async execution-log writes (Razorpay's #1 bottleneck: DB IOPS)
- **Finding:** `CreateExecutionDetails` writes to MongoDB synchronously, inline, per-detail,
  from every worker step (`libs/application-generic/src/usecases/create-execution-details/`).
  Under load, workers burn DB IOPS on audit writes and slow down actual sends. (ClickHouse
  trace path already supports async/batched insert — Mongo path does not.)
- **Add:** a new `execution-logs` BullMQ queue (or reuse the ClickHouse batch service pattern).
  Workers enqueue log entries fire-and-forget; a dedicated low-priority consumer batch-inserts
  into Mongo (`insertMany`, e.g. 500/batch or 1s flush). Feature-flag it like the existing
  `IS_EXECUTION_DETAILS_CLICKHOUSE_ONLY_ENABLED` flag.
- **Touch points:** new queue service in `services/queues/`, new consumer in `apps/worker`,
  swap the repository call in `create-execution-details.usecase.ts`.

#### 3. Dead-letter queue + replay on the BullMQ path
- **Finding:** `removeOnFail: true` everywhere; after max attempts a job is just marked FAILED
  in Mongo (`standard.worker.ts:230-286`). No DLQ, no replay tooling. (DLQ semantics exist
  only on the SQS/cloud path via infra RedrivePolicy.)
- **Add:** on final failure, push the job payload to a `{queue}-dlq` BullMQ queue with failure
  metadata; add a scheduler/CLI to inspect and re-inject DLQ jobs at a controlled pace; alert
  on DLQ depth via the existing metrics service.
- **Touch points:** `worker-base.service.ts` failed handler, `standard.worker.ts:jobHasFailed`.

#### 4. Retries with exponential backoff for provider sends
- **Finding:** default job options carry no `attempts` — most jobs effectively get **1 attempt**.
  Retry (3 attempts, custom backoff) is only wired for webhook-filter steps
  (`add-job.usecase.ts:1072-1080`) and inbound mail parse (5 attempts, exponential).
  A transient SendGrid 500 = notification failed.
- **Add:** `attempts: 3-5, backoff: { type: 'exponential', delay: 2000 }` (+ jitter) on
  send-message jobs; classify provider errors (retryable 429/5xx/timeouts vs permanent
  4xx bad-address) — reuse the `isPermanentClientError` logic from
  `worker-base.service.ts:40-52` on the BullMQ path, not just SQS.

### P2 — Resilience under real-world provider failures

#### 5. Circuit breaker + provider failover
- **Finding:** no circuit breaker exists in the repo; `select-integration.usecase.ts` picks the
  single `primary: true` integration and retries failures against the *same* provider. A
  SendGrid outage stalls email entirely until humans switch the primary.
- **Add:** wrap provider `send()` in a breaker (e.g. `opossum`: open after N failures/error-rate,
  half-open probes). On open breaker, fall back to the next active integration of the same
  channel (add a `fallbackOrder` to integrations). Emit breaker state as a metric.
- **Touch points:** `send-message.base.ts` (`getIntegration` / send path),
  `select-integration.usecase.ts`, integration entity in `libs/dal`.

#### 6. Outbound per-provider rate limiting
- **Finding:** nothing paces calls to a provider's API (Twilio TPS caps, SES quotas) except
  worker concurrency. The workflow Throttle step is per-subscriber/user-configured, not a
  global provider limiter. 200-concurrency workers can trivially blow a Twilio TPS cap →
  429 storms → (with #4) retry storms.
- **Add:** per-integration token bucket (reuse the existing Redis Lua token-bucket from
  `evaluate-token-bucket-rate-limit.usecase.ts`) or BullMQ's built-in `limiter` on
  channel-specific worker groups; configurable `rateLimit` field on the integration.

#### 7. transactionId dedupe on trigger
- **Finding:** a caller-supplied `transactionId` is used for tracking/naming but never checked
  for duplicates — the same event triggered twice sends twice. Only the optional
  `Idempotency-Key` header dedupes.
- **Add:** Redis `SETNX transactionId:{env}:{txId}` with TTL in `parse-event-request.usecase.ts`;
  reject or short-circuit duplicates.

### P3 — Tenant isolation & operations

#### 8. Per-tenant fair-share / overflow isolation (open-source path)
- **Finding:** BullMQ **Pro** groups (`groupId: organizationId`) provide org fair-sharing, but
  only when `NOVU_MANAGED_SERVICE` is set (Novu Cloud). Self-hosted/OSS deployments have no
  protection against one org flooding the shared queues.
- **Add:** per-org in-flight caps (Redis counter checked at fan-out), and/or a `rate-limited`
  overflow queue: when an org exceeds its trigger budget, divert its jobs there and re-inject
  at a trickle (Razorpay's pattern). Optionally QoS demotion: orgs whose webhook endpoints
  respond slowly get temporarily demoted to P2.

#### 9. Autoscaling manifests (KEDA on queue depth)
- **Finding:** only Docker Compose with single pinned containers; no K8s/Helm/KEDA/HPA anywhere.
  Queue-depth metrics already exist — nothing consumes them for scaling.
- **Add:** Helm chart with per-worker Deployments (`ACTIVE_WORKERS` env already supports
  running one worker type per pod) + KEDA `ScaledObject`s on Redis list length / OTel queue
  metrics: scale `standard` workers on `standard` queue depth, WS workers on socket queue, etc.

#### 10. Data lifecycle for self-hosted Mongo
- **Finding:** no TTL indexes, no sharding config; archival is delegated to MongoDB Atlas
  Online Archive (cloud-only). Self-hosted installs grow `messages`/`jobs`/`executiondetails`
  unboundedly, degrading the very indexes the hot path relies on.
- **Add:** TTL indexes (`expireAfterSeconds`) or a scheduled pruning/archival job with
  configurable retention per collection (e.g. execution details 30d, jobs 90d).

#### 11. Queue operations visibility
- **Finding:** metrics are push-only (New Relic/OTel); no queue dashboard, no DLQ browser.
- **Add:** Bull Board (or similar) mounted behind admin auth for waiting/active/failed/DLQ
  inspection and manual retry; alert rules on queue **age** (oldest-job wait time), not just depth.

#### 12. Async status-webhook ingestion
- **Finding:** `apps/webhook` processes provider delivery callbacks synchronously in the HTTP
  request. A bounce storm (big campaign → bad list) spikes latency and can drop provider callbacks.
- **Add:** controller enqueues raw callback to a `status-events` queue and returns 200
  immediately; a worker parses and applies status updates (batched Mongo writes, same
  pattern as #2).

---

## C. Suggested execution order

| Phase | Items | Rationale |
|---|---|---|
| 1 | #4 retries, #7 txId dedupe, #3 DLQ | Small, self-contained, immediately improves reliability |
| 2 | #1 priority queues, #2 async execution logs | The two biggest scalability wins (Razorpay's exact fixes) |
| 3 | #5 circuit breaker + failover, #6 provider rate limiter | Provider-outage resilience |
| 4 | #8 tenant isolation, #9 KEDA autoscaling, #10 TTL, #11 Bull Board, #12 async webhooks | Operate at scale, multi-tenant hardening |
