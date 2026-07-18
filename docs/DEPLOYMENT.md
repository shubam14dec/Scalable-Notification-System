# Going to production — what replaces the tunnel

In development, `asyncify dev` borrows a public address (a cloudflare
quick tunnel) because a laptop doesn't have one. Every inbound webhook —
Telegram messages, Slack events, Postmark inbound email, Twilio delivery
receipts — POSTs to that borrowed address, and the CLI's watchdog re-wires
everything each time the address rotates.

Production runs **identical code with one variable different**: the
address is permanent, so the rotation machinery simply goes quiet.

```
DEV                                     PRODUCTION
Telegram / Slack / Postmark / Twilio    Telegram / Slack / Postmark / Twilio
        │ POST                                  │ POST
        ▼                                       ▼
https://<random>.trycloudflare.com      https://api.your-domain.com
        │  rotates hourly                       │  never changes
        ▼                                       ▼
laptop :3000                            api pods (same Fastify app)
```

## Deployment-day checklist

1. **DNS + TLS** — point a subdomain (e.g. `api.your-domain.com`) at the
   deployed API behind a TLS-terminating load balancer. The deployment
   artifacts already exist: `Dockerfile` and the Helm chart with KEDA
   autoscaling under `deploy/helm/notification-system/`.
   > Before the first deploy, re-verify the chart's env plumbing for
   > `PUBLIC_URL` — the chart predates the runtime-URL override below.
2. **Set the public URL once** — prefer the runtime endpoint over the
   env var:
   ```bash
   curl -X PUT https://api.your-domain.com/v1/ops/public-url \
     -H "x-api-key: <key>" -H "content-type: application/json" \
     -d '{"url":"https://api.your-domain.com"}'
   ```
   Every consumer (Telegram registration, Slack manifest URLs, email
   webhook, tracking pixel, Twilio per-message `StatusCallback`) reads
   this runtime value. A future domain migration is this same PUT again —
   connected channels re-wire with zero restarts.
3. **One-time webhook wiring** (then never again):
   - Telegram: re-register the webhook (Channels page button or the CLI's
     reconnect) so it points at the permanent URL.
   - Slack: manifest URLs update via the stored config token
     (auto-update), or re-paste once from the Channels page.
   - Email: re-paste the inbound webhook URL in Postmark once, and add
     the MX record for your reply domain — full steps in
     [AGENT-CHANNELS.md](AGENT-CHANNELS.md).
4. **Twilio needs nothing** — every SMS carries its own `StatusCallback`
   return address, stamped at send time from the runtime public URL.
5. `asyncify dev` remains a development tool for anyone building against
   the platform locally. Production never runs it.

## What does NOT change

Everything you verified locally — webhook signature checks, channel
routing, delivery receipts, agent bridges — is the same code path. The
tunnel was never a feature; it was a stand-in for DNS.
