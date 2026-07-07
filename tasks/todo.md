# Asyncify — Task Board

Per the asyncify-engineering skill: plans land here as checkable items
before implementation; items get checked off as they complete; finished
plans get a short review section, then move to Done.

## Backlog (next candidates, in rough value order)

**Agents / conversations — future phases** (continuation of the shipped
inapp/telegram/email platform; promoted here from the Phase-1/2 parked
notes. Order within this cluster is rough — reorder freely.)

- [ ] Managed LLM brain (Phase 3): a customer pastes an Anthropic key +
      a system prompt in the dashboard and we run the Claude loop
      ourselves instead of POSTing a bridge URL — zero customer code,
      reuses all three channels + the whole conversation core. v1 scope:
      agent gains a `runtime` mode + sealed Anthropic key + system
      prompt; conversation.processor branches to an LLM call (system +
      `ctx.history` → reply) instead of the bridge POST. Tools
      (exposing `trigger` as an LLM tool, built-ins) are a later slice.
      READ the claude-api skill before writing the Anthropic call.
- [ ] Interactive cards + `onAction`: buttons in the `<AgentChat />`
      widget + Telegram inline keyboards, an `onAction({actionId,value})`
      handler in `@asyncify-hq/agent`, card components in the reply
      shape. Unlocks the human-in-the-loop approval pattern later.
- [ ] Subscriber linking (`tg-<id>` / email sender → real app
      subscriber): deep-link `/start <token>` for Telegram (+ an email
      equivalent) so a channel identity merges into an existing
      subscriber instead of a standalone `tg-`/email-addressed one.
      (Deferred from Phase 2.5 — see the Telegram design notes.)

- [ ] Landing page for asyncify.org (public face; domain currently unpointed)
- [ ] Release automation: Changesets + GitHub Actions publish pipeline
      (fresh npm token straight into GitHub Secrets)
- [ ] CI workflow (.github/workflows/ci.yml): typecheck + vitest + builds
      on every push (deliberately deferred earlier)
- [ ] Compliance gap set from email-delivery skill §5: List-Unsubscribe /
      RFC 8058 headers on P2 email, public unsubscribe endpoint, consent
      fields on subscribers, marketing footer block
- [ ] npm workspaces wiring for packages/ (deferred from Phase D)
- [ ] Agent toolkit `@asyncify-hq/agent-toolkit` (workflows-as-LLM-tools
      + MCP server + human-in-the-loop wrapper) — superseded by the
      Conversations/Agents build below; cheap add-on later since it
      wraps the existing trigger API

## In progress

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

## Recently finished

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
