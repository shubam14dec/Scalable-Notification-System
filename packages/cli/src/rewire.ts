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
  /**
   * The connection this row belongs to. Lets the runner drop a slack
   * connection's rows from the paste table when its runtime reconnect
   * auto-updated the app manifest (see runRewire).
   */
  connectionId: string;
}

export interface RewirePlan {
  /** Telegram connections auto-reconnected via POST …/reconnect. */
  reconnectIds: string[];
  /**
   * Active and pending slack connections to ATTEMPT a runtime reconnect on.
   * The attempt decides the outcome: 200 auto-updates the manifest (drop the
   * paste rows), 400 `manual` / 409 `refresh-expired` / other errors fall
   * back to pasting. Pending is included so a not-yet-installed quick-setup
   * app gets its redirect/event URLs re-pointed after a rotation.
   */
  slackAttemptIds: string[];
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
  const slackAttemptIds: string[] = [];
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
      // Active AND pending slack connections get a runtime reconnect attempt;
      // the attempt (not the plan) decides whether these paste rows survive.
      // Pending matters: a quick-setup app that was created but not yet
      // installed already holds a config refresh chain, and its registered
      // redirect/event URLs go stale if the tunnel rotates before install —
      // the reconnect re-points them so the OAuth install can succeed.
      // Other statuses (inactive/disabled) stay paste-only — same as before.
      if (conn.status === 'active' || conn.status === 'pending') {
        slackAttemptIds.push(conn.id);
      }
      pasteRows.push({
        key: eventsKey,
        label: `${conn.agent.name} — Slack Events`,
        url: wh.eventsUrl,
        destination: DEST.slackEvents,
        changed: isChanged(eventsKey, wh.eventsUrl),
        connectionId: conn.id,
      });
      pasteRows.push({
        key: interKey,
        label: `${conn.agent.name} — Slack Interactivity`,
        url: wh.interactivityUrl,
        destination: DEST.slackInteractivity,
        changed: isChanged(interKey, wh.interactivityUrl),
        connectionId: conn.id,
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
        connectionId: conn.id,
      });
    }
  }

  return { reconnectIds, slackAttemptIds, pasteRows };
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
  const connById = new Map(connections.map((c) => [c.id, c]));

  // 4. Reconnect telegram connections one by one; never abort on failure.
  for (const id of plan.reconnectIds) {
    await reconnectOne(ctx, id, sleep, log);
  }

  // 5. Attempt a runtime reconnect on each active/pending slack connection. A 200
  //    auto-updates the app manifest — we suppress that connection's paste
  //    rows below. Everything else (legacy `manual`, `refresh-expired`, or a
  //    hard error) falls through to the paste table.
  const suppressed = new Set<string>();
  for (const id of plan.slackAttemptIds) {
    const updated = await attemptSlackReconnect(ctx, id, connById.get(id), log);
    if (updated) suppressed.add(id);
  }

  // 6. Print the paste table for slack/email; ● marks a row that changed.
  //    Auto-updated slack connections are dropped from the table entirely.
  const visibleRows = plan.pasteRows.filter((row) => !suppressed.has(row.connectionId));
  if (visibleRows.length > 0) {
    log('');
    log('  Paste these into their consoles (● = changed since last run):');
    for (const row of visibleRows) {
      const mark = row.changed ? '●' : ' ';
      log(`  ${mark} ${row.label}`);
      log(`      URL: ${row.url}`);
      log(`      →   ${row.destination}`);
    }
  }

  // 7. Build the new URL map for change-detection next run. Record EVERY row's
  //    URL — including suppressed (auto-updated) slack rows — so that if a
  //    later run falls back to manual pasting, the ●-changed diff is correct.
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

/**
 * Attempt a runtime reconnect on one active/pending slack connection (Phase 17
 * backend).
 * Returns true only when the manifest was auto-updated (HTTP 200 `updated`), in
 * which case the caller suppresses that connection's paste rows. Every other
 * outcome returns false and keeps the paste rows:
 *   - 400 `manual`: legacy connection with no config-refresh chain. Expected —
 *     stay quiet, just fall back to the paste table.
 *   - 409 `refresh-expired`: the refresh chain broke. Emit one hint line.
 *   - anything else (409 `manual` missing app id, 502, network error): log it
 *     like a normal reconnect failure.
 */
async function attemptSlackReconnect(
  ctx: RewireContext,
  id: string,
  conn: Connection | undefined,
  log: (msg: string) => void,
): Promise<boolean> {
  const name = conn?.config.teamName ?? conn?.agent.name ?? id;
  try {
    const res = await apiFetch(
      ctx.baseUrl,
      ctx.apiKey,
      'POST',
      `/v1/connections/${id}/reconnect`,
    );
    const code = (res.json as { code?: string }).code;
    if (res.status === 200 && (res.json as { updated?: boolean }).updated) {
      log(`  ✔ slack app URLs auto-updated (${name})`);
      return true;
    }
    if (res.status === 400 && code === 'manual') {
      // Expected legacy path — no error noise; the paste rows carry it.
      return false;
    }
    if (res.status === 409 && code === 'refresh-expired') {
      log(
        `  ! slack auto-update needs a fresh config refresh token — paste one in the dashboard (connection ${name})`,
      );
      return false;
    }
    log(`  ✖ slack reconnect ${id}: ${res.status} ${JSON.stringify(res.json)}`);
    return false;
  } catch (err) {
    log(`  ✖ slack reconnect ${id}: ${(err as Error).message}`);
    return false;
  }
}
