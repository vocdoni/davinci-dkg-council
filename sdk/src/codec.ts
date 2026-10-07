/**
 * Compressed point codec (protocol §2.5): one 32-byte word per point,
 * `compressed(x, y) = x | ((y & 1) << 255)` — x-plus-parity-of-y, NOT any
 * library's Edwards format.
 *
 * Bits 0..253 hold the canonical x < p, bit 254 is reserved and MUST be zero,
 * bit 255 is the parity of the canonical y. Decompression solves the TE curve
 * equation and takes a Tonelli–Shanks square root (p ≡ 1 mod 2^28, so the
 * (p+1)/4 shortcut is invalid for this field).
 *
 * This module validates the ENCODING only. The zero word decodes to (0, p−1),
 * a canonical on-curve point of order two — never "empty" and never identity;
 * the caller applies the subgroup/non-identity policy (e.g.
 * `assertValidSubgroupPoint`) and must never "repair" a point by cofactor
 * multiplication.
 */

import { P, TE_A, TE_D } from './constants.js';
import { invMod, isOnCurve, modP } from './curve.js';
import type { Point } from './types.js';

/** Why a strict decoder refused a word (the `decodeRejections` reasons of the codec vectors). */
export type DecodeRejection = 'bit254' | 'xNotCanonical' | 'nonResidue' | 'zeroRootOddParity';

/** Raised on any §2.5 encoding violation; `reason` is set for the strict-decode rejections. */
export class CodecError extends Error {
  constructor(
    message: string,
    readonly reason?: DecodeRejection,
  ) {
    super(message);
    this.name = 'CodecError';
  }
}

const BIT_254 = 1n << 254n;
const BIT_255 = 1n << 255n;
const WORD_MAX = (1n << 256n) - 1n;

function powMod(base: bigint, exp: bigint, m: bigint): bigint {
  let b = ((base % m) + m) % m;
  let r = 1n;
  let e = exp;
  while (e > 0n) {
    if (e & 1n) r = (r * b) % m;
    b = (b * b) % m;
    e >>= 1n;
  }
  return r;
}

// p − 1 = Q · 2^S with Q odd (S = 28 for BN254's scalar field).
const TS_S = (() => {
  let s = 0n;
  let q = P - 1n;
  while ((q & 1n) === 0n) {
    q >>= 1n;
    s++;
  }
  return s;
})();
const TS_Q = (P - 1n) >> TS_S;
// Smallest quadratic non-residue, found once by Euler's criterion.
const TS_Z = (() => {
  let z = 2n;
  while (powMod(z, (P - 1n) >> 1n, P) !== P - 1n) z++;
  return z;
})();

/** Tonelli–Shanks square root mod p; undefined when n is a non-residue. */
export function sqrtModP(n: bigint): bigint | undefined {
  const a = modP(n);
  if (a === 0n) return 0n;
  if (powMod(a, (P - 1n) >> 1n, P) !== 1n) return undefined;
  let m = TS_S;
  let c = powMod(TS_Z, TS_Q, P);
  let t = powMod(a, TS_Q, P);
  let r = powMod(a, (TS_Q + 1n) >> 1n, P);
  while (t !== 1n) {
    let i = 0n;
    let t2 = t;
    while (t2 !== 1n) {
      t2 = (t2 * t2) % P;
      i++;
      if (i === m) return undefined; // unreachable for residues; defensive
    }
    const b = powMod(c, 1n << (m - i - 1n), P);
    m = i;
    c = (b * b) % P;
    t = (t * c) % P;
    r = (r * b) % P;
  }
  return r;
}

/**
 * Compress a canonical on-curve TE point to its §2.5 word. Rejects
 * non-canonical coordinates and off-curve points (an off-curve point has no
 * valid encoding). Applies no subgroup policy.
 */
export function compressPoint(p: Point): bigint {
  if (p.x < 0n || p.x >= P || p.y < 0n || p.y >= P) {
    throw new CodecError('codec: coordinates must be canonical (< p)');
  }
  if (!isOnCurve(p)) throw new CodecError('codec: point is not on the curve');
  return p.x | ((p.y & 1n) << 255n);
}

/**
 * The contract's sqrt-free authentication of a supplied full point against a
 * stored compressed word, in its exact check order: (1) canonical coordinates,
 * (2) on-curve, (3) exact compressed equality. Returns the contract error name
 * instead of throwing so callers can mirror revert selection.
 */
export function authenticateCompressed(
  stored: bigint,
  supplied: Point,
): 'ok' | 'NonCanonical' | 'InvalidPoint' | 'CompressedPointMismatch' {
  if (supplied.x < 0n || supplied.x >= P || supplied.y < 0n || supplied.y >= P) return 'NonCanonical';
  if (!isOnCurve(supplied)) return 'InvalidPoint';
  if ((supplied.x | ((supplied.y & 1n) << 255n)) !== stored) return 'CompressedPointMismatch';
  return 'ok';
}

/**
 * Decompress a §2.5 word to its canonical TE point. Rejects words with bit
 * 254 set, x >= p, a non-residue y², or bit 255 set when y² = 0 (the only
 * root is y = 0, so the odd "root" would be y = p — not canonical; this is
 * the case of the two order-4 points x = ±sqrt(1/168700)). Applies no
 * subgroup policy: the zero word decodes to (0, p−1), an order-two point the
 * caller MUST reject for any key/ciphertext slot.
 */
export function decompressPoint(word: bigint): Point {
  if (word < 0n || word > WORD_MAX) throw new CodecError('codec: word out of range');
  if (word & BIT_254) throw new CodecError('codec: reserved bit 254 is set', 'bit254');
  const parity = (word & BIT_255) === BIT_255 ? 1n : 0n;
  const x = word & ~(BIT_255 | BIT_254);
  if (x >= P) throw new CodecError('codec: x is not canonical (>= p)', 'xNotCanonical');
  // y² = (1 − a·x²) / (1 − d·x²) mod p
  const xx = (x * x) % P;
  const den = modP(1n - (TE_D * xx) % P);
  if (den === 0n) throw new CodecError('codec: no curve point for this x');
  const yy = (modP(1n - (TE_A * xx) % P) * invMod(den, P)) % P;
  const root = sqrtModP(yy);
  if (root === undefined) throw new CodecError('codec: y² is a non-residue — no curve point for this x', 'nonResidue');
  // A zero root has no odd twin: P − 0 = p is not a canonical coordinate.
  const y = root === 0n ? 0n : (root & 1n) === parity ? root : P - root;
  if ((y & 1n) !== parity) {
    throw new CodecError(
      'codec: y is zero for this x, so an odd parity bit is not canonical (y = p)',
      'zeroRootOddParity',
    );
  }
  return { x, y };
}
