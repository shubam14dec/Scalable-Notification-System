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

**Two more guardrails sit on the agent, not on a tool**: the **topic gate**
(*whether this agent should answer this message at all*) and **reply rules**
(*whether what it wrote may ship*). They guard the conversation rather than an
action, so they have their own field reference at *Topic gate and reply rules*,
at the end of this page; the customer-facing story is section 6 of
[ASYNCIFY-AGENTS-GUIDE.md](ASYNCIFY-AGENTS-GUIDE.md).

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
| `candidate` | `{ systemPrompt?, model?, routing?, topics?, moderation? }` — grade **this** config instead of the agent's live one. At least one of the five keys (an empty object is a **400**, not "use the agent's config"). `systemPrompt` 1–100,000 chars, `model` 1–255 — the same caps the agent-create route enforces, because a candidate must be something the agent could actually be saved with. `routing` takes the agent field's own `{enabled, cheapModel}` shape (*Model routing*, below) or `null`; `topics` and `moderation` take theirs (*Topic gate and reply rules*, below) or `null` — the **same** schema objects the agent routes validate against, not copies of them. |

**`candidate.routing` has three states, and the difference between them is the
contract.** Turning the router on is a behavior change like a prompt edit — the
reply comes from a different model — so a check that graded it on the strong
model would grade the one config you are *not* about to ship:

- **absent** — no opinion; the router steps aside for the whole run (this is
  every canary turn and every prompt-only pre-save check, byte for byte).
- **`null`** — "routing OFF for this turn", explicitly graded. `{"candidate":
  {"routing": null}}` is a complete, valid body: *does it still pass without the
  router?* is a real question to ask of a save that switches routing off.
- **an object** — route this run with **this** config, not the agent's. The run
  really executes through it: cheap model first, safe-tool law, escalation.

**`candidate.topics` and `candidate.moderation` have the same three states and a
deliberately different `absent`.** Absent means **the agent's live gate applies to
the run** — not "step aside". The difference from `routing` is the design, not an
oversight: routing decides *who answers*, so an unopinionated candidate must not be
rerouted onto a model nobody asked to grade; the two gates decide *whether anyone
answers* and *what may ship*, and a check that quietly ran without them would pass
an agent that doesn't exist. `null` is the only way to say "grade it with this gate
off", which is a real thing to ask of a save that removes one.

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

## Model routing: a cheap model for the easy turns

A managed agent can answer its **conversational** turns on a small model and keep
the strong one for turns that do something. It is a field on the agent, not a
separate resource:

```bash
curl -X PATCH -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/agents/support-bot \
  -d '{ "routing": { "enabled": true, "cheapModel": "claude-haiku-4-5" } }'
# → 200 { "agent": { …, "routing": { "enabled": true, "cheapModel": "claude-haiku-4-5" } } }
```

| Field | Rules |
|---|---|
| `enabled` | required boolean. |
| `cheapModel` | optional, ≤255 chars — but **required when `enabled`** (else a **400**, `cheapModel is required when routing is enabled`). Optional in the object so you can switch the router off without losing the id you typed; stored as `""` when absent, which reads the same as `enabled: false`, so a half-filled config can never accidentally route. |

There is **no default** `cheapModel`, deliberately. Routing rides this agent's own
key and `llm.baseUrl`, so only ids that endpoint actually serves can work — a
guessed default would 400 on every turn, which is a 100% escalation rate plus a
wasted round-trip per turn. A wrong id is *safe* (see below), not free.

**`null` clears, absent leaves it alone.** On `PATCH`, omitting `routing` changes
nothing and `"routing": null` puts the agent back to never-configured. On create
(`POST /v1/agents`) `null` is a **400** — there is nothing to clear yet. The agent
object always carries `routing`, `null` when it was never configured.

**Managed only.** `routing` on a bridge agent is a **400** (*"a bridge agent's
brain is your own code, not a model we choose"*), and on `PATCH` that test is made
against what the agent will **be** after the patch, not what it was — so a
managed→bridge conversion is rejected if it also sets a router. Clearing is
exempt: `"routing": null` alongside `"runtime": "bridge"` is allowed, because
switching the router off in the same request is never wrong.

### The escalation law

Every routed turn runs on `cheapModel` **first**, with an identical request — same
system blocks, same cache marker, same tool menu, same messages. Then the whole
response is inspected **before any tool executes**:

- Only text, or only **safe** tools → the cheap reply ships. The safe set is
  exactly `set_metadata`, `remember`, `resolve_conversation`: bookkeeping that
  touches nothing outside the conversation, plus the eval-pinned "customer said
  thanks, close it" archetype (reversible — her next message reopens the thread).
- **Any other `tool_use`** → the attempt is discarded and the **entire turn
  re-runs from scratch** on the agent's own model, in a clean room: fresh
  messages, fresh model-call budget, and no trace of the cheap attempt in the
  strong model's context. `trigger_workflow`, every custom tool, `search_*`,
  `handoff_to_human` and the presentation tools are all in this half.

Membership is by **name against a closed set**, so an unknown tool — including
every tool you register — is unsafe by construction. Nothing here is a model
judging a model: the signal is which tool was reached for.

**Errors escalate too.** A cheap model that 400s on an unknown id, rejects the key
or returns something unparseable is a *routing* fault, and a routing fault must
never cost a customer their answer: it warns and escalates. A misconfigured router
degrades to pre-routing behavior, one wasted round-trip per turn.

**What an escalation does not undo.** A response is inspected whole, so a mixed
one executes nothing — but a turn is several responses, and a safe tool executed
on an earlier round is already committed. It is not rolled back; all three safe
tools are idempotent by content (`set_metadata` merges, `remember` is a keyed
upsert with a content-derived dedupe breadcrumb, `resolve_conversation` updates
`where status <> 'resolved'`), so the strong re-run lands on the same state. In
particular a resolve does **not** end the turn loop, so "resolved, then
escalated" is reachable: the resolve stays committed and the turn still reports
`resolved: true`, because the row *is* resolved.

**Precedence: candidate > routing > agent default.** An eval or canary run grades
the config it was **given**, so a candidate turns the router off for that turn —
unless the candidate names a `routing` of its own (*Running evals from the API*,
above), in which case the router is part of what is being graded.

**Per-turn attribution.** A reply written by a routed turn carries
`raw.routing = {model, escalated, trigger?}` on its transcript row: the model that
actually served the reply, whether the turn escalated, and — for tool-triggered
escalations only — which tool triggered it. `trigger` is deliberately absent on
*error* escalations, so an escalation rate can never lie about why. The key is
absent entirely when routing was off, so unrouted and pre-routing rows are
byte-identical to what they were. The Turn Inspector renders an escalated turn as
what it was: two model calls, on two different models, one of them wasted.

**Cost, plainly.** A cheap turn costs a fraction of a strong one; an escalated
turn costs ≈1.05–1.15× a plain strong turn (the discarded attempt is billed —
discarded from the model's context, never from the bill) plus the cheap call's
latency in front of the normal turn. The win depends on how much of your traffic
is conversation, which is what the stats route measures.

### `GET /v1/agents/:identifier/routing/stats`

```jsonc
// → 200
{ "windowDays": 7, "replies": 1240, "cheapReplies": 769,
  "escalatedReplies": 223, "unroutedReplies": 248 }
```

The window is **fixed at 7 days** and echoed back, so a caller's sentence can
never drift from the number beside it. `replies` is **one denominator** — every
reply this agent sent in the window — and the three buckets sum to it exactly:
served cheap, escalated to the main model, and `unrouted` (no routing recorded at
all: the router was off when they were sent, or they predate it). Two
denominators would make incomparable numbers look comparable.

**Canary-trial replies are excluded from all four numbers.** A canary-arm turn
runs on the trial's own model, because candidate beats routing — so the router was
never offered it, and counting it would silently depress the cheap share.

**400** on a bridge agent, **404** on an unknown one.

Typed wrappers are in `@asyncify-hq/node` (`client.agents.update(id, {routing})`).

## Topic gate and reply rules: the two agent-level gates

The guards above ride a **tool**. These two ride the **agent** and guard the
conversation itself: `topics` decides whether the agent should be answering this
message at all, `moderation` decides whether what it wrote may ship. Both are
plain fields on the agent, both are **managed-only**, and both are **off until
configured** — which is what every agent was before they existed. The
customer-facing story is section 6 of
[ASYNCIFY-AGENTS-GUIDE.md](ASYNCIFY-AGENTS-GUIDE.md).

### `topics` — the inbound gate

```bash
curl -X PATCH -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/agents/support-bot \
  -d '{ "topics": {
        "deny": ["medical advice", "legal questions"],
        "allow": ["orders and delivery", "returns"],
        "redirect": "I can only help with orders and returns here — for anything else, email support@acme.com."
      } }'
# → 200 { "agent": { …, "topics": { "deny": [...], "allow": [...], "redirect": "…" } } }
```

| Field | Rules |
|---|---|
| `deny` | optional array, **≤24** entries, each **1–120** chars. Topics the agent must never engage with. |
| `allow` | optional array, same bounds. When non-empty it is **exhaustive** — anything the classifier can't place inside it is off-topic, including "none of these". |
| `redirect` | **required**, **1–2,000** chars. The canned reply a blocked message gets, sent word for word. There is no default: a policy that blocks without saying anything is a mute button, not a boundary. |

At least one of `deny` / `allow` must be non-empty, or the request is a **400**
(`topics needs at least one deny or allow label`) — there is nothing to classify
against otherwise. **Deny beats allow**: a label in both lists is dropped from
`allow`, so an operator who contradicts themselves gets the safer half. The caps
are the same constants the runtime normalizes a *stored* policy against, imported
rather than retyped — two copies of a bound is two bounds, and the day either
moved you would save a 25th label the gate then silently dropped.

**How a turn is decided.** Before the brain — and therefore before the router, so
one classification governs the turn whichever model would have served it — a single
model call is forced through a `classify_topic` tool with a **closed enum**:
`deny + allow + in_lane`. It sees the inbound message plus the last **6** user/agent
rows (enough to resolve *"will it interact with my prescription?"*; tool
breadcrumbs and deleted rows excluded), fenced between sentinel markers as
untrusted data. The label comes back; then `deny` → blocked, or `allow` non-empty
and the label isn't in it → blocked. `in_lane` falls in that second branch on
purpose: an exhaustive allow list doesn't cover "nothing in particular" either.

**The classifier is never told which labels are denied**, never sees the redirect,
and is never asked whether to answer. Policy is applied afterwards, in code, where
it is deterministic and cannot be talked out of — a model told "this one is
forbidden" starts hedging toward the safe-looking label instead of the true one,
and the true one is the only thing the code can act on.

**Which model runs it.** The routing cheap model when routing applies to the turn
(*Model routing*, above — same precedence, so the routing decision that governs the
turn governs the classifier in front of it), otherwise the model that would have
served the turn. A closed-label, one-word answer is the archetypal cheap-model job.
The call's tokens are folded into the agent's **daily token budget** like any other
spend, so a gated agent's cheapest turns are not the only ones its breaker can't
feel.

**When it blocks:** the `redirect` ships through the ordinary reply path (same
insert, same delivery), the brain never runs, and the reply is tagged
platform-authored so it is never replayed to the model as an assistant turn. A
breadcrumb row records the label, the list, the model and the call's usage. Nothing
is written when a message is in lane — a receipt on every ordinary turn would be a
row per turn to record that nothing happened.

**When it can't decide, it steps aside.** Unusable output buys exactly one re-ask
naming what was wrong; a second unusable answer ends the gate's involvement. Every
failure mode — no usable client, a call that throws, a timeout, unusable twice —
logs a warning, returns `skipped`, and the turn runs **ungated**. Failing the other
way would mute an agent's entire traffic behind one canned sentence with nothing in
the transcript to say why: a gate that is down is a gate that is off.

**Storage is jsonb and it is normalized on read**, because a column can hold
whatever a migration or a hand-run `UPDATE` left there: entries are trimmed, capped,
and deduped, and the reserved label `in_lane` is dropped from an operator's own
lists (a deny list containing it would block every message on earth; an allow list
containing it would allow every one). A row that fails the structural requirements
is not an error raised at a customer — it is an agent with no gate.

### `moderation` — the outbound gate

```bash
curl -X PATCH -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/agents/support-bot \
  -d '{ "moderation": {
        "denyPhrases": ["guarantee", "risk-free"],
        "blockPii": true,
        "fallback": "Let me get a teammate to confirm this for you — someone will follow up shortly."
      } }'
```

| Field | Rules |
|---|---|
| `denyPhrases` | optional array, **≤100** entries, each **1–200** chars. Matched **case-insensitively as substrings**, so `guarantee` also catches `guaranteed`/`guarantees`. |
| `blockPii` | optional boolean, default false. Blocks email addresses and phone numbers that are not **this subscriber's own**. |
| `fallback` | **required**, **1–2,000** chars. What ships instead of a blocked reply. No default, for the same reason `redirect` has none. |

At least one deny phrase **or** `blockPii: true`, else **400**
(`moderation needs at least one deny phrase or blockPii`) — a policy that matches
nothing would make every reply pay a scan to reach the answer it would have reached
anyway. Phrases are trimmed and deduped case-insensitively.

**Zero model calls, zero added latency.** This is a pure in-process check over a few
kilobytes — no I/O, no clock, no config reads — which is why it can run on every
reply of every agent that has it without the operator trading reply speed for it.

**Substring, not word boundary, and that is a decision.** An operator who has to
enumerate `guarantee`, `guaranteed`, `guarantees`, `guaranteeing` will miss one, and
a guard that lets all three through while looking like it works is the worst
property a guard can have. The cost is over-matching inside unrelated words (`cure`
in `secure`), and the fix for an over-broad phrase is a **longer** one — `a cure
for` rather than `cure`. Padding with spaces is deliberately *not* an escape hatch:
phrases are trimmed, so a stray trailing space can never quietly disarm a rule.

**The PII rule's boundary, stated exactly**, because an order number that trips a
privacy guard is a support bug. Emails match what an address looks like in prose.
A phone candidate is a run of digits and phone separators bounded by
non-alphanumerics; it is a phone number when it carries **7–15 digits** *and* wears
one of four shapes: a leading `+` or `(`; a single unbroken run; 10+ digits with
every group after the first ≥3 digits; or exactly 3-separator-4. Deliberately
**not** matched: `#1042`, `1042-2024`, `2026-08-24`, `1,234,567.89`, `12:30`,
`1Z999AA10123456784` (`,` and `:` are not separators, which is what keeps money and
times out). Knowingly **over**-matched: a bare 7–15-digit run with no `#` and no
separators is indistinguishable from a local number by shape alone — an opt-in
privacy guard errs toward blocking.

**The subscriber's own details are exempt**, or the agent couldn't confirm the
address on their own account. Email is compared as the **exact** address, normalized
for case and surrounding punctuation — never the domain, since excluding
`@acme.com` wholesale would wave through `someone-else@acme.com`, which is exactly
the leak the rule exists for. Phones compare on **digits only**, with a suffix
allowance floored at 7 digits so a stored `+1 555 123 4567` matches `5551234567`
without making every number ending in `4567` "their own".

**Phrases are checked before PII**, and the order is reported as well as executed: a
deny phrase is a rule the operator *wrote*, so when both would fire, naming theirs
beats naming a built-in they can't edit. An empty or whitespace-only reply passes —
there is nothing in it to leak.

**When it blocks:** the `fallback` replaces the reply and ships **bare** — buttons
and cards drafted in the same breath are dropped, because "Yes, refund it" under a
fallback that no longer offers a refund is worse than no buttons. Nothing is rolled
back: **the turn's tools have already run**, a resolve stays resolved, and the
breadcrumbs stay. That tension has one mitigation and it is editorial — write the
fallback knowing actions may have completed (*"a teammate will follow up"* is always
true; *"I wasn't able to help"* can be a lie). The platform-authored fallback is
tagged like the redirect, so the model never learns to imitate it.

**What is exempt from this check:** the topic gate's redirect and the budget-pause
note. Both are platform-shipped canned text set before the brain branch — checking
an operator's own redirect against their own deny phrases is circular, and the only
outcome it could produce is a redirect that blocks itself into a second canned
sentence. This gate exists to check what the **model** wrote.

**The breadcrumb and the ops alert.** A blocked reply writes a breadcrumb row
carrying the rule, the match (the configured *phrase* for a phrase hit; the matched
address itself for a PII hit, since there is no configured value to name) and **the
blocked text**, which is the only place it survives — without it an operator can't
tell a leak they were saved from apart from a rule that is too broad, and those need
opposite fixes. It also raises the reserved `agent-approvals` ops alert (same
audience as approvals and the budget breaker) — when that workflow and the
`approvals` subscriber both exist; when they don't, nothing is sent and no hour is
spent. Debounced to **once per agent per UTC hour**, it carries:

```jsonc
{ "agentIdentifier": "support-bot", "rule": "pii",
  "conversationId": "…", "blockedPreviousHour": 14 }
```

`blockedPreviousHour` is what makes the alert worth reading: the alert fires on the
first block of an hour, so its own hour's count is always 1, while the hour *before*
separates "the agent said something it shouldn't have, once" from "a broken prompt
has been blocking every turn since midnight". **The payload deliberately omits the
match and the blocked text.** This alert is delivered by a workflow the *tenant*
wrote, whose steps can email or SMS it anywhere; forwarding the phone number we just
stopped leaking to one customer would relocate the leak rather than stop it. The
text stays in Postgres.

### Shared rules for both gates

**`null` clears, absent leaves it alone, an object replaces it whole.** On `PATCH`,
omitting the field changes nothing, `null` puts the agent back to never-configured,
and an object **replaces** the stored policy — there is no merge, on purpose: a
half-updated deny list is a guard nobody can reason about. On create
(`POST /v1/agents`) `null` is a **400** — there is nothing to clear yet. The agent
object always carries both fields, `null` when never configured.

**Managed only.** `topics` or `moderation` on a bridge agent is a **400** — a bridge
agent's brain is your own code, so what it will discuss is decided there, and its
replies are written by your own code, which is where to check them. As with
`routing`, `PATCH` judges the runtime the agent will **be** after the patch, and
clearing is exempt: `"moderation": null` alongside `"runtime": "bridge"` is allowed,
because switching a gate off is never the wrong answer for an agent that cannot run
it.

**Both trip the pre-save check.** A gate edit is a behavior change of the bluntest
kind, so the dashboard sends it as a `candidate` and the scenarios really execute
behind the edited gate (*Running evals from the API*, above) — including when the
new value is "off", because *does it still pass without this boundary?* is the whole
question that save is asking.

**What these gates are not.** `moderation` is **not** a content-safety classifier
and must never be described as one: it matches phrases an operator typed and two
built-in contact-detail shapes, so it cannot catch a paraphrase — blocking
`guarantee` has not blocked *"you have my word"*. That limit is the honest price of a
check that costs nothing and can never be down. `topics` does read meaning rather
than spelling, but it is a classifier naming a topic against a closed list, not a
moderator: what happens to that topic is the operator's lists, applied in code.

Typed wrappers are in `@asyncify-hq/node`
(`client.agents.update(id, { topics, moderation })`).

## `subscriberRate` — the per-customer message limit

The two gates above decide what an agent will discuss and what it may say. This
field decides **how often one end user gets to ask**, per agent, in a window the
operator chooses. It is **off until configured**, and it is the one agent-level
policy that is **not** managed-only. The customer-facing story is section 6 of
[ASYNCIFY-AGENTS-GUIDE.md](ASYNCIFY-AGENTS-GUIDE.md).

```bash
curl -X PATCH -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/agents/support-bot \
  -d '{ "subscriberRate": {
        "maxMessages": 20,
        "windowMinutes": 5,
        "notice": "Thanks — that is faster than I can answer. I will pick this back up shortly."
      } }'
# → 200 { "agent": { …, "subscriberRate": { "maxMessages": 20, "windowMinutes": 5, "notice": "…" } } }
```

| Field | Rules |
|---|---|
| `maxMessages` | **required**, integer **1–1,000**. Messages from one subscriber that pass per window; the `maxMessages + 1`-th is suppressed. `1` is a real (if brutal) setting for an abusive subscriber; past 1,000 in a window the limit stops being a limit and the daily token budget is the honest tool. |
| `windowMinutes` | **required**, integer **1–1,440**. One minute is the tightest burst window worth expressing; 1,440 is one day, past which a fixed window stops resembling anything a customer experiences as "slow down". |
| `notice` | **required**, **1–2,000** chars, **trimmed**. What a throttled customer is told, once per window. No default, for the same reason `redirect` and `fallback` have none. |

All three are required and each is a real guard: a cap with no window is not a
rate, a window with no cap is not a limit, and a limit with no notice is a
customer talking to a wall — their messages still land in the transcript, so they
would reasonably send more, and a silent limit manufactures the flood it exists
to stop. The bounds are the same constants the runtime validates a *stored*
policy against, imported rather than retyped.

**A whitespace-only `notice` is a 400**, which is one step stricter than
`redirect`/`fallback`, where the same shape is caught in the dashboard form
alone. The SDK does not go through the form, and the runtime trims the notice and
reads an empty one as **no limit at all** — so a lone space accepted here would
store a limit that silently does nothing while the operator reads it back from
this API and believes it is armed.

**`null` clears, absent leaves it alone, an object replaces it whole** — the same
`PATCH` semantics as the two gates, and `null` on create (`POST /v1/agents`) is a
**400** because there is nothing to clear yet. The agent object always carries
the field, `null` when never configured.

**Both runtimes, and that is the design.** `topics` or `moderation` on a bridge
agent is a **400**; `subscriberRate` on a bridge agent is a **200**. The gates are
brain config — they stand between a bridge customer and their own code, so storing
one would store a policy nothing reads. This is **ingress protection**, applied
above the managed/bridge fork: a flooding customer costs a bridge agent its own
compute and its own bill just as surely as it costs a managed agent tokens.
A limit therefore also survives a managed → bridge conversion.

**Where the check runs, stated honestly.** Not at ingress — there is no ingress in
this system to put it at (nine independent enqueue sites, no shared helper, and a
helper would be a rule every future channel's author has to remember), so it runs
at **the top of the turn job**, which every customer message on every channel in
either runtime reaches by construction. The accepted cost is one enqueue and one
immediately-returning job per suppressed message that a route-level check would
have saved; what it does not cost is the turn — no brain, no classifier, no tools,
no model call, no history read, no typing pulse. Operator replies and proactive
pushes are a different job kind and never enter; the platform's own follow-up
turns are `system` rows and are not counted against the customer. An agent with
`subscriberRate: null` pays a single null comparison and no Redis round trip.

**Counting is a fixed window, and `windowMinutes` is part of the key.** One `INCR`
plus one `EXPIRE` per inbound message on an epoch-aligned bucket — not a sliding
window, which would cost a sorted set per subscriber and a memory footprint
proportional to traffic. The price is boundary precision: a burst straddling two
adjacent buckets can pass up to 2 × `maxMessages`. This is a circuit breaker for a
flood, not a billing meter. Because the window length is *in* the key, retuning
`60` → `5` starts a **fresh series** rather than inheriting an hour-sized count
into a five-minute window and throttling everyone in it for the rest of the hour.
Button and card taps count: a tap flood enqueues turns exactly like a typed one.

**When it trips:** the message row still lands (the transcript stays truthful) and
no turn runs. The `notice` is claimed **once per window** by an atomic `SET NX`, so
a customer who pushes two hundred messages into a closed window is told once, not
two hundred times — it ships through the ordinary reply path, tagged
platform-authored so the model never learns to imitate it. The window's first
suppression also writes a breadcrumb row (`raw.rateLimit`: the configured cap, the
window, the count — a named key, never `raw.action`, which would replay to the
model as a phantom tool) and raises the reserved `agent-approvals` ops alert when
that workflow and the `approvals` subscriber both exist. Debounced to **once per
UTC hour per (agent, subscriber)** — deliberately unlike the reply-rules alert's
per-agent debounce, because this alert's whole actionable content is *which*
customer, and an agent-wide window would hide the hour's second offender behind
its first:

```jsonc
{ "agentIdentifier": "support-bot", "subscriberExternalId": "…",
  "conversationId": "…", "maxMessages": 20, "windowMinutes": 5,
  "suppressedPreviousHour": 312 }
```

`suppressedPreviousHour` counts every suppressed message, not just the ones that
produced a notice, and reports the **previous** hour for the same reason
`blockedPreviousHour` does: the alert fires on the hour's first suppression, so
its own hour's count is always 1. **The payload carries who and how much, never
what.** Not one character of the customer's messages travels in it — the alert is
delivered by a workflow the tenant wrote, whose steps can email or SMS it
anywhere, and a flood is often someone upset about the most sensitive thing they
have to say. The content stays in Postgres.

**Storage is jsonb and out-of-range reads as OFF, never clamped.** A stored
`maxMessages: 100000` (a migration, a hand-run `UPDATE`, a future SDK) switches
the limit off rather than throttling at 1,000: a limiter that silently invents its
own threshold leaves the operator's mental model wrong, while reading it as off is
exactly the behavior every agent had before this existed. **If Redis is
unavailable the check is skipped with a warning and the turn runs unlimited** —
the asymmetry runs the opposite way to a gate here, because a limiter that failed
*closed* would mute every customer of every limited agent, turning a counter's
hiccup into a platform outage.

**It does not trip the pre-save check**, and there is no `candidate.subscriberRate`
to send it in — deliberately, and it is the only agent-level policy that skips it.
The gates change what the agent *says*, so an edit to one must be graded; a message
limit changes whether a *flood* is answered, and an eval run's scenario turns are a
burst from one synthetic subscriber by construction, so a gradeable limit would
throttle the check itself and report the limiter's behavior as the prompt's. The
eval driver carries an **explicit** exemption flag for the same reason (never
inferred from the run's shape, and never accepted from a request body).

Typed wrapper: `client.agents.update(id, { subscriberRate })` in
`@asyncify-hq/node` (`AgentSubscriberRate`).

## The kill-switch — `pause` / `resume`

Every knob above is a policy set in advance. This pair is the **manual** control
for the moment something is wrong right now: one button stops an agent from
answering **without refusing its customers**. The operator-facing story is
section 13 of [ASYNCIFY-AGENTS-GUIDE.md](ASYNCIFY-AGENTS-GUIDE.md).

```bash
curl -X POST -H "x-api-key: $API_KEY" \
  https://api.asyncify.org/v1/agents/support-bot/pause
# → 200 { "agent": { …, "pausedAt": "2026-08-26T09:14:02.118Z" } }

curl -X POST -H "x-api-key: $API_KEY" \
  https://api.asyncify.org/v1/agents/support-bot/resume
# → 200 { "agent": { …, "pausedAt": null } }
```

**No body, on either route.** The state is one timestamp — `pausedAt` on the
agent object, `null` when live — and it is deliberately **not** a third value of
`status`: `disabled` keeps its hard-off meaning, and a timestamp answers *when*,
which is what an incident review asks. Unknown identifier is a **404**.

**Both are idempotent, and that is the requirement rather than a shortcut.**
Pausing a paused agent is a `200` no-op; so is resuming a live one. The person
pressing this twice is not reading a response body — they are checking that it
worked, at 3am, while something is on fire, and a `409` there would read as *"the
pause failed"* and send them hunting for a second lever that doesn't exist.

**Both runtimes.** Unlike the brain-config knobs (versions, canary, `routing`,
`topics`, `moderation`), these never `400` a bridge agent. An agent whose brain
is the customer's own code is exactly the agent an operator cannot fix by
deploying; for it, the pause means Asyncify stops POSTing turns to their service.

**Neither route runs the pre-save check, and neither mints a prompt version.**
The check grades *config* changes — "does this new prompt still behave?" — and a
pause changes no config and asks no such question. Making an emergency stop wait
on an eval run would be the worst place in the product to add latency.

**What a paused agent does with an inbound message**, in order, at the top of the
turn job — the same chokepoint the per-customer limit uses, so no channel can
bypass it:

| | While paused |
|---|---|
| The message row | **lands, always.** Nothing here or in the channel webhooks reads the pause, so it can never become a `409` at the door — that is `disabled`'s job, and during an incident the customer's words are the evidence |
| The brain | never runs — no model call, no tool call, no bridge POST, no topic classifier, no history read, no typing pulse |
| The customer | gets one platform-authored holding line: *"Our team is taking over this conversation — a person will be with you shortly."* Claimed **once per conversation** by the shipped reply row itself, not once per message |
| The conversation | moves to `waiting_human` through P26's real transition — so the operator queue lists it, the D2 gate holds the customer's *next* message, and handback works afterwards |
| The transcript | gets a breadcrumb per hold episode: a named `raw.pausedHold` key (`{ pausedAt, runtime, notice }`), never `raw.action`, which would replay to the model as a phantom tool |

**Order against the neighbouring gates, because each ranking is a ruling.**
*After* the D2 human-pen gate: a thread a person already owns is held by a
stronger claim, and shipping platform prose into an operator's live conversation
would talk over them mid-sentence. *Before* the `subscriberRate` limiter: a
paused agent must never say *"you're sending faster than I can answer"* — a
sentence about an agent that is answering — so the limiter's whole block is
skipped and a held turn doesn't even spend the `INCR`. *Before* the token
budget, the canary snapshot, the topic gate, routing and the brain, none of which
a held turn reaches. A **live** agent pays one null comparison on a row already
in hand.

**The breadcrumb's granularity is once per hold *episode*, not once per message.**
The first held turn routes the conversation to `waiting_human`, so the customer's
next message is stopped by the D2 gate above and never reaches this code. A
*second* breadcrumb on one conversation therefore means something specific and
worth seeing: a human took it, handed it back, and the still-paused agent had to
hold it again.

**Evals are exempt, and that exemption is what makes the drill possible.** The
eval driver runs real turns through the same function against a synthetic
subscriber, and holding those would push robots into the operator's real incident
queue *and* make it impossible to verify a fix before resuming — which is the
exact sequence a kill-switch exists to enable: pause, diagnose, run the
scenarios, resume. It is an **explicit** flag on the eval driver, never inferred
from the caller's shape and never accepted from a request body — the same
discipline as the eval driver's rate-limit and canary exemptions.

**Resume does not reclaim conversations.** Clearing `pausedAt` makes new turns
run normally; a conversation sitting with an operator stays theirs until they
hand it back (P26 semantics, unchanged). A sweep that yanked conversations back
from people mid-reply the moment someone pressed Resume would be a second
incident.

**`pausedAt` is operational state, never config.** It is not in the config file
below, it is not settable through `PATCH /v1/agents/:identifier`, and an import
neither pauses a live agent nor resumes a paused one.

Typed wrappers: `client.agents.pause(identifier)` / `client.agents.resume(identifier)`
in `@asyncify-hq/node`; `Agent.pausedAt` carries the state.

## Config as code — `export`, `import/preview`, `import`

One JSON document describes an agent completely enough to recreate it in another
environment: identity, the six knobs, custom tools with their guards, the
knowledge it reads and the workflow keys its prompt names. **No secret is ever
serialized** — not the LLM key, not the agent signing secret, not a tool's call
secret. The file is safe to commit because there is nowhere in it for a
credential to hide, not because a redaction step remembered to run. The
operator-facing story is section 13 of
[ASYNCIFY-AGENTS-GUIDE.md](ASYNCIFY-AGENTS-GUIDE.md).

### `GET /v1/agents/:identifier/export`

```bash
curl -H "x-api-key: $API_KEY" \
  https://api.asyncify.org/v1/agents/support-bot/export > support-bot.agent.json
```

**The body IS the file** — no envelope — so the redirect above writes something
the import route accepts and a human can read in a pull request. Unknown
identifier is a **404**. Both runtimes export: a bridge agent carries its tools
and knobs too, and `runtime` says which kind it is.

| Key | What it holds |
|---|---|
| `formatVersion` | `1`. A file declaring a version **above** the API's is refused; unknown *keys* are ignored, which is the opposite asymmetry on purpose — silently dropping a key you don't know is safe, silently mis-reading a changed shape is not |
| `identifier` | **required**, the file's primary key. It is what decides create-vs-update on import |
| `name`, `description`, `runtime`, `bridgeUrl`, `model`, `systemPrompt`, `llmBaseUrl`, `context`, `welcomeMessage`, `suggestedPrompts` | the agent's identity and brain config; `runtime` (`bridge` \| `managed`) and `name` are required |
| `routing`, `topics`, `moderation`, `subscriberRate`, `maxTokens`, `maxDailyTokens`, `autoResolveMinutes` | all six guardrail/behaviour knobs plus the reply cap and idle backstop. Values ride as opaque JSON here on purpose — the *ranges* are stated once, in the save schemas, and the import runs every knob through those very objects |
| `tools` | up to 200; each `{ name, description, parameters, endpointUrl, approval?, timeoutMs?, guard? }` — the `guard` block travels intact |
| `knowledge` | up to 200 **references**: `{ name, origin }`, where `origin` is the source URL or the literal `"text"` for pasted prose. Chunk text and embeddings are **not** in the file |
| `workflows` | up to 100 workflow **keys** the agent's prompt names — requirements to check, never workflows to create |

**Not in the file, deliberately:** every secret; `status` and `pausedAt`
(operational state — an import must not disable a live agent or resume a paused
one); `promptVersion` and the canary (history and trials belong to the
environment they happened in).

**Absent is absent.** A knob that was never configured is *omitted* rather than
written as `null`, so a config file reads as a list of decisions someone made
rather than a form with fifteen blanks. Lists are sorted by name, so two exports
of the same agent are byte-identical regardless of row order — which is what
makes `git diff` on these files worth reading.

**Disabled tools are not exported.** A disabled tool isn't part of what the agent
does, and `status` doesn't travel — exporting one would silently re-enable it in
the target environment, precisely the surprise config-as-code exists to prevent.

**`workflows` is derived by scanning the prompt** for the tenant's real workflow
keys (boundary-anchored, so a workflow keyed `ship` doesn't match "shipping").
There is no agent→workflow table to read: the managed brain offers
`trigger_workflow` with the whole workflow list as an enum, so an agent's real
dependency is exactly the set of keys its prompt tells the model to trigger. It
is a heuristic, and both failure modes are benign — a key the prompt never
mentions isn't exported, and a spurious match only adds a requirement the source
environment provably satisfies.

**`bridgeUrl` and `llmBaseUrl` do travel**, and that call is deliberate: both are
endpoints rather than credentials, both are already returned by
`GET /v1/agents/:identifier` to any holder of an API key, and a bridge agent
whose file omitted its own bridge URL couldn't be recreated at all. The pairing
risk lands on the other side — the key never travels, so an endpoint on its own
dials nothing. Import treats them accordingly (below).

### `POST /v1/agents/import/preview`

```bash
curl -X POST -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/agents/import/preview \
  -d "{ \"file\": $(cat support-bot.agent.json) }"
```

| Body field | Rules |
|---|---|
| `file` | **required**, the parsed config file (an object, not a string). Shape-checked by the format owner; a malformed file is a **400** `invalid config file` with the field-level issues under `details` |
| `llmApiKey` | optional, **8–512** chars — the *target* environment's LLM key. Never in the file; it travels in the request, once. Preview accepts it but stores nothing |

Response:

```jsonc
{ "identifier": "support-bot",
  "mode": "update",                     // or "create" — no agent with this identifier here
  "changes": [ { "field": "systemPrompt", "action": "changed" },
               { "field": "maxDailyTokens", "action": "added" },
               { "field": "topics", "action": "removed" },
               { "field": "model", "action": "unchanged" } ],
  "toolChanges": { "added": ["lookup_order"], "changed": ["refund_customer"],
                   "removed": ["legacy_ping"] },
  "removalPolicy": "kept",
  "missingWorkflows": [],               // keys this environment does not have
  "missingKnowledge": ["refund-policy"],// references the target agent lacks
  "needsLlmKey": false }
```

**Read `removed` carefully — it describes the FILE, not the outcome.** Nothing is
removed by an import, which is what `removalPolicy: "kept"` says out loud so a UI
cannot render the word as a threat. A field the file doesn't mention keeps its
stored value; a tool on the agent that the file doesn't mention is left exactly
where it is. An import must not destroy what the file's author never knew about,
and deleting a tool stays an explicit act done by someone who can see what calls
it. `changed` means *the file's value wins*; `added` means the agent has nothing
there yet.

**The live side is compared through the serializer** — the stored agent is turned
into the file it *would* export as, and the two files are diffed. So "export,
change nothing, import" is guaranteed to report nothing, and normalisation can
never manufacture a spurious `changed` row.

**Tools reconcile by name**, which is the only stable identity a file can carry:
a tool name is immutable and unique per agent, while a row id would be
meaningless in the target environment. Only the fields a file *states* are
compared, so an omitted `timeoutMs` is not read as a request to change the
timeout.

**Preview refuses everything apply would refuse, except the missing-workflow
case.** That is the whole point of two steps: a modal that says "one tool added,
prompt changed" followed by an apply that then fails on a bound the preview never
checked would be worse than no preview at all. So the knobs go through the save
schemas here, every tool endpoint goes through the tool-registration validators
and the SSRF guard here, and a `bridgeUrl` pointing at private infrastructure is
a **400** at preview rather than a promise that can't be kept. Missing workflows
are the deliberate exception — reported as a warning list so the operator can go
create them and come back.

**`needsLlmKey` is computed from the real absence**, not from what you sent: it
is `true` when the file's `runtime` is `managed` and the target has no stored
credentials — always on create, and on the `bridge → managed` conversion a file
can ask for. Preview validates with a throwaway stand-in key so it can still tell
you your 31st topic label is one too many; nothing is written and nothing is
stored.

### `POST /v1/agents/import`

```bash
curl -X POST -H "x-api-key: $API_KEY" -H 'Content-Type: application/json' \
  https://api.asyncify.org/v1/agents/import \
  -d "{ \"file\": $(cat support-bot.agent.json), \"llmApiKey\": \"$PROD_LLM_KEY\" }"
# → 201 (create) / 200 (update)
# { "mode": "create",
#   "agent": { …, "identifier": "support-bot", "promptVersion": 1 },
#   "signingSecret": "ags_…",
#   "tools": { "created": [ { "name": "lookup_order", "secret": "ats_…" } ],
#              "updated": [], "kept": ["legacy_ping"] },
#   "missingKnowledge": [] }
```

Same body as preview. **`201` on create, `200` on update.**

**Missing workflows are a `422` here**, with the offending keys in both the
message and `details.missingWorkflows`. A prompt that tells the model to trigger
a workflow this environment doesn't have is a broken agent; shipping it quietly
would make the failure a customer's problem at turn time.

**An update rides the same save path a human does**, so a changed prompt or model
**mints a prompt version** and history stays complete. A create rides the create
path, and therefore requires an `llmApiKey` for a managed agent exactly like
`POST /v1/agents` does.

**`llmBaseUrl` is only applied alongside a key.** It is the endpoint a stored key
is used against, so re-pointing it while an older key stays behind would ship
that credential somewhere its owner never agreed to. On create a key is always
present (managed agents require one); on update the file's base URL is applied
**only** if you supplied `llmApiKey` in the same request, and otherwise silently
left alone. There is no way to repoint stored credentials through an import.

**Secrets are shown exactly once, on apply.** A freshly created agent returns its
`signingSecret` (absent on an update), and every tool the import creates returns
its newly minted call secret — the file cannot carry them (that is what makes it
git-safe), so a tool's backend can never verify our calls unless the operator
takes the secret here. The dashboard's import modal refuses to auto-navigate
away while any of these are on screen.

**Tools are validated to the last one before any of them is written**, so a file
with one bad endpoint is refused whole rather than applied halfway. A tool the
file adds that raced into existence between preview and apply is not fought over:
the tool exists, which is what the file asked for.

**What an import never touches:** `status`, `pausedAt` (a paused agent stays
paused — importing a config is not an all-clear), a tool's `status` (one an
operator disabled here stays disabled), the canary, version history, and the
stored LLM credentials unless a key was supplied.

**The reader is deliberately tolerant.** Unknown keys are ignored (including
`_comment` blocks), `formatVersion` may be absent and defaults to `1`,
`workflows` entries may be full workflow objects instead of bare keys (only the
key is read), and a tool `endpointUrl` may be an env template like
`${ACME_TOOLS_URL}/refund` rather than an absolute URL — the file is a document,
and the URL law belongs to the moment we are about to dial it, so **apply** runs
every endpoint through the registration schema and its SSRF guard and refuses an
unresolved template there with the real message. This is why the repo's CI eval
fixture (`evals/agents/support-demo.agent.json`) is a valid import file **without
being edited to suit us**.

### Promoting across environments

The dashboard's **Promote to…** menu targets another environment in the same
organization by sending `x-environment-id` alongside a **user session token**;
every such request re-checks that the caller is a member of that environment's
organization. **An API-key caller cannot do this** — an API key is scoped to the
environment that issued it, and the header is ignored on that path. From a
script, the two-environment trip is two keys: export with the source
environment's key, import with the target's.

**The pre-save eval check does not run across environments** and the dashboard
says so instead of hiding it: threading a candidate config into the target's
evals would grade the wrong environment's agent, so a cross-environment promote
that changes the prompt or model shows an amber warning naming the *target's*
real enabled-scenario count and asking you to run that environment's evals from
its own tab afterwards. Same-environment imports run the full check normally.

Typed wrappers in `@asyncify-hq/node`: `client.agents.export(identifier)` returns
the file as `AgentConfigFile`, `client.agents.importPreview(file)` returns
`AgentImportPreview`, and `client.agents.import(file, { llmApiKey })` returns
`AgentImportResult`.
