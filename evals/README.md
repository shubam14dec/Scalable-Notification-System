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
| `judge: {…}` | an LLM judge scores the reply on the requested dimensions (below) |

`X` is any tool name the agent can call — a custom tool, a built-in
(`resolve_conversation`, `trigger_workflow`…), or a **built-in retrieval tool**.
So for a grounded agent, `{ "expect": { "tool": "search_knowledge" } }` asserts
it actually looked a policy question up before answering (that tool is offered
only once the agent has a `ready` knowledge source — see
[docs/AGENT-TOOLS.md](../docs/AGENT-TOOLS.md), *Built-in retrieval tools*).

### Judged expectations (`expect.judge`)

The matchers above assert the **trace**. `judge` asserts the **reply**, on the
three dimensions a trace cannot express:

```jsonc
{ "expect": {
    "tool": "search_knowledge",              // graded FIRST — the judge only runs if it passes
    "judge": {
      "groundedness": { "min": 4 },          // or `true` for the default bar
      "tone": { "rubric": "warm, first person", "min": 4 },
      "refusal": "must_refuse"               // or "must_answer"
    }
} }
```

- `groundedness` / `tone` score **1–5**; `min` defaults to **4**. `refusal` is a
  requirement, not a score. At least one dimension is required, and unknown
  dimension keys are **rejected** at validation — a typo can't look like a pass.
- Every dimension in one `expect` rides **one** model call, forced through a
  `report_verdicts` tool (temperature 0; omitted on the newer Claude models that
  reject it). The model returns a score + rationale; the runner — not the model —
  compares that score to `min`.
- Groundedness evidence is the tool-result text **already** in the transcript
  (`raw.action.result`, rendered as `[evidence: <tool>]` lines), limited to rows
  through the reply under judgment. The transcript is fenced as untrusted data.
- The judge runs on the **agent's own model and credentials** (self-judge bias is
  a documented tradeoff; a `judgeModel` override is future work).
- **On CLI runs the judge is the *operator's*, not the agent's** — `npm run eval`
  holds a tenant api key, which is not an LLM credential. Give it one in env and
  judged dimensions grade for real (*Running with a judge (CLI)*, below); give it
  none and they record as `skipped` — visibly, never as a pass — while the
  deterministic assertions in the same scenario keep grading.
- A failing dimension reads `judge.groundedness: 2/5 < 4 — <rationale>` (or
  `judge.refusal: expected must_refuse — <rationale>`) inside the scenario's
  normal failure block, and every graded dimension — passes included — rides an
  additive `judged[]` on the result. Full walkthrough:
  [ASYNCIFY-AGENTS-GUIDE.md](../docs/ASYNCIFY-AGENTS-GUIDE.md) §10.

#### Running with a judge (CLI)

Judging is **off until you hand the harness a key**, and pinned to a model you
name. There is no default model, deliberately: a judge that silently picks one is
a scoring change nobody reviewed, and judged scores are only comparable across
runs when the judge is pinned.

| var | default | meaning |
|---|---|---|
| `EVAL_LLM_API_KEY` | — | the judge's key; setting it is what turns judging **on** |
| `EVAL_LLM_MODEL` | — (**required alongside the key**) | the judge model, e.g. `glm-4.6` |
| `EVAL_LLM_BASE_URL` | the SDK's own | any Anthropic-**compatible** endpoint (z.ai, a proxy, a local judge) |

`ASYNCIFY_JUDGE_API_KEY` / `ASYNCIFY_JUDGE_MODEL` / `ASYNCIFY_JUDGE_BASE_URL` are
the same three knobs and **take precedence** when both forms are set (blank
counts as unset). The wiring is `src/core/eval-judge-env.ts`.

- **A key with no model is a hard error**, never a quiet assertions-only run: the
  CLI fails with *"a judge api key is set but no judge model…"* naming both env
  vars.
- **No persona is passed.** This process holds an api key, not the agent row, so
  inventing a persona would grade `tone` against a fiction. `tone` is graded
  against ordinary professional support tone plus whatever `judge.tone.rubric`
  the scenario itself carries — the persona-aware score comes from a
  dashboard/API run.
- The base URL is **not** SSRF-gated here, unlike a tenant-supplied one: it comes
  from your own environment, so pointing the judge at `http://localhost` works.

With judging on, the run announces `Judging with <model> (no persona — tone
graded generically)`. With it off, every judged scenario prints the way to turn
it on, by name:

```
        ⚠ 2 judged dimension(s) skipped — set EVAL_LLM_API_KEY + EVAL_LLM_MODEL (and EVAL_LLM_BASE_URL for a compatible endpoint) to grade them
```

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
| `approval-pause` | the **repeat-refund guard**: the first refund executes inline, a second one for the same subscriber pauses for human approval |
| `refund-window-judged` (skip) | LLM-judged: the refund answer is grounded + on-voice, and a cross-customer request is refused — needs knowledge indexed (and judge creds, above) |

`approval-pause` asserted `approval='required'` until 2026-08-21. The live tool
had moved to `auto` plus a repeat-action guard on 2026-07-21, so the scenario was
red for a month without anyone seeing it — nothing ran it on every push. It now
asserts the guard itself, and that month is exactly the failure mode the CI gate
below exists to close.

## The CI gate

These scenarios are not just a local ritual — they **block merges**. The
`agent-evals` job in [`.github/workflows/ci.yml`](../.github/workflows/ci.yml)
boots the real product on a runner (Postgres + Redis, the demo tool backend on
`:4400`, API, worker — each health-**polled**, never slept on), seeds a throwaway
CI tenant and the fixture agent from
[`evals/agents/support-demo.agent.json`](agents/support-demo.agent.json)
**through the real API** (`npm run eval:seed` — no direct DB writes), then runs
`npm run eval` against it. Every turn is a real LLM conversation, judged
dimensions included. A scenario that regresses fails the job, and the job is a
required check: a push that breaks the agent cannot merge, exactly like a push
that breaks a unit test.

Two configuration choices worth knowing:

- The judge is pinned by `ASYNCIFY_JUDGE_MODEL`. `EVAL_LLM_MODEL` is deliberately
  **not** set, so the fixture file stays the single source of truth for the model
  *under test* while the variable pins only the *judge*.
- `OUTBOUND_URL_ALLOW=localhost,127.0.0.1` is set at **job** level, not just on
  the API: the fixture's tools point at localhost, and the worker re-checks tool
  URLs at dial time, not only the API at save time.

### When it runs

Only when the push touched something that can change what the agent does. The
filter is a **preflight step**, not `on.push.paths` — that would stop the `test`
job too, and a separate workflow file would leave required checks stuck on
"Expected — waiting for status" on every unrelated PR. The pathspec list:

```
evals/**
src/core/managed-brain*
src/core/eval-*
scripts/eval.ts
scripts/eval-seed.ts
scripts/acme-tools/**
.github/workflows/ci.yml
```

That list lives in the preflight step of `ci.yml` (as git pathspecs with
`:(glob)` magic) and **nowhere else in this repo** — it is the single source of
truth, so believe the workflow over this page if they ever drift.
`workflow_dispatch` runs the gate on demand with the path filter **not** applied,
which is how you re-check the agent after a model or provider change that touches
no code at all.

### A skip is never silent

Every outcome prints a `::notice::` **and** a job-summary line saying exactly
why, so a green `agent-evals` check can always be explained from the log alone:

| situation | outcome |
|---|---|
| no agent-behaviour path changed | skipped, green, naming the two shas it diffed |
| `EVAL_LLM_API_KEY` not set (fork PR, or not yet configured) | skipped, green — a missing secret must never be red, and never quietly green either |
| base commit unresolvable (new branch, force push) | **runs** — the gate fails *towards* running rather than skipping on a guess |

### One-time owner setup

1. **Repo secret `EVAL_LLM_API_KEY`** — Settings → Secrets and variables →
   Actions → Secrets. Until it exists, the job skips on every run (loudly, green).
2. **Optional repo variables** — same page, Variables tab: `EVAL_LLM_BASE_URL`
   (default `https://api.z.ai/api/anthropic`, which is what the fixture's `glm-5`
   needs — a bare Anthropic endpoint would 401/404 every turn) and
   `EVAL_JUDGE_MODEL` (default `glm-5`). The key is always a secret; only these
   two are variables.
3. **Branch protection** — require the `agent-evals` status check on `main`.

A green seed does **not** prove the key works: the API stores it sealed and never
calls the provider, so a wrong or expired key seeds perfectly and then dies on
turn 1. The job's failure step calls that case out explicitly, and uploads the
API/worker/eval logs as an artifact (7 days) so the distinction is checkable.

**The honest boundary:** a required status check blocks **PR merges**. A direct
push to `main` still lands and simply goes red afterwards — GitHub cannot fail a
push that already happened. Route changes that must be gated through a PR.
