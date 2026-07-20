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
}

export interface ConversationSummary {
  id: string;
  agent: { identifier: string; name: string };
  subscriberId: string;
  channel: string;
  status: 'active' | 'resolved';
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

/** One scenario's verdict inside a run's results. */
export interface EvalScenarioResult {
  name: string;
  passed: boolean;
  /** Human-readable failure reasons; empty when passed. */
  failures: string[];
  /** Attempts USED (a passing scenario may pass before exhausting its budget). */
  attempts: number;
}

/** An eval run — created 'running', finalized by the worker. */
export interface AgentEvalRun {
  id: string;
  status: 'running' | 'passed' | 'failed' | 'error';
  trigger: 'manual' | 'pre_save';
  results: EvalScenarioResult[];
  startedAt: string;
  finishedAt: string | null;
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
    /** Patch any subset; `autoResolveMinutes: null` switches the backstop off. */
    update: (
      identifier: string,
      patch: Partial<Omit<CreateAgentOptions, 'identifier' | 'autoResolveMinutes'>> & {
        status?: 'active' | 'disabled';
        autoResolveMinutes?: number | null;
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
       */
      run: (identifier: string, options: { trigger?: 'manual' | 'pre_save' } = {}) =>
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
    list: (filters: { agent?: string; status?: 'active' | 'resolved' } = {}) => {
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
          status: 'active' | 'resolved';
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
