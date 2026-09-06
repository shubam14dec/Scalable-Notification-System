# Deploying Asyncify

This is the runbook for the production deployment that actually exists: **one
ARM VPS, docker compose, a permanent named Cloudflare tunnel, and one
hostname**. It is not a general "how to run this on Kubernetes" document — see
[Deliberately not deployed](#deliberately-not-deployed) for why the Helm chart
in `deploy/helm/` is a future-scale story rather than this deploy.

## What production is

A single always-on box (Oracle Always Free A1: 4 OCPU / 24 GB — Hetzner CAX11
is the drop-in fallback) running `docker-compose.prod.yml`: postgres, redis,
clickhouse, the three app roles (api / worker / ws) from **one image**, the
acme-tools demo stub, a Caddy container serving the dashboard, and cloudflared.

**Zero published ports.** No service in the compose file declares `ports:`. The
box's only public listener is sshd. Ingress arrives exclusively through the
cloudflared container, which dials **out** to the Cloudflare edge and forwards
to `web:8080` over the compose network. There is no inbound firewall rule to
get wrong, and no origin IP to leak.

**Everything on one hostname**: `app.asyncify.org` (plus `tools.asyncify.org`
for the demo tool backend). The dashboard, the API's six public prefixes, and
the WebSocket gateway are all the same origin.

In development, `asyncify dev` borrows a public address (a Cloudflare *quick*
tunnel) because a laptop doesn't have one, and re-wires every channel each time
that address rotates. Production runs **identical code with one variable
different** — the address is permanent, so the rotation machinery goes quiet:

```
DEV                                     PRODUCTION
Telegram / Slack / Postmark / Twilio    Telegram / Slack / Postmark / Twilio
        │ POST                                  │ POST
        ▼                                       ▼
https://<random>.trycloudflare.com      https://app.asyncify.org
        │  rotates hourly                       │  never changes
        ▼                                       ▼
laptop :3000                            api container (same Fastify app)
```

The tunnel was never a feature; it was a stand-in for DNS.

## Topology

Cloudflare edge → cloudflared (outbound-only) → `web` (Caddy, `:8080`) → the
routing table in [`deploy/compose/Caddyfile`](../deploy/compose/Caddyfile):

| Request path | Goes to | Why |
|---|---|---|
| `/v1/*` | `api:3000` | REST API (tenant API-key auth) |
| `/auth/*` | `api:3000` | dashboard signup / login / refresh |
| `/ops/*` | `api:3000` | dashboard operational reads |
| `/webhooks/*` | `api:3000` | provider inbound: Telegram, Slack, Postmark, Twilio |
| `/handoff/*` | `api:3000` | human-handoff operator links |
| `/o/*` | `api:3000` | email open-tracking pixel |
| `/health` | `api:3000` | liveness |
| `/ws*` | `ws:3001` | WebSocket upgrade — dashboard admin channel **and** the embedded widget |
| everything else | `/srv` static | dashboard SPA, `try_files {path} /index.html` |
| `/metrics` | **nothing** | deliberately unrouted; scrape `api:3000/metrics` and `worker:3002/metrics` on the compose network |

`tools.asyncify.org` is a separate ingress rule straight to `acme-tools:4400`;
it never touches Caddy.

The WS gateway **ignores the request path entirely** — it reads only
`searchParams` (`src/ws/gateway.ts`). So `/ws/?admin=1&token=…` reaches it
unmodified and the `/ws` prefix is routing information for Caddy alone. That is
why moving the gateway onto the same hostname needed no server change.

## Why one origin

- **The dashboard fetches relative paths** and stores bearer tokens in
  localStorage. Same origin means **no CORS configuration exists to get wrong** —
  the API has no CORS plugin at all, and doesn't need one.
- **The WS origin is derived, not configured.** `dashboard/src/lib/wsOrigin.ts`
  returns `(https→wss)://${location.host}/ws`. There is no build-time variable
  and no dev/prod fork: in dev, vite proxies `/ws` to `localhost:3001`
  (`dashboard/vite.config.ts`), so development exercises the exact path
  production uses. A domain move needs no rebuild.
- **PUBLIC_URL is this same host**, so provider webhooks, handoff links and the
  open-tracking pixel all land on the one hostname the tunnel serves.

> **The Caddyfile is the routing source of truth.** If you add a new top-level
> route prefix to `src/api/app.ts`, add it to the `@api path` matcher too —
> otherwise it silently falls through to the SPA and returns `index.html` with a
> 200, which is much harder to debug than a 404.

## Secrets

All of them live in one file, `.env.prod` (chmod 600, gitignored, never
committed). Template: [`.env.prod.example`](../.env.prod.example).

**One shared `env_file` for api, worker and ws is not a convenience — it is the
mechanism** that guarantees `JWT_SECRET` is byte-identical across the process
that signs dashboard tokens and the process that verifies them.

| Variable | Generate with | Notes |
|---|---|---|
| `JWT_SECRET` | `openssl rand -base64 48` | **Must be byte-identical on api and ws.** |
| `CREDENTIALS_ENCRYPTION_KEY` | `openssl rand -base64 48` | **Unrecoverable. Back it up off-box before first use.** |
| `WEBHOOK_SIGNING_SECRET` | `openssl rand -hex 32` | Empty **disables** provider-webhook signature verification. |
| `POSTGRES_PASSWORD` | `openssl rand -base64 48` | Must match the password inside `DATABASE_URL`. |
| `CLICKHOUSE_PASSWORD` | `openssl rand -hex 32` | Analytics only; soft-fails if wrong. |
| `OUTBOUND_URL_ALLOW` | — | **Must stay empty.** It is the SSRF guard's dev escape hatch. |
| `TUNNEL_ID` | `cloudflared tunnel create` | Box-local UUID; creds JSON is never committed. |

Two of these have failure modes that are silent rather than loud, which is
exactly why the preflight below exists:

- **`JWT_SECRET` mismatch between api and ws**: nothing errors. The gateway
  rejects every dashboard socket with close code **4401**, and the dashboard
  falls back to its 60-second degraded polling. The product still works; it just
  feels stale. (Diagnosis: `docker compose exec api printenv JWT_SECRET` vs the
  same on `ws`.)
- **`CREDENTIALS_ENCRYPTION_KEY` loss**: every stored provider credential
  (Resend, Postmark, Telegram, Slack, Twilio, LLM keys) becomes undecryptable
  ciphertext and every channel must be reconnected by hand. **A `pg_dump` taken
  without this key is worthless for restoring integrations.**

**Preflight refuses dev defaults.** `src/config/preflight.ts` runs as the first
statement of each entrypoint's `main()` and, when `NODE_ENV=production`,
fatal-exits on: a dev-default or sub-32-char `JWT_SECRET`, a dev-default or
sub-32-char `CREDENTIALS_ENCRYPTION_KEY`, an empty `WEBHOOK_SIGNING_SECRET`, or
a non-empty `OUTBOUND_URL_ALLOW`. It warns (without exiting) on a localhost
`PUBLIC_URL`. This exists because `src/config/env.ts` gives every variable a
fallback — so without the preflight, a missing secret doesn't crash anything, it
boots a fully working system on values published in this repo. Preflight is
never called inside `buildApp()` / `startGateway()`, so tests are unaffected.

Per-tenant provider credentials (a Resend API key, a Telegram bot token) are
**not** environment config — they are encrypted rows added from the dashboard's
Integrations page.

## First-deploy runbook

**0. The box.** Ubuntu 24.04 aarch64, 4 OCPU / 24 GB, 100 GB boot, SSH key
only; security list allows nothing inbound but port 22. Then `apt upgrade`, add
a 2 GB swapfile, and leave the provider's iptables alone. Gate: `ssh` works and
`uname -m` prints `aarch64`.

**1. Docker + cloudflared on the host.**
```bash
curl -fsSL https://get.docker.com | sh
sudo usermod -aG docker $USER      # log out and back in
# cloudflared arm64 .deb on the HOST — only needed to create the tunnel
```
Gate: `docker compose version` prints v2.

**2. Tunnel + DNS, before any code.**
```bash
cloudflared tunnel login                            # browser auth, asyncify.org zone
cloudflared tunnel create asyncify-prod             # note the <UUID>; writes creds json
cloudflared tunnel route dns asyncify-prod app.asyncify.org
cloudflared tunnel route dns asyncify-prod tools.asyncify.org
```
Gate: both proxied CNAMEs are visible in the Cloudflare dashboard.

**3. Clone + secrets.**
```bash
git clone <repo> asyncify && cd asyncify
cp ~/.cloudflared/<UUID>.json deploy/compose/cloudflared/creds.json
chmod 600 deploy/compose/cloudflared/creds.json
cp .env.prod.example .env.prod && chmod 600 .env.prod
$EDITOR .env.prod                                   # fill every <gen>
```
**Do this now, not later:** put `JWT_SECRET` and `CREDENTIALS_ENCRYPTION_KEY`
into a password manager. The second one is unrecoverable.

**4. Build.**
```bash
export COMPOSE_FILE=docker-compose.prod.yml
docker compose --env-file .env.prod build           # ~8–15 min on 4 OCPU
```

**5. Migrate — never seed.**
```bash
docker compose --env-file .env.prod up -d postgres redis clickhouse
# wait for healthy, then:
docker compose --env-file .env.prod run --rm api npx tsx src/db/migrate.ts
```
The migration is an idempotent whole-schema apply; its ClickHouse portion
soft-fails by design. **Never run `npm run seed` in production** — it mints the
publicly-known `dev-api-key-123`.

**6. Up.**
```bash
docker compose --env-file .env.prod up -d
```
Gate: every service healthy; api/worker/ws logs show "listening" and **no
preflight fatal line**; the cloudflared log shows 4 registered edge connections.

**7. Smoke, then publish the runtime URL — before creating any channel.**
```bash
curl -s  https://app.asyncify.org/health     # {"status":"ok"}
curl -sI https://app.asyncify.org/agents     # 200 (SPA fallback, not 404)
curl -s  https://tools.asyncify.org/ -X POST -d '{"args":{"orderId":"X"}}'
```
Then sign up in the browser to hold a production API key, and publish the
runtime public URL:
```bash
curl -X PUT https://app.asyncify.org/v1/ops/public-url \
  -H "x-api-key: <key>" -H "content-type: application/json" \
  -d '{"url":"https://app.asyncify.org"}'
curl -s https://app.asyncify.org/v1/ops/public-url -H "x-api-key: <key>"
# → {"url":"https://app.asyncify.org","source":"runtime"}   ← the gate
```
`PUBLIC_URL` in `.env.prod` is only the boot-time fallback; the live value is a
Redis key, which is why a domain move needs no restart.

## One-time channel wiring

Order matters — nothing is ever pointed at a dead URL:

1. Tunnel + DNS live (step 2 gate green).
2. Runtime public URL published (`"source":"runtime"`).
3. **Resend (do this early — DNS propagates while you work).** Add
   `asyncify.org` in the company Resend account; put the SPF TXT and DKIM
   records into the Cloudflare zone (**DKIM records must be DNS-only / grey
   cloud**); optional DMARC `p=none`; wait for "Verified". Then add the Resend
   API key on the dashboard's **Integrations** page — it is a per-tenant
   encrypted credential and never belongs in `.env.prod`.
4. **Postmark inbound.** Dashboard → Channels → connect Email with the
   `<hash>@inbound.postmarkapp.com` address, copy the minted
   `/webhooks/email/<id>?key=…` URL from the connection, and paste it into
   Postmark's inbound webhook settings. That is the last manual paste this
   system ever needs. (An MX record for `reply.asyncify.org` → Postmark is an
   optional branded-reply follow-up; skip it at launch.)
5. **Telegram.** Connect in the dashboard with the bot token — `setWebhook` is
   automatic at the runtime URL. If it reports "failed to resolve host", DNS is
   still propagating: retry three times, ten seconds apart, as the CLI does.
6. **Slack.** Dashboard quick-setup via manifest.
7. **Twilio needs nothing** — every SMS carries its own `StatusCallback` return
   address, stamped at send time from the runtime public URL.
8. **acme-tools.** Dashboard → Agents → support-demo → Tools → set
   `refund_customer`'s URL to `https://tools.asyncify.org` (only after DNS
   resolves; the SSRF check runs at write time).

## Day-2

**Deploy a change — the normal path (since 2026-09-07): merge main →
production.** `main` is just code; going live is a pull request from `main`
into the `production` branch. The PR shows the exact diff that will ship,
branch protection keeps the merge button grey until CI (test + agent-evals)
passes, and merging triggers `.github/workflows/deploy.yml`, which SSHes to
the box (dedicated deploy key in the `DEPLOY_SSH_KEY` repo secret, pinned
host key) and runs exactly the manual runbook below: pull → migrate (always;
idempotent) → build → up → health-check app.asyncify.org. Rollback = the
PR's Revert button, which redeploys the previous state. One deploy runs at a
time and is never cancelled mid-flight.

**Deploy a change — by hand** (fallback; also the recovery path if Actions
or the deploy key is broken — `/root/asyncify` is a real git checkout
tracking `production`; the launch-day tarball copy was converted in place;
`.env.prod` and the tunnel creds are untracked and survive pulls):
```bash
cd ~/asyncify && git pull   # tracks production
docker compose -f docker-compose.prod.yml --env-file .env.prod build
docker compose -f docker-compose.prod.yml --env-file .env.prod up -d
```
`-f` matters: the repo also carries the dev `docker-compose.yml`, and
without it compose would pick that one. The box's `/root/.bashrc` exports
`COMPOSE_FILE=docker-compose.prod.yml` as a belt-and-suspenders default for
interactive shells. A dashboard-only change needs just `build web` +
`up -d web`.
The schema is additive and `IF NOT EXISTS`, so a bad deploy rolls back with
`git checkout <last-good>` + build + up — no schema rollback needed.

**Backups.** Nightly cron:
```bash
docker compose --env-file .env.prod exec -T postgres \
  pg_dump -U asyncify notifications | gzip > /backups/pg-$(date +%F).sql.gz
```
Keep the dumps off-box, and keep `CREDENTIALS_ENCRYPTION_KEY` off-box with
them — **a dump without that key cannot restore a single integration.**

**Domain migration** is one `PUT /v1/ops/public-url` plus reconnecting the
channels that store a callback (Telegram, Slack, Postmark). No restart, no
rebuild: the dashboard's WS origin is derived from `location.host`, so it
follows the new domain by itself.

## Escape hatches

- **Cloud capacity ("out of host capacity" at instance creation).** Try other
  availability domains → drop to 2 OCPU / 12 GB (it fits; set ClickHouse
  `mem_limit: 2g`, scale up later) → a scripted `oci compute instance launch`
  retry loop typically lands within a day or two. Or stop fighting: **Hetzner
  CAX11 (~€4/mo)** — only the box-provisioning steps change; everything from
  the tunnel step onward is byte-identical, because the stack is host-agnostic.
- **Tunnel flap.** `docker compose restart cloudflared` and expect 4 registered
  connections. Rule out the origin first:
  `docker compose exec cloudflared wget -qO- web:8080/health`. If the named
  tunnel is unrecoverable, run a **quick tunnel** against `web:8080` and use the
  product's own rewire sequence: PUT the new public URL → `GET` connections →
  reconnect Telegram and Slack → re-paste the Postmark URL. The dashboard's
  WebSocket follows automatically (origin-derived).
- **Full retreat.** `asyncify dev` on the laptop still works — but it is the dev
  database, with different tenants and API keys. Coming back means redoing the
  Telegram and Slack reconnects.
- **Bad deploy.** `git checkout <last-good>` → build → up. See Day-2.

## Deliberately not deployed

- **Mailpit.** A dev SMTP sink. Production sends through Resend with a real
  verified domain; `SMTP_HOST` is left empty.
- **Jaeger.** The dev all-in-one stores spans **in RAM** — a bounded window,
  wiped on restart. `OTEL_ENABLED=false` at launch (see fast-follows).
- **`npm run seed`.** It mints `dev-api-key-123`, a key published in this repo.
  Production starts empty; the first real tenant is created by signing up.
- **The dev Postgres data.** Not imported: its provider credentials are sealed
  with the dev encryption key and its webhook URLs point at dead tunnels.
  Rebuilding the channels takes minutes.
- **The Helm chart (`deploy/helm/`).** It predates the runtime-URL override and
  doesn't template the two secrets above. It is the *future-scale* story — when
  one box stops being enough, KEDA-autoscaled workers are the shape to grow
  into — not the thing being deployed today.

**Things that look like deploy steps but aren't.** `EVAL_LLM_*` /
`ASYNCIFY_JUDGE_*` belong to the CLI and CI (`npm run eval`); the API and worker
never read them. `PINECONE_CONTROL_URL` defaults correctly to
`https://api.pinecone.io` — leave it unset. Agent guardrails, evals, knowledge,
memory, the kill-switch, config-as-code and human handoff all ride the existing
API / worker / ws / Postgres / Redis: no new service, port, queue or console
step. Two per-tenant opt-ins are dashboard actions, not deploy steps: the
embeddings + Pinecone credentials on Integrations, and the reserved
`agent-handoffs` workflow for handoff email nudges.

One consequence of the empty `OUTBOUND_URL_ALLOW` worth knowing before the first
config-as-code promote: a config exported from a laptop whose `bridgeUrl` or
tool `endpointUrl` still points at `localhost` or a dev tunnel is **refused at
import in production (400)**. That is the SSRF guard working, not a bug, and the
two-step preview surfaces it before the apply.

## Accepted risks

Documented, not fixed — each has a known mitigation if it ever bites:

- **`/auth/signup` is open.** Anyone who finds the hostname can create a tenant.
  The zero-code fix is Cloudflare Access in front of the zone, which is why the
  tunnel lane was chosen; apply it the moment it is abused.
- **Aggregate `/ops` reads are unauthenticated.** They expose queue depths and
  counts, not tenant row data.
- **The acme-tools stub is unsigned.** It is a demo backend that holds no data
  and performs no real refunds; it is public only because the SSRF guard
  requires agent tool URLs to resolve publicly.

## Fast-follows

- **Traces.** The app speaks vendor-neutral OTLP, so turning observability on is
  one env change and zero code: point `OTEL_EXPORTER_OTLP_ENDPOINT` at Grafana
  Cloud's free OTLP endpoint (add its auth header env), set `OTEL_ENABLED=true`,
  and rebuild. At real traffic, head-sample the delivery pipeline (~10%) but keep
  agent turns at 100% — turn volume is tiny, and the Turn Inspector's Postgres
  copy is per-turn regardless.
- **Slack one-click OAuth**, unblocked now that a stable redirect URL exists.
- **Branded reply address** (`reply.asyncify.org` MX → Postmark).
