/**
 * Phase 18 agent-tools pure validation bits. Three of the four constants under
 * test (NAME_RE, the reserved list, and the dedupe-key hash builder) are
 * module-PRIVATE in the frozen source — they are not exported, and the slice
 * is tests-only, so we cannot import them. They are REPLICATED here verbatim,
 * with the integration suites as the drift alarm: agent-tools.test.ts exercises
 * the real NAME_RE / reserved list through the create API (each replicated
 * reject below has a matching 400 there), and tool-execution.test.ts asserts a
 * real POST carries a `toolCallId` equal to the row keyed by the real hash
 * builder — so a divergence between these replicas and the source fails an
 * integration test, not just this file.
 */
import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { stableStringify } from '../../src/core/managed-brain';

// --- replicas of the frozen source (see header) ---

// src/api/routes/agent-tools.ts
const NAME_RE = /^[a-z][a-z0-9_]{0,63}$/;
const RESERVED_TOOL_NAMES = [
  'trigger_workflow',
  'set_metadata',
  'resolve_conversation',
  'present_choices',
  'present_buttons',
  'request_input',
];

// src/core/managed-brain.ts, executeCustomTool (inline, not exported —
// but its canonicalizer, stableStringify, IS exported and imported above):
//   const argsHash = sha256(stableStringify(args)).hex
//   const dedupeKey = `tc-${inbound.id}-${def.name}-${argsHash.slice(0, 16)}`
function dedupeKey(inboundId: string, toolName: string, args: Record<string, unknown>): string {
  const argsHash = createHash('sha256').update(stableStringify(args)).digest('hex');
  return `tc-${inboundId}-${toolName}-${argsHash.slice(0, 16)}`;
}

describe('tool name regex ^[a-z][a-z0-9_]{0,63}$', () => {
  test('accepts snake_case names within 64 chars', () => {
    for (const name of ['a', 'refund_order', 'x9', 'a_b_c', 'tool_1', 'a'.repeat(64)]) {
      expect(NAME_RE.test(name), name).toBe(true);
    }
  });

  test('rejects leading digit/underscore, uppercase, punctuation, spaces, empties, overlength', () => {
    for (const name of [
      '',
      '1refund',
      '_refund',
      'Refund',
      'refund-order',
      'refund order',
      'refund.order',
      'réfund',
      'a'.repeat(65),
    ]) {
      expect(NAME_RE.test(name), name).toBe(false);
    }
  });
});

describe('the reserved built-in tool names', () => {
  test('there are exactly the six model-facing built-ins', () => {
    expect(RESERVED_TOOL_NAMES).toHaveLength(6);
    expect([...RESERVED_TOOL_NAMES].sort()).toEqual(
      [
        'present_buttons',
        'present_choices',
        'request_input',
        'resolve_conversation',
        'set_metadata',
        'trigger_workflow',
      ].sort(),
    );
  });

  test('every reserved name is itself a legal tool name (so the reserve, not the regex, is what rejects it)', () => {
    for (const name of RESERVED_TOOL_NAMES) {
      expect(NAME_RE.test(name), name).toBe(true);
    }
  });
});

describe('the content-keyed dedupe key (replica — asserted end-to-end in tool-execution.test.ts)', () => {
  test('shape is tc-<inboundId>-<tool>-<16 hex>', () => {
    const key = dedupeKey('msg-123', 'refund_order', { orderId: '#1' });
    expect(key).toMatch(/^tc-msg-123-refund_order-[0-9a-f]{16}$/);
  });

  test('deterministic for identical (inbound, tool, args)', () => {
    const args = { b: 2, a: 1 };
    expect(dedupeKey('m', 't', args)).toBe(dedupeKey('m', 't', args));
  });

  test('changes when args change (content-keyed, not call-order-keyed)', () => {
    expect(dedupeKey('m', 't', { a: 1 })).not.toBe(dedupeKey('m', 't', { a: 2 }));
  });

  test('is stableStringify-keyed: key order does NOT matter (canonicalized)', () => {
    // The source hashes stableStringify(args) — recursively sorted object
    // keys — so a retried model call emitting the same args in a different
    // key order lands on the SAME row instead of double-firing the POST.
    expect(dedupeKey('m', 't', { a: 1, b: 2 })).toBe(dedupeKey('m', 't', { b: 2, a: 1 }));
  });

  test('canonicalization is recursive: nested objects are order-insensitive, arrays keep order', () => {
    expect(dedupeKey('m', 't', { outer: { x: 1, y: { p: 'a', q: 'b' } }, list: [1, 2] })).toBe(
      dedupeKey('m', 't', { list: [1, 2], outer: { y: { q: 'b', p: 'a' }, x: 1 } }),
    );
    // Array order is CONTENT — reordering it must key differently.
    expect(dedupeKey('m', 't', { list: [1, 2] })).not.toBe(dedupeKey('m', 't', { list: [2, 1] }));
  });

  test('stableStringify matches JSON.stringify semantics on primitives and arrays', () => {
    for (const v of [null, true, 42, 'str', [1, 'two', null], { a: [{ b: 1 }] }]) {
      // Round-trip equality: canonical output parses back to the same value.
      expect(JSON.parse(stableStringify(v))).toEqual(v);
    }
    expect(stableStringify({ b: 2, a: 1 })).toBe('{"a":1,"b":2}');
  });

  test('separates by inbound message and by tool name', () => {
    expect(dedupeKey('m1', 't', { a: 1 })).not.toBe(dedupeKey('m2', 't', { a: 1 }));
    expect(dedupeKey('m', 't1', { a: 1 })).not.toBe(dedupeKey('m', 't2', { a: 1 }));
  });
});
