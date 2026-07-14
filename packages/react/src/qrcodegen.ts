/*
 * QR Code generator — vendored, zero-dependency.
 *
 * Adapted from "QR Code generator library" by Project Nayuki.
 *   https://www.nayuki.io/page/qr-code-generator-library
 *
 * Copyright (c) Project Nayuki. (MIT License)
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy of
 * this software and associated documentation files (the "Software"), to deal in
 * the Software without restriction, including without limitation the rights to
 * use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 * the Software, and to permit persons to whom the Software is furnished to do so,
 * subject to the following conditions:
 * - The above copyright notice and this permission notice shall be included in all
 *   copies or substantial portions of the Software.
 * - The Software is provided "as is", without warranty of any kind, express or
 *   implied, including but not limited to the warranties of merchantability,
 *   fitness for a particular purpose and noninfringement. In no event shall the
 *   authors or copyright holders be liable for any claim, damages or other
 *   liability, whether in an action of contract, tort or otherwise, arising from,
 *   out of or in connection with the Software or the use or other dealings in the
 *   Software.
 *
 * This is a focused subset of Nayuki's reference TypeScript port: it encodes text
 * in QR Model 2, byte mode, error-correction level M, with automatic version
 * selection (1..40) and optimal data-mask selection by the standard penalty rules.
 */

// --- Error-correction level M tables (indexed by version 1..40; index 0 unused) ---

// Number of error-correction codewords per block.
const ECC_CODEWORDS_PER_BLOCK: number[] = [
  -1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26,
  26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28,
];

// Number of error-correction blocks.
const NUM_ERROR_CORRECTION_BLOCKS: number[] = [
  -1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18,
  20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49,
];

// Format-info ECC-level field for level M is 0b00 (L=0b01, M=0b00, Q=0b11, H=0b10).
const ECC_FORMAT_BITS = 0;

const PENALTY_N1 = 3;
const PENALTY_N2 = 3;
const PENALTY_N3 = 40;
const PENALTY_N4 = 10;

/** Total number of data modules (bits) in a QR symbol of the given version. */
function getNumRawDataModules(ver: number): number {
  let result = (16 * ver + 128) * ver + 64;
  if (ver >= 2) {
    const numAlign = Math.floor(ver / 7) + 2;
    result -= (25 * numAlign - 10) * numAlign - 55;
    if (ver >= 7) result -= 36;
  }
  return result;
}

/** Number of 8-bit data codewords (not counting ECC) at ECC level M. */
function getNumDataCodewords(ver: number): number {
  return (
    Math.floor(getNumRawDataModules(ver) / 8) -
    ECC_CODEWORDS_PER_BLOCK[ver] * NUM_ERROR_CORRECTION_BLOCKS[ver]
  );
}

/** Push the low `len` bits of `val` (most-significant first) onto the bit buffer. */
function appendBits(val: number, len: number, bb: number[]): void {
  if (len < 0 || len > 31 || val >>> len !== 0) throw new RangeError('Value out of range');
  for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

function getBit(x: number, i: number): boolean {
  return ((x >>> i) & 1) !== 0;
}

// --- Reed-Solomon over GF(256), primitive polynomial x^8 + x^4 + x^3 + x^2 + 1 ---

function reedSolomonMultiply(x: number, y: number): number {
  let z = 0;
  for (let i = 7; i >= 0; i--) {
    z = (z << 1) ^ ((z >>> 7) * 0x11d);
    z ^= ((y >>> i) & 1) * x;
  }
  return z & 0xff;
}

/** Compute the Reed-Solomon generator polynomial's coefficients for `degree`. */
function reedSolomonComputeDivisor(degree: number): number[] {
  const result: number[] = [];
  for (let i = 0; i < degree - 1; i++) result.push(0);
  result.push(1); // Start off with the monomial x^0

  // Multiply by (x - r^0)(x - r^1)...(x - r^{degree-1}) where r = 0x02.
  let root = 1;
  for (let i = 0; i < degree; i++) {
    for (let j = 0; j < result.length; j++) {
      result[j] = reedSolomonMultiply(result[j], root);
      if (j + 1 < result.length) result[j] ^= result[j + 1];
    }
    root = reedSolomonMultiply(root, 0x02);
  }
  return result;
}

/** Compute the remainder of `data` divided by the RS `divisor`. */
function reedSolomonComputeRemainder(data: readonly number[], divisor: readonly number[]): number[] {
  const result: number[] = divisor.map(() => 0);
  for (const b of data) {
    const factor = b ^ (result.shift() as number);
    result.push(0);
    divisor.forEach((coef, i) => (result[i] ^= reedSolomonMultiply(coef, factor)));
  }
  return result;
}

/** Split data codewords into blocks, append ECC, and interleave per the spec. */
function addEccAndInterleave(data: readonly number[], version: number): number[] {
  const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[version];
  const blockEccLen = ECC_CODEWORDS_PER_BLOCK[version];
  const rawCodewords = Math.floor(getNumRawDataModules(version) / 8);
  const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
  const shortBlockLen = Math.floor(rawCodewords / numBlocks);

  const blocks: number[][] = [];
  const rsDiv = reedSolomonComputeDivisor(blockEccLen);
  for (let i = 0, k = 0; i < numBlocks; i++) {
    const dat = data.slice(k, k + shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1));
    k += dat.length;
    const ecc = reedSolomonComputeRemainder(dat, rsDiv);
    if (i < numShortBlocks) dat.push(0);
    blocks.push(dat.concat(ecc));
  }

  const result: number[] = [];
  for (let i = 0; i < blocks[0].length; i++) {
    blocks.forEach((block, j) => {
      // The last data codeword of a short block is a phantom pad; skip it.
      if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
    });
  }
  return result;
}

// --- The symbol itself ---

class QrCode {
  readonly size: number;
  private readonly modules: boolean[][] = [];
  private readonly isFunction: boolean[][] = [];
  mask = -1;

  constructor(version: number, dataCodewords: readonly number[], msk: number) {
    this.size = version * 4 + 17;
    for (let y = 0; y < this.size; y++) {
      this.modules.push(new Array(this.size).fill(false));
      this.isFunction.push(new Array(this.size).fill(false));
    }

    this.drawFunctionPatterns(version);
    const allCodewords = addEccAndInterleave(dataCodewords, version);
    this.drawCodewords(allCodewords);

    // Pick the mask with the lowest penalty.
    if (msk === -1) {
      let minPenalty = Infinity;
      for (let i = 0; i < 8; i++) {
        this.applyMask(i);
        this.drawFormatBits(i);
        const penalty = this.getPenaltyScore();
        if (penalty < minPenalty) {
          msk = i;
          minPenalty = penalty;
        }
        this.applyMask(i); // Undoes the mask due to XOR
      }
    }
    this.mask = msk;
    this.applyMask(msk);
    this.drawFormatBits(msk);
    this.drawVersion(version);
  }

  getModule(x: number, y: number): boolean {
    return x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x];
  }

  private setFunctionModule(x: number, y: number, isDark: boolean): void {
    this.modules[y][x] = isDark;
    this.isFunction[y][x] = true;
  }

  private drawFunctionPatterns(version: number): void {
    // Timing patterns
    for (let i = 0; i < this.size; i++) {
      this.setFunctionModule(6, i, i % 2 === 0);
      this.setFunctionModule(i, 6, i % 2 === 0);
    }

    // Three finder patterns (with their separators, drawn as light border cells)
    this.drawFinderPattern(3, 3);
    this.drawFinderPattern(this.size - 4, 3);
    this.drawFinderPattern(3, this.size - 4);

    // Alignment patterns (skip the three that collide with finders)
    const alignPatPos = getAlignmentPatternPositions(version, this.size);
    const numAlign = alignPatPos.length;
    for (let i = 0; i < numAlign; i++) {
      for (let j = 0; j < numAlign; j++) {
        if (
          !(
            (i === 0 && j === 0) ||
            (i === 0 && j === numAlign - 1) ||
            (i === numAlign - 1 && j === 0)
          )
        ) {
          this.drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
        }
      }
    }

    // Reserve format and version areas; filled with real bits later.
    this.drawFormatBits(0);
    this.drawVersion(version);
  }

  private drawFinderPattern(x: number, y: number): void {
    for (let dy = -4; dy <= 4; dy++) {
      for (let dx = -4; dx <= 4; dx++) {
        const dist = Math.max(Math.abs(dx), Math.abs(dy));
        const xx = x + dx;
        const yy = y + dy;
        if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
          this.setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
        }
      }
    }
  }

  private drawAlignmentPattern(x: number, y: number): void {
    for (let dy = -2; dy <= 2; dy++) {
      for (let dx = -2; dx <= 2; dx++) {
        this.setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
      }
    }
  }

  private drawFormatBits(mask: number): void {
    // 5-bit data (2-bit ECC + 3-bit mask), then BCH(15,5) error correction.
    const data = (ECC_FORMAT_BITS << 3) | mask;
    let rem = data;
    for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
    const bits = ((data << 10) | rem) ^ 0x5412; // uint15
    const size = this.size;

    // First copy, around the top-left finder.
    for (let i = 0; i <= 5; i++) this.setFunctionModule(8, i, getBit(bits, i));
    this.setFunctionModule(8, 7, getBit(bits, 6));
    this.setFunctionModule(8, 8, getBit(bits, 7));
    this.setFunctionModule(7, 8, getBit(bits, 8));
    for (let i = 9; i < 15; i++) this.setFunctionModule(14 - i, 8, getBit(bits, i));

    // Second copy, split across the other two finders.
    for (let i = 0; i < 8; i++) this.setFunctionModule(size - 1 - i, 8, getBit(bits, i));
    for (let i = 8; i < 15; i++) this.setFunctionModule(8, size - 15 + i, getBit(bits, i));
    this.setFunctionModule(8, size - 8, true); // Always-dark module
  }

  private drawVersion(version: number): void {
    if (version < 7) return;
    // 6-bit version, then BCH(18,6) error correction.
    let rem = version;
    for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1f25);
    const bits = (version << 12) | rem; // uint18
    const size = this.size;
    for (let i = 0; i < 18; i++) {
      const bit = getBit(bits, i);
      const a = size - 11 + (i % 3);
      const b = Math.floor(i / 3);
      this.setFunctionModule(a, b, bit);
      this.setFunctionModule(b, a, bit);
    }
  }

  private drawCodewords(data: readonly number[]): void {
    let i = 0; // Bit index into data
    for (let right = this.size - 1; right >= 1; right -= 2) {
      if (right === 6) right = 5; // Skip the vertical timing column
      for (let vert = 0; vert < this.size; vert++) {
        for (let j = 0; j < 2; j++) {
          const x = right - j;
          const upward = ((right + 1) & 2) === 0;
          const y = upward ? this.size - 1 - vert : vert;
          if (!this.isFunction[y][x] && i < data.length * 8) {
            this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
            i++;
          }
        }
      }
    }
  }

  private applyMask(mask: number): void {
    for (let y = 0; y < this.size; y++) {
      for (let x = 0; x < this.size; x++) {
        let invert: boolean;
        switch (mask) {
          case 0:
            invert = (x + y) % 2 === 0;
            break;
          case 1:
            invert = y % 2 === 0;
            break;
          case 2:
            invert = x % 3 === 0;
            break;
          case 3:
            invert = (x + y) % 3 === 0;
            break;
          case 4:
            invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0;
            break;
          case 5:
            invert = ((x * y) % 2) + ((x * y) % 3) === 0;
            break;
          case 6:
            invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          case 7:
            invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0;
            break;
          default:
            throw new Error('unreachable');
        }
        if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
      }
    }
  }

  private getPenaltyScore(): number {
    let result = 0;
    const size = this.size;

    // Rule 1: adjacent modules in a row of the same color.
    for (let y = 0; y < size; y++) {
      let runColor = false;
      let runX = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let x = 0; x < size; x++) {
        if (this.modules[y][x] === runColor) {
          runX++;
          if (runX === 5) result += PENALTY_N1;
          else if (runX > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runX, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = this.modules[y][x];
          runX = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runX, runHistory) * PENALTY_N3;
    }
    // Rule 1: adjacent modules in a column of the same color.
    for (let x = 0; x < size; x++) {
      let runColor = false;
      let runY = 0;
      const runHistory = [0, 0, 0, 0, 0, 0, 0];
      for (let y = 0; y < size; y++) {
        if (this.modules[y][x] === runColor) {
          runY++;
          if (runY === 5) result += PENALTY_N1;
          else if (runY > 5) result++;
        } else {
          this.finderPenaltyAddHistory(runY, runHistory);
          if (!runColor) result += this.finderPenaltyCountPatterns(runHistory) * PENALTY_N3;
          runColor = this.modules[y][x];
          runY = 1;
        }
      }
      result += this.finderPenaltyTerminateAndCount(runColor, runY, runHistory) * PENALTY_N3;
    }

    // Rule 2: 2x2 blocks of the same color.
    for (let y = 0; y < size - 1; y++) {
      for (let x = 0; x < size - 1; x++) {
        const color = this.modules[y][x];
        if (
          color === this.modules[y][x + 1] &&
          color === this.modules[y + 1][x] &&
          color === this.modules[y + 1][x + 1]
        ) {
          result += PENALTY_N2;
        }
      }
    }

    // Rule 3 is folded into the finder-pattern counting above (rule 1 loops).

    // Rule 4: balance of dark vs. light modules.
    let dark = 0;
    for (const row of this.modules) for (const color of row) if (color) dark++;
    const total = size * size;
    const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
    result += k * PENALTY_N4;
    return result;
  }

  // Counts finder-like 1:1:3:1:1 patterns touching the current run.
  private finderPenaltyCountPatterns(runHistory: readonly number[]): number {
    const n = runHistory[1];
    const core =
      n > 0 &&
      runHistory[2] === n &&
      runHistory[3] === n * 3 &&
      runHistory[4] === n &&
      runHistory[5] === n;
    return (
      (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0) +
      (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0)
    );
  }

  private finderPenaltyTerminateAndCount(
    currentRunColor: boolean,
    currentRunLength: number,
    runHistory: number[],
  ): number {
    if (currentRunColor) {
      this.finderPenaltyAddHistory(currentRunLength, runHistory);
      currentRunLength = 0;
    }
    currentRunLength += this.size; // Add light border to final run
    this.finderPenaltyAddHistory(currentRunLength, runHistory);
    return this.finderPenaltyCountPatterns(runHistory);
  }

  private finderPenaltyAddHistory(currentRunLength: number, runHistory: number[]): void {
    if (runHistory[0] === 0) currentRunLength += this.size; // Add light border to initial run
    runHistory.pop();
    runHistory.unshift(currentRunLength);
  }
}

/** Alignment-pattern center coordinates for the given version (empty for v1). */
function getAlignmentPatternPositions(version: number, size: number): number[] {
  if (version === 1) return [];
  const numAlign = Math.floor(version / 7) + 2;
  const step = version === 32 ? 26 : Math.ceil((version * 4 + 4) / (numAlign * 2 - 2)) * 2;
  const result = [6];
  for (let pos = size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
  return result;
}

/** Encode `str` as a UTF-8 byte array (no dependency on TextEncoder). */
function toUtf8ByteArray(str: string): number[] {
  const result: number[] = [];
  for (const ch of str) {
    const cp = ch.codePointAt(0) as number;
    if (cp < 0x80) {
      result.push(cp);
    } else if (cp < 0x800) {
      result.push(0xc0 | (cp >>> 6), 0x80 | (cp & 0x3f));
    } else if (cp < 0x10000) {
      result.push(0xe0 | (cp >>> 12), 0x80 | ((cp >>> 6) & 0x3f), 0x80 | (cp & 0x3f));
    } else {
      result.push(
        0xf0 | (cp >>> 18),
        0x80 | ((cp >>> 12) & 0x3f),
        0x80 | ((cp >>> 6) & 0x3f),
        0x80 | (cp & 0x3f),
      );
    }
  }
  return result;
}

/** A finished QR matrix: its side length and a per-module accessor. */
export interface QrMatrix {
  /** Side length in modules (not counting the quiet zone). */
  size: number;
  /** True when the module at (x, y) is dark. Out-of-range reads return false. */
  getModule(x: number, y: number): boolean;
}

/**
 * Encode `text` as a QR Code (Model 2, byte mode, ECC level M) and return its
 * module matrix. The version (1..40) is chosen as the smallest that fits, and
 * the data mask is chosen to minimize the standard penalty score.
 *
 * @throws RangeError if the text is too long for even version 40.
 */
export function encodeText(text: string): QrMatrix {
  const data = toUtf8ByteArray(text);

  // Smallest version whose data capacity holds the payload.
  let version = 1;
  for (; ; version++) {
    if (version > 40) throw new RangeError('Data too long for a QR Code');
    const capacityBits = getNumDataCodewords(version) * 8;
    const ccBits = version <= 9 ? 8 : 16; // Byte-mode character-count width
    const usedBits = 4 + ccBits + data.length * 8;
    if (usedBits <= capacityBits) break;
  }

  // Build the bit stream: mode indicator, char count, payload.
  const bb: number[] = [];
  appendBits(0x4, 4, bb); // Byte mode indicator
  appendBits(data.length, version <= 9 ? 8 : 16, bb);
  for (const b of data) appendBits(b, 8, bb);

  // Terminator, bit padding, then alternating pad bytes.
  const capacityBits = getNumDataCodewords(version) * 8;
  appendBits(0, Math.min(4, capacityBits - bb.length), bb);
  appendBits(0, (8 - (bb.length % 8)) % 8, bb);
  for (let padByte = 0xec; bb.length < capacityBits; padByte ^= 0xec ^ 0x11) {
    appendBits(padByte, 8, bb);
  }

  // Pack bits into codeword bytes.
  const dataCodewords: number[] = [];
  while (dataCodewords.length * 8 < bb.length) dataCodewords.push(0);
  bb.forEach((b, i) => (dataCodewords[i >>> 3] |= b << (7 - (i & 7))));

  const qr = new QrCode(version, dataCodewords, -1);
  return { size: qr.size, getModule: (x, y) => qr.getModule(x, y) };
}
