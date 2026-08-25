/**
 * @asyncify-hq/node — server-side client for Asyncify.
 *
 *   const asyncify = new AsyncifyClient({ apiKey: process.env.ASYNCIFY_API_KEY! });
 *   await asyncify.trigger('order-shipped', {
 *     to: [{ subscriberId: 'user-42', email: 'u42@example.com' }],
 *     payload: { orderId: 'ORD-1' },
 *   });
 *
 * Zero dependencies — plain fetch over the REST API.
 */

export interface Recipient {
  subscriberId: string;
  email?: string;
  phone?: string;
  pushToken?: string;
}

export type Priority = 'p0' | 'p1' | 'p2';

/** A registered push device as the API returns it. */
export interface Device {
  id: string;
  token: string;
  platform: 'web' | 'android' | 'ios' | null;
  createdAt: string;
  lastSeenAt: string;
}

/** Direct recipient, or a topic reference ({ topic: "beta-users" }). */
export type TriggerRecipient = Recipient | { topic: string };

export interface TriggerOptions {
  to: TriggerRecipient[];
  payload?: Record<string, unknown>;
  priority?: Priority;
  /** Provide your own id to make the trigger idempotent across retries. */
  transactionId?: string;
}

export interface TriggerResult {
  transactionId: string;
  eventId?: string;
  duplicate?: boolean;
  priority?: Priority;
}

export interface WorkflowStep {
  channel: 'email' | 'sms' | 'push' | 'inapp';
  subject?: string;
  body?: string;
  /** Email steps: render this MJML template instead of an inline body. */
  templateKey?: string;
  delaySeconds?: number;
  digest?: { windowSeconds: number; itemTemplate?: string };
  /** All must pass; evaluated over payload + subscriber at fan-out. */
  conditions?: Array<{
    field: string;
    op: 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists' | 'not_exists';
    value?: unknown;
  }>;
  /** Skip at delivery time if an earlier step reached one of these states. */
  skipIfStep?: { stepIndex: number; statusIn: string[] };
  /**
   * Push steps only: tap-through URL, notification image, and an arbitrary
   * data bag delivered to the device. Handlebars vars are allowed in all three;
   * `data` values must be strings (max 10 keys).
   */
  push?: { clickUrl?: string; imageUrl?: string; data?: Record<string, string> };
}

/**
 * Cheap-first model routing for a MANAGED agent. Every routed turn runs on
 * `cheapModel` first; if that attempt reaches for a consequential tool (a
 * workflow, one of your own tools, a knowledge lookup) the whole turn is thrown
 * away and re-run on the agent's main model, so a small model is trusted to
 * talk and never to act. Cheap-model errors escalate too — a misconfigured
 * router degrades the bill, never the reply.
 *
 * `cheapModel` must be an id the agent's OWN endpoint serves (routing rides its
 * `llm.baseUrl` and key); there is deliberately no default, since a guessed id
 * would escalate 100% of turns. It is '' on a config that was switched off
 * without clearing the id, which reads the same as `enabled: false`.
 *
 * HAND-KEPT COPY of the server's `RoutingSchema` / `agentView.routing`
 * (src/api/routes/agents.ts); this package ships standalone and cannot import
 * server types.
 */
export interface AgentRouting {
  enabled: boolean;
  /** 1–255 chars, and required whenever `enabled` is true. */
  cheapModel: string;
}

/**
 * The TOPIC GATE for a MANAGED agent. Before the brain runs, one small
 * classifier call names what the customer's message is about; a message that
 * lands on a denied topic — or, when `allow` is non-empty, outside it — never
 * reaches the brain at all, and `redirect` is sent back verbatim instead. The
 * classifier is never told which topics are denied: it names the topic, and the
 * policy decides, so there is nothing in the prompt to argue with.
 *
 * `deny` beats `allow` wherever a label is in both, a non-empty `allow` is
 * EXHAUSTIVE, and the gate applies only when at least one list is non-empty AND
 * `redirect` is set — a policy that blocks with nothing to say would be a mute
 * button. The check costs one call on the agent's cheap model (see
 * `AgentRouting`) or its main model when it has no cheap one; if that call
 * fails, the gate is SKIPPED and the turn runs, because fail-closed would mute
 * an agent's whole traffic behind one canned sentence.
 *
 * HAND-KEPT COPY of the server's `TopicsSchema` / `agentView.topics`
 * (src/api/routes/agents.ts); this package ships standalone and cannot import
 * server types.
 */
export interface AgentTopics {
  /** Up to 24 labels, 1–120 chars each. Beats `allow` on a label in both. */
  deny?: string[];
  /** Up to 24 labels, 1–120 chars each. Non-empty = the ONLY topics handled. */
  allow?: string[];
  /** 1–2000 chars, required: the canned reply an off-topic message gets. */
  redirect: string;
}

/**
 * The REPLY RULES for a MANAGED agent — a word check over every reply the agent
 * drafts, in-process: no model, no extra call, no added latency. A reply that
 * breaks a rule is never sent; `fallback` ships in its place, with any buttons
 * or card drafted alongside it suppressed, and the blocked text is preserved on
 * a system note so the block can be triaged.
 *
 * `denyPhrases` match case-insensitively as SUBSTRINGS (`guarantee` catches
 * `guaranteed`), and they are trimmed — the fix for an over-broad phrase is a
 * longer one, never padding. `blockPii` adds two built-in patterns (email
 * addresses and phone numbers) with the subscriber's OWN contact details
 * excluded. The rules apply only when `fallback` is set AND something can match.
 *
 * WHAT THIS IS NOT: it matches typed phrases, not paraphrases — the honest price
 * of a check that costs nothing and cannot be down. And write the fallback with
 * care: by the time it ships, the turn's tools have ALREADY RUN, so "a teammate
 * will follow up" is safe where "I couldn't help" may be false.
 *
 * HAND-KEPT COPY of the server's `ModerationSchema` / `agentView.moderation`
 * (src/api/routes/agents.ts); this package ships standalone and cannot import
 * server types.
 */
export interface AgentModeration {
  /** Up to 100 phrases, 1–200 chars each. Case-insensitive substring match. */
  denyPhrases?: string[];
  /** Block an email/phone in a reply that is not the subscriber's own. */
  blockPii?: boolean;
  /** 1–2000 chars, required: the canned reply a blocked turn ships instead. */
  fallback: string;
}

/**
 * The PER-CUSTOMER MESSAGE LIMIT — how many messages ONE end user may send this
 * agent inside a fixed window before the agent stops answering THAT PERSON.
 * Everyone else is untouched, which is the whole point: the per-agent daily
 * token budget is a circuit breaker for the agent, so leaning on it as the
 * defense against one abusive customer lets that customer mute the agent for
 * every other customer.
 *
 * Over the limit, the customer's messages STILL LAND in the conversation exactly
 * as they were sent — only the turn is skipped, so the record of what someone
 * sent you stays true — and `notice` goes back ONCE per window, never on every
 * message, since a limit that answered a flood would be an amplifier. The
 * blocked messages cost no model call at all, which is the feature.
 *
 * All three fields are required (a cap with no window is not a rate, a window
 * with no cap is not a limit, and a limit with no notice is a customer talking
 * to a wall), and a config outside the bounds below reads as OFF rather than
 * being clamped — a limiter that silently invents its own threshold is worse
 * than none, because your mental model of it is then wrong.
 *
 * THE ONE AGENT CONFIG THAT IS NOT MANAGED-ONLY: unlike `routing`, `topics` and
 * `moderation`, this applies to BRIDGE agents too. It is ingress protection
 * rather than brain config, and a flood costs your own handler its compute and
 * its own bill just as surely as it costs a managed agent tokens.
 *
 * HAND-KEPT COPY of the server's `SubscriberRateSchema` /
 * `agentView.subscriberRate` (src/api/routes/agents.ts); this package ships
 * standalone and cannot import server types.
 */
export interface AgentSubscriberRate {
  /** Inbound messages one subscriber may send per window, 1–1000. Button taps count. */
  maxMessages: number;
  /** The fixed window in minutes, 1–1440. Fixed, not rolling: the count restarts when it ends. */
  windowMinutes: number;
  /** 1–2000 chars, required: the canned reply the FIRST over-limit message gets, once per window. */
  notice: string;
}

/** An agent as the API returns it — secrets (signing, LLM key) never included. */
export interface Agent {
  identifier: string;
  name: string;
  description: string | null;
  runtime: 'bridge' | 'managed';
  bridgeUrl: string | null;
  model: string | null;
  systemPrompt: string | null;
  llmBaseUrl: string | null;
  maxTokens: number | null;
  autoResolveMinutes: number | null;
  hasLlmKey: boolean;
  /**
   * The prompt snapshot the agent is serving right now. Every managed save that
   * CHANGES the prompt or model mints the next number; meaningless on a bridge
   * agent, which has no prompt to version.
   */
  promptVersion: number;
  /** The trial running right now, or null when none is — see `agents.canary`. */
  canary: AgentCanary | null;
  /** Cheap-first model routing, or null when it was never set up. Managed only. */
  routing: AgentRouting | null;
  /** The topic gate's policy, or null when it was never set up. Managed only. */
  topics: AgentTopics | null;
  /** The outbound reply rules, or null when never set up. Managed only. */
  moderation: AgentModeration | null;
  /** The per-customer message limit, or null when never set up. EITHER runtime. */
  subscriberRate: AgentSubscriberRate | null;
  status: 'active' | 'disabled';
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentOptions {
  identifier: string;
  name: string;
  description?: string;
  /** 'bridge' (default): we POST turns to your bridgeUrl. 'managed': we run the LLM. */
  runtime?: 'bridge' | 'managed';
  bridgeUrl?: string;
  model?: string;
  systemPrompt?: string;
  /** Managed reply cap, 256–8192 (default 1024). */
  maxTokens?: number;
  /** Auto-resolve conversations idle this many minutes, 1–43200 (default: never). */
  autoResolveMinutes?: number;
  /** Managed runtime: the LLM key (stored encrypted, write-only) + optional compat base URL. */
  llm?: { apiKey?: string; baseUrl?: string };
  /** Cheap-first model routing. Managed only — a bridge agent answers 400. */
  routing?: AgentRouting;
  /** The topic gate. Managed only — a bridge agent answers 400. */
  topics?: AgentTopics;
  /** The outbound reply rules. Managed only — a bridge agent answers 400. */
  moderation?: AgentModeration;
  /**
   * The per-customer message limit. Accepted on BOTH runtimes — the only agent
   * config that is, because it protects your own compute rather than configuring
   * a brain we run.
   */
  subscriberRate?: AgentSubscriberRate;
}

export interface ConversationSummary {
  id: string;
  agent: { identifier: string; name: string };
  subscriberId: string;
  channel: string;
  /** `waiting_human`/`human` mean a handoff is in flight — a teammate has the pen. */
  status: 'active' | 'resolved' | 'waiting_human' | 'human';
  messageCount: number;
  lastMessagePreview: string | null;
  lastMessageAt: string;
}

/** A custom tool in an agent's registry — the managed brain dispatches these. */
export interface AgentTool {
  id: string;
  name: string;
  description: string;
  /** JSON Schema object ({ type: 'object', ... }) describing the tool's args. */
  parameters: Record<string, unknown>;
  endpointUrl: string;
  /** 'required' routes every call through the human approval queue first. */
  approval: 'auto' | 'required';
  timeoutMs: number;
  status: 'active' | 'disabled';
  createdAt: string;
}

export interface CreateAgentToolOptions {
  /** Lowercase `^[a-z][a-z0-9_]{0,63}$`; reserved built-in names are rejected. */
  name: string;
  description: string;
  /** JSON Schema; must be an object with `type: 'object'`. */
  parameters: Record<string, unknown>;
  /** We POST tool calls here — must be a public URL (SSRF-checked write-time). */
  endpointUrl: string;
  /** 'auto' (default) runs immediately; 'required' gates on human approval. */
  approval?: 'auto' | 'required';
  /** Per-call timeout in ms, 1000–30000 (default 10000). */
  timeoutMs?: number;
}

/** A gated tool call in the approvals queue — pending, or already decided. */
export interface ToolApproval {
  id: string;
  agentIdentifier: string | null;
  toolName: string;
  args: Record<string, unknown>;
  conversationId: string;
  status: 'pending' | 'approved' | 'denied' | 'expired' | 'executed' | 'failed';
  /** Tool result, truncated to 500 chars; null until the call has executed. */
  result: string | null;
  note: string | null;
  requestedAt: string;
  decidedAt: string | null;
  decidedBy: string | null;
  expiresAt: string | null;
}

/** One tool's slice of an agent's health window. */
export interface AgentToolHealth {
  name: string;
  calls: number;
  failures: number;
  /** Always null — no per-call execution duration is recorded server-side. */
  avgMs: number | null;
}

/** Rolling-window observability for one agent (GET /v1/agents/:id/health). */
export interface AgentHealth {
  windowDays: number;
  turns: number;
  replies: number;
  notes: number;
  /** Mean / p95 turn latency in ms; null when no traced turns fell in the window. */
  avgMs: number | null;
  p95Ms: number | null;
  avgInputTokens: number | null;
  avgOutputTokens: number | null;
  toolCalls: number;
  toolFailures: number;
  tools: AgentToolHealth[];
}

/** A stored eval scenario for an agent (same JSON shape as the eval harness). */
export interface AgentEval {
  id: string;
  name: string;
  enabled: boolean;
  /** `{ turns: [{ user }|{ expect }] }` — the scenario the run drives. */
  scenario: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface CreateAgentEvalOptions {
  name: string;
  /** `{ turns: [{ user }|{ expect }] }`; validated server-side. */
  scenario: Record<string, unknown>;
  /** Disabled evals are drafts — excluded from runs until enabled (default true). */
  enabled?: boolean;
}

/**
 * One LLM-judged dimension's outcome inside a scenario result — the grade for an
 * `expect.judge` block (groundedness / tone / refusal).
 *
 * HAND-KEPT COPY of the server's `JudgeVerdictRecord` (src/core/eval-runner.ts),
 * which is the source of truth for this wire shape; this package ships
 * standalone and cannot import server types. `verdict: 'skipped'` means the run
 * had no judge client (a CLI run, or an agent whose LLM credentials could not be
 * opened) — not a pass and not a failure.
 */
export interface JudgeVerdictRecord {
  turn: number;
  dim: 'groundedness' | 'tone' | 'refusal';
  verdict: 'pass' | 'fail' | 'skipped';
  /** 1-5, present for the scored dimensions (groundedness, tone) only. */
  score?: number;
  rationale: string;
}

/** One scenario's verdict inside a run's results. */
export interface EvalScenarioResult {
  name: string;
  passed: boolean;
  /** Human-readable failure reasons; empty when passed. */
  failures: string[];
  /** Attempts USED (a passing scenario may pass before exhausting its budget). */
  attempts: number;
  /**
   * Every dimension the judge graded, passing ones included. Additive: present
   * only when the scenario used `expect.judge`, so pre-judge results are
   * unchanged. Failing dimensions ALSO appear in `failures`.
   */
  judged?: JudgeVerdictRecord[];
}

/**
 * A config to grade INSTEAD of the agent's live one — what powers the
 * dashboard's pre-save check ("does the edited prompt still pass?"). At least
 * one key must be set. Managed agents only: a candidate on a bridge agent is a
 * 400, since its brain is your code behind a signed URL, not a prompt. Nothing
 * is written to the agent — the override lives on the run and dies with it.
 *
 * HAND-KEPT COPY of the server's `CandidateSchema`
 * (src/api/routes/agent-evals.ts), which is the source of truth for this wire
 * shape; this package ships standalone and cannot import server types.
 */
export interface EvalRunCandidate {
  /** 1–100,000 chars — the same cap agent create enforces. */
  systemPrompt?: string;
  /** 1–255 chars. */
  model?: string;
  /**
   * The model-routing config to grade. Turning routing on changes which model
   * writes the reply, so the run really executes THROUGH this router rather
   * than merely noting it. `null` grades the agent with routing switched off;
   * omitting the key entirely means the run has no opinion, and the router
   * steps aside for it as it always did.
   */
  routing?: AgentRouting | null;
  /**
   * The topic gate and reply rules to grade. Absent means something DIFFERENT
   * from `routing` above, deliberately: the AGENT'S OWN gate applies to the run,
   * because a check grades this agent, and an edit that sails past a boundary
   * the real agent has would be checking an agent that does not exist. `null` is
   * the only way to say "grade it with this gate off".
   */
  topics?: AgentTopics | null;
  moderation?: AgentModeration | null;
}

/** An eval run — created 'running', finalized by the worker. */
export interface AgentEvalRun {
  id: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  trigger: 'manual' | 'pre_save';
  results: EvalScenarioResult[];
  /**
   * The candidate config this run graded instead of the agent's live one.
   * Additive: present ONLY on a run started with one — a plain run has no such
   * key, so pre-candidate readers are unaffected.
   */
  candidate?: EvalRunCandidate;
  startedAt: string;
  finishedAt: string | null;
}

/**
 * One entry in an agent's prompt history, in the LIGHT shape the list returns:
 * length + head only, never the whole prompt (a long prompt × a long history is
 * megabytes down the wire for a list of numbers and dates). `versions.get`
 * fetches the full text of one.
 *
 * HAND-KEPT COPY of the server's versions-list projection
 * (src/api/routes/agents.ts), which is the source of truth for this wire shape;
 * this package ships standalone and cannot import server types.
 */
export interface AgentPromptVersionSummary {
  version: number;
  /** The model this snapshot pinned; null means it ran on the platform default. */
  model: string | null;
  promptLength: number;
  /** First 140 chars of the prompt — enough to tell two versions apart. */
  promptHead: string;
  /** True for the version the agent is serving right now. */
  current: boolean;
  createdAt: string;
}

/** One prompt snapshot in full (`versions.get`). */
export interface AgentPromptVersion {
  version: number;
  systemPrompt: string | null;
  model: string | null;
  current: boolean;
  createdAt: string;
}

/**
 * The trial running on an agent right now, or `null` when none is. Presence is
 * the flag: the API sends the object only while a canary is active, so there is
 * no "percent 0" or "version null" state to interpret.
 *
 * HAND-KEPT COPY of the server's `agentView.canary` (src/api/routes/agents.ts).
 */
export interface AgentCanary {
  /** The prompt version on trial. */
  version: number;
  /** Share of NEWLY OPENED conversations enrolled in the trial arm, 1–99. */
  percent: number | null;
  startedAt: string | null;
  /** Share of replies judged in BOTH arms; resolved server-side, never null. */
  samplePercent: number;
}

/**
 * One arm of a canary comparison. Both arms are ALWAYS present in a report —
 * an arm with no traffic yet reports zeros rather than vanishing.
 *
 * Two attributions on purpose: `conversations` / `resolutions` / `handoffs` /
 * `guardPauses` count by the arm a conversation was ENROLLED in (a thread is
 * assigned once, and "did it resolve?" is a property of the thread), while
 * `turns` count by what ACTUALLY SERVED them — a canary-arm turn that ran on
 * the live prompt (after a Stop, say) is evidence for the control arm, not for
 * the trial version.
 *
 * HAND-KEPT COPY of the server's `CanaryArmStats` + `judged`
 * (src/db/conversations.repo.ts, src/core/turn-judge.ts).
 */
export interface CanaryArmReport {
  arm: 'canary' | 'control';
  conversations: number;
  turns: number;
  resolutions: number;
  handoffs: number;
  guardPauses: number;
  /** Mean input+output tokens over turns that RECORDED usage; null if none did. */
  avgTokensPerTurn: number | null;
  /**
   * Judged averages by dimension (`groundedness`, `tone`) — `{ avg, n }` each,
   * from the sampled turns of THIS arm. Empty until the first sampled reply is
   * judged, and always empty when the trial runs at `samplePercent: 0`.
   *
   * Averages only: live traffic carries no scenario author's bar, so there is
   * no pass/fail here — the comparison is canary's average against control's.
   */
  judged: Record<string, { avg: number; n: number }>;
}

/** The comparison behind a Promote decision, scoped to the CURRENT trial. */
export interface CanaryReport {
  version: number;
  percent: number | null;
  samplePercent: number;
  startedAt: string;
  /** Exactly two entries: the trial arm and the live-prompt control arm. */
  arms: CanaryArmReport[];
}

/**
 * One knowledge source an agent can search — pasted text or a fetched URL,
 * chunked and embedded for retrieval. `status` walks
 * pending → indexing → ready (or → error); `chunkCount` is 0 until ready.
 */
export interface KnowledgeSource {
  id: string;
  name: string;
  kind: 'text' | 'url';
  status: 'pending' | 'indexing' | 'ready' | 'error';
  /** Set only when `status` is 'error' — why indexing failed. */
  error: string | null;
  /** Number of embedded chunks; 0 until the source reaches 'ready'. */
  chunkCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface CreateKnowledgeSourceOptions {
  /** Display name, unique per agent (a duplicate → 409). */
  name: string;
  /** 'text' carries `text`; 'url' carries `url` (fetched + converted server-side). */
  kind: 'text' | 'url';
  /** Required when `kind` is 'text'; the raw material to index (≤1 MB). */
  text?: string;
  /** Required when `kind` is 'url'; SSRF-checked at write time. */
  url?: string;
}

/**
 * One durable fact an agent keeps about a subscriber for FUTURE conversations
 * — a preference, plan, or constraint (e.g. `channel_pref: "prefers email"`).
 * `source` is `'agent'` (written by the `remember` built-in mid-conversation)
 * or `'operator'` (edited from the dashboard or `agents.memories.put`). The
 * managed brain loads the whole profile into every later conversation with
 * this customer. Never holds secrets or payment data.
 */
export interface SubscriberMemory {
  key: string;
  value: string;
  source: 'agent' | 'operator';
  updatedAt: string;
}

/** Which connections carry approval cards; each field null when unset. */
export interface ApprovalSettings {
  slackConnectionId: string | null;
  slackChannelId: string | null;
  telegramConnectionId: string | null;
}

export class AsyncifyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'AsyncifyError';
  }
}

export interface AsyncifyClientOptions {
  apiKey: string;
  /** Defaults to http://localhost:3000 — point at your deployment. */
  baseUrl?: string;
}

export class AsyncifyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: AsyncifyClientOptions) {
    if (!options.apiKey) throw new Error('apiKey is required');
    this.apiKey = options.apiKey;
    this.baseUrl = (options.baseUrl ?? 'http://localhost:3000').replace(/\/$/, '');
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers: { 'content-type': 'application/json', 'x-api-key': this.apiKey },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) {
      throw new AsyncifyError(res.status, data.error ?? `request failed (${res.status})`);
    }
    return data as T;
  }

  /** Fire a workflow for specific recipients. */
  trigger(workflowKey: string, options: TriggerOptions): Promise<TriggerResult> {
    return this.request('POST', '/v1/events/trigger', { workflowKey, ...options });
  }

  /** Send a workflow to EVERY subscriber in the environment (bulk tier by default). */
  broadcast(
    workflowKey: string,
    options: { payload?: Record<string, unknown>; priority?: Priority; transactionId?: string } = {},
  ): Promise<TriggerResult & { broadcast: boolean }> {
    return this.request('POST', '/v1/events/broadcast', { workflowKey, ...options });
  }

  readonly workflows = {
    upsert: (workflow: { key: string; name: string; steps: WorkflowStep[] }) =>
      this.request<{ id: string; key: string }>('PUT', '/v1/workflows', workflow),
    list: () => this.request<{ workflows: unknown[] }>('GET', '/v1/workflows'),
  };

  readonly subscribers = {
    upsert: (subscriber: Recipient) =>
      this.request<{ id: string; subscriberId: string }>('PUT', '/v1/subscribers', subscriber),
    /** Channel identities linked to this subscriber (telegram, email). */
    identities: (subscriberId: string) =>
      this.request<{
        identities: Array<{ channel: string; externalKey: string; linkedAt: string }>;
      }>('GET', `/v1/subscribers/${encodeURIComponent(subscriberId)}/identities`),
    /** Drop a linked identity — future messages fall back to a channel-local one. */
    unlink: (subscriberId: string, identity: { channel: 'telegram' | 'email' | 'slack'; externalKey: string }) =>
      this.request<{ deleted: boolean }>(
        'DELETE',
        `/v1/subscribers/${encodeURIComponent(subscriberId)}/identities`,
        identity,
      ),
    /** Register (upsert) a push device token against this subscriber. */
    registerDevice: (device: {
      subscriberId: string;
      token: string;
      platform?: 'web' | 'android' | 'ios';
    }) =>
      this.request<{ deviceId: string; platform: Device['platform'] }>(
        'POST',
        `/v1/subscribers/${encodeURIComponent(device.subscriberId)}/devices`,
        { token: device.token, platform: device.platform },
      ),
    /** Every push device registered to this subscriber. */
    listDevices: (subscriberId: string) =>
      this.request<{ devices: Device[] }>(
        'GET',
        `/v1/subscribers/${encodeURIComponent(subscriberId)}/devices`,
      ),
    /** Drop one device by token; false if it isn't this subscriber's. */
    removeDevice: (device: { subscriberId: string; token: string }) =>
      this.request<{ deleted: boolean }>(
        'DELETE',
        `/v1/subscribers/${encodeURIComponent(device.subscriberId)}/devices`,
        { token: device.token },
      ),
  };

  readonly agents = {
    /** Create an agent. The signing secret is returned EXACTLY ONCE — store it. */
    create: (options: CreateAgentOptions) =>
      this.request<{ agent: Agent; signingSecret: string }>('POST', '/v1/agents', options),
    list: () => this.request<{ agents: Agent[] }>('GET', '/v1/agents'),
    get: (identifier: string) =>
      this.request<{ agent: Agent }>('GET', `/v1/agents/${encodeURIComponent(identifier)}`),
    /**
     * Patch any subset; `autoResolveMinutes: null` switches the backstop off,
     * and `routing`/`topics`/`moderation`/`subscriberRate: null` each switch that
     * feature off and forget its config. A provided object REPLACES the whole
     * config — the lists are never merged, so removing one entry is an ordinary
     * edit.
     */
    update: (
      identifier: string,
      patch: Partial<
        Omit<
          CreateAgentOptions,
          | 'identifier'
          | 'autoResolveMinutes'
          | 'routing'
          | 'topics'
          | 'moderation'
          | 'subscriberRate'
        >
      > & {
        status?: 'active' | 'disabled';
        autoResolveMinutes?: number | null;
        routing?: AgentRouting | null;
        topics?: AgentTopics | null;
        moderation?: AgentModeration | null;
        subscriberRate?: AgentSubscriberRate | null;
      },
    ) =>
      this.request<{ agent: Agent }>(
        'PATCH',
        `/v1/agents/${encodeURIComponent(identifier)}`,
        patch,
      ),
    /** New signing secret, shown once; the old one stops working immediately. */
    rotateSecret: (identifier: string) =>
      this.request<{ signingSecret: string }>(
        'POST',
        `/v1/agents/${encodeURIComponent(identifier)}/rotate-secret`,
      ),
    delete: (identifier: string) =>
      this.request<{ deleted: boolean }>(
        'DELETE',
        `/v1/agents/${encodeURIComponent(identifier)}`,
      ),
    /**
     * Mint the single-use deep link (24h TTL) that merges a user's Telegram
     * into this subscriber: generate it server-side for your LOGGED-IN user
     * and hand them the returned t.me link. When they tap Start, their
     * Telegram identity, history, and notifications unify with the
     * subscriber — agent replies and triggers reach the real person.
     */
    linkToken: (agentIdentifier: string, subscriberId: string) =>
      this.request<{ token: string; deepLink: string; expiresAt: string }>(
        'POST',
        `/v1/agents/${encodeURIComponent(agentIdentifier)}/subscribers/${encodeURIComponent(subscriberId)}/link-token`,
      ),

    /**
     * Rolling-window health for one agent: turn / reply / note counts, turn
     * latency (avg + p95), token averages, and per-tool call/failure tallies.
     * `days` is 1–30 (default 7); out-of-range values are rejected server-side.
     */
    health: (identifier: string, opts: { days?: number } = {}) =>
      this.request<AgentHealth>(
        'GET',
        `/v1/agents/${encodeURIComponent(identifier)}/health${
          opts.days === undefined ? '' : `?days=${opts.days}`
        }`,
      ),

    /**
     * The per-agent custom tool registry (managed runtime dispatches these).
     * Reads as `client.agents.tools.create('acme-support', {...})`.
     */
    tools: {
      /**
       * Register a tool. The secret is returned EXACTLY ONCE — store it; it is
       * used to verify our signed calls to your endpoint.
       */
      create: (identifier: string, options: CreateAgentToolOptions) =>
        this.request<{ tool: AgentTool; secret: string }>(
          'POST',
          `/v1/agents/${encodeURIComponent(identifier)}/tools`,
          options,
        ),
      /** Every tool registered on this agent. */
      list: (identifier: string) =>
        this.request<{ tools: AgentTool[] }>(
          'GET',
          `/v1/agents/${encodeURIComponent(identifier)}/tools`,
        ),
      /** Patch any subset; `status: 'disabled'` hides the tool from the model. */
      update: (
        identifier: string,
        toolId: string,
        patch: Partial<Omit<CreateAgentToolOptions, 'name'>> & {
          status?: 'active' | 'disabled';
        },
      ) =>
        this.request<{ tool: AgentTool }>(
          'PATCH',
          `/v1/agents/${encodeURIComponent(identifier)}/tools/${encodeURIComponent(toolId)}`,
          patch,
        ),
      delete: (identifier: string, toolId: string) =>
        this.request<{ deleted: boolean }>(
          'DELETE',
          `/v1/agents/${encodeURIComponent(identifier)}/tools/${encodeURIComponent(toolId)}`,
        ),
      /** New call secret, shown once; the old one stops working immediately. */
      rotateSecret: (identifier: string, toolId: string) =>
        this.request<{ secret: string }>(
          'POST',
          `/v1/agents/${encodeURIComponent(identifier)}/tools/${encodeURIComponent(toolId)}/rotate-secret`,
        ),
    },

    /**
     * Per-agent evals: store scenarios, run them as jobs, read verdicts. Reads
     * as `client.agents.evals.run('acme-support')`.
     */
    evals: {
      /** Every stored eval for this agent (enabled and disabled drafts). */
      list: (identifier: string) =>
        this.request<{ evals: AgentEval[] }>(
          'GET',
          `/v1/agents/${encodeURIComponent(identifier)}/evals`,
        ),
      /** Store a new scenario; the (agent, name) pair must be unique. */
      create: (identifier: string, options: CreateAgentEvalOptions) =>
        this.request<{ eval: AgentEval }>(
          'POST',
          `/v1/agents/${encodeURIComponent(identifier)}/evals`,
          options,
        ),
      /** Patch any subset; `enabled: false` turns a scenario into a draft. */
      update: (identifier: string, id: string, patch: Partial<CreateAgentEvalOptions>) =>
        this.request<{ eval: AgentEval }>(
          'PUT',
          `/v1/agents/${encodeURIComponent(identifier)}/evals/${encodeURIComponent(id)}`,
          patch,
        ),
      remove: (identifier: string, id: string) =>
        this.request<{ deleted: boolean }>(
          'DELETE',
          `/v1/agents/${encodeURIComponent(identifier)}/evals/${encodeURIComponent(id)}`,
        ),
      /**
       * Enqueue a run of this agent's ENABLED evals. Returns the run id
       * immediately (202); poll `getRun` for the verdict.
       *
       * Pass `candidate` to grade an UNSAVED config — the edited prompt and/or
       * model — instead of the agent's live one: the run uses the real agent,
       * tools, guardrails and knowledge with only those swapped in, and the
       * agent row is never touched. Managed agents only (bridge → 400).
       */
      run: (
        identifier: string,
        options: { trigger?: 'manual' | 'pre_save'; candidate?: EvalRunCandidate } = {},
      ) =>
        this.request<{ runId: string }>(
          'POST',
          `/v1/agents/${encodeURIComponent(identifier)}/evals/run`,
          options,
        ),
      /** The latest 20 runs, newest first. */
      runs: (identifier: string) =>
        this.request<{ runs: AgentEvalRun[] }>(
          'GET',
          `/v1/agents/${encodeURIComponent(identifier)}/evals/runs`,
        ),
      /** One run in full, including per-scenario results. */
      getRun: (identifier: string, runId: string) =>
        this.request<{ run: AgentEvalRun }>(
          'GET',
          `/v1/agents/${encodeURIComponent(identifier)}/evals/runs/${encodeURIComponent(runId)}`,
        ),
    },

    /**
     * Prompt history for a managed agent. Every save that CHANGES the prompt or
     * the model snapshots itself, so the history is append-only: `restore` does
     * not rewind it, it publishes the old content as a NEW version. Reads as
     * `client.agents.versions.list('acme-support')`.
     *
     * Managed agents only — a bridge agent's brain is your own code behind a
     * signed URL, so every route here answers 400 rather than pretending there
     * is a prompt to version.
     */
    versions: {
      /** The history, newest first, in the light shape (no prompt bodies). */
      list: (identifier: string) =>
        this.request<{ currentVersion: number; versions: AgentPromptVersionSummary[] }>(
          'GET',
          `/v1/agents/${encodeURIComponent(identifier)}/versions`,
        ),
      /** One snapshot in full, prompt text included. */
      get: (identifier: string, version: number) =>
        this.request<{ version: AgentPromptVersion }>(
          'GET',
          `/v1/agents/${encodeURIComponent(identifier)}/versions/${version}`,
        ),
      /**
       * Publish an old snapshot as the live config. This is a SAVE, not a
       * rewind: it copies the snapshot forward through the ordinary update
       * path, so it mints a new version (`version` in the response) and meets
       * every guard an ordinary save meets. Restoring v1 never deletes v2 — it
       * publishes v3. A restore whose content already matches live mints
       * nothing, and `version` then equals `restoredFrom`.
       */
      restore: (identifier: string, version: number) =>
        this.request<{ agent: Agent; restoredFrom: number; version: number }>(
          'POST',
          `/v1/agents/${encodeURIComponent(identifier)}/versions/${version}/restore`,
        ),
    },

    /**
     * Trial a prompt version on a share of REAL conversations before it takes
     * over. The arm is assigned when a conversation OPENS and is sticky for its
     * whole life — a customer never meets two personalities in one thread — so
     * traffic converges over new conversations rather than instantly. Reads as
     * `client.agents.canary.start('acme-support', { version: 7, percent: 10 })`.
     *
     * Managed agents only (bridge → 400), one trial per agent at a time.
     */
    canary: {
      /**
       * Start the trial. `percent` is 1–99 — both ends excluded, because 0 is
       * "no trial" (that is `stop`) and 100 is "ship it" (that is `promote`),
       * and an all-or-nothing split leaves the comparison with an empty arm.
       * `samplePercent` (0–100, default 20) is the share of replies judged in
       * BOTH arms; 0 runs the trial on counters alone.
       *
       * A second start while one is already running is a **409**, never a
       * silent replacement: changing the version or the percent means stop,
       * then start. Unknown version → 404.
       */
      start: (
        identifier: string,
        options: { version: number; percent: number; samplePercent?: number },
      ) =>
        this.request<{ agent: Agent }>(
          'POST',
          `/v1/agents/${encodeURIComponent(identifier)}/canary`,
          options,
        ),
      /**
       * End the trial without promoting. Conversations already enrolled keep
       * their arm (it records what they were enrolled in, which the report
       * needs) but revert to the live prompt at their NEXT turn.
       */
      stop: (identifier: string) =>
        this.request<{ agent: Agent }>(
          'DELETE',
          `/v1/agents/${encodeURIComponent(identifier)}/canary`,
        ),
      /**
       * The trial version becomes the live prompt and the trial ends. This is
       * the `versions.restore` path, so promotion enters history as an ordinary
       * versioned save rather than by a second mechanism.
       */
      promote: (identifier: string) =>
        this.request<{ agent: Agent; promotedFrom: number; version: number }>(
          'POST',
          `/v1/agents/${encodeURIComponent(identifier)}/canary/promote`,
        ),
      /**
       * The per-arm comparison behind the promote-or-stop decision: counters
       * for both arms plus judged averages from the sampled turns of each.
       * Scoped to the CURRENT trial — **404** when none is running, rather than
       * a report full of zeros that would read like a trial going badly.
       */
      report: (identifier: string) =>
        this.request<CanaryReport>(
          'GET',
          `/v1/agents/${encodeURIComponent(identifier)}/canary/report`,
        ),
    },

    /**
     * Per-agent knowledge sources (managed runtime): the material the agent
     * grounds its answers in. Requires the tenant's embeddings + vector-store
     * integrations to exist first (else create → 400). Reads as
     * `client.agents.knowledge.create('acme-support', { name, kind, text })`.
     */
    knowledge: {
      /** Every source on this agent, with its indexing status + chunk count. */
      list: (identifier: string) =>
        this.request<{ sources: KnowledgeSource[] }>(
          'GET',
          `/v1/agents/${encodeURIComponent(identifier)}/knowledge`,
        ),
      /**
       * Add a source. Returns it in status 'pending'; indexing runs async —
       * poll `list` until `status` is 'ready'. A duplicate name → 409.
       */
      create: (identifier: string, options: CreateKnowledgeSourceOptions) =>
        this.request<{ source: KnowledgeSource }>(
          'POST',
          `/v1/agents/${encodeURIComponent(identifier)}/knowledge`,
          options,
        ),
      /** Re-embed a source (re-fetches a URL; re-embeds a text source in place). */
      reindex: (identifier: string, sourceId: string) =>
        this.request<{ status: string }>(
          'POST',
          `/v1/agents/${encodeURIComponent(identifier)}/knowledge/${encodeURIComponent(sourceId)}/reindex`,
        ),
      /** Delete a source and its chunks; the vectors are cleaned up async. */
      remove: (identifier: string, sourceId: string) =>
        this.request<{ deleted: boolean }>(
          'DELETE',
          `/v1/agents/${encodeURIComponent(identifier)}/knowledge/${encodeURIComponent(sourceId)}`,
        ),
    },

    /**
     * Per-subscriber long-term memory (managed runtime): the durable facts an
     * agent remembers about ONE customer across conversations. A subscriber is
     * addressed by its external id (the id you pass in `to` / `subscriberId`),
     * not an internal uuid; an unknown agent or subscriber → 404. Reads as
     * `client.agents.memories.list('acme-support', 'user-42')`.
     */
    memories: {
      /** Every stored fact for this (agent, subscriber), ordered by key. */
      list: (identifier: string, subscriberExternalId: string) =>
        this.request<{ memories: SubscriberMemory[] }>(
          'GET',
          `/v1/agents/${encodeURIComponent(identifier)}/memories/${encodeURIComponent(subscriberExternalId)}`,
        ),
      /**
       * Set one fact (upsert by `key`), tagged `source: 'operator'`. Caps: ≤32
       * keys per subscriber, key ≤64 chars, value ≤300 chars. A NEW key on a
       * full profile → 409 (overwrite an existing key instead — no silent drop).
       */
      put: (
        identifier: string,
        subscriberExternalId: string,
        fact: { key: string; value: string },
      ) =>
        this.request<{ memory: SubscriberMemory }>(
          'PUT',
          `/v1/agents/${encodeURIComponent(identifier)}/memories/${encodeURIComponent(subscriberExternalId)}`,
          fact,
        ),
      /**
       * Delete one fact by `key`, or the WHOLE profile when `key` is omitted
       * (deleting the subscriber removes it all too — GDPR). Returns the number
       * of rows removed.
       */
      remove: (identifier: string, subscriberExternalId: string, key?: string) =>
        this.request<{ deleted: number }>(
          'DELETE',
          `/v1/agents/${encodeURIComponent(identifier)}/memories/${encodeURIComponent(
            subscriberExternalId,
          )}${key === undefined ? '' : `?key=${encodeURIComponent(key)}`}`,
        ),
    },
  };

  readonly approvals = {
    /** Gated tool calls: `pending` (default) awaiting review, or `decided`. */
    list: (filters: { status?: 'pending' | 'decided' } = {}) => {
      const qs = filters.status ? `?status=${filters.status}` : '';
      return this.request<{ approvals: ToolApproval[] }>('GET', `/v1/approvals${qs}`);
    },
    /** Approve or deny a pending call — atomic: 409 once already decided. */
    decide: (id: string, decision: 'approve' | 'deny', note?: string) =>
      this.request<{ id: string; status: string }>(
        'POST',
        `/v1/approvals/${encodeURIComponent(id)}/decision`,
        { decision, note },
      ),
  };

  readonly settings = {
    /** Current approval-channel config + count of linked telegram approvers. */
    getApprovals: () =>
      this.request<{ settings: ApprovalSettings; telegramApproverCount: number }>(
        'GET',
        '/v1/settings/approvals',
      ),
    /**
     * Merge-patch approval channels (an absent field is kept). An explicit
     * `null` CLEARS a field; `slackChannelId` requires an active
     * `slackConnectionId` (and is cleared when that connection is nulled).
     */
    putApprovals: (patch: Partial<ApprovalSettings>) =>
      this.request<{ settings: ApprovalSettings }>('PUT', '/v1/settings/approvals', patch),
  };

  readonly conversations = {
    /** Conversations across your agents, newest first. */
    list: (
      filters: {
        agent?: string;
        /** Filter by lifecycle state; `waiting_human`/`human` are handoff states. */
        status?: 'active' | 'resolved' | 'waiting_human' | 'human';
      } = {},
    ) => {
      const qs = new URLSearchParams();
      if (filters.agent) qs.set('agent', filters.agent);
      if (filters.status) qs.set('status', filters.status);
      const suffix = qs.toString();
      return this.request<{ conversations: ConversationSummary[] }>(
        'GET',
        `/v1/conversations${suffix ? `?${suffix}` : ''}`,
      );
    },
    /** Full transcript + metadata + LLM usage totals for one conversation. */
    get: (id: string) =>
      this.request<{
        conversation: {
          id: string;
          channel: string;
          /** `waiting_human`/`human` mean a handoff is in flight — a teammate has the pen. */
          status: 'active' | 'resolved' | 'waiting_human' | 'human';
          metadata: Record<string, unknown>;
          summary: string | null;
          messageCount: number;
          createdAt: string;
        };
        messages: Array<{
          id: string;
          role: 'user' | 'agent' | 'system';
          content: string;
          createdAt: string;
          buttons?: Array<{ id: string; label: string }>;
          clicked?: boolean;
        }>;
        usage: { inputTokens: number; outputTokens: number; modelCalls: number };
      }>('GET', `/v1/conversations/${encodeURIComponent(id)}`),
    /** Close a conversation (a new message from the user reopens it). */
    resolve: (id: string) =>
      this.request<{ status: string }>(
        'POST',
        `/v1/conversations/${encodeURIComponent(id)}/resolve`,
      ),
  };

  readonly templates = {
    upsert: (template: { key: string; name: string; subject: string; mjml: string }) =>
      this.request<{ key: string; version: number }>('PUT', '/v1/templates', template),
    list: () => this.request<{ templates: unknown[] }>('GET', '/v1/templates'),
    get: (key: string) =>
      this.request<{ template: unknown }>('GET', `/v1/templates/${encodeURIComponent(key)}`),
    delete: (key: string) =>
      this.request<{ deleted: boolean }>('DELETE', `/v1/templates/${encodeURIComponent(key)}`),
  };

  readonly topics = {
    upsert: (key: string, name: string) =>
      this.request<{ id: string; key: string }>('PUT', '/v1/topics', { key, name }),
    list: () => this.request<{ topics: unknown[] }>('GET', '/v1/topics'),
    addSubscribers: (key: string, subscriberIds: string[]) =>
      this.request<{ added: number }>(
        'POST',
        `/v1/topics/${encodeURIComponent(key)}/subscribers`,
        { subscriberIds },
      ),
    removeSubscribers: (key: string, subscriberIds: string[]) =>
      this.request<{ removed: number }>(
        'DELETE',
        `/v1/topics/${encodeURIComponent(key)}/subscribers`,
        { subscriberIds },
      ),
    delete: (key: string) =>
      this.request<{ deleted: boolean }>('DELETE', `/v1/topics/${encodeURIComponent(key)}`),
  };

  readonly events = {
    /** Delivery status of one trigger. */
    get: (transactionId: string) =>
      this.request<{ status: string; messages: unknown[] }>(
        'GET',
        `/v1/events/${encodeURIComponent(transactionId)}`,
      ),
  };

  /**
   * Mint a short-lived token scoped to one subscriber — pass it to the
   * <NotificationInbox /> widget in your frontend. Never ship the api key.
   */
  subscriberToken(
    subscriberId: string,
    ttlSeconds = 3600,
  ): Promise<{ token: string; expiresAt: number }> {
    return this.request('POST', '/v1/subscriber-tokens', { subscriberId, ttlSeconds });
  }
}
