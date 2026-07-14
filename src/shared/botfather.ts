/**
 * Extract a Telegram bot token from arbitrary pasted text — the whole
 * BotFather "Done! Congratulations..." message, or a whole-screen paste that
 * happens to contain it. A token is "<6-12 digits>:<30+ of [A-Za-z0-9_-]>".
 *
 * The onboarding phone never asks the user to isolate the token; they paste
 * whatever they have. So we scan for every token-shaped run, dedupe identical
 * matches (the same token echoed twice is still one token), and only refuse
 * when the paste is genuinely empty of tokens ('not-found') or carries two
 * DISTINCT tokens ('ambiguous' — we won't guess which bot they meant).
 */
export function parseBotFatherToken(
  blob: string,
): { token: string } | { error: 'not-found' | 'ambiguous' } {
  const matches = blob.match(/\d{6,12}:[A-Za-z0-9_-]{30,}/g);
  if (!matches || matches.length === 0) return { error: 'not-found' };
  const distinct = [...new Set(matches)];
  if (distinct.length > 1) return { error: 'ambiguous' };
  return { token: distinct[0] };
}
