/**
 * Webhook rewiring. `planRewire` is a pure function that turns the current
 * connections list into (a) the telegram connection ids to auto-reconnect and
 * (b) the rows a human must paste into third-party consoles. `runRewire`
 * performs the effects: publish the URL, write .env, reconnect telegram, and
 * print the paste table.
 */

import { apiFetch } from './api';
import { writeEnvFile } from './env-file';

export interface TelegramWebhook {
  url: string;
  expectedUrl: string;
  lastError?: string;
}
export interface EmailWebhook {
  url: string;
}
export interface SlackWebhook {
  eventsUrl: string;
  interactivityUrl: string;
}

export interface Connection {
  id: string;
  channel: 'telegram' | 'email' | 'slack';
  status: string;
  config: { botUsername?: string; address?: string; teamName?: string };
  agent: { identifier: string; name: string };
  webhook: TelegramWebhook | EmailWebhook | SlackWebhook;
  createdAt: string;
}

export interface PasteRow {
  key: string;
  label: string;
  url: string;
  destination: string;
  changed: boolean;
}

export interface RewirePlan {
  reconnectIds: string[];
  pasteRows: PasteRow[];
}

const DEST = {
  slackEvents: 'Slack app config → Event Subscriptions → Request URL (wait for Verified)',
  slackInteractivity: 'Slack app config → Interactivity & Shortcuts → Request URL',
  email: 'Postmark → Servers → Default Inbound Stream → Settings → Webhook',
} as const;

/**
 * Decide what rewiring the new tunnel URL implies. Pure — no network, no clock.
 * `prevUrls` is the map returned by the previous run (or null on first run);
 * a row is `changed` when this is the first run or the URL differs from before.
 */
export function planRewire(
  connections: Connection[],
  prevUrls: Map<string, string> | null,
): RewirePlan {
  const reconnectIds: string[] = [];
  const pasteRows: PasteRow[] = [];

  const isChanged = (key: string, url: string): boolean =>
    prevUrls === null || prevUrls.get(key) !== url;

  for (const conn of connections) {
    if (conn.channel === 'telegram') {
      // Telegram is rewired automatically via the reconnect endpoint.
      if (conn.status === 'active') reconnectIds.push(conn.id);
      continue;
    }

    if (conn.channel === 'slack') {
      const wh = conn.webhook as SlackWebhook;
      const eventsKey = `${conn.id}:slack-events`;
      const interKey = `${conn.id}:slack-interactivity`;
      pasteRows.push({
        key: eventsKey,
        label: `${conn.agent.name} — Slack Events`,
        url: wh.eventsUrl,
        destination: DEST.slackEvents,
        changed: isChanged(eventsKey, wh.eventsUrl),
      });
      pasteRows.push({
        key: interKey,
        label: `${conn.agent.name} — Slack Interactivity`,
        url: wh.interactivityUrl,
        destination: DEST.slackInteractivity,
        changed: isChanged(interKey, wh.interactivityUrl),
      });
      continue;
    }

    if (conn.channel === 'email') {
      const wh = conn.webhook as EmailWebhook;
      const key = `${conn.id}:email`;
      pasteRows.push({
        key,
        label: `${conn.agent.name} — Email Inbound`,
        url: wh.url,
        destination: DEST.email,
        changed: isChanged(key, wh.url),
      });
    }
  }

  return { reconnectIds, pasteRows };
}

// ---- effects ----

export interface RewireContext {
  baseUrl: string;
  apiKey: string;
  /** The new public tunnel URL (origin, no trailing path). */
  tunnelUrl: string;
  /** Map from the previous run, or null on the first run. */
  prevUrls: Map<string, string> | null;
  /** Whether to write ./.env (false for --no-env-write). */
  envWrite: boolean;
  /** Path to the local .env (default ./.env). Written only if it exists. */
  envPath?: string;
  log?: (msg: string) => void;
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((r) => setTimeout(r, ms));

/**
 * Publish the tunnel URL, rewire everything, and return the new URL map for the
 * next run. Reconnect failures are printed but never abort the loop.
 */
export async function runRewire(ctx: RewireContext): Promise<Map<string, string>> {
  const log = ctx.log ?? ((m: string) => console.log(m));
  const sleep = ctx.sleep ?? defaultSleep;

  // 1. Publish the public URL.
  const put = await apiFetch(ctx.baseUrl, ctx.apiKey, 'PUT', '/v1/ops/public-url', {
    url: ctx.tunnelUrl,
  });
  if (put.status !== 200) {
    throw new Error(
      `PUT /v1/ops/public-url failed: ${put.status} ${JSON.stringify(put.json)}`,
    );
  }
  log(`  ✔ published public URL → ${ctx.tunnelUrl}`);

  // 2. Write ./.env (only if it exists and env-write is enabled).
  if (ctx.envWrite) {
    const envPath = ctx.envPath ?? '.env';
    try {
      const wrote = await writeEnvFile(envPath, ctx.tunnelUrl);
      if (wrote) log(`  ✔ updated ${envPath} (PUBLIC_URL)`);
    } catch (err) {
      const e = err as NodeJS.ErrnoException;
      // Missing .env is fine — nothing to update.
      if (e.code !== 'ENOENT') log(`  ✖ could not update ${envPath}: ${e.message}`);
    }
  }

  // 3. Re-read connections AFTER the URL change so webhook URLs are fresh.
  const list = await apiFetch(ctx.baseUrl, ctx.apiKey, 'GET', '/v1/connections');
  if (list.status !== 200) {
    throw new Error(
      `GET /v1/connections failed: ${list.status} ${JSON.stringify(list.json)}`,
    );
  }
  const connections = ((list.json as { connections?: Connection[] }).connections) ?? [];
  const plan = planRewire(connections, ctx.prevUrls);

  // 4. Reconnect telegram connections one by one; never abort on failure.
  for (const id of plan.reconnectIds) {
    await reconnectOne(ctx, id, sleep, log);
  }

  // 5. Print the paste table for slack/email; ● marks a row that changed.
  if (plan.pasteRows.length > 0) {
    log('');
    log('  Paste these into their consoles (● = changed since last run):');
    for (const row of plan.pasteRows) {
      const mark = row.changed ? '●' : ' ';
      log(`  ${mark} ${row.label}`);
      log(`      URL: ${row.url}`);
      log(`      →   ${row.destination}`);
    }
  }

  // 6. Build the new URL map for change-detection next run.
  const next = new Map<string, string>();
  for (const row of plan.pasteRows) next.set(row.key, row.url);
  return next;
}

async function reconnectOne(
  ctx: RewireContext,
  id: string,
  sleep: (ms: number) => Promise<void>,
  log: (msg: string) => void,
): Promise<void> {
  const attempt = async () => {
    const res = await apiFetch(
      ctx.baseUrl,
      ctx.apiKey,
      'POST',
      `/v1/connections/${id}/reconnect`,
    );
    return res;
  };

  // A reconnect right after a URL change can fail because Telegram's resolver is
  // still negative-caching the freshly-created tunnel host (NXDOMAIN). That
  // clears within a minute or two, so DNS-resolve failures are retryable —
  // unlike other reconnect errors, which we surface immediately.
  const isDnsResolveFailure = (res: { json: unknown }): boolean =>
    JSON.stringify(res.json).toLowerCase().includes('failed to resolve host');

  try {
    let res = await attempt();
    for (let k = 1; k <= 3 && isDnsResolveFailure(res); k += 1) {
      log(
        `  ✖ reconnect ${id}: telegram cannot resolve the tunnel host yet — retrying in 10s (attempt ${k}/3)`,
      );
      await sleep(10_000);
      res = await attempt();
    }
    if (res.status !== 200) {
      log(`  ✖ reconnect ${id}: ${res.status} ${JSON.stringify(res.json)}`);
      return;
    }
    const webhookUrl = (res.json as { webhookUrl?: string }).webhookUrl ?? '';
    if (webhookUrl.startsWith(ctx.tunnelUrl)) {
      log(`  ✔ reconnected telegram ${id}`);
      return;
    }
    // Telegram sometimes reports a stale webhook right after a URL change;
    // give it a moment and retry exactly once.
    log(`  … telegram ${id} reported a stale webhook, retrying in 6s`);
    await sleep(6_000);
    const retry = await attempt();
    if (retry.status !== 200) {
      log(`  ✖ reconnect ${id} (retry): ${retry.status} ${JSON.stringify(retry.json)}`);
      return;
    }
    const retryUrl = (retry.json as { webhookUrl?: string }).webhookUrl ?? '';
    if (retryUrl.startsWith(ctx.tunnelUrl)) {
      log(`  ✔ reconnected telegram ${id} (after retry)`);
    } else {
      log(`  ✖ telegram ${id} webhook still mismatched: ${retryUrl}`);
    }
  } catch (err) {
    log(`  ✖ reconnect ${id}: ${(err as Error).message}`);
  }
}
