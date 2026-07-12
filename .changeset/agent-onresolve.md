---
'@asyncify-hq/agent': minor
---

Adds `resolved` lifecycle events: `onResolve(ctx)` now fires when a conversation is resolved (by the agent, an operator, or the inactivity sweep), with a read-only ResolveContext carrying the conversation summary and metadata. Also fixes unknown event types incorrectly falling through to onMessage.
