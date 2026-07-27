---
'@asyncify-hq/node': minor
---

`conversations` status types widen to include the `waiting_human` and `human` handoff states — on `ConversationSummary`, the `list` status filter, and the `get` response — so consumers can filter for and read conversations a human teammate is currently handling.
