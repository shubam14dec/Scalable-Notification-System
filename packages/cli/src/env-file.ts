/**
 * Rewrite the PUBLIC_URL line in a .env file, preserving every other byte and
 * the file's line-ending style. Pure `rewritePublicUrlLine` + an effects
 * wrapper `writeEnvFile`.
 */

import { readFile, writeFile } from 'node:fs/promises';

/**
 * Replace the first `PUBLIC_URL=` line with `PUBLIC_URL=<url>`, keeping the
 * file byte-for-byte identical everywhere else. If no such line exists, append
 * one (matching the file's newline style and trailing-newline convention).
 * Idempotent: running twice with the same url is a no-op.
 */
export function rewritePublicUrlLine(text: string, url: string): string {
  const newline = detectNewline(text);
  const replacement = `PUBLIC_URL=${url}`;

  // Match the first PUBLIC_URL= line (its content up to, but not including,
  // the line ending) and swap it, leaving line endings untouched.
  const lineRe = /^PUBLIC_URL=.*$/m;
  if (lineRe.test(text)) {
    return text.replace(lineRe, replacement);
  }

  // No PUBLIC_URL line — append one.
  if (text.length === 0) return replacement;
  if (text.endsWith(newline)) {
    // File ends with a newline: append the line and keep the trailing newline.
    return `${text}${replacement}${newline}`;
  }
  // No trailing newline: separate with one, add none after.
  return `${text}${newline}${replacement}`;
}

/** Detect CRLF vs LF from the first line ending; default to the host's. */
function detectNewline(text: string): string {
  const idx = text.indexOf('\n');
  if (idx === -1) return '\n';
  return text[idx - 1] === '\r' ? '\r\n' : '\n';
}

/**
 * Read `path`, rewrite the PUBLIC_URL line, and write back only if the content
 * actually changed. Returns true when a write happened.
 */
export async function writeEnvFile(path: string, url: string): Promise<boolean> {
  const before = await readFile(path, 'utf8');
  const after = rewritePublicUrlLine(before, url);
  if (after === before) return false;
  await writeFile(path, after, 'utf8');
  return true;
}
