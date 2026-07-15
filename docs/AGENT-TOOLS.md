# Agent tools: custom tools, human approval, and evals

A **managed** agent ships with a fixed built-in menu (`trigger_workflow`,
`set_metadata`, `resolve_conversation`, `present_buttons`, `present_choices`,
`request_input`). **Custom tools** extend that menu with *your* code: you
register a tool — a model-facing name, a description, and a JSON-Schema
parameter shape — pointed at an **HTTPS endpoint you own**. Mid-conversation
the model decides when to call it; the platform POSTs the arguments to your
endpoint, and the (2xx) response body comes back to the model as the tool
result.

This page is the runbook for the three pieces: **registering** a tool, your
**endpoint's contract** (the signed POST it must answer), and the **approval**
flow that can pause a tool behind a human. It closes with the **eval harness**
for testing that your agent actually makes the right calls.

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

## Registering a tool

### Dashboard

**Agents → (row) → Tools → Add tool.** Fill in name, description, the
Parameters JSON Schema, the endpoint URL, the **Require human approval** toggle,
and a timeout. On save the **signing secret is shown once** — copy it before
you close the dialog. Existing tools can be edited (name is immutable),
**disabled** (stays defined, model can't call it), have their **secret
rotated**, or deleted.

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
| `name` | required; must match **`^[a-z][a-z0-9_]{0,63}$`** (lowercase, starts with a letter, ≤64 chars). May **not** be a reserved built-in name: `trigger_workflow`, `set_metadata`, `resolve_conversation`, `present_choices`, `present_buttons`, `request_input`. Immutable after create; a duplicate name on the same agent → **409**. |
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

## Evals: test your prompt like you test your code

The eval harness proves your **real configured LLM**, given your **real
prompt**, makes the **right tool calls** — asserting the **tool-call trace**, not
prose vibes.

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
either a `user` message or an `expect` about the tool trace of the most recent
user turn.

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
last reply).

Full details — how the trace is reconstructed, the starter scenarios, and why
the read path is the DB — are in **[evals/README.md](../evals/README.md)**.
