# Asyncify

Notification infrastructure — a horizontally scalable, multi-channel
notification platform built from scratch. Design informed by the
architecture of production notification systems operating at very large
scale.

SDKs: [`@asyncify-hq/node`](packages/sdk-node) ·
[`@asyncify-hq/react`](packages/react) (drop-in `<NotificationInbox />`).

**Channels:** email, SMS, push, in-app (live WebSocket push + durable inbox) —
extensible via one provider interface.

## How it works — the simple version

Your app makes **one API call**; Asyncify figures out *who* to notify, on
*which channels*, and delivers it reliably — even when providers fail or a
million people need the same message.

The core trick is that **the caller never waits for the slow part**. It works
like a restaurant: the waiter takes your order, hands you a token, and walks
away — the kitchen cooks in the background. In code: the API writes the
request down, replies `202 Accepted` in milliseconds, and queues do the rest.

A request passes through six hands:

1. **Your app triggers an event.**
   *One-liner: "Ana's order shipped → run the `order-shipped` workflow for her."*
2. **The API accepts it (fast).** It checks your API key, checks you're not
   over your rate limit, ignores duplicates (same `transactionId` twice =
   sent once), saves the event, and replies immediately.
   *One-liner: "Got it, here's your receipt (`transactionId`) — check back anytime."*
3. **The trigger worker works out the audience.** A direct list, a **topic**
   (a named group), or literally everyone (broadcast) — sliced into batches
   of 100 so no single job is huge.
   *One-liner: "'Everyone following repo X' → 40,000 people → 400 small jobs."*
4. **The fan-out worker turns one event into individual messages.** Per
   person, per channel, per workflow step — skipping anyone on the
   suppression list (bounced/complained), applying the workflow's rules
   (conditions, delays, digest windows), and locking in the template version.
   *One-liner: "Ana gets an email now and a push in 10 minutes unless she reads the email first."*
5. **Delivery queues, sorted by channel and priority.** Twelve separate
   lanes (email/SMS/push/in-app × P0/P1/P2) — like an airport fast-track,
   an urgent OTP never stands behind a marketing blast.
   *One-liner: "Login codes ride P0; the newsletter rides P2; they never share a lane."*
6. **The delivery worker actually sends it.** Renders the template, calls
   *your* configured provider (SendGrid, Twilio, FCM…), retries on hiccups,
   fails over to your backup provider, and parks hopeless jobs in a
   dead-letter queue for replay.
   *One-liner: "SendGrid is down? The same email leaves via SMTP ten seconds later."*

Then the world reports back: providers send webhooks ("delivered" /
"bounced"), email opens fire a tracking pixel, and every message's full
story is readable at `/v1/events/:transactionId/timeline`.

**Words you'll see everywhere** (one line each):

| Word | Meaning |
|---|---|
| **Workflow** | A recipe: which channels, in what order, with what rules ("email, wait 10m, then push"). |
| **Subscriber** | A person you notify (their email, phone, device tokens, preferences). |
| **Topic** | A named group of subscribers you can target with one call. |
| **Integration** | Your provider account (e.g. SendGrid key) stored encrypted; chains give you failover. |
| **Template** | Versioned MJML email design; in-flight messages keep the version they started with. |
| **Digest** | "Don't send 30 emails in an hour — send one summary." |
| **Suppression list** | Addresses that bounced or complained; we never send to them again automatically. |
| **Queue / worker** | The waiting line (Redis) and the process that takes jobs off it. Scale = add more workers. |
| **Idempotency** | Safe retries: sending the same request twice can never create two notifications. |

The diagram below is the same story with every component named.

## Architecture

```
POST /v1/events/trigger  ──202──▶ caller gets transactionId immediately
        │  validate · rate-limit (per tenant) · dedupe (transactionId) · persist
        ▼
   [trigger queue]
        ▼
  trigger worker ── splits recipients into batches of 100
        ▼
   [fanout queue]
        ▼
  fanout worker ── upsert subscriber · preferences · render · persist message
        ▼
   [deliver.{email|sms|push|inapp}.{p0|p1|p2}]   ← 12 isolated queues
        ▼
  delivery workers ── per-tier concurrency · per-channel rate limiter
        │              circuit breaker + provider failover chain
        │              retries: exp backoff + jitter → dead-letter queue
        ▼
     providers (SMTP → log-fallback, sms-mock, push-mock, in-app)

  in-app: message row IS the inbox (durable) ─▶ Redis pub/sub (1 channel per
  subscriber) ─▶ WS gateway nodes (stateless, run N of them) ─▶ live sockets;
  online = 'delivered' receipt, offline = waits in inbox as 'sent'

  provider callbacks ─▶ [status-events] ─▶ status worker ─▶ message status
  all pipeline steps ─▶ Redis log buffer ─▶ batch writer ─▶ execution_logs
  dead jobs ─▶ [dead-letter] ─▶ scripts/replay-dlq.ts
```

### Engineering principles in the code

| Principle | Where |
|---|---|
| Accept fast, process async (202 + transactionId) | `src/api/routes/trigger.ts` |
| Priority isolation — P0/P1/P2 as **separate queues** per channel | `src/shared/queues.ts` |
| Bulkheads — per-channel queues + worker pools; per-tier concurrency | `src/workers/index.ts` |
| Per-tenant rate limiting (Redis, works across API replicas) | `src/api/rate-limit.ts` |
| Idempotency — transactionId dedupe (Redis + DB unique), idempotent fan-out, jobId-deduped enqueues, status guard on delivery | trigger route, `fanout.processor.ts`, schema |
| Retries — exponential backoff + jitter; permanent errors skip retries | `queues.ts`, `delivery.processor.ts` |
| Dead-letter queue + paced replay | `src/workers/dlq.ts`, `scripts/replay-dlq.ts` |
| Circuit breaker per provider + failover chain | `src/resilience/circuit-breaker.ts`, `src/providers/registry.ts` |
| Outbound pacing per channel (queue-global limiter) | `src/workers/index.ts` |
| Async batched audit writes (protects hot-path DB IOPS) | `src/core/execution-log.ts`, `src/workers/log-writer.ts` |
| Digest steps — N events in a window merge into ONE message | `fanout.processor.ts`, `delivery.processor.ts` (`renderDigest`) |
| Tenant overflow queue (burst QoS) — bursts above the soft limit are diverted and trickled back, not dropped or 429'd | `src/api/rate-limit.ts`, `src/workers/processors/overflow.processor.ts` |
| ClickHouse analytics store — execution logs dual-written in batches, TTL'd at 90 days | `src/analytics/clickhouse.ts`, `GET /ops/logs/stats` |
| Webhook signature verification (HMAC-SHA256 + timestamp anti-replay) | `src/api/webhook-signature.ts` |
| Bounce suppression — bounced/complained addresses are never sent to again | `status.processor.ts`, `fanout.processor.ts`, `/v1/suppressions` |
| Prometheus metrics per process (queue depths, deliveries, breaker states) | `src/shared/metrics.ts`, `GET /metrics` (api :3000, worker :3002) |
| Kubernetes: Helm chart + KEDA autoscaling on BullMQ queue depth | `Dockerfile`, `deploy/helm/notification-system/` |
| OpenTelemetry tracing — one trace per trigger across api + workers (context carried in job payloads) | `src/shared/tracing.ts`, Jaeger UI :16686 |
| DR reconciler — rebuilds queue state from the Postgres outbox after a Redis wipe / region failover | `scripts/reconcile-events.ts`, [docs/MULTI-REGION.md](docs/MULTI-REGION.md) |
| Broadcast — one API call sends a workflow to ALL subscribers (server-side keyset paging, no recipient list over HTTP) | `POST /v1/events/broadcast`, `broadcastFanout` in `trigger.processor.ts` |
| Fan-out backpressure — broadcast paging pauses above FANOUT_HIGH_WATERMARK waiting jobs, so Redis memory stays flat for any blast size | `pipelineBacklog` in `queues.ts` |
| Batched fan-out — one multi-row insert + one suppression query + addBulk per batch | `insertMessagesBulk`, `suppressedSet`, `fanout.processor.ts` |
| Async status-callback ingestion (bounce storms can't slow the API) | `src/api/routes/webhooks.ts` |
| Queue-depth + breaker observability | `GET /ops/queues`, `GET /ops/breakers` |

## Quickstart

Requires Node 20+, Docker.

```bash
cd notification-system
docker compose up -d          # postgres, redis, mailpit (UI :8025), clickhouse (:8123)
npm install
cp .env.example .env
npm run migrate               # apply schema
npm run seed                  # dev tenant (api key: dev-api-key-123), workflows, subscribers

# in three terminals:
npm run api                   # http://localhost:3000
npm run worker                # the whole worker fleet
npm run ws                    # WebSocket gateway, ws://localhost:3001

# live in-app demo (fourth terminal):
npm run ws:client -- alice    # then trigger the welcome workflow for alice
```

Send a notification:

```bash
curl -X POST http://localhost:3000/v1/events/trigger \
  -H "content-type: application/json" -H "x-api-key: dev-api-key-123" \
  -d '{
    "workflowKey": "welcome",
    "priority": "p1",
    "to": [{"subscriberId": "alice", "email": "alice@example.com"}],
    "payload": {"name": "Alice", "company": "Acme"}
  }'
```

Check delivery status (use the returned transactionId):

```bash
curl -H "x-api-key: dev-api-key-123" http://localhost:3000/v1/events/<transactionId>
```

The email appears in Mailpit at http://localhost:8025.

### Try the failure modes

```bash
# watch retries, circuit breaking and failover: make SMTP fail 70% of the time
EMAIL_CHAOS_RATE=0.7 npm run worker
curl http://localhost:3000/ops/breakers       # breaker states
npm run loadtest -- 200                       # burst 200 events, watch queues drain
curl http://localhost:3000/ops/queues         # live queue depths
npm run dlq:replay                            # re-inject dead-lettered jobs

# digest demo: 3 events inside the 15s window -> ONE combined message
curl -X POST http://localhost:3000/v1/events/trigger \
  -H "content-type: application/json" -H "x-api-key: dev-api-key-123" \
  -d '{"workflowKey":"activity-digest","to":[{"subscriberId":"alice","email":"alice@example.com"}],"payload":{"actor":"sam","action":"commented"}}'
# (repeat 2-3x quickly, then wait 15s and check Mailpit / the inbox)

curl http://localhost:3000/ops/logs/stats     # log analytics from ClickHouse

# distributed tracing: open http://localhost:16686 (Jaeger), service
# "notification-api" — every trigger is one trace across api + workers

npm run reconcile                             # DR drill: settle finished events,
                                              # replay any stuck ones from Postgres
```

## API

| Method | Path | Purpose |
|---|---|---|
| POST | `/v1/events/trigger` | Fire a notification event (202 + transactionId) |
| POST | `/v1/events/broadcast` | Send a workflow to every subscriber (defaults to p2) |
| GET | `/v1/events/:transactionId` | Event + per-message delivery status |
| PUT | `/v1/subscribers` | Upsert a subscriber |
| PUT | `/v1/workflows` | Upsert a workflow (steps per channel) |
| GET | `/v1/inbox/:subscriberId` | In-app inbox + unread count |
| POST | `/v1/inbox/:subscriberId/read` | Mark inbox messages read (all, or by ids) |
| WS | `ws://:3001/?apiKey=...&subscriberId=...` | Live in-app push |
| POST | `/webhooks/providers/:provider` | Provider delivery-status callbacks |
| GET | `/health` | Liveness (Postgres + Redis) |
| GET | `/ops/queues` | Waiting/active/delayed/failed per queue |
| GET | `/ops/breakers` | Circuit-breaker states |

Auth: `x-api-key` header on all `/v1/*` routes.

## Scaling playbook

- **More throughput:** run more `npm run worker` processes (any number of
  machines) — BullMQ coordinates via Redis; the per-channel `limiter` and all
  rate limits hold globally. Scale the API the same way behind any LB.
  (Run extra local workers with distinct `WORKER_METRICS_PORT`s.)
- **Dedicated transactional lane:** `WORKER_TIERS=p0` pins a worker process
  to P0-only delivery. Measured effect (`scripts/github-sim.ts`, 20 events/s
  sustained + P0 OTPs): one shared process saturated at p50 15s with OTPs at
  5.5s; a 3-process fleet (1x p0, 2x p1+p2) held the stream at p50 2.2s and
  OTPs at **p50 0.54s** under the same load.
- **Kubernetes:** build the `Dockerfile`, then
  `helm install notif deploy/helm/notification-system` — one image, three
  Deployments (api / worker / ws). The included KEDA `ScaledObject` scales the
  worker fleet 1→20 replicas on BullMQ waiting-list length (`bull:<q>:wait`),
  checked every 5s across all 16 queues. Requires [KEDA](https://keda.sh) in
  the cluster; set `keda.enabled=false` for plain replicas.
- **Autoscaling signal:** `/ops/queues` (JSON) or the `notif_queue_jobs`
  Prometheus gauge — every process exports `/metrics` (api :3000,
  worker :3002 by default).
- **Selective scaling:** worker tiers are just env config — run dedicated
  P0-only processes by setting `DELIVERY_CONCURRENCY_P1=0`/`P2=0` on them.
- **When Redis becomes the bottleneck (~tens of k jobs/sec):** move trigger
  ingestion + the execution-log stream to Kafka partitioned by tenant; keep
  BullMQ for delay/digest scheduling.

## Database choices (why these)

- **PostgreSQL — system of record** (tenants, subscribers, workflows, events,
  messages). ACID + unique constraints give idempotency guarantees for free
  (`events(tenant_id, transaction_id)`, `messages(event, subscriber, channel,
  step)`); JSONB covers the flexible payloads people pick Mongo for. Scales
  with read replicas + time-partitioning of `messages`/`execution_logs`.
- **Redis — everything hot and ephemeral:** queues (BullMQ), rate-limit
  windows, dedupe keys, the log buffer. Never the system of record.
- **ClickHouse — wired in for execution-log analytics** (per-step audit rows
  are ~10-50x message volume): append-only, columnar, native 90-day TTL.
  Logs are dual-written (Postgres keeps a copy; a ClickHouse hiccup is a
  warning, never data loss). Full deep-dive: [docs/CLICKHOUSE.md](docs/CLICKHOUSE.md).
- Further out: **Kafka** for ingestion buffering, **Cassandra/ScyllaDB** only
  if the message store outgrows partitioned Postgres.

## License

MIT — see [LICENSE](LICENSE).

## Status

All items from the original architecture plan are built and verified. The
multi-region / disaster-recovery strategy (staged: multi-AZ → warm standby →
tenant-pinned active-active) is documented in
[docs/MULTI-REGION.md](docs/MULTI-REGION.md); the only code it required — the
outbox reconciler — ships as `npm run reconcile`.
