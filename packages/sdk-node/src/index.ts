/**
 * @notify/sdk-node — server-side client for the notify platform.
 *
 *   const notify = new NotifyClient({ apiKey: process.env.NOTIFY_API_KEY! });
 *   await notify.trigger('order-shipped', {
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

export interface TriggerOptions {
  to: Recipient[];
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
  body: string;
  delaySeconds?: number;
  digest?: { windowSeconds: number; itemTemplate?: string };
}

export class NotifyError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'NotifyError';
  }
}

export interface NotifyClientOptions {
  apiKey: string;
  /** Defaults to http://localhost:3000 — point at your deployment. */
  baseUrl?: string;
}

export class NotifyClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;

  constructor(options: NotifyClientOptions) {
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
      throw new NotifyError(res.status, data.error ?? `request failed (${res.status})`);
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
