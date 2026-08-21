---
'@asyncify-hq/node': patch
---

Eval run results now include optional `judged[]` LLM-judge verdicts. A scenario whose `expect` blocks use `judge` (groundedness / tone / refusal) carries one `JudgeVerdictRecord` per graded dimension — `{ turn, dim, verdict, score?, rationale }` — alongside the existing `failures`. `verdict: 'skipped'` marks a dimension no judge client was available for, which is neither a pass nor a failure. Types only, and additive: a scenario that uses no judge returns exactly the shape it did before.
