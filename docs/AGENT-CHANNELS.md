# Agent channels: connections, re-pointing, local dev → production

The conversation channels (Telegram, email, Slack) run the **same code path**
in dev and production — the only thing that changes is *how the internet
reaches your API*. Locally that's a tunnel; in production it's your real
domain.

As of Phase 12 a channel is no longer wired *into* an agent. A **connection**
is a standalone resource: it owns the channel identity (a Telegram bot, an
inbound email address, a Slack workspace) and its sealed credentials, and it
carries a
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
(Telegram / Postmark / Slack) completely untouched.

## The one variable that matters: `PUBLIC_URL`

Every inbound webhook URL is derived from `PUBLIC_URL` at the moment it's
read — nothing is hardcoded.

| | Local dev | Production |
|---|---|---|
| `PUBLIC_URL` | the tunnel, e.g. `https://random-words.trycloudflare.com` | your API's real domain, e.g. `https://api.asyncify.org` |
| Telegram webhook | `<PUBLIC_URL>/webhooks/telegram/<connectionId>` | same pattern, real domain |
| Email webhook | `<PUBLIC_URL>/webhooks/email/<connectionId>?key=…` | same pattern, real domain |
| Slack events + interactivity URLs | `<PUBLIC_URL>/webhooks/slack/<connectionId>/…` | same pattern, real domain |
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

# Connect a Slack workspace and point it at a default agent.
# Returns the two webhook URLs you paste into the Slack app config.
curl -X POST -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/connections/slack \
  -d '{"botToken":"xoxb-...","signingSecret":"...","agentIdentifier":"support-bot"}'
# → 201 { "channel":"slack", "teamName":"Acme", "eventsUrl":"...", "interactivityUrl":"..." }

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
| `POST /v1/connections/slack` | connect/upsert a workspace `{botToken, signingSecret, agentIdentifier}` |
| `PATCH /v1/connections/:id` | re-point `{agentIdentifier}` |
| `POST /v1/connections/:id/reconnect` | re-register the Telegram webhook (telegram only) |
| `GET/PUT/DELETE /v1/connections/:id/routes` | per-channel routing rules (slack only) — see [Slack](#slack) |
| `DELETE /v1/connections/:id` | disconnect (keeps transcripts) |
| `POST /v1/connections/:id/link-tokens` | mint a link token `{subscriberId}` (telegram only) |

## Re-pointing an agent

`PATCH /v1/connections/:id {agentIdentifier}` moves **all** of the
connection's conversations to the new agent, immediately. History rides
along — the new agent sees the full thread. The response reports
`movedConversations` so you know the blast radius.

What re-pointing does **not** touch:

- **The webhook.** URLs key on the connection id, so a re-point **never**
  requires webhook re-registration. Telegram / Postmark / Slack stay exactly
  as they were — no `reconnect`, no re-paste.
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
4. **Slack — re-paste the two URLs per connection.** The Events and
   Interactivity URLs are derived from `PUBLIC_URL`, so a change moves them.
   Copy the current pair from the Slack connection row and paste them back
   into the Slack app config → *Event Subscriptions* (wait for **Verified**)
   and *Interactivity & Shortcuts*. The bot token and signing secret are
   unchanged. (This only applies to a real `PUBLIC_URL` change — an upsert or
   re-point keeps the URLs stable.)

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

## Slack

Slack is the fourth agent channel. Unlike Telegram (one bot) or email (one
address), a Slack connection owns a **whole workspace** and can fan out to
**many agents** through per-channel routing rules — the switchboard payoff.
Install is a **token paste**, not OAuth: you create a Slack app from our
manifest, install it to your workspace, and paste two secrets into the
dashboard. (Full OAuth "Add to Slack" distribution is planned — see the
backlog note at the end.)

### The app manifest

Create the Slack app from this manifest **verbatim**. The two `request_url`
placeholders are intentional — they get replaced **after** you connect,
because the real URLs contain the connection id that doesn't exist yet
(chicken-and-egg). Slack will warn at creation that the URLs are unverified;
that's expected — ignore it.

```yaml
display_information:
  name: Asyncify Agent
  description: AI agent connected via Asyncify
features:
  app_home:
    messages_tab_enabled: true
    messages_tab_read_only_enabled: false
  bot_user:
    display_name: asyncify-agent
    always_online: true
oauth_config:
  scopes:
    bot:
      - app_mentions:read
      - channels:history
      - chat:write
      - im:history
      - users:read
      - users:read.email
settings:
  event_subscriptions:
    request_url: https://example.invalid/replace-after-connect
    bot_events:
      - app_mention
      - message.channels
      - message.im
  interactivity:
    is_enabled: true
    request_url: https://example.invalid/replace-after-connect
```

### Setup (runbook)

1. **api.slack.com/apps → Create New App → From an app manifest.** Pick the
   workspace, paste the YAML above, **Create** (ignore the URL warnings).
2. **Install to Workspace → authorize.** Copy the **Bot User OAuth Token**
   (`xoxb-…`) from *OAuth & Permissions*, and the **Signing Secret** from
   *Basic Information*.
3. **Dashboard → Connections → Connect → Slack.** Paste both secrets, choose
   the **default agent** ("answered by"), and **Connect**. The success panel
   returns two URLs — copy both.
   (API equivalent: `POST /v1/connections/slack {botToken, signingSecret,
   agentIdentifier}` → `201 {channel, teamName, eventsUrl, interactivityUrl}`.)
4. **Slack app config → Event Subscriptions → Enable.** Paste the **Events
   URL**, wait for **Verified** (Slack fires a `url_verification` challenge —
   a green *Verified* also proves your signing secret was pasted correctly),
   ensure the three bot events (`app_mention`, `message.channels`,
   `message.im`) are subscribed, and **Save**.
5. **Interactivity & Shortcuts → Enable.** Paste the **Interactivity URL** and
   **Save**.
6. **Test.** DM the bot. For channels: `/invite @asyncify-agent`, then
   @mention it.
7. **Routing (optional).** Add a rule in the dashboard **Routes** modal to
   send a specific Slack channel to a specific agent (see below).

### Which messages the bot answers

Slack only delivers channel messages for channels the bot is a **member** of,
so surface behavior depends on where the message lives:

- **DMs to the bot** are **always** answered.
- **In a channel the bot has been `/invite`-d to:** a thread starts when the
  bot is **@mentioned**. Once a thread exists, the bot follows every reply in
  it **without further mentions**. Top-level messages that don't mention the
  bot are **ignored**.
- **In a channel the bot is not a member of:** nothing — Slack never delivers
  those messages.

### Per-channel routing rules (the switchboard)

A single Slack connection can route different channels to different agents.
Rules map a **Slack channel id** (`C…` public / `G…` private) → a specific
agent. Anything unmatched — other channels **and all DMs** — falls through to
the connection's default "answered by" agent.

| Method & path | Purpose |
|---|---|
| `GET /v1/connections/:id/routes` | list the routing rules on a Slack connection |
| `PUT /v1/connections/:id/routes` | add/update a rule `{scopeKey, agentIdentifier}` |
| `DELETE /v1/connections/:id/routes` | remove a rule |

On the dashboard, use the **Routes** button on the Slack connection's row.
**Finding a channel id:** open the channel → **About** tab → it's at the very
bottom.

### Buttons

When an agent replies with buttons (`present_buttons`), they render as native
**Block Kit** buttons in Slack. A click posts back, the original message
updates in place to **"✓ &lt;choice&gt;"**, and the agent continues the turn.

### Edit / delete parity

- **Editing** your Slack message updates the transcript in place — it does
  **not** trigger a re-answer.
- **Deleting** your Slack message **tombstones** the transcript row.
- When an operator deletes an **agent reply** from the dashboard, it's removed
  from Slack too (`chat.delete` — no time window).

### Limitation: no typing indicator

There is **no typing indicator** on Slack. The platform exposes no general
typing API for bots, so — unlike Telegram/email/widget — a Slack agent can't
show "typing…". This is a documented platform limitation, not a bug.

### Re-point and upsert (same as every channel)

Connecting the **same workspace** (matched on `teamId`) again is an
**upsert** — it refreshes the sealed token/secret **in place** and keeps the
connection id and both URLs **stable** (no re-paste in Slack). `PATCH
/v1/connections/:id {agentIdentifier}` re-points the connection's **default**
agent and moves all conversations with their history, exactly like Telegram
and email. Per-channel routes are unaffected by a re-point.

### Slack backlog notes

- **Identity linking is automatic on Slack.** The `link-token` deep-link flow
  is **Telegram-only** for now. On Slack, users are matched to subscribers by
  **email** automatically (this is why the manifest requests
  `users:read.email`; grant it so the match works).
- **OAuth distribution (13b) is planned.** The full "Add to Slack" one-click
  install will replace the manual token paste; the token-paste path above is
  what ships today.

### Smoke test

1. **DM** the bot → answered.
2. **@mention** it in an invited channel → a **thread** starts.
3. **Reply in that thread** without mentioning → still answered.
4. **Top-level unmentioned** channel message → **silent**.
5. Agent **button** click → message updates to **"✓ …"**, agent continues.
6. **Edit** your message → transcript reflects the edit, no re-answer.
7. **Delete** your message → the row is **tombstoned**.

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
