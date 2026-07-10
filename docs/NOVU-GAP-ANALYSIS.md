# Novu (`next`, pulled 2026-07-11) vs Asyncify — Gap Analysis

Method: four parallel code+docs sweeps over the novu monorepo (agents,
workflow engine, inbox/dashboard, platform infra), including undocumented
code-only features, cross-checked against Asyncify's current feature set.
Tiers reflect OUR goals: agents as the differentiator, sellable product,
10–20M-user scale.

- **Tier A** — build next: high product value, fits our architecture
- **Tier B** — valuable, schedule after A
- **Tier C** — heavy or premature; revisit when customers demand
- **Not a gap** — we already have an equivalent (sometimes better)

---

## 1. Agents (our flagship — novu calls theirs "Novu Connect", private beta)

| Novu feature | What it is | Ours today | Tier |
|---|---|---|---|
| **Slack channel** | Full agent channel: OAuth manifest, threads, Block Kit cards, welcome DM + suggested prompts | not supported | **A** — the B2B channel; sales demos live in Slack |
| **Message edit/delete** | `reply.edit()` / `.delete()` updates the sent message in place (all channels) | replies are immutable | **A** — unlocks streaming + progress UX cheaply |
| **Typing indicator** | `ctx.typing('Thinking…')`, per-channel capability matrix | none | **A** (small, pairs with edit) |
| **Streaming / plan progress** | Managed agent streams a live evolving "plan" message (thinking + tool tasks) | parked on our backlog | **B** — built ON edit/delete; do after them |
| **Tool approval cards + tool trust** | `ctx.toolApproval.request()` → native Approve/Deny card; per-agent `agent_tool_trust` so approved tools stop re-prompting | we have buttons (could hand-roll); no first-class approvals | **B** — human-in-the-loop selling point; our buttons pipeline is 80% of it |
| **Welcome message + suggested prompts** | On channel connect the agent sends a welcome DM; Slack shows tappable prompt suggestions | none | **B** (small) |
| **Reactions** | `onReaction` handler + `ctx.addReaction()` | none | **C** |
| **File/attachment replies** | `ctx.reply(text, {files})`, size caps, S3 materialization | none | **C** |
| **WhatsApp channel** | Text + buttons + inbound media | none | **C** — needs WhatsApp Business account ceremony |
| **MS Teams channel** | Multi-tenant app distribution + linking components | none | **C** |
| **MCP servers + per-user OAuth** | Managed agents call Linear/GitHub/etc via MCP; end-users OAuth from inside the chat ("connect card"), token vault | none | **C** — powerful but a platform of its own |
| **Skills (SKILL.md bundles)** | Upload instruction bundles (GitHub URL/inline), versioned | system prompt only | **C** |
| **AI-SDK / LangChain adapters** | Plug a Vercel-AI-SDK or LangChain app in as the bridge brain | plain SDK handler | **B** — cheap DX win for OUR agent SDK (adapter = ~1 file) |
| **Open vs restricted subscriber access** | `restricted` rejects unknown senders; `open` auto-provisions | we are always-open | **B** — one enum + gate; enterprise checkbox |
| **Conversation billing (activation episodes)** | Active-conversation counting per billing window, limits + overage | usage tokens per turn only | **C** — needs a billing system first |
| **Agent evals harness** | Suite-based behavioral evals in CI | manual battle-tests | **B** — we could eval the fabrication defenses in CI |
| **Agent env sync / runtime migration** | Promote agent defs between environments; bridge↔managed migration API | manual re-create | **C** (fold into env promotion, §4) |
| **AI-generated agent config** | LLM synthesizes name/prompt/tools from a description | none | **C** (demo sugar) |
| **Inbound-turn queueing** | Turns arriving mid-run are parked and replayed in order | BullMQ serializes per-conversation job; broadly equivalent | Not a gap (verify ordering under concurrency someday) |
| Identity linking (Slack/Teams/Telegram connect buttons) | Setup links + SDK components | **we have it** for telegram deep link + email auto-match; widget born-linked | Partial gap: connect-button UI components in our react SDK = **B** |

## 2. Workflow engine

| Novu feature | What it is | Ours today | Tier |
|---|---|---|---|
| **Digest: digestKey** | Group digests by a payload field (per-order, per-project digests) | single window per subscriber | **A** — the single biggest digest gap |
| **Digest: backoff strategy** | Send immediately unless a prior event within backoff window, then digest | regular window only | **B** |
| **Digest: scheduled/cron** | Digest fires on a schedule (atTime, weekDays, monthDays, cron) | none | **B** |
| **Throttle step** | Rate-limit sends per key/threshold/window | none | **A** — alert-storm control; small build on our Redis |
| **Delay: until-date / dynamic** | Delay until payload-supplied date or cron, not just fixed seconds | fixed delaySeconds | **A** (small; parameter-space rule says design the range) |
| **Cancel trigger API** | DELETE /events/:txn cancels pending delays/digests | none | **A** — pairs with delays; "order shipped, cancel the reminder" |
| **Per-workflow subscriber preferences** | 5-layer resolution: subscriber-per-workflow → subscriber-global → workflow default; readOnly/critical | global per-channel prefs only | **A** — table stakes for a notification platform |
| **Quiet hours / schedules** | Weekly per-day delivery windows per subscriber, timezone-aware | none | **B** |
| **Severity** | high/medium/low on workflow + trigger override; drives inbox UX | p0/p1/p2 priority (delivery QoS, not UX) | **B** — distinct from priority; feeds inbox |
| **Step conditions: webhook / online-status / prev-step-read** | Condition sources beyond payload/subscriber | payload+subscriber ops only | **B** (prev-step-read first — enables "email only if in-app unread" pattern) |
| **Actor / tenant / context on triggers** | Sender identity, customer-tenant, generalized contexts | none | **B** (actor = avatar in inbox; contexts see §4) |
| **Content variants** | Per-step variants picked by conditions at send time | one content per step | **C** |
| **Email layouts** | Reusable wrappers around step content | MJML templates (versioned) — partial overlap | **C** |
| **Translations / i18n** | Per-locale content, fallback, import/export (EE) | none | **C** |
| **Custom / HTTP-request steps** | Arbitrary code or HTTP call mid-workflow | none | **C** |
| **Code-first workflows (framework/bridge)** | Define workflows in code, discovered via bridge | API/dashboard-defined | **C** — big bet; our agent bridge is the adjacent tech |
| **Topic subscription conditions** | Per-subscription JSON-Logic conditions evaluated at fan-out | plain topic membership | **B** |
| **Topic trigger exclude[]** | Exclude subscriber ids on topic trigger | none | **B** (tiny) |
| Trigger idempotency, bulk, broadcast | — | **we have** transactionId, broadcast, batched fan-out | Not a gap |
| Retries/DLQ/failover/breakers | — | **we have** (chains + breakers + DLQ replay arguably richer) | Not a gap |

## 3. Inbox / end-user surfaces

| Novu feature | What it is | Ours today | Tier |
|---|---|---|---|
| **Notification action buttons** | Primary/secondary CTAs with pending→done complete/revert semantics | AgentChat has buttons; NotificationInbox items do NOT | **A** — we built the pipeline in Phase 4; extend it to inbox items |
| **Archive + snooze states** | Read/unread/archive/snooze (with date-picker, auto-resurface worker) | read/unread only | **A** (archive) / **B** (snooze — we have the sweep pattern for resurfacing) |
| **Redirect URLs on notifications** | url + target per notification, sanitized | none | **A** (tiny, ships with action buttons) |
| **Tabs / filters** | Tag/data/severity tabs in the widget | single list | **B** |
| **Preference center component** | End-user per-workflow/channel toggles inside the widget | none (admin-side only) | **A** — pairs with per-workflow prefs (§2) |
| **Per-severity badge counts** | Bell glow/counts per severity | single unread count | **C** |
| **Custom rendering / appearance API** | renderNotification props + hundreds of theming keys | dark/light palettes | **C** — polish when selling the widget |
| **Localization of widget strings** | 65-key localization prop | none | **C** |
| Keyless/HMAC widget auth | HMAC subscriber hash | **we have** signed subscriber tokens (stronger default) | Not a gap |
| Headless hooks | useNotifications/useCounts/usePreferences | **we have** useNotifications/useAgentChat; add usePreferences with pref center | Partial |

## 4. Platform / infrastructure

| Novu feature | What it is | Ours today | Tier |
|---|---|---|---|
| **Environment promotion + diff** | Publish workflows/layouts/agents dev→prod with dry-run diff (created/updated/skipped) | envs exist; promotion is manual re-creation | **A** — required for real customers to trust envs |
| **Outbound webhooks (customer-facing)** | message.sent/failed/delivered/read…, workflow.*, preference.updated — Svix-backed with hosted portal | none | **A** — customers integrate on this; we'd self-build (no Svix dependency) |
| **RBAC (roles + ~30 permissions)** | OWNER/ADMIN/AUTHOR/VIEWER + @RequirePermissions | single-role org members | **B** — needed at sale time; boring until then |
| **Tenants / contexts** | Customer-of-customer scoping (branding, integrations, prefs per tenant) | none | **B** — our integration chains could take per-tenant conditions |
| **Integration conditions** | An integration applies only when subscriber/tenant conditions match | failover chains (ordered) only | **B** (the cheap 80% of tenants) |
| **Provider breadth (~70 providers)** | 38 SMS, 18 email, 10 chat, 8 push | a handful per channel | **C** — add on customer demand, our provider interface makes each cheap |
| **Data retention policies** | Tiered retention windows per artifact | keep-forever | **B** — a scale/compliance issue eventually; one sweep-pattern job |
| **Rate limiting (token bucket, per-category costs)** | TRIGGER/CONFIG/GLOBAL categories, burst, per-request cost | per-tenant rate limit + overflow QoS (stronger on QoS, weaker on API categories) | **C** |
| **Billing / feature tiers** | ~110 feature flags mapped to plans, Stripe metering | none | **C** — needed when charging, not before |
| **SSO/SAML, MFA** | Clerk/EE | password auth | **C** |
| **Own inbound-mail infra (MX, SPF/DKIM, domain routes)** | Dedicated inbound-mail service + domain verification | Postmark inbound webhook (deliberate: no DNS access) | **C** — revisit when asyncify.org DNS is real |
| **CLI + local tunnel service** | novu CLI with managed tunnel (novu.sh) | cloudflared drill (manual) | **C** — a `asyncify dev` command wrapping the tunnel drill would erase our rotation pain, though: **B** for DX |
| **Command palette (⌘K)** | Dashboard quick nav | none | **C** (fun, cheap) |
| Encryption at rest, HMAC, API keys per env | — | **we have** (secret-box AES, hashed keys, signed tokens) | Not a gap |
| Activity/execution observability | — | **we have** (timeline, exec log, ClickHouse, Jaeger, Prometheus) | Not a gap |

---

---

# Round 2 — exhaustive pass (all 440 docs files + full codebase, 2026-07-11)

Eight parallel sweeps: every docs/platform + docs/agents/framework/guides/
api-reference page read file-by-file; apps/api, apps/worker+ws+webhook+
inbound-mail, apps/dashboard, libs/dal + application-generic + automation +
notifications + agent-evals, packages/framework + agent-toolkit +
chat-adapter(+email) + stateless + novu CLI, packages/js/react/providers/
shared. Architecture comparison in docs/ARCHITECTURE-COMPARISON.md.
New findings beyond round 1:

## New feature gaps found (additions to the matrix)

| Feature | What it is | Tier |
|---|---|---|
| **Idempotency-Key header** | API-layer dedupe protocol: 409 on in-flight dup, 422 on same-key-different-body (body hash), 24h cached replay with `Idempotency-Replay` header. Distinct from transactionId | **A** (small; rides our Redis) |
| **SSRF hardening on outbound URLs** | assertSafeOutboundUrl + DNS-pinned redirect re-validation on every user-supplied URL (bridge, webhooks). We currently POST to bridge URLs unguarded | **A** — security, do with next agents phase |
| **Notification action complete/revert semantics** | Inbox buttons carry server-tracked pending→done state with revert | folds into Inbox v2 (Tier A) — adopt their semantics |
| **Digest precision** | digestKey + backoff + cron/timed windows (subscriber-timezone), `countSummary`/`sentenceSummary` helpers ("Radek, Dima, and 5 others"), only-one-digest-per-workflow rule, digest-failure-halts rule | already Tier A — semantics now fully specified |
| **Subscriber schedule (quiet hours)** | weekly per-day windows, 30-min increments, tz-aware, critical + inapp exempt, deferred steps can "extend to schedule" (cap 3 extensions) | Tier B (spec now complete) |
| **Env variables in templates** | `{{ env.KEY }}` per-environment named/secret values usable in editors, conditions, HTTP steps | **B** (small, useful) |
| **Webhook connectors** | outbound events straight into ClickHouse/Snowflake/Redshift/SQS/SNS with JS transformations | C (enterprise; note for outbound-webhooks design) |
| **Contexts** | persistent typed `type:id` objects (≤5/trigger, 64KB data) scoping triggers/topics/subscriptions/inbox — their tenant successor | B (was "tenants"; contexts is the better-designed version to copy) |
| **Agent cards: Select + TextInput** | beyond buttons: dropdowns and text inputs in cards, plus card links/dividers/fields | **B** — natural next step after our buttons |
| **Tool approval via workflow (agent-toolkit)** | deferred tool calls fire a notification workflow; human approves from ANY channel; `message.interacted` webhook resumes execution with approve/edit/reject | **B** — pairs beautifully with our buttons + trigger machinery |
| **Keyless/demo mode** | try the widget/agents with zero signup (`pk_keyless_*` localStorage identity, claim-token upgrade to real org) | C (growth feature, clever) |
| **Data residency regions** | region-bound API keys, US/EU+ | C (deployment topic) |
| **Rolling dual API keys** | max 2 active secret keys per env for zero-downtime rotation | **B** (small; we have 1) |
| **AI copilot** | LangGraph dashboard agent editing workflows with checkpoint/keep/revert | C (their moat investment; ours would be premature) |
| **add-inbox CLI scaffolder** | `npx`-style codegen detecting framework/pkg-manager, drops a wired widget | B — great DX for @asyncify-hq/react adoption |
| **`asyncify dev` tunnel command** | their `novu dev`: managed tunnel + watchdog (sleep-drift detect) + half-open probe + auto devBridgeUrl registration — would erase our cloudflared rotation drill | **B** — our recurring pain, their solved problem |
| **Payload schema validation on trigger** | per-workflow JSON Schema, AJV compiled + LRU-cached by schema hash, opt-in `validatePayload` | B |
| **Provider catalog machinery** | catalog-as-data (IProviderConfig[] drives UI + typed credentials), Nx generator scaffolding new providers, canonical status enums, generic `*-webhook` escape-hatch provider per channel | B — the enabler for cheap provider breadth |
| **Agent evals harness** | LLM-judge + deterministic graders + scripted mock-shell tapes, run in CI | B (we battle-test manually; this CI-fies it) |
| **Streaming adaptation** | post-then-edit-on-interval where editable; buffer-and-post-once on email/WhatsApp | folds into streaming backlog item |
| **Notification container concept** | trigger×subscriber = one "notification" row holding jobs/messages/status — cleaner billing + activity grouping than per-message | note for engine v2 |

## Corrections/notes to round-1 tiers
- **Inbound-turn queueing**: confirmed they park+replay concurrent turns; our BullMQ per-conversation jobs serialize but VERIFY ordering under concurrent sends someday.
- **Their agents product is private beta** and Slack-first; our 3 live channels with verified linking is genuinely competitive. Their edit/delete/typing/streaming/cards-beyond-buttons remain the visible UX gaps.
- **Environment promotion** (round-1 Tier A) is confirmed as a full diff/publish subsystem (Change entities, per-resource sync strategies, dry-run) — bigger than round 1 assumed; plan as its own phase.
- **novu has NO circuit breakers** on providers (priority/primary + conditions only) — our failover chains + breakers are ahead; keep saying so in sales material.

## Recommended build order (Tier A distilled)

1. **Inbox v2** — notification action buttons (+ redirect), archive, snooze.
   Reuses the Phase 4/6 machinery (buttons pipeline, sweep resurfacing).
2. **Preferences v2** — per-workflow subscriber preferences (layered
   resolution) + end-user preference center in the widget.
3. **Workflow engine v2** — digestKey, throttle step, delay-until-date,
   cancel-trigger API. (Digest backoff/cron as fast-follow.)
4. **Slack agent channel** — the biggest agents gap; our connection
   model (agent_connections + webhook + thread_key) maps 1:1.
5. **Agent message edit/delete + typing** — small, unlocks streaming next.
6. **Environment promotion with diff** + **outbound webhooks** — the two
   platform features customers ask about in week one.

Everything Tier B/C stays recorded here; promote when a phase slot opens.
