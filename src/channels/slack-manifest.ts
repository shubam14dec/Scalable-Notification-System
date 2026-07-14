/**
 * Slack app-manifest builder (pure — no I/O). The quick-setup flow POSTs this
 * JSON to apps.manifest.create so a user goes from "config token" to a fully
 * wired Slack app (scopes, event subscriptions, interactivity, redirect URL)
 * in one call instead of clicking through the Slack app-config UI. The manual
 * flow surfaces the same shape as YAML (manifestToYaml) for paste-in.
 *
 * URLs embed the connection id (the routing key our webhook handlers dispatch
 * on), exactly like the paste-in URLs slackWebhookUrls() builds.
 */

/** A suggested prompt as Slack's agent_view expects it. */
export interface SuggestedPrompt {
  title: string;
  message: string;
}

/**
 * The EXACT 14 bot scopes the platform needs — app_mentions + read/history on
 * every conversation surface + chat:write + users:read/.email (auto-match) +
 * assistant:write (the agent_view suggested-prompts surface). One source of
 * truth: the install route joins this with commas for the OAuth `scope` param,
 * and the manifest embeds it verbatim.
 */
export const SLACK_BOT_SCOPES = [
  'app_mentions:read',
  'channels:history',
  'channels:read',
  'chat:write',
  'groups:history',
  'groups:read',
  'im:history',
  'im:read',
  'im:write',
  'mpim:history',
  'mpim:read',
  'users:read',
  // Never prune: users.info returns profile.email ONLY with this scope — the
  // slack→email subscriber auto-match silently degrades without it.
  'users:read.email',
  // Enables the agent_view feature below: without it Slack accepts the
  // suggested_prompts block but never renders it (the AI-assistant surface
  // stays off). Pair them or neither works.
  'assistant:write',
] as const;

/** The bot events our events webhook ingests. */
const BOT_EVENTS = [
  'app_mention',
  'message.channels',
  'message.groups',
  'message.im',
  'message.mpim',
] as const;

/**
 * Slack rejects any app/bot name containing the substring "slack" (case
 * insensitive). Strip it, collapse the doubled spaces the strip leaves behind,
 * and fall back to "Agent" if nothing survives.
 */
function sanitizeName(name: string): string {
  const stripped = name.replace(/slack/gi, '').replace(/\s+/g, ' ').trim();
  return stripped || 'Agent';
}

export function buildSlackManifest(opts: {
  agentName: string;
  agentDescription?: string | null;
  suggestedPrompts?: SuggestedPrompt[] | null;
  publicUrl: string;
  connectionId: string;
}): Record<string, unknown> {
  const name = sanitizeName(opts.agentName);
  const description = opts.agentDescription ? opts.agentDescription.slice(0, 175) : undefined;
  const prompts = (opts.suggestedPrompts ?? []).slice(0, 4).map((p) => ({
    title: p.title,
    message: p.message,
  }));

  const botUser: Record<string, unknown> = { display_name: name, always_online: true };

  const features: Record<string, unknown> = {
    app_home: {
      home_tab_enabled: false,
      messages_tab_enabled: true,
      messages_tab_read_only_enabled: false,
    },
    bot_user: botUser,
    ...(prompts.length
      ? {
          agent_view: {
            agent_description: description ?? name,
            suggested_prompts: prompts,
          },
        }
      : {}),
  };

  return {
    display_information: {
      name,
      ...(description ? { description } : {}),
    },
    features,
    oauth_config: {
      redirect_urls: [`${opts.publicUrl}/webhooks/slack/oauth/callback`],
      scopes: { bot: [...SLACK_BOT_SCOPES] },
    },
    settings: {
      event_subscriptions: {
        request_url: `${opts.publicUrl}/webhooks/slack/${opts.connectionId}/events`,
        bot_events: [...BOT_EVENTS],
      },
      interactivity: {
        is_enabled: true,
        request_url: `${opts.publicUrl}/webhooks/slack/${opts.connectionId}/interactivity`,
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: false,
    },
  };
}

// ---- minimal YAML serializer (block style) ----
// Good enough for the fixed manifest shape: nested maps, arrays of strings, and
// arrays of {title, message} objects. No external deps. Strings are always
// double-quoted (JSON.stringify handles escaping); booleans/numbers are bare.

function isScalar(v: unknown): boolean {
  return v === null || typeof v !== 'object';
}

function scalarToYaml(v: unknown): string {
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  if (typeof v === 'number') return String(v);
  if (v === null) return 'null';
  return JSON.stringify(String(v));
}

function emit(value: unknown, indent: number, lines: string[]): void {
  const pad = '  '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) return; // empty arrays render inline at the key
    for (const item of value) {
      if (isScalar(item)) {
        lines.push(`${pad}- ${scalarToYaml(item)}`);
      } else {
        // Object item: first key rides the dash, the rest align under it.
        const entries = Object.entries(item as Record<string, unknown>).filter(
          ([, v]) => v !== undefined,
        );
        entries.forEach(([k, v], i) => {
          const prefix = i === 0 ? `${pad}- ` : `${pad}  `;
          if (isScalar(v)) {
            lines.push(`${prefix}${k}: ${scalarToYaml(v)}`);
          } else {
            lines.push(`${prefix}${k}:`);
            emit(v, indent + 2, lines);
          }
        });
      }
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v === undefined) continue;
      if (Array.isArray(v) && v.length === 0) {
        lines.push(`${pad}${k}: []`);
      } else if (isScalar(v)) {
        lines.push(`${pad}${k}: ${scalarToYaml(v)}`);
      } else {
        lines.push(`${pad}${k}:`);
        emit(v, indent + 1, lines);
      }
    }
  }
}

/** Serialize a manifest object to block-style YAML for paste-in prefill. */
export function manifestToYaml(manifest: Record<string, unknown>): string {
  const lines: string[] = [];
  emit(manifest, 0, lines);
  return lines.join('\n') + '\n';
}
