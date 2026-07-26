# Going to production — what replaces the tunnel

In development, `asyncify dev` borrows a public address (a cloudflare
quick tunnel) because a laptop doesn't have one. Every inbound webhook —
Telegram messages, Slack events, Postmark inbound email, Twilio delivery
receipts — POSTs to that borrowed address, and the CLI's watchdog re-wires
everything each time the address rotates.

Production runs **identical code with one variable different**: the
address is permanent, so the rotation machinery simply goes quiet.

```
DEV                                     PRODUCTION
Telegram / Slack / Postmark / Twilio    Telegram / Slack / Postmark / Twilio
        │ POST                                  │ POST
        ▼                                       ▼
https://<random>.trycloudflare.com      https://api.your-domain.com
        │  rotates hourly                       │  never changes
        ▼                                       ▼
laptop :3000                            api pods (same Fastify app)
```

## Deployment-day checklist

1. **DNS + TLS** — point a subdomain (e.g. `api.your-domain.com`) at the
   deployed API behind a TLS-terminating load balancer. The deployment
   artifacts already exist: `Dockerfile` and the Helm chart with KEDA
   autoscaling under `deploy/helm/notification-system/`.
   > Before the first deploy, re-verify the chart's env plumbing for
   > `PUBLIC_URL` — the chart predates the runtime-URL override below.
2. **Set the public URL once** — prefer the runtime endpoint over the
   env var:
   ```bash
   curl -X PUT https://api.your-domain.com/v1/ops/public-url \
     -H "x-api-key: <key>" -H "content-type: application/json" \
     -d '{"url":"https://api.your-domain.com"}'
   ```
   Every consumer (Telegram registration, Slack manifest URLs, email
   webhook, tracking pixel, Twilio per-message `StatusCallback`) reads
   this runtime value. A future domain migration is this same PUT again —
   connected channels re-wire with zero restarts.
3. **One-time webhook wiring** (then never again):
   - Telegram: re-register the webhook (Channels page button or the CLI's
     reconnect) so it points at the permanent URL.
   - Slack: manifest URLs update via the stored config token
     (auto-update), or re-paste once from the Channels page.
   - Email: re-paste the inbound webhook URL in Postmark once, and add
     the MX record for your reply domain — full steps in
     [AGENT-CHANNELS.md](AGENT-CHANNELS.md).
4. **Twilio needs nothing** — every SMS carries its own `StatusCallback`
   return address, stamped at send time from the runtime public URL.
5. `asyncify dev` remains a development tool for anyone building against
   the platform locally. Production never runs it.

## Observability in production

Local dev ships spans to the all-in-one Jaeger container, which stores
them **in RAM** — fine for debugging, useless for production (bounded
window, wiped on restart). The application speaks vendor-neutral
OpenTelemetry, so moving to a durable backend is one env change and
zero code:

1. Pick a backend: self-hosted Jaeger backed by real storage
   (Elasticsearch/Cassandra), Grafana Tempo, or a managed vendor
   (Datadog, Honeycomb, Grafana Cloud — anything that accepts OTLP).
2. Point `OTEL_EXPORTER_OTLP_ENDPOINT` at it (and set the vendor's
   auth header env if it needs one) on the api and worker deployments.
   Keep `OTEL_ENABLED=true`.
3. Sampling: dev traces everything. At real traffic, configure
   head-sampling (e.g. keep 10% of pipeline traces) — but keep agent
   turns at 100%; the Turn Inspector's Postgres copy is per-turn
   regardless, and turn volume is tiny next to delivery volume.

The dashboard Turn Inspector needs nothing: its traces live on the
transcript rows in Postgres and deploy with the database.

## Live dashboard updates (Phase 25)

The dashboard stopped polling and now takes live invalidation hints over the
**same WebSocket gateway the widget already uses** (`:3001`) — a tenant-scoped
admin channel carrying tiny `{type, id?, at}` hints, never row data. **No new
infra:** no new service, port, queue, or Redis instance; the gateway process
gains an admin connect path and rides the existing pub/sub. Two production
considerations, both extensions of things already true:

1. **`JWT_SECRET` must be set IDENTICALLY on the API and the ws gateway.** The
   gateway verifies the dashboard's access JWT with the *same* HS256 secret the
   API signs it with (`env.jwtSecret`). In dev both read the same default, so it
   just works; in production they are separate deployments — **if the two secrets
   differ, every admin socket is rejected with close code `4401` and the
   dashboard silently falls back to its 60s degraded-mode polling.** Set the same
   `JWT_SECRET` on both the api and the ws-gateway deployments (the Helm chart
   already templates it; confirm it lands on both).

2. **The dashboard's ws origin must point at the deployed gateway** — the exact
   consideration the widget already has. Acme's embedded `@asyncify-hq/react`
   widget takes a `wsUrl` prop (e.g. `wss://ws.your-deployment.com`, see the
   package README); the dashboard's admin client currently uses the same
   dev literal (`ws://localhost:3001`). Production must make the gateway
   reachable at the deployed ws origin and the dashboard build must target it —
   same gateway, same TLS/ingress work you already do for the widget's `wsUrl`.
   If the origin is wrong the dashboard degrades to 60s polling; nothing breaks.

## What does NOT change

Everything you verified locally — webhook signature checks, channel
routing, delivery receipts, agent bridges — is the same code path. The
tunnel was never a feature; it was a stand-in for DNS.

**Agent guardrails and evals add nothing deployment-specific.** The guardrail
counters (daily token budget, per-tool rate cap) ride the existing Redis, and the
eval-run queue rides the existing worker — no new service, secret, or env var.
Deploy day is the checklist above, unchanged.

**Agent knowledge & memory add nothing global either.** Grounding (indexed
knowledge) and episodic memory run entirely on **two per-tenant BYO
credentials** each tenant adds itself on the **Integrations** page — an
OpenAI-shaped **embeddings endpoint** and a **Pinecone** vector store — exactly
like every other provider (Twilio, FCM, an LLM key). There is **no shared infra
change**: the Postgres image is untouched (it stores chunk text, statuses, and
vector ids only — no vector extension), and the indexing/summary work rides the
existing worker. The one env var that exists, `PINECONE_CONTROL_URL`, **defaults
correctly to `https://api.pinecone.io`** and is only a test / self-host seam —
**leave it unset in production; there is no deploy-day action for it.**

**Long-term memory, rolling summaries, caching, and budget hints add nothing
either.** Durable customer profiles are Postgres rows (a table + two columns on
existing tables, created by the same migration path as every other); rolling
summaries ride the existing worker queue; the budget suggestion is a read-time
aggregate over data already stored. **No new infra, no new env var, no one-time
console step.** Two honesty notes for production, both self-adjusting: **prompt
caching** cuts token cost only on LLM providers that honor `cache_control` — real
Anthropic endpoints do (full discount), some Anthropic-compat layers ignore it
(no discount, no error, no behavior change); and the **daily-budget suggestion**
stays blank until an agent has **7+ days of production usage** — it appears on its
own once the data exists, nothing to enable.
