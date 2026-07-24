---
'@asyncify-hq/node': minor
---

Add `agents.memories` for per-customer long-term memory: `list`, `put({ key, value })`, and `remove` (one key, or the whole profile when the key is omitted). A subscriber is addressed by its external id; the durable facts an agent remembers about a customer — a preference, plan, or constraint — are loaded into every future conversation. Exports a `SubscriberMemory` type; enforced caps are ≤32 keys, key ≤64 chars, value ≤300 chars.
