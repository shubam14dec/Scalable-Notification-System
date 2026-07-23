---
'@asyncify-hq/node': minor
---

Add `agents.knowledge` for per-agent knowledge sources: `list`, `create({ name, kind, text? | url? })`, `reindex`, and `remove`. Sources are chunked and embedded so a managed agent can ground its answers and cite them; poll `list` until a source is `ready`.
