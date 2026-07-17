/**
 * SMS segment math (Phase 20). Pure-module matrix over the two encodings and
 * their concatenation boundaries: GSM-7 (160 single / 153 concatenated) and
 * UCS-2 (70 / 67), plus the two things that flip or inflate the count —
 * extension-table characters (2 septets) and any non-GSM char (whole message
 * → UCS-2). Mirrors src/shared/sms-segments.ts; the dashboard counter duplicates
 * the same rules, so these boundaries are load-bearing.
 */
import { describe, expect, test } from 'vitest';
import { computeSmsSegments } from '../../src/shared/sms-segments';

describe('GSM-7 encoding + segment boundaries', () => {
  test('empty body is one segment, zero units', () => {
    const info = computeSmsSegments('');
    expect(info).toMatchObject({ encoding: 'gsm7', units: 0, segments: 1 });
  });

  test('160 GSM-7 chars stay one segment; 161 spill to two', () => {
    expect(computeSmsSegments('A'.repeat(160))).toMatchObject({
      encoding: 'gsm7',
      units: 160,
      segments: 1,
    });
    expect(computeSmsSegments('A'.repeat(161))).toMatchObject({
      encoding: 'gsm7',
      units: 161,
      segments: 2,
    });
  });

  test('the 153-septet concatenation boundary: 306 → 2, 307 → 3', () => {
    expect(computeSmsSegments('A'.repeat(306)).segments).toBe(2);
    expect(computeSmsSegments('A'.repeat(307)).segments).toBe(3);
  });

  test('an extension-table char costs two septets (159 + € = 161 → 2 segments)', () => {
    // A single extension char alone is 2 septets but still one segment.
    expect(computeSmsSegments('{')).toMatchObject({ encoding: 'gsm7', units: 2, segments: 1 });
    // 159 basic septets + € (2) = 161 septets → over the 160 single-segment line.
    const info = computeSmsSegments('A'.repeat(159) + '€');
    expect(info).toMatchObject({ encoding: 'gsm7', units: 161, segments: 2 });
  });
});

describe('UCS-2 encoding + segment boundaries', () => {
  test('a single emoji forces UCS-2', () => {
    const info = computeSmsSegments('😀'); // surrogate pair → 2 UTF-16 code units
    expect(info).toMatchObject({ encoding: 'ucs2', units: 2, segments: 1 });
  });

  test('the 70 / 67 UCS-2 boundaries: 70 → 1, 71 → 2, 134 → 2, 135 → 3', () => {
    // '中' is a single (non-GSM) UTF-16 code unit, so char count == unit count.
    expect(computeSmsSegments('中'.repeat(70))).toMatchObject({ encoding: 'ucs2', segments: 1 });
    expect(computeSmsSegments('中'.repeat(71))).toMatchObject({ encoding: 'ucs2', segments: 2 });
    expect(computeSmsSegments('中'.repeat(134)).segments).toBe(2);
    expect(computeSmsSegments('中'.repeat(135)).segments).toBe(3);
  });

  test('one non-GSM char flips the WHOLE message to UCS-2', () => {
    // Mostly GSM-7 text, but a single '中' downgrades every char to 2 bytes.
    const info = computeSmsSegments('Hello world 中');
    expect(info.encoding).toBe('ucs2');
    expect(info.units).toBe('Hello world 中'.length);
  });
});
