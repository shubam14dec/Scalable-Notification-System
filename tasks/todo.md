# Asyncify â€” Task Board

Per the asyncify-engineering skill: plans land here as checkable items
before implementation; items get checked off as they complete; finished
plans get a short review section, then move to Done.

## Backlog (next candidates, in rough value order)

- [ ] Landing page for asyncify.org (public face; domain currently unpointed)
- [ ] Release automation: Changesets + GitHub Actions publish pipeline
      (fresh npm token straight into GitHub Secrets)
- [ ] CI workflow (.github/workflows/ci.yml): typecheck + vitest + builds
      on every push (deliberately deferred earlier)
- [ ] Compliance gap set from email-delivery skill Â§5: List-Unsubscribe /
      RFC 8058 headers on P2 email, public unsubscribe endpoint, consent
      fields on subscribers, marketing footer block
- [ ] npm workspaces wiring for packages/ (deferred from Phase D)
- [ ] Agent toolkit `@asyncify-hq/agent-toolkit` (workflows-as-LLM-tools
      + MCP server + human-in-the-loop wrapper) â€” superseded by the
      Conversations/Agents build below; cheap add-on later since it
      wraps the existing trigger API

## In progress

### Conversations / Agents â€” Phase 1 (ACI direction; plan pending user OK)

Goal: make the pipe two-way. A customer registers an **agent** (a bridge
URL we call), end-users message it through our **in-app channel** (zero
third-party setup), we dispatch normalized events to the customer's
brain, deliver its replies live, and let it fire workflows
mid-conversation.

**Slice 1 â€” backend core (build â†’ verify â†’ commit)** â€” DONE, verified
against a stub bridge (reply + metadata + mid-chat welcome email in
Mailpit, duplicate turn deduped, thanksâ†’resolved, new message reopens,
51 tests green)
- [x] Schema (append to `src/db/schema.sql`, idempotent): `agents`
      (tenant-scoped identifier, name, bridge_url, sealed per-agent
      signing secret, status), `conversations` (agent, subscriber,
      channel, thread_key, status active/resolved, metadata JSONB â‰¤64KB,
      last_message_at; unique (agent_id, channel, thread_key)),
      `conversation_messages` (role user/agent/system, content, dedupe
      key unique per conversation, created_at)
- [x] Repo layer `src/db/conversations.repo.ts`
- [x] New queue `conversation-inbound` in `src/shared/queues.ts`
      (jobIds use `-` separators per gotcha ledger)
- [x] Conversation processor in the worker fleet: load agent +
      conversation + history â†’ POST signed event (reuse HMAC scheme from
      `webhook-signature.ts`, per-agent secret) to bridge_url (10s
      timeout, BullMQ retries â†’ DLQ) â†’ apply response: insert agent
      reply row + publish `conversation.message` on the subscriber's
      existing WS pub/sub channel â†’ apply signals in order
      (`metadata.set` merge w/ 64KB cap Â· `trigger` â†’ internal trigger
      path, tagged in conversation Â· `resolve`)
- [x] API routes: `/v1/agents` CRUD (dashboard JWT + api-key dual auth,
      same pattern as templates) Â· `POST /v1/agents/:identifier/messages`
      inbound (subscriber-token OR api-key auth; creates/reopens
      conversation, enqueues, 202) Â· `GET /v1/conversations` +
      `/:id` (transcript) Â· `POST /v1/conversations/:id/resolve`
- [x] Execution-log entries so the `/activity` timeline extends later

**Slice 2 â€” SDK + demo brain (build â†’ verify â†’ commit)**
- [ ] `packages/agent` = `@asyncify-hq/agent` (zero-dep, mirrors
      sdk-node): `defineAgent({ onMessage, onResolve })` +
      `createHandler(agent, { signingSecret })` returning a plain Node
      http handler (usable from Express/Fastify/Next). ctx: `message`,
      `conversation`, `subscriber`, `history` (LLM-shaped
      `{role, content}[]`), `ctx.reply()`, `ctx.metadata.set()`,
      `ctx.trigger()`, `ctx.resolve()` â€” signals batched into the one
      HTTP response (Novu's model). Returning a string = reply.
- [ ] `scripts/agent-demo.ts`: sample bridge on :4100 â€” rule-based brain
      (no LLM key needed): greets, answers "where is my order" with a
      reply + `ctx.trigger('order-shipped', â€¦)`, resolves on "thanks"
- [ ] Vitest: unit (signature verify, signal application, thread-key
      dedupe/reopen) + integration via buildApp()+inject with a stub
      bridge server

**Slice 3 â€” surfaces (build â†’ verify â†’ commit)**
- [ ] `packages/react`: `<AgentChat agentIdentifier â€¦ />` chat panel
      (subscriber-token auth, REST send + existing WS live replies),
      design-system compliant; dogfood on the dashboard Inbox-preview
      page
- [ ] Dashboard: Agents page (list/create/edit: identifier, bridge URL,
      secret shown once) + Conversations list & transcript view under
      Activity (frontend-design plugin + skill Â§13)

**End-to-end verification (the Ana demo, per skill Â§1):** start
everything + demo bridge â†’ send "where is my order #1042" in the widget
â†’ agent reply appears live in the chat â†’ triggered workflow email lands
in Mailpit â†’ "thanks" resolves it â†’ transcript + metadata visible in
dashboard â†’ `npm test` green.

**Explicitly OUT of Phase 1** (parked): external channels
(Telegram/email/Slack = Phase 2), managed/hosted LLM brain (Phase 3),
interactive cards + onAction, reply editing, typing indicators,
attachments.

**Decisions locked into this plan:** in-app is the only v1 channel;
plain text/markdown replies; bridge auth = per-agent HMAC secret
(AES-sealed at rest like integration creds); inbound auth = subscriber
tokens (browser) or api key (server).

## Done (compressed history)

- Phases Aâ€“G: engine, accounts, integrations, dashboard, SDKs + widget,
  topics, conditions + open tracking, MJML templates â€” all verified, all
  pushed (see git log for the full story)
- Published @asyncify-hq/node@0.1.0 + @asyncify-hq/react@0.1.0
- Test suite (51 tests) + instant key-revocation fix
- Skill library: asyncify-engineering (main) + email-delivery (domain)
