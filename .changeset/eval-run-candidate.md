---
'@asyncify-hq/node': patch
---

Eval runs can now grade an unsaved config. `agents.evals.run()` takes an optional `candidate: { systemPrompt?, model? }` — the run uses the real agent, tools, guardrails and knowledge with only the prompt and/or model swapped in, so you can check an edit before it is saved (what the dashboard's pre-save check does). Managed agents only; a candidate on a bridge agent is a 400. The agent is never written to, and a run started with a candidate carries it back on `AgentEvalRun.candidate`. Types only, and additive: a run without a candidate returns exactly the shape it did before.
