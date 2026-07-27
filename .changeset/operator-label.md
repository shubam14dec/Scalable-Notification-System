---
'@asyncify-hq/react': minor
---

AgentChat renders a quiet "«name» · team" sender label above replies from a human teammate during a handoff, on both the live WebSocket and fetched-history paths. The conversation status type widens to the `waiting_human`/`human` handoff states (exported as `ConversationStatus`): the message input stays enabled so the customer keeps typing — now to the person — while the agent typing indicator is suppressed.
