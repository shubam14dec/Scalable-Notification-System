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
| `/ops/*` | `api:3000` | operational reads — **operator-only** (see below) |
| `/webhooks/*` | `api:3000` | provider inbound: Telegram, Slack, Postmark, Twilio |
| `/handoff/*` | `api:3000` | human-handoff operator links |
| `/o/*` | `api:3000` | email open-tracking pixel |
| `/health` | `api:3000` | liveness |
| `/ws*` | `ws:3001` | WebSocket upgrade — dashboard admin channel **and** the embedded widget |
| everything else | `/srv` static | dashboard SPA, `try_files {path} /index.html` |
| `/metrics` | **nothing** | deliberately unrouted; scrape `api:3000/metrics` and `worker:3002/metrics` on the compose network |

`tools.asyncify.org` is a separate ingress rule straight to `acme-tools:4400`;
it never touches Caddy.

### `/ops/*` is the operator plane (behaviour change, 2026-09-13)

Everything under `/ops/` reports or writes something that belongs to the WHOLE
deployment, so it is gated above tenant auth. Two credentials open it, and which
one a route takes depends on whether a human or a machine is meant to use it —
see `requireOperatorSeat` / `requireOperator` in `src/api/auth.ts`:

| Route | Reports | Accepts |
|---|---|---|
| `GET /ops/queues`, `/ops/breakers`, `/ops/logs/stats` | the platform: shared queue depths, the shared dead-letter queue, provider breakers, log volume | a dashboard session whose address is in `OPERATOR_EMAILS`, **or** `x-operator-token: $OPS_ADMIN_TOKEN` (outside production an `x-api-key` also passes, so dev scripts keep working) |
| `PUT /v1/ops/public-url` | writes one globally shared value | `x-operator-token` only (in production) |
| `GET /v1/ops/public-url`, `GET /v1/ops/tenant-stats` | the base URL; the CALLER's own message counts | any tenant credential (`authenticate`) |

**What changed for tenants:** the dashboard Overview used to show every tenant
"Queue backlog" and "Dead-lettered" read from the shared BullMQ queues — the
same platform numbers for everybody, which read as if they were the tenant's
own. Those two cards are now the tenant's own rows (`GET /v1/ops/tenant-stats`:
in-flight and failed message counts, one index-only query), and the platform
gauges moved into a "Platform (operator view)" row that renders only for the
operator seat. The sidebar queue-pulse sparkline is operator-only for the same
reason, and the WS gateway sends its `queue.depths` frames only to operator
sockets.

**Operational consequences on deploy day:**

1. `OPERATOR_EMAILS` must list whoever is expected to see platform telemetry —
   without it, nobody can read `/ops/queues` from the dashboard (the page still
   works; the operator row simply does not render).
2. Any autoscaler or monitor scraping `/ops/queues` in production must now send
   `x-operator-token: $OPS_ADMIN_TOKEN`; a tenant api key gets `401 operator
   token required`. The alternative is `/metrics` (same gauges, Prometheus
   format, deliberately unrouted publicly — scrape it on the compose network).

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

## Security headers (S1.3)

Two writers, one header each — never both, because Caddy would *append* a
second value rather than replace ours:

| Where | Sets | On what |
|---|---|---|
| [`Caddyfile`](../deploy/compose/Caddyfile), site block | `Strict-Transport-Security` | **every** response on the host, API and WS included |
| `Caddyfile`, static `handle` block | `Content-Security-Policy`, `X-Content-Type-Options`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy` | dashboard SPA / static files only |
| [`src/api/app.ts`](../src/api/app.ts), `onSend` hook | `X-Content-Type-Options`, `Referrer-Policy`, `Content-Security-Policy`, `Cache-Control` | every API response |

Verify a Caddyfile edit before it reaches the box — a bad one takes the whole
site down, since Caddy fails to start rather than serving unstyled:

```bash
docker run --rm -v "$PWD/deploy/compose/Caddyfile:/etc/caddy/Caddyfile:ro" \
  caddy:2-alpine caddy validate --config /etc/caddy/Caddyfile
```

### What the SPA's CSP allows, and why

`default-src 'self'` with these deliberate widenings — each one is in the
policy because the *built* bundle needs it, not because a template had it:

- **`script-src 'self'`** — no `'unsafe-inline'`, no hash. The shell's
  pre-paint theme setter lives in `dashboard/public/theme.js`, **not** inline.
  Keep it that way: `tests/unit/csp-no-inline-script.test.ts` fails the build
  if a `<script>` body returns to `dashboard/index.html`. (A `'sha256-…'` pin
  was the alternative and was rejected — the hash is byte-exact, and this repo
  is checked out with `core.autocrlf=true` on Windows while the image builds
  from an LF checkout, so the two disagree and the stale hash fails *silently*,
  as an unthemed dashboard.)
- **`style-src 'unsafe-inline'`** — the dashboard uses React `style={{}}`
  attributes throughout. Unavoidable without rewriting every component.
- **`img-src data:`** for inline icons; **`img-src https:`** for the
  email-template **live preview**. `Templates.tsx` renders MJML output into an
  `<iframe sandbox="" srcDoc>`, and a srcdoc document *inherits* the parent
  policy (it has no response of its own), so tenant templates carrying remote
  `<mj-image>` logos would show broken images under `'self'` alone — in the one
  feature whose job is showing the recipient's-eye view. Drop `https:` if that
  fidelity is not worth the widening; images are not a script sink and
  `connect-src` stays `'self'`.
- **`font-src data:`** — not boilerplate. `@fontsource` is self-hosted, but
  vite inlines the small Geist subsets as `data:font/woff2` while emitting the
  rest as `/assets` files. Both forms ship, so both must be allowed.
- **`connect-src 'self'`** — the dashboard calls relative API paths (no
  `VITE_` base URL exists) and derives its WebSocket origin from
  `location.host` (`dashboard/src/lib/wsOrigin.ts`). CSP3 maps `'self'` onto
  `wss:` for an `https:` origin, so same-host sockets are covered **without**
  naming a domain — which is what keeps the "a domain move needs no rebuild"
  property above true.

**No external origin is allowed, because the dashboard touches none.** Fonts
are self-hosted, QR codes are generated locally
(`packages/react/src/qrcodegen.ts`), and there is **no Firebase/gstatic script
and no FCM connect in the dashboard bundle** — web push lives in
`@asyncify-hq/react`, which *consumers* install and serve under their own CSP
(see [PUSH-SMS.md](PUSH-SMS.md)). If a push page is ever added to this
dashboard, it needs `script-src https://www.gstatic.com` and the FCM
`connect-src` entries, or push breaks with no error.

### HSTS: 180 days, no `includeSubDomains`

`max-age=15552000` and nothing else. **Do not add `includeSubDomains`** —
`asyncify.org`'s apex hosts a separate marketing site, and the directive on
`app.asyncify.org` would pin HTTPS-only on every sibling hostname for 180 days
with no way to take it back early. Same reason there is no `preload`.

### The API's own headers

`Referrer-Policy: no-referrer` here is stricter than the SPA's
`strict-origin-when-cross-origin`: API URLs carry ids and handoff tokens **in
the path**, and no API response has a reason to leak its own URL onward.
`Cache-Control: no-store` covers `/auth/*`, whose bodies carry access and
refresh tokens.

The API's CSP branches on the **outgoing content type**, not on a path list
that would drift: `text/html` responses — the phone-facing bot-setup handoff
(`routes/handoff.ts`) and the Slack OAuth result page (`routes/slack.ts`) — get
`default-src 'none'; style-src 'unsafe-inline'; form-action 'self'`, because
both are styled (a `<style>` block and `style=""` attributes) and neither has a
script of any kind. Everything else gets `default-src 'none'`, which only bites
if someone points a browser tab straight at an endpoint.

JWT algorithms are pinned on both sides (`sign.algorithm` / `verify.algorithms`
= HS256), matching what the WS gateway already enforced. Before the pin, a
token forged with **HS512 and the same secret was accepted** by both guards —
that regression is now covered by `tests/integration/security-headers.test.ts`.

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
| `WEBHOOK_SIGNING_SECRET` | `openssl rand -hex 32` | ROOT secret only — never handed to a provider. Each tenant's webhook key is derived from it (see below). Empty **disables** provider-webhook signature verification. |
| `OPS_ADMIN_TOKEN` | `openssl rand -hex 32` | Operator-only secret gating global ops writes (`PUT /v1/ops/public-url`) and, since 2026-09-13, machine reads of platform telemetry (`GET /ops/queues`, `/ops/breakers`, `/ops/logs/stats`), sent as `x-operator-token`. **Not a tenant key** — no tenant api key is accepted for those routes in production. |
| `POSTGRES_PASSWORD` | `openssl rand -base64 48` | Must match the password inside `DATABASE_URL`. |
| `CLICKHOUSE_PASSWORD` | `openssl rand -hex 32` | Analytics only; soft-fails if wrong. |
| `OUTBOUND_URL_ALLOW` | — | **Must stay empty.** It is the SSRF guard's dev escape hatch. |
| `TUNNEL_ID` | `cloudflared tunnel create` | Box-local UUID; creds JSON is never committed. |
| `GOOGLE_CLIENT_ID` | Google Cloud console | **Optional** ("Continue with Google"). Empty = feature off: `/auth/google` 404s and the login page hides the button. |
| `GOOGLE_CLIENT_SECRET` | Google Cloud console | **Optional**, and required together with the id — one without the other still reads as off. |
| `GOOGLE_POST_LOGIN_ORIGIN` | — | **Leave empty in production** (the SPA and the API are one origin behind Caddy). Only local dev sets it, to `http://localhost:5173`. |
| `SMTP_HOST` / `SMTP_PORT` | Resend dashboard | **Required from S1.7a** — the OPERATOR mail path that carries password-reset links. `smtp.resend.com` / `587`. Empty = `/auth/forgot` still answers 200 but nothing is delivered (a warn in the api log is the only trace). |
| `SMTP_USER` / `SMTP_PASS` | Resend dashboard | `resend` and a Resend **API key** (Resend's SMTP mode uses the API key as the password). |
| `SMTP_FROM` | — | `notifications@asyncify.org` — must be on a domain verified in Resend, or every reset email is rejected at the relay. |
| `SMTP_TENANT_FALLBACK` | — | **Must be `false` in production.** The SMTP block above is the PLATFORM's sending identity; without this flag, integration-less tenants fall back to it — with open signup, that is any stranger sending mail through our domain. Platform emails (resets) ignore the flag. |
| `SIGNUP_MODE` | — | `invite` at launch (the beta gate, B1) or `open` for self-serve signup. Anything unrecognized reads as `open` with a warn at boot. **Flipping it to `open` is the launch switch** — see below. |
| `OPERATOR_EMAILS` | — | Comma-separated list of the HUMAN operator seat: who may open the dashboard's **Requests** page, approve/decline access requests, who is emailed when somebody asks, and (since 2026-09-13) who sees the Overview's "Platform (operator view)" cards, the sidebar queue-pulse, and the `/ops/*` telemetry behind them. Matched case-insensitively against the signed-in account's address. Empty = nobody. **Not `OPS_ADMIN_TOKEN`** — that is a machine header; this names people with their own accounts. |

### Beta gate / launch switch (B1)

With `SIGNUP_MODE=invite` the front door is closed to strangers:

- `POST /auth/signup` demands a live invite code that was issued to **the
  address being registered**. Every failure — no code, junk code, expired,
  already spent, issued to somebody else — is the same `403`, so a guessed code
  learns nothing.
- **Continue with Google** still lets every EXISTING account in (sub match, or
  the email-link path onto a password account). Only the *create* branch is
  gated: an unknown Google address with no invite is bounced to
  `/login?gate=request`, which shows the request form. No user row is created.
- The dashboard's sign-up card is replaced by a **request access** form
  (`POST /auth/request-access` — 3/min per IP, 3/hour per address, and always
  the same `200` regardless of what it found, so it cannot be used to test
  whether an address is registered).
- Everyone in `OPERATOR_EMAILS` is emailed when a request arrives and works the
  queue on the dashboard's **Requests** page. Approving mints a single-use code,
  stores only its sha256, and emails a `/login?invite=<code>` link that lives
  **7 days**. Approving an already-approved row is the **resend** (it re-mints,
  killing the previous code).

**Launching = setting `SIGNUP_MODE=open` and restarting api.** Nothing else
changes: existing accounts, invites already spent, and every other route behave
identically, and the Requests page just stops receiving new rows (it stays
visible to operators, showing the history). Going back to `invite` later is the
same one-line move.

`OPERATOR_EMAILS` empty is a working configuration, not a broken one: requests
are still recorded, they are simply waiting for whoever is given the seat. But
set it before flipping to invite, or the first applicant's email goes nowhere.

**Google sign-in, one-time console setup** (skip entirely if you are not
offering it): in [console.cloud.google.com/apis/credentials](https://console.cloud.google.com/apis/credentials)
create an **OAuth 2.0 Client ID** of type *Web application*, and register both
authorized redirect URIs on it — `https://app.asyncify.org/auth/google/callback`
(production) and `http://localhost:3000/auth/google/callback` (local dev, the
API port). Google compares the redirect URI byte for byte, so the dev tunnel
hostname is deliberately never used here: it rotates on every `asyncify dev`
run and could not be registered ahead of time.

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
  without this key is worthless for restoring integrations.** The same box also
  seals the Google one-time login codes in Redis (U6 — they carry a brand-new
  account's API keys across the redirect hop); those self-heal in five minutes,
  so a rotation costs at most a handful of in-flight sign-ins retrying, nothing
  more. No new variable — this is the key you already set.

### The generic provider webhook is per-tenant (S1.2)

`POST /webhooks/providers/:provider/:tenantId` — the tenant is **in the URL**,
and the signature is checked with a key derived for that tenant:

```
tenantKey = hex( HMAC-SHA256( WEBHOOK_SIGNING_SECRET, "tenant:<tenantId>" ) )
```

The root `WEBHOOK_SIGNING_SECRET` never leaves the box; a provider (or a
customer wiring their own status callbacks) gets only that tenant's derived
key, which can forge nothing for anyone else. Derive one on the box with:

```bash
docker compose exec api node -e "console.log(require('crypto').createHmac('sha256', process.env.WEBHOOK_SIGNING_SECRET).update('tenant:'+process.argv[1]).digest('hex'))" <TENANT_ID>
```

The wire format is unchanged (`x-webhook-timestamp` + `x-webhook-signature`
over `` `${timestamp}.${rawBody}` ``, 300s tolerance) — only the URL and the
key changed.

> **One-time deploy step.** The old tenant-less path
> `/webhooks/providers/:provider` now **404s** — deliberately, so nothing keeps
> arriving unscoped. Anything configured against it (a provider console, a
> customer's callback config) must be re-pointed at the tenant URL with the
> tenant's derived key. Nothing in this repo mints that URL programmatically,
> so this is a manual re-paste wherever one was set up by hand.

> **Subscriber tokens die at deploy.** `nst_` tokens are now signed with a
> per-tenant key (`subscriber:$JWT_SECRET:<tenantId>`), so every token minted
> before this release fails verification. Widgets re-mint from the customer's
> own session on the next load — one-time, no action required, expect a brief
> spike of 401s on `/v1/inbox/*` and 4401 WebSocket closes. Their TTL ceiling
> also dropped from 24h to **6h**, default **1h**; a backend explicitly asking
> for more than 6h now gets a 400.

> **Deploying the S1.7a password slice:** production needs the **operator SMTP**
> filled in, or `POST /auth/forgot` accepts every request, answers 200, mints a
> token — and delivers nothing. It fails exactly that quietly by design (the
> route must never reveal whether an address exists), so the only signal is a
> `platform email not configured` warn in the api log. Six lines in
> `.env.prod`, using Resend's SMTP mode against the domain already verified for
> outbound mail:
>
> ```
> SMTP_HOST=smtp.resend.com
> SMTP_PORT=587
> SMTP_USER=resend
> SMTP_PASS=<the Resend API key>
> SMTP_FROM=notifications@asyncify.org
> ```
>
> This is the **platform's** mailbox, not a tenant's: reset mail goes out
> through these env settings and never through a customer's provider chain, so
> a locked-out admin is not blocked by their own broken integration. Note this
> also arms the env-default email provider (`src/providers/registry.ts`), which
> until now was an unconfigured stub in production — tenants with their own
> Resend/SendGrid integration are unaffected, since an integration always wins.
> Gate: from the dashboard log-in page, "Forgot password?" with a real account
> address delivers a link within a minute; `docker compose logs api | grep
> 'platform email'` is silent.

**Preflight refuses dev defaults.** `src/config/preflight.ts` runs as the first
statement of each entrypoint's `main()` and, when `NODE_ENV=production`,
fatal-exits on: a dev-default or sub-32-char `JWT_SECRET`, a dev-default or
sub-32-char `CREDENTIALS_ENCRYPTION_KEY`, an empty `WEBHOOK_SIGNING_SECRET`, an
empty or sub-32-char `OPS_ADMIN_TOKEN`, or a non-empty `OUTBOUND_URL_ALLOW`.
It warns (without exiting) on a localhost `PUBLIC_URL`. This exists because
`src/config/env.ts` gives every variable a fallback — so without the preflight,
a missing secret doesn't crash anything, it boots a fully working system on
values published in this repo. Preflight is never called inside `buildApp()` /
`startGateway()`, so tests are unaffected.

> **Deploying the S1.1 operator-plane slice:** add `OPS_ADMIN_TOKEN` to
> `/root/asyncify/.env.prod` **before** merging it — preflight refuses to boot
> without it, so api, worker and ws will all fatal-exit on the first restart.

> **Deploying the S1.5 box-hardening slice:** two host-side steps, both on the
> box, both before `docker compose up -d --build`.
>
> 1. **Tighten the tunnel credentials.** They are 644 on every box deployed
>    before S1.5 — readable by any account on the machine. Fix them in place:
>    ```bash
>    cd /root/asyncify
>    sudo chown 65532:65532 deploy/compose/cloudflared/creds.json
>    sudo chmod 600 deploy/compose/cloudflared/creds.json
>    docker compose -f docker-compose.prod.yml restart cloudflared
>    ```
>    **Why uid 65532 and not `root`:** `cloudflare/cloudflared` is a distroless
>    image whose process runs as the `nonroot` user, uid 65532. The bind mount
>    carries the host's numeric owner straight into the container — there is no
>    uid translation — so 600 plus the right numeric owner is the only way the
>    container can read the file without anyone else on the host being able to.
>    That uid is unallocated on Ubuntu, so nothing on the host gains access.
>    Gate: `ls -ln deploy/compose/cloudflared/creds.json` shows `-rw------- …
>    65532 65532`, and the cloudflared log registers 4 edge connections after
>    the restart (a permissions mistake shows up as an immediate
>    `error parsing credentials` crash-loop, not a silent degradation).
> 2. **Rebuild the app image.** The runtime user changed from root to `node`
>    (uid 1000) and `docker-compose.prod.yml` now drops every Linux capability
>    from api / worker / ws / acme-tools / web / cloudflared, so a plain
>    `restart` is not enough — `docker compose -f docker-compose.prod.yml up -d
>    --build` is. Nothing binds a port under 1024, so no capability is needed
>    back. Gate: `docker compose exec api id -u` prints `1000`, and all four
>    health endpoints answer as in step 6 below. The data tier (postgres,
>    redis, clickhouse) is deliberately untouched — see the comment block at the
>    top of `docker-compose.prod.yml`.

> **Deploying the S1.7 session slice (refresh-token rotation):** nothing to
> configure — **no new env vars, no host step, and nobody gets logged out.** The
> whole deploy is the ordinary `migrate` in step 5 / Day-2, which adds one
> additive table (`refresh_tokens`, plus three indexes). What changes at runtime:
>
> - `POST /auth/refresh` now **spends** the refresh token it is given and returns
>   a **new** `refreshToken` alongside the `accessToken`. The old response field
>   is unchanged, so the addition is backwards compatible — but a client that
>   keeps presenting its original token will be refused on the second call. The
>   only client is our own dashboard, and it ships in the same commit.
> - `POST /auth/logout` (unauthenticated, takes the refresh token) revokes the
>   whole session family; `POST /auth/logout-all` (needs an access token) revokes
>   every live session of the account and returns `{revoked: n}`.
> - Reusing an already-spent token more than **30 seconds** after it was spent
>   revokes its entire family and logs `refresh token reuse detected` at warn
>   with the `userId` — that line is the theft alarm, and it is the one thing
>   here worth an alert rule. Inside 30 seconds it is a two-tab race and is
>   refused silently.
> - **Live sessions survive the deploy.** Refresh tokens minted before this slice
>   carry no `jti`, so they have no ledger row; rather than rejecting them (which
>   would sign every open dashboard out once), `/auth/refresh` adopts such a
>   token into the ledger under a handle derived from the token itself, then
>   rotates it normally. The adoption is single-use (`on conflict do nothing`),
>   so a pre-deploy token is spent exactly once and is subject to the same theft
>   detection as any other — it is not a grace period, it is a migration.
> - The inactivity sweep (worker, 60s tick) now also deletes ledger rows 30 days
>   past expiry. No new timer, no new process.
>
> Gate: log in, then in the browser console `localStorage.getItem('nk_refresh')`
> twice about 15 minutes apart (or force it by deleting `nk_access` and
> reloading) — the value must have **changed**. Then Settings → "Log out
> everywhere" signs the tab out, and `docker compose logs api | grep 'logout
> everywhere'` shows the revoked count.

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
# The creds file is a bearer credential for the whole tunnel. It is bind-mounted
# read-only into a container that runs as the distroless `nonroot` user, uid
# 65532 — a uid that does not exist on the host, so it cannot be reached
# through group or "other" bits without making the file world-readable. Give the
# file to that uid NUMERICALLY and take every other bit away; do NOT settle for
# 644 to make the container happy.
sudo chown 65532:65532 deploy/compose/cloudflared/creds.json
sudo chmod 600 deploy/compose/cloudflared/creds.json
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
# The PUT is operator-only in production: x-operator-token = OPS_ADMIN_TOKEN
# from .env.prod. A tenant api key is rejected (401 operator token required).
curl -X PUT https://app.asyncify.org/v1/ops/public-url \
  -H "x-operator-token: <OPS_ADMIN_TOKEN>" -H "content-type: application/json" \
  -d '{"url":"https://app.asyncify.org"}'
# The GET stays tenant-readable.
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
`COMPOSE_FILE=docker-compose.prod.yml` AND
`COMPOSE_ENV_FILES=/root/asyncify/.env.prod` as belt-and-suspenders defaults
for interactive shells — bare `docker compose` there picks the prod file and
its env with no flags (without the second export, a bare `up -d` would
interpolate ${POSTGRES_*}/${TUNNEL_ID} as blanks). A dashboard-only change needs just `build web` +
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

**Domain migration** is one `PUT /v1/ops/public-url` (operator-only —
`x-operator-token: $OPS_ADMIN_TOKEN`) plus reconnecting the
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

- **Mailpit.** A dev SMTP sink. Production points `SMTP_HOST` at Resend's SMTP
  relay instead (see Secrets) — as of S1.7a that path is no longer optional,
  because it is what carries password-reset links.
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
