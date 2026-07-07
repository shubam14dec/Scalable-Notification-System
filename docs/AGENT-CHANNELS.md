# Agent channels: local dev → production

The conversation channels (Telegram, email) run the **same code path** in
dev and production — the only thing that changes is *how the internet
reaches your API*. Locally that's a tunnel; in production it's your real
domain. This page is the checklist for the switch.

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

## Switching checklist (do these in order)

1. **Deploy with `PUBLIC_URL=https://api.asyncify.org`** (or whatever the
   API's public domain is).
2. **Telegram — one click per agent.** Telegram still holds the OLD
   (tunnel) URL. Dashboard → Agents → *agent* → Channels → the modal
   shows *registered* vs *expected* URL mismatched — press
   **Re-register webhook**. (API equivalent:
   `POST /v1/agents/:identifier/channels/telegram/reconnect`.)
   Bot tokens and secrets are untouched.
3. **Email — re-paste one URL.** The Channels modal always displays the
   webhook URL derived from the *current* `PUBLIC_URL`. Copy it and paste
   it into Postmark → Servers → Default Inbound Stream → Settings →
   Webhook, replacing the tunnel one. Done — the connection, secret and
   address are unchanged.

That's the whole migration. No code, no schema, no reconnects that lose
history.

## When DNS for asyncify.org becomes available (custom email domain)

Today the agent receives mail on Postmark's hash address
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
4. Dashboard → agent → Channels → Email: update the address to
   `support@reply.asyncify.org` (disconnect → connect with the new
   address; the webhook URL it gives back is what stays in Postmark —
   re-paste if it changed).

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
- Replies always set `Reply-To` to the agent's inbound address, so the
  thread survives whatever the from address is.
- The suppression list applies to agent replies too: a bounced address
  gets a transcript breadcrumb instead of an email. That's intentional.

## Quick smoke test after any URL change

1. Channels modal: Telegram shows registered = expected; email webhook
   URL matches what's pasted in Postmark.
2. Message the bot / email the address.
3. `/activity` or the Conversations page shows the turn within seconds;
   if not, check the provider's delivery log first (Telegram:
   getWebhookInfo last error in the modal · Postmark: Activity → Inbound).
