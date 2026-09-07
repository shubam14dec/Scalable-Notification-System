/**
 * Pre-paint theme setter. Runs as a BLOCKING classic script in <head> (see
 * index.html) so `data-theme` is on <html> before the first paint — that is
 * the whole point; deferring it (or moving it into the module bundle) brings
 * back the light/dark flash it exists to prevent.
 *
 * Why a file and not an inline <script>: the SPA ships
 * `script-src 'self'` (deploy/compose/Caddyfile). An inline script would need
 * either 'unsafe-inline' — which throws away most of what the CSP buys — or a
 * 'sha256-…' hash pinned in the Caddyfile. The hash is byte-exact, and this
 * repo is checked out with core.autocrlf=true on Windows while the image is
 * built from an LF checkout, so the same source yields two different hashes
 * and the stale one fails silently (unthemed dashboard). A same-origin file
 * has no such coupling. Vite copies public/ to dist/ verbatim.
 *
 * Guarded by tests/unit/csp-no-inline-script.test.ts — index.html must stay
 * free of inline script bodies or `script-src 'self'` becomes a lie.
 */
const saved = localStorage.getItem('nk_theme');
const dark = saved ? saved === 'dark' : true; // dark is the showcase default
document.documentElement.dataset.theme = dark ? 'dark' : 'light';
