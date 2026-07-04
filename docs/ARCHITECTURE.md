# Scalable Notification System — High-Level Architecture Plan

Reference systems: **Novu** (open-source notification infrastructure) and **Razorpay's notification service** (engineering blog on handling increasing load).

---

## 1. Goals & Non-Functional Requirements

| Requirement | Target |
|---|---|
| Channels | Email, SMS, Push, In-App, Chat/Webhook (extensible) |
| Delivery semantics | At-least-once, with idempotency to make it effectively exactly-once |
| Latency SLO | P0 (OTP/transactional): < 2s enqueue-to-provider; P2 (bulk): best-effort |
| Throughput | Designed to scale horizontally; no single component is a bottleneck |
| Isolation | One slow channel/provider/tenant must never block others |
| Durability | No notification lost after API returns 202 |

## 2. Core Engineering Principles Applied

1. **Accept fast, process async** — the API only validates, persists, enqueues, and returns `202 Accepted` with a `transactionId`. All real work happens in workers.
2. **Bulkhead pattern** — separate queue + worker pool per channel. A Twilio outage must not delay emails.
3. **Priority segregation (Razorpay P0/P1/P2)** — separate physical queues per priority, not just priority flags. Bulk campaigns can never starve OTPs.
4. **Backpressure & rate limiting** — per-tenant and per-provider rate limits; violators are diverted to an overflow queue instead of clogging the main path.
5. **Async writes for hot paths (Razorpay learning)** — execution logs/status updates go through a stream (Kafka/Kinesis/BullMQ) and are batch-written to the DB. DB IOPS was Razorpay's #1 bottleneck.
6. **Idempotency everywhere** — `transactionId` + step-level idempotency keys; retries never double-send.
7. **Retries with exponential backoff + jitter → DLQ** — bounded attempts, then dead-letter queue with alerting and a replay scheduler.
8. **Circuit breakers on providers** — trip on error-rate/latency, fail over to secondary provider (e.g., SendGrid → SES).
9. **Autoscale on queue depth** — workers are stateless; scale on lag (KEDA/HPA), not CPU.
10. **Outbox pattern** — DB write + enqueue happen atomically so no event is lost between "saved" and "queued".

## 3. High-Level Architecture

```
 Clients / Services
        │  POST /v1/events/trigger  (202 + transactionId)
        ▼
 ┌─────────────┐     ┌──────────────────────────────────────────┐
 │  API Layer   │────▶│  Q1: trigger queue                       │
 │ (stateless)  │     └──────────────────────────────────────────┘
 └─────────────┘                    │
   validate, auth,                  ▼
   dedupe, outbox        ┌───────────────────┐
                         │ Workflow Engine    │  resolves workflow steps,
                         │ (orchestrator)     │  digest/delay, preferences
                         └───────────────────┘
                                    │
                                    ▼
                         ┌───────────────────┐
                         │ Q2: fan-out queue  │  1 event → N subscribers
                         └───────────────────┘  (batch subscribers, e.g. 100/job)
                                    │
          ┌──────────┬──────────────┼──────────────┬───────────┐
          ▼          ▼              ▼              ▼           ▼
      email.{p0,p1,p2}  sms.{p0,p1,p2}  push.{p0,p1,p2}  inapp   webhook
          │          │              │              │           │
          ▼          ▼              ▼              ▼           ▼
     Email workers  SMS workers  Push workers  WS service  Webhook workers
     (render + provider adapter + circuit breaker + provider failover)
          │          │              │              │           │
          └──────────┴──────┬───────┴──────────────┴───────────┘
                            ▼
              Q: execution-log stream ──▶ batch writer ──▶ DB / data lake
                            ▲
   Provider callbacks ──▶ Q: status-events queue (delivered/bounced/opened)
   Failed jobs ─────────▶ per-queue DLQ ──▶ replay scheduler + alerts
   Rate-limit breaches ─▶ Q: rate-limited (throttled re-injection)
```

## 4. The Queues (the heart of the system)

| Queue | Purpose | Why it exists |
|---|---|---|
| `trigger` | Raw incoming events from the API | Decouples ingestion from processing; absorbs spikes |
| `fan-out` (subscriber-process) | Expands 1 event → N subscriber jobs | Novu pattern; fan-out is CPU-heavy and must not block ingestion |
| `email.p0/p1/p2`, `sms.p0/p1/p2`, `push.p0/p1/p2`, `inapp`, `webhook` | Per-channel, per-priority delivery queues | Bulkhead + priority isolation (Razorpay's three-tier P0/P1/P2) |
| `delayed/digest` (scheduler-backed) | Delay steps, digest/batching windows | Time-based release, dedupe of noisy events into one digest |
| `rate-limited` | Overflow for tenants/events exceeding limits | Isolates misbehaving tenants (Razorpay's rate-limit queue) |
| `status-events` | Provider webhooks (delivered/bounced/failed/opened) | Async status ingestion; feeds retries and analytics |
| `execution-log` stream | All step logs / message state changes | Async batch DB writes — protects DB IOPS (Razorpay's Kinesis move) |
| `ws` | In-app real-time delivery to WebSocket gateway | Novu pattern; decouples socket fan-out |
| `*.dlq` (one per queue) | Exhausted-retry jobs | Alerting, inspection, controlled replay |

**Priority handling:** three physical queues per channel. Workers drain P0 first with dedicated capacity; P2 gets leftover/burst capacity. Razorpay's QoS twist: if a tenant's webhook endpoint responds slowly (> threshold), temporarily demote that tenant's priority so they can't degrade everyone else.

## 5. Component Responsibilities

- **API Layer** — auth (API keys/HMAC), schema validation, idempotency check on `transactionId`, write event via outbox, enqueue to `trigger`. Nothing else.
- **Workflow Engine** — loads the workflow definition (steps: send email → wait 1h → if unread, send push), evaluates conditions, digest/delay logic, checks **subscriber preferences** (opt-outs, quiet hours, channel preferences), emits channel jobs.
- **Channel Workers** — render template (variables + i18n), pick provider via adapter interface (`send(message) → providerMessageId`), enforce provider rate limits, circuit-break and fail over.
- **Provider Adapter Layer** — uniform interface per channel; providers are plug-ins: Email (SES/SendGrid/Postmark), SMS (Twilio/MSG91/SNS), Push (FCM/APNs), Chat (Slack/WhatsApp).
- **Status Processor** — consumes provider callbacks, updates message state, triggers bounce suppression lists.
- **WebSocket Gateway** — in-app channel; horizontally scalable with Redis pub/sub for cross-node delivery.
- **Scheduler** — releases delayed/digest jobs, replays DLQ/rate-limited jobs at controlled pace, detects stuck jobs.

## 6. Data Model (core entities)

- `workflows` — steps, channels, templates, digest/delay config
- `subscribers` — user identity, channel credentials (email, phone, device tokens), preferences
- `events` — raw triggers (transactionId, payload, tenant)
- `jobs` — per-step execution units (status: pending/queued/running/completed/failed/skipped)
- `messages` — the actual per-channel sends (provider, providerMessageId, delivery status timeline)
- `execution_logs` — append-only audit trail (written via the async stream; consider TTL/cold storage)

## 7. Technology Choices

**Phase 1 (pragmatic, Novu's own stack):**
- **Node.js/NestJS** services, **Redis + BullMQ** for all queues (priorities, delays, retries, rate limiting built in)
- **MongoDB** (Novu's choice) or **PostgreSQL** for state; **Redis** for cache/idempotency keys
- Docker + Kubernetes, KEDA autoscaling on queue depth

**Scale-up path (when Redis queue throughput or durability becomes the limit):**
- **Kafka** (or SQS like Razorpay) for `trigger` ingestion and `execution-log` stream — partitioned by tenant for ordering + hot-tenant isolation
- Keep BullMQ for delay/digest scheduling where it shines
- Read replicas + partitioning (by tenant/time) for the DB; archive old messages to a data lake

**Why not Kafka from day one?** BullMQ gives you retries, backoff, priorities, delayed jobs, and DLQ semantics out of the box; Kafka makes you build all of that. Start simple, keep the queue behind an interface so the broker is swappable.

## 8. Failure Handling Summary

| Failure | Handling |
|---|---|
| Provider down | Circuit breaker → failover provider → else retry with backoff → DLQ |
| Provider rate limit (429) | Token-bucket limiter per provider; delayed requeue, no retry burn |
| Tenant flooding | Per-tenant quota → divert to `rate-limited` queue → trickle re-inject |
| Slow tenant webhook | QoS demotion (Razorpay): lower that tenant's priority temporarily |
| DB under pressure | Execution logs via stream + batch writer; throttle writers, never workers |
| Worker crash mid-job | Queue visibility timeout / job lock expiry → job re-delivered (idempotent) |
| Duplicate trigger | `transactionId` idempotency check at API + step-level dedupe keys |

## 9. Observability

- **Metrics:** queue depth & age per queue (the #1 scaling signal), jobs/sec, provider latency & error rate, delivery success rate per channel/provider/tenant, DLQ size.
- **Tracing:** propagate `transactionId` through every queue hop (OpenTelemetry) — one trace from trigger to delivered.
- **Alerts:** queue age > SLO, DLQ growth, provider circuit open, tenant rate-limit diversions.
- **Execution log UI** (like Novu's activity feed): per-notification timeline for debugging "why didn't user X get the email?"

## 10. Phased Roadmap

**Phase 1 — MVP (walking skeleton, ~weeks 1–3)**
API trigger endpoint → `trigger` queue → single worker → email + SMS via one provider each. Retries + backoff + DLQ. Message/job persistence. Docker Compose dev setup.

**Phase 2 — Multi-channel + orchestration**
Workflow engine (multi-step), fan-out queue, subscriber registry + preferences, push (FCM/APNs), in-app + WebSocket gateway, templates with variables, delay + digest steps.

**Phase 3 — Scale & isolation (the Razorpay lessons)**
Per-channel per-priority queues (P0/P1/P2), per-tenant rate limiting + `rate-limited` overflow queue, provider failover + circuit breakers, async execution-log stream with batch DB writes, KEDA autoscaling on queue depth.

**Phase 4 — Hardening & platform**
Status webhooks from providers (delivered/bounced/opened), bounce suppression, analytics dashboard, QoS-based tenant priority demotion, Kafka migration for ingestion if throughput demands, multi-region/DR strategy.
