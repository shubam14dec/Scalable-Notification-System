# @asyncify-hq/cli

## 0.3.0

### Minor Changes

- d4d36e3: `asyncify dev` now decides a new tunnel address is live by asking a public DNS
  server (1.1.1.1, falling back to 8.8.8.8) and calling `/health` straight at that
  IP, instead of trusting your own machine's DNS — which on some networks lags
  minutes behind and made the check fail on tunnels the rest of the internet could
  already reach. It waits up to five minutes (was one), prints a line whenever
  something changes, takes a new `--wait <seconds>` flag (or `$ASYNCIFY_WAIT`), and
  tells you when webhooks are live but your own machine still cannot look the
  address up. If no public resolver is reachable, it falls back to the previous
  behaviour and says so.

## 0.2.0

### Minor Changes

- 0c5a812: `asyncify dev` now auto-updates a Slack app's Event/Interactivity URLs on tunnel rotation when the connection holds a config refresh chain, with a graceful paste-table fallback for legacy or expired connections.

## 0.1.0

### Minor Changes

- 4f3eab5: First release: `asyncify dev` (managed cloudflared tunnel with automatic PUBLIC_URL rotation and webhook rewiring) and `asyncify create-agent` (bridge-agent starter scaffolder).
