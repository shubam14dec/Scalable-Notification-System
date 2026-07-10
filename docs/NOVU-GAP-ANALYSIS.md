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
