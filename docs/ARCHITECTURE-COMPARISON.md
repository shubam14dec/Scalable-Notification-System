# Architecture: novu vs Asyncify — engine-to-engine comparison

Sources: exhaustive code sweep of novu `next` (2026-07-11) — apps/api,
apps/worker, apps/ws, apps/webhook, apps/inbound-mail, libs/dal,
libs/application-generic, all SDK/framework packages — compared against
our engine as documented in docs/REQUEST-FLOW.md.

## 1. The two spines, side by side

```
NOVU                                     ASYNCIFY
────                                     ────────
POST /v1/events/trigger                  POST /v1/events/trigger
  Nest guards/interceptors chain           Fastify auth + tenant rate check
  NO domain write on trigger               event row -> Postgres OUTBOX (202)
  1 job -> "trigger-handler" queue         1 job -> "trigger" queue
     groupId = organizationId                jobId = evt-{transactionId}
        │                                       │
        ▼                                       ▼
  TriggerEvent worker                      TRIGGER worker
    resolves workflow, fans out              resolves audience (topic
    topic members via async                  members streamed w/
    generator, 100-chunks                    backpressure), 100-chunks
        │                                       │
        ▼ "process-subscriber" queue            ▼ "fanout" queue
  SubscriberJobBound worker                FAN-OUT worker
    upserts subscriber, evaluates            upserts subscribers, drops
    preferences, builds the JOB              suppressed, evaluates step
    CHAIN: one JobEntity per step,           conditions, pins template
    linked by _parentId                      version, bulk-inserts
        │                                    MESSAGE rows (unique wall)
        ▼ "standard" queue                      │
  RunJob worker (per STEP)                      ▼ 12 delivery queues
    job DAG walk: run step ->               DELIVERY worker (per MESSAGE)
    find child by _parentId ->                channel × priority lanes
    AddJob(next). DELAY/DIGEST/               (p0 never behind p2),
    THROTTLE = native BullMQ                  status guard, delay,
    delayed jobs. Digest master               skip-if gate, render pinned
    dedupe = unique partial index             template, sendWithFailover
        │                                     (chains + breakers) -> DLQ
        ▼                                       │
  SendMessage -> provider                       ▼ provider
  webhooks app (separate service)          status-events queue -> status
  normalizes provider receipts             worker -> suppressions/opened
```

**The fundamental difference:** novu's execution unit is the **step**
(a Job row per step, chained by `_parentId`, walked one at a time);
ours is the **message** (all steps materialized at fan-out into message
rows, each riding its own delivery lane). Consequences:

| Aspect | novu (job chain) | Asyncify (message lanes) | Verdict |
|---|---|---|---|
| Mid-workflow logic (delay→digest→email) | natural — each step is a job that schedules the next | delay handled at send; digest via Redis window; no step DAG | **novu wins** for complex sequential workflows (this is why their delay-until-date/throttle/cron-digest are easy) |
| Priority isolation (OTP vs marketing) | one `standard` queue for everything; fairness via per-org groups | 12 physical channel×priority lanes + WORKER_TIERS process pinning | **we win** — p0 latency can't be touched by bulk |
| Crash recovery | job rows are the state machine | Postgres outbox + reconciler rebuilds queues | **we win** on DR story; they win on step-resume granularity |
| Retry granularity | per step, previous steps never re-run | per message send | comparable |
| Tenant fairness | BullMQ **Pro** (paid) `group: organizationId` | overflow queue QoS (soft/hard limits) | different tools; theirs smoother, ours harder-edged. Adopting group-aware dequeue would close it |

**Adopt from this:** if we build the workflow-engine-v2 backlog item
(delay-until-date, throttle, cron digests), the clean mechanism is a
**step-chain job model for the deferred parts** — a `run_after`
timestamptz + parent linkage on a step-jobs table (Postgres `FOR UPDATE
SKIP LOCKED` replaces BullMQ delayed sets), while keeping our message
lanes for actual delivery. Hybrid of both spines.

## 2. Data layer

| | novu | Asyncify |
|---|---|---|
| Source of truth | **MongoDB** (Mongoose) — ObjectId↔string mapping layer everywhere, soft-delete plugins being removed, high-write ExecutionDetails **actively migrating to ClickHouse** | **Postgres** — outbox doctrine, execution logs dual-written to ClickHouse **from day one** |
| Scoping | `_organizationId` + `_environmentId` on every row; new `contextKeys[]` axis with hashed uniqueness | `tenant_id` on every row |
| Idempotency | unique **partial** indexes (digest master guard, subscriber-per-env) | unique constraints everywhere (events, messages, conversation dedupe keys) — same doctrine |
| Pagination | keyset/cursor with `limit+1`, bidirectional, **counts capped at 50k** | offset/limit | **adopt theirs** as tables grow |
| Repository | BaseRepositoryV2: **mandatory column projection**, inferred `Pick<>` types, `.lean()` everywhere | `select *` common | adopt the projection discipline on hot paths |
| Retention | partial indexes covering only recent rows + Mongo Online Archive | keep-forever | we need retention (already Tier B) |

Their migration OFF Mongo for hot analytics data validates our
architecture — we started where they're heading.

## 3. Realtime, webhooks, inbound mail

- **WS**: socket.io + `@socket.io/redis-adapter`, room per subscriber id,
  **no sticky sessions**, exact-match contextKeys filtering per socket.
  Ours: raw `ws` + Redis pub/sub channel per subscriber — equivalent
  shape, fewer moving parts. No action needed.
- **Provider receipts**: a whole separate `apps/webhook` service maps
  provider events through each provider's `parseEventBody/getStatus`
  into canonical enums (email 13 statuses / sms 9 / push 5). Ours lives
  in the API + status worker — fine at our scale; **adopt their canonical
  status enums** when we broaden providers.
- **Inbound mail**: dedicated SMTP listener with SPF/DKIM (bundled Python
  verifiers, fail-closed), spam scoring, S3 attachments, 451-on-error so
  MTAs retry. Ours: Postmark inbound webhook (deliberate, no DNS). Their
  approach is the endgame when asyncify.org gets MX records; the
  fail-closed verdict discipline and 451-retry semantics are the notes
  to keep.

## 4. Security patterns — the adopt-now list

1. **SSRF guards on every user-supplied URL** (`assertSafeOutboundUrl` +
   DNS-pinned re-validation across redirects; validate BEFORE signing so
   blocked URLs never see signed payloads). We POST to customer bridge
   URLs with none of this. **Highest-priority adoption.**
2. **HMAC header parse rule**: split each `t=...,v1=...` part on the
   FIRST `=` only (field-injection replay bypass); verify over raw bytes,
   never re-serialized JSON; ±replay window. Our scheme is the same shape
   — audit our parser for the first-`=` rule.
3. **Derived callback URLs**: their async reply model computes the reply
   URL from config, never trusts the inbound payload. Our bridge batches
   replies in the HTTP response (no reply URL at all) — simpler and safer;
   keep, but remember this rule if we ever add async replies/streaming.
4. **App-layer AES on all secrets** — both do this. Parity.
5. **One-shot OAuth callback claim** via atomic conditional update —
   note for the future Slack channel OAuth work.

## 5. Engineering patterns adopted into our backlog thinking

- **Per-tenant fair dequeue** (their BullMQ Pro groups): our overflow QoS
  covers bursts, not sustained fairness. A group-aware claim pattern is
  the eventual 10–20M answer.
- **Idempotency-Key header** (409 in-flight / 422 body-mismatch / 24h
  replay with `Idempotency-Replay` header) — a customer-facing API
  nicety our transactionId doesn't fully cover.
- **TTL jitter on every cache set** + query-result caching with
  set-based invalidation — cheap stampede protection.
- **Append-only metering ledgers** (conversation activations, one row per
  billable episode; count rows per period) — the billing-ready pattern
  for when we meter agent conversations.
- **Fail-open limit checks with short TTL cache** — never let a
  plan-limit lookup error break a paying customer's hot path.
- **Dashboard autosave** (debounced single-flight invocation queue, no
  Save button, navigation guard) and the **escape-key priority stack** —
  UX machinery worth copying wholesale.
- **Eval harness for agent behavior** (LLM-judge + scripted mock shells)
  — the mature version of our fabrication battle-tests; CI-able.

## 6. Honest scorecard

**Where we're structurally ahead:** Postgres source of truth +
queue-rebuild reconciler; ClickHouse from day one; physical priority
lanes; provider failover chains with circuit breakers (they have
priority/primary + conditions, no breakers); one codebase a person can
hold in their head. Our agent bridge protocol (sync reply batching, no
reply URL) is simpler and has a smaller attack surface than theirs.

**Where they're structurally ahead:** step-chain execution (unlocks the
whole deferred-action family), per-tenant fairness groups, cursor
pagination + capped counts, 76-provider catalog with a scaffolding
generator, the environment promotion/diff machinery, and sheer surface
(severity, contexts, schedules, translations, RBAC, regions, billing).

**Their weight is also their weakness:** dual queue backends mid-
migration, two i18n systems, v1+v2 APIs side by side, EE submodules,
Mongo→ClickHouse migration in flight. We can move faster; they can't
simplify.
