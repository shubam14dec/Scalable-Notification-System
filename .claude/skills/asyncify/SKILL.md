---
name: asyncify-engineering
description: How Asyncify gets built — the working method, verification discipline, idempotency rules, project gotchas, and dashboard design system distilled from building phases A–G. Read before ANY work in this repo (backend, dashboard, packages, ops).
---

# Asyncify Engineering

Distilled from building this system end to end. Every rule below was earned
by a concrete failure or save in this repo — nothing is generic advice.

## 1. Nothing is "done" until it has been driven end to end

Typecheck and build prove the code compiles; they prove nothing about
behavior. Every change here ends with: restart affected services → trigger a
real notification via API or UI → read the timeline (`/activity/:txn`),
Mailpit (:8025), or the DB row. Why: typecheck was green when digest emails
silently rendered the wrong template, when timelines printed out of causal
order, and when a revoked API key kept working — only *driving* the flow (or
a test doing so) caught each one. Boris's #1 tip is the same finding: a
verification feedback loop 2–3×'s output quality.

Fastest loop: `npm test` (51 tests, ~6s, needs docker pg+redis up) →
`npx tsc --noEmit` → drive the feature. For sends: Mailpit at :8025 catches
all email; `scripts/send-test.ps1 -ApiKey ...` fires a trigger; every
message's full story is at `/v1/events/:txn/timeline`.

## 2. Restart what you changed — processes don't reload code

api, worker, and ws are long-running tsx processes; edits do nothing until
the owning process restarts. The WS gateway once rejected all new hashed API
keys with 4401 for a whole session because it was still running pre-accounts
code. Map: `src/workers/**` or providers → restart worker · `src/api/**` or
auth → restart api AND ws (gateway imports auth code) · `dashboard/**` →
vite hot-reloads, no restart. After upgrades, restart all three.

## 3. Every pipeline step declares its idempotency key before it's written

The system's safety rests on layered dedupe: `events(tenant_id,
transaction_id)` unique, `messages(event_id, subscriber_id, channel,
step_index)` unique, BullMQ `jobId` on every enqueue, status guards in the
delivery processor. This is what makes retries, crash re-delivery, the DR
reconciler, and topic/direct overlap all safe *for free*. When adding any
new queue hop or writer, decide its dedupe key first — and remember the
flip side: jobId dedupe silently swallows intentional replays, so replays
must carry a nonce (see the reconciler's `replay` field).

## 4. The hot path never waits on bookkeeping

Delivery must only do: read message → call provider → update one row.
Everything else is deferred: execution logs go to a Redis buffer drained in
batches, event completion is a 30s sweep (`settleCompletedEvents`), analytics
are dual-written to ClickHouse, digest state lives in Redis lists. When a new
feature needs to record something, the question is never "where do I write
this" but "which async channel carries it." Adding a synchronous aggregate
to the send path is how notification platforms die (DB IOPS).

## 5. Answer questions by asking reality, not memory

Claims about the reference codebase were settled by grepping its actual
source; npm name availability by hitting `registry.npmjs.org/<name>` (404 =
free); org ownership by `npm org ls`; the BullMQ "Custom Id cannot contain :"
mystery by reading `node_modules/bullmq/dist/.../job.js` (colons allowed only
when the id splits into exactly 3 parts — which is why it worked for months
then broke). A two-minute check beats a confident guess every time it was
tried here.

## 6. Distrust your own green checkmarks

Two self-checks in this project were wrong: an availability probe returned
"FREE" for everything because Cloudflare was blocking the request, and a
PowerShell loop reported stale results because `$r` kept its previous value
after an exception. Before acting on a probe's output, ask whether the
mechanism could produce that answer for the wrong reason. The same applies
to success paths: the first run of the test suite disproved a "verified"
manual result (revoked keys kept working for 60s when cached). Tests explore
sequences humans don't think to try — keep adding them for every behavior
worth keeping.

## 7. Ship in phase-sized slices: build → verify → commit+push → memory

Each phase (A–G) landed as one verified, pushed commit whose message tells
the story, plus a memory update. Never stack a second feature on an
unverified first one, and never leave verified work uncommitted — sessions
end abruptly (services get killed, laptops close). The commit log doubles as
the project's changelog.

## 8. User-found friction outranks the roadmap

The best fixes in this repo came from the user clicking around, not from the
plan: "why is it processing?" → the settle sweep; "the sidebar covers the
inbox" → the widget's `align` prop; "how do I test from the UI?" → Send-test
buttons; the digest body missing `{{digest_items}}` → the editor warning.
When the user reports friction, fix it before resuming feature work — and
where the fix is generalizable, make it a product feature (the `align`
prop), not a one-off patch.

## 9. Secrets hygiene

Anything pasted into chat is burned — the npm token used for publishing was
revoked immediately after. Provider credentials are AES-256-GCM sealed
(`src/auth/secret-box.ts`) and never returned by any endpoint. API keys are
stored as SHA-256 hashes, shown once; the auth cache is keyed by hash and
revocation must call `invalidateApiKeyCache`. `.npmrc` and `.env` are
gitignored. Browsers only ever get subscriber tokens (`nst_`), never API
keys. Future CI tokens go directly into GitHub Secrets, never through chat.

## 10. Project gotchas ledger

- **BullMQ jobIds must not contain `:`** unless exactly 3 colon-separated
  parts (legacy check). Use `-` separators everywhere.
- **PowerShell 5.1** (the shell here): no `&&`; `git commit -m` breaks on
  embedded double quotes (use single-quoted here-strings, `'@` at column 0);
  multi-line pastes execute line-by-line (give users one-liners or .ps1
  scripts); no inline `try` in expressions; long `Start-Sleep` is blocked —
  poll in a loop or use Monitor.
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

## 11. Email domain knowledge lives in its own skill

Deliverability (SPF/DKIM/DMARC, warming, reputation thresholds),
compliance (CAN-SPAM/GDPR/CASL, unsubscribe rules), provider error
classification for new providers, and the known compliance gaps are in
`.claude/skills/email-delivery/SKILL.md`. Consult it before email
features, new providers, or template work.

## 12. Dashboard design system — "Quiet Infrastructure" (condensed)

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
