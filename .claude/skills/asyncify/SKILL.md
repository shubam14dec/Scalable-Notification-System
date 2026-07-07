---
name: asyncify-engineering
description: The main working skill for this repo — operating rules (planning, subagents, verification, elegance, autonomy, self-improvement, task management) plus Asyncify-specific engineering lessons, the gotchas ledger, and the design system. Read before ANY work in this repo.
---

# Asyncify Engineering — Main Skill

Part I is how to operate, always. Part II is what this codebase has taught
us — every rule earned by a concrete incident here. Both are binding.

# Part I — Operating Rules

## Plan first

- Any non-trivial task (3+ steps or an architectural decision): write the
  plan BEFORE code — checkable items in `tasks/todo.md`; check in with the
  user before implementing when the scope is new or ambiguous.
- Write detailed specs upfront; ambiguity in = rework out.
- The moment something goes sideways, STOP and re-plan. Do not keep pushing
  a broken approach. Plan the verification steps, not just the build.

## Use subagents to protect context

- Offload research, exploration, and parallel analysis to subagents — one
  track per subagent (the reference-codebase audit here ran as two parallel
  explorers and returned only conclusions, not file dumps).
- Hard problems: throw more compute via parallel agents rather than
  grinding one context window down.

## Verification before "done"

- Never mark a task complete without proving it works: run `npm test`,
  drive the feature, read the logs/timeline. Ask: *would a staff engineer
  approve this?*
- Diff behavior against main when a change is risky.
- The project-specific verification loop is Part II §1 — it is not optional.

## Demand elegance (balanced)

- For non-trivial changes, pause and ask: is there a more elegant way?
- If a fix feels hacky: "knowing everything I know now, implement the
  elegant solution" — replace it before presenting.
- Skip this for simple, obvious fixes. Do not over-engineer.
- Challenge your own work before the user has to.

## Autonomous bug fixing

- Given a bug report, failing test, or error log: just fix it. Point at
  the evidence, find the ROOT cause, resolve it. No hand-holding requests,
  no temporary patches. (Precedents here: the "processing" status, the
  timeline ordering, and the revoked-key cache were all fixed at the root —
  a sweep job, FIFO+real timestamps, hash-keyed cache invalidation — never
  band-aided.)

## Self-improvement loop

- After ANY correction from the user: record the pattern immediately —
  project-specific lessons go into Part II of THIS file (that is what the
  ledger is); cross-project lessons go to auto-memory. Write the rule so
  the mistake cannot recur.
- Review this skill at session start; iterate on it until the mistake rate
  drops. This file replaces `tasks/lessons.md` — one ledger, not two.

## Task management

- Plan → `tasks/todo.md` with checkable items → verify the plan with the
  user → mark items complete as you go → add a short review section when
  done.
- Give a high-level summary of changes at each step; the final message of
  a turn carries everything the user needs.

## Core principles

- **Simplicity first:** every change as simple as possible — impact the
  minimum code that fully solves the problem.
- **No laziness:** root causes only. No TODO-hacks left behind. Senior
  engineer standards.
- **Minimal blast radius:** touch only what's necessary; don't create bugs
  in code you didn't need to open.

# Part II — Earned Project Lessons

## 1. Nothing is "done" until it has been driven end to end

Typecheck and build prove the code compiles; they prove nothing about
behavior. Every change here ends with: restart affected services → trigger a
real notification via API or UI → read the timeline (`/activity/:txn`),
Mailpit (:8025), or the DB row. Why: typecheck was green when digest emails
silently rendered the wrong template, when timelines printed out of causal
order, and when a revoked API key kept working — only *driving* the flow (or
a test doing so) caught each one.

Fastest loop: `npm test` (51 tests, ~6s, needs docker pg+redis up) →
`npx tsc --noEmit` → drive the feature. For sends: Mailpit at :8025 catches
all email; `scripts/send-test.ps1 -ApiKey ...` fires a trigger; every
message's full story is at `/v1/events/:txn/timeline`.

## 2. The "start everything" / "stop everything" runbook

When the user says **"start everything"** (all commands from the repo root
`notification-system/`, Node processes as background tasks):

1. `docker compose up -d --wait` — postgres (host :5433), redis, mailpit
   (UI :8025), clickhouse (:8123), jaeger (UI :16686). Volumes persist
   all data; migrate/seed are NOT needed on restart.
2. Start four background processes: `npm run api` · `npm run worker` ·
   `npm run ws` · `npm run dev` in `dashboard/`.
3. Verify before reporting ready: GET :3000/health (api), :3002/health
   (worker), :3001/health (ws), :5173 (dashboard). Report the four
   statuses; only claim "everything is up" when all four return.

**"Stop everything"**: stop the four Node background tasks, then
`docker compose stop` (never `down -v` — that deletes data volumes).
Login: dashboard user shubam@xmobility.ai; env API keys are in the
dashboard (API keys page). Everything survives restarts.

## 3. Restart what you changed — processes don't reload code

api, worker, and ws are long-running tsx processes; edits do nothing until
the owning process restarts. The WS gateway once rejected all new hashed API
keys with 4401 for a whole session because it was still running pre-accounts
code. Map: `src/workers/**` or providers → restart worker · `src/api/**` or
auth → restart api AND ws (gateway imports auth code) · `dashboard/**` →
vite hot-reloads, no restart. After upgrades, restart all three.

## 4. Every pipeline step declares its idempotency key before it's written

The system's safety rests on layered dedupe: `events(tenant_id,
transaction_id)` unique, `messages(event_id, subscriber_id, channel,
step_index)` unique, BullMQ `jobId` on every enqueue, status guards in the
delivery processor. This is what makes retries, crash re-delivery, the DR
reconciler, and topic/direct overlap all safe *for free*. When adding any
new queue hop or writer, decide its dedupe key first — and remember the
flip side: jobId dedupe silently swallows intentional replays, so replays
must carry a nonce (see the reconciler's `replay` field).

## 5. The hot path never waits on bookkeeping

Delivery must only do: read message → call provider → update one row.
Everything else is deferred: execution logs go to a Redis buffer drained in
batches, event completion is a 30s sweep (`settleCompletedEvents`), analytics
are dual-written to ClickHouse, digest state lives in Redis lists. When a new
feature needs to record something, the question is never "where do I write
this" but "which async channel carries it." Adding a synchronous aggregate
to the send path is how notification platforms die (DB IOPS).

## 6. Answer questions by asking reality, not memory

Claims about the reference codebase were settled by grepping its actual
source; npm name availability by hitting `registry.npmjs.org/<name>` (404 =
free); org ownership by `npm org ls`; the BullMQ "Custom Id cannot contain :"
mystery by reading `node_modules/bullmq/dist/.../job.js` (colons allowed only
when the id splits into exactly 3 parts — which is why it worked for months
then broke). A two-minute check beats a confident guess every time it was
tried here.

## 7. Distrust your own green checkmarks

Two self-checks in this project were wrong: an availability probe returned
"FREE" for everything because Cloudflare was blocking the request, and a
PowerShell loop reported stale results because `$r` kept its previous value
after an exception. Before acting on a probe's output, ask whether the
mechanism could produce that answer for the wrong reason. The same applies
to success paths: the first run of the test suite disproved a "verified"
manual result (revoked keys kept working for 60s when cached). Tests explore
sequences humans don't think to try — keep adding them for every behavior
worth keeping.

## 8. Ship in phase-sized slices: build → verify → commit+push → memory

Each phase (A–G) landed as one verified, pushed commit whose message tells
the story, plus a memory update. Never stack a second feature on an
unverified first one, and never leave verified work uncommitted — sessions
end abruptly (services get killed, laptops close). The commit log doubles as
the project's changelog. Beware `git add -A` and `git add <dir>` sweeping in
local-only files — a reference file once reached the public repo that way.

## 9. User-found friction outranks the roadmap

The best fixes in this repo came from the user clicking around, not from the
plan: "why is it processing?" → the settle sweep; "the sidebar covers the
inbox" → the widget's `align` prop; "how do I test from the UI?" → Send-test
buttons; the digest body missing `{{digest_items}}` → the editor warning.
When the user reports friction, fix it before resuming feature work — and
where the fix is generalizable, make it a product feature (the `align`
prop), not a one-off patch.

## 10. Secrets hygiene

Anything pasted into chat is burned — the npm token used for publishing was
revoked immediately after. Provider credentials are AES-256-GCM sealed
(`src/auth/secret-box.ts`) and never returned by any endpoint. API keys are
stored as SHA-256 hashes, shown once; the auth cache is keyed by hash and
revocation must call `invalidateApiKeyCache`. `.npmrc` and `.env` are
gitignored. Browsers only ever get subscriber tokens (`nst_`), never API
keys. Future CI tokens go directly into GitHub Secrets, never through chat.

## 11. Project gotchas ledger

- **BullMQ jobIds must not contain `:`** unless exactly 3 colon-separated
  parts (legacy check). Use `-` separators everywhere.
- **PowerShell 5.1** (the shell here): no `&&`; `git commit -m` messages must
  contain NO double quotes at all — even inside a single-quoted here-string,
  PS strips embedded `"` when passing to git.exe and the message word-splits
  into bogus pathspecs (proven 2026-07-07). Rephrase to avoid quotes; use
  here-strings (`'@` at column 0) only for multi-line;
  multi-line pastes execute line-by-line (give users one-liners or .ps1
  scripts); no inline `try` in expressions; a thrown cmdlet leaves the
  result variable holding its PREVIOUS value — reset `$r = $null` in loops;
  long `Start-Sleep` is blocked — poll in a loop or use Monitor.
- **ioredis is pinned to exactly 5.10.1** to match bullmq's bundled copy;
  upgrading only one side breaks typechecking.
- **@types/mjml declares `mjml2html` as async** — always `await` it.
- **Legacy `nk_` API keys remain valid** (hash lookup); new keys are `ak_`.
- **The dashboard imports `packages/react` source directly** (vite
  `fs.allow: ['..']`) — dogfooding; switch to the npm package only if that
  path breaks.
- **Provider chains cache 30s per tenant+channel; auth cache 60s** — config
  changes are not instant across processes.
- **The public repo must not name the reference systems** (the OSS platform
  or the payments company) — scrubbed once already; keep it that way.
- **Publishing**: account has 2FA-on-publish; `prepublishOnly` rebuilds;
  scoped packages need `publishConfig.access: public` (already set).

## 12. Email domain knowledge lives in its own skill

Deliverability (SPF/DKIM/DMARC, warming, reputation thresholds),
compliance (CAN-SPAM/GDPR/CASL, unsubscribe rules), provider error
classification for new providers, and the known compliance gaps are in
`.claude/skills/email-delivery/SKILL.md`. Consult it before email
features, new providers, or template work.

## 13. Dashboard design system — "Quiet Infrastructure" (condensed)

Tokens live in `dashboard/src/styles.css` — the single source of truth; no
hardcoded hex in components. Geist Sans for UI, **Geist Mono for every
technical value** (ids, keys, addresses, timestamps, counts). Monochrome
chrome: depth = background step + 1px border, no shadows; primary buttons
are inverted monochrome — **color is reserved exclusively for delivery
status**, minted only via `<StatusBadge>`/status vars (ok/warn/err/info).
The violet accent appears ONLY on the logo dot and active-nav marker.
Both themes always (`data-theme`), visible focus rings, 150ms ease motion,
skeletons over spinners, compact rows in an airy frame. Empty states teach
(show the curl/SDK snippet); errors say what happened and what to do. The
sidebar queue-pulse is the one signature element — never enlarge it. If a
diff adds color to a non-status element, it's wrong.
