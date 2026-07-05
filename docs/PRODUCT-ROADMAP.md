# Product Roadmap — From Engine to Sellable Product

The engine (queues, channels, resilience, observability, scale) is done. This
plan covers the product layer that makes it sellable: dashboard, self-serve
onboarding, integration store, SDKs, topics, workflow logic, and templates.

---

## 0. Tech stack decisions (one table)

| Layer | Choice | Why |
|---|---|---|
| Dashboard SPA | **React 18 + Vite + TypeScript** | Industry default; huge component ecosystem; Vite dev speed |
| UI components | **shadcn/ui + Tailwind CSS** | Modern look with full code ownership (no runtime dep lock-in) |
| Data fetching | **TanStack Query** | Cache/invalidations over our existing REST API, zero backend changes |
| Routing | **TanStack Router** | Type-safe routes |
| Charts (analytics) | **Recharts** | Simple, fits ClickHouse aggregates |
| Dashboard auth | **JWT (access+refresh) + argon2id password hashing** | Stateless, works across API replicas; no session store needed |
| Secrets at rest (provider credentials) | **AES-256-GCM, master key from env/KMS** | Integration credentials are the crown jewels |
| Email templates | **Handlebars (logic) + MJML (responsive HTML)** | MJML compiles to bulletproof email HTML; Handlebars supersedes our `{{var}}` renderer (backward compatible) |
| Template editing UI | **CodeMirror 6 + live preview iframe** (phase 1), visual builder later | Code-first editor ships in days; drag-drop builders take months |
| Server SDK | **TypeScript, zero-dependency fetch wrapper**, published as `@<brand>/node` | Thin client over REST; ESM+CJS dual build with tsup |
| In-app UI kit | **`@<brand>/react` package: `<NotificationInbox />`** headless hook + styled component | The drop-in inbox widget is the single most-adopted piece of this product category |
| Repo layout | **npm workspaces monorepo**: `apps/api`, `apps/worker`, `apps/ws`, `apps/dashboard`, `packages/sdk-node`, `packages/react` | SDKs and app share types; single version, single CI |
| Push (real) | **firebase-admin (FCM HTTP v1)** — covers Android + iOS via APNs relay; direct APNs later | One credential (service-account JSON) reaches both platforms |
| Tests / CI | **Vitest + GitHub Actions** (typecheck, test, docker build) | Table stakes before selling |

Everything else stays as-is: Fastify, BullMQ/Redis, PostgreSQL, ClickHouse,
Prometheus, OpenTelemetry, Helm/KEDA.

---

## Phase A — Multi-tenant foundation (everything else depends on this)

**A1. Accounts & organizations**
- New tables: `users` (email, argon2id password hash), `org_members`
  (user↔tenant, role: owner|admin|member), extend `tenants` → treat as
  "organizations".
- Auth endpoints: signup, login, refresh, invite member. JWT middleware for
  dashboard routes (separate from `x-api-key` machine auth).

**A2. Environments & API keys**
- `environments` table (org → dev/staging/prod), each owning its own API
  keys, subscribers, workflows, messages (add `environment_id` to those
  tables; backfill existing rows into a default env).
- `api_keys` table: **hashed** keys (store SHA-256, show once on creation),
  multiple active keys, rotation + revocation endpoints.

**A3. Repo restructure to npm workspaces** (mechanical move of `src/` into
`apps/`, shared types into `packages/shared`).

*Deliverable: a stranger can sign up, get an org + dev/prod envs + API key,
and trigger their first notification without us touching the DB.*

## Phase B — Integration store (bring-your-own providers)

- `integrations` table: environment_id, channel, provider slug, **encrypted**
  credentials (AES-256-GCM), `is_primary`, `fallback_order`, active flag.
- Provider factory: registry becomes DB-driven per environment — resolve
  integration → decrypt → instantiate provider (cached, invalidated on
  update). Existing circuit breaker/failover chain plugs in unchanged.
- Real providers, in order of demand: **SendGrid, SES, SMTP (have), Resend**
  (email) · **Twilio, MSG91** (SMS) · **FCM** (push, see push section) ·
  **Slack incoming-webhook, Discord, generic webhook** (new `chat` channel —
  cheap to add and demos well).
- CRUD endpoints + credential validation ("send test message" button).

## Phase C — Dashboard (the thing people buy)

Pages, in build order:
1. **Auth** (login/signup/org switcher) → 2. **API keys & environments** →
3. **Workflows list + editor** (steps as cards: channel, template, delay,
digest, conditions) → 4. **Activity feed** (per-notification timeline from
execution logs + message statuses; the "why didn't user X get the email?"
screen) → 5. **Subscribers** (search, preferences, suppressions) →
6. **Integrations store UI** → 7. **Analytics** (delivery rates, latency,
volume per channel/provider — straight from ClickHouse + Prometheus data).

Served as a static SPA (Fastify `@fastify/static` or any CDN); talks only to
the public REST API — which keeps the API honest and fully documented.

## Phase D — SDKs & embeddable inbox

- `packages/sdk-node`: `new Client(apiKey).trigger('welcome', { to, payload })`,
  `broadcast()`, `subscribers.upsert()`, `inbox.list()` — typed against
  shared zod schemas.
- `packages/react`: `useNotifications()` hook (WS connect, unread count,
  pagination, mark-read) + `<NotificationInbox />` styled component (bell,
  dropdown, list). Auth via short-lived signed subscriber tokens (HMAC,
  minted by the customer's backend through the SDK) — replaces raw apiKey in
  the browser (the gateway already flags this as its production TODO).
- Publish both to npm; versioned OpenAPI spec for other languages.

## Phase E — Topics / segments

- `topics` (environment, key, name) + `topic_subscribers` join table.
- Endpoints: create topic, add/remove subscribers (bulk), list.
- Trigger accepts `to: [{ topic: "beta-users" }]`; broadcast accepts
  `topicKey`. Fan-out pages the join table with the same keyset+backpressure
  machinery the 10M broadcast already uses.

## Phase F — Workflow logic v2

- **Step conditions**: `step.if` — a small typed condition list
  (`{ field, op, value }[]` over payload + subscriber attributes), evaluated
  at fan-out. No eval(), no sandbox risk.
- **Cross-step conditions**: "send push only if the email from step 0 is not
  `read`/`opened` after 1h" — implemented as: delay the step, then at
  delivery time re-check the referenced message's status (we already track
  delivered/read); skip if satisfied. Needs email open tracking: a 1px
  tracking pixel route + `opened_at` on messages.
- **Per-step channel override of priority**, and step-level `stopOnFailure`.

## Phase G — Email templates that sell

- Handlebars rendering (drop-in superset of current `{{var}}`) + MJML
  compile step for email HTML, with plain-text auto-derivation.
- `templates` table (shared, versioned) so one template serves many
  workflows; workflow steps reference template + overrides.
- Dashboard: CodeMirror editor, variable autocomplete from a sample payload,
  live MJML preview, "send test to myself".

## Suggested order & rough effort

| Order | Phase | Effort (focused days) |
|---|---|---|
| 1 | A — multi-tenant foundation + workspaces | 3–4 |
| 2 | B — integration store + real FCM/SendGrid/Twilio/Slack | 3–4 |
| 3 | C — dashboard (iterative; first useful cut) | 5–8 |
| 4 | D — SDKs + React inbox | 3–4 |
| 5 | E — topics | 1–2 |
| 6 | F — workflow logic v2 + open tracking | 2–3 |
| 7 | G — template system | 2–3 |

A→B→C is the sellable core; D is what makes developers adopt it; E–G are the
feature-depth that closes deals.
