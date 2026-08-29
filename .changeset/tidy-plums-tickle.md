---
'@asyncify-hq/cli': minor
---

`asyncify dev` now decides a new tunnel address is live by asking a public DNS
server (1.1.1.1, falling back to 8.8.8.8) and calling `/health` straight at that
IP, instead of trusting your own machine's DNS — which on some networks lags
minutes behind and made the check fail on tunnels the rest of the internet could
already reach. It waits up to five minutes (was one), prints a line whenever
something changes, takes a new `--wait <seconds>` flag (or `$ASYNCIFY_WAIT`), and
tells you when webhooks are live but your own machine still cannot look the
address up. If no public resolver is reachable, it falls back to the previous
behaviour and says so.
