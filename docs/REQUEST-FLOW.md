# Anatomy of a Notification

> **Fully styled version:** open [`docs/request-flow.html`](request-flow.html)
> in a browser — the same page, with the dashboard's design system applied.
> GitHub strips custom styling from markdown, so this file draws the flow
> as monospace block diagrams instead.

Every component a request touches, end to end. The **(1)–(12)** trail follows
one concrete journey — your application sends an *order shipped* email — and
the same spine carries `sms`, `push` and `in-app`.

The one idea behind the whole design: **the caller never waits for the slow
part.** The API writes the request down, answers `202` in milliseconds, and
everything below happens in the background, stage by stage, connected by
queues.

**Legend** — **(n)** = the traced email request · every hop between stages is
a BullMQ queue on Redis · ⤷ = side path (overflow, digest, dead-letter).

**Words used below** — **queue**: a waiting line of jobs in Redis ·
**worker**: a process that takes jobs off a queue; more workers = more
throughput · **tenant**: one customer environment; every row, limit and queue
job is scoped to it · **outbox**: the permanent Postgres record everything can
be rebuilt from · **circuit breaker**: stop calling a provider that keeps
failing; try the next one.

## The diagram

Solid boxes = the traced email path (1)-(12), with queue names on the
connectors. Dashed boxes = side paths (overflow, digest window, dead-letter).

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ YOUR APPLICATION — the only code you write                                 │
│                                                                            │
│ (1) Your backend     @asyncify-hq/node · trigger('order-shipped', ...)     │
│     Your frontend    <NotificationInbox /> · nst_ token · live WebSocket   │
│     Dashboard :5173  workflows · templates · integrations · topics         │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │  POST /v1/events/trigger · x-api-key: ak_...
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ API — THE FRONT DOOR · Fastify :3000 · stateless, run N copies             │
│                                                                            │
│ (2) Authenticate       SHA-256 key lookup (60s cache) → org → tenant       │
│ (3) Tenant rate check  over soft limit ╌▶ overflow · 5x hard limit → 429   │
│ (4) Accept & persist   dedupe (tenant, transactionId) · event row →        │
│                        Postgres outbox · reply 202 in milliseconds         │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
                                      │    ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
                                      │    ┆ OVERFLOW QUEUE — side path                 ┆
                                      │◀╌╌ ┆ bursts over the soft limit divert here;    ┆
                                      │    ┆ trickled back once the tenant has budget   ┆
                                      │    └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
                                      │  [ trigger queue · BullMQ on Redis · jobId = evt-{transactionId} ]
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ (5) TRIGGER WORKER — resolve the audience · :3002                          │
│                                                                            │
│ direct list → chunked as-is · topic → members streamed page by page,       │
│ pausing when queues fill (backpressure) · broadcast → every subscriber     │
│ output: one fan-out job per 100 recipients                                 │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │  [ fanout queue ]
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ (6) FAN-OUT WORKER — one job becomes N messages                            │
│                                                                            │
│ upsert subscribers → drop suppressed (batch) → evaluate step conditions    │
│ → pin template version → insert message rows, unique on                    │
│ (event, subscriber, channel, step) → addBulk · jobId = messageId           │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
                                      │    ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
                                      │    ┆ DIGEST WINDOW — side path (Redis)          ┆
                                      │╌╌▶ ┆ digest steps park here; window closes →    ┆
                                      │◀╌╌ ┆ ONE summary message rejoins the lanes      ┆
                                      │    └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
                                      │  [ 12 delivery queues · channel × priority ]
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ (7) QUEUE PLANE — the email lands in its lane · Redis + BullMQ             │
│                                                                            │
│ email    [ p0 otp ]  [ p1 ← ours ]  [ p2 marketing ]                       │
│ sms      [ p0     ]  [ p1        ]  [ p2           ]                       │
│ push     [ p0     ]  [ p1        ]  [ p2           ]                       │
│ in-app   [ p0     ]  [ p1        ]  [ p2           ]                       │
│                                                                            │
│ p0 never waits behind p2 · WORKER_TIERS pins whole processes to a lane     │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ DELIVERY WORKER — the hot path: read → render → send → update ONE row      │
│                                                                            │
│ (8) prepare   status guard · delay · skip-if gate (opened/read?) ·         │
│               render pinned MJML template + tracking pixel                 │
│ (9) send      integration chain (sealed creds) · circuit breaker per       │
│               provider · retry with backoff · fail over to next            │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │
                                      │    ┌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┐
                                      │    ┆ DEAD-LETTER QUEUE — side path              ┆
                                      │╌╌▶ ┆ retries exhausted → parked here,           ┆
                                      │    ┆ held for replay, never lost                ┆
                                      │    └╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌┘
                                      │  (10)
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ CHANNELS & PROVIDERS — configured per environment (integration store)      │
│                                                                            │
│ email    SMTP · SendGrid · Resend     → recipient inbox (+ pixel)          │
│ sms      Twilio                       → phone                              │
│ push     FCM                          → device (dead tokens suppressed)    │
│ in-app   Postgres row + Redis pub/sub → WS :3001 → your widget, live       │
└─────────────────────────────────────┬──────────────────────────────────────┘
                                      │  webhooks: delivered / bounced (signed) · opens: GET /o/:id.gif
                                      ▼
┌────────────────────────────────────────────────────────────────────────────┐
│ FEEDBACK LOOP — closes the story on every message                          │
│                                                                            │
│ (11) status-events queue → status worker → delivered / bounced →           │
│      suppression list (read again at step 6) · open pixel →                │
│      opened_at (read by the skip-if gate at step 8)                        │
│ (12) 30s sweep settles the event · logs: Redis buffer → batch writer       │
│      → Postgres + ClickHouse · story: /v1/events/:txn/timeline             │
└────────────────────────────────────────────────────────────────────────────┘
```

**The plane underneath:**

```text
┌────────────────────────────────────────────────────────────────────────────┐
│ POSTGRES :5433 — SOURCE OF TRUTH                                           │
│ events (outbox) · messages · orgs / environments / api_keys (hashed)       │
│ workflows · templates + versions · topics · subscribers                    │
│ integrations (sealed creds) · suppressions · execution logs                │
└────────────────────────────────────────────────────────────────────────────┘
                                      ▲
                                      ┆  Redis lost? the reconciler rebuilds every
                                      ┆  queue from the Postgres outbox alone
┌────────────────────────────────────────────────────────────────────────────┐
│ REDIS — EVERYTHING IN MOTION                                               │
│ all BullMQ queues + jobId dedupe · rate-limit windows · digest windows     │
│ log buffer · pub/sub fabric for live in-app delivery                       │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│ CLICKHOUSE :8123 — ANALYTICS COPY                                          │
│ dual-written execution logs, 90-day TTL · feeds /v1/analytics              │
│ aggregations never compete with the send path for IOPS                     │
└────────────────────────────────────────────────────────────────────────────┘

┌────────────────────────────────────────────────────────────────────────────┐
│ OBSERVABILITY                                                              │
│ Prometheus /metrics on API + every worker · one OpenTelemetry trace        │
│ spans API → queues → workers → provider (Jaeger :16686)                    │
└────────────────────────────────────────────────────────────────────────────┘
```

---

## Your application — the only code you write

**(1) Your backend.** Order ships → one SDK call with your server-side API
key. Same call for any channel mix — the workflow decides.

```ts
// @asyncify-hq/node
await asyncify.trigger('order-shipped', {
  to: [{ subscriberId: 'user-42', email: 'ana@shop.com' }],
  payload: { order: '#1042' },
  transactionId: 'order-1042-shipped'
})
```

**Your frontend.** `<NotificationInbox />` from `@asyncify-hq/react`. Holds
only a scoped subscriber token (`nst_…`, HMAC) — never an API key. Reads
inbox REST, listens live on WebSocket.

**Asyncify dashboard `:5173`.** Where you shape the flow before any request
exists: **workflows** (steps, priorities, conditions, digests), **templates**
(MJML, versioned), **integrations** (your provider keys), **topics**,
subscribers, activity timeline, analytics. Auth: JWT + `x-environment-id`.

> ⬇ HTTPS · `POST /v1/events/trigger` · `x-api-key: ak_…`

## API — the front door: check, record, reply fast

Fastify · `:3000` · stateless — run as many copies as you like.

**(2) Authenticate.** Key is SHA-256-hashed and looked up (60s cache,
invalidated on revoke) → resolves your **organization → environment
(tenant)**. Every later step is scoped to that tenant.

**(3) Tenant rate check** *(burst QoS)*. Under limit → straight through. Over
soft limit → diverted to the **overflow queue**, trickled back later — a
bursty tenant can't starve others. Over 5× → `429`.

**(4) Accept & persist** *(≈ ms)*. Dedupe on `(tenant, transactionId)` — the
same request sent twice can never notify twice, so retries are always safe.
Event row written to the Postgres outbox, workflow validated, one job
enqueued. Your backend gets **202 Accepted** and moves on.

Other API surfaces: `/v1/workflows` · `/v1/templates` + `/preview` ·
`/v1/integrations` + `/test` · `/v1/topics` · `/v1/subscribers` ·
`/v1/subscriber-tokens` · `/v1/inbox/:subscriberId` ·
`/v1/events/:txn/timeline` · `/v1/events/broadcast` · `/v1/suppressions` ·
`/v1/analytics` · `/webhooks/:provider` · `/o/:messageId.gif` · `/metrics`

> ⬇ **trigger** queue · jobId = `evt-{transactionId}`

## Worker — resolve the audience

Figures out exactly who should receive this · `:3002`.

**(5) Trigger worker.** Turns "who" into concrete recipients, in chunks
of 100:

- **Direct list** → chunked as-is.
- **Topic** (a named group, `to: {topic}`) → members read page by page,
  pausing whenever downstream queues get too full (backpressure — Redis
  memory stays flat for any audience size).
- **Broadcast** → pages every subscriber in the environment the same way.

One fan-out job per chunk.

> ⤷ **Overflow queue**: requests diverted at (3) re-enter here at a
> controlled trickle once the tenant has budget again. Nothing is dropped
> below the hard limit.

> ⬇ **fanout** queue · one job per 100 recipients

## Worker — one job becomes N messages

One message per person, per channel, per workflow step.

**(6) Fan-out worker.**

1. Upsert subscribers
2. Drop anyone on the **suppression list** (batch check)
3. Evaluate **step conditions** against payload + subscriber (`plan = "pro"`?)
4. Pin the **template version** so later edits can't change an in-flight send
5. Bulk-insert **message rows** — unique on
   `(event, subscriber, channel, step)`, the second dedupe wall
6. `addBulk` delivery jobs, `jobId = messageId`

> ⤷ **Digest window**: digest steps don't enqueue — they append to a Redis
> window per subscriber. When it closes, one summary message carries all
> items (`{{digest_items}}`); merged events get a terminal `merged` row so
> they still settle.

> ⬇ 12 **delivery** queues · channel × priority

## Queue plane — twelve separate waiting lines

Redis + BullMQ — so channels and priorities never block each other.
**(7)** the email lands in its channel + priority lane:

| | email | sms | push | in-app |
|---|---|---|---|---|
| **p0** (OTP) | `deliver-email-p0` | `deliver-sms-p0` | `deliver-push-p0` | `deliver-inapp-p0` |
| **p1** | **`deliver-email-p1` ← ours** | `deliver-sms-p1` | `deliver-push-p1` | `deliver-inapp-p1` |
| **p2** (marketing) | `deliver-email-p2` | `deliver-sms-p2` | `deliver-push-p2` | `deliver-inapp-p2` |

Priority lanes are why a promo blast to a million users never delays a login
code: p0 has its own queue, its own concurrency — and `WORKER_TIERS=p0` can
pin whole worker processes to it. Per-channel rate limiters throttle each
lane independently.

## Worker — the hot path

Read message → render → send → update one row. Nothing else.

**(8) Prepare.** Status guard (already sent? stop — safe re-delivery) ·
honor step **delay** · check the **skip-if gate**: "skip this reminder if
step A was opened/read since it went out" — decided now, at send time, not at
fan-out · render the **pinned MJML template** with Handlebars, inject the
open-tracking pixel, derive the plaintext part.

**(9) Send with failover.** Your tenant's **integration chain** (your
provider accounts, credentials encrypted at rest with AES-256-GCM, decrypted
only here) is tried in order, each behind a **circuit breaker**. Temporary
error → retry with exponential backoff. Provider says "bad address" →
`failed`, no retry. First provider down → the next one sends it. Retries
exhausted → **dead-letter queue**, held for replay instead of lost.

> ⬇ **(10)** provider APIs · four channels

## Channels & providers

Configured per environment in the integration store.

| Channel | Providers | What happens |
|---|---|---|
| ✉ **Email** | SMTP · SendGrid · Resend | Lands in the recipient's inbox with the tracking pixel. Dev: Mailpit `:8025` catches everything. |
| ▤ **SMS** | Twilio | Plain text to the phone; delivery receipts come back by webhook. |
| ⬒ **Push** | FCM | Device notification; dead device tokens are auto-suppressed on the provider's "unregistered" error. |
| ◉ **In-app** | Postgres row + Redis pub/sub → WS gateway `:3001` | The message row *is* the durable inbox. Online → pushed live to `<NotificationInbox />`, marked delivered. Offline → waiting, unread, next login. |

> ⬇ the world answers back

## Feedback loop — closes the story on every message

**(11) Provider webhooks.** Signed callbacks (HMAC, timestamped) →
`status-events` queue → status worker updates the row: `delivered`, or
`bounced` / complaint — which also writes the address to the **suppression
list** so step (6) never emails it again.

**Open tracking.** Recipient opens the email → the pixel fires
`GET /o/:messageId.gif` → `opened`. This is the timestamp the skip-if gate
at (8) reads to cancel redundant reminders.

**(12) Settle & observe.** A 30s sweep marks the event `completed` once
every message is terminal. Execution logs never touch the hot path: Redis
buffer → batch writer → Postgres + ClickHouse. The whole story per request:
`/v1/events/:txn/timeline`.

**Message lifecycle:**
`queued` → `sent` → `delivered` → `opened / read`
⌁ `retrying` → `failed` → `dead-letter → replay`
⌁ `bounced` → `suppressed`

## The plane underneath — who remembers what

**Postgres `:5433` — source of truth.**
`events` (outbox) + `messages` — every send, forever auditable ·
`organizations · environments · api_keys` (hashed) · `org_members` (RBAC) ·
`workflows · templates + template_versions · topics · subscribers` ·
`integrations` (sealed creds) · `suppressions` · execution logs ·
DR: the reconciler can rebuild every queue from this outbox alone.

**Redis — everything in motion.**
All BullMQ queues + `jobId` dedupe · rate-limit windows · digest windows ·
log buffer · pub/sub fabric for live in-app delivery · loses power? Postgres
outbox + reconciler restore the world.

**ClickHouse `:8123` — analytics.**
Dual-written execution logs, 90-day TTL · feeds `/v1/analytics` and the
dashboard charts · aggregations never compete with the send path for IOPS.

**Observability.**
Prometheus `/metrics` on API and every worker · OpenTelemetry — trace context
rides *inside job payloads*, so one trace spans API → queues → workers →
provider (Jaeger `:16686`) · queue depths → the dashboard's sidebar pulse.

## The same journey, in twelve sentences

1. Your backend calls `trigger('order-shipped', …)` with a **transactionId**
   — the SDK is a thin, zero-dependency HTTP client.
2. The API hashes your `ak_` key and resolves your tenant; every row and
   queue job from here on is scoped to it.
3. Your tenant's rate budget is checked — bursts divert to the overflow
   queue instead of degrading anyone else.
4. The event is deduped, persisted to the Postgres outbox, one job is
   enqueued, and you get **202** in milliseconds — the caller never waits on
   a single send.
5. The trigger worker resolves the audience — direct list, streamed **topic**
   members, or full broadcast — into fan-out jobs of 100.
6. The fan-out worker drops suppressed addresses, evaluates each step's
   **conditions**, parks digest steps in their window, pins the **template
   version**, and writes one deduped message row per recipient × step.
7. Each message enters its lane — `deliver-email-p1` here — so OTPs (p0)
   never queue behind campaigns (p2).
8. At send time the delivery worker re-checks reality: not already sent,
   delay elapsed, and the **skip-if gate** hasn't been satisfied by an
   earlier step being opened.
9. The pinned MJML template renders with the payload, the pixel goes in, and
   **sendWithFailover** walks your integration chain behind circuit breakers
   — retry, fail over, or dead-letter.
10. The provider hands it to the inbox — while sms, push and in-app ride the
    identical spine to phones, devices and your `<NotificationInbox />`.
11. Delivery receipts and bounces flow back through signed webhooks; bounces
    auto-populate the suppression list that step 6 consults.
12. Logs batch into Postgres + ClickHouse off the hot path, the sweep settles
    the event, and `/v1/events/:txn/timeline` can replay the whole story.

---

*asyncify — multi-channel notification infrastructure · API `:3000` ·
workers `:3002` · WS `:3001` · dashboard `:5173`*
