/**
 * WS gateway origin, derived from where the dashboard is being served.
 * Dev: vite proxies /ws to localhost:3001 (see vite.config.ts) — dev and
 * prod take the identical code path, no build-time variable, no
 * environment fork. Callers append `/?<query>` (see packages/react and
 * adminEvents), and the ws gateway ignores the request path entirely
 * (src/ws/gateway.ts reads only searchParams), so the /ws prefix is
 * routing information for Caddy alone.
 */
export function wsOrigin(): string {
  const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${proto}//${window.location.host}/ws`;
}
