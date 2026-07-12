/**
 * Minimal Slack Web API client — only the calls the platform needs. One code
 * path for every environment: production and local dev both receive real
 * webhook pushes (locally via a tunnel, PUBLIC_URL set to the tunnel URL).
 * The base URL is overridable ONLY so tests can point at a stub server; it is
 * read per-call, not at import time.
 *
 * Slack does not use HTTP status for API errors: every Web API call returns
 * HTTP 200 with `{ok:boolean, error?:string}`, so `call` inspects the body.
 */

import { createHmac, timingSafeEqual } from 'node:crypto';

export interface SlackAuthTest {
  team_id: string;
  team: string;
  user_id: string;
  bot_id: string;
}

/** A Slack message event — the shape fresh, changed, and deleted events share. */
export interface SlackMessageEvent {
  ts: string;
  channel: string;
  channel_type: 'im' | 'channel' | 'group' | 'mpim';
  user?: string;
  text?: string;
  bot_id?: string;
  thread_ts?: string;
  subtype?: string;
  /** message_changed carries the edited message nested here (with ORIGINAL ts). */
  message?: { ts: string; text?: string; user?: string; bot_id?: string; thread_ts?: string };
  /** message_deleted references the removed message here. */
  previous_message?: { ts: string; thread_ts?: string };
  /** message_deleted: the ts of the removed message. */
  deleted_ts?: string;
}

/** The Events API envelope Slack POSTs to the events route. */
export interface SlackEventEnvelope {
  type: string;
  challenge?: string;
  event_id?: string;
  event?: SlackMessageEvent & { type: string };
}

function apiBase(): string {
  return (process.env.SLACK_API_BASE ?? 'https://slack.com/api').replace(/\/$/, '');
}

class SlackError extends Error {
  constructor(method: string, error: string) {
    super(`slack ${method}: ${error}`);
  }
}

async function call<T>(token: string, method: string, body?: Record<string, unknown>): Promise<T> {
  const res = await fetch(`${apiBase()}/${method}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      authorization: `Bearer ${token}`,
    },
    body: JSON.stringify(body ?? {}),
  });
  const json = (await res.json().catch(() => null)) as ({ ok: boolean; error?: string } & T) | null;
  if (!json || !json.ok) {
    throw new SlackError(method, json?.error ?? `HTTP ${res.status}`);
  }
  return json as T;
}

export const slack = {
  /** Validates the bot token and returns the workspace + bot identity. */
  authTest: (token: string) => call<SlackAuthTest>(token, 'auth.test'),

  /**
   * Post a message. With buttons: a section block carries the text and an
   * actions block carries the buttons (action_id + value = our button id);
   * the plain `text` stays as the notification/accessibility fallback.
   * Without buttons: `text` only. thread_ts threads the reply.
   */
  postMessage: (
    token: string,
    channel: string,
    text: string,
    opts?: { threadTs?: string; buttons?: Array<{ id: string; label: string }> },
  ) =>
    call<{ channel: string; ts: string }>(token, 'chat.postMessage', {
      channel,
      text,
      ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {}),
      ...(opts?.buttons?.length
        ? {
            blocks: [
              { type: 'section', text: { type: 'mrkdwn', text } },
              {
                type: 'actions',
                elements: opts.buttons.map((b) => ({
                  type: 'button',
                  text: { type: 'plain_text', text: b.label },
                  action_id: b.id,
                  value: b.id,
                })),
              },
            ],
          }
        : {}),
    }),

  /**
   * Rewrite a sent message. text only — omitting blocks strips the actions
   * block, which is how a button set retires after a click.
   */
  update: (token: string, channel: string, ts: string, text: string) =>
    call<{ channel: string; ts: string }>(token, 'chat.update', { channel, ts, text }),

  deleteMessage: (token: string, channel: string, ts: string) =>
    call<{ channel: string; ts: string }>(token, 'chat.delete', { channel, ts }),

  /** Look up a Slack user's profile — used to auto-match by email. */
  usersInfo: (token: string, userId: string) =>
    call<{ user: { id: string; profile?: { email?: string } } }>(token, 'users.info', {
      user: userId,
    }),
};

/**
 * Slack request signing (the v0 scheme):
 *
 *   signature = 'v0=' + hex( HMAC-SHA256( signingSecret, `v0:${timestamp}:${rawBody}` ) )
 *
 * sent as `x-slack-signature` with `x-slack-request-timestamp` (unix seconds).
 * The timestamp binds the signature to a moment so a captured request can't be
 * replayed later; the tolerance window absorbs clock skew. Mirrors the
 * timing-safe skeleton in api/webhook-signature.ts.
 */
export function verifySlackSignature(
  signingSecret: string,
  timestamp: string | undefined,
  signature: string | undefined,
  rawBody: string,
  toleranceSec = 300,
): { ok: boolean; reason?: string } {
  if (!timestamp || !signature) {
    return { ok: false, reason: 'missing x-slack-request-timestamp or x-slack-signature header' };
  }
  const ts = Number.parseInt(timestamp, 10);
  if (!Number.isFinite(ts)) {
    return { ok: false, reason: 'invalid timestamp' };
  }
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSec) {
    return { ok: false, reason: 'timestamp outside tolerance (possible replay)' };
  }

  const expected = Buffer.from(
    'v0=' + createHmac('sha256', signingSecret).update(`v0:${timestamp}:${rawBody}`).digest('hex'),
  );
  const provided = Buffer.from(signature);
  if (provided.length !== expected.length || !timingSafeEqual(provided, expected)) {
    return { ok: false, reason: 'signature mismatch' };
  }
  return { ok: true };
}

export { SlackError };
