# @asyncify-hq/cli

## 0.2.0

### Minor Changes

- 0c5a812: `asyncify dev` now auto-updates a Slack app's Event/Interactivity URLs on tunnel rotation when the connection holds a config refresh chain, with a graceful paste-table fallback for legacy or expired connections.

## 0.1.0

### Minor Changes

- 4f3eab5: First release: `asyncify dev` (managed cloudflared tunnel with automatic PUBLIC_URL rotation and webhook rewiring) and `asyncify create-agent` (bridge-agent starter scaffolder).
