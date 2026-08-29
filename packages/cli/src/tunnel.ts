/**
 * cloudflared quick-tunnel management. `parseTunnelUrl` is pure (extract the
 * public URL out of cloudflared's noisy stderr); `spawnTunnel` drives the
 * child process; `waitForTunnelReady` is the reachability gate that decides
 * when the fresh hostname is safe to hand to third parties.
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { Resolver } from 'node:dns/promises';
import dns from 'node:dns';
import https from 'node:https';

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

// ---------------------------------------------------------------------------
// Public-path reachability
//
// The gate below asks a PUBLIC resolver, not this machine's. That is not an
// optimization — it is the only oracle that answers the question the gate
// actually asks. See waitForTunnelReady's comment for the full story.
// ---------------------------------------------------------------------------

/** Public recursive resolvers, tried in order. Cloudflare first, then Google. */
export const PUBLIC_RESOLVERS = ['1.1.1.1', '8.8.8.8'] as const;

/** How often waitForTunnelReady reassures the user while nothing has changed. */
const HEARTBEAT_MS = 30_000;

/** Resolve `host`'s A records using one specific DNS server. Injectable. */
export type PublicResolveFn = (host: string, server: string) => Promise<string[]>;

/** HTTPS-probe `{url}/health` against a pinned IP. Injectable. */
export type PinnedProbeFn = (url: string, ip: string) => Promise<boolean>;

/**
 * Thrown by `resolvePublicA` when EVERY public resolver failed to answer at all
 * (timeout, refused, connection error). Distinct from "answered: no such name",
 * which is a plain `null` — the difference decides whether the caller keeps
 * waiting or falls back to this machine's own resolver.
 */
export class PublicDnsUnavailableError extends Error {
  constructor(host: string, servers: readonly string[]) {
    super(`no public DNS server answered for ${host} (tried ${servers.join(', ')})`);
    this.name = 'PublicDnsUnavailableError';
  }
}

/**
 * A resolver that ANSWERED "this name does not exist / has no A record" is a
 * useful negative answer; anything else means the resolver itself is unusable
 * from here (corporate networks commonly block outbound port 53).
 */
function isNegativeAnswer(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOTFOUND' || code === 'ENODATA' || code === 'NOTFOUND';
}

/** Default resolve: a throwaway c-ares resolver pinned to one server. */
function defaultPublicResolve(host: string, server: string): Promise<string[]> {
  const resolver = new Resolver({ timeout: 2_000, tries: 1 });
  resolver.setServers([server]);
  return resolver.resolve4(host);
}

/**
 * Ask public DNS for `host`'s first IPv4 address.
 *
 * Returns the address, or `null` when a resolver answered but the name does not
 * exist yet (the normal state for the first few seconds of a quick tunnel).
 * Throws `PublicDnsUnavailableError` when no listed resolver could be reached —
 * the caller must then degrade rather than treat it as "not resolvable".
 */
export async function resolvePublicA(
  host: string,
  opts: { resolveFn?: PublicResolveFn; servers?: readonly string[] } = {},
): Promise<string | null> {
  const resolveFn = opts.resolveFn ?? defaultPublicResolve;
  const servers = opts.servers ?? PUBLIC_RESOLVERS;

  for (const server of servers) {
    try {
      const addresses = await resolveFn(host, server);
      return addresses.length > 0 ? addresses[0] : null;
    } catch (err) {
      // An authoritative "no" from a reachable resolver is an answer; stop here.
      if (isNegativeAnswer(err)) return null;
      // Otherwise this resolver is unusable — try the next one.
    }
  }
  throw new PublicDnsUnavailableError(host, servers);
}

/**
 * `GET {url}/health` over HTTPS, dialing `ip` directly while presenting the real
 * hostname as TLS SNI and as the `Host` header — so Cloudflare routes the request
 * to the right tunnel and the certificate still validates against the hostname.
 * This is what makes the probe independent of this machine's resolver.
 *
 * Resolves true only on a 2xx; every error, non-2xx, and timeout is false.
 */
export function probePinnedHealth(
  url: string,
  ip: string,
  opts: { timeoutMs?: number } = {},
): Promise<boolean> {
  const timeoutMs = opts.timeoutMs ?? 5_000;
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      resolve(ok);
    };

    let target: URL;
    try {
      target = new URL(url);
    } catch {
      done(false);
      return;
    }
    const basePath = target.pathname.replace(/\/+$/, '');

    const req = https.request(
      {
        hostname: ip,
        port: target.port === '' ? 443 : Number(target.port),
        path: `${basePath}/health`,
        method: 'GET',
        // TLS is negotiated for the real hostname (so the cert checks out) even
        // though the socket is opened to the pinned IP.
        servername: target.hostname,
        headers: { host: target.hostname },
        timeout: timeoutMs,
        // No connection pooling: each rotation gets a different edge IP, and a
        // pooled socket to a dead tunnel would answer for the wrong host.
        agent: false,
      },
      (res) => {
        const status = res.statusCode ?? 0;
        res.resume(); // drain so the socket can close
        done(status >= 200 && status < 300);
      },
    );

    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
    req.on('error', () => done(false));
    req.end();
  });
}

/** How a single reachability poll was answered. */
export interface ProbeOutcome {
  /** Did the tunnel answer /health with a 2xx? */
  ok: boolean;
  /** 'pinned' = public DNS + pinned HTTPS; 'system' = this machine's resolver. */
  via: 'pinned' | 'system';
  /** The public IPv4 the probe dialed, when it had one. */
  ip: string | null;
  /** True when public DNS answered "that host does not exist (yet)". */
  unresolved: boolean;
}

export interface PublicProbeDeps {
  fetchFn?: typeof fetch;
  resolveFn?: PublicResolveFn;
  pinnedProbeFn?: PinnedProbeFn;
  servers?: readonly string[];
  timeoutMs?: number;
}

/**
 * One reachability poll through the public path: resolve the host on a public
 * resolver, then HTTPS-probe `/health` at that IP. If no public resolver is
 * reachable at all, degrade to the plain `fetch` probe (this machine's resolver)
 * so the check is never WORSE than it was before this existed.
 */
export async function probeThroughPublicPath(
  url: string,
  deps: PublicProbeDeps = {},
): Promise<ProbeOutcome> {
  const timeoutMs = deps.timeoutMs ?? 5_000;
  let host: string;
  try {
    host = new URL(url).hostname;
  } catch {
    return { ok: false, via: 'system', ip: null, unresolved: false };
  }

  try {
    const ip = await resolvePublicA(host, {
      resolveFn: deps.resolveFn,
      servers: deps.servers,
    });
    if (ip === null) return { ok: false, via: 'pinned', ip: null, unresolved: true };
    const probe = deps.pinnedProbeFn ?? ((u: string, addr: string) => probePinnedHealth(u, addr, { timeoutMs }));
    return { ok: await probe(url, ip), via: 'pinned', ip, unresolved: false };
  } catch (err) {
    if (!(err instanceof PublicDnsUnavailableError)) throw err;
    const ok = await systemFetchProbe(url, deps.fetchFn ?? fetch, timeoutMs);
    return { ok, via: 'system', ip: null, unresolved: false };
  }
}

/** The original probe: plain `fetch` through this machine's own resolver. */
async function systemFetchProbe(
  url: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchFn(`${url}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Does THIS machine's own resolver know the host yet? Used only to decide
 * whether to warn the user that their browser may not open the URL for a few
 * more minutes — never to gate anything.
 */
export function localDnsResolves(
  host: string,
  opts: { lookupFn?: (h: string) => Promise<unknown> } = {},
): Promise<boolean> {
  const lookupFn =
    opts.lookupFn ??
    ((h: string) =>
      new Promise((resolve, reject) => {
        dns.lookup(h, (err, address) => (err ? reject(err) : resolve(address)));
      }));
  return lookupFn(host).then(
    () => true,
    () => false,
  );
}

/**
 * Block until a freshly-spawned quick tunnel is *publicly reachable* — i.e. it
 * answers its own `/health` from the public internet's point of view — before
 * anyone publishes or registers its hostname anywhere.
 *
 * WHY this wait exists: cloudflared prints the assigned tunnel URL the instant
 * it picks a subdomain, seconds BEFORE the matching DNS record actually exists
 * on public resolvers. If we rewire during that gap, a third party (notably
 * Telegram's `setWebhook`) tries to resolve the host, gets NXDOMAIN, and
 * *negatively caches* it. That negative cache outlives the race by many minutes,
 * so setWebhook keeps failing with "Failed to resolve host" long after the DNS
 * record has propagated.
 *
 * WHY it asks a PUBLIC resolver: the original gate polled `GET {url}/health`
 * with plain `fetch`, which uses THIS machine's resolver. On networks whose ISP
 * resolver is slow to pick up new `*.trycloudflare.com` names, that resolver lags
 * minutes behind Cloudflare's edge — so the gate timed out (11 times in 14 days
 * of field use) on tunnels that the rest of the internet, Telegram included,
 * could already reach. The local resolver was always the wrong oracle: the whole
 * point is to approximate what the third party sees. So each poll now resolves
 * the host on 1.1.1.1 (falling back to 8.8.8.8) and HTTPS-probes `/health` at
 * that IP with SNI + Host pinned to the real hostname.
 *
 * If NO public resolver can be reached (corporate networks block outbound port
 * 53), the poll degrades to the original plain-`fetch` probe and says so once —
 * the gate can never be worse than it was.
 *
 * Resolves after `consecutive` successful polls in a row; throws once
 * `maxWaitMs` of budget is spent without reaching that streak, naming the URL.
 * Elapsed time is measured by accumulating the injected `sleepFn` waits (never a
 * bare `setTimeout` in the loop body) so tests can drive the whole thing —
 * including the timeout path — with no real clock or network.
 */
export async function waitForTunnelReady(
  url: string,
  opts: {
    fetchFn?: typeof fetch;
    sleepFn?: (ms: number) => Promise<void>;
    resolveFn?: PublicResolveFn;
    pinnedProbeFn?: PinnedProbeFn;
    servers?: readonly string[];
    maxWaitMs?: number;
    intervalMs?: number;
    consecutive?: number;
    onProgress?: (line: string) => void;
  } = {},
): Promise<void> {
  const sleepFn =
    opts.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const maxWaitMs = opts.maxWaitMs ?? 300_000;
  const intervalMs = opts.intervalMs ?? 2_000;
  const consecutive = opts.consecutive ?? 2;
  const onProgress = opts.onProgress ?? (() => {});
  const deps: PublicProbeDeps = {
    fetchFn: opts.fetchFn,
    resolveFn: opts.resolveFn,
    pinnedProbeFn: opts.pinnedProbeFn,
    servers: opts.servers,
  };

  let elapsed = 0;
  let streak = 0;
  // Each announced once: transitions, not per-poll chatter.
  let saidResolved = false;
  let saidFallback = false;
  let saidAnswered = false;
  let nextHeartbeatAt = HEARTBEAT_MS;

  for (;;) {
    const outcome = await probeThroughPublicPath(url, deps);

    if (outcome.via === 'system' && !saidFallback) {
      saidFallback = true;
      onProgress(
        "no public DNS server is reachable from this network - checking with this machine's own resolver instead",
      );
    }
    if (outcome.ip !== null && !saidResolved) {
      saidResolved = true;
      onProgress(`public DNS now knows this address (${outcome.ip}) - checking it directly`);
    }
    if (outcome.ok && !saidAnswered) {
      saidAnswered = true;
      onProgress('the tunnel answered its first health check from the public internet');
    }

    if (outcome.ok) {
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

    if (elapsed >= nextHeartbeatAt) {
      while (nextHeartbeatAt <= elapsed) nextHeartbeatAt += HEARTBEAT_MS;
      onProgress(
        `still waiting for the new address to go live (${Math.round(elapsed / 1000)}s of ${Math.round(maxWaitMs / 1000)}s)`,
      );
    }
  }
}
