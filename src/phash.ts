/**
 * phash.ts — pure-JS perceptual image hashing for near-duplicate bill detection.
 *
 * Works inside a Cloudflare Worker (no native bindings, no canvas, no sharp).
 * Uses `jpeg-js` (pure JS, typed-array based) to decode the JPEG, then
 * replicates the well-known `imagehash.phash` algorithm from Python:
 *
 *   1. Grayscale + resize to 32x32 (box-average downsample)
 *   2. 2D DCT-II (unnormalized, matches scipy.fftpack.dct default)
 *   3. Take the top-left 8x8 low-frequency block
 *   4. Threshold each value against the block's median -> 64-bit hash
 *
 * Two images that "look the same" (recompressed, lightly cropped, resized)
 * produce hashes with a small Hamming distance. This catches the class of
 * duplicate bill photos that a plain SHA-256 exact-byte hash misses.
 *
 * NOTE: comparing hashes still requires a linear scan (see fraud.ts) since
 * there's no bitwise index in SQLite/D1 — fine at moderate submission
 * volumes, but revisit (e.g. an LSH index) if volume grows very large.
 */
import { decode as decodeJpeg } from "jpeg-js";

const HASH_SIZE = 8; // final hash grid -> 8*8 = 64 bits
const IMG_SIZE = 32; // DCT input size (32x32), matches highfreq_factor=4

/** Box-average downsample of RGBA pixel data to a `size x size` grayscale grid. */
function toGrayscaleSquare(rgba: Uint8Array, width: number, height: number, size: number): Float64Array {
  const out = new Float64Array(size * size);
  const xRatio = width / size;
  const yRatio = height / size;

  for (let ty = 0; ty < size; ty++) {
    const y0 = Math.floor(ty * yRatio);
    const y1 = Math.max(y0 + 1, Math.floor((ty + 1) * yRatio));
    for (let tx = 0; tx < size; tx++) {
      const x0 = Math.floor(tx * xRatio);
      const x1 = Math.max(x0 + 1, Math.floor((tx + 1) * xRatio));

      let sum = 0;
      let count = 0;
      for (let sy = y0; sy < Math.min(y1, height); sy++) {
        const rowOffset = sy * width * 4;
        for (let sx = x0; sx < Math.min(x1, width); sx++) {
          const i = rowOffset + sx * 4;
          sum += 0.299 * rgba[i] + 0.587 * rgba[i + 1] + 0.114 * rgba[i + 2];
          count++;
        }
      }
      out[ty * size + tx] = count > 0 ? sum / count : 0;
    }
  }
  return out;
}

/** 1D DCT-II, unnormalized (matches scipy.fftpack.dct default: type=2, norm=None). */
function dct1d(input: Float64Array): Float64Array {
  const N = input.length;
  const out = new Float64Array(N);
  const factor = Math.PI / N;
  for (let k = 0; k < N; k++) {
    let sum = 0;
    for (let n = 0; n < N; n++) {
      sum += input[n] * Math.cos(factor * (n + 0.5) * k);
    }
    out[k] = 2 * sum;
  }
  return out;
}

/** Separable 2D DCT-II over a size×size grid stored row-major. */
function dct2d(grid: Float64Array, size: number): Float64Array {
  const tmp = new Float64Array(size * size);
  for (let y = 0; y < size; y++) {
    const row = grid.slice(y * size, y * size + size);
    tmp.set(dct1d(row), y * size);
  }
  const out = new Float64Array(size * size);
  const col = new Float64Array(size);
  for (let x = 0; x < size; x++) {
    for (let y = 0; y < size; y++) col[y] = tmp[y * size + x];
    const colDct = dct1d(col);
    for (let y = 0; y < size; y++) out[y * size + x] = colDct[y];
  }
  return out;
}

/**
 * Computes a 64-bit perceptual hash of a JPEG image, returned as a
 * 16-character hex string. Throws on undecodable input — callers should
 * wrap this (see `computeNearDuplicateHash` in fraud.ts) and degrade
 * gracefully, since exact-hash duplicate detection still applies either way.
 */
export function computePerceptualHash(jpegBytes: Uint8Array): string {
  const decoded = decodeJpeg(jpegBytes, { useTArray: true } as any);
  const gray = toGrayscaleSquare(decoded.data as Uint8Array, decoded.width, decoded.height, IMG_SIZE);
  const dct = dct2d(gray, IMG_SIZE);

  const lowFreq: number[] = [];
  for (let y = 0; y < HASH_SIZE; y++) {
    for (let x = 0; x < HASH_SIZE; x++) {
      lowFreq.push(dct[y * IMG_SIZE + x]);
    }
  }

  const sorted = [...lowFreq].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;

  let bits = "";
  for (const v of lowFreq) bits += v > median ? "1" : "0";

  let hex = "";
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }
  return hex;
}

/** Hamming distance between two 16-char hex pHash strings (0–64). Returns -1 on invalid input. */
export function hammingDistanceHex(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return -1;
  let dist = 0;
  for (let i = 0; i < a.length; i++) {
    let x = parseInt(a[i], 16) ^ parseInt(b[i], 16);
    while (x) {
      dist += x & 1;
      x >>= 1;
    }
  }
  return dist;
}

/** Default near-duplicate threshold for a 64-bit hash — distance <= this is treated as "same bill". */
export const NEAR_DUPLICATE_THRESHOLD = 10;
