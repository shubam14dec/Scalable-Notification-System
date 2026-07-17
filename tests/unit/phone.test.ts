/**
 * E.164 phone normalization (Phase 20). normalizePhone strips separators and a
 * leading 00 prefix, but NEVER guesses a country code — a number without a
 * leading + is ambiguous and rejected rather than mangled. This matrix pins the
 * accept/reject line and the digit-count bounds (8..15 total digits).
 */
import { describe, expect, test } from 'vitest';
import { normalizePhone } from '../../src/shared/phone';

describe('normalizePhone: accepted forms normalize to +<digits>', () => {
  test('an already-canonical number is returned unchanged', () => {
    expect(normalizePhone('+919901489187')).toBe('+919901489187');
  });

  test('spaces and dashes are stripped', () => {
    expect(normalizePhone('+91 99014-89187')).toBe('+919901489187');
  });

  test('a leading 00 international prefix becomes +', () => {
    expect(normalizePhone('0091 9901489187')).toBe('+919901489187');
  });

  test('dots and surrounding whitespace are stripped', () => {
    expect(normalizePhone('  +1.415.555.2671  ')).toBe('+14155552671');
  });

  test('15 digits (the E.164 maximum) is accepted', () => {
    expect(normalizePhone('+123456789012345')).toBe('+123456789012345');
  });
});

describe('normalizePhone: rejected forms return null', () => {
  test('a number with separators but no + is rejected (country unknowable)', () => {
    expect(normalizePhone('(415) 555-2671')).toBeNull();
  });

  test('bare local digits with no + are rejected', () => {
    expect(normalizePhone('9901489187')).toBeNull();
  });

  test('a leading-zero country code is rejected', () => {
    expect(normalizePhone('+0123')).toBeNull();
  });

  test('too few digits (7) is rejected', () => {
    expect(normalizePhone('+1234567')).toBeNull();
  });

  test('too many digits (16) is rejected', () => {
    expect(normalizePhone('+1234567890123456')).toBeNull();
  });
});
