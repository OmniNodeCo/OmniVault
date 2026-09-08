'use strict';

/**
 * Minimal QR-code encoder — zero dependencies.
 *
 * Supports exactly what the LAN banner needs: byte mode, error-correction
 * level L, versions 1–5 (up to 106 bytes — enough for any LAN URL) and mask
 * pattern 0. The layout follows the classic, widely-implemented algorithm
 * (finder/timing/alignment patterns, BCH-protected format info, Reed-Solomon
 * error correction over GF(256)).
 */

// ------------------------------------------------------------ GF(256)

const GF_EXP = new Uint8Array(512);
const GF_LOG = new Uint8Array(256);
(function initGf() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    GF_EXP[i] = x;
    GF_LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d; // primitive polynomial
  }
  for (let i = 255; i < 512; i++) GF_EXP[i] = GF_EXP[i - 255];
})();

function gfMul(a, b) {
  if (a === 0 || b === 0) return 0;
  return GF_EXP[GF_LOG[a] + GF_LOG[b]];
}

/** Reed-Solomon generator polynomial (monic, highest degree first). */
function rsGenerator(degree) {
  let poly = [1];
  for (let i = 0; i < degree; i++) {
    const next = new Array(poly.length + 1).fill(0);
    for (let j = 0; j < poly.length; j++) {
      next[j] ^= poly[j]; // × x
      next[j + 1] ^= gfMul(poly[j], GF_EXP[i]); // × α^i
    }
    poly = next;
  }
  return poly;
}

/** Error-correction codewords for the given data codewords. */
function rsRemainder(data, degree) {
  const gen = rsGenerator(degree);
  const res = data.concat(new Array(degree).fill(0));
  for (let i = 0; i < data.length; i++) {
    const factor = res[i];
    if (factor === 0) continue;
    for (let j = 0; j < gen.length; j++) res[i + j] ^= gfMul(gen[j], factor);
  }
  return res.slice(data.length);
}

// ------------------------------------------------------------ versions

/** EC-level-L capacities for versions 1–5 (single block each). */
const VERSIONS = [
  null,
  { size: 21, dataCodewords: 19, ecCodewords: 7, align: [] },
  { size: 25, dataCodewords: 34, ecCodewords: 10, align: [6, 18] },
  { size: 29, dataCodewords: 55, ecCodewords: 15, align: [6, 22] },
  { size: 33, dataCodewords: 80, ecCodewords: 20, align: [6, 26] },
  { size: 37, dataCodewords: 108, ecCodewords: 26, align: [6, 30] }
];

const MAX_INPUT = 106; // V5-L byte-mode capacity
const EC_LEVEL_L = 0b01;
const MASK_PATTERN = 0; // any mask is valid; decoders read it from format info

// ------------------------------------------------------------ format info

/** BCH(15,5)-encode the 5 format bits, then XOR the static mask. */
function formatBits(ecBits, mask) {
  const data = (ecBits << 3) | mask;
  let d = data << 10;
  while (bitLength(d) > 10) {
    d ^= 0x537 << (bitLength(d) - 11);
  }
  return ((data << 10) | d) ^ 0x5412;
}

function bitLength(x) {
  let n = 0;
  while (x) {
    n++;
    x >>>= 1;
  }
  return n;
}

// ------------------------------------------------------------ encoding

/** Build the final codeword array (data + EC) for the input text. */
function codewordsFor(text, version) {
  const bytes = Array.from(Buffer.from(text, 'utf8'));
  const spec = VERSIONS[version];

  // Bit stream: mode (0100) + 8-bit length + data + terminator + padding.
  const bits = [];
  const push = (value, count) => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >>> i) & 1);
  };
  push(0b0100, 4);
  push(bytes.length, 8);
  for (const b of bytes) push(b, 8);
  const capacityBits = spec.dataCodewords * 8;
  const terminator = Math.min(4, capacityBits - bits.length);
  push(0, terminator);
  while (bits.length % 8 !== 0) bits.push(0);
  const data = [];
  for (let i = 0; i < bits.length; i += 8) {
    let byte = 0;
    for (let j = 0; j < 8; j++) byte = (byte << 1) | bits[i + j];
    data.push(byte);
  }
  const pads = [0xec, 0x11];
  for (let i = 0; data.length < spec.dataCodewords; i++) data.push(pads[i % 2]);

  return data.concat(rsRemainder(data, spec.ecCodewords));
}

// ------------------------------------------------------------ matrix

function makeMatrix(version, codewords) {
  const { size, align } = VERSIONS[version];
  const modules = [];
  for (let r = 0; r < size; r++) modules.push(new Array(size).fill(null));

  const set = (row, col, dark) => {
    if (row >= 0 && row < size && col >= 0 && col < size) modules[row][col] = dark;
  };

  // Finder patterns + separators (9×9 area per corner).
  const finder = (row, col) => {
    for (let r = -1; r <= 7; r++) {
      for (let c = -1; c <= 7; c++) {
        if (row + r < 0 || row + r >= size || col + c < 0 || col + c >= size) continue;
        const dark =
          (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
          (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
          (r >= 2 && r <= 4 && c >= 2 && c <= 4);
        set(row + r, col + c, dark);
      }
    }
  };
  finder(0, 0);
  finder(size - 7, 0);
  finder(0, size - 7);

  // Alignment patterns (skip any overlapping a finder — null check).
  for (const r of align) {
    for (const c of align) {
      if (modules[r][c] !== null) continue;
      for (let dr = -2; dr <= 2; dr++) {
        for (let dc = -2; dc <= 2; dc++) {
          set(r + dr, c + dc, Math.max(Math.abs(dr), Math.abs(dc)) !== 1);
        }
      }
    }
  }

  // Timing patterns.
  for (let i = 8; i < size - 8; i++) {
    if (modules[i][6] === null) modules[i][6] = i % 2 === 0;
    if (modules[6][i] === null) modules[6][i] = i % 2 === 0;
  }

  // Format info (both copies) + the dark module.
  const fmt = formatBits(EC_LEVEL_L, MASK_PATTERN);
  for (let i = 0; i < 15; i++) {
    const dark = ((fmt >> i) & 1) === 1;
    if (i < 6) modules[i][8] = dark;
    else if (i < 8) modules[i + 1][8] = dark;
    else modules[size - 15 + i][8] = dark;

    if (i < 8) modules[8][size - 1 - i] = dark;
    else if (i < 9) modules[8][15 - i] = dark;
    else modules[8][14 - i] = dark;
  }
  modules[size - 8][8] = true;

  // Data placement: two-column zigzag from the bottom-right, skipping
  // function modules, applying mask pattern 0 ((row + col) % 2 === 0).
  let inc = -1;
  let row = size - 1;
  let bitIndex = 7;
  let byteIndex = 0;
  for (let col = size - 1; col > 0; col -= 2) {
    if (col === 6) col--;
    for (;;) {
      for (let c = 0; c < 2; c++) {
        const r = row;
        const cc = col - c;
        if (modules[r][cc] === null) {
          let dark = false;
          if (byteIndex < codewords.length) dark = ((codewords[byteIndex] >>> bitIndex) & 1) === 1;
          if ((r + cc) % 2 === 0) dark = !dark;
          modules[r][cc] = dark;
          bitIndex--;
          if (bitIndex === -1) {
            byteIndex++;
            bitIndex = 7;
          }
        }
      }
      row += inc;
      if (row < 0 || row >= size) {
        row -= inc;
        inc = -inc;
        break;
      }
    }
  }
  return modules;
}

// ------------------------------------------------------------ public API

function pickVersion(text) {
  const len = Buffer.byteLength(text, 'utf8');
  for (let v = 1; v < VERSIONS.length; v++) {
    if (len <= VERSIONS[v].dataCodewords - 2) return v;
  }
  throw new Error(`Text is too long for a QR code (max ${MAX_INPUT} bytes)`);
}

/**
 * Encode text into a QR matrix (array of rows of booleans, dark = true).
 * Byte mode, EC level L, versions 1–5, mask 0.
 */
function qrMatrix(text) {
  if (typeof text !== 'string' || !text.length) throw new Error('Text is required');
  const version = pickVersion(text);
  return makeMatrix(version, codewordsFor(text, version));
}

/** Render a QR matrix as terminal-friendly ASCII with a quiet zone. */
function qrAscii(text, opts) {
  const options = opts || {};
  const dark = options.dark || '██';
  const light = options.light || '  ';
  const matrix = qrMatrix(text);
  const n = matrix.length;
  const quiet = 4;
  const lines = [];
  for (let r = -quiet; r < n + quiet; r++) {
    let line = '';
    for (let c = -quiet; c < n + quiet; c++) {
      const inBounds = r >= 0 && r < n && c >= 0 && c < n;
      line += inBounds && matrix[r][c] ? dark : light;
    }
    lines.push(line);
  }
  return lines;
}

module.exports = { qrMatrix, qrAscii, pickVersion, MAX_INPUT };
