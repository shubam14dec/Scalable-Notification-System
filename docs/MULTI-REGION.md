# Multi-Region & Disaster Recovery Strategy

How to take this system from one region to region-resilient — in stages, each
one justified by an actual requirement, because every stage adds real
operational cost.

---

## 0. First, the targets (decide these before any architecture)

| Metric | Meaning | Suggested target |
|---|---|---|
| **RPO** (Recovery Point Objective) | How many seconds of *accepted* notifications you may lose in a disaster | ≤ 30s (bounded by replication lag) |
| **RTO** (Recovery Time Objective) | How long delivery may be down during failover | 5–15 min (stage 2), < 1 min (stage 3) |

Notification-specific nuance: much of the traffic is *time-sensitive but
re-derivable* (the OTP that didn't send in 10 minutes is useless — dropping it
is fine; callers retry). What must NOT be lost is the *record* of what was
sent (compliance, dedupe) and subscriber/preference data.

## 1. Stage 1 — Single region, multi-AZ (do this immediately)

Most "region" outages are actually single-AZ. This stage is cheap and removes
the majority of risk:

- **Postgres:** managed HA (RDS Multi-AZ / Cloud SQL HA / Patroni) —
  synchronous standby in a second AZ, automatic failover. RPO 0, RTO ~1 min.
- **Redis:** Redis Sentinel or a managed replica with automatic promotion.
  BullMQ reconnects on promotion; in-flight jobs are re-delivered after
  their locks expire (our processors are idempotent precisely for this).
- **Workers/API/WS:** replicas spread across AZs (K8s topology spread
  constraints in the Helm chart's Deployments).
- **ClickHouse:** single node is acceptable — it's the analytics copy;
  Postgres holds the source-of-truth logs.

## 2. Stage 2 — Warm standby region (active-passive)

The 80/20 of multi-region: one serving region, one region that can take over.

```
        REGION A (active)                REGION B (warm standby)
  API + workers + WS  (full)         API + workers scaled to 0-1
  Postgres primary  ──async repl──▶  Postgres replica (read-only)
  Redis (queues)                     Redis (empty — queues are NOT replicated)
  ClickHouse        ──repl/backup─▶  ClickHouse replica or S3 backups
        ▲
   DNS / global LB (health-checked, manual or automated flip)
```

Key decisions and why:

- **Do NOT replicate Redis queues cross-region.** Queue state is short-lived
  and reconstructible; cross-region Redis replication adds latency to every
  enqueue and fails messily. Instead, rely on the **outbox property** our
  pipeline already has: every accepted event is a row in Postgres (`events`,
  status `accepted`/`processing`) *before* the API acks. After failover, a
  **reconciler** re-enqueues events that were accepted but never completed:
  `SELECT * FROM events WHERE status != 'completed' AND created_at > now() - interval '1 hour'`
  → re-add to the trigger queue. Idempotency (transactionId dedupe, message
  unique keys, jobId dedupe) makes replay safe — that's why it was built in.
- **Postgres async replication** (streaming/logical) A→B. RPO = replication
  lag (typically < 5s). Sync replication cross-region is possible (RPO 0) but
  taxes every write with cross-region RTT — usually not worth it here.
- **Failover runbook (automatable later):**
  1. Confirm region A is actually down (not a monitoring blip).
  2. Promote Postgres B to primary.
  3. Scale up workers/API/WS in B (KEDA handles workers once traffic arrives).
  4. Flip DNS / global load balancer to B.
  5. Run the reconciler → unfinished events re-enter the pipeline.
  6. WS clients reconnect automatically (they're stateless reconnectors) and
     re-fetch inboxes over REST — no socket state to migrate, by design.
- **Provider webhooks:** register BOTH regions' webhook URLs with providers
  where supported, or put webhooks behind the same global LB hostname so
  callbacks follow the flip.

## 3. Stage 3 — Active-active (only if the business demands < 1 min RTO)

Both regions serve traffic simultaneously. The clean model for a notification
system is **tenant pinning** (Razorpay-style cell architecture), NOT
write-anywhere:

- Each tenant is **homed** to one region (`tenants.home_region`); the global
  LB routes a tenant's API calls to its home region. Each region runs the
  full stack including its own Redis and Postgres primary.
- **No cross-region write conflicts** because a tenant's writes only ever
  happen in one region. The other region holds its async replica (stage-2
  mechanics per region, symmetric).
- Failover = re-homing tenants of the dead region onto the survivor
  (promote replica, flip routing table, run reconciler). Blast radius of any
  regional failure = only the tenants homed there.
- **In-app/WS:** the gateway a user connects to must reach the pub/sub of the
  tenant's home region — simplest is routing WS connections through the same
  tenant-aware LB layer as HTTP.
- **Suppressions & preferences** are the one dataset worth replicating
  everywhere quickly (a bounce learned in region A must stop sends from
  region B for a re-homed tenant): logical replication of those small tables
  both ways, last-write-wins — they're idempotent sets, so conflicts are benign.

**Avoid** the tempting-but-wrong design: one global queue consumed by workers
in many regions. It puts a cross-region RTT inside every BullMQ lock/ack,
multiplies Redis failure modes, and gives you neither isolation nor lower
latency.

## 4. Data-layer summary

| Store | Multi-AZ (stage 1) | Cross-region (stages 2-3) |
|---|---|---|
| Postgres | Sync standby, auto-failover | Async streaming replica; promote on failover; reconciler replays unfinished events |
| Redis / BullMQ | Sentinel/managed replica | **Not replicated** — rebuilt from Postgres via reconciler |
| ClickHouse | Single node OK | `ReplicatedMergeTree` across regions, or restore from S3 backups (it's derived data) |
| Suppressions/preferences | (in Postgres) | Additionally logically replicated both ways in active-active |

## 5. What this system already does that makes DR cheap

- **API acks only after the event row is committed** → Postgres is a complete
  outbox; queues are disposable.
- **Idempotency at every layer** (transactionId, message unique key, jobId,
  status guard) → replays after failover cannot double-send.
- **Stateless WS gateway** → zero connection state to migrate; clients
  reconnect and reconcile via REST.
- **KEDA autoscaling** → the standby region's worker fleet sizes itself as
  soon as replayed load arrives.
- **Per-process Prometheus + tracing** → the failover runbook has objective
  "is it healthy" signals (`notif_queue_jobs`, delivery success rates, traces).

## 6. Practical order of adoption

1. Multi-AZ Postgres + Redis, pod topology spread — **now** (config, not code).
2. Cross-region Postgres replica + tested promotion runbook + the reconciler
   script — when the business asks "what if the region goes down?".
3. Global LB + automated failover — when the runbook works but is too slow.
4. Tenant pinning / active-active — only at genuine multi-region scale or
   for data-residency requirements (EU tenants homed in EU, etc.).

The only *code* this roadmap ever needs is the reconciler (a ~50-line script:
re-enqueue non-completed events older than N minutes) — everything else is
infrastructure configuration on top of properties the system already has.
