# Asyncify — Task Board

Per the asyncify-engineering skill: plans land here as checkable items
before implementation; items get checked off as they complete; finished
plans get a short review section, then move to Done.

## Production-grade agents roadmap (agreed 2026-07-21, ranked; plans
## need user approval per phase)

- [ ] Phase 21 — Agent observability — BUILD COMPLETE 2026-07-21, user
      E2E pending (plan: ~/.claude/plans/phase21-agent-observability.md;
      suite 543→558 twice; all Opus, audited):
      [x] A capture: TurnTrace on every runManagedTurn exit (model_call
          ms/tokens/stopReason incl. thrown-call event; tool_call
          ok/paused), persisted beside usage on reply rows AND
          refusal/limit/paused notes; bridge_post parity; OTel spans
          (brain.model_call / brain.tool)
      [x] B API+SDK: detail trace passthrough; GET /v1/agents/:id/health
          (FILTER/percentile_cont/make_interval, 60s bounded cache,
          conversations_agent_idx added); sdk-node agents.health() +
          changeset (node minor)
      [x] C dashboard: Turn Inspector (usage line = toggle, indented
          event timeline, dots-only failure) + Health modal on Agents
          page (7d/30d, warn dot >5% tool failures or >20% notes)
      [x] D tests: +15 (trace shapes per exit, persistence incl. bridge,
          health aggregates/window/cache-aware matrix) — 558/558 ×2
      [ ] USER E2E + review + LOCAL commit close
      Note for Phase 22: agent_tool_calls has no execution-duration
      column → per-tool avgMs is null; add duration capture with the
      guardrails work. Crash-mid-turn traces still unrecorded (D7).
- [ ] Phase 22 — Evals-as-gate + guardrails hardening: CI eval gate;
      customer-facing pre-save eval runs ("3/12 scenarios regressed");
      LLM-judge dimensions (groundedness/tone/refusals); one-click
      prod-conversation→eval-case; tool-call rate caps; per-agent
      token/spend budgets (pause not surprise-bill); topic allow/deny;
      output moderation hook; REPEAT-ACTION guardrail (his insight:
      >N refunds/window flips tool to approval-required, approval card
      shows history from agent_tool_calls; agent detects → rule
      decides → human judges)
- [ ] Phase 23 — Knowledge (RAG) + episodic memory: pgvector in the
      existing Postgres; per-agent OPTIONAL knowledge sources
      (files/URLs → chunks → embeddings), retrieval as a TOOL BLOCK
      (breadcrumbs record what was read; groundedness auditable),
      citations; episodic = same retrieval over past conversation
      summaries (continuity, repeat-problem escalation, product
      intelligence, tone calibration)
- [ ] Phase 24 — Long-term memory + cost: subscriber_memories keyed
      rows (NOT vectors; load-all each turn; dashboard view/edit +
      GDPR delete; `remember` tool); rolling summarization (summary +
      recent turns replay — also the big cost lever); prompt caching
      (near-free); budgets+alerts; model routing later
- [ ] Later bucket: HITL conversation handoff (handoff_to_human tool,
      operator takeover in dashboard, hand-back, SLA timers on
      approvals via sweep pattern); security hardening (PII redaction
      in logs/breadcrumbs, per-tenant retention auto-purge, per-END-
      USER rate limits, RAG docs = untrusted input); prompt versioning
      + canary (template-versioning pattern); scaling (provider-aware
      LLM concurrency + LLM failover chain mirroring channel failover)

## Backlog (next candidates, in rough value order)

**From the novu gap analysis (2026-07-11, docs/NOVU-GAP-ANALYSIS.md —
full tiered comparison lives there; these are the Tier-A picks):**

- [ ] Inbox v2: action buttons (complete/revert semantics) + redirect
      URLs + archive + snooze on NotificationInbox items (reuses the
      Phase-4 buttons pipeline + the sweep pattern for snooze resurfacing)
- [ ] Preferences v2: per-workflow subscriber preferences (layered
      resolution: subscriber-workflow → subscriber-global → workflow
      default) + end-user preference center component in the widget
- [ ] Workflow engine v2: digestKey (group digests by payload field),
      throttle step, delay-until-date/dynamic, cancel-trigger API
- [x] Slack agent channel: threads → conversations, Block Kit buttons,
      per-scope routing — Phase 13 (2026-07-12). Still open from the
      original item: OAuth Add-to-Slack one-click install (13b; today =
      manifest paste) and welcome message → stay in backlog below
- [x] Agent replies: edit/delete tombstones (user+operator,
      cross-channel propagation) + typing indicators — Phase 10
      (2026-07-12)
- [ ] Environment promotion dev→prod with dry-run diff; outbound
      webhooks to customers (message.sent/failed/delivered/read,
      workflow.*, preference.updated)

**Round-2 additions (2026-07-11 exhaustive pass — full details +
architecture comparison in docs/NOVU-GAP-ANALYSIS.md and
docs/ARCHITECTURE-COMPARISON.md):**

- [x] SSRF hardening on all user-supplied outbound URLs — Phase 9,
      commit 77a4400 (2026-07-12)
- [ ] Idempotency-Key header protocol: 409 in-flight / 422 body-hash
      mismatch / 24h cached replay (Tier A — small, rides Redis)
- [x] Agent cards v2: Select dropdowns + TextInput on top of the
      buttons pipeline — Phase 14, incl. plan-card streaming
      (2026-07-12)
- [ ] Tool approval via workflow: deferred tool call fires a real
      notification; human approves from any channel; webhook resumes
      (Tier B — composes our buttons + trigger machinery)
- [x] `asyncify dev` CLI command: managed tunnel + sleep-drift
      watchdog + auto PUBLIC_URL/webhook re-registration — Phase 16,
      released as @asyncify-hq/cli@0.1.0 (2026-07-13); + create-agent
      scaffolder
- [ ] Rolling dual API keys per environment (Tier B — small)
- [ ] API polish: map Fastify FST_ERR_CTP_* (415 unsupported media
      type) to a clean 4xx JSON error instead of 500 'internal error'
      (found in Phase 11 E2E via PS5.1 bodyless POST)
- [ ] Engine hygiene from their DAL: keyset pagination + capped
      counts on list endpoints; mandatory column projection on hot
      queries; cache-set TTL jitter (Tier B — adopt incrementally)

**Phase 18/19 polish leftovers (small, non-blocking):**
- [x] sdk-node wrappers: client.agents.tools.* / client.approvals.* /
      client.settings.{getApprovals,putApprovals} + types + README —
      shipped 2026-07-16 (Opus, audited; live-smoked via the BUILT
      package against :3000; changeset minor → node 0.3.0)
- [x] decidedBy for dashboard deciders now resolves to
      `dashboard: <email>` at decision time (stored, not
      display-resolved; missing user → raw sub; api-key unchanged) —
      shipped + user-verified 2026-07-16 ("dashboard:
      shubam@xmobility.ai" in History)
- [ ] approval-pause eval scenario assumes the gated refund_customer
      stays registered on support-demo (fails loudly if removed — by
      design, but worth remembering)

**Phase 17 polish leftovers (small, non-blocking):**
- [ ] GET /v1/connections: expose quickSetup flag on slack rows so the
      dashboard hides re-arm on manual connections (today it 409s
      politely)
- [ ] Fold setup_handoffs purge into the inactivity sweep (today:
      opportunistic delete on mint)
- [ ] Welcome-message empty-string == clear sentinel (API can't store
      an explicitly empty greeting; fine unless someone asks)
- [ ] tests tsconfig: lib ES2023 needed (agents.test.ts findLast) if
      tests ever enter the typecheck
- [ ] Slack CMD+A credentials paste parser for the manual tab (novu
      parity; Quick Setup made it near-moot)

**Agents / conversations — future phases** (continuation of the shipped
inapp/telegram/email platform; promoted here from the Phase-1/2 parked
notes. Order within this cluster is rough — reorder freely.)

- [ ] Streaming managed replies — PLAN-READY, parked 2026-07-16 by user
      ("we will pick this later"). Full scouted design + locked
      decisions in `~/.claude/plans/phase-streaming-replies-PARKED.md`:
      managed brains → widget only; snapshot-publishing over the
      existing .updated pathway (gateway + widget sink need ~zero
      changes); auto-fallback for non-SSE LLM endpoints; ~1 day,
      4 slices. Pickup = read the plan file, launch slices.
- [x] Auto-resolve on inactivity: per-agent sweep with system
      breadcrumb — shipped (see tests/integration/inactivity-sweep.test.ts)
- [x] Subscriber linking (tg deep-link `/start <token>`, email sender
      auto-match, slack auto-match): shipped across Phases 13/15 incl.
      <ConnectChannels> self-service UI + token-only /v1/me family
      (2026-07-12). Remaining nicety: QR handoff for desktop t.me →
      polish backlog

- [ ] Landing page for asyncify.org (public face; domain currently unpointed)
- [x] Release automation: Changesets + GitHub Actions — shipped, and
      better than planned: OIDC trusted publishing, NO npm token
      anywhere (see RELEASING.md incl. the new-package bootstrap).
      All four packages live: node@0.2.1 agent@0.4.0 react@0.5.0
      cli@0.1.0
- [x] CI workflow (.github/workflows/ci.yml): postgres/redis/mailpit
      services, migrate → typecheck → 152 tests → SDK + dashboard
      builds on every push/PR; README badge. (2026-07-10)
- [ ] Compliance gap set from email-delivery skill §5: List-Unsubscribe /
      RFC 8058 headers on P2 email, public unsubscribe endpoint, consent
      fields on subscribers, marketing footer block
- [x] npm workspaces wiring for packages/ — shipped (root
      `workspaces: ["packages/*"]`, four packages linked)
- [ ] Agent toolkit `@asyncify-hq/agent-toolkit` (workflows-as-LLM-tools
      + MCP server + human-in-the-loop wrapper) — superseded by the
      Conversations/Agents build below; cheap add-on later since it
      wraps the existing trigger API

## In progress

### Phase 20: Push & SMS hardening — BUILD COMPLETE, user E2E pending
(plan approved 2026-07-18 + user added native mobile SDK; full plan in
`~/.claude/plans/phase20-push-sms-hardening.md`. ALL COMMITS LOCAL.
All slices Opus, audited; suite 543/543 twice.)
- [x] Foundation (manager): device_tokens table + legacy backfill;
      messages.device_key (5-col dedupe — audit had missed that the
      old 4-col unique key made one-row-per-device impossible);
      device-tokens.repo; sms-segments + phone(E.164) utils; route
      stubs pre-wired in app.ts (492/492 parity before slices)
- [x] A. Device APIs + SDK: /v1/me/devices + /v1/subscribers/:id/
      devices (both auth planes, no-oracle deletes), legacy pushToken
      write-mirror, E.164-in-upsert; sdk-node registerDevice/
      listDevices/removeDevice + typed WorkflowStep.push (revision) +
      changeset (Opus, audited; 5/5 live curls on :3011)
- [x] B. Pipeline: multi-device fan-out (batched device read, one msg
      per device, per-device suppression/correlation; digest push =
      newest device, v1), dead-token row deletion in FCM provider,
      rich push (clickUrl/imageUrl/data → webpush+android+apns,
      SSRF-gated w/ {{var}} bypass), 10-segment send guard, E.164
      reject at admin+trigger (Opus, audited; 80/80 targeted incl. 11
      new; in-process verification — sanctioned fleet-safe path)
- [x] C. Twilio receipts: per-send StatusCallback via runtime public
      URL; public callback route w/ X-Twilio-Signature (host-header
      URL = tunnel-rotation safe), delivered/failed mapped onto the
      status queue, intermediates 204 no-op; STOP(21610) suppression
      on BOTH send-rejection (revision) and callback (Opus, audited;
      live sim: 204/403/404 + sent→delivered flip via real worker)
- [x] D. Web: usePushRegistration in @asyncify-hq/react (firebase =
      optional peer, canonical SW in README, sticky opt-out marker
      'asyncify:push:opted-out' — revision; disable() must survive
      reloads) + editor rich-push fields + live SMS segment counter
      (dot-colored over-limit per design system) + changeset (Opus,
      audited; react + dashboard builds green)
- [x] G. Native: NEW @asyncify-hq/react-native 0.0.0 (same hook shape,
      required RN/firebase peers, optional async-storage peer for the
      same sticky opt-out — revision; OS is the receiver, no SW) +
      examples/push-test-app (Expo + EAS cloud build, no local Android
      toolchain) + changeset (Opus, audited; clean-room build green;
      workspace-linked at close-out, lockfile verified 0 entries
      removed / 586 added)
- [x] E. Tests: +51 over baseline → 543/543 twice (segments matrix,
      E.164 matrix, device repo cap/evict/re-point, both route planes,
      multi-device fan-out, dead-token deletion via stubbed FCM — the
      baseline's one unproven cell, Twilio callback matrix incl. 21610,
      rich payload mapping) (Opus; zero bugs found in landed code)
- [x] F. Docs: docs/PUSH-SMS.md customer guide (Acme cast, honest
      receipts story, every snippet source-verified) + README pointer
      (Opus, audited)
- [x] Fleet restarted on new code (api/worker/ws; dashboard hot-reloads)
- [x] USER E2E 1-5 (2026-07-18): multi-device pop (Chrome+Edge, one
      trigger) ✓; rich push image + CROSS-ORIGIN click→blinkit ✓;
      segment counter (emoji→Unicode flip) + 11-segment send guard
      failed loudly pre-Twilio ✓; receipt sent→delivered through the
      tunnel ✓; dead-token auto-cleanup (row deleted, 1 attempt) ✓ —
      proven accidentally when unregistering the SW killed the token.
      HIS E2E CAUGHT TWO SHIPPED BUGS, both fixed + ledgered:
      (1) canonical SW double-painted every push (FCM SDK auto-display
      + our onBackgroundMessage painter) → SW is now init-only;
      (2) FCM SDK's click handler drops CROSS-ORIGIN clickUrls (host
      check in their source) → our notificationclick registered BEFORE
      firebase.messaging() opens any origin + stops propagation.
- [x] USER E2E 6 NATIVE done (2026-07-18, friend's Android over adb +
      WhatsApp APK; his iPhone 15 can't sideload): notification with
      image arrived APP-CLOSED via Play Services; tap → app blink →
      blinkit opened ✓; one trigger popped phone + Chrome + Edge.
      THE PHONE FOUND TWO MORE SHIPPED BUGS, fixed + committed:
      (3) package crashed on launch under Metro — Expo ignores
      `exports`, `main` served the Node-mode CJS build whose default-
      import interop calls the firebase module OBJECT ("Object is not
      a function", adb crash log) → `react-native` package.json field
      now points Metro at the ESM build (bundle-verified);
      (4) tapping a rich push opened the app and STOPPED — native has
      no browser-opens-directly path, so the hook now forwards
      data.clickUrl via Linking.openURL (onNotificationOpenedApp +
      getInitialNotification; `openClickUrlOnTap: false` opt-out).
      Also fixed en route: EAS empty file: dep → packed tarball;
      root-level .easignore (monorepo reads GIT ROOT, never .env);
      expo-splash-screen required by prebuild; repack-same-version
      needs lockfile regen + npm cache clean (integrity pin).
- [x] RELEASED 2026-07-19: pushed (scrub clean) → user bootstrapped
      react-native@0.0.0 + Trusted Publisher → merged PR #10 →
      node@0.4.0, react@0.7.0, react-native@0.1.0 live with provenance

Notes for later (from E's review): updateMessageByProviderId has no
terminal-state guard (a late 'sent' could regress 'delivered'; today
unreachable — the webhook 204s intermediates before enqueue). Backlog:
per-device digest fan-out; inbound two-way SMS (STOP content webhook).

## Recently finished

### Agents — Phase 19: Channel Approvals (tap Approve/Deny in Slack/Telegram) — COMPLETE
(plan approved 2026-07-15 auto mode; full plan in
`~/.claude/plans/phase19-channel-approvals.md`. Approval cards post to a
configured Slack channel (membership = authz boundary, per-tap identity
recorded + enriched via Phase-15 links) and to telegram identities
linked to the 'approvals' subscriber; taps reuse the atomic
decideToolCall + the same tool-decision job (all entry points
converge); cards edited in place to the outcome; first tenant-wide
setting (tenant_settings table). callback_data scheme apv:a:<uuid>
fits telegram's 64-byte cap. ALL COMMITS LOCAL. All Opus.)

- [x] Foundation (manager): tenant_settings + cards column + repo bits
      (schema live-verified; tenant-settings.repo.ts new; ApprovalCardRef
      + setToolCallCards in agent-tools.repo; tsc green)
- [x] A. API: settings GET/PUT + approvals view +result
      (Opus, audited; validation matrix curl-proven on :3044;
      explicit-null cascades slackChannelId, inherited-null + channel
      set = 400; approver count from linked identities; result
      truncated 500 in view)
- [x] B. Worker/brain: card poster + decision finalizer
      (Opus, audited; 4/4 live scenarios incl. not_in_channel
      graceful degrade w/ invite hint + telegram-still-posts;
      correct divergence: executed snippet uses finalResult, not the
      stale pre-POST call.result)
- [x] C. Inbound: slack interactivity + telegram callback branches
      (Opus, audited; 22/22 live proof — winners/losers/identity/
      foreign-ack/regression; branches slot BEFORE conversation
      machinery (taps never open threads); frozen job byte-exact;
      71 existing slack+telegram tests intact)
- [ ] D. Dashboard: settings section on Approvals page
- [x] E. Tests: posting/taps/race/not_in_channel + parse unit
      (Opus, audited; suite 470→492 green 2x; 22 new incl. the full
      loop pending→tap→POST→cards-finalized→follow-up; adversarial
      find: telegram branch ordered after agent resolution → revision
      dispatched to C; decidedBy-verbatim note = plain-text-safe)
- [x] F. Docs (done, cited) + user E2E + review + LOCAL commit + memory

**Phase 19 review — COMPLETE (user-verified 2026-07-16):** The full
loop ran live in his workspace: gated refund from the widget (customer
e2e-19) → the approval card appeared on THREE surfaces at once (his
Slack channel, his Telegram DM as a linked approver, the dashboard);
tapped Approve in Slack → signed POST hit the fake Acme endpoint →
BOTH channel cards flipped to "✓ approved by slack:U0BGL10B3EX
(connect-test-1) — executed" with the result — the (connect-test-1)
suffix being Phase 15's identity links enriching the audit trail
automatically. Race test clean (dashboard first → Slack tap sees
"already approved"). E2E found TWO issues, both fixed+re-verified
same session: (1) the tapped Slack card stuck on "processing…" — the
tap handler enqueued the decision job BEFORE its optimistic edit, so
a fast worker's final edit got overwritten; fix = await the edit,
THEN enqueue (the bad interleaving is no longer expressible); (2) the
card lacked the CUSTOMER — approvers decided blind; Customer: line
added + the test now pins the exact card text. His onboarding
question ("how does Acme add approvers? the curl is a dev path")
became the [Add approver] button: QR + /start fallback in the
settings panel, reusing Phase 17's machinery — mint auto-upserts the
'approvals' subscriber. Also fixed from E's adversarial read: the
telegram tap branch ordered after agent resolution (would silently
dead-end on a disabled agent) — proven fixed with the agent disabled
via SQL. Suite 470→492. Design: one atomic decideToolCall converges
dashboard/Slack/Telegram; channel membership = authz boundary,
per-tap identity = audit; cards best-effort so posting can never
break the pause. novu has no answer to approve-from-your-own-Slack.
LOCAL COMMIT ONLY per no-push rule.

## Recently finished

### Agents — Phase 18: Agent Tools (registry + execution + approval + evals) — COMPLETE
(plan approved 2026-07-15 auto mode; full plan in
`~/.claude/plans/phase18-agent-tools.md`. Customers register tools on
managed agents (name/description/JSON-schema params/endpoint/approval
tier; per-tool sealed secret, SSRF-gated, reserved-name guard); worker
merges them into the brain's tool list and executes as signed HTTP
POSTs (bridge HMAC pattern, content-keyed idempotency, 16KB result
cap); approval='required' pauses via COMPLETE-THE-PAIR-NOW (breadcrumb
result "pending human approval", force-exit loop, deterministic note)
then UPDATE-IN-PLACE at decision + fresh resume turn — no suspended
jobs, no replay changes, fresh turn budget; dashboard Approvals page +
reserved `agent-approvals` trigger convention; sweep-piggybacked
24h expiry; eval harness (scripts/eval.ts, scripted+live modes).
Erases novu's tool-approval lead. ALL COMMITS LOCAL. All Opus.)

- [x] Manager foundation: schema (agent_tool_defs, agent_tool_calls) +
      agent-tools.repo.ts (atomic transitions, conflict-reuse insert)
      (applied + live-verified via psql; tsc green)
- [x] A. Backend routes: tools CRUD + approvals list/decision
      (Opus, audited; full 400/409 matrix curl-proven on :3033, no
      secret leak in lists, frozen tool-decision job shape verified in
      redis; decidedBy = JWT sub not email (JWT carries none) —
      id→email resolution = polish)
- [x] B. Worker/brain: tool merge, customer execute branch, approval
      pause, tool-decision job + resume, sweep expiry
      (Opus, audited + 1 revision: agent-approvals trigger now fires
      to reserved subscriber 'approvals' (lookup-first — blind fire
      would MINT a phantom subscriber via fanout upsert), payload
      +conversationId; decision row raw=null so replay can never
      forge a pair; force-exit via pausedToolName; note rides the
      normal finalize path; 24+8 live assertions green; 35/35
      agents.test intact)
- [x] C. Dashboard: Tools section on agent, Approvals page + nav
      (Opus, audited; build green, contracts type-checked, client
      validation matrix exercised; Tools gated to managed agents;
      live round-trips deferred to post-B api restart — covered by
      the E2E; approvals history renders `result` only-if-present —
      consider adding result to the GET view = polish)
- [x] D. Tests: CRUD matrix + execution/approval lifecycle integration
      + unit validation
      (Opus, audited; 38 new, suite 430→468 green 2x; SOLVED the
      flaky-suite mystery — 10,620 stale bull:* keys in test db 15,
      not parallel contention → manager added tests/global-setup.ts
      one-time flush; adversarial finds: dedupe key needs canonical
      JSON (revision dispatched to B), decidedBy uuid noted)
- [x] E. Eval harness: scripts/eval.ts + evals/ scenarios + npm run eval
      (Opus, audited; drives the REAL product path, reconstructs tool
      traces from raw.action + metadata deltas + reply buttons (DB
      read — no HTTP route exposes raw.action, documented); attempts +
      skip + exit codes; honest live run: 2 pass / 3 correct-fails
      (seed tenant runs the bridge demo, scenarios describe the
      managed one — flips on the user's tenant in E2E) / 1 skip;
      failure output prints the actual trace = debuggable)
- [x] F. Docs: AGENT-TOOLS.md + README
      (Opus, audited; every claim cited file:line incl. the REAL POST
      body shape ({identifier}/{id,subscriberId} — spec was looser),
      verify-signature snippet mirrors packages/agent exactly,
      retries-can-re-POST honesty, opt-in convention documented)
- [x] G. User E2E (steps 1-5 "everything was smooth" 2026-07-15) +
      review + single LOCAL commit + memory

**Phase 18 review — COMPLETE (user-verified 2026-07-15):** The full
loop ran live on his tenant: registered refund_customer (approval
required, endpoint = a local fake Acme API), rewrote the prompt's
refund branch to use it, asked on TELEGRAM → agent paused with the
deterministic note and NOTHING hit the endpoint → approved on the new
dashboard Approvals page → the signed POST landed (timestamp/signature/
idempotency-key all visible in the endpoint log) → agent followed up
on telegram with the refund result. Deny path clean (no POST, agent
relays the note). THE EVAL HARNESS PROVED ITSELF THE SAME DAY: his
first `npm run eval` failed refund-path with a perfect diagnosis — the
scenario encoded the OLD prompt behavior and the E2E's prompt edit
changed it; exactly the "prompt edits are deploys" catch the harness
exists for. Scenarios updated (refund-path now asserts the gated
pause; approval-pause un-skipped). Design wins that made it clean:
complete-the-pair-now/update-in-place (no suspended jobs, replay
stays honest, fresh turn budget); one table = execution log +
approval queue; content-keyed idempotency HARDENED to canonical JSON
mid-phase (D's adversarial catch: key-order-sensitive hashing could
double-POST on retry); reserved-recipient revision (blind trigger
would MINT a phantom subscriber via fanout upsert — B's lookup-first
catch); D also SOLVED the 3-phase-old flaky-suite mystery (10,620
stale bull:* keys in test db 15, not parallelism) → global-setup
flush. Suite 430→470 green. decidedBy=JWT sub (email = polish);
channel-tap approvals = Phase 19 (planned same day). NO PUSH yet.

## Recently finished

### Workflow flow-editor redesign (dashboard UX, user-requested 2026-07-14) — COMPLETE
Reworks /workflows/:key from a stack of expanded edit-cards into a FLOW
canvas (impeccable `shape` brief, user-approved): novu-style content
cards, but the flow makes CONDITIONAL LOGIC spatial — a step with
conditions/skip-gate gets a labeled BYPASS around it ("if not opened"),
so optional steps are visible at a glance (novu's flat line can't show
this). Single-click node → timing drawer (steps/:i); double-click → full
content page (steps/:i/editor); explicit Save with dirty guard. Hand-
rolled (no React Flow), zero new deps. Foundation (types + WorkflowProvider
draft context + layout + nested routes) manager-written + tsc green; canvas
(Slice A) + drawer/page (Slice B) delegated to Opus in parallel.
- [x] Foundation: types.ts, WorkflowProvider, layout shell, routing
- [x] A. Gated-bypass flow canvas (Opus; measured-SVG dashed bypass +
      "skip" tag + gate diamond, portal'd add-menu, cancelable
      single/double-click nav, selected-from-location, zero hex)
- [x] B. Timing drawer (subset) + full content page (all fields)
      (Opus; live updateStep, template/inline toggle, monochrome
      Toggle/ChannelPicker, skip-gate gated to i>0)
- [x] Dashboard build green (all 3 integrate); HMR clean on :5173
- [x] User-reviewed + iterated 2026-07-14/15: channel/type no longer
      editable post-create (per-type content only); drawer re-anchored
      to the viewport right + GSAP slide (gsap added, matchMedia for
      reduced-motion — the CSS reduced-motion setting had made it look
      instant); double-click window 180→280ms + native onDoubleClick
      (was opening the drawer/needing a fast triple-click); drawer
      Content section = just an "Edit content →" button (no misleading
      disabled preview); conditions "Add" is now a clear dashed empty-
      state affordance + secondary button (was a faint text link).
      GSAP is now the project's animation lib; keep motion subtle +
      only-when-it-improves-UX (his directive).

## Recently finished

### Onboarding — Phase 17: every first touch becomes one tap — COMPLETE
(plan approved 2026-07-13 ("go ahead, auto mode"); full plan in
`~/.claude/plans/phase17-onboarding.md`. Slack quick setup (config-token
→ apps.manifest.create, two-phase b/c URLs embed connectionId; OAuth
install leg mandatory — bot token only exists post-install) + rotation
auto-update via sealed refresh-token chain (persist-before-use!) that
novu lacks; welcome_message + suggested_prompts on agents (widget =
client-side render, zero rows; telegram bare-/start = dedupe
welcome-<convId>; slack = manifest suggested_prompts only); telegram
admin onboarding (BotFather parser + 5-min single-use phone-handoff
paste page served via tunnel); end-user QR in ConnectChannels (vendored
qrcodegen, react stays zero-dep). 12 scopes not novu's 17. ALL COMMITS
LOCAL. All Opus.)

- [x] Schema block (manager): agents welcome cols, setup_handoffs,
      pending status accommodation; migrate idempotent on live db
      (applied 2026-07-13, live-verified via psql \d)
- [x] A. Slack backend: quick-setup + install/callback + reconnect
      manifest-update branch + slack-manifest builder
      (Opus, audited + 1 revision: invalid_auth now gets the friendly
      12-hours message — live Slack returns invalid_auth not
      invalid_token, found by the slice's own curl; persist-refresh-
      BEFORE-manifest-update ordering verified by manager read;
      pending-status sweep clean: routes/delivery gate on active,
      GET /v1/connections lists pending for the poller)
- [x] B. Telegram+agents backend: bare-/start welcome, handoff
      endpoints+pages, botfather parser, agent config surface
      (Opus, audited; welcome enqueue mirrors the operator-push
      deliver job byte-for-byte; prompts ride existing buttons →
      action pipeline unchanged; handoff one-shot read via
      data-modifying CTE; manager moved registerHandoffRoutes from
      server.ts into buildApp so inject() tests see it; handoff purge
      is mint-time opportunistic — folding into the sweep = polish)
- [x] C. packages/react: QrCode, ConnectChannels QR, AgentChat welcome
      bubble + prompt chips, changeset
      (Opus, audited; build+dts green, qrcodegen zero-import w/ Nayuki
      MIT header, self-caught format-bits bug (M=00 not 1), RS-syndrome
      self-decoder round-trip on 3 inputs; QR intentionally light-
      palette both themes for scannability; INDEPENDENT decode proof =
      the user's actual phone in E2E)
- [x] D. Dashboard: slack Quick/Manual tabs + Listening poller,
      telegram handoff QR + autofill, agents welcome editor
      (Opus, audited + 1 joint revision with A: browsers return
      opaqueredirect for authed fetches so the install 302 was
      unreadable → install route content-negotiates (Accept json →
      200 {authorizeUrl}), dashboard opens it directly, manual-tab
      fallback deleted; live-verified with the real tunnel URL in
      redirect_uri. Standing polish gap: no refresh-token-only
      repair endpoint when manifestAutoUpdate='broken')
- [x] E. CLI: slack auto-update attempt in rewire + fallbacks, changeset
      (Opus, audited; 48 cli tests green incl. 6 new runtime-attempt
      cases; suppressed rows still feed the prevUrls snapshot so a
      later manual fallback ●-marks correctly; runRewire effect
      branches contract-read, not mocked — noted in-file)
- [x] F. Tests: slack-quick-setup / handoff / welcome integration +
      parser/manifest/state unit
      (Opus, audited; suite 368→417 green 2x, 43 new re-verified by
      manager; adversarial reads: rotate-before-appId-guard is
      doctrine-consistent (never strand a spent refresh token);
      empty-string welcome == clear (sentinel; acceptable semantics);
      pre-existing agents.test findLast needs lib ES2023 if tests
      ever enter tsc — polish note)
- [x] G. Docs + user E2E + review + single LOCAL commit + memory
      (docs written from shipped code + updated again post-E2E for the
      re-arm/fallback features; all 7 E2E tests user-verified
      2026-07-14)

**Phase 17 review — COMPLETE (user-verified 2026-07-14, all 7 tests):**
THE E2E'S RICHEST HAUL YET — six live defects found and fixed
same-session, each now regression-tested: (1) OAuth callback 500 on the
one-connection-per-workspace constraint → mapped 409 HTML w/ recovery
instructions; (2) reboot stranded the install (button lived only in
create-flow state) → persistent [Install to workspace] on pending rows;
(3) browsers return opaqueredirect for authed fetches → install route
content-negotiates Accept:json → {authorizeUrl}; (4) rotation before
install stranded the app's registered URLs → CLI attempts pending slack
too; (5) readiness-timeout left a zombie cloudflared that could go
healthy-but-unrewired → dud child killed on timeout → immediate
re-rotation through the storm breaker; (6) reused refresh token killed
the chain (single-use! access twin still worked, so creation succeeded
and rotation died later) → re-arm endpoint + dashboard field (validate
by rotating, heal URLs, flip flag) replacing dead-end re-creation.
Plus the docs agent's adversarial read caught a MANAGER SPEC BUG before
E2E: 12-scope minimalism had pruned users:read.email, which slack→email
auto-match needs — silent-degradation shape of the Phase 15 saga.
And the user's own ISP proved t.me is DNS-blocked in his market → the
widget now ships a copyable /start fallback under QR + connect.
Headline moments, all user-driven live: clean-slate Quick Setup on a
virgin workspace = one paste + three clicks + authorize → agent
replying in Slack; kill-test rotation printing '✔ slack app URLs
auto-updated (asyncify-dev)' with only Postmark left in the paste
table; /start welcome + prompt keyboard instant on telegram; widget
welcome bubble + chips (zero rows until the user acts); phone-handoff
paste page autofilling the desktop; phone camera decoding our
hand-rolled QR (the independent decoder proof). Suite 368→424 (49 new
in F + 7 in E); cli tests 49. Changesets riding: react minor, cli
minor. Polish backlog fed: expose quickSetup flag to hide re-arm on
manual rows; fold handoff purge into the sweep; empty-string welcome ==
clear sentinel; agents.test findLast needs lib ES2023 if tests enter
tsc. LOCAL COMMIT ONLY per no-push rule.

### Conversations / Agents — Phase 16: @asyncify-hq/cli (TRACK FINALE) — COMPLETE + RELEASED
(plan approved 2026-07-12; full plan in
`~/.claude/plans/tranquil-swimming-acorn.md`. PUBLIC_URL becomes a
runtime setting (redis config:public-url + env fallback, 5s
write-through cache, 4 call sites across api+worker) → rotations need
ZERO restarts; authed PUT/GET /v1/ops/public-url; `asyncify dev` =
cloudflared spawn + rolling-buffer URL parse + ordered rewire (PUT →
.env CRLF-safe write → reconnect loop w/ stale-cache guard → ●-marked
paste table) + sleep-aware watchdog (3 fails/20s → rotate, storm
breaker); `create-agent` scaffolder from the demo pattern. USER
ACTION at release: npm Trusted Publisher for the new package. ALL
COMMITS LOCAL. All Opus.)

- [x] A. Backend: public-url resolver + ops endpoint + 4-call-site
      async propagation + .env.example
      (Opus, audited; tsc green, zero env.publicUrl residuals outside
      fallback+ops GET source branch, live no-restart proof on an
      ephemeral :3055 instance, .env + redis restored to current
      tunnel; 15 suite timeouts = pre-existing parallel flakiness in
      agents/inactivity-sweep, both green in isolation)
- [x] B. packages/cli: dev command (preflight/tunnel/rewire/watchdog)
      + create-agent + README + changeset + CLEAN-ROOM lockfile
      (Opus, audited; build+help+scaffold verified; the poisoned lock
      had dropped @emnapi 11→6, clean room restored 11 — the ritual
      proved itself again)
- [x] C. Tests: cli unit (pure fns) + ops-url integration incl. the
      no-restart drill-elimination assertion + R1 redis hygiene
      (Opus, audited; 38 unit + 6 integration, suite 364 green 2x,
      44/44 re-verified by manager, dev redis key unleaked; note:
      watchdog post-pause rotate can re-pause while old rotation
      stamps are inside the 120s window — conservative, by design)
- [x] D. Docs: runbook leads with the CLI one-liner, manual flow
      demoted to fallback, runtime-URL note + curls, RELEASING
      trusted-publisher note (Opus, audited; scrub clean)
- [x] E. Manual E2E (user-run 2026-07-13) + review + single LOCAL
      commit + memory

**Phase 16 review — COMPLETE (user-verified 2026-07-13):** The E2E
earned its keep AGAIN: the first live `asyncify dev` run hit a DNS
race no manual drill could ever hit — the CLI called telegram
setWebhook seconds after cloudflared printed the URL, BEFORE the
tunnel's DNS record existed; Telegram's resolver negative-cached the
NXDOMAIN and kept rejecting the (by then resolvable) host for ~4
minutes. Manual pasting always took >1min, which is why 4+ hand
rotations never saw it. Fix (Opus, audited): waitForTunnelReady()
readiness gate — poll {url}/health through the tunnel until 2
consecutive 200s (60s budget) BEFORE any rewire, at both spawn sites
(startup + watchdog rotation), so third parties' first DNS query
lands after the record exists; plus reconnectOne retries
"Failed to resolve host" 3x/10s. Suite 364→368. Second run: clean
startup, telegram ✔ first try; user killed cloudflared → watchdog
rotated → readiness wait → full auto-rewire incl. telegram ✔ → real
telegram message flowed through the resurrected tunnel. Redis key +
.env + all three channels' listed URLs verified on the rotated base.
Slack + Postmark re-pasted from the ●-table. Scaffolder: create-agent
→ npm install (8s) → key into .env → npm run dev → registered,
bridge on :4200, echo reply in the dashboard inbox — zero to talking
agent in 4 commands. Staging incident: creating the bin shims needed
a real npm install which re-poisoned the lock (@emnapi 11→6);
clean-room regenerated back to B's exact 49+/21− shape (fourth
incident; order-of-operations lesson in the skill ledger). The
rotation drill this phase existed to kill is dead: cold start =
`npx asyncify dev` + paste ●-rows; rotation = nothing. RELEASED
2026-07-13: @asyncify-hq/cli@0.1.0 via user-merged PR #7 (first-publish
bootstrap: manual 0.0.0 → Trusted Publisher → OIDC 0.1.0 w/ provenance
— procedure in RELEASING.md).

### Conversations / Agents — Phase 15: connect-button components — COMPLETE
(user-verified 2026-07-12 as his own customer's end user: telegram
linked from the widget via deep link (typed /start on phone — desktop
t.me button needs the native app; QR handoff → backlog), row flipped
Linked on tab refocus; self-unlink two-step worked; slack app_redirect
landed in the bot DM and auto-match linked U0BGL10B3EX →
connect-test-1 (DB-verified); maya's card showed the three correct
ABSENCES (email row w/ no unlink, slack+tg Not linked = per-subscriber
isolation); both themes clean. THE E2E EARNED ITS KEEP: found TWO live
Slack API-dialect bugs — bots.info AND users.info silently ignore
JSON bodies (read methods need query params); users.info had been
silently disabling live email auto-match SINCE PHASE 13, masked by its
own fallback + JSON-accepting test stubs. Both wrappers fixed +
live-proven (real app id A0BGW0B0M9S fetched), stubs updated, lesson
in skill ledger. 320 tests. LOCAL COMMIT ONLY per no-push rule.)

### (original Phase 15 plan)
(plan approved 2026-07-12; full plan in
`~/.claude/plans/tranquil-swimming-acorn.md`. New token-only /v1/me
family (token IS identity — no subscriberId params, no oracle,
projection allowlist); telegram full deep-link connect; slack
universal app_redirect w/ bots.info appId capture + click-gated lazy
backfill; email display-only; self-unlink w/ ownership check the
legacy admin route lacks; ONE composite <ConnectChannels> + hook,
focus-refetch link detection. ALL COMMITS LOCAL — NO PUSH. All Opus.)

- [x] A. Backend: channels/slack botsInfo, repo updateConnectionConfig,
      slack connect appId capture, mintLinkTokenCore extraction,
      me.ts (channels/link-tokens/identities) + app.ts
      (Opus, audited; 306 green; oracle-proof unlink verified)
- [x] B. React: useConnectChannels + <ConnectChannels> + changeset +
      InboxPreview dogfood (Opus, audited; builds green, zero raw
      colors, focus-refetch + two-step unlink per spec)
- [x] C. Tests: me.test.ts (14 tests incl. strict projection,
      ownership, zero-slack-calls-after-persist cache proof, negative-
      ttl expired token) + slack stub bots.info; 320/320 2x + manager
      re-run (Opus, audited; zero suspected bugs)
- [x] D. Docs: end-user linking section (method table, token-only
      callout, 3 curls, slack app-id + email-not-unlinkable notes) +
      README SDK line (Opus, audited; scrub clean)
- [x] E. Manual E2E complete (found + fixed the two Slack read-method
      JSON bugs live) + review above + single LOCAL commit + memory.
      Backlog added: QR code in ConnectChannels for desktop→phone
      telegram handoff (t.me button dead without native app)

## Recently finished

### Conversations / Agents — Phase 14: Cards v2 + plan-card streaming — COMPLETE
(user-verified 2026-07-12 on ALL THREE surfaces in one storyline
(order → dropdown → Resend → email input → plan card → resolve):
widget, telegram (keyboard + ForceReply capture), slack #support
channel THREADED — and the smoke came back best-case: SLACK RENDERS
NATIVE IN-MESSAGE TEXT INPUTS (no prose fallback needed). DB evidence:
raw.card select/text_input on agent rows, raw.action.kind
select/input on answers, trigger breadcrumbs BEFORE final replies
(the replay-ordering invariant live), zero edited markers (D7).
Delegation: 5 Opus slices + 1 revision-gate return — slice B's OWN
honest flag exposed the replay-pairing shift (plan-card row inserted
early sorted before its breadcrumbs → tool pairs would attach to the
NEXT reply); fixed via finalizeAgentMessage created_at bump,
empirically verified. 306 tests. COMMITTED LOCALLY ONLY per user
no-push directive.)

### (original Phase 14 plan)
(plan approved 2026-07-12; full plan in
`~/.claude/plans/tranquil-swimming-acorn.md`. ONE evolving message
(plan card row IS the reply row, dedupe reply-<msgId>, marker-free
setAgentMessageContent, finalize rides .updated); cards on all
channels w/ graceful degrade (tg: keyboard/ForceReply; email prose);
two named tools present_choices + request_input (GLM rule); answers
ride the action pipeline w/ raw.action.value/kind; slack text-input =
live-smoke risk w/ prose fallback; NO new dedupe keys. ALL COMMITS
LOCAL — NO PUSH until user says. All subagents Opus.)

- [x] A. Cards v2 backend: shared/cards.ts, bridge+push schemas,
      managed tools + reminder + replay + userText, actions value,
      tg/slack ingestion branches, channel card params, email prose
      (Opus, audited; 269 green; deferred-to-B: cardPromptTelegramMessageId
      alternate match)
- [x] B. Plan-card engine: onToolCall/onToolResult hooks,
      PlanCardController (post/throttle ≥1s/finalize/error+DLQ
      finalizes), setAgentMessageContent + finalizeAgentMessage,
      typing gate (Opus, audited; 269 green 2x. Revision gate: agent's
      own honest flag exposed replay-pairing shift — plan-card row
      inserted early sorted before its breadcrumbs → tool pairs would
      attach to the NEXT reply; fixed via created_at bump on finalize,
      empirically verified both DB ordering + replay folding)
- [x] C. Widget+dashboard+SDK: react card UI + .updated extras + value
      POST, agent SDK card/value, dashboard chips, 2 minor changesets
      (Opus, audited; both package builds + dashboard tsc/vite green)
- [x] D. Tests: 37 new across 4 integration suites + sdk unit incl.
      the pinned replay-ordering invariant + invalid_blocks fallback;
      306/306 2x + manager re-run (Opus, audited; zero suspected bugs)
- [x] E. Docs: Cards and plan cards section (matrix, tg reply-to
      contract, slack degradation caveat, plan-card explainer) +
      README one-liner (Opus, audited; scrub clean)
- [x] F. Manual E2E all three channels, one storyline; slack native
      input CONFIRMED; retry drill skipped (RAM caution) — covered by
      the retry-recovery integration test; review + single LOCAL
      commit + memory

## Recently finished

### Conversations / Agents — Phase 13: Slack channel — COMPLETE
(user-verified 2026-07-12 on a real workspace (user's own asyncify-dev,
created for the test — company workspace correctly avoided): DM
answered by default agent; #billing mention → haiku agent IN THREAD
via routing rule while #support + DM stayed support-demo — the
switchboard demo, DB-verified (rule row C0BGAURDCQ7→haiku, thread
agents match); thread-following without mention; top-level unmentioned
silence; Block Kit buttons + ✓ retire; edit → edited marker, delete →
user tombstone, operator delete → vanished from Slack (deleted_by
rows evidence). FOUR channels live. Delegation: 5 Opus slices, ZERO
revision-gate returns — first clean phase. E2E friction: manifest
lacked app_home messages_tab settings → DMs disabled ("sending
messages turned off"); fixed in docs manifest (messages_tab_enabled +
read_only false = the checkbox). 269 tests.)

### (original Phase 13 plan)
(plan approved 2026-07-12; full plan in
`~/.claude/plans/tranquil-swimming-acorn.md`. Token-paste v1 w/
manifest; routing rules table → resolveAgentForInbound scope param;
DMs always / channels @mention-to-start + thread-follows; dedupe on
slack-<channel>-<ts> — mentions fire TWO envelopes, event_id dedupe
would double-ingest; bot-echo guard first; Block Kit buttons ride
existing pipeline; edit+DELETE parity (Slack notifies deletions);
typing = documented no-op. All subagents Opus.)

- [x] A. Backend core: schema (rules table + slack identity index),
      channels/slack.ts (client + v0 verify), app.ts form parser,
      routes/slack.ts (connect + events + subscriber resolution +
      edit/delete handlers), inbound-routing scope param, repo adds,
      webhookState branch (Opus, audited; 234 green, migrate 2x,
      acyclic imports, no secret leakage)
- [x] B. Interactivity + outbound: block_actions route, deliverReply/
      typing/operator-delete branches, /v1/connections/slack + routes
      CRUD, identities enum (Opus, audited; 234 green)
- [x] C. Dashboard: slack tab + dual-URL panel + RoutesModal
      (Opus, audited; dashboard tsc + build green, zero raw colors)
- [x] D. Tests: slack.test.ts (33 cases) + connections additions;
      269/269 2x no-flake; zero suspected bugs — first slice with no
      revision-gate returns (Opus, audited + manager re-run)
- [x] E. Docs: AGENT-CHANNELS.md slack section w/ manifest YAML +
      README (Opus, audited; scrub clean; rotation runbook +
      enumeration coherence included)
- [x] F. Manual E2E (own workspace, manifest app creation, DM +
      routing demo + parity — all behaved; DB-evidence-verified) +
      single verified commit + push + memory

## Recently finished

### Conversations / Agents — Phase 12: connection/endpoint model split — COMPLETE
(user-verified 2026-07-12, review: the switchboard is real — one bot
served three brains in one afternoon with zero webhook re-registration,
including through a live tunnel rotation AND an OOM crash recovery
mid-E2E. The forcing fact held up: connection-keyed threads are
REQUIRED, not nice-to-have (tg chat.id collides across bots — test
case 3 proves it). Delegation scorecard: 4 Opus slices + 2 revision-
gate returns, both first-retry fixes — (1) test slice caught
updateConnectionAgent never referencing $1/tenantId (42P18; every
re-point would have 500'd; ZERO pre-existing coverage on that path —
adversarial tests earn their cost), (2) user found the agent-delete
409 rendered nowhere in the UI. Live model finding documented in
AGENT-CHANNELS.md §9: weak models (GLM) imitate the inherited thread
persona over their system prompt after a re-point — fresh-thread
haiku proof isolated platform from model. Docs agent honestly flagged
its one inference (auth header) — it was wrong, manager fixed.
234 tests.)

### (original Phase 12 plan)
(plan approved 2026-07-12; full plan in
`~/.claude/plans/tranquil-swimming-acorn.md`. Semantics: connections
standalone, credentials + mutable agent_id = v1 routing; re-point
moves ALL conversations, history rides; channel threads re-key to
(connection_id, thread_key) — REQUIRED, tg chat.id collides across
bots; connect = identity-upsert, id stable, webhooks never re-register
on re-point; resolveAgentForInbound seam for Phase 13 Slack matchers;
top-level Connections page. All subagents = Opus per CLAUDE.md
directive.)

- [x] A. Model + rewire: schema DO-blocks (backfill, constraint drops,
      restrict FK, dupe demotion, 4 partial uniques), repo (identity
      upserts, openChannelConversation, getConnectionForConversation,
      mandatory ON CONFLICT fixes), inbound-routing.ts seam, outbound
      swap (Opus, audited; 224 green, migrate 2x idempotent on dev DB,
      backfill 145/188 — 43 nulls all orphaned-connection legacy rows)
- [x] B. New API: connections.ts (list/connect tg+email/repoint/
      reconnect/disconnect/link-tokens), agents delete-409, legacy
      shims delegate, identities 0/1/many (Opus, audited; 224 green,
      acyclic imports; kept legacy 422 on getMe failure — spec had an
      internal contradiction, byte-identical shims won)
- [x] C. Dashboard: Connections page (switchboard), nav/route, Agents
      modal shrink to read-only, Subscribers Link modal fix
      (Opus, audited; dashboard tsc + vite build green, zero raw colors)
- [x] D. Tests: connections.test.ts (10 cases; zero telegram retargets
      needed); suite 234/234 2x. FOUND REAL BUG: updateConnectionAgent
      second UPDATE never referenced $1 (tenantId) → 42P18 → every
      re-point would have 500'd; zero pre-existing coverage on that
      path. Revision gate: same Slice-A agent fixed it (one line,
      + tenant scoping), first retry.
- [x] E2E user-verified 2026-07-12 on the real bot: re-point moved
      conversations (history intact through TWO brain swaps + memory
      of order 55555 across them); same bot token served 3 brains with
      ZERO webhook re-registration incl. through a real tunnel
      rotation (Re-register now lives on Connections page — dogfooded
      during an OOM+tunnel-death recovery); delete guard 409 while
      routed (UI gap found live → fixed: visible dismissible error;
      ApiError doesn't expose response bodies — noted as polish) then
      delete succeeded once un-routed; fresh-thread haiku proof
      isolated platform (correct) from model behavior: GLM imitates
      inherited thread persona over its system prompt — documented as
      a product consideration in AGENT-CHANNELS.md
- [x] E. Docs: AGENT-CHANNELS.md rewritten around standalone
      connections (14 sections, deprecated flows isolated, persona
      finding in §9; auth-header inference corrected to x-api-key);
      single verified commit + push + memory

## Recently finished

### Conversations / Agents — Phase 11: send-agent-reply API + onResolve — COMPLETE
(user-verified 2026-07-12 on real Telegram: proactive push landed in
the TG chat unprompted, same-messageId repeat → duplicate:true with no
second send, operator resolve + bridge resolve both printed RESOLVED
lines in agent-demo (job records show first-attempt delivery in
~150ms — bridge was up throughout; an earlier "delivered through
bridge downtime" claim here was a manager inference error from paste
ordering, corrected against Redis job timestamps + execution logs).
Downtime recovery then LIVE-PROVEN deliberately (user-driven drill,
same day): resolve fired with the bridge stopped → Redis job atm=4,
failedReason 'fetch failed', delivered 15.1s after enqueue on the 4th
backoff attempt, 40ms after bridge restart — exactly once.
224 tests. Delegation: 2 Opus + 1 Sonnet
slices, zero revision-gate retries. E2E friction noted for backlog:
Fastify 415 content-type errors surface as 500 'internal error' —
map FST_ERR_CTP_* to clean 4xx; PS5.1 bodyless POST needs -Body '{}'.)

### (original Phase 11 plan)
(plan approved 2026-07-12; full plan in
`~/.claude/plans/tranquil-swimming-acorn.md`. Semantics: push never
reopens unless reopen:true; onResolve = bridge-only signed
notification, response ignored, dropped if reopened before dispatch.
Same conversation queue with kind discriminator; resolved jobs
priority 10 so live turns always win. Delegated per CLAUDE.md.)

- [x] A. Backend: repo (flip-boolean resolve, reopenConversation,
      lastUserMessage, sweep CTE columns) + processor (kind dispatch,
      processDeliver, processResolved, postSignedToBridge extraction,
      nullable inboundRow) + enqueue sites + push route
      (Opus, audited; tsc green under manager re-run)
- [x] B. SDK: AgentEvent union + ResolveContext + handleEvent resolved
      case + unknown-type fix + createHandler guard; agent changeset;
      agent-demo onResolve log (Opus, audited; tsup build green)
- [x] C. Tests: SDK unit cases; agents.test.ts push/resolved cases;
      sweep enqueue cases; full suite green (Sonnet, audited +
      manager re-run: 224 tests, 2x no-flake)
- [x] D. Manual E2E: real Telegram push (dedupe proof), RESOLVED
      operator + bridge in agent-demo console (both first-attempt,
      sub-second — verified via Redis job timestamps)
- [x] E. Review section; single verified commit + changeset; push;
      memory update

## Recently finished

### Conversations / Agents — Phase 10: edit/delete + typing — COMPLETE
(user-verified 2026-07-12 on widget AND real Telegram: widget inline
edit/(edited)/tombstones/typing dots all clean; Telegram typing shown,
in-app edit of a TG message landed with the edited marker, operator
delete vanished the bot reply from the real TG chat within seconds.
Review: first phase run under the CLAUDE.md delegation rules — 2 Opus
backend slices + 1 Opus UI slice + 1 Sonnet test slice, all audited
against the plan; one E2E-found bug (widget kept its optimistic client
id after the 202, so PATCH/DELETE 404'd on fresh messages) went back
to the SAME agent per the revision gate and passed on first retry —
fix: send()/sendAction() adopt the server's durable messageId from the
202 body. The 22:07 telegram session became an accidental semantics
demo: record-only edit means pre-edit agent replies keep the stale
order number (the model then reconciles both, groundedly) — deleting
the agent's FIRST reply, not just the later one, is how an operator
purges a stale fact from history. 207 tests, 3x no-flake.)

### (original Phase 10 plan)
(plan approved 2026-07-12; full plan in
`~/.claude/plans/tranquil-swimming-acorn.md`. Semantics: edit =
record-only; delete = soft tombstone, user own-messages + operator
any-row; typing = platform-emitted, client 15s TTL, no stop event.
Delegated implementation per CLAUDE.md handoff rules; manager reviews
each slice.)

- [x] 1. Migration: edited_at/deleted_at/deleted_by on
      conversation_messages + ConversationMessage type; migrate + verify
      (Opus slice 1, audited; 191 tests green)
- [x] 2. Repo: editConversationMessage + softDeleteConversationMessage;
      deleted_at filter in conversationHistoryBefore (SQL)
- [x] 3. Brain safety: buildHistory deleted-row rule (agent row → clear
      pending breadcrumbs); processConversation deleted-inbound guard
- [x] 4. Extract publishConversationEvent → src/core/conversation-events.ts
      (pure move, tests stay green)
- [x] 5. Telegram client: sendChatAction + deleteMessage +
      edited_message in allowed_updates + shared TelegramMessage type
      (Opus slice 2, audited; 191 tests still green)
- [x] 6. Routes: new conversation-messages.ts (PATCH + user DELETE +
      operator DELETE), authenticateSender export, GET mappings grow
      editedAt/deletedAt/deletedBy
- [x] 7. Telegram outbound-delete propagation (48h guard, best-effort)
- [x] 8. Typing: typingEmitter in processor + onModelCall hook in
      runManagedTurn; turn-start + per-model-call emission
- [x] 9. Inbound edited_message handler in routes/telegram.ts
- [x] 10. Tests: conversation-messages.test.ts (new) + telegram/
      managed-brain additions; npm test + tsc green (Sonnet slice,
      audited + re-run by manager: 207 tests, 3x no-flake)
- [x] 11. Widget: ChatMessage fields, WS branches (typing/updated/
      deleted), edit/delete UI, typing bubble; react changeset SAME commit
      (Opus UI slice, audited; react tsup + dashboard tsc/vite green)
- [x] 12. Dashboard: tombstone + edited marker + operator two-step delete
- [x] 13. Manual E2E: InboxPreview + real Telegram (Re-register first);
      TG no-deletion-updates limitation documented in the plan + here:
      user-side TG deletes are never reported to bots, transcript keeps them
- [x] 14. Review section above; single verified commit; push; memory update

## Recently finished

### Phase 9: SSRF hardening — COMPLETE
(committed+pushed 77a4400, 2026-07-12; 191 tests green. Review: the
guard is two layers sharing one predicate — write-time asserts with
field-named 400s, connect-time IP pinning via a shared undici
dispatcher hook, redirects refused on bridge posts. E2E found a real
adjacent bug: the bridge branch burned 39s of retries on a
PermanentError the managed branch handled gracefully — now both
fast-fail into a transcript note within the same second. The
allowlist keeps dev on the production code path (config, not
branches). SMTP got write-time checks only — nodemailer owns its
sockets; revisit if subscriber-supplied SMTP ever ships. Ops gotcha
leddered: stopping the npm-wrapper background task orphans the tsx
child on Windows — kill by port before restarting a worker.)

### (original Phase 9 plan)

Goal: a tenant can never make our servers talk to something private.
Three surfaces accept arbitrary URLs today, validated only by zod
`.url()`: `agents.bridge_url` (POSTed every bridge turn,
conversation.processor.ts:229), `agents.llm_base_url` (Anthropic SDK
baseURL, managed-brain.ts:85), and the SMTP `host` credential
(integrations). Any of them can point at 127.0.0.1:6379 (our Redis),
Postgres, or 169.254.169.254 (cloud metadata) — the classic SSRF holes.

**Design — two layers, one predicate:**

1. **Write-time validation** (UX layer, fast feedback): new
   `src/core/safe-url.ts` exports `assertSafeOutboundUrl(url)` —
   http/https only, no userinfo (`user:pass@`), hostname not
   localhost/*.local/*.internal, not a literal private/reserved IP
   (v4: 0/8, 10/8, 100.64/10, 127/8, 169.254/16, 172.16/12,
   192.168/16, 198.18/15, 224/4, 240/4; v6: ::1, ::, fc00::/7,
   fe80::/10, ::ffff: v4-mapped), plus a DNS resolve whose answers
   must all be public. Applied in agents create/patch (bridgeUrl +
   llm.baseUrl → 400 with a clear message) and integrations
   create/update for the SMTP host.
2. **Connect-time IP pinning** (the actual security boundary, immune
   to DNS rebinding and exotic IP encodings): a shared undici Agent
   whose `connect.lookup` filters the resolved IPs through the same
   predicate at socket time — the check rides the lookup the socket
   already does, zero extra DNS queries. Bridge fetch gets
   `dispatcher: safeDispatcher()` + `redirect: 'manual'` (a bridge
   must never redirect; kills the redirect-revalidation class
   entirely). Managed brain passes a custom `fetch` to the Anthropic
   SDK wired to the same dispatcher. Blocked at dispatch →
   PermanentError → existing no-retry breadcrumb path.

**Local dev without a code fork (no-shortcuts rule):**
`OUTBOUND_URL_ALLOW` env — comma list of exact hostnames exempt from
the private check (`localhost,127.0.0.1,host.docker.internal` in dev
.env; EMPTY in prod). Same code path always; config, not branches —
agent:demo (localhost:4100) and the z.ai tunnel keep working.

**Known gap accepted this phase:** SMTP gets write-time checks only
(nodemailer owns its sockets; dispatch-time pinning there is a
follow-up if we ever allow subscriber-supplied SMTP).

**Scale math:** validation runs per agent-save (rare) and per
conversation turn (human-paced; even 1M chatting DAU ≈ low hundreds
of turns/sec). The connect-time filter adds a few range compares per
socket connect, amortized further by keep-alive. Zero per-user-per-
tick work, zero extra DNS round trips.

**Slices:**
- [x] 1. `src/core/safe-url.ts` (predicate + assert + safeDispatcher
      singleton + OUTBOUND_URL_ALLOW) with unit tests: private v4/v6,
      v4-mapped v6, metadata IP, localhost names, userinfo, bad
      schemes, allowlist exemption (35 unit tests)
- [x] 2. Write-time: agents create/patch validate bridgeUrl +
      llm.baseUrl; integrations validate SMTP host; integration tests
      (private bridgeUrl → 400; allowlisted localhost → 201)
- [x] 3. Dispatch-time: bridge fetch dispatcher + redirect manual;
      managed-brain custom fetch; blocked URL → PermanentError →
      transcript note, no retries (E2E-found fix: the bridge branch
      didn't catch PermanentError — 39s of retry burn → same-second
      fast-fail after giving it the managed branch's doctrine)
- [x] 4. .env/.env.example + tests/setup.ts allowlist; drove E2E:
      169.254.169.254 + 10.0.0.1 + nip.io-to-127.0.0.1 all 400;
      SQL-planted private URL blocked at dispatch with transcript
      note; agent:demo round-trip green via allowlist (191 tests)
- [x] 5. Commit (no packages/* change → no changeset)

## Recently finished

### Phase 8: Release automation — COMPLETE
(user-verified 2026-07-10 with a REAL release: changeset → bot's
Version Packages PR → user merge → @asyncify-hq/agent@0.2.1 on npm
in 33s with the SLSA provenance attestation, zero tokens. Commits
e78afb8 / e1c8d19 / 9a8f27a. Also cleared the parked npm-workspaces
backlog item. Review: the 3-month-token problem is abolished, not
worked around — npm package settings now DISALLOW token publishing
entirely; the only publish paths are 2FA humans or this repo's
release.yml via OIDC. Releasing = merge a PR; changelogs write
themselves. Gotcha earned twice and leddered (skill §11): this
Windows machine's real npm install writes non-portable lockfiles
(drops @emnapi cross-platform entries) — always clean-room the lock
after the last install; CI caught it both times, same-day proof of
the CI investment.)

### (original Phase 8 plan)

Goal: publishing stops being a manual chore with a pasted, expiring
token. A release becomes: merge the bot's "Version Packages" PR →
CI publishes the changed packages to npm via OIDC trusted publishing
— NO npm token anywhere (user constraint: tokens cap at 3 months).

Design decisions:
- **Step 0 — npm workspaces** (unblocks Changesets, clears the parked
  backlog item): root package.json gains `"workspaces":
  ["packages/*"]` (sdk-node, agent, react; the dashboard app stays
  outside — it's not published). The four lockfiles collapse into
  the root one; package devDeps (tsup/typescript/react types) hoist.
  Risk watched: the lockfile regenerates — validated the same way
  the CI lockfile fix was (npm ci --dry-run + the CI run itself).
- **Changesets, independent versioning** (packages evolve at their
  own pace — agent/react/node have never moved in lockstep):
  `npx changeset` per user-visible package change → tiny .md file
  rides the commit → changesets/action on pushes to main maintains
  ONE aggregating "Version Packages" PR (bumps + CHANGELOGs) →
  merging it publishes exactly the changed packages.
- **Token-less publish (OIDC trusted publishing)**: each package on
  npmjs.com gets a Trusted Publisher binding (this GitHub repo +
  release.yml). The workflow requests `id-token: write`; npm ≥11.5
  (node 24, already CI's runtime) exchanges the OIDC token at
  publish time — no long-lived secret to expire or leak, and npm
  shows a provenance badge on every release. Fallback documented:
  NPM_TOKEN secret if OIDC misbehaves, removable after.
- **CI updates**: root `npm ci` now installs workspaces (drop the
  three per-package installs); builds become `npm run build -w`;
  cache path = root lockfile only.
- **User-side one-time setup (flagging early)**: (a) on npmjs.com,
  add the Trusted Publisher (repo shubam14dec/Scalable-Notification-
  System, workflow release.yml) on each of the 3 packages; (b) repo
  Settings → Actions → General → allow Actions to create PRs.
- **Parameter space**: independent versions (not fixed/linked);
  access public (already in publishConfig); baseBranch main;
  changelog = the default changeset-generated per-package
  CHANGELOG.md.
- **Scale note (10-20M rule)**: n/a — repo tooling; the only "scale"
  is developer count, which this improves (any contributor can ship
  a release via PR review instead of holding a token).
- **E2E through the real surface (house rule)**: the acceptance test
  is a REAL release: one changeset (a patch-level README tweak to
  @asyncify-hq/agent) → bot opens Version Packages PR → user merges
  → CI publishes 0.2.1 → npm shows the new version WITH the
  provenance badge. No dry-runs pretending to be releases.

**Slice 1 — workspaces (build → verify → commit)**
- [x] Root workspaces field; per-package lockfiles deleted; clean-room
      lockfile regeneration; npm ci --dry-run green. GOTCHA earned
      twice and now in skill §11: any real npm install on this
      Windows machine drops the cross-platform @emnapi entries from
      the lock (node_modules bias) — CI caught it both times; always
      clean-room the lock AFTER the last install, before committing
- [x] CI: single root install, -w builds, root cache path
- [x] Full suite (152) + all three -w builds green locally
**Slice 2 — changesets + release workflow (build → verify → commit)**
- [x] @changesets/cli + init; config: independent versions, access
      public, baseBranch main
- [x] .github/workflows/release.yml: changesets/action maintains the
      Version Packages PR + publishes on merge; permissions contents/
      pull-requests/id-token write; NO npm token anywhere
- [x] RELEASING.md: the habit (npx changeset per package change),
      release = merge the bot PR, OIDC troubleshooting + fallback
**Slice 3 — user setup + the real release (user-driven)**
- [x] User: npmjs.com Trusted Publisher on all 3 packages (allow npm
      publish; "require 2FA and disallow tokens" — token publishing
      is now IMPOSSIBLE, not just avoided) + repo setting allowing
      Actions to create PRs
- [x] E2E user-verified 2026-07-10: seed changeset pushed → bot
      opened Version Packages PR within seconds → user merged →
      @asyncify-hq/agent@0.2.1 live on npm 33s later WITH the SLSA
      provenance attestation — no token anywhere in the chain

**Out of scope**: publishing the dashboard (not a package), GitHub
Releases/tags automation (changesets can add later), migrating old
release notes.

## Recently finished

### Conversations / Agents — Phase 7: Subscriber linking — COMPLETE
(user-verified 2026-07-10 on a real phone: Subscribers-page Link →
t.me deep link → tap → "Linked! …(maya)" in the bot chat → order
message → button tap → trigger_workflow → confirmation email in the
REAL Gmail, from a telegram conversation — the Phase 5 phantom-email
failure replayed as a passing scenario, zero faked state. Email
auto-match ALSO live-verified same day: a mail from the user's real
Gmail landed under maya (not an address-keyed stranger) with the
email identity visible in the Link modal — all three channels now
resolve to one person, each verified live (widget = born linked via
subscriber tokens; telegram = deep link; email = auto-match).
Commits 36000f1 / 3232563. Review: the mapping-table design (no row merges)
kept every hot path at one unique-index lookup and made unlink
trivial; the /start token consume-UPDATE doubles as the idempotency
lock; history repointing means the person keeps their transcript
across the identity change. One semantics decision surfaced by
testing: an existing chat thread keeps its owner after unlink (one
conversation per chat) — only fresh identity resolution falls back.
Learned: bridge signal txns index from 1, 0 is the turn note.)

### (original Phase 7 plan)

Goal: one human = ONE subscriber across widget/telegram/email. Today a
person is up to three strangers (`maya`, `tg-8123991`, sender-email row)
— which broke the Phase-5 telegram trigger (no email on file → phantom
"email incoming") and gives the agent amnesia across channels.

Design decisions:
- **No destructive row merges.** New table `channel_identities`
  (tenant_id, channel, external_key → subscriber_id, unique on the
  first three). Inbound resolution order becomes: mapping hit → real
  subscriber; miss → today's auto-created `tg-<id>`/email row
  (unchanged fallback). One extra O(1) indexed lookup per inbound
  message — nothing else in the hot path changes.
- **Telegram link = deep link** (the production pattern):
  `POST /v1/agents/:identifier/subscribers/:subscriberId/link-token`
  (api-key auth, server-side only) → single-use token (random,
  stored HASHED, 24h TTL) + ready `https://t.me/<bot>?start=<token>`
  URL. User taps → bot chat opens → Telegram sends `/start <token>`
  → webhook intercepts (only when the payload matches the token
  shape; bare /start still goes to the brain) → validates hash,
  tenant, expiry, unused → writes the mapping → repoints that chat's
  EXISTING conversations + threads to the real subscriber (history
  rides along — conversations keep their rows) → marks token used →
  bot confirms in-chat ("Linked — you're now checking in as <id>").
- **Email link = auto-match** (industry standard): inbound sender
  address exactly matching an existing subscriber's email → mapping
  written automatically on first inbound. CAVEAT documented: From
  headers are spoofable; consequences bounded (replies go to the
  real mailbox owner, not the spoofer). Signed-link email flow =
  later hardening, out of v1.
- **What it fixes downstream, for free**: trigger_workflow from a
  telegram thread reaches the REAL subscriber (the phantom-email
  fix); managed brain sees real email/phone; dashboard shows the
  real subscriberId; preferences/suppression unify.
- **Unlink**: DELETE the mapping (api + dashboard action). Future
  messages fall back to a fresh channel-local identity; past
  conversations stay where they were repointed (history is the
  subscriber's).
- **Parameter space (house rule)**: token TTL 24h fixed v1 (rides
  inside emails/QRs, so minutes is too short); single-use; a
  subscriber may link MULTIPLE telegram accounts (mapping is per
  external_key); auto email match always-on v1.
- **Scale (10-20M rule)**: mapping lookup is one unique-index hit
  per inbound message — O(1), no fan-out. Linking repoints only that
  chat's conversations (a few rows). Token table self-cleans: delete
  where expired/used older than 7d, folded into the EXISTING
  inactivity-sweep tick (one indexed statement — no new timer).
- **E2E through the real surface (house rule)**: dashboard →
  Conversations/Agents surface generates the deep link; user taps it
  on the phone; bot confirms; next telegram turn triggers a workflow
  whose EMAIL ARRIVES in the real inbox — the exact scenario that
  failed in Phase 5, now passing, zero faked state.

**Slice 1 — backend (build → verify vs tests → commit)**
- [x] Schema: channel_identities + subscriber_link_tokens (+ expiry
      index + subscribers (tenant, email) partial index) — migrated
- [x] Token mint route (sha256 at rest, 24h TTL, single-use, 48-hex
      inside telegram's 64-char start-payload limit) returning the
      t.me deep link (404 without an active telegram connection)
- [x] Telegram webhook: /start <token> interception (shape-matched;
      bare /start still → brain) → atomic consume (the UPDATE is the
      lock) → mapping + tenant-wide thread repoint + in-chat
      confirmation; invalid/expired → polite notice, silent when
      already linked (redelivery-safe)
- [x] Inbound resolution: resolveTelegramSubscriber (messages AND
      button callbacks) + resolveEmailSubscriber (mapping → auto-
      match → channel-local fallback); auto-match writes the mapping
      + repoints on first hit
- [x] Sweep tick: purgeDeadLinkTokens piggybacked (one indexed
      delete, 7-day grace, no new timer)
- [x] Unlink route + GET identities listing
- [x] Tests (12 new, 152 total green): mint + 404s, pre-link
      baseline (trigger recipients carry NO email — the phantom-
      email BEFORE), handshake (mapping + repointed history +
      confirmation), single-use (second user gets invalid notice,
      no mapping), expired rejected, bare /start → brain, post-link
      turns land under the real subscriber, THE REGRESSION (linked
      telegram trigger's recipients carry ana + her real email),
      unlink drops mapping + relink works (existing thread keeps
      its owner — one conversation per chat, by design), email
      auto-match links + strangers stay channel-local.
      Learned: bridge signal txn indexes start at 1 (0 = turn note)
**Slice 2 — dashboard + real E2E (user-driven)**
- [x] Surface: Subscribers page grew a per-row Link action → modal
      shows linked identities (+ unlink) and generates the one-tap
      telegram deep link (agent picker when several bots exist,
      CopyField, 24h note). Dashboard tsc + vite build clean
- [x] E2E from the phone (user-verified 2026-07-10): minted maya's
      link on the Subscribers page → tapped on the phone → bot
      confirmed "Linked!" → order message → button tap → trigger →
      the confirmation email LANDED IN THE REAL GMAIL from a
      telegram chat — the Phase 5 phantom email, exorcised.
      "all the things were same in the result step by step"

**Out of scope v1**: signed-link email verification, WhatsApp/Slack
identities, cross-tenant identity, merging two REAL subscribers,
widget-side linking (widget users are already real subscribers).

## Recently finished

### Conversations / Agents — Phase 6: Auto-resolve on inactivity — COMPLETE
(user-verified 2026-07-09 TWICE: first the backdated-clock drive
(1h knob, widget flipped live via WS, breadcrumb + summary, reopen
worked), then — after the minutes upgrade — a pure E2E with zero
clock-faking: 1-minute knob, one real minute of silence, the widget
auto-resolved on its own. Commits 78228a1 / c6f9231 / fb530b2 /
c05774b. Review: first feature planned under the 10-20M rule — the
original 200-rows-per-tick sweep would have drained 5M stale rows in
~87 days; shipped as set-based batches (single CTE statement: SKIP
LOCKED lock → resolve → crumb) in a 55s-budgeted drain loop, O(matches)
partial index. Deviation from plan: settleCompletedEvents interval
pattern instead of a BullMQ repeatable (precedent, simpler, same
shape). Post-verification user request folded in: minutes granularity
(DO-block column migration ×60, verified live), twin hours+min form
inputs, 60s tick, humanized summaries.)

### (original Phase 6 plan)

Goal: the platform backstop for threads that trail off. An active
conversation with no messages for N hours gets resolved by a sweep —
no model judgment involved, works identically for both runtimes and
all channels. (Born from the Phase 5 "Thank you" case.)

Design decisions:
- **Per-agent knob**: `agents.auto_resolve_hours` int NULLABLE —
  NULL = feature off (default; resolution stays brain/manual only).
  Bounds 1–720 (30 days). Accepted on create/PATCH as
  `autoResolveHours`, exposed in agentView, numeric field in the
  agent form (both runtimes — it's channel- and brain-agnostic).
- **Mechanism: one global repeatable sweep** (first repeatable job in
  the codebase): BullMQ every-5-min job registered idempotently at
  worker startup on a new `conversation-sweep` queue.
- **SCALE MATH (the 10–20M rule — house standard from here on)**:
  worst case 5M conversations stale at once. A row-at-a-time sweep
  with a 200/tick cap drains in ~87 days — rejected. Instead the
  tick is a TIME-BUDGETED DRAIN LOOP (55s/tick) of SET-BASED batches:
  each iteration = one `UPDATE conversations … FROM (select stale
  batch of 5000 … FOR UPDATE SKIP LOCKED) RETURNING …` + one bulk
  breadcrumb `INSERT … ON CONFLICT DO NOTHING` + pipelined WS
  publishes for the returned inapp rows. 5M stale ≈ 1000 batches ≈
  drains within 1–2 ticks; Postgres does the work, the worker only
  orchestrates. Finding stale rows is a partial index
  `(last_message_at) where status='active'` — cost scales with
  MATCHES, not the 10–20M-row table. SKIP LOCKED + the status guard
  make overlapping/racing ticks harmless.
- **Resolution semantics**: same outcome as every other resolve —
  status flip + summary "auto-resolved after Nh of inactivity" +
  system breadcrumb (dedupe key `autoresolve-<convId>-<last_message_
  at epoch>`: re-runs can't double-write) + `conversation.resolved`
  WS event for inapp rows so an open widget flips live.
  Reopen-on-new-message is untouched (existing behavior).
- **Sweep is dumb on purpose**: no per-conversation scheduling, no
  brain calls, no channel sends — a timer and a status flip. Nothing
  in the design is per-user; everything is per-batch.
- Why sweep > per-conversation delayed jobs: 10–20M users churning
  messages would mean re-scheduling a delayed job on EVERY message
  (per-user-per-event work — the red flag); one indexed query every
  5 min is O(stale), and minute-precision is worthless for an
  hours-scale timeout.

**Slice 1 — backend (build → verify vs tests → commit)**
- [x] Schema: agents.auto_resolve_hours + partial index on active
      conversations (migrated)
- [x] Routes: create/PATCH validation (int 1–720, PATCH accepts null
      to disable via a 0 wire-sentinel in the repo), agentView
- [x] Sweep: DEVIATION from plan — no BullMQ repeatable; followed
      the existing settleCompletedEvents house pattern instead
      (plain interval in the worker + idempotent set-based SQL).
      Simpler, has precedent, same scale shape. One statement per
      batch (CTE: lock SKIP LOCKED → resolve+summary+count → crumb
      insert ON CONFLICT DO NOTHING → return rows w/ subscriber),
      55s-budgeted drain loop, batch 5000, pipelined WS resolves
      for inapp rows, exec-log per conversation. Breadcrumb bumps
      message_count but NOT last_message_at (keeps the idle
      timestamp honest).
- [x] Tests (7 new, 139 total green): stale resolves w/ summary +
      breadcrumb; fresh survives; NULL-knob agent never swept;
      re-run no-op; manually-resolved not re-touched; reopen works;
      knob create/PATCH/null + bounds (0, 721, -5, 1.5 → 400)
**Slice 2 — dashboard + verification (user-driven)**
- [x] Agent form: "Auto-resolve after (hours)" numeric field, both
      runtimes, blank = never (clearing it on edit sends null =
      backstop off); dashboard tsc + vite build clean
- [x] Live drive in dev (user-verified 2026-07-09): 1h knob on
      support-2, conversation backdated 2h, sweep resolved it —
      widget flipped live via WS, breadcrumb + summary in dashboard,
      new message reopened. "all the things worked"
- [x] Post-verification upgrade (user request): unit changed
      hours → MINUTES (1–43200; DO-block migration backfills ×60 and
      drops the old column — verified live: support-2's 1h became
      60m). Dashboard = hours + minutes twin inputs; sweep tick
      tightened 5min → 60s so a 1-minute knob behaves like one
      (idle tick = one partial-index query, cheaper than the 30s
      settle sweep). Summary humanizes: 1 minute / 45 minutes /
      24 hours / 1h 30m (formatting test added; 140 green)

**Out of scope**: per-conversation overrides, warning message before
closing ("are you still there?"), tenant-level default, sweeping
resolved→archived states.

## Recently finished

### Conversations / Agents — Phase 5: present_buttons tool — COMPLETE
(user-verified 2026-07-09 on widget AND telegram with real GLM-4.7:
the model authored buttons via the tool on both surfaces — inline
keyboard + retire-on-tap on the phone — clicks routed back, trigger
fired with content-keyed txn, set_metadata + resolve_conversation all
exercised, zero fabrication. Commit 2fcfee9. Battle-test findings:
(a) GLM imitated the demo brain's exact reply phrasing from bridge-era
history in the same telegram thread — harmless mimicry over a real
trigger; (b) it promised "a confirmation email is incoming" to a tg-
subscriber with no email — the subscriber-linking gap surfacing in
model behavior; (c) a bare "Thank you" after two off-topic meta-
questions did NOT resolve (defensible judgment; explicit "thanks,
everything is sorted now!" resolved instantly) — the ambiguous-thanks
case is a PROMPT policy ("if the user thanks you and nothing is
pending, resolve") or model-tier question, not a platform rule;
auto-resolve-on-inactivity added to backlog as the platform backstop.)

### (original Phase 5 plan)

Goal: managed LLM agents (GLM/Claude) can offer buttons like bridge
agents do. Phase 4 shipped the entire pipeline (raw.buttons on the
reply row → widget/telegram/email rendering, clicks → action events →
"[user clicked: …]"); this adds only the LLM's send-side entry point.

Design decisions:
- **Fourth tool, presentation-only**: `present_buttons {buttons:
  [{id, label}]}` — same limits as the bridge schema (max 6, id ≤64,
  label ≤48). No side effects → no content-keyed txn needed (unlike
  trigger_workflow); invalid input (too many, too long, empty,
  duplicate ids) → `is_error` tool result so the model can correct.
- **Buttons attach to the turn's final reply text**: the loop captures
  the last present_buttons call (last call wins), BrainTurnResult
  carries `buttons`, processor writes them into the reply row's
  raw.buttons — the exact slot bridge buttons use, so every channel
  and surface works with ZERO downstream changes. Model calls the
  tool but produces no text → buttons dropped (nothing to attach to).
- **Prescriptive tool description** (skill): call it when offering
  the user a small set of choices; buttons render attached to your
  reply; do NOT also enumerate the options in the text.
- **Honest history replay (skill §13)**: assistant rows carrying
  raw.buttons replay as real tool_use(present_buttons) + tool_result
  blocks, same reconstruction as trigger/metadata/resolve — the model
  sees the correct pattern, not bare text that happened to have
  buttons. Click rows already render as "[user clicked: …]".
- **Retry-safety**: reply-row dedupe (`reply-<messageId>`) already
  makes a re-run turn idempotent; a re-run may present different
  buttons but the first stored row wins — same doctrine as reply text.
- No UI/schema/SDK changes anywhere — Phase 4 surfaces render
  whatever raw.buttons contains.

**Slice 1 — backend (build → verify vs scripted stub → commit)**
- [x] managed-brain.ts: tool definition + loop capture (last call
      wins) + validation with is_error + BrainTurnResult.buttons +
      history reconstruction for raw.buttons assistant rows (works
      for bridge-authored button rows too — a runtime flip keeps
      honest replay)
- [x] conversation.processor: managed branch threads brain buttons
      into the reply row raw (bridge path untouched)
- [x] Tests (6 new, 132 total green): buttons land on the reply row
      + transcript; no breadcrumb (presentation ≠ effect); 7 buttons
      / duplicate ids → is_error → model corrects, invalid set never
      sticks; no-reply-text drops buttons; two calls → last wins;
      replay shows a real present_buttons tool_use block; re-run →
      no duplicate row; reminder + both tool menus name the tool
**Slice 2 — real GLM E2E (user-driven, the battle-test)**
- [x] User tightens support-2's system prompt (e.g. "when a user
      reports an order issue, use present_buttons to offer
      [Resend the order / Talk to a human], then act on their click")
      → widget chat → GLM offers real buttons → click → GLM handles
      "[user clicked: …]" (trigger on resend) → same from telegram
      with keyboard + retire-on-tap

**Out of scope**: multi-select/forms, per-button styles, email
numbered-reply parsing back into actions, buttons on breadcrumbs.

**Watch-list for the battle-test** (GLM priors from 3b): does it
enumerate options in text AND call the tool (harmless, cosmetic);
does it claim to have offered buttons without calling the tool
(history reconstruction should prevent — it's the same failure class
we fixed with breadcrumb replay); does it invent button ids on click
handling (can't — clicks carry our stored ids).

## Recently finished

### Conversations / Agents — Phase 4: Buttons + onAction — COMPLETE
(user-verified 2026-07-09 on widget AND telegram: buttons rendered,
click → "· clicked" row + onAction → real welcome email through
Resend to Gmail; telegram inline keyboard tap cleared its spinner and
answered after a webhook Re-register. Commits 8c31ed6 / bec50ee /
13cacdb, + 65924ca keyboard-retire polish (user-verified: on tap the
telegram message rewrites itself — keyboard dropped, choice appended
as a check line — matching the widget's dim-after-click; first
accepted tap only, best-effort). Email degradation also user-verified
live 2026-07-09: real Postmark→Resend round trip delivered the
numbered Options block to Gmail. ALL THREE CHANNELS driven E2E.
Known v1 boundary: email replies are plain text — "1" is onMessage,
not an action (numbered-reply parsing = possible later nicety). Review: the action pipeline reused the conversation core
wholesale — clicks are just user rows with raw.action, so dedupe,
transcripts, and both brains got clicks for free. Two operational
gotchas earned: existing telegram registrations must Re-register to
receive callback_query, and agent:demo must run with the USER'S api
key (dev-api-key-123 is the seed tenant — registered a parallel
agent there and silently touched nothing visible). Decision: support-2
stays the GLM managed agent, support-demo stays the bridge/button
demo permanently — no more runtime flipping. Follow-up parked in
backlog: present_buttons tool so managed LLM agents can offer
buttons too.)

### (original Phase 4 plan)

Goal: agent replies can carry BUTTONS; a user click flows back as a
first-class action event that the brain (code or LLM) handles. Widget
renders buttons natively, Telegram uses inline keyboards, email
degrades gracefully. This is the human-in-the-loop building block.

Design decisions:
- **Reply shape**: a reply may carry `buttons: [{id, label}]` (max 6,
  label ≤48 chars). Stored on the reply row as `raw.buttons`; content
  stays plain text (transcript stays readable everywhere).
- **SDK**: `ctx.reply(text, { buttons })` + new `onAction({ action,
  ctx })` handler (`action = {id, label}`); bridge event type
  'action'. Non-breaking: agents without onAction get the action as a
  plain message fallback.
- **Action inbound**: clicks arrive as a user-role row (content =
  the button label, so transcripts read naturally) with
  `raw.action {id}`; rides the same conversation queue; processor
  passes type 'action' to the bridge / renders "[user clicked:
  <label>]" for the managed brain (LLMs handle text best).
- **Channels**:
  · widget: buttons under the agent bubble; click POSTs the action
    (subscriber-token auth), buttons disable after use
  · telegram: `reply_markup.inline_keyboard`; `callback_query` updates
    handled in the webhook (dedupe on callback id, answerCallbackQuery
    to clear the spinner)
  · email: buttons degrade to a numbered text list ("reply 1 for …");
    no click path v1 — replies are already text
- **Managed brain**: gains a `present_buttons` tool? NO — v1 keeps the
  LLM text-only on output; buttons are a BRIDGE (code-agent) feature
  first. LLM button output = later phase (needs a tool + strict
  schema). Keeps this phase bounded.
- Idempotency: click rows dedupe on client-generated actionEventId;
  telegram callbacks dedupe on callback_query id.

**Slice 1 — core + SDK (build → verify vs tests → commit)**
- [x] Reply pipeline: buttons through bridge response schema →
      reply row raw.buttons → WS event + widget REST transcript
- [x] Action inbound: POST /v1/agents/:identifier/actions
      (subscriber-token or api-key; {actionId, label, messageId
      client-dedupe}) → user row + queue → bridge event type 'action'
      / managed textual rendering
- [x] SDK: ctx.reply options.buttons + onAction handler + types
- [x] Tests: buttons round-trip, action event reaches bridge with
      matching id, managed fallback text, dedupe on double-click
**Slice 2 — telegram inline keyboards (build → verify → commit)**
- [x] deliverReply telegram: reply_markup from raw.buttons
- [x] Webhook: handle callback_query (secret check as today, dedupe on
      callback id, answerCallbackQuery, label recovered from the reply
      row's raw.buttons, route as action). setWebhook now sends
      allowed_updates ['message','callback_query'] — existing
      connections must RE-REGISTER to start receiving clicks.
- [x] Tests: keyboard on the wire, callback → action event (label +
      onAction + spinner ack), dedupe, malformed callback skipped,
      allowed_updates asserted (126 tests green)
**Slice 3 — widget + dashboard + E2E (user-driven)**
- [x] `<AgentChat />`: buttons under agent bubbles, click → optimistic
      label bubble + POST /actions (client actionEventId dedupe);
      buttons stay live only while theirs is the latest turn — any
      newer message retires them. Versions bumped: react 0.2.0,
      agent 0.2.0 (Slice 1 SDK additions ride the same release)
- [x] Dashboard transcript: button chips under agent rows +
      "· clicked" marker on action rows
- [x] Demo: agent-demo order flow now offers [Resend the order /
      Talk to a human]; onAction triggers the workflow (resend) or
      sets escalated metadata (human)
- [x] E2E: widget click round-trip; telegram inline keyboard click
      from the phone (RE-REGISTER the telegram webhook first —
      old registrations never receive callback_query)

**Out of scope**: LLM-generated buttons (needs a present_buttons tool
+ schema — follow-up), email click-tracking links, multi-select/forms.

### Conversations / Agents — Phase 3c: Managed-brain polish — COMPLETE
(2026-07-09: usage accounting + per-agent max_tokens. 116 tests;
streaming stays parked. Live check: chat as maya → Details panel shows
LLM usage line with real z.ai token counts.)

Goal: the two cheap-and-real polish items — token-usage accounting
(customers pay per token on their own key; we currently drop the
counts) and per-agent max_tokens (the knob that controls that spend).
Streaming replies stay parked: large surface (WS protocol + gateway +
widget) for 1–2s chat replies.

Design:
- **Usage accounting**: the tool loop accumulates `usage` across ALL
  model calls in a turn (input + output tokens, call count) →
  BrainTurnResult carries it → processor stores it on the reply row's
  `raw.usage` (crash-retry safe: written with the row). Conversation
  detail endpoint sums transcript usage → dashboard Details panel
  shows "LLM usage: N in / M out (K calls)" per conversation; per-turn
  numbers ride the transcript response for later UI.
- **Per-agent max_tokens**: `agents.max_tokens` int nullable (brain
  default 1024 when null), accepted on create/PATCH (bounds 256–8192),
  managed panel gets a numeric field. Loop cap stays a constant.

**Slice (single): backend + dashboard + tests**
- [x] managed-brain: accumulate usage across loop calls; honor
      agent.max_tokens
- [x] Schema/repo/routes: max_tokens column + validation + agentView
- [x] Processor: usage → reply row raw
- [x] API: conversation detail returns per-message usage + totals
- [x] Dashboard: Details panel usage line; managed form max_tokens field
- [x] Tests: usage recorded + totaled, max_tokens reaches the wire,
      bounds validation

### Conversations / Agents — Phase 3b: LLM tool-use — COMPLETE
(user-verified 2026-07-08. Clean-thread E2E with real GLM-4.7: all
three tools live — trigger_workflow fired a real order-shipped email
into Gmail, set_metadata populated the Details panel (order_number +
topic), resolve_conversation closed with a model-written summary.
Commits d877158 / adc5b33 / 59ae493.

The fabrication saga, fully characterized by experiment: GLM claimed
sends it never made once its own history contained a similar exchange.
Root cause = replayed history showed only text, so tool-backed replies
looked like bare claims — we were teaching the model to imitate
claiming. Fixes: anti-fabrication clause in the tool description
(adc5b33) + honest history folding breadcrumbs into replayed assistant
turns (59ae493, skill §13). Bounded residual: threads poisoned BEFORE
the fix stay broken for weak-instruction-following models (Test B);
post-fix threads cannot enter that state (Test A perfect). The
breadcrumb audit trail is what caught the model lying.)

Goal: the zero-code agent gets hands. The managed brain can now
`trigger_workflow` (real notifications mid-chat), `set_metadata`, and
`resolve_conversation` — closing the gap with the SDK brain. No UI
changes; every managed agent gets the tools automatically.

Design decisions:
- **Manual bounded tool loop, NOT the SDK Tool Runner**: the runner is
  beta-namespace (`client.beta.messages`), which Anthropic-COMPATIBLE
  endpoints (z.ai) can't be assumed to serve. Plain `messages.create`
  + a hand-rolled loop (max 5 iterations) is maximally compatible and
  the skill blesses manual loops when you own the whole loop. Evidence
  tools work on z.ai compat: Claude Code (fully tool-driven) runs on it.
- **Three tools, raw JSON schema** (skill: prescriptive descriptions
  that say WHEN to call):
  · `trigger_workflow {workflowKey, payload?}` — workflowKey is an
    **enum of the tenant's actual workflow keys** (fetched per turn),
    so the model cannot hallucinate one; tool omitted if none exist
  · `set_metadata {key, value}` — conversation notes (64KB cap holds)
  · `resolve_conversation {summary?}` — close the thread
- **Loop discipline (per skill)**: execute ALL tool_use blocks in one
  assistant turn, return ALL tool_results in a SINGLE user message
  (splitting trains the model out of parallel calls); failures return
  `is_error: true` results so the model can adapt; append the full
  `response.content` back each iteration; stop on any non-tool_use
  stop_reason; refusal → breadcrumb as in v1; loop cap exhausted →
  breadcrumb + best-effort last text.
- **Retry-safety with a nondeterministic brain**: a retried job re-runs
  the LLM, which may order tool calls differently — so index-based
  dedupe (bridge-style) is NOT safe here. Managed tool effects use
  CONTENT-keyed idempotency instead: trigger txn =
  `conv-<messageId>-<workflowKey>` (a re-run re-fires as duplicate
  no-op), resolve/metadata already idempotent, breadcrumb dedupe keys
  content-based. Bridge path untouched (its signals are deterministic).
- Tool results feed the model real outcomes ("workflow queued, txn …" /
  "unknown workflow" as is_error) — the model can tell the user what
  it actually did.

**Slice 1 — backend (build → verify vs scripted stub → commit)**
- [x] managed-brain.ts: tool definitions (enum from tenant workflows),
      bounded loop, content-keyed effect execution + breadcrumbs
- [x] Tests (stub scripts multi-turn tool_use): trigger creates a real
      event w/ deterministic txn + breadcrumb, metadata lands, resolve
      closes + reopen works, tool error → is_error → model recovers,
      re-run job → NO duplicate trigger, loop cap stops runaway,
      no-tools tenant → trigger tool absent
**Slice 2 — real E2E (user-driven, zero setup)**
- [x] User tightens the GLM agent's system prompt (e.g. "when a user
      reports a missing order, trigger the order-shipped workflow and
      tell them; when the issue is settled, resolve") → asks about an
      order in the widget → real email lands + breadcrumb in transcript
      → metadata visible → "thanks" resolves. Optionally repeat on
      Telegram for the full effect.

**Out of scope**: streaming, cards/onAction (separate backlog item),
letting the LLM read subscriber PII beyond what v1 already sends,
token-usage accounting.

### Conversations / Agents — Phase 3: Managed LLM brain — COMPLETE
(user-verified 2026-07-08 with a real z.ai GLM-4.7 agent through the
Anthropic-compatible base URL: persona followed, conversation memory
across turns, live replies in the widget, transcript on Conversations.
CHANNEL PARITY user-verified same day: flipping the channel-connected
support-demo agent to runtime=managed made the REAL Telegram bot and
the REAL Postmark email address GLM-powered with zero reconfiguration
— "it worked on both telegram and email".
Metadata/resolve correctly empty — v1 brain has no signals by design;
LLM tool-use is the follow-up backlog item. Commits 9e05980 / 84a97d9 /
fa2dc9f. Diagnosis note: user's key carries z.ai Coding-Plan quota on
/api/anthropic but no paas balance — paas 1113 error is irrelevant to
our path.)

Goal: zero-code agents. A customer picks runtime = managed in the
dashboard, pastes an LLM API key + system prompt, and their agent
answers on ALL channels (widget/telegram/email) with no bridge app.
The conversation core, reply delivery, and transcripts are untouched —
only the "brain call" branches.

Design decisions (per the claude-api skill, read 2026-07-08):
- **Client**: official `@anthropic-ai/sdk` in the main app (house
  zero-dep rule applies to published packages, not the server, which
  already carries fastify/bullmq). Per-agent `new Anthropic({ apiKey,
  baseURL, timeout: 60s, maxRetries: 1 })` — BullMQ owns outer retries.
- **BYO endpoint**: per-agent optional base URL for Anthropic-compatible
  APIs. Default api.anthropic.com; the user's z.ai GLM key works by
  setting their compat endpoint — same mechanism tests use to point at
  a stub. This is a product feature, not a shortcut.
- **Model**: per-agent, default `claude-opus-4-8` (skill-mandated
  default; user types their GLM model id for z.ai).
- **Request shape v1**: system = agent system prompt, messages =
  conversation history (already LLM-shaped) + current turn,
  max_tokens per agent (default 1024 — chat replies), NO `thinking`
  param (valid on every model incl. compat endpoints), NO sampling
  params (removed on modern models). Reply = joined text blocks.
- **Stop-reason discipline**: check before reading content — `refusal`
  → system breadcrumb (no reply, no retry); `max_tokens` → deliver
  what came + breadcrumb. SDK typed errors: AuthenticationError /
  BadRequestError / NotFoundError = permanent → breadcrumb "brain
  config error", ack (no retry storm); RateLimit/5xx/connection =
  throw → BullMQ retry → DLQ.
- **Schema**: agents grows `runtime` ('bridge' default | 'managed'),
  `model`, `system_prompt`, `llm_base_url` (plain — not secret),
  `llm_credentials` (sealed {apiKey}, write-only like integrations);
  `bridge_url` becomes nullable (bridge runtime still requires it at
  the app layer; managed requires key+model).
- **No tools in v1** (trigger-as-tool, resolve-as-tool = later slice);
  managed replies reuse deliverReply verbatim, so channel parity is free.

**Slice 1 — backend (build → verify vs stub Anthropic server → commit)**
- [x] Schema + repo: new agent columns, nullable bridge_url
- [x] `src/core/managed-brain.ts`: build client per agent, call
      messages.create, stop-reason handling, typed-error mapping
- [x] conversation.processor: runtime branch (managed → brain call;
      bridge path byte-identical)
- [x] Routes: create/PATCH accept runtime + managed config (apiKey
      write-only sealed; validation per runtime); agentView exposes
      runtime/model/systemPrompt/baseUrl, never the key
- [x] npm i @anthropic-ai/sdk
- [x] Tests: stub Anthropic-shaped server as per-agent baseUrl —
      happy turn (system + history arrive correctly, reply lands via
      existing delivery), 401 → breadcrumb no-retry, refusal →
      breadcrumb, 529 → throws (retryable), key never in GET
**Slice 2 — dashboard + real E2E (user-driven)**
- [x] AgentForm: runtime selector (Your code ↔ Managed LLM); managed
      panel = model, system prompt textarea, API key (password,
      write-only; blank on edit = keep), base URL (optional, hint for
      Anthropic-compatible endpoints)
- [x] E2E: user creates a managed agent with their z.ai key (pasted in
      the modal, never chat) + z.ai compat base URL + GLM model id →
      chats in the widget with ZERO agent code; optionally Telegram
      (needs tunnel back up)

**Out of scope Phase 3 v1**: LLM tool-use (ctx.trigger as a tool),
streaming replies, per-conversation model overrides, token-usage
accounting/quotas (note for later — usage fields are in every response).

### Conversations / Agents — Phase 2b: Email channel — COMPLETE
(user-verified 2026-07-08: real Postmark inbound through the tunnel,
reply delivered to the real inbox via re-added Resend, Re: threading,
resolve, transcript + metadata in dashboard. "everythign worked
awesome". Production migration doc: docs/AGENT-CHANNELS.md, linked
from README. Commits f6f78f0 / f6a5ac1 + docs.)

Goal: notifications become conversations — a user REPLIES to an email
and the agent answers. Third channel on the same core; zero SDK changes.

Design decisions:
- **Inbound = provider inbound webhook** (production path; works locally
  through the same cloudflared tunnel because it's plain HTTP). v1
  provider: **Postmark Inbound** — chosen over SendGrid Parse because
  the user has no DNS access: Postmark hands every account a ready
  inbound address (`<hash>@inbound.postmarkapp.com`), zero MX records,
  clean JSON payload; a custom domain via MX later = same webhook, no
  code change. Route: `POST /webhooks/email/:connectionId?key=<secret>`
  — auth = minted secret in the query, sealed at rest.
- **Agent address**: whatever inbound address the user's Postmark server
  has (stored in config {address}); routing to the agent is by
  connectionId in the webhook URL, NOT by parsing To (v1: one agent per
  Postmark server; multi-agent plus-tag routing noted for later). The
  connect modal collects the address + shows the webhook URL to paste
  into Postmark's inbound settings.
- **Threading**: thread_key = normalized sender email (one thread per
  sender per agent — same shape as inapp/telegram). Dedupe key =
  inbound Message-ID header (falls back to provider envelope id).
  Reply-quoting stripped to the top-most text (naive `On ... wrote:` /
  `>` trimming, v1).
- **Outbound**: deliverReply grows an email branch — build a
  RenderedMessage from the reply row and hand it to the EXISTING
  `sendWithFailover('email', …)` (tenant integration chain, breakers,
  failover all free). From = agent address, To = thread_key,
  Subject = `Re: <last inbound subject>`, In-Reply-To = inbound
  Message-ID so mail clients thread it. Send-once guard identical to
  telegram (raw.providerMessageId).
- Suppression list respected: an address on the suppression list gets
  no agent replies (check before send, system breadcrumb if dropped).

**Slice 1 — backend** — DONE (commit f6f78f0): 98 tests green.
- [x] Inbound route (Postmark JSON: FromFull.Email, Subject, TextBody,
      MessageID): query-secret auth, strip quoted tail, upsert
      subscriber (external_id = sender email), open conversation
      channel='email', dedupe on MessageID, enqueue
- [x] Connect/disconnect/list routes for the email channel (mint
      secret, store inbound address; list shows the webhook URL to
      paste into Postmark)
- [x] deliverReply email branch via sendWithFailover + suppression
      check + send-once; In-Reply-To/References headers via a small
      extension to RenderedMessage (headers?: Record<string,string>)
- [x] Tests: auth (bad key 401), threading (same sender → same
      conversation), Message-ID dedupe, quoted-reply stripping, reply
      send-once, suppressed address → no send + breadcrumb
**Slice 2 — surfaces + real E2E (user-driven)**
- [x] Channels modal: email section (inbound address input, webhook URL
      with copy button + Postmark setup steps, connection state)
- [x] E2E user-verified: Postmark inbound → tunnel → brain → Resend
      reply back to the real inbox, threaded; resolve; transcript OK

**User-side prerequisites (flagging early):** a free Postmark account
(inbound needs no approval, no DNS) and re-adding the Resend
integration for real outbound. NO domain/MX access required.

### Conversations / Agents — Phase 2: Telegram channel — COMPLETE
(user-verified on a real bot over a real tunnel 2026-07-08; commits
451eb2b / cf91806 / ce65f1b, pushed)

Goal: the "any channel, same brain" proof. A customer connects their
Telegram bot to an agent; end-users message the bot; the SAME
conversation core + bridge + brain answer back in Telegram. Zero agent
code changes — the channel is pure platform work.

Design decisions (locked unless you object):
- **Connections**: new `agent_connections` table (tenant, agent, channel,
  sealed credentials {botToken}, config {secretToken, botUsername},
  status; unique (agent_id, channel)) — NOT the integrations table
  (that's outbound failover chains; this is a per-agent identity).
- **Identity**: subscriber auto-created as `tg-<telegramUserId>`;
  conversation thread_key = telegram chat id (so outbound needs no
  subscriber schema change). Linking a tg user to an existing app
  subscriber (deep-link /start token) = deferred, noted for Phase 2.5.
- **Inbound**: ONE path — webhook `POST /webhooks/telegram/:connectionId`
  verified via Telegram's `X-Telegram-Bot-Api-Secret-Token` (we mint the
  secret at connect time, sealed in config). Idempotency free of charge:
  Telegram's `update_id` is the message dedupe key. NO dev poller (user
  decision: no local-only shortcuts) — local dev runs a real tunnel and
  sets PUBLIC_URL to it, so Telegram pushes exactly as in production.
  Because tunnel URLs rotate, the connect API must support re-registering
  the webhook (reconnect action) and surface getWebhookInfo status.
- **Outbound**: conversation.processor becomes channel-aware — 'inapp' →
  existing WS publish; 'telegram' → sendMessage via the connection's bot
  token, with send-once tracking (reply row records the telegram message
  id in `raw`; a retried job re-sends only if it isn't there).
- **Connect flow**: POST /v1/agents/:id/channels/telegram {botToken} →
  we validate via getMe + register setWebhook(PUBLIC_URL/webhooks/...,
  secret_token). DELETE disconnects (deleteWebhook). Token sealed with
  secret-box, never returned.

**Slice 1 — backend** — DONE: 81 tests green twice consecutively.
Bonus root-cause fix: suite was racing the live dev worker fleet on
shared Redis — tests now pin REDIS_DB=15 (tests/setup.ts, skill §12).
- [x] Schema: `agent_connections` + repo functions
- [x] `src/channels/telegram.ts` — tiny client (getMe, setWebhook,
      deleteWebhook, getWebhookInfo, sendMessage), base URL read
      per-call from TELEGRAM_API_BASE (stub-able in tests only)
- [x] Routes: connect (getMe-validated, secret minted+sealed, setWebhook
      registered), reconnect (re-register after PUBLIC_URL/tunnel
      change), channels list w/ live getWebhookInfo, disconnect
      (best-effort deleteWebhook) + inbound webhook (secret-token 401,
      update_id dedupe, private text only, 200-acks what it skips)
- [x] conversation.processor: channel-aware deliverReply (inapp → WS,
      telegram → sendMessage w/ send-once guard via raw.telegramMessageId,
      recovers the row when a retry hits the reply dedupe)
- [x] Integration tests (10): connect/reconnect/webhook-state, bad
      secret 401, unknown connection 404, duplicate update ack,
      non-text/group skip, reply lands in chat exactly once across a
      crash-retry, disconnect kills the webhook

**Slice 2 — surfaces + real-bot E2E**
- [x] Dashboard Agents page: Channels modal per agent — connect (token
      pasted in a password field, never in chat), connected state
      compares Telegram's registered webhook vs expected PUBLIC_URL
      (mismatch = visible + one-click re-register), disconnect
- [x] Conversations UI: channel column in list + Details panel
- [x] E2E with a REAL bot over a REAL cloudflared tunnel — USER-VERIFIED
      2026-07-08: connected via the modal (after a token-paste 404 →
      route now trims + shape-validates tokens), messaged the bot from a
      phone, brain replied in Telegram, transcript + workflow breadcrumb
      + metadata on the Conversations page. Identical path to prod.

**Out of scope for Phase 2**: subscriber linking/connect buttons, media
attachments, typing indicators, message editing, Slack/Teams/WhatsApp,
email inbound-parse (next phase candidate).

### Conversations / Agents — Phase 1 (ACI direction) — COMPLETE

User-verified in the browser 2026-07-08: chat panel live reply, welcome
email in Mailpit (Resend integration removed), Conversations page
transcript + metadata all confirmed working. Commits 8e0bcb6 (core),
785efb7 (SDK+demo+tests), 210e659 (surfaces) — all pushed.

**Review:** the two-way pipe reused almost everything — queues, HMAC
webhook signing, secret-box, subscriber tokens, WS pub/sub, StatusBadge.
Genuinely new: 3 tables, 1 processor, 1 SDK package, 2 dashboard pages.
Next candidates: push to GitHub · publish @asyncify-hq/agent · Phase 2
inbound channels (Telegram first, then email inbound-parse) · Phase 3
managed LLM brain · onAction/interactive cards.

<details>
<summary>Original plan (all items done)</summary>

### Conversations / Agents — Phase 1 (ACI direction; approved)

Goal: make the pipe two-way. A customer registers an **agent** (a bridge
URL we call), end-users message it through our **in-app channel** (zero
third-party setup), we dispatch normalized events to the customer's
brain, deliver its replies live, and let it fire workflows
mid-conversation.

**Slice 1 — backend core** — DONE (commit 8e0bcb6), verified against a
stub bridge: reply + metadata + mid-chat welcome email in Mailpit,
duplicate turn deduped, thanks→resolved, new message reopens, 51 tests
green.
- [x] Schema: `agents` (sealed per-agent signing secret), `conversations`
      (unique (agent_id, channel, thread_key), metadata ≤64KB),
      `conversation_messages` (dedupe key unique per conversation)
- [x] Repo layer `src/db/conversations.repo.ts`
- [x] `conversation-inbound` queue (dash-separated jobIds per gotcha)
- [x] Conversation processor: signed POST to bridge (10s timeout,
      retries→DLQ) → reply row + WS publish + signals in order
      (metadata.set / trigger via internal-trigger.ts / resolve)
- [x] Routes: /v1/agents CRUD + rotate-secret, POST
      /v1/agents/:identifier/messages (subscriber-token or api-key),
      /v1/conversations list/transcript/resolve
- [x] Execution-log entries (transaction_id = conv-<conversationId>)

**Slice 2 — SDK + demo brain** — DONE: 69 tests green (18 new), demo
brain drove the full Ana story (greet → order → mid-chat workflow event
completed w/ inapp sent + email/sms cleanly skipped for the bare
subscriber → thanks → resolved), tsup build clean.
- [x] `packages/agent` = `@asyncify-hq/agent` (zero-dep, mirrors
      sdk-node): `defineAgent({ onMessage, onResolve })` +
      `createHandler(agent, { signingSecret })` returning a plain Node
      http handler (usable from Express/Fastify/Next). ctx: `message`,
      `conversation`, `subscriber`, `history` (LLM-shaped
      `{role, content}[]`), `ctx.reply()`, `ctx.metadata.set()`,
      `ctx.trigger()`, `ctx.resolve()` — signals batched into the one
      HTTP response. Returning a string = reply.
- [x] `scripts/agent-demo.ts` (npm run agent:demo): self-registering
      sample bridge on :4100 — rule-based brain (no LLM key needed)
- [x] Vitest: unit (signature verify, signal application, thread-key
      dedupe/reopen) + integration via buildApp()+inject with a stub
      bridge server

**Slice 3 — surfaces** — DONE: 71 tests green, dashboard tsc+vite build
clean, widget transcript endpoint verified live (subscriber token,
system rows excluded). Deviation from plan: Conversations got its own
nav item + /conversations route instead of living under Activity —
less blast radius on the existing Activity page, clearer nav.
- [x] `packages/react`: `useAgentChat` + `<AgentChat …/>` chat panel
      (optimistic sends w/ client messageId, REST transcript via new
      GET /v1/agents/:id/conversation, live replies over the existing
      WS, resolve/reopen aware); dogfooded on Inbox-preview
- [x] Dashboard: Agents page (create w/ secret-shown-once, edit, rotate
      secret, enable/disable, delete, empty state teaches the SDK) +
      Conversations list (agent/status filters, 10s poll) + transcript
      detail (chat layout, system breadcrumbs centered, metadata +
      details side panel, manual resolve)

**End-to-end verification (the Ana demo, per skill §1):** start
everything + demo bridge → send "where is my order #1042" in the widget
→ agent reply appears live in the chat → triggered workflow email lands
in Mailpit → "thanks" resolves it → transcript + metadata visible in
dashboard → `npm test` green.

**Explicitly OUT of Phase 1** (parked): external channels
(Telegram/email/Slack = Phase 2), managed/hosted LLM brain (Phase 3),
interactive cards + onAction, reply editing, typing indicators,
attachments.

**Decisions locked into this plan:** in-app is the only v1 channel;
plain text/markdown replies; bridge auth = per-agent HMAC secret
(AES-sealed at rest like integration creds); inbound auth = subscriber
tokens (browser) or api key (server).

</details>

## Done (compressed history)

- Phases A–G: engine, accounts, integrations, dashboard, SDKs + widget,
  topics, conditions + open tracking, MJML templates — all verified, all
  pushed (see git log for the full story)
- Published @asyncify-hq/node@0.1.0 + @asyncify-hq/react@0.1.0
- Test suite (51 tests) + instant key-revocation fix
- Skill library: asyncify-engineering (main) + email-delivery (domain)
