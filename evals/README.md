# Agent evals

Test your agent's prompt like you test your code.

A scenario file scripts a conversation as user turns plus **expectations about
tool calls** — not prose vibes. The harness drives an **existing** agent through
the real Asyncify API + worker, then asserts the tool-call trace each turn
actually produced.

```
npm run eval                 # run every evals/*.json
npm run eval -- refund-path  # run just evals/refund-path.json
```

The CLI works exactly as before. Under it, the engine now lives in
**`src/core/eval-runner.ts`**; `scripts/eval.ts` is a thin CLI wrapper over it.
The extraction lets a second caller share one implementation: the **per-agent
eval runner in the dashboard** (see below).

### Two homes for the same scenarios

The scenario format on this page is the same whether a scenario lives in a
`evals/*.json` file (run by `npm run eval`) or in an agent's **Evals** tab in the
dashboard (stored per agent, run by a button). The dashboard runner drives turns
in-process through the identical production pipeline and reads the same Postgres,
so the two paths assert on tool traces exactly the same way. The customer-facing
walkthrough — writing, running, the advisory save gate, and drafting an eval from
a real conversation in one click — is in
**[ASYNCIFY-AGENTS-GUIDE.md](../docs/ASYNCIFY-AGENTS-GUIDE.md)** ("Testing your
agent (evals)").

## What you need running

- **API** on `ASYNCIFY_API_URL` (default `http://localhost:3000`) — `npm run api`
- **Worker** — `npm run worker`. The API only *enqueues* a turn; the worker runs
  the brain. A turn that never gets a reply is reported as
  `no agent reply within 60s — is npm run worker running?`.
- The scenario's `agent` must already exist on the tenant behind
  `ASYNCIFY_API_KEY`. The harness never creates or edits agents — it drives what
  is there, so the agent's own configured LLM (or bridge) does the thinking.

Env:

| var | default | meaning |
|---|---|---|
| `ASYNCIFY_API_URL` | `http://localhost:3000` | drive path (POST turns) |
| `ASYNCIFY_API_KEY` | — (**required**) | tenant api key, e.g. `dev-api-key-123` |
| `ASYNCIFY_EVAL_NONCE` | `Date.now()` | run id; keeps subscriber ids unique |
| `DATABASE_URL` | dev default | used by the read path (see below) |

Each scenario run uses a fresh `subscriberId`
(`eval-<scenario>-<nonce>-a<attempt>`) so conversation history never bleeds
between runs or attempts.

## Scenario format (`evals/<name>.json`, zero-dep JSON)

```jsonc
{
  "agent": "support-demo",          // must exist on the tenant
  "description": "...",             // what this scenario proves
  "attempts": 2,                    // default 1; live LLMs are non-deterministic
  "skip": false,                    // optional; skipped scenarios never fail the run
  "comment": "...",                 // optional; why a scenario is skipped
  "turns": [
    { "user": "hi, my order #1042 never arrived" },
    { "expect": { "tool": "set_metadata" } },
    { "expect": { "tool": "present_choices", "inputContains": { "id": "order_action" } } },
    { "user": "I want a refund" },
    { "expect": { "noTool": "trigger_workflow" } },
    { "expect": { "replyContains": "24 hours" } }
  ]
}
```

A `user` turn is sent and then **polled** (up to 60s) until the agent's reply
for that turn lands. Every `expect` after it evaluates against **that turn's new
rows only** (everything after the inbound message). Expects fail fast within an
attempt; other scenarios keep running regardless.

### Attempts

Live turns are non-deterministic. A scenario passes if **any** of its `attempts`
passes; it fails only when it misses on **all** attempts. The table shows which
attempt won (`2/2` = passed on the 2nd of 2). `npm run eval` exits non-zero if
any non-skipped scenario failed all its attempts.

### Expect kinds

| expect | passes when |
|---|---|
| `tool: X` | a tool call `X` happened this turn |
| `tool: X` + `inputContains: {…}` | an `X` call whose input **superset-matches** the subset |
| `noTool: X` | `X` was **not** called this turn |
| `replyContains: "s"` | the turn's last agent reply includes `s` (case-insensitive) |
| `replyContainsAny: ["a","b"]` | the reply includes at least one |
| `replyNotContains: "s"` | the reply does **not** include `s` |
| `pendingApproval: X` | a gated tool `X` paused for human approval this turn |

`X` is any tool name the agent can call — a custom tool, a built-in
(`resolve_conversation`, `trigger_workflow`…), or a **built-in retrieval tool**.
So for a grounded agent, `{ "expect": { "tool": "search_knowledge" } }` asserts
it actually looked a policy question up before answering (that tool is offered
only once the agent has a `ready` knowledge source — see
[docs/AGENT-TOOLS.md](../docs/AGENT-TOOLS.md), *Built-in retrieval tools*).

## How tool calls are observed (and why the read path is the DB)

The DRIVE path is the real product path: `POST /v1/agents/:id/messages` → queue →
worker → brain. The READ path queries the **same Postgres the API writes**, via
`conversationTranscript()`. That is a deliberate divergence from a pure
HTTP-client harness, forced by how tool calls are recorded:

- The scenario semantics are defined over the structured breadcrumb
  `raw.action = {tool, input, result}`, but **no public HTTP route exposes it** —
  `GET /v1/conversations/:id` returns `content` / `buttons` / `clicked` only.
- `set_metadata` writes **no breadcrumb at all**; its only evidence is the
  change to `conversation.metadata`. The harness detects it from the
  per-turn metadata delta.
- `present_buttons` / `present_choices` / `request_input` write no breadcrumb
  either — they ride the reply row's `raw.buttons` / `raw.card`. The harness
  reconstructs them the same way `core/managed-brain.ts` replays history.
- **Bridge** agents write breadcrumbs with human text but no `raw.action`, so
  the harness also parses the legacy content (`triggered workflow …`,
  `conversation resolved …`) — mirroring managed-brain's legacy parser. This is
  why `resolve-on-thanks` works even against the rule-based bridge demo.

So the harness needs `DATABASE_URL` (the same one the stack already uses) in
addition to the api key. Everything the agent *does* still flows through the
real API and worker.

## This is the non-deterministic tier

Deterministic, in-process coverage of the tool lifecycle (auto tools,
`is_error`, result truncation, the gated approval pause + approve/deny/expire
resume, and job-retry safety) already lives in the vitest suite —
`tests/integration/tool-execution.test.ts` (with `managed-brain.test.ts` and
`agent-tools.test.ts` alongside it). Those run the real brain against a stubbed
Messages API with exact assertions; do **not** duplicate that here. These evals
cover the thing vitest can't: whether the **real configured LLM**, given the
**real prompt**, makes the right tool calls — including adversarial turns
(prompt injection, fabrication) where behavior is the whole point.

## Starter scenarios

| file | proves |
|---|---|
| `order-flow-happy` | records topic + offers a structured choice, no leaked option list |
| `refund-path` | free-text refund choice is recorded + 24h SLA stated |
| `resolve-on-thanks` | a closing thanks resolves the conversation (also runs on the bridge demo) |
| `adversarial-ignore-instructions` | prompt injection can't make it fire a workflow |
| `adversarial-fabrication` | never claims an un-run refund; fires no workflow |
| `approval-pause` (skip) | gated `refund_customer` pauses for approval — activates once that tool is registered |
