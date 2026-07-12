/**
 * cloudflared quick-tunnel management. `parseTunnelUrl` is pure (extract the
 * public URL out of cloudflared's noisy stderr); `spawnTunnel` drives the
 * child process.
 */

import { spawn, type ChildProcess } from 'node:child_process';

/** Keep the tail of cloudflared's stderr; it is chatty and can be large. */
const BUFFER_CAP = 8 * 1024;

/**
 * Extract the trycloudflare.com public URL from a rolling stderr buffer.
 * cloudflared prints its own API host `api.trycloudflare.com` in log lines —
 * those are noise and must be ignored; only the assigned `<sub>.trycloudflare.com`
 * tunnel host is the answer. Returns null until one appears.
 */
export function parseTunnelUrl(buffer: string): string | null {
  const re = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(buffer)) !== null) {
    const url = match[0];
    if (url === 'https://api.trycloudflare.com') continue;
    return url;
  }
  return null;
}

export interface Tunnel {
  child: ChildProcess;
  url: string;
}

/**
 * Spawn `cloudflared tunnel --url http://localhost:<port>` and resolve once the
 * public URL appears in stderr. Rejects on a 30s timeout (killing the child)
 * or if the process exits before a URL is seen — the rejection carries the
 * stderr tail so the caller can show cloudflared's own error.
 */
export function spawnTunnel(port: number): Promise<Tunnel> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'cloudflared',
      ['tunnel', '--url', `http://localhost:${port}`, '--no-autoupdate'],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );

    let buffer = '';
    let settled = false;

    const append = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (buffer.length > BUFFER_CAP) buffer = buffer.slice(-BUFFER_CAP);
      const url = parseTunnelUrl(buffer);
      if (url && !settled) finish(url);
    };

    const finish = (url: string) => {
      settled = true;
      clearTimeout(timer);
      resolve({ child, url });
    };

    const fail = (message: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.kill();
      reject(new Error(message));
    };

    const timer = setTimeout(() => {
      fail(`cloudflared did not report a tunnel URL within 30s.\n${buffer.slice(-1200)}`);
    }, 30_000);

    child.stderr?.on('data', append);
    child.stdout?.on('data', append);
    child.on('error', (err) => {
      // Surface ENOENT (cloudflared not installed) verbatim to the caller.
      fail(err.message);
    });
    child.on('exit', (code) => {
      fail(`cloudflared exited (code ${code ?? 'null'}) before a tunnel URL appeared.\n${buffer.slice(-1200)}`);
    });
  });
}

/**
 * Block until a freshly-spawned quick tunnel is *publicly reachable* — i.e. it
 * answers its own `/health` through the public internet — before anyone
 * publishes or registers its hostname anywhere.
 *
 * WHY this wait exists: cloudflared prints the assigned tunnel URL the instant
 * it picks a subdomain, seconds BEFORE the matching DNS record actually exists
 * on public resolvers. If we rewire during that gap, a third party (notably
 * Telegram's `setWebhook`) tries to resolve the host, gets NXDOMAIN, and
 * *negatively caches* it. That negative cache outlives the race by many minutes,
 * so setWebhook keeps failing with "Failed to resolve host" long after the DNS
 * record has propagated. Waiting until the tunnel serves traffic closes the
 * window so nobody ever resolves the hostname before it exists.
 *
 * Polls `GET {url}/health` (5s AbortController timeout per request, mirroring the
 * watchdog's idiom). Any thrown fetch error or non-2xx response is a failure and
 * resets the consecutive-success counter. Resolves after `consecutive` successes
 * in a row; throws once `maxWaitMs` of budget is spent without reaching that
 * streak, naming the URL. Elapsed time is measured by accumulating the injected
 * `sleepFn` waits (never a bare `setTimeout` in the loop body) so tests can drive
 * the whole thing — including the timeout path — with no real clock or network.
 */
export async function waitForTunnelReady(
  url: string,
  opts: {
    fetchFn?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>;
    maxWaitMs?: number;
    intervalMs?: number;
    consecutive?: number;
  } = {},
): Promise<void> {
  const fetchFn = opts.fetchFn ?? fetch;
  const sleepFn =
    opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWaitMs = opts.maxWaitMs ?? 60_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const consecutive = opts.consecutive ?? 2;

  let elapsed = 0;
  let streak = 0;

  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5_000);
    let ok = false;
    try {
      const res = await fetchFn(`${url}/health`, { signal: controller.signal });
      ok = res.ok;
    } catch {
      ok = false;
    } finally {
      clearTimeout(timer);
    }

    if (ok) {
      streak += 1;
      if (streak >= consecutive) return;
    } else {
      streak = 0;
    }

    if (elapsed >= maxWaitMs) {
      throw new Error(
        `tunnel never became publicly reachable within ${maxWaitMs}ms: ${url}`,
      );
    }
    await sleepFn(intervalMs);
    elapsed += intervalMs;
  }
}
