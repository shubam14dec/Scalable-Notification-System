/**
 * SMS segment math (Phase 20). An SMS is billed per SEGMENT, and the segment
 * size depends on the encoding the whole body forces: GSM-7 (160 chars, or
 * 153 each when concatenated) vs UCS-2 (70 / 67) — one emoji flips the whole
 * message to UCS-2 and roughly halves capacity. Pure module: used by the
 * delivery-time guard AND (duplicated) by the dashboard editor counter —
 * keep dashboard/src/lib/sms-segments.ts in sync.
 */

// GSM 03.38 basic charset. Anything outside basic+extension forces UCS-2.
const GSM7_BASIC =
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?' +
  '¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà';
// Extension table characters cost TWO septets (escape + char).
const GSM7_EXTENSION = '^{}\\[~]|€';

const BASIC = new Set(GSM7_BASIC);
const EXTENSION = new Set(GSM7_EXTENSION);

export interface SmsSegmentInfo {
  encoding: 'gsm7' | 'ucs2';
  /** Billable units: septets for gsm7 (extension chars count 2), UTF-16 code units for ucs2. */
  units: number;
  segments: number;
  /** Units a single further character of the current encoding would add to. */
  perSegment: number;
}

export function computeSmsSegments(text: string): SmsSegmentInfo {
  let gsm = true;
  let septets = 0;
  for (const ch of text) {
    if (BASIC.has(ch)) septets += 1;
    else if (EXTENSION.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }

  if (gsm) {
    const segments = septets === 0 ? 1 : septets <= 160 ? 1 : Math.ceil(septets / 153);
    return { encoding: 'gsm7', units: septets, segments, perSegment: segments > 1 ? 153 : 160 };
  }

  // UCS-2 bills per UTF-16 code unit (an emoji is 2), which .length gives us.
  const units = text.length;
  const segments = units === 0 ? 1 : units <= 70 ? 1 : Math.ceil(units / 67);
  return { encoding: 'ucs2', units, segments, perSegment: segments > 1 ? 67 : 70 };
}

/** Send-time ceiling: bodies above this many segments fail permanently. */
export const MAX_SMS_SEGMENTS = 10;
