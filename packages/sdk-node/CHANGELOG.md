# @asyncify-hq/node

## 0.8.6

### Patch Changes

- 5d5632a: Per-customer message limits are now typed on the client. `agents.update(id, { subscriberRate: { maxMessages, windowMinutes, notice } })` caps how many messages ONE end user may send an agent inside a fixed window; past the cap that person stops getting replies until the window ends and receives `notice` once — never on every message, because a limit that answered a flood would be an amplifier. Their messages still land in the conversation exactly as they sent them, so the transcript stays true; only the turn is skipped, and a blocked message costs no model call at all. Everyone else is unaffected, which is the difference from the daily token budget: that one goes quiet for every customer at once, so leaning on it against a single abusive user lets that user mute the agent for everybody. This is the one agent config that works on BOTH runtimes — it is ingress protection, not brain config, and a flood costs a bridge agent its own compute just as surely as it costs a managed agent tokens. `subscriberRate: null` switches it off and forgets the config, `Agent` gains the field the API now returns, and a config outside the bounds (`maxMessages` 1–1000, `windowMinutes` 1–1440, `notice` 1–2000) is rejected on save and read as OFF rather than clamped, since a limiter throttling at a number you never chose is worse than no limiter. There is deliberately no `candidate` override on an eval run: a scenario is a burst of messages from one synthetic subscriber by construction, so a gradeable message limit would throttle the check itself.

## 0.8.5

### Patch Changes

- 9bc828d: The two per-agent guardrails are now typed on the client. `agents.update(id, { topics: { deny, allow, redirect } })` decides what a managed agent will discuss: one small classifier call runs in front of the brain, names what the customer's message is about, and a message on a denied topic — or, when `allow` is non-empty, outside it — gets `redirect` back word for word without the brain ever running. `deny` beats `allow`, and a classifier that errors SKIPS the gate rather than blocking, since fail-closed would mute an agent's whole traffic behind one canned sentence. `agents.update(id, { moderation: { denyPhrases, blockPii, fallback } })` decides what may ship: every drafted reply is checked in-process — no model, no extra call, no added latency — against case-insensitive substring phrases and, with `blockPii`, against emails and phone numbers that are not the customer's own; a blocked reply is replaced by `fallback` with any buttons suppressed. It matches typed phrases, not paraphrases, which is the honest price of a check that cannot be down; and the fallback deserves care, because the turn's tools have already run by the time it ships — "a teammate will follow up" is safe where "I couldn't help" can be a lie. `null` switches either off and forgets its config, `Agent` gains both fields the API now returns, and `EvalRunCandidate` gains them too — with the deliberate asymmetry that omitting them leaves the AGENT'S gates in force for the run (a check grades the agent you have, boundaries included), so `null` is how you ask whether the evals still pass with a gate off. Managed agents only: a bridge agent answers 400.

## 0.8.4

### Patch Changes

- 71b5802: Cheap-first model routing is now typed on the client. `agents.update(id, { routing: { enabled, cheapModel } })` puts a managed agent's simple replies on a smaller model; the moment a routed turn reaches for a consequential tool — a workflow, one of your own tools, a knowledge lookup — the whole turn is discarded and re-run on the agent's main model, so a small model is trusted to talk and never to act. `cheapModel` must be an id your own LLM endpoint serves (routing rides the agent's key and base URL) and has no default; a wrong id is safe, since the failed cheap call just escalates. `routing: null` switches it off and forgets the config, and `Agent` gains the `routing` field the API now returns. `EvalRunCandidate` gains `routing` too, so a pre-save check can grade the router the operator is about to turn on — the run executes through it rather than merely recording it, and an explicit `null` grades the agent with routing off. Managed agents only: a bridge agent answers 400.

## 0.8.3

### Patch Changes

- 2a2b607: Prompt versioning and canary trials are now typed on the client. `agents.versions.list / get / restore` reads a managed agent's append-only prompt history — restore is a save, not a rewind: it publishes an old snapshot as a NEW version and reports both numbers. `agents.canary.start / stop / promote / report` trials a version on a percentage of real conversations (sticky per conversation) and returns the per-arm comparison: counters for both arms plus judged averages sampled from each at the same rate, as `CanaryReport` / `CanaryArmReport`. `Agent` gains the `promptVersion` and `canary` fields the API has been sending. Managed agents only; a bridge agent answers 400, and a second concurrent trial is a 409.
- 620a8d5: README now documents the `agents.evals` surface (present since 0.5.0 but previously undocumented): creating scenarios, running them, pre-save candidate runs, and reading `judged[]` verdicts — with the skipped-is-not-a-pass rule.

## 0.8.2

### Patch Changes

- aa68816: Eval runs can now grade an unsaved config. `agents.evals.run()` takes an optional `candidate: { systemPrompt?, model? }` — the run uses the real agent, tools, guardrails and knowledge with only the prompt and/or model swapped in, so you can check an edit before it is saved (what the dashboard's pre-save check does). Managed agents only; a candidate on a bridge agent is a 400. The agent is never written to, and a run started with a candidate carries it back on `AgentEvalRun.candidate`. Types only, and additive: a run without a candidate returns exactly the shape it did before.

## 0.8.1

### Patch Changes

- 340576a: Eval run results now include optional `judged[]` LLM-judge verdicts. A scenario whose `expect` blocks use `judge` (groundedness / tone / refusal) carries one `JudgeVerdictRecord` per graded dimension — `{ turn, dim, verdict, score?, rationale }` — alongside the existing `failures`. `verdict: 'skipped'` marks a dimension no judge client was available for, which is neither a pass nor a failure. Types only, and additive: a scenario that uses no judge returns exactly the shape it did before.

## 0.8.0

### Minor Changes

- 34479ca: `conversations` status types widen to include the `waiting_human` and `human` handoff states — on `ConversationSummary`, the `list` status filter, and the `get` response — so consumers can filter for and read conversations a human teammate is currently handling.

## 0.7.0

### Minor Changes

- c7ac2a8: Add `agents.memories` for per-customer long-term memory: `list`, `put({ key, value })`, and `remove` (one key, or the whole profile when the key is omitted). A subscriber is addressed by its external id; the durable facts an agent remembers about a customer — a preference, plan, or constraint — are loaded into every future conversation. Exports a `SubscriberMemory` type; enforced caps are ≤32 keys, key ≤64 chars, value ≤300 chars.

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
