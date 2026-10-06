/**
 * BabyJubJub arithmetic in the circomlib twisted Edwards chart (protocol §2.1).
 *
 * Affine points use the `Point` type; the hot paths (BSGS, Horner ladders) use
 * extended twisted Edwards coordinates (X:Y:T:Z) with the unified add-2008-hwcd
 * formulas, which are complete for BabyJubJub (a = 168700 is a square in F_p,
 * d = 168696 is not), so no special-casing of identity or doubling is needed.
 *
 * Pure math: this module performs no I/O and never logs.
 */

import { FORM_K, FORM_K_INV, GX, GY, P, R, TE_A, TE_D } from './constants.js';
import type { Point } from './types.js';

export const G: Point = { x: GX, y: GY };
export const IDENTITY: Point = { x: 0n, y: 1n };

const mod = (a: bigint, m: bigint): bigint => {
  const v = a % m;
  return v < 0n ? v + m : v;
};

export const modP = (a: bigint): bigint => mod(a, P);
export const modR = (a: bigint): bigint => mod(a, R);

/** Modular inverse via extended Euclid. Throws on non-invertible input. */
export function invMod(a: bigint, m: bigint): bigint {
  let t = 0n;
  let newT = 1n;
  let rr = m;
  let newR = mod(a, m);
  while (newR !== 0n) {
    const q = rr / newR;
    [t, newT] = [newT, t - q * newT];
    [rr, newR] = [newR, rr - q * newR];
  }
  if (rr !== 1n) throw new Error('invMod: not invertible');
  return mod(t, m);
}

/** Extended twisted Edwards coordinates: x = X/Z, y = Y/Z, T = X·Y/Z. */
export interface ExtPoint {
  X: bigint;
  Y: bigint;
  T: bigint;
  Z: bigint;
}

export const EXT_IDENTITY: ExtPoint = { X: 0n, Y: 1n, T: 0n, Z: 1n };

export function toExtended(p: Point): ExtPoint {
  return { X: p.x, Y: p.y, T: modP(p.x * p.y), Z: 1n };
}

export function toAffine(e: ExtPoint): Point {
  const zInv = invMod(e.Z, P);
  return { x: modP(e.X * zInv), y: modP(e.Y * zInv) };
}

/** Unified, complete extended addition (add-2008-hwcd). */
export function extAdd(p1: ExtPoint, p2: ExtPoint): ExtPoint {
  const A = modP(p1.X * p2.X);
  const B = modP(p1.Y * p2.Y);
  const C = modP(TE_D * modP(p1.T * p2.T));
  const D = modP(p1.Z * p2.Z);
  const E = modP(modP((p1.X + p1.Y) * (p2.X + p2.Y)) - A - B);
  const F = modP(D - C);
  const Gg = modP(D + C);
  const H = modP(B - TE_A * A);
  return { X: modP(E * F), Y: modP(Gg * H), T: modP(E * H), Z: modP(F * Gg) };
}

/** Extended doubling (dbl-2008-hwcd). */
export function extDouble(p1: ExtPoint): ExtPoint {
  const A = modP(p1.X * p1.X);
  const B = modP(p1.Y * p1.Y);
  const C = modP(2n * modP(p1.Z * p1.Z));
  const D = modP(TE_A * A);
  const t0 = modP(p1.X + p1.Y);
  const E = modP(modP(t0 * t0) - A - B);
  const Gg = modP(D + B);
  const F = modP(Gg - C);
  const H = modP(D - B);
  return { X: modP(E * F), Y: modP(Gg * H), T: modP(E * H), Z: modP(F * Gg) };
}

export function extNeg(p1: ExtPoint): ExtPoint {
  return { X: modP(-p1.X), Y: p1.Y, T: modP(-p1.T), Z: p1.Z };
}

export function pointNeg(p1: Point): Point {
  return { x: modP(-p1.x), y: p1.y };
}

export function pointEq(a: Point, b: Point): boolean {
  return a.x === b.x && a.y === b.y;
}

export function isIdentity(p1: Point): boolean {
  return p1.x === 0n && p1.y === 1n;
}

export function addPoints(a: Point, b: Point): Point {
  return toAffine(extAdd(toExtended(a), toExtended(b)));
}

export function subPoints(a: Point, b: Point): Point {
  return toAffine(extAdd(toExtended(a), extNeg(toExtended(b))));
}

/** Double-and-add scalar multiplication. `scalar` is reduced mod nothing: caller passes canonical scalars. */
export function extMul(base: ExtPoint, scalar: bigint): ExtPoint {
  if (scalar < 0n) throw new Error('extMul: negative scalar');
  let acc = EXT_IDENTITY;
  let cur = base;
  let s = scalar;
  while (s > 0n) {
    if (s & 1n) acc = extAdd(acc, cur);
    s >>= 1n;
    if (s > 0n) cur = extDouble(cur);
  }
  return acc;
}

export function mulPoint(base: Point, scalar: bigint): Point {
  return toAffine(extMul(toExtended(base), scalar));
}

export function mulBase(scalar: bigint): Point {
  return mulPoint(G, scalar);
}

/** Canonical coordinates: both < p. */
export function isCanonical(p1: Point): boolean {
  return p1.x >= 0n && p1.x < P && p1.y >= 0n && p1.y < P;
}

/** a·x² + y² == 1 + d·x²·y² in F_p (TE chart). */
export function isOnCurve(p1: Point): boolean {
  if (!isCanonical(p1)) return false;
  const x2 = modP(p1.x * p1.x);
  const y2 = modP(p1.y * p1.y);
  return modP(TE_A * x2 + y2) === modP(1n + modP(TE_D * modP(x2 * y2)));
}

/** r·P == O. Assumes the point is on the curve. */
export function isInPrimeSubgroup(p1: Point): boolean {
  const e = extMul(toExtended(p1), R);
  // r·P = O  <=>  X == 0 and Y == Z (projective identity).
  return modP(e.X) === 0n && modP(e.Y - e.Z) === 0n;
}

/** Full validity check for an externally supplied point: canonical, on curve, prime subgroup, not identity. */
export function assertValidSubgroupPoint(p1: Point, label: string): void {
  if (!isCanonical(p1)) throw new Error(`${label}: non-canonical coordinate`);
  if (!isOnCurve(p1)) throw new Error(`${label}: not on curve`);
  if (isIdentity(p1)) throw new Error(`${label}: identity point`);
  if (!isInPrimeSubgroup(p1)) throw new Error(`${label}: not in the prime-order subgroup`);
}

// --- TE <-> reduced-form map (protocol §2.2) ---

export function teToReduced(p1: Point): Point {
  return { x: modP(p1.x * FORM_K), y: p1.y };
}

export function reducedToTe(p1: Point): Point {
  return { x: modP(p1.x * FORM_K_INV), y: p1.y };
}

// --- Batch normalization (Montgomery's trick) for the BSGS hot path ---

/**
 * Convert many extended points to affine with a single field inversion.
 * Returns an array of affine points in the same order.
 */
export function batchToAffine(points: ExtPoint[]): Point[] {
  const nPts = points.length;
  if (nPts === 0) return [];
  const prefix = new Array<bigint>(nPts);
  let acc = 1n;
  for (let i = 0; i < nPts; i++) {
    prefix[i] = acc;
    acc = modP(acc * (points[i] as ExtPoint).Z);
  }
  let inv = invMod(acc, P);
  const out = new Array<Point>(nPts);
  for (let i = nPts - 1; i >= 0; i--) {
    const pt = points[i] as ExtPoint;
    const zInv = modP(inv * (prefix[i] as bigint));
    inv = modP(inv * pt.Z);
    out[i] = { x: modP(pt.X * zInv), y: modP(pt.Y * zInv) };
  }
  return out;
}

/**
 * Horner evaluation over commitment points: `Σ_{k} m^k·C_k` computed as
 * `Acc = C_15; for k = 14..0: Acc = m·Acc + C_k` (protocol §8.5 item 4).
 * `m` is a small member index (1..16).
 */
export function hornerEval(C: Point[], m: number): Point {
  if (C.length === 0) throw new Error('hornerEval: empty commitment vector');
  let acc = toExtended(C[C.length - 1] as Point);
  for (let k = C.length - 2; k >= 0; k--) {
    acc = extMul(acc, BigInt(m));
    acc = extAdd(acc, toExtended(C[k] as Point));
  }
  return toAffine(acc);
}
