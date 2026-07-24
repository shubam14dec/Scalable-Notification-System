# @asyncify-hq/node

## 0.6.0

### Minor Changes

- fab0f83: Add `agents.knowledge` for per-agent knowledge sources: `list`, `create({ name, kind, text? | url? })`, `reindex`, and `remove`. Sources are chunked and embedded so a managed agent can ground its answers and cite them; poll `list` until a source is `ready`.

## 0.5.0

### Minor Changes

- b1eb2a7: Add `agents.evals` for per-agent eval scenarios: `list`, `create`, `update`, `remove`, `run` (enqueues a run of the agent's enabled scenarios), `runs`, and `getRun` (poll for the pass/fail verdict per scenario).
- 03b9919: Add `agents.health(identifier, { days })` for rolling-window agent observability: turn/reply/note counts, turn latency (avg + p95), token averages, and per-tool call/failure tallies.

## 0.4.0

### Minor Changes

- 8cfbdc2: subscribers.{registerDevice,listDevices,removeDevice} for multi-device push tokens (upsert by token, per-subscriber list, ownership-scoped removal); exports a Device type. WorkflowStep also gains an optional `push` field (clickUrl/imageUrl/data) so typed users can author rich push steps without casting.

## 0.3.0

### Minor Changes

- 3319f55: Wrappers for agent tools (registry + rotate), approvals (list/decide), and approval channel settings.

## 0.2.1

### Patch Changes

- 5a38908: subscribers.unlink accepts slack identities (the server has supported unlinking slack channel identities since the Slack agent channel shipped).
