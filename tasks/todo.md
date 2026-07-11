# Asyncify — Task Board

Per the asyncify-engineering skill: plans land here as checkable items
before implementation; items get checked off as they complete; finished
plans get a short review section, then move to Done.

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
- [ ] Slack agent channel: OAuth connect, threads → conversations,
      Block Kit buttons, welcome message (our agent_connections +
      thread_key model maps 1:1)
- [ ] Agent replies: edit/delete (ReplyHandle) + typing indicator —
      small; the prerequisite for streaming
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
- [ ] Agent cards v2: Select dropdowns + TextInput on top of the
      buttons pipeline (Tier B)
- [ ] Tool approval via workflow: deferred tool call fires a real
      notification; human approves from any channel; webhook resumes
      (Tier B — composes our buttons + trigger machinery)
- [ ] `asyncify dev` CLI command: managed tunnel + sleep-drift
      watchdog + auto PUBLIC_URL/webhook re-registration — erases the
      cloudflared rotation drill (Tier B — our own recurring pain)
- [ ] Rolling dual API keys per environment (Tier B — small)
- [ ] Engine hygiene from their DAL: keyset pagination + capped
      counts on list endpoints; mandatory column projection on hot
      queries; cache-set TTL jitter (Tier B — adopt incrementally)

**Agents / conversations — future phases** (continuation of the shipped
inapp/telegram/email platform; promoted here from the Phase-1/2 parked
notes. Order within this cluster is rough — reorder freely.)

- [ ] Streaming managed replies (parked from 3c: WS protocol + gateway +
      widget surface for 1–2s chat replies — revisit if replies grow)
- [ ] Auto-resolve on inactivity: scheduled sweep closes active
      conversations idle for N hours (per-agent setting, default
      24h?) with a system breadcrumb — the platform backstop for
      threads that trail off, regardless of brain quality (the
      "Thank you" judgment case from Phase 5's battle-test).
- [ ] Subscriber linking (`tg-<id>` / email sender → real app
      subscriber): deep-link `/start <token>` for Telegram (+ an email
      equivalent) so a channel identity merges into an existing
      subscriber instead of a standalone `tg-`/email-addressed one.
      (Deferred from Phase 2.5 — see the Telegram design notes.)

- [ ] Landing page for asyncify.org (public face; domain currently unpointed)
- [ ] Release automation: Changesets + GitHub Actions publish pipeline
      (fresh npm token straight into GitHub Secrets)
- [x] CI workflow (.github/workflows/ci.yml): postgres/redis/mailpit
      services, migrate → typecheck → 152 tests → SDK + dashboard
      builds on every push/PR; README badge. (2026-07-10)
- [ ] Compliance gap set from email-delivery skill §5: List-Unsubscribe /
      RFC 8058 headers on P2 email, public unsubscribe endpoint, consent
      fields on subscribers, marketing footer block
- [ ] npm workspaces wiring for packages/ (deferred from Phase D)
- [ ] Agent toolkit `@asyncify-hq/agent-toolkit` (workflows-as-LLM-tools
      + MCP server + human-in-the-loop wrapper) — superseded by the
      Conversations/Agents build below; cheap add-on later since it
      wraps the existing trigger API

## In progress

(nothing — next up per the agents track: Phase 10, message
edit/delete + typing indicator)

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
