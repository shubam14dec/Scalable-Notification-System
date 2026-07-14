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

**Runtime public URL (no restart).** `PUBLIC_URL` is only the **boot
fallback**. At runtime an authed ops endpoint — and the CLI below, which
calls it for you — **overrides** it across both the API and the worker with a
**~5s propagation bound**, no restart. Validation accepts an `http(s)` base
URL only (no path or query).

```bash
# Set the runtime public URL (instantly, across api + worker).
curl -X PUT -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/ops/public-url \
  -d '{"url":"https://random-words.trycloudflare.com"}'

# Read the value in force and where it came from.
curl -H "x-api-key: $API_KEY" \
  https://api.asyncify.org/v1/ops/public-url
# → { "url":"https://random-words.trycloudflare.com", "source":"runtime" }
```

`source` is `runtime` once the ops endpoint has set a value, or `env` while
the value is still the `PUBLIC_URL` boot fallback.

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
live), the providers still hold the **old** webhook URLs. The CLI rewires
everything for you; the manual fallback below does the same by hand.

### The one-liner (recommended)

```bash
npx @asyncify-hq/cli dev
```

This spawns a cloudflared quick tunnel and then, with **zero restarts and
zero clicks**, automatically:

1. **Sets the runtime public URL** via the ops endpoint — it propagates to
   the api and worker in ~5s, **no restart** — and rewrites the `PUBLIC_URL`
   line in your `.env`.
2. **Re-registers every active Telegram webhook** in the tenant.

Steps 1–2 are the channels that *can* be pushed programmatically, so they're
automatic — as is Slack for **quick-setup connections that stored a refresh
token** (their URLs auto-update; see [URL rotation](#url-rotation)). For what's
left — email always, and Slack for legacy/manual connections — the CLI prints a
**paste table** with a **●** marking only the rows that **changed** since the
last rotation. Paste **just the ●-marked rows** into the provider config (the
manual steps below say exactly where each goes); unmarked rows are already
correct.

It then **watches the tunnel**, health-checking through it every 20s; when
the tunnel dies or sleeps it **respawns and re-runs the whole rewire
automatically**. Requires `cloudflared` installed.

Flags: `--port 3000`, `--api-url <url>`, `--api-key <key>` (or the
`ASYNCIFY_API_KEY` env var), and `--no-env-write` to leave `.env` untouched.

### Manual fallback

The CLI is the fast path; this is the identical rewire done by hand, and it
still works. Fix each channel from the **Connections** page:

1. **Point the runtime public URL at the new value** — either
   `PUT /v1/ops/public-url {url}` (propagates in ~5s, no restart; see the
   *Runtime public URL* note above) or deploy / restart with the new
   `PUBLIC_URL` (e.g. `PUBLIC_URL=https://api.asyncify.org`).
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
4. **Slack — re-paste the two URLs per connection** *unless it auto-updates*.
   A **quick-setup connection with a stored refresh token** rewrites its own
   Slack URLs on `reconnect` — nothing to paste (see
   [URL rotation](#url-rotation)). For legacy/manual connections the Events and
   Interactivity URLs derive from `PUBLIC_URL`, so a change moves them: copy the
   current pair from the Slack connection row and paste them back into the Slack
   app config → *Event Subscriptions* (wait for **Verified**) and *Interactivity
   & Shortcuts*. The bot token and signing secret are unchanged. (This only
   applies to a real `PUBLIC_URL` change — an upsert or re-point keeps the URLs
   stable.)

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

## Telegram

Create a bot with **@BotFather** (`/newbot`) and connect it on **Dashboard →
Connections → Connect → Telegram**. Two conveniences in the connect form:

- **Paste the whole message.** Drop BotFather's entire *"Done! Congratulations…"*
  reply into the box — we extract the `<digits>:<letters>` token and show
  **token detected ✔**. Two different tokens in one paste are flagged
  (*"multiple tokens found — paste just one"*); a bare token works too. On
  **Connect** we validate the token, register the webhook, and route the bot to
  the chosen agent. (API: `POST /v1/connections/telegram {botToken,
  agentIdentifier}`.)
- **Set up from your phone.** No bot yet, or BotFather only open on your phone?
  Press **Set up from your phone**: the dashboard mints a **single-use,
  5-minute** handoff and shows it as a **QR**. Scan it and a minimal paste page
  — served through your tunnel at `{PUBLIC_URL}/handoff/<token>` — asks for
  BotFather's message on the phone. Paste there; the token flows back and
  **autofills the desktop form exactly once**. The page carries no tenant data,
  the token is stored hashed (the plaintext lives only in the QR), and the
  paste endpoint is rate-limited per IP. A live QR counts down to expiry; an
  expired one offers a **New QR**.

## Slack

Slack is the fourth agent channel. Unlike Telegram (one bot) or email (one
address), a Slack connection owns a **whole workspace** and can fan out to
**many agents** through per-channel routing rules — the switchboard payoff.

Two ways to connect, both on **Dashboard → Connections → Connect → Slack**:

- **Quick Setup** (recommended) — paste an *App Configuration Token* and we
  create the Slack app, wire its scopes / event / interactivity URLs, and hand
  you an OAuth **Install** button. No manifest copy-paste, no URL paste-back.
- **Manual** (the trust path) — create the app yourself from a prefilled
  manifest, install it, and paste the bot token + signing secret back. Use
  this when you'd rather not hand us a config token.

(Full OAuth "Add to Slack" *distribution* — installing one app across many
customer workspaces — is still planned; see the backlog note at the end.)

### Quick Setup (recommended)

1. **Generate an App Configuration Token.** api.slack.com/apps → the **App
   Configuration Tokens** section at the bottom → generate. It **lasts 12
   hours**; generate a fresh one if it's expired. *Optionally* also copy the
   **refresh token** next to it — storing it lets us keep the app's webhook
   URLs current automatically when your tunnel rotates (see
   [URL rotation](#url-rotation)).
2. **Connect → Slack → Quick setup.** Paste the config token (and the refresh
   token if you have one), choose the **default agent** ("answered by"), and
   **Create Slack app**. We POST a manifest to `apps.manifest.create`, so the
   app is born with the right scopes, bot events, and *our* webhook URLs
   already set — the connection is created **pending**.
   (API: `POST /v1/connections/slack/quick-setup {configToken,
   configRefreshToken?, agentIdentifier}` → `201 {connectionId, installUrl,
   eventsUrl, interactivityUrl}`.)
3. **Install to workspace.** Press it; Slack's **consent screen** opens
   requesting the **14 bot scopes** (`app_mentions:read` + read/history on
   channels, groups, im and mpim + `chat:write` + `users:read` +
   `users:read.email` — powers slack→email subscriber auto-match; without
   it users.info returns no email and matching silently degrades — and
   `assistant:write`, which enables the agent's suggested-prompts view).
   Authorize.
   The OAuth callback flips the connection **active** and captures the
   workspace's team + Slack app id.
4. **Watch it connect.** The panel shows **"Listening…"** and polls until the
   connection goes active, then flips to **"✔ Connected"** and displays the
   Events / Interactivity URLs *for reference* — you don't paste them, they
   were baked into the app at creation.
   You can't strand the flow: if the modal (or the whole browser) closes
   before you install, the connections table keeps a persistent **Install to
   workspace** action on the pending Slack row ("app created — awaiting
   workspace install") — pick it up from there any time.
5. **Test.** DM the bot. For channels: `/invite @<bot>`, then @mention it.
6. **Routing (optional).** Add a rule in the dashboard **Routes** modal to
   send a specific Slack channel to a specific agent (see below).

If the config token is stale, quick-setup returns **400** — *"slack config
token invalid or expired — tokens last 12 hours; generate a fresh one"* — the
fix is a fresh token. A manifest Slack rejects comes back **400** with
`code: invalid_manifest` and the offending pointer.

### Manual (paste a bot token)

The trust path — you create and install the app yourself; we never see a
config token.

1. **Connect → Slack → Manual.** Choose the **default agent**. The form offers
   **Open prefilled manifest** (opens api.slack.com/apps with the manifest
   pre-loaded) and **Show manifest** (view the exact YAML inline). The
   manifest's two `request_url`s carry a `pending` placeholder — the real URLs
   come back after you connect.
   (API: `GET /v1/connections/slack/manifest-preview?agentIdentifier=…` →
   `{yaml, prefillUrl}`.)
2. **Create the app** from that manifest (ignore Slack's unverified-URL
   warning), **Install to Workspace**, then copy the **Bot User OAuth Token**
   (`xoxb-…`) from *OAuth & Permissions* and the **Signing Secret** from
   *Basic Information*.
3. **Paste both secrets** back in the Manual form and **Connect Slack**. The
   success panel returns the **Events URL** and **Interactivity URL** — copy
   both.
   (API: `POST /v1/connections/slack {botToken, signingSecret,
   agentIdentifier}` → `201 {channel, teamName, eventsUrl, interactivityUrl}`.)
4. **Slack app config → Event Subscriptions → Enable.** Paste the **Events
   URL**, wait for **Verified** (Slack fires a `url_verification` challenge —
   a green *Verified* also proves your signing secret was pasted correctly),
   confirm the bot events are subscribed, and **Save**.
5. **Interactivity & Shortcuts → Enable.** Paste the **Interactivity URL** and
   **Save**.
6. **Test.** DM the bot. For channels: `/invite @<bot>`, then @mention it.
7. **Routing (optional).** Add a rule in the dashboard **Routes** modal to
   send a specific Slack channel to a specific agent (see below).

### URL rotation

The webhook URLs (Events + Interactivity) derive from `PUBLIC_URL`, so a tunnel
rotation moves them. What you paste depends on whether the connection can
update *itself*:

- **Quick-setup connection with a stored refresh token** (the row shows
  **URL auto-update: on**): `asyncify dev` — or `POST
  /v1/connections/:id/reconnect` — **rotates the config token and pushes a
  fresh manifest**, so the Slack app's URLs update themselves. **Zero pastes**;
  the CLI paste table omits these Slack rows. This covers **pending**
  connections too: an app created but not yet installed keeps its event,
  interactivity **and OAuth redirect** URLs current across rotations, so the
  install works whenever you get to it.
- **Legacy / manual connections, or a broken refresh chain:** no auto-update,
  so the CLI paste table lists the Slack row and you re-paste both URLs into
  the Slack app config (Event Subscriptions + Interactivity).

**Re-arming a broken chain.** A dead refresh token flips the row to
**`broken`** ("Config refresh token expired"). To recover: generate a fresh
token pair on api.slack.com, then on the Connections page open the Slack row's
**View URLs** section, paste the new **refresh** token, and press **Re-arm**.
(API: `PUT /v1/connections/:id/slack/config-token {configRefreshToken}`.) It
validates the token by spending it once via rotate, persists the successor,
**heals the app's URLs to the current public URL immediately**, and flips
auto-update back **on**. If the rotate succeeds but the manifest push fails
(502), the chain is still restored — do **not** re-paste the same token (it's
spent); the URLs heal on the next rotation. The same field appears on healthy
rows as a quiet *"re-arm auto-update"* action — pasting a fresh token any time
is legitimate.

**The single-use-chain gotcha:** config refresh tokens are spent on first use
(each rotation stores a successor), so always generate a **fresh pair** per
setup and **re-arm** if the chain ever dies — a reused or lost token can't be
revived.

An upsert or re-point never changes the URLs — only a real `PUBLIC_URL` change
does.

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

### Buttons and cards

When an agent replies with buttons (`present_buttons`), they render as native
**Block Kit** buttons in Slack. A click posts back, the original message
updates in place to **"✓ &lt;choice&gt;"**, and the agent continues the turn.

A reply can instead carry a **card** — a `static_select` menu or a
`plain_text_input` field (see [Cards and plan cards](#cards-and-plan-cards)).
**Caveat:** in-message input blocks are a **newer Slack surface**; if a
workspace rejects them the platform **automatically degrades** that reply to
plain prose (numbered options / "reply with your answer") — nothing breaks
and no action is needed. `static_select` menus are broadly supported.

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
- **OAuth *distribution* (13b) is planned.** Quick Setup already uses OAuth to
  install an app **we create for you** into **your own** workspace. What's
  still planned is the full "Add to Slack" flow that installs **one** app
  across **many** customer workspaces from a public listing; today the two
  paths are Quick Setup and the manual token paste.

### Smoke test

1. **DM** the bot → answered.
2. **@mention** it in an invited channel → a **thread** starts.
3. **Reply in that thread** without mentioning → still answered.
4. **Top-level unmentioned** channel message → **silent**.
5. Agent **button** click → message updates to **"✓ …"**, agent continues.
6. **Edit** your message → transcript reflects the edit, no re-answer.
7. **Delete** your message → the row is **tombstoned**.

## Welcome messages & suggested prompts

An agent can **speak first**. Give it a **welcome message** and a set of
**suggested prompts** (starter chips) — per agent, on the dashboard **Agents**
form or via the API:

```bash
curl -X PATCH -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/agents/support-bot \
  -d '{
    "welcomeMessage": "Hi! I can help track an order or start a return. What do you need?",
    "suggestedPrompts": [
      { "title": "Track my order",  "message": "Where is my order?" },
      { "title": "Start a return",  "message": "I want to return an item." }
    ]
  }'
```

Each prompt is a **`title`** (the chip label) and a **`message`** (the turn the
chip sends). **Bounds:** `welcomeMessage` ≤ **2000** chars; **≤6** prompts, each
`title` ≤ **40** and `message` ≤ **200**. Send `null` to clear a field; omit it
to leave it untouched.

Where each surface shows them:

- **Widget** — while a conversation is **empty**, the widget renders the welcome
  as a greeting bubble and the prompts as tappable chips (tapping one sends its
  `message` as the user's first turn). **Nothing is stored until the user
  acts** — the greeting and chips come from the agent config the
  `GET /v1/agents/:identifier/conversation` response carries even when the
  conversation is still `null`.
- **Telegram** — a bare **`/start`** gets the welcome message (delivered as a
  normal agent reply) with the prompts as an **inline keyboard**, instead of a
  model turn. Every `/start` press re-greets (Telegram's convention); the
  dedupe keys on the update, so only Telegram's delivery retries are suppressed.
  Tapping a chip flows through the normal action pipeline. (Welcome unset →
  `/start` behaves exactly as before.)
- **Slack** — **two surfaces.** (1) The **first DM** a user opens with the bot
  gets the welcome message posted as a real message, with the prompts as **Block
  Kit buttons**; it's deduped **once per DM** (the analog of the widget bubble),
  and the user's own message still runs the model. (2) The prompts *also* ride
  the manifest's **`agent_view`** (Slack's native suggested-prompts surface in
  the assistant pane) — this needs the `assistant:write` scope and takes the
  **first 4**; it applies to apps built via **Quick Setup** or the **prefilled
  manifest** and refreshes on `reconnect`. Existing apps must **re-install** to
  pick up the scope. DM greetings fire only in DMs, never in shared channels.
- **Email** — no first-contact surface (there is no "open" / `/start` event to
  hang a greeting on).

## Cards and plan cards

Buttons (`present_buttons`) are no longer the only interactive element an
agent reply can carry. A reply may also carry a **card** — a single
structured input rendered natively per channel. The rule is **one
interactive element per reply**: a reply carries **buttons OR a card, never
both**. For managed agents the **last presentation tool call wins**, so a
turn that calls `present_choices` after `present_buttons` ships the card.

### The two card types

A card is exactly one of:

- **Single-select** — `{type:'select', id, prompt?, options:[{id,label}]}`,
  with **2–25** options. The user picks one.
- **Text input** — `{type:'text_input', id, prompt?, placeholder?}`, where
  `placeholder` is **≤64** chars. The user types free text (**≤3000** chars).

Three ways to attach one, all carrying the same card shape:

- **Bridge agents:** `ctx.reply(text, {card})`.
- **Managed agents:** the `present_choices` tool (select) and the
  `request_input` tool (text input) — the platform builds the card for you.
- **Push API:** the `card` field on the reply body.

### Answers come back as `action` events

A card answer arrives as the **same `action` event** buttons already use —
there is no new event type:

```
action: { id, label, value? }
```

- **Select:** `value` holds the **chosen option id**; `label` is its label.
- **Text input:** `value` holds the **typed text** (≤3000 chars).

Managed agents see the answer folded into the next turn as
`[user clicked: …]` (select) or `[user entered: …]` (text input), so a
prompt reacts to it exactly as it reacts to a button click.

### Per-channel rendering matrix

| Channel | Select card | Text-input card | Answer capture |
|---|---|---|---|
| **widget** | native dropdown under the reply | native input field under the reply | structured; active **only while the reply is the latest message** |
| **slack** | `static_select` in an actions block | `plain_text_input` in an input block (dispatches on **Enter**) | structured; degrades to prose if the workspace rejects input blocks — see caveat |
| **telegram** | inline keyboard, **one option per row** | `ForceReply` prompt (shows the placeholder) | structured **only via Telegram's reply affordance** — see reply-to contract |
| **email** | numbered options in prose | prompt + `(e.g. placeholder)` in prose | **none** — email replies are normal turns, no structured capture |

**Telegram reply-to contract (tell your end users).** A Telegram text-input
card is a `ForceReply` prompt, and the user **must** answer using Telegram's
**reply** affordance (the swipe / quoted-reply UI) so the platform can tie
the text back to the card. A plain, non-reply message is treated as a
**normal conversational turn** and the card **quietly expires** — the typed
text is not captured as the card's answer. Select cards (inline keyboards)
have no such constraint: tapping an option always registers.

**Slack input-block degradation caveat.** In-message `plain_text_input`
blocks are a **newer Slack surface**. If a workspace rejects them, the
platform **automatically degrades** that reply to plain prose (numbered
options / "reply with your answer") — **no action is needed**, and nothing
is lost but the native widget. `static_select` menus are broadly supported
and don't hit this path.

### Plan cards (live "working…" streaming)

When a **managed** agent's turn **calls tools** (`trigger_workflow`,
`set_metadata`, …), it doesn't sit silent until the work finishes. It posts
a single **"working…"** message that **edits itself live** as the steps run
— `⏳ Triggering order-shipped…` → `✓` — and the **final edit becomes the
reply**. One message, edited in place; never a stream of separate posts.

- **Where it applies:** managed agents on **widget, Telegram, and Slack**.
  **Not** email (replies are normal turns) and **not** bridge agents (they
  own their own output).
- **Zero configuration.** It's automatic. A turn that calls **no** tools
  behaves exactly as before — one reply, no "working…" message.
- **The step lines are the platform's, not the model's.** Each line comes
  from the platform's **tool label**, so the visible progress is backed by
  the **same breadcrumb audit trail** operators see in the dashboard — the
  model can't invent a step that didn't run.
- **Throttled ≥1s.** Edits are paced at least one second apart to stay under
  channel rate limits.
- **Crash-safe.** If the worker dies mid-turn, the retry **resumes editing
  the same message** — no duplicate "working…" posts.

## End-user linking (connect buttons)

Everything above is the **operator's** view — you connect a bot or workspace
in your own dashboard. This section is the **end-user's** view: your customers
embed a widget in *their* product so *their* users link their own Telegram or
Slack account and start receiving agent conversations there. Nobody touches
your dashboard, and no API key ever reaches a browser.

### The `<ConnectChannels />` component

Drop the component in from [`@asyncify-hq/react`](../packages/react):

```tsx
import { ConnectChannels } from '@asyncify-hq/react';

<ConnectChannels
  token={subscriberToken}                 // minted by YOUR backend, per user
  apiUrl="https://api.asyncify.org"
/>
```

It renders one row per channel: **Telegram** and **Slack** show a
**Connect** button (and, once linked, the linked handle plus an **Unlink**
control); **email** shows as already linked and read-only (see the email
note below). Clicking **Connect** mints a link token and sends the user into
the normal handshake — the Telegram deep link or the Slack DM redirect.

**Desktop → phone QR (Telegram).** The Telegram row also offers an **"or scan
with your phone"** toggle that renders the minted deep link as a **QR code**. A
desktop user — for whom the `t.me` **Connect** button would try to hand off to a
Telegram app that isn't installed — scans it with their phone instead, opening
the bot there to press **Start**. Slack rows have no QR: their `app_redirect`
link already opens the native app.

**Manual fallback (`/start` command).** Under the QR — and after a **Connect**
click — the widget shows a copyable **`/start <token>`** command with the bot's
@handle: some ISPs DNS-block `t.me`, but the Telegram app itself is unaffected,
so messaging the bot directly and sending that command completes the link
in-app. One click selects the whole command.

**Where `subscriberToken` comes from.** The token **is** the user's identity,
so it must be minted server-side and handed to the browser — **never** put an
API key in front-end code. Your backend calls
`POST /v1/subscriber-tokens` (an `x-api-key` admin route) for the signed-in
user and returns the short-lived token to your page. The component then talks
to the `/v1/me/*` routes below using that token and nothing else.

### The `/v1/me` API (for custom UIs)

If you're building your own linking UI instead of using the component, drive
these three routes directly. **Auth is `x-subscriber-token` only** — the
token carries the subscriber identity, so there are **no `subscriberId`
parameters anywhere**, and an **API key is rejected** on these routes. A user
can only ever see and touch their own identities.

| Method & path | Purpose |
|---|---|
| `GET /v1/me/channels` | merged listing of the caller's channels + linked identities |
| `POST /v1/me/link-tokens` | mint a link token `{connectionId}` to start a Telegram/Slack link |
| `DELETE /v1/me/identities` | unlink one of the caller's own identities `{channel, externalKey}` |

**`GET /v1/me/channels`** returns one row per linkable channel, merged across
the tenant's connections:

```json
{
  "channels": [
    { "connectionId": "conn_abc123", "channel": "telegram", "label": "Support bot",
      "linked": true,
      "identities": [ { "externalKey": "882410", "linkedAt": "2026-07-10T12:00:00Z" } ] },
    { "connectionId": "conn_def456", "channel": "slack", "label": "Acme workspace",
      "linked": false, "identities": [] },
    { "connectionId": null, "channel": "email", "label": "you@example.com",
      "linked": true,
      "identities": [ { "externalKey": "you@example.com", "linkedAt": "2026-07-01T09:00:00Z" } ] }
  ]
}
```

Email rows are **display-only**: their `connectionId` is `null` because email
identities are linked **automatically server-side** (an inbound email is
matched to the subscriber by address), so there is no connect button to press.

**`POST /v1/me/link-tokens {connectionId}`** returns the action that starts
the handshake for that connection's channel:

```json
{ "kind": "telegram_deeplink", "url": "https://t.me/support_bot?start=lt_…", "expiresAt": "…" }
```

- **Telegram** → `kind: "telegram_deeplink"`: a **single-use, 24h** deep link
  into the existing `/start` handshake. The user taps it, Telegram opens the
  bot, and pressing **Start** completes the link.
- **Slack** → `kind: "slack_redirect"`: an **`app_redirect`** URL that opens
  the bot's DM in the user's Slack. Their **first message** in that DM
  auto-links via the workspace email match (the same
  `users:read.email` mechanism the operator flow relies on).

**`DELETE /v1/me/identities {channel, externalKey}`** unlinks one identity and
returns `{ "deleted": true }`. It only ever affects the **caller's own**
identities; asking to delete a foreign or unknown identity returns
`{ "deleted": false }` — the two cases are **deliberately
indistinguishable**, so a caller can't probe whether some other identity
exists.

### Curl (end-user token, never an API key)

```bash
# List the caller's channels and linked identities.
curl -H "x-subscriber-token: $SUBSCRIBER_TOKEN" \
  https://api.asyncify.org/v1/me/channels

# Start a Telegram (or Slack) link for one connection.
curl -X POST -H "x-subscriber-token: $SUBSCRIBER_TOKEN" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/me/link-tokens \
  -d '{"connectionId":"conn_abc123"}'
# → { "kind":"telegram_deeplink", "url":"https://t.me/support_bot?start=lt_…", "expiresAt":"…" }

# Unlink one of your own identities.
curl -X DELETE -H "x-subscriber-token: $SUBSCRIBER_TOKEN" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/me/identities \
  -d '{"channel":"telegram","externalKey":"882410"}'
# → { "deleted": true }
```

### Slack app id (needed for the redirect)

The `slack_redirect` URL needs the workspace's **Slack app id**. It's
**captured automatically at connect**, and **lazily backfilled on first use**
for workspaces that were connected before this feature existed — so it just
works. If the app id can't be determined, `POST /v1/me/link-tokens` returns
**`502` with `reconnect the workspace`**; reconnecting that workspace from the
**Connections** page (an upsert — no re-paste in Slack) records the app id and
fixes it. A desktop-only `slack://` deep link exists as a documented
alternative but is **not shipped** — it silently no-ops on mobile and web, so
the `app_redirect` URL is the one path that works everywhere.

### Email is intentionally not unlinkable from the widget

Email rows are display-only and the component offers **no** email unlink. You
*can* call `DELETE /v1/me/identities {channel:"email", …}` and it will report
`deleted: true`, but the **next inbound email from that address re-links it
automatically** — so an unlink button would be a lie. The auto-link is the
feature, not a gap; the widget just doesn't pretend otherwise.

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
