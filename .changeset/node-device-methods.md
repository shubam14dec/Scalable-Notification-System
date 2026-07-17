---
"@asyncify-hq/node": minor
---

subscribers.{registerDevice,listDevices,removeDevice} for multi-device push tokens (upsert by token, per-subscriber list, ownership-scoped removal); exports a Device type. WorkflowStep also gains an optional `push` field (clickUrl/imageUrl/data) so typed users can author rich push steps without casting.
