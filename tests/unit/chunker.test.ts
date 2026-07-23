/**
 * Phase 23 slice E — the pure chunker (src/core/chunker.ts). Boundary matrix
 * only; no infra. Every case pins a DETERMINISTIC output for a hand-computed
 * input, using tiny maxTokens so short strings exercise the same packing the
 * ~800-token default does at scale.
 *
 * tokens = ceil(chars / 4). A 4-char paragraph = 1 token; that identity is the
 * lever every case below is built on.
 */
import { describe, expect, test } from 'vitest';
import { chunkText, estimateTokens, type Chunk } from '../../src/core/chunker';

const contents = (chunks: Chunk[]) => chunks.map((c) => c.content);

describe('chunker — token estimate', () => {
  test('ceil(chars/4)', () => {
    expect(estimateTokens('')).toBe(0);
    expect(estimateTokens('a')).toBe(1);
    expect(estimateTokens('abcd')).toBe(1);
    expect(estimateTokens('abcde')).toBe(2);
  });
});

describe('chunker — multi-paragraph packing (<= cap)', () => {
  test('several small paragraphs pack together, no chunk over the cap', () => {
    // 6 one-token paragraphs; cap 3 tokens, no overlap → pure packing.
    const text = ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF'].join('\n\n');
    const chunks = chunkText(text, { maxTokens: 3, overlapTokens: 0 });

    // The PACKING invariant is on unit tokens (the '\n\n' joiners the reported
    // tokenCount also counts are not part of the budget): the paragraphs packed
    // into each chunk sum to at most the cap.
    for (const c of chunks) {
      const unitTokens = c.content.split('\n\n').reduce((s, p) => s + estimateTokens(p), 0);
      expect(unitTokens).toBeLessThanOrEqual(3);
    }
    // ...and packing actually happened (a chunk holds MORE than one paragraph,
    // joined on the paragraph boundary).
    expect(chunks.some((c) => c.content.includes('\n\n'))).toBe(true);
    // No content is lost or reordered: paragraphs appear in order across chunks.
    const flat = contents(chunks).join('\n\n');
    for (const p of ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF']) {
      expect(flat).toContain(p);
    }
    // With cap 3 and 1-token paragraphs → exactly two full chunks of three.
    expect(contents(chunks)).toEqual(['AAAA\n\nBBBB\n\nCCCC', 'DDDD\n\nEEEE\n\nFFFF']);
  });
});

describe('chunker — overlap carry', () => {
  test('the tail paragraph of a chunk reappears as the head of the next', () => {
    // 6 one-token paragraphs, cap 3, overlap 1 → the last packed paragraph of
    // each chunk is carried into the next (see hand-trace in the source).
    const text = ['AAAA', 'BBBB', 'CCCC', 'DDDD', 'EEEE', 'FFFF'].join('\n\n');
    const chunks = chunkText(text, { maxTokens: 3, overlapTokens: 1 });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    // CCCC ends chunk 0 and begins chunk 1; EEEE ends chunk 1 and begins chunk 2.
    expect(chunks[0].content).toContain('CCCC');
    expect(chunks[1].content.startsWith('CCCC')).toBe(true);
    expect(chunks[1].content).toContain('EEEE');
    expect(chunks[2].content.startsWith('EEEE')).toBe(true);
    // Concretely:
    expect(contents(chunks)).toEqual([
      'AAAA\n\nBBBB\n\nCCCC',
      'CCCC\n\nDDDD\n\nEEEE',
      'EEEE\n\nFFFF',
    ]);
  });
});

describe('chunker — oversized paragraph sentence-splits', () => {
  test('a single over-cap paragraph is split ON sentence boundaries, none broken', () => {
    // One paragraph, three ~10-token sentences; cap 12 tokens holds ONE sentence
    // but not two → the over-cap paragraph splits on sentence boundaries, each
    // sentence (<= cap) staying intact — no fragment ends mid-sentence.
    const s1 = 'Returns are accepted within thirty days.';
    const s2 = 'Opened electronics cannot be returned.';
    const s3 = 'Refunds post in five business days.';
    const chunks = chunkText(`${s1} ${s2} ${s3}`, { maxTokens: 12, overlapTokens: 0 });

    expect(chunks.length).toBeGreaterThan(1);
    // Every original sentence survives whole inside some chunk.
    for (const s of [s1, s2, s3]) {
      expect(chunks.some((c) => c.content.includes(s))).toBe(true);
    }
    // No chunk carries a broken sentence head like "Returns are accepted within"
    // without its terminating period — each chunk's sentences all end in punctuation.
    for (const c of chunks) {
      const trimmed = c.content.trim();
      expect(/[.!?]$/.test(trimmed)).toBe(true);
    }
  });
});

describe('chunker — oversized sentence hard-splits', () => {
  test('a single over-cap sentence (no breaks) is hard-split by char window', () => {
    // 50 non-space chars = one paragraph, one sentence, well over a 5-token cap.
    const text = 'x'.repeat(50);
    const chunks = chunkText(text, { maxTokens: 5, overlapTokens: 0 });

    // maxChars = 5*4 = 20 → 20 + 20 + 10.
    expect(contents(chunks)).toEqual(['x'.repeat(20), 'x'.repeat(20), 'x'.repeat(10)]);
    // Every piece is at or under the cap...
    for (const c of chunks) expect(c.tokenCount).toBeLessThanOrEqual(5);
    // ...and hard slices concatenate back to the exact original (sep '').
    expect(contents(chunks).join('')).toBe(text);
  });
});

describe('chunker — empty input', () => {
  test('empty string yields no chunks', () => {
    expect(chunkText('')).toEqual([]);
  });
  test('whitespace / blank-line only yields no chunks', () => {
    expect(chunkText('   \n\n  \t \n\n')).toEqual([]);
  });
});

describe('chunker — determinism', () => {
  test('same input twice produces byte-identical output', () => {
    const text = [
      'Acme return policy.',
      'You may return most items within 30 days of delivery.',
      'Opened electronics are non-returnable once the seal is broken.',
      '',
      'Refunds are issued to the original payment method.',
    ].join('\n\n');
    const a = chunkText(text, { maxTokens: 8, overlapTokens: 2 });
    const b = chunkText(text, { maxTokens: 8, overlapTokens: 2 });
    expect(a).toEqual(b);
    // And the default-option path is equally stable.
    expect(chunkText(text)).toEqual(chunkText(text));
  });
});
