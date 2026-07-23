/**
 * Phase 23 knowledge chunker — pure, deterministic, unit-testable.
 *
 * Splits a document into ~800-token chunks on PARAGRAPH boundaries, with a
 * ~100-token overlap carried from the tail of the previous chunk so a fact
 * that straddles a boundary is retrievable from either side. A paragraph is
 * never split mid-way UNLESS it alone exceeds the cap — then it is
 * sentence-split, and a single over-cap sentence is hard-split by character
 * window (last resort, keeps every unit ≤ cap so packing terminates).
 *
 * TOKEN ESTIMATE: tokens ≈ ceil(chars / 4). This is the well-known rough
 * heuristic for English text under BPE tokenizers (~4 chars/token). It is an
 * APPROXIMATION, not a real tokenizer — deliberately, so the chunker stays a
 * pure function with zero deps. Real embedding providers accept generously
 * over our target, so a modest under/over-estimate never overflows an API
 * limit; it only nudges chunk sizes. Retrieval quality is unaffected.
 */

export interface Chunk {
  content: string;
  /** Estimated token count of `content` (ceil(chars/4)). */
  tokenCount: number;
}

export interface ChunkOptions {
  /** Target chunk size in estimated tokens (default 800). */
  maxTokens?: number;
  /** Tokens of tail overlap carried into the next chunk (default 100). */
  overlapTokens?: number;
}

const DEFAULT_MAX_TOKENS = 800;
const DEFAULT_OVERLAP_TOKENS = 100;

/** tokens ≈ ceil(chars / 4) — the documented approximation (see file header). */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

/** A packing unit: a paragraph, a sentence, or a hard character slice. */
interface Unit {
  content: string;
  tokens: number;
  /** Separator placed BEFORE this unit when it is not first in a chunk. */
  sep: string;
}

/** Split into non-empty paragraphs on blank lines; each paragraph is trimmed. */
function paragraphs(text: string): string[] {
  return text
    .replace(/\r\n/g, '\n')
    .split(/\n[ \t]*\n+/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0);
}

/** Split a paragraph into sentences on ., !, ? followed by whitespace. */
function sentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** Hard-split a string that is itself over the cap into char-window pieces. */
function hardSplit(text: string, maxTokens: number): string[] {
  const maxChars = Math.max(1, maxTokens * 4);
  const pieces: string[] = [];
  for (let i = 0; i < text.length; i += maxChars) {
    pieces.push(text.slice(i, i + maxChars));
  }
  return pieces;
}

/**
 * Flatten the document into packing units, each ≤ maxTokens. Whole paragraphs
 * stay intact (sep '\n\n'); an over-cap paragraph becomes sentence units
 * (sep ' '); an over-cap sentence becomes hard char slices (sep '').
 */
function toUnits(text: string, maxTokens: number): Unit[] {
  const units: Unit[] = [];
  for (const para of paragraphs(text)) {
    if (estimateTokens(para) <= maxTokens) {
      units.push({ content: para, tokens: estimateTokens(para), sep: '\n\n' });
      continue;
    }
    // Oversized paragraph: sentence-split. The first sentence keeps the
    // paragraph separator; the rest join with a space (same paragraph).
    let first = true;
    for (const sentence of sentences(para)) {
      const parts = estimateTokens(sentence) <= maxTokens ? [sentence] : hardSplit(sentence, maxTokens);
      for (let i = 0; i < parts.length; i += 1) {
        const content = parts[i];
        units.push({
          content,
          tokens: estimateTokens(content),
          // paragraph boundary only at the very first unit of this paragraph;
          // sentence pieces join with a space, hard slices join with nothing.
          sep: first ? '\n\n' : i === 0 ? ' ' : '',
        });
        first = false;
      }
    }
  }
  return units;
}

/** Join a run of units into the chunk text (first unit drops its separator). */
function joinUnits(units: Unit[]): string {
  return units.map((u, i) => (i === 0 ? u.content : u.sep + u.content)).join('');
}

/** Tail units of a chunk whose tokens sum to ≥ overlapTokens (for carry). */
function tailUnits(units: Unit[], overlapTokens: number): Unit[] {
  if (overlapTokens <= 0) return [];
  const tail: Unit[] = [];
  let sum = 0;
  for (let i = units.length - 1; i >= 0; i -= 1) {
    tail.unshift(units[i]);
    sum += units[i].tokens;
    if (sum >= overlapTokens) break;
  }
  return tail;
}

/**
 * Chunk `text` into ~maxTokens-token chunks with ~overlapTokens of tail
 * overlap. Deterministic and pure: same input → identical output, no I/O.
 */
export function chunkText(text: string, opts: ChunkOptions = {}): Chunk[] {
  const maxTokens = opts.maxTokens ?? DEFAULT_MAX_TOKENS;
  const overlapTokens = opts.overlapTokens ?? DEFAULT_OVERLAP_TOKENS;

  const units = toUnits(text, maxTokens);
  if (units.length === 0) return [];

  const chunks: Chunk[] = [];
  let carry: Unit[] = [];
  let i = 0;

  while (i < units.length) {
    const current: Unit[] = [...carry];
    let currentTokens = carry.reduce((s, u) => s + u.tokens, 0);
    let added = 0;

    // Always consume at least one NEW unit per chunk (guarantees progress even
    // when the carried overlap alone already meets the cap — no infinite loop).
    while (i < units.length) {
      const u = units[i];
      if (added > 0 && currentTokens + u.tokens > maxTokens) break;
      current.push(u);
      currentTokens += u.tokens;
      added += 1;
      i += 1;
    }

    const content = joinUnits(current);
    chunks.push({ content, tokenCount: estimateTokens(content) });

    // Carry the tail of THIS chunk into the next one for overlap. When the
    // whole document is consumed, no next chunk needs it.
    carry = i < units.length ? tailUnits(current, overlapTokens) : [];
  }

  return chunks;
}
