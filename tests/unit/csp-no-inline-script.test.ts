/**
 * S1.3 drift guard. The SPA ships `script-src 'self'`
 * (deploy/compose/Caddyfile), which silently BLOCKS any inline <script> body
 * in the dashboard's HTML shell — the failure looks like a dead feature in
 * production and nothing at all in dev, where no CSP is served.
 *
 * The pre-paint theme setter used to live inline here; it now lives in
 * dashboard/public/theme.js. The alternative — pinning a 'sha256-…' of the
 * inline body in the Caddyfile — was rejected because the hash is byte-exact
 * and this repo is checked out with core.autocrlf=true, so the Windows working
 * tree and the LF checkout the image is built from hash differently.
 *
 * These assertions are cheap and they fail loudly the moment someone puts a
 * script body back, or relaxes the policy to buy one.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, test } from 'vitest';

const repoRoot = resolve(__dirname, '../..');
const indexHtml = readFileSync(resolve(repoRoot, 'dashboard/index.html'), 'utf8');
const caddyfile = readFileSync(resolve(repoRoot, 'deploy/compose/Caddyfile'), 'utf8');

/** Every <script>…</script> body in the shell, ignoring src-only elements. */
function inlineScriptBodies(html: string): string[] {
  return [...html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)]
    .map((m) => m[1].trim())
    .filter((body) => body.length > 0);
}

describe("the dashboard shell stays compatible with script-src 'self'", () => {
  test('index.html contains no inline script body', () => {
    expect(inlineScriptBodies(indexHtml)).toEqual([]);
  });

  test('the theme setter is still loaded, as a same-origin file', () => {
    expect(indexHtml).toContain('<script src="/theme.js"></script>');
  });

  test("the SPA policy has not been relaxed to 'unsafe-inline' for scripts", () => {
    const csp = /Content-Security-Policy "([^"]+)"/.exec(caddyfile)?.[1];
    expect(csp, 'no Content-Security-Policy header found in the Caddyfile').toBeTruthy();

    const scriptSrc = /script-src ([^;]+)/.exec(csp as string)?.[1].trim();
    expect(scriptSrc).toBe("'self'");

    // Directives the SPA must never lose, whatever else gets tuned.
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("base-uri 'self'");
  });
});
