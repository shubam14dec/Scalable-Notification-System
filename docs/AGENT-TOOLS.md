# Agent tools: custom tools, human approval, and evals

A **managed** agent ships with a fixed built-in menu (`set_metadata`,
`resolve_conversation`, `present_buttons`, `present_choices`,
`request_input`, `remember` — see **Built-in memory tool** below —
and `handoff_to_human` — see **Built-in handoff tool** below), plus three
**conditional** built-ins that appear only when there's something for them
to act on: `trigger_workflow` (offered once the tenant has at least one
workflow — its key argument is an enum of your real workflow keys, so a
made-up workflow can't be fired), and `search_knowledge` /
`search_history` (see **Built-in retrieval tools** below).
**Custom tools** extend that menu with
*your* code: you
register a tool — a model-facing name, a description, and a JSON-Schema
parameter shape — pointed at an **HTTPS endpoint you own**. Mid-conversation
the model decides when to call it; the platform POSTs the arguments to your
endpoint, and the (2xx) response body comes back to the model as the tool
result.

This page is the runbook for the three pieces: **registering** a tool, your
**endpoint's contract** (the signed POST it must answer), and the **approval**
flow that can pause a tool behind a human. It closes with the **eval harness**
for testing that your agent actually makes the right calls — and, for what a
call trace can't show, that it says the right things — then with the two API
surfaces that carry a prompt change to production: **prompt versions** and the
**canary** that trials one against live traffic.

## What a tool is

A tool definition is four things:

- a **model-facing name** and **description** — the description is what the
  model reads to decide *when* to call it (write it like the built-in tool
  descriptions: "Look up the status of a customer order by its id.");
- a **JSON-Schema** `parameters` object — the arguments the model must supply;
- **your HTTPS endpoint** — where we POST the call;
- an **approval tier** — `auto` (POST immediately) or `required` (pause for a
  human first).

Tools are only meaningful for **managed-runtime agents** — the managed brain is
what dispatches them. (Registration itself doesn't refuse a bridge agent, so a
bridge agent that's later re-pointed to the managed runtime keeps its defs, but
a bridge agent never calls them.) They're per-agent: each agent has its own
registry.

## Built-in memory tool (`remember`)

Always offered to a **managed** agent (no setup) — the tool that writes a
customer's **long-term profile**: durable facts the managed brain LOADS into
every future conversation with that subscriber (never searches — see the
customer guide's *Memory & cost*).

- **Input shape:** `{ key, value }` — `key` a short snake_case handle
  (`channel_pref`, `plan`), `value` the fact (`"prefers email over SMS"`). Both
  required; upsert by `key` (saving the same key overwrites).
- **Result:** `remembered <key>` on success — invisible to the customer, visible
  as a tool breadcrumb in the turn trace.
- **Caps (enforced as law, both writers):** **≤32 keys** per (agent,
  subscriber), **key ≤64 chars**, **value ≤300 chars**. Nothing is truncated
  silently — an over-cap call comes back as an **instructive `is_error` result**
  the model can act on:
  - profile full → `cannot remember a new fact — this customer's profile is full
    (32 keys max). To save this, reuse one of the existing keys to overwrite it:
    <current keys>.` (an *existing* key can always be overwritten, even at the
    cap — that's how the model frees space);
  - value too long → `cannot remember — the value is longer than 300 characters.
    Store a shorter, essential version of the fact.`;
  - key too long → `cannot remember — the key is longer than 64 characters. Use a
    short snake_case key.`
- **No content filter (v1):** the tool stores whatever it's handed — it does
  **not** refuse a value by content. Keeping secrets, passwords, and payment data
  out is the tool description's instruction (and the system prompt's), not an
  enforced check.
- **Reserved name:** `remember` is on the reserved list — a custom tool may not
  be named `remember` (registration → 400), so the built-in can't be shadowed.

**`remember` vs `set_metadata` — two different horizons:**

| | `set_metadata` | `remember` |
|---|---|---|
| **Scope** | THIS conversation | THIS customer, all future conversations |
| **Read by** | support staff, later turns of this chat | the agent, loaded into every later conversation |
| **Lifetime** | lives on the conversation | durable profile until deleted |
| **Example** | `order_id: 1042`, `sentiment: frustrated` | `channel_pref: prefers email`, `plan: Pro` |
| **Storage** | conversation metadata | per-(agent, subscriber) profile (≤32 keys) |

The platform reminder the model sees carries this one-line disambiguation so it
picks the right tool: a fact about *this* conversation → `set_metadata`; a
durable fact about the *customer* → `remember`.

## Built-in retrieval tools (`search_knowledge`, `search_history`)

Beyond the always-on built-in menu, a managed agent can gain **two more built-in
tools** — one for its business's indexed knowledge, one for a customer's past
conversations. They aren't registered or configured per tool; they appear
**automatically, and only when there is something to search**. Both ride the
tenant's **embeddings + vector-store integrations** (set up on the Integrations
page — customer-facing walkthrough in
[ASYNCIFY-AGENTS-GUIDE.md](ASYNCIFY-AGENTS-GUIDE.md), *"Teach your agent"*); with
those absent, neither tool is ever offered.

### `search_knowledge(query)`

- **Offered when** this agent has **≥1 knowledge source in status `ready`**.
- **What the executor does:** embeds `query` (one call to the tenant's embeddings
  endpoint), pulls the **top 4** chunks by cosine similarity scoped to *this
  agent*, then reads their text + source name back from Postgres in match order
  (dropping any chunk whose embedding dimension no longer matches the current
  config).
- **Result format:** numbered excerpts, each prefixed with its source tag —

  ```
  1. [source: returns-policy] Opened electronics can be returned within 14 days…
  2. [source: shipping-faq] Standard orders ship within 2 business days…
  ```

  The whole result is capped at ~6 KB (excerpt bodies are tail-truncated with an
  ellipsis to fit). **No match →** the fixed string `no relevant knowledge
  found.`
- **Grounding:** whenever this tool is offered, the agent's system instructions
  gain a directive to answer policy/product/factual questions **only** from its
  results, cite `[source: <name>]` inline, and otherwise say it doesn't know and
  offer a human — see *Grounding v1* note below.

### `search_history(query)`

- **Offered when** **this subscriber** has **≥1 embedded summary** of a past
  resolved conversation with **this agent** (episodic memory; managed runtime
  only — bridge agents produce no summaries).
- **What the executor does:** embeds `query`, then queries the **top 3** past
  conversation summaries scoped to *this agent **and** this subscriber*, reading
  the summary text + date back from Postgres.
- **Result format:** one line per summary, tagged with a **relative age** instead
  of a source —

  ```
  2 weeks ago — Refund issued for order #1042 that never arrived; customer satisfied.
  3 days ago — Walked through resetting the app password.
  ```

  (Ages read as `just now`, `N minutes/hours/days/weeks/months/years ago`.) **No
  match →** the fixed string `no relevant past conversations found.`

### Shared behavior

- Both take a single `query` string and return their result to the model as an
  ordinary tool result — so **evals assert them like any tool** (`expect: { tool:
  "search_knowledge" }`), and they show up in the conversation's turn trace and
  the Turn Inspector with **zero extra instrumentation**.
- An empty `query`, or an internal failure (embeddings/vector-store error),
  comes back as an `is_error` result the model can recover from — never a thrown
  turn.
- **Not customer-registrable:** these names are on the reserved list — the
  registration API rejects a custom tool named `search_knowledge` or
  `search_history`, so a built-in can never be shadowed.

> **Grounding v1 — honest scope.** Grounding is three real mechanisms: the prompt
> **directive**, the **conditional availability** of `search_knowledge`, and the
> **retrieval audit trail** (every lookup is a visible tool call). What it is
> *not* is an automated faithfulness **judge in the live reply path**, scoring
> each answer and withholding an un-grounded one — that inline enforcement layer
> is a roadmap item, not shipped. Groundedness *is* graded off the live path:
> `expect.judge.groundedness` scores it 1–5 against your bar in the eval harness
> (see **Evals** below), which catches a drifting prompt before it ships rather
> than a bad reply mid-conversation. Knowledge sources are
> **text, URL, or `.txt`/`.md`** today; **PDF is not yet supported**.

## Built-in handoff tool (`handoff_to_human`)

Always offered to a **managed** agent (no setup) — the escape hatch that hands
the whole conversation to a human teammate. It is the sibling of the approval
flow below, and the distinction is the whole point:

| | **Approval** (a `required` tool) | **Handoff** (`handoff_to_human`) |
|---|---|---|
| **What the human does** | vetoes or approves **one action** | **takes the pen** — owns the conversation |
| **Who holds the conversation** | the agent, still driving | the human, until they hand it back |
| **After the human acts** | the agent resumes and composes the reply | the agent stays **silent** until *Return to agent* |
| **Trigger** | the model calls a `required`-tier tool | the model calls `handoff_to_human` |

Put plainly: **approval = a human vetoes one action; handoff = a human takes the
pen.**

- **When the model calls it:** the per-turn reminder tells the agent to call
  `handoff_to_human` when the customer **explicitly asks for a person**, or when
  it **cannot help after honest attempts** — and never to promise a human
  without calling it.
- **Input shape:** `{ reason?: string }` — an optional note for the team (≤300
  chars, trimmed); no required fields.
- **Tier:** **auto** — escalating to a human never needs human approval, so it
  runs immediately (it is not gated behind the approval flow).
- **Effects of a successful call:** the conversation flips to **`waiting_human`**
  (visible live on the dashboard's Conversations queue), a breadcrumb is written,
  and — if ops notifications are wired (below) — the team is paged. From that
  moment the managed brain **will not reply** on this conversation until a human
  returns it (the customer's later messages still post to the live transcript).
- **Result texts (verbatim):**
  - success → `a human teammate has been notified and will take over — let the
    customer know` (the agent then writes one short reply telling the customer a
    teammate is taking over);
  - **idempotent** — called while the conversation is already `waiting_human` or
    `human` → `a human teammate is already engaged on this conversation`, with
    **no** second page and no state change.
- **Ops notification:** a handoff dogfoods the same reserved-workflow pattern as
  approvals — it fires the reserved workflow **`agent-handoffs`** for the reused
  reserved **`approvals`** subscriber (see *Opt-in approval notifications* below;
  the audience is the same ops humans, so a tenant that wired approval alerts
  gets handoff alerts with **zero new setup beyond a second workflow**). Payload:

  ```json
  {
    "agentIdentifier": "support-bot",
    "agentName": "Acme Support",
    "subscriberExternalId": "user_789",
    "reason": "customer asked to speak to a person",
    "conversationUrl": "/conversations/…"
  }
  ```

  `conversationUrl` is a **relative** dashboard deep link the workflow template
  prefixes with the team's dashboard origin. **Missing either the workflow or
  the `approvals` subscriber = a silent no-op** — the handoff still happens and
  the dashboard queue is the authoritative record; the email is only the
  accelerator. A notification failure never fails the handoff.
- **Reserved name:** `handoff_to_human` is on the reserved list — a custom tool
  may not be named it (registration → 400), so the built-in can't be shadowed.

The customer-facing walkthrough (Priya's one-time setup, Sam's reply surface,
what Maya sees) is in [ASYNCIFY-AGENTS-GUIDE.md](ASYNCIFY-AGENTS-GUIDE.md),
*"Human handoff"*.

## Registering a tool

### Dashboard

**Agents → (row) → Tools → Add tool.** Fill in name, description, the
Parameters JSON Schema, the endpoint URL, the **Require human approval** toggle,
and a timeout. The optional **guard** fields on the same form add automatic,
per-customer limits (repeat-action and hourly-rate — see **Guardrails** below);
leave them blank for today's behavior. On save the **signing secret is shown
once** — copy it before you close the dialog. Existing tools can be edited (name
is immutable), **disabled** (stays defined, model can't call it), have their
**secret rotated**, or deleted.

### API

```bash
# Register a custom tool on an agent (managed).
curl -X POST -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/agents/support-bot/tools \
  -d '{
    "name": "lookup_order",
    "description": "Look up the status of a customer order by its id.",
    "parameters": {
      "type": "object",
      "properties": { "orderId": { "type": "string" } },
      "required": ["orderId"]
    },
    "endpointUrl": "https://app.example.com/tools/lookup-order",
    "approval": "auto",
    "timeoutMs": 10000
  }'
# → 201 { "tool": { "id": "...", "name": "lookup_order", ... }, "secret": "ats_…" }
```

| Method & path | Purpose |
|---|---|
| `POST /v1/agents/:identifier/tools` | register a tool → `201 {tool, secret}` (**secret shown once**) |
| `GET /v1/agents/:identifier/tools` | list the agent's tools (never returns the secret) |
| `PATCH /v1/agents/:identifier/tools/:toolId` | update description/parameters/endpointUrl/approval/status/timeoutMs |
| `DELETE /v1/agents/:identifier/tools/:toolId` | delete (call history survives; the FK nulls out) |
| `POST /v1/agents/:identifier/tools/:toolId/rotate-secret` | mint a new secret → `{secret}` (**shown once**) |

**Field table (create):**

| Field | Rules |
|---|---|
| `name` | required; must match **`^[a-z][a-z0-9_]{0,63}$`** (lowercase, starts with a letter, ≤64 chars). May **not** be a reserved built-in name: `trigger_workflow`, `set_metadata`, `resolve_conversation`, `present_choices`, `present_buttons`, `request_input`, `search_knowledge`, `search_history`, `remember`, `handoff_to_human`. Immutable after create; a duplicate name on the same agent → **409**. |
| `description` | required; 1–1024 chars. |
| `parameters` | required; a **JSON Schema object with `type: "object"`** (not an array, not `null`). Shallow-validated — this becomes the tool's `input_schema` verbatim. |
| `endpointUrl` | required; a valid URL, ≤2048 chars. **SSRF-gated at write time** — it must not resolve to private/internal infrastructure, or you get a 400. |
| `approval` | `auto` (default) or `required`. |
| `timeoutMs` | integer **1000–30000**; default **10000**. |

`PATCH` takes the same fields (all optional) plus `status: 'active' | 'disabled'`; `parameters` and `endpointUrl` are re-validated the same way. `name` cannot be patched.

**The secret is shown once.** The `secret` (an `ats_…` value) is returned only
in the `POST` create response and the `rotate-secret` response — it's sealed at
rest and never appears in `GET`/list. Lost it? **Rotate** to mint a fresh one
(the old one stops verifying). Same doctrine as API keys.

## Your endpoint's contract

When an `auto` tool is called (or an approved `required` tool resumes), the
worker sends a signed `POST` to your `endpointUrl`.

### Body

```json
{
  "toolCallId": "…",
  "tool": "lookup_order",
  "arguments": { "orderId": "1042" },
  "agent": { "identifier": "support-bot" },
  "conversation": { "id": "…", "subscriberId": "user_789" }
}
```

`arguments` is exactly what the model produced against your `parameters`
schema.

### Headers

| Header | Value |
|---|---|
| `content-type` | `application/json` |
| `x-asyncify-timestamp` | unix **seconds** at send time |
| `x-asyncify-signature` | `hex( HMAC-SHA256( secret, "<timestamp>.<rawBody>" ) )` |
| `x-asyncify-idempotency-key` | the `toolCallId` — **dedupe on this** |

This is the **same signing scheme** the bridge transport uses. Verify it before
trusting the body:

```js
const { createHmac, timingSafeEqual } = require('node:crypto');

// Verify an Asyncify tool-call POST. `rawBody` MUST be the exact bytes
// received (verify BEFORE JSON.parse — re-serializing changes the signature).
function verifyToolCall(secret, headers, rawBody, toleranceSec = 300) {
  const ts = headers['x-asyncify-timestamp'];
  const sig = headers['x-asyncify-signature'];
  if (!ts || !sig) return false;
  const n = Number.parseInt(ts, 10);
  // Reject stale/replayed requests: ±300s window (matches @asyncify-hq/agent).
  if (!Number.isFinite(n) || Math.abs(Date.now() / 1000 - n) > toleranceSec) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${rawBody}`).digest();
  let provided;
  try { provided = Buffer.from(sig, 'hex'); } catch { return false; }
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
```

(This mirrors `verifySignature` in `@asyncify-hq/agent` exactly — same
`"<ts>.<body>"` string, same hex HMAC-SHA256, same 300-second tolerance.)

### Response rules

- **2xx** → your response **body** becomes the model-visible tool result,
  **truncated to 16 KB**. Return whatever the model should read next (a status,
  a JSON blob, a short sentence).
- **non-2xx** → surfaced to the model as an **error** (`HTTP <status>: <body>`,
  body clipped to ~512 chars) so it can self-correct. A side-effecting POST is
  **not** auto-retried within the turn.
- **timeout / network / blocked URL** → surfaced to the model as an error
  (`timed out after <timeoutMs>ms`, etc.). We do **not** follow redirects (a
  redirect is treated as a failure — it could bounce us to a private host).
- **DEDUPE ON THE IDEMPOTENCY KEY.** A crash-retried worker job can re-POST the
  **same** `toolCallId`. If your tool has side effects (charging, refunding,
  writing), key on `x-asyncify-idempotency-key` so a retry is a no-op.

## Approval flow (human-in-the-loop)

Mark a tool `approval: "required"` and a call to it **doesn't run**
immediately:

1. The agent **pauses**. It records a `pending` approval, writes a transcript
   breadcrumb, and ends the turn with a **deterministic** note —
   *"I've asked a teammate to approve `<tool>` — I'll follow up here as soon as
   it's decided."* (No model-composed text; the note is fixed.)
2. The pending call shows up on the dashboard **Approvals → Pending** (and via
   `GET /v1/approvals?status=pending`), with the tool name, agent, arguments,
   and an expiry hint.
3. An operator **approves** or **denies** (with an optional note):

   ```bash
   curl -X POST -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
     https://api.asyncify.org/v1/approvals/<approvalId>/decision \
     -d '{"decision":"approve"}'          # or {"decision":"deny","note":"…"}
   ```

   Approve → we POST the tool now (the endpoint contract above). Deny → the
   model sees `denied by <who>: <note>`. Either way the conversation **resumes
   with a fresh turn** so the agent composes the user-facing follow-up.
4. **24-hour expiry.** A pending call not decided within 24h is flipped to
   `expired` by the inactivity sweep (runs every 60s); the model sees
   `approval expired` and the conversation resumes the same way.

Decided calls (approved/denied/expired/executed/failed) move to **Approvals →
History**. Deciding an already-decided call returns **409**; an unknown id,
**404**.

An **`auto`** tool can also reach this pause without being marked `required` —
the repeat-action guard (see **Guardrails** below) flips it once a customer's
executed calls hit the ceiling, adding a history line to the card so the approver
sees why.

### Opt-in approval notifications (a convention)

Nothing is pushed to you when a call pauses **unless you opt in** — the pause is
recorded regardless, but the notification is convention-over-config, mirroring
the reserved workflow pattern. To get pinged, create **both**:

- a workflow with key **`agent-approvals`** (wire it to whatever channels your
  approvers watch — email, Slack, push…), and
- a subscriber with externalId **`approvals`** (your ops audience — **not** the
  end customer; the customer must never be told their own refund needs
  approval).

With both present, each pending call triggers `agent-approvals` to the
`approvals` subscriber with payload:

```json
{
  "approvalId": "…",
  "agentIdentifier": "support-bot",
  "toolName": "refund_customer",
  "argsSummary": "{\"orderId\":\"1042\"}",
  "requestedAt": "…",
  "conversationId": "…"
}
```

**Missing either the workflow or the subscriber = a silent no-op** (by design:
firing blind would mint a phantom, channel-less `approvals` subscriber). A
notification failure never fails the pause — the Approvals page is the
authoritative record.

### Approve from Slack / Telegram

The convention above only *pings* your approvers; to let them **decide** in the
chat itself, route each pending call as an in-channel **Approve/Deny card**. The
card is an accelerator, not the source of truth — every failure is swallowed so
no channel hiccup can break the pause, and the Approvals page stays authoritative.

**Setup — dashboard → Approvals → Channel approvals** (the collapsible panel at
the top). Configure Slack, Telegram, or both:

- **Slack** — pick a Slack **connection** and paste the **channel ID** (open the
  channel → details → About; it looks like `C0123456789`). `/invite` the bot into
  that channel first — a `not_in_channel` / `channel_not_found` post fails with a
  logged hint (`invite the bot to <channel>`) and never blocks the pause.
- **Telegram** — pick a Telegram **connection**. Cards go to **every telegram
  identity linked to the reserved `approvals` subscriber** (the *same* subscriber
  as the notification convention above) — each approver gets a private-chat card,
  and each must have `/start`ed the bot (unreachable approvers are logged and
  skipped).

Or set it over the API — `PUT /v1/settings/approvals` with any of
`{slackConnectionId, slackChannelId, telegramConnectionId}`; an explicit `null`
clears a field (nulling the Slack connection also clears its channel id), and a
`slackChannelId` requires an active `slackConnectionId`. `GET` returns the
current settings plus `telegramApproverCount`.

**What happens.** Each pending approval posts a card carrying **Approve** and
**Deny** buttons (Slack: one card in the channel; Telegram: one per linked
approver):

- **Any channel member / linked approver can tap** — channel membership *is* the
  authorization boundary (the webhook signature already trusts the request).
- The tap records **exactly who**: `slack:U…` / `telegram:<id>`, plus the linked
  subscriber id when the tapper is connected via identity links
  (`slack:U… (jane@acme.com)`).
- Taps **race safely with the dashboard** — the decision is a single atomic
  claim, so one tap (or one dashboard click) wins and every late tapper sees
  `already <status> by <who>`.
- Every posted card is **edited in place to the final outcome**: `✓ approved by
  … — executed` (with a result snippet), `✗ denied by … : <note>`, or
  `⏱ expired (24h)`. The winner's card first flips to `Approving — by …,
  processing…` while the follow-up turn runs, then settles to the outcome.

**Audit trail.** However a call is decided — dashboard, Slack, or Telegram — the
`decided_by` on the approval record carries that tapper's identity, and the
dashboard **History** tab shows it alongside the decision and any note.

## Guardrails: limits a tool enforces on its own

Approval is one brake — a human's. A **guard** is the other: a small, optional
JSON object on a tool that lets the platform pump the brakes **deterministically**,
before the model or your endpoint is touched. Guards are configured per tool on
the dashboard (**Agents → (row) → Tools**); leaving them blank keeps today's
behavior. The shape stored on the tool def's `guard` column:

```json
{ "maxAutoCalls": 1, "windowDays": 30, "maxCallsPerHour": 5 }
```

Every field is optional and off when absent.

| Field(s) | Arms | Applies to |
|---|---|---|
| `maxAutoCalls` + `windowDays` (both required together) | the **repeat-action rule** | `auto` tools only |
| `maxCallsPerHour` | the **hourly rate cap** | any tool (`auto` or `required`) |

### Repeat-action rule (`maxAutoCalls` + `windowDays`)

An **`auto`** tool with both set flips to the approval path once **this
subscriber's** prior **executed** calls of this tool reach `maxAutoCalls` within
the window. The count is:

- **per-subscriber** — set-based, joined through the conversation to the
  subscriber, so one customer's history doesn't affect another's;
- **executed-only** — only `status='executed'` calls count; pending, denied,
  failed, and rate-capped attempts do not;
- a **rolling window** — calls whose `requested_at` is within the last
  `windowDays` days (`now() - windowDays`), not a calendar month.

On the `(maxAutoCalls+1)`th attempt the call pauses **exactly like**
`approval: "required"` — nothing POSTs until a human decides — and the approval
card gains a **history line** so the approver sees the pattern:

```
⚠ 2nd refund_customer in 30d for this customer — prior: 2026-07-20
```

**History line format (frozen):**
`⚠ <ordinal> <tool> in <windowDays>d for this customer — prior: <dates>`

- `<ordinal>` is this attempt's position — 2nd, 3rd, 11th …;
- `<dates>` are up to the **3 most recent** executed-call dates, UTC
  `YYYY-MM-DD`, comma-separated;
- with no prior dates the ` — prior: <dates>` clause is omitted.

The line is stored on the paused call (so the dashboard's **Pending** entry shows
it) and rides just under the `Customer:` line on the Slack / Telegram approval
cards. Only `auto` tools flip; a tool already `required` is always human-judged,
guard or not.

### Hourly rate cap (`maxCallsPerHour`)

A per-subscriber, per-tool ceiling within a UTC hour, checked **before any
execution or approval** (auto *or* required). It counts **every attempt**; once
the count exceeds `maxCallsPerHour`, the call is refused before it runs and the
model receives an **error result** it explains politely to the customer:

```
rate limit reached for this action — try again later
```

Nothing executes, **no tool-call row is written**, and **no approval is raised**
(so a loop can't spam your approvers). The refusal still shows in the turn's tool
trace as a failed call. Rate-capped attempts don't count toward the repeat-action
rule (they never execute).

### Tool timing (`duration_ms`)

Every executed tool call now records **`duration_ms`** — the wall-clock of the
signed POST, measured by the worker around the request and stored on the
`agent_tool_calls` row. The agent's **Health** view averages it per tool (mean
over executed calls in the window; blank until a tool has an executed call
carrying a duration), so a slow endpoint is visible.

**Approximate by design.** The rate cap and daily-token counters (below) are fast
Redis tallies; a worker retry can re-count, so they can drift slightly high. They
are circuit breakers, never exact quotas — Postgres (the tool-call rows,
`raw.usage`) stays the auditable truth.

### Per-agent daily token budget

Separately from any tool, an agent can carry a **daily token budget**
(`max_daily_tokens`, null = off) — a ceiling on how much it may *think* in a UTC
day, set on the agent (dashboard → the agent). It's a **circuit breaker, not a
quota**: sized well above normal so it trips only on the abnormal (an injection
loop, a runaway retry). When the day's spend reaches the limit, the next turn
makes **no model call** — the customer gets a fixed note (*"I'm temporarily
unavailable right now — the team has been notified. Please try again later."*),
the skip is breadcrumbed with `used/limit`, and — if approval notifications are
wired — the ops audience is paged **once per day**. The agent's **Health** view
shows tokens used today against the limit; raise the limit and the agent resumes
on the next turn. (Customer-facing framing and sizing advice are in
[ASYNCIFY-AGENTS-GUIDE.md](ASYNCIFY-AGENTS-GUIDE.md).) The ops page rides the same
reserved `agent-approvals` / `approvals` convention as **Opt-in approval
notifications** above — wiring steps are in that guide's *Where the alerts go*
subsection.

## Evals: test your prompt like you test your code

The eval harness proves your **real configured LLM**, given your **real
prompt**, makes the **right tool calls** — asserting the **tool-call trace**, not
prose vibes. For the qualities a trace can't express, an expect can also carry
**LLM-judged dimensions** — `groundedness`, `tone`, `refusal` — scored 1–5
against a bar *you* set, with the runner (not the judge model) converting the
score into pass/fail.

```bash
npm run eval                 # run every evals/*.json
npm run eval -- refund-path  # run just evals/refund-path.json
```

**What must be running:** the **API** (`npm run api`) and the **worker**
(`npm run worker`) — the drive path is the real product path (HTTP POST → queue
→ worker → brain). The scenario's `agent` must already exist on the tenant.
**Env:** `ASYNCIFY_API_KEY` (required, the tenant key), `ASYNCIFY_API_URL`
(default `http://localhost:3000`), `DATABASE_URL` (the read path queries the
same Postgres). A turn that never gets a reply is reported as such.

**Scenario file** (`evals/<name>.json`, zero-dep JSON): a list of `turns`, each
either a `user` message or an `expect` about the most recent user turn — its
tool trace, its reply, or a judged dimension of it.

```jsonc
{
  "agent": "support-demo",       // must exist on the tenant
  "description": "…",
  "attempts": 2,                 // default 1; live LLMs are non-deterministic — pass if ANY attempt passes
  "skip": false,                 // optional; skipped scenarios never fail the run
  "turns": [
    { "user": "hi, my order #1042 never arrived" },
    { "expect": { "tool": "set_metadata" } },
    { "expect": { "tool": "present_choices", "inputContains": { "id": "order_action" } } },
    { "user": "I want a refund" },
    { "expect": { "pendingApproval": "refund_customer" } },
    { "expect": { "replyContains": "24 hours" } }
  ]
}
```

**Expect kinds:** `tool: X` (called this turn), `tool: X` + `inputContains: {…}`
(a call whose input superset-matches), `noTool: X` (not called),
`pendingApproval: X` (a gated tool paused for approval this turn), `replyContains`
/ `replyContainsAny` / `replyNotContains` (case-insensitive checks on the turn's
last reply), and `judge: {…}` — any of `groundedness` (`true`, or `{ min }`),
`tone` (`{ rubric?, min? }`) and `refusal` (`"must_refuse" | "must_answer"`).
Scores are 1–5 and `min` defaults to **4**; an unknown dimension name is
rejected rather than ignored, and the deterministic matchers on the same expect
must pass before a judge is ever called.

Full details — how the trace is reconstructed, the starter scenarios, and why
the read path is the DB — are in **[evals/README.md](../evals/README.md)**. That
file also covers judging from the CLI (`EVAL_LLM_API_KEY` + `EVAL_LLM_MODEL`;
without them, judged dimensions come back visibly `skipped`, never passed) and
the repo's required **`agent-evals`** CI check, which boots the real stack and
drives the config-as-code fixture agent in `evals/agents/` through real turns, so
an agent regression blocks the merge.

### Running evals from the API

The dashboard's **Run evals** button and its pre-save check are the same
endpoint: enqueue a run, poll for the verdict.

```bash
# Grade an EDITED prompt before saving it — what the dashboard's pre-save
# check does when you change a managed agent's prompt and hit Save.
curl -X POST -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/agents/support-bot/evals/run \
  -d '{
    "trigger": "pre_save",
    "candidate": { "systemPrompt": "You are Acme support. Refunds within 14 days…" }
  }'
# → 202 { "runId": "..." }
```

| Method & path | Purpose |
|---|---|
| `POST /v1/agents/:identifier/evals/run` | enqueue a run of the agent's **enabled** evals → `202 {runId}` |
| `GET /v1/agents/:identifier/evals/runs` | recent runs, newest first |
| `GET /v1/agents/:identifier/evals/runs/:runId` | one run in full, with per-scenario `results[]` |

**Body (every field optional):**

| Field | Rules |
|---|---|
| `trigger` | `manual` (default) or `pre_save` — recorded on the run, so the history says *why* it ran. |
| `candidate` | `{ systemPrompt?, model? }` — grade **this** config instead of the agent's live one. At least one of the two keys (an empty object is a **400**, not "use the agent's config"). `systemPrompt` 1–100,000 chars, `model` 1–255 — the same caps the agent-create route enforces, because a candidate must be something the agent could actually be saved with. |

**`candidate` is managed-only.** A bridge agent's brain is your own code behind a
signed URL — there is no prompt or model here to override — so a candidate on a
bridge agent is a **400**, never a silently-ignored field.

**Nothing is written.** The override lives on the **run row**, not the agent: it
is applied when the brain is assembled for that run's turns (real tools, real
guardrails, real knowledge, real judge — only the prompt/model swapped) and it
applies to nothing else. The agent your customers are talking to is untouched for
the whole run, and a retried job grades the same config the results are filed
under.

**The run remembers what it graded.** A run started with a candidate carries
`candidate` back on its payload (`GET …/evals/runs/:runId`); a plain run has no
such key at all, so existing readers see exactly the shape they saw before.

Typed wrappers for all of the above are in `@asyncify-hq/node`
(`client.agents.evals.run(...)` / `.getRun(...)`).

## Prompt versions

Every save that **changes** a managed agent's `systemPrompt` or `model`
snapshots it first: `promptVersion` on the agent row moves to the next number
and the new values are stored as that version, in the same transaction as the
save. A save that submits identical values versions nothing — the outcome is
compared, not the request, so a re-submit of the same prompt is not a new
version.

| Method & path | Purpose |
|---|---|
| `GET /v1/agents/:identifier/versions` | the history → `{currentVersion, versions[]}` |
| `GET /v1/agents/:identifier/versions/:version` | one snapshot in full → `{version:{…}}` |
| `POST /v1/agents/:identifier/versions/:version/restore` | publish that snapshot as the live config |

**The list is deliberately light.** Each entry is
`{version, model, promptLength, promptHead, current, createdAt}` — a 140-char
head, never the prompt body, because a hundred versions of a 100,000-char prompt
is megabytes down the wire for a list of numbers and dates. The full text comes
from the single-version route, which returns
`{version, systemPrompt, model, current, createdAt}`.

**Restore is a SAVE, not a rewind.** It copies the old snapshot forward through
the ordinary update path, so it mints a **new** version rather than deleting the
ones after it — restoring v1 publishes v3, and v2 stays in the history:

```bash
curl -X POST -H "x-api-key: $API_KEY" \
  https://api.asyncify.org/v1/agents/support-bot/versions/1/restore
# → 200 { "agent": {…}, "restoredFrom": 1, "version": 3 }
```

`restoredFrom` is what you asked for, `version` is what was published. They are
equal only when the restore was a no-op — the live config already matched, so
nothing was minted. Because it goes through the ordinary save path, a restore
also meets every guard an ordinary save meets, now and later.

**Managed only.** All three routes answer **400** on a bridge agent — its brain
is your code behind a signed URL, so there is no prompt here to version — and
**404** for an unknown agent or an unknown version. A `:version` that isn't a
positive integer is a 404, never a coerced `NaN`.

## Canary: trialling a version on real conversations

A canary puts one prompt version in front of a **percentage of real
conversations** and compares it against the live prompt on the same traffic.

Two properties make it safe to run on customers. It is **sticky**: the arm is
rolled once, when a conversation OPENS, and never re-rolled — so a customer
never meets two different personalities inside one thread, and traffic converges
over *new* conversations rather than instantly. And it is **not a second brain**:
a canary-arm turn injects the version's snapshot through the very same
`candidate` mechanism the pre-save check uses (above), so the trial runs the real
agent, real tools, real guardrails, real knowledge — only the prompt and model
swapped. Nothing about the live agent's configuration changes while a trial runs.

| Method & path | Purpose |
|---|---|
| `POST /v1/agents/:identifier/canary` | start a trial → `{agent}` |
| `DELETE /v1/agents/:identifier/canary` | stop it, changing nothing → `{agent}` |
| `GET /v1/agents/:identifier/canary/report` | the per-arm comparison |
| `POST /v1/agents/:identifier/canary/promote` | the trial version becomes live |

```bash
curl -X POST -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/agents/support-bot/canary \
  -d '{ "version": 8, "percent": 10, "samplePercent": 20 }'
# → 200 { "agent": { …, "canary": { "version": 8, "percent": 10,
#                                   "startedAt": "…", "samplePercent": 20 } } }
```

**Start body:**

| Field | Rules |
|---|---|
| `version` | required, a positive integer that exists on this agent (else **404**). |
| `percent` | required, **1–99**. Both ends are excluded on purpose: 0 is "no trial" (that's `DELETE`) and 100 is "ship it" (that's Promote). An all-or-nothing "split" would leave one arm empty and a comparison with nothing to compare. |
| `samplePercent` | optional, **0–100**, default **20** — the share of replies sampled for judging, in BOTH arms. Both ends are meaningful here, unlike `percent`: `0` runs the trial on counters alone (spend nothing extra), `100` judges every reply, which is affordable on a low-traffic agent and is the only way a short trial gathers enough judgments to separate the arms. |

**One trial at a time.** Starting a second while one is running is a **409**,
enforced by the write itself — never a silent replacement, whose partial results
would be misattributed to the new version. Changing the version or the percent
means stop, then start. The agent object carries `canary` **only while a trial
is running**, so its presence is the flag.

**Stop reverts at the next turn.** Conversations already enrolled keep their arm
recorded (the report needs to know what they were enrolled in) but are served
the live prompt from their next turn onward — a rejected prompt stops serving
immediately and everywhere, rather than lingering in the threads that happened to
open under it.

### The report

```bash
curl -H "x-api-key: $API_KEY" \
  https://api.asyncify.org/v1/agents/support-bot/canary/report
```

```jsonc
{
  "version": 8, "percent": 10, "samplePercent": 20, "startedAt": "…",
  "arms": [
    { "arm": "canary",  "conversations": 42, "turns": 118, "resolutions": 31,
      "handoffs": 4, "guardPauses": 1, "avgTokensPerTurn": 1840,
      "judged": { "groundedness": { "avg": 4.4, "n": 24 },
                  "tone":         { "avg": 4.6, "n": 24 } } },
    { "arm": "control", "conversations": 391, "turns": 1102, "resolutions": 268,
      "handoffs": 55, "guardPauses": 9, "avgTokensPerTurn": 1795,
      "judged": { "groundedness": { "avg": 4.1, "n": 221 },
                  "tone":         { "avg": 4.5, "n": 221 } } }
  ]
}
```

**Both arms are always present**, zeros included, so an arm with no traffic yet
reads as "nothing here" rather than vanishing. `judged` is empty until the first
sampled reply is judged, and always empty at `samplePercent: 0`.

**Both arms are judged at the same rate** — an unjudged control arm is not a
control: "groundedness 4.4" means nothing without the live prompt's number,
measured the same way, on the same traffic, by the same judge. The judging is
sampled, asynchronous, and happens strictly **after** the reply is delivered; a
broken judge queue degrades the comparison and never the product.

**Two dimensions only, and they are averages, not verdicts.** `groundedness` and
`tone` are the two that score 1–5 and can therefore be averaged across an arm.
There is no `refusal` here: it is a requirement, and it is only meaningful
against a scenario author's declaration of which way a reply should have gone —
real traffic carries no such declaration, so a refusal verdict would be the judge
inventing the requirement it then grades against. For the same reason there is no
pass/fail on this surface, unlike an eval's `min` bar: the evidence is one arm's
average against the other's.

**Two attributions, deliberately.** `conversations`, `resolutions`, `handoffs`
and `guardPauses` count by the arm a conversation was **enrolled** in — a thread
is assigned once, and "did it resolve?" is a property of the thread. `turns`
count by what **actually served** them: a canary-arm turn that ran on the live
prompt (after a Stop, or if the version vanished underneath it) is evidence for
the control arm, not for the trial version.

The report is scoped to the trial running **right now** — there is no history
endpoint, because the only question it serves is "promote or stop?". When no
trial is running it is a **404**, not an empty body: a report full of zeros would
read like a trial going badly instead of a trial that isn't happening.

### Promote

```bash
curl -X POST -H "x-api-key: $API_KEY" \
  https://api.asyncify.org/v1/agents/support-bot/canary/promote
# → 200 { "agent": {…}, "promotedFrom": 8, "version": 9 }
```

Promote **is** the restore path: the winning version's content is published as a
new version, so every change to what the agent says lands in one append-only
trail rather than arriving by a second mechanism. Then the trial ends. `404` when
no trial is running.

**One caveat worth knowing.** The control arm is whatever the live prompt says,
so editing the live prompt **while a trial is running** changes what the trial is
being compared against — the numbers already counted stay true, but the
comparison stops being one experiment. The dashboard warns about this on the
pre-save panel; nothing blocks the edit.

Typed wrappers are in `@asyncify-hq/node` (`client.agents.versions.*`,
`client.agents.canary.*`).
