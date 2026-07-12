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
asyncify dev [--port 3000] [--api-url http://localhost:3000] [--api-key <key>] [--no-env-write]
```

| Flag | Default | Meaning |
|------|---------|---------|
| `--port` | `3000` | Local port your Asyncify stack listens on (tunnel target). |
| `--api-url` | `http://localhost:3000` | Asyncify API base URL. |
| `--api-key` | `$ASYNCIFY_API_KEY`, else the dev seed `dev-api-key-123` | Tenant API key. |
| `--no-env-write` | off | Do not rewrite `PUBLIC_URL` in `./.env`. |

When the dev seed key is used (no env var, no flag), `dev` prints a notice so
you know which tenant you are targeting.

### What it automates

- Publishes the tunnel URL via `PUT /v1/ops/public-url`.
- Updates `PUBLIC_URL` in `./.env` (if the file exists; skip with `--no-env-write`).
- **Telegram**: reconnects each active connection automatically and verifies
  the new webhook took (one retry if Telegram reports a stale URL).
- Health-checks the tunnel every 20s and **rotates** it on failure (3 strikes)
  or if cloudflared exits — re-running the full rewire against the new URL.

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
