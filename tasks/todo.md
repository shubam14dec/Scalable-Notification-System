# Asyncify — Task Board

Per the asyncify-engineering skill: plans land here as checkable items
before implementation; items get checked off as they complete; finished
plans get a short review section, then move to Done.

## Backlog (next candidates, in rough value order)

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
      HTTP response (Novu's model). Returning a string = reply.
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

## Done (compressed history)

- Phases A–G: engine, accounts, integrations, dashboard, SDKs + widget,
  topics, conditions + open tracking, MJML templates — all verified, all
  pushed (see git log for the full story)
- Published @asyncify-hq/node@0.1.0 + @asyncify-hq/react@0.1.0
- Test suite (51 tests) + instant key-revocation fix
- Skill library: asyncify-engineering (main) + email-delivery (domain)
