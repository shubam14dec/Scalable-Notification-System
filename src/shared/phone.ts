/**
 * E.164 phone normalization (Phase 20). Strict by design: we normalize
 * separators away but NEVER guess a default country — "9901489187" is a
 * different number in every country, so it's rejected rather than mangled.
 */

/**
 * Returns the normalized +<digits> form, or null when the input cannot be a
 * valid E.164 number. Accepts spaces/dashes/dots/parens as separators and a
 * leading 00 as the international prefix.
 */
export function normalizePhone(raw: string): string | null {
  let s = raw.trim().replace(/[\s\-.()]/g, '');
  if (s.startsWith('00')) s = '+' + s.slice(2);
  if (!s.startsWith('+')) return null;
  const digits = s.slice(1);
  if (!/^[1-9][0-9]{7,14}$/.test(digits)) return null;
  return '+' + digits;
}
