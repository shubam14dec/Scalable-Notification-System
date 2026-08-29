# @asyncify-hq/cli

Dev tooling for [Asyncify](https://asyncify.org) agents. Two commands, zero
runtime dependencies:

- **`asyncify dev`** — runs a managed [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)
  tunnel, publishes its public URL to your local Asyncify stack, rewires every
  channel webhook, and keeps the tunnel healthy — auto-rotating and re-wiring
  when cloudflared drops.
- **`asyncify create-agent <dir>`** — scaffolds a runnable bridge-agent starter.

```bash
npx @asyncify-hq/cli dev
npx @asyncify-hq/cli create-agent my-bot
```

## `asyncify dev`

```bash
asyncify dev [--port 3000] [--api-url http://localhost:3000] [--api-key <key>] [--wait 300] [--no-env-write]
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--port` | `3000` | Local port your Asyncify stack listens on (tunnel target). |
| `--api-url` | `http://localhost:3000` | Asyncify API base URL. |
| `--api-key` | `$ASYNCIFY_API_KEY`, else the dev seed `dev-api-key-123` | Tenant API key. |
| `--wait` | `$ASYNCIFY_WAIT`, else `300` | Seconds to wait for the new tunnel address to go live (5–3600). |
| `--no-env-write` | off | Do not rewrite `PUBLIC_URL` in `./.env`. |

When the dev seed key is used (no env var, no flag), `dev` prints a notice so
you know which tenant you are targeting.

### Waiting for the address to go live

A brand-new tunnel address does not exist in DNS the moment cloudflared prints
it. Registering it with Telegram too early makes Telegram cache "no such host"
for minutes, so `dev` waits until the tunnel answers `/health` **from the public
internet's point of view**: it looks the address up on a public resolver
(`1.1.1.1`, falling back to `8.8.8.8`) and then calls `/health` straight at that
IP. Your own machine's DNS is deliberately not the judge — on some networks it
is minutes behind, which used to fail the check on tunnels the rest of the world
could already reach. If no public resolver is reachable at all (some corporate
networks block it), `dev` says so and falls back to a normal request.

It waits up to five minutes by default and prints a line whenever something
changes; raise it with `--wait 600` on a slow network. Once webhooks are live,
`dev` warns you if *your* machine still cannot look the address up — the browser
failing to open the URL then means your network is catching up, not that the
tunnel is down.

### What it automates

- Publishes the tunnel URL via `PUT /v1/ops/public-url`.
- Updates `PUBLIC_URL` in `./.env` (if the file exists; skip with `--no-env-write`).
- **Telegram**: reconnects each active connection automatically and verifies
  the new webhook took (one retry if Telegram reports a stale URL).
- Health-checks the tunnel every 20s (through the same public-resolver path) and
  **rotates** it on failure (3 strikes) or if cloudflared exits — re-running the
  full rewire against the new URL.

### What still needs a human paste

Slack and email webhooks live in third-party consoles, so `dev` prints a table
of the exact URLs and where to paste them (● marks a row that changed since the
last run):

- **Slack Events** → Slack app config → Event Subscriptions → Request URL.
- **Slack Interactivity** → Slack app config → Interactivity & Shortcuts → Request URL.
- **Email** → Postmark → Servers → Default Inbound Stream → Settings → Webhook.

### Prerequisite

`cloudflared` must be on PATH. `dev` checks at startup and prints install
instructions (winget / brew / apt) if it is missing.

## `asyncify create-agent`

```bash
asyncify create-agent my-bot [--identifier my-bot]
```

Scaffolds `package.json`, a self-registering `agent.ts`, `.env.example`,
`README.md`, and `.gitignore` into the target directory (which must be empty).
The agent registers itself with Asyncify on first run and serves a signed
bridge; edit `agent.ts` to build your brain.

`--identifier` defaults to the slugified directory basename (`[a-z0-9-]`).

> The scaffolded project runs with `tsx --env-file=.env`, which needs
> **Node >= 20.6**.

## Engines

Requires **Node >= 20.6**.
