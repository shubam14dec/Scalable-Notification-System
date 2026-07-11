import { isIP } from 'node:net';
import dns from 'node:dns';
import { Agent } from 'undici';

/**
 * SSRF guard for every user-supplied outbound URL (bridge URLs, LLM base
 * URLs, SMTP hosts, future customer webhooks).
 *
 * Two layers share one predicate:
 *  - assertSafeOutboundUrl / assertSafeOutboundHost: write-time and
 *    pre-dispatch checks — scheme, userinfo, hostname class, literal IPs,
 *    optional DNS resolution. Fast feedback; NOT the security boundary.
 *  - safeDispatcher(): an undici Agent whose connect-time lookup filters
 *    the actual resolved addresses — immune to DNS rebinding and exotic
 *    IP encodings, because it vets the exact IPs the socket will use.
 *    (Node skips custom lookup for literal-IP hosts, which is why the
 *    pre-dispatch assert must also run: it catches literals.)
 *
 * OUTBOUND_URL_ALLOW (comma-separated exact hostnames) exempts hosts for
 * local dev — same code path in every environment, config decides
 * (dev: localhost etc.; prod: empty).
 */

const BLOCKED_HOST_SUFFIXES = ['.localhost', '.local', '.internal', '.home.arpa'];

function allowedHosts(): Set<string> {
  return new Set(
    (process.env.OUTBOUND_URL_ALLOW ?? '')
      .split(',')
      .map((h) => h.trim().toLowerCase())
      .filter(Boolean),
  );
}

function isAllowlisted(hostname: string): boolean {
  return allowedHosts().has(hostname.toLowerCase());
}

function isPrivateIpv4(ip: string): boolean {
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some((p) => Number.isNaN(p))) return true; // malformed → treat as unsafe
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true; // "this" net, private, loopback
  if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
  if (a === 169 && b === 254) return true; // link-local + cloud metadata
  if (a === 172 && b >= 16 && b <= 31) return true; // private 172.16/12
  if (a === 192 && b === 168) return true; // private 192.168/16
  if (a === 198 && (b === 18 || b === 19)) return true; // benchmarking 198.18/15
  if (a >= 224) return true; // multicast 224/4 + reserved 240/4 + broadcast
  return false;
}

function isPrivateIpv6(ip: string): boolean {
  const lower = ip.toLowerCase();
  // v4-mapped/compatible forms carry a dotted quad — the v4 part is the
  // verdict (the ::ffff: prefix itself starts with 0 and would false-flag).
  const dotted = lower.split(':').pop();
  if (dotted && dotted.includes('.')) return isPrivateIpv4(dotted);
  return isPrivateIpv6Prefix(lower);
}

function isPrivateIpv6Prefix(lower: string): boolean {
  if (lower === '::' || lower === '::1') return true; // unspecified, loopback
  const first = parseInt(lower.split(':')[0] || '0', 16);
  if (Number.isNaN(first)) return true;
  if (first === 0) return true; // ::/8 incl. v4-mapped ::ffff: handled above, v4-compat
  if ((first & 0xfe00) === 0xfc00) return true; // ULA fc00::/7
  if ((first & 0xffc0) === 0xfe80) return true; // link-local fe80::/10
  if ((first & 0xff00) === 0xff00) return true; // multicast ff00::/8
  return false;
}

/** True when this IP must never be dialed on behalf of a tenant. */
export function isPrivateIp(ip: string): boolean {
  const family = isIP(ip);
  if (family === 4) return isPrivateIpv4(ip);
  if (family === 6) return isPrivateIpv6(ip);
  return true; // not an IP → caller misuse; fail closed
}

export class UnsafeOutboundUrlError extends Error {}

function unsafe(reason: string): never {
  throw new UnsafeOutboundUrlError(reason);
}

/**
 * Validate a bare hostname (no URL) — used for SMTP hosts.
 * `resolve: true` additionally requires every DNS answer to be public.
 */
export async function assertSafeOutboundHost(
  rawHost: string,
  opts: { resolve?: boolean } = {},
): Promise<void> {
  const hostname = rawHost.trim().toLowerCase().replace(/^\[|\]$/g, '');
  if (!hostname) unsafe('host is empty');
  if (isAllowlisted(hostname)) return;
  if (isIP(hostname)) {
    if (isPrivateIp(hostname)) unsafe(`${hostname} is a private or reserved address`);
    return;
  }
  if (hostname === 'localhost' || BLOCKED_HOST_SUFFIXES.some((s) => hostname.endsWith(s))) {
    unsafe(`${hostname} points at internal infrastructure`);
  }
  if (opts.resolve !== false) {
    let addresses: { address: string }[];
    try {
      addresses = await dns.promises.lookup(hostname, { all: true });
    } catch {
      unsafe(`${hostname} does not resolve`);
    }
    const bad = addresses.find((a) => isPrivateIp(a.address));
    if (bad) unsafe(`${hostname} resolves to the private address ${bad.address}`);
  }
}

/**
 * Validate a full user-supplied URL before storing or dialing it.
 * Throws UnsafeOutboundUrlError with a tenant-safe message.
 */
export async function assertSafeOutboundUrl(
  rawUrl: string,
  opts: { resolve?: boolean } = {},
): Promise<void> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    unsafe('not a valid URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    unsafe(`scheme ${url.protocol.replace(':', '')} is not allowed (http/https only)`);
  }
  if (url.username || url.password) unsafe('URLs with embedded credentials are not allowed');
  await assertSafeOutboundHost(url.hostname, opts);
}

/**
 * The connect-time boundary: every socket this dispatcher opens re-checks
 * the addresses DNS actually returned, at the moment of connection.
 * Use with undici's fetch: fetch(url, { dispatcher: safeDispatcher() }).
 */
let dispatcher: Agent | undefined;

// Mirrors dns.lookup's callback contract exactly: net may ask for a single
// address or (with autoSelectFamily) an array — we filter, never reshape.
function guardedLookup(
  hostname: string,
  options: dns.LookupOptions,
  callback: (err: NodeJS.ErrnoException | null, address: unknown, family?: number) => void,
): void {
  dns.lookup(hostname, options, (err, address, family) => {
    if (err) return callback(err, address, family);
    const entries = Array.isArray(address) ? address : [{ address, family }];
    if (!isAllowlisted(hostname)) {
      const bad = entries.find((e) => isPrivateIp(e.address));
      if (bad) {
        return callback(
          new UnsafeOutboundUrlError(
            `${hostname} resolves to the private address ${bad.address}`,
          ),
          address,
          family,
        );
      }
    }
    callback(null, address, family);
  });
}

export function safeDispatcher(): Agent {
  // undici forwards unknown connect options to net.connect, which accepts
  // a custom lookup — its types just don't declare it.
  dispatcher ??= new Agent({ connect: { lookup: guardedLookup } as Agent.Options['connect'] });
  return dispatcher;
}
