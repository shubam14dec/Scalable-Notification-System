---
'@asyncify-hq/node': patch
---

Prompt versioning and canary trials are now typed on the client. `agents.versions.list / get / restore` reads a managed agent's append-only prompt history — restore is a save, not a rewind: it publishes an old snapshot as a NEW version and reports both numbers. `agents.canary.start / stop / promote / report` trials a version on a percentage of real conversations (sticky per conversation) and returns the per-arm comparison: counters for both arms plus judged averages sampled from each at the same rate, as `CanaryReport` / `CanaryArmReport`. `Agent` gains the `promptVersion` and `canary` fields the API has been sending. Managed agents only; a bridge agent answers 400, and a second concurrent trial is a 409.
