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
import { logger } from '../shared/logger';
import type { Card } from '../shared/cards';

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

/** A manifest-validation detail Slack returns on invalid_manifest. */
interface SlackErrorDetail {
  pointer?: string;
  message?: string;
}

class SlackError extends Error {
  /** The raw Slack `error` code (e.g. 'invalid_blocks'), for branchable handling. */
  readonly error: string;
  /** apps.manifest.* validation pointers, when present. */
  readonly details?: SlackErrorDetail[];
  constructor(method: string, error: string, details?: SlackErrorDetail[]) {
    const suffix =
      details && details.length
        ? ` (${details
            .map((d) => `${d.pointer ?? ''} ${d.message ?? ''}`.trim())
            .filter(Boolean)
            .join('; ')})`
        : '';
    super(`slack ${method}: ${error}${suffix}`);
    this.error = error;
    this.details = details;
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

/**
 * POST a form-urlencoded Slack call. The tooling/oauth methods this platform
 * adds (apps.manifest.*, tooling.tokens.rotate, oauth.v2.access) all REQUIRE
 * application/x-www-form-urlencoded — oauth.v2.access rejects JSON outright,
 * and apps.manifest.* take the manifest as a JSON-string form field. Each call
 * gets its own ~5s abort budget so a hung Slack request can't wedge a route.
 * On ok:false, throws SlackError carrying Slack's `error` plus any manifest
 * validation `errors[]` pointers.
 */
async function callForm<T>(
  method: string,
  params: Record<string, string>,
  opts?: { bearer?: string },
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 5000);
  try {
    const res = await fetch(`${apiBase()}/${method}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(opts?.bearer ? { authorization: `Bearer ${opts.bearer}` } : {}),
      },
      body: new URLSearchParams(params).toString(),
      signal: controller.signal,
    });
    const json = (await res.json().catch(() => null)) as
      | ({ ok: boolean; error?: string; errors?: SlackErrorDetail[] } & T)
      | null;
    if (!json || !json.ok) {
      throw new SlackError(method, json?.error ?? `HTTP ${res.status}`, json?.errors);
    }
    return json as T;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Build the Block Kit blocks for a reply's interactive widget: an actions
 * block for buttons, a static_select for a select card, or an input block for
 * a text_input card. Returns undefined for a plain (text-only) reply — the
 * caller then sends `text` alone.
 */
function messageBlocks(
  text: string,
  opts?: { buttons?: Array<{ id: string; label: string }>; card?: Card },
): unknown[] | undefined {
  if (opts?.buttons?.length) {
    return [
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
    ];
  }
  const card = opts?.card;
  if (card?.type === 'select') {
    return [
      { type: 'section', text: { type: 'mrkdwn', text } },
      ...(card.prompt ? [{ type: 'context', elements: [{ type: 'mrkdwn', text: card.prompt }] }] : []),
      {
        type: 'actions',
        elements: [
          {
            type: 'static_select',
            action_id: card.id,
            placeholder: { type: 'plain_text', text: card.prompt?.slice(0, 150) ?? 'Choose…' },
            options: card.options.map((o) => ({
              text: { type: 'plain_text', text: o.label },
              value: o.id,
            })),
          },
        ],
      },
    ];
  }
  if (card?.type === 'text_input') {
    return [
      { type: 'section', text: { type: 'mrkdwn', text } },
      {
        type: 'input',
        dispatch_action: true,
        block_id: card.id,
        label: { type: 'plain_text', text: card.prompt ?? ' ' },
        element: {
          type: 'plain_text_input',
          action_id: card.id,
          ...(card.placeholder ? { placeholder: { type: 'plain_text', text: card.placeholder } } : {}),
          dispatch_action_config: { trigger_actions_on: ['on_enter_pressed'] },
        },
      },
    ];
  }
  return undefined;
}

/** Prose fallback when a card's blocks are rejected (the D15 invalid_blocks net). */
function cardProse(text: string, card: Card): string {
  const prompt = card.prompt ?? '';
  if (card.type === 'select') {
    const opts = card.options.map((o, i) => `${i + 1}) ${o.label}`).join('\n');
    return `${text}\n\n${prompt}${prompt ? '\n' : ''}${opts}`;
  }
  return `${text}\n\n${prompt}${card.placeholder ? ` (e.g. ${card.placeholder})` : ''}`;
}

export const slack = {
  /** Validates the bot token and returns the workspace + bot identity. */
  authTest: (token: string) => call<SlackAuthTest>(token, 'auth.test'),

  /**
   * Post a message. With buttons/card: a section block carries the text and a
   * widget block carries the interaction; the plain `text` stays as the
   * notification/accessibility fallback. Without either: `text` only.
   * thread_ts threads the reply. If a card's blocks are rejected as
   * invalid_blocks, retry once as plain prose so the reply still lands.
   */
  postMessage: async (
    token: string,
    channel: string,
    text: string,
    opts?: { threadTs?: string; buttons?: Array<{ id: string; label: string }>; card?: Card },
  ): Promise<{ channel: string; ts: string }> => {
    const blocks = messageBlocks(text, opts);
    try {
      return await call<{ channel: string; ts: string }>(token, 'chat.postMessage', {
        channel,
        text,
        ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {}),
        ...(blocks ? { blocks } : {}),
      });
    } catch (err) {
      // D15 safety net: an in-message input block can be rejected on some
      // surfaces — fall back to prose so the card degrades but the reply lands.
      if (err instanceof SlackError && err.error === 'invalid_blocks' && opts?.card) {
        logger.warn({ error: err.error }, 'slack card blocks rejected — falling back to prose');
        return await call<{ channel: string; ts: string }>(token, 'chat.postMessage', {
          channel,
          text: cardProse(text, opts.card),
          ...(opts?.threadTs ? { thread_ts: opts.threadTs } : {}),
        });
      }
      throw err;
    }
  },

  /**
   * Rewrite a sent message. With no opts: text only — omitting blocks strips
   * the actions/input block, which is how a widget retires after a response.
   * With buttons/card opts: re-attach the matching blocks.
   */
  update: (
    token: string,
    channel: string,
    ts: string,
    text: string,
    opts?: { buttons?: Array<{ id: string; label: string }>; card?: Card },
  ) => {
    const blocks = messageBlocks(text, opts);
    return call<{ channel: string; ts: string }>(token, 'chat.update', {
      channel,
      ts,
      text,
      ...(blocks ? { blocks } : {}),
    });
  },

  deleteMessage: (token: string, channel: string, ts: string) =>
    call<{ channel: string; ts: string }>(token, 'chat.delete', { channel, ts }),

  /**
   * Look up a Slack user's profile — used to auto-match by email.
   * NOTE: like bots.info, users.info silently IGNORES JSON-body arguments
   * (proven live 2026-07-12: auto-match never fired because the `user` arg
   * never reached Slack and the error was swallowed by the fallback) — read
   * methods send their args as query parameters.
   */
  usersInfo: async (
    token: string,
    userId: string,
  ): Promise<{ user: { id: string; profile?: { email?: string } } }> => {
    const res = await fetch(`${apiBase()}/users.info?user=${encodeURIComponent(userId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; error?: string; user?: { id: string; profile?: { email?: string } } }
      | null;
    if (!json || !json.ok || !json.user) {
      throw new SlackError('users.info', json?.error ?? `HTTP ${res.status}`);
    }
    return { user: json.user };
  },

  /**
   * The bot's app id (A…) — auth.test returns bot_id but not app_id.
   * NOTE: bots.info silently IGNORES JSON-body arguments (returns ok with no
   * bot object) — proven live 2026-07-12 — so this one method sends its arg
   * as a query parameter instead of using the JSON `call` helper.
   */
  botsInfo: async (token: string, botId: string): Promise<{ bot: { id: string; app_id?: string } }> => {
    const res = await fetch(`${apiBase()}/bots.info?bot=${encodeURIComponent(botId)}`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const json = (await res.json().catch(() => null)) as
      | { ok: boolean; error?: string; bot?: { id: string; app_id?: string } }
      | null;
    if (!json || !json.ok || !json.bot) {
      throw new SlackError('bots.info', json?.error ?? `HTTP ${res.status}`);
    }
    return { bot: json.bot };
  },

  /**
   * Create a Slack app from a manifest, using an app-configuration token
   * (xoxe-…, 12h TTL). Returns the app id and its brand-new OAuth credentials.
   */
  appsManifestCreate: async (
    configToken: string,
    manifest: Record<string, unknown>,
  ): Promise<{
    appId: string;
    clientId: string;
    clientSecret: string;
    signingSecret: string;
    verificationToken?: string;
  }> => {
    const json = await callForm<{
      app_id: string;
      credentials: {
        client_id: string;
        client_secret: string;
        signing_secret: string;
        verification_token?: string;
      };
    }>('apps.manifest.create', { manifest: JSON.stringify(manifest) }, { bearer: configToken });
    return {
      appId: json.app_id,
      clientId: json.credentials.client_id,
      clientSecret: json.credentials.client_secret,
      signingSecret: json.credentials.signing_secret,
      verificationToken: json.credentials.verification_token,
    };
  },

  /** Update an existing app's manifest (re-point event/interactivity URLs). */
  appsManifestUpdate: async (
    configToken: string,
    appId: string,
    manifest: Record<string, unknown>,
  ): Promise<{ appId: string }> => {
    const json = await callForm<{ app_id: string }>(
      'apps.manifest.update',
      { app_id: appId, manifest: JSON.stringify(manifest) },
      { bearer: configToken },
    );
    return { appId: json.app_id };
  },

  /**
   * Rotate an app-configuration token. The refresh token is SINGLE-USE — each
   * rotate mints a fresh access token AND a fresh refresh token, invalidating
   * the one just spent. Callers MUST persist the new refresh token before
   * doing anything else with the access token.
   */
  toolingTokensRotate: async (
    refreshToken: string,
  ): Promise<{ token: string; refreshToken: string; exp: number }> => {
    const json = await callForm<{ token: string; refresh_token: string; exp: number }>(
      'tooling.tokens.rotate',
      { refresh_token: refreshToken },
    );
    return { token: json.token, refreshToken: json.refresh_token, exp: json.exp };
  },

  /**
   * Exchange an OAuth authorization code for a bot token. redirect_uri must
   * byte-match the one used in the authorize step. Form-encoded — Slack rejects
   * a JSON body here.
   */
  oauthV2Access: async (
    clientId: string,
    clientSecret: string,
    code: string,
    redirectUri: string,
  ): Promise<{ botToken: string; teamId: string; teamName: string; botUserId: string }> => {
    const json = await callForm<{
      access_token: string;
      team: { id: string; name: string };
      bot_user_id: string;
    }>('oauth.v2.access', {
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    });
    return {
      botToken: json.access_token,
      teamId: json.team.id,
      teamName: json.team.name,
      botUserId: json.bot_user_id,
    };
  },
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
