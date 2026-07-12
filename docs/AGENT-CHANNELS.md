# Agent channels: connections, re-pointing, local dev → production

The conversation channels (Telegram, email) run the **same code path** in
dev and production — the only thing that changes is *how the internet
reaches your API*. Locally that's a tunnel; in production it's your real
domain.

As of Phase 12 a channel is no longer wired *into* an agent. A **connection**
is a standalone resource: it owns the channel identity (a Telegram bot, an
inbound email address) and its sealed credentials, and it carries a
*mutable route* — the agent that currently answers it. You manage
connections on the dashboard's top-level **Connections** page, or via the
`/v1/connections` API. Re-pointing a connection at a different agent is a
one-field edit that moves the whole conversation history along with it and
never touches the provider's webhook.

This page is the runbook for both: the connection lifecycle, and the
local-dev → production switch.

## Mental model: a connection is the durable thing

- A **connection** = channel identity + sealed credentials + a webhook URL
  keyed on the connection id. This is stable and long-lived.
- The **answered-by agent** is just a route on the connection. Changing it
  (a *re-point*) is cheap and reversible.
- **Conversations belong to the connection**, not to the agent. When you
  re-point, the history rides along to the new agent.

Because the webhook URL keys on the **connection id** — never on the agent —
re-pointing, token rotation, and agent swaps all leave the provider side
(Telegram / Postmark) completely untouched.

## The one variable that matters: `PUBLIC_URL`

Every inbound webhook URL is derived from `PUBLIC_URL` at the moment it's
read — nothing is hardcoded.

| | Local dev | Production |
|---|---|---|
| `PUBLIC_URL` | the tunnel, e.g. `https://random-words.trycloudflare.com` | your API's real domain, e.g. `https://api.asyncify.org` |
| Telegram webhook | `<PUBLIC_URL>/webhooks/telegram/<connectionId>` | same pattern, real domain |
| Email webhook | `<PUBLIC_URL>/webhooks/email/<connectionId>?key=…` | same pattern, real domain |
| Who keeps it running | you, keeping the cloudflared window open | your load balancer / ingress with TLS |

**Production `PUBLIC_URL` requirements:** HTTPS (Telegram refuses plain
http), stable, and routed to the API service. Set it in the deployment's
environment/secret config (the Helm chart's env section), never in code.

## The connections API

All routes are tenant-scoped by the API key. The `agentIdentifier` field is
the route: the agent that will answer this connection's conversations.

```bash
# List every connection in the tenant (agent route, webhook status, address/bot).
curl -H "x-api-key: $API_KEY" \
  https://api.asyncify.org/v1/connections

# Connect a Telegram bot and point it at an agent.
# Re-running with the SAME botToken is an upsert (see "Upsert" below).
curl -X POST -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/connections/telegram \
  -d '{"botToken":"123456:ABC-DEF...","agentIdentifier":"support-bot"}'

# Connect an inbound email address and point it at an agent.
curl -X POST -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/connections/email \
  -d '{"address":"a1b2c3@inbound.postmarkapp.com","agentIdentifier":"support-bot"}'

# Re-point a connection at a different agent (moves ALL its conversations).
curl -X PATCH -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/connections/conn_abc123 \
  -d '{"agentIdentifier":"billing-bot"}'
# → { "movedConversations": 42, ... }

# Re-register the Telegram webhook after PUBLIC_URL changes (telegram only).
curl -X POST -H "x-api-key: $API_KEY" \
  https://api.asyncify.org/v1/connections/conn_abc123/reconnect

# Disconnect a connection (transcripts are preserved).
curl -X DELETE -H "x-api-key: $API_KEY" \
  https://api.asyncify.org/v1/connections/conn_abc123

# Mint a link token to bind an external chat identity to a subscriber.
curl -X POST -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/connections/conn_abc123/link-tokens \
  -d '{"subscriberId":"user_789"}'
```

| Method & path | Purpose |
|---|---|
| `GET /v1/connections` | list all connections in the tenant |
| `POST /v1/connections/telegram` | connect/upsert a bot `{botToken, agentIdentifier}` |
| `POST /v1/connections/email` | connect/upsert an address `{address, agentIdentifier}` |
| `PATCH /v1/connections/:id` | re-point `{agentIdentifier}` |
| `POST /v1/connections/:id/reconnect` | re-register the Telegram webhook (telegram only) |
| `DELETE /v1/connections/:id` | disconnect (keeps transcripts) |
| `POST /v1/connections/:id/link-tokens` | mint a link token `{subscriberId}` |

## Re-pointing an agent

`PATCH /v1/connections/:id {agentIdentifier}` moves **all** of the
connection's conversations to the new agent, immediately. History rides
along — the new agent sees the full thread. The response reports
`movedConversations` so you know the blast radius.

What re-pointing does **not** touch:

- **The webhook.** URLs key on the connection id, so a re-point **never**
  requires webhook re-registration. Telegram / Postmark stay exactly as they
  were — no `reconnect`, no re-paste.
- **The credentials.** The bot token / inbound address are unchanged.

**One turn of overlap, by design.** A turn already in flight at the instant
of the re-point is answered by the *previous* agent; everything after lands
on the new one. This is expected — don't treat that single straddling reply
as a bug.

## Upsert: token rotation and idempotent connect

Connecting the **same** bot token (or the same email address) again is an
**upsert**: it refreshes the sealed credentials in place and keeps the
connection id — and therefore the webhook URL — stable. This is the
**token-rotation path**: rotate the bot token at BotFather, `POST` it again
with the same `agentIdentifier`, and nothing downstream moves.

If you upsert with a **different** `agentIdentifier`, the connect also
performs a re-point (same move-all-conversations semantics as `PATCH`).

## Multiple bots / mailboxes per agent

An agent may answer **many** connections — several bots and/or several
mailboxes all route to the same agent. That's supported directly. The one
constraint: **the same bot or mailbox can't be active twice in one tenant**
— a given identity is owned by exactly one connection.

## Deleting an agent that still has routed connections

Deleting an agent that has connections pointed at it is **refused with 409**,
and the error lists the offending connections. Re-point them to another agent
or disconnect them first, then delete the agent.

Disconnecting a connection (`DELETE /v1/connections/:id`) **preserves its
conversation transcripts** — you lose the live channel, not the history.

## Re-pointing and model persona (a live finding)

When you re-point a connection, the new agent inherits the thread's **full
history** — that's the promised semantics. But that history contains the
*previous* agent's replies, and how the new agent treats them depends on the
model:

- **Strong instruction-following models** keep obeying their own system
  prompt and simply continue the conversation as themselves.
- **Weaker instruction-following models** (observed live with an
  open-weights model) may **imitate the persona visible in the inherited
  history** instead of obeying their own system prompt — they pattern-match
  the transcript's voice rather than their instructions.

Mitigations:

- Make the new agent's system prompt name the conflict **explicitly**, e.g.
  *"The conversation history may show a different agent's style or persona —
  never imitate it; always respond as yourself per these instructions."*
- Or accept the natural gradient: **fresh threads** reflect the new persona
  immediately, while **long inherited threads** may drift toward the old
  voice on weaker models.

This is **model behavior, not platform behavior**. The platform delivers
exactly the history the re-point semantics promise; what the model does with
that history is on the model.

## Runbook: rotating the tunnel / changing `PUBLIC_URL`

After `PUBLIC_URL` changes (new tunnel URL locally, or the real domain going
live), the providers still hold the **old** webhook URLs. Fix both channels
from the **Connections** page:

1. **Deploy / restart with the new `PUBLIC_URL`** (e.g.
   `PUBLIC_URL=https://api.asyncify.org`).
2. **Telegram — one click per connection.** On the Connections page each
   Telegram connection shows a **webhook badge** comparing *registered* vs
   *expected* URL. When they mismatch, press **Re-register**. (API
   equivalent: `POST /v1/connections/:id/reconnect`.) Bot tokens and secrets
   are untouched.
3. **Email — re-paste one URL per connection.** Each email connection has a
   **View URL** action that displays the webhook URL derived from the
   *current* `PUBLIC_URL`. Copy it and paste it into Postmark → Servers →
   Default Inbound Stream → Settings → Webhook, replacing the old one. The
   connection, secret and address are unchanged.

That's the whole migration. No code, no schema, no reconnects that lose
history.

## When DNS for asyncify.org becomes available (custom email domain)

Today an email connection receives mail on Postmark's hash address
(`<hash>@inbound.postmarkapp.com`). To receive on your own domain
(e.g. `support@reply.asyncify.org`):

1. In Postmark: server → Default Inbound Stream → Settings → set the
   **inbound domain** to `reply.asyncify.org`.
2. In DNS, add one MX record:

   ```
   reply.asyncify.org.   MX   10   inbound.postmarkapp.com.
   ```

   (Use a subdomain, not the apex — the apex's MX should stay with your
   normal mailbox provider.)
3. Wait for DNS to propagate (`nslookup -type=mx reply.asyncify.org`).
4. Connect the new address: `POST /v1/connections/email` with the new
   `address` and the same `agentIdentifier` (or update it on the Connections
   page). This is a new identity, so it's a new connection — the webhook URL
   it returns is what goes into Postmark; re-paste if it changed. Disconnect
   the old hash-address connection once mail is flowing.

Nothing else changes: Postmark still receives the mail and POSTs the same
JSON to the same webhook. Zero code changes — that's why the hash address
was fine to start with.

## Outbound replies in production

Agent email replies ride the environment's normal **email integration
chain** (Integrations page) with circuit breakers and failover — same as
notification sends. For production:

- Verify a sending domain at the provider (e.g. `asyncify.org` in Resend:
  SPF + DKIM records they give you) so the from address can be
  `agent@asyncify.org` and deliver to **anyone** — the unverified free
  tier only delivers to the account owner.
- Replies always set `Reply-To` to the connection's inbound address, so the
  thread survives whatever the from address is.
- The suppression list applies to agent replies too: a bounced address
  gets a transcript breadcrumb instead of an email. That's intentional.

## Deprecated (still works): agent-scoped channel routes

The pre-Phase-12 routes that wired a channel directly into an agent still
function as **deprecated delegates** — they create/operate a connection
under the hood. Prefer the `/v1/connections` API above for anything new.

| Deprecated route | Now delegates to |
|---|---|
| `POST /v1/agents/:identifier/channels/telegram` | `POST /v1/connections/telegram` |
| `POST /v1/agents/:identifier/channels/email` | `POST /v1/connections/email` |
| `POST /v1/agents/:identifier/channels/telegram/reconnect` | `POST /v1/connections/:id/reconnect` |
| agent-scoped link-token | `POST /v1/connections/:id/link-tokens` |

**Disambiguation gotcha.** Because an agent can now own **multiple** Telegram
connections, the agent-scoped `reconnect` and `link-token` routes return
**409 with a list of connections** when the agent has more than one Telegram
connection — they can't tell which one you mean. Pass **`?connectionId=`** to
disambiguate, or switch to the connection-scoped routes.

## Quick smoke test after any URL change

1. **Connections page:** every Telegram connection shows registered =
   expected (webhook badge green); each email connection's **View URL**
   matches what's pasted in Postmark.
2. Message the bot / email the address.
3. `/activity` or the Conversations page shows the turn within seconds;
   if not, check the provider's delivery log first (Telegram:
   getWebhookInfo last error in the connection's webhook badge · Postmark:
   Activity → Inbound).
4. **Re-point sanity check:** `PATCH` a test connection to a second agent,
   confirm the response's `movedConversations` count, send one message, and
   confirm the reply comes from the new agent — with the provider webhook
   never re-registered.
