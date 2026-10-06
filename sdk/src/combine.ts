/**
 * Combine (protocol §10.3): Lagrange coefficients over F_r, per-field M_k
 * computation, plaintext search via BSGS, and the combine call arguments.
 *
 * The combiner needs no trust: it only proposes plaintexts the contract
 * verifies with the exact per-field group equation.
 */

import { MAX_COMBINE_FIELDS, R, RESULT_BOUND } from './constants.js';
import { solveDlog, type BsgsOptions } from './bsgs.js';
import {
  extAdd,
  extMul,
  extNeg,
  invMod,
  G,
  mulBase,
  pointEq,
  toAffine,
  toExtended,
  addPoints,
  mulPoint,
} from './curve.js';
import type { Hex, Point } from './types.js';

/**
 * Lagrange coefficients at zero for the member set S (1-based indexes):
 * λ_i = Π_{h in S, h != i} h · (h − i)^(-1) mod r (protocol §10.3).
 * The set must be strictly increasing (the contract's canonical order).
 */
export function lagrangeCoefficients(memberSet: number[]): Map<number, bigint> {
  if (memberSet.length === 0) throw new Error('lagrange: empty member set');
  for (let k = 0; k < memberSet.length; k++) {
    const v = memberSet[k] as number;
    if (!Number.isInteger(v) || v < 1 || v > 16) throw new Error('lagrange: member indexes must be in 1..16');
    if (k > 0 && v <= (memberSet[k - 1] as number)) throw new Error('lagrange: member set must be strictly increasing');
  }
  const out = new Map<number, bigint>();
  for (const i of memberSet) {
    let num = 1n;
    let den = 1n;
    for (const h of memberSet) {
      if (h === i) continue;
      num = (num * BigInt(h)) % R;
      den = (den * (((BigInt(h) - BigInt(i)) % R) + R)) % R;
    }
    out.set(i, (num * invMod(den, R)) % R);
  }
  return out;
}

/**
 * M_k = C2_k − Σ_{i in S} λ_i·D_{i,k} from public data (protocol §10.3).
 * `partials` maps member index -> that member's D_{i,k} for this field.
 */
export function combinedPoint(
  c2: Point,
  memberSet: number[],
  partials: ReadonlyMap<number, Point>,
  lambda?: Map<number, bigint>,
): Point {
  const coeffs = lambda ?? lagrangeCoefficients(memberSet);
  let acc = toExtended(c2);
  for (const i of memberSet) {
    const d = partials.get(i);
    if (!d) throw new Error(`combine: missing partial from member ${i}`);
    const l = coeffs.get(i);
    if (l === undefined) throw new Error(`combine: missing coefficient for member ${i}`);
    acc = extAdd(acc, extNeg(extMul(toExtended(d), l)));
  }
  return toAffine(acc);
}

/**
 * Solve one field's plaintext: find m_k < 2^40 with M_k == m_k·G.
 * Throws if the field has no in-range plaintext (such a field can never
 * complete; there is no out-of-range escape hatch).
 */
export function solvePlaintext(
  c2: Point,
  memberSet: number[],
  partials: ReadonlyMap<number, Point>,
  options?: BsgsOptions,
): bigint {
  const M = combinedPoint(c2, memberSet, partials);
  return solveDlog(M, { bound: RESULT_BOUND, ...options });
}

/**
 * Local mirror of the contract's exact per-field check:
 * m_k·G + Σ λ_i·D_{i,k} == C2_k.
 */
export function verifyCombine(
  plaintext: bigint,
  c2: Point,
  memberSet: number[],
  partials: ReadonlyMap<number, Point>,
): boolean {
  if (plaintext < 0n || plaintext >= RESULT_BOUND) return false;
  const coeffs = lagrangeCoefficients(memberSet);
  let acc = toExtended(mulBase(plaintext));
  for (const i of memberSet) {
    const d = partials.get(i);
    const l = coeffs.get(i);
    if (!d || l === undefined) return false;
    acc = extAdd(acc, extMul(toExtended(d), l));
  }
  const lhs = toAffine(acc);
  return pointEq(lhs, c2);
}

export interface CombineArgs {
  requestId: Hex;
  memberSet: number[];
  fieldIndexes: number[];
  plaintexts: bigint[];
}

/**
 * Build validated `combine(...)` call arguments for one chunk
 * (1..MAX_COMBINE_FIELDS strictly increasing field indexes).
 */
export function buildCombineArgs(
  requestId: Hex,
  memberSet: number[],
  fields: { fieldIndex: number; plaintext: bigint }[],
): CombineArgs {
  if (fields.length < 1 || fields.length > MAX_COMBINE_FIELDS) {
    throw new Error(`combine: 1..${MAX_COMBINE_FIELDS} fields per transaction`);
  }
  lagrangeCoefficients(memberSet); // validates the set shape
  const sorted = fields.slice().sort((a, b) => a.fieldIndex - b.fieldIndex);
  for (let k = 0; k < sorted.length; k++) {
    const f = sorted[k] as { fieldIndex: number; plaintext: bigint };
    if (!Number.isInteger(f.fieldIndex) || f.fieldIndex < 0 || f.fieldIndex > 15) {
      throw new Error('combine: field index out of range');
    }
    if (k > 0 && f.fieldIndex === (sorted[k - 1] as { fieldIndex: number }).fieldIndex) {
      throw new Error('combine: duplicate field index');
    }
    if (f.plaintext < 0n || f.plaintext >= RESULT_BOUND) throw new Error('combine: plaintext out of range');
  }
  return {
    requestId,
    memberSet,
    fieldIndexes: sorted.map((f) => f.fieldIndex),
    plaintexts: sorted.map((f) => f.plaintext),
  };
}

/** The architecture §1.8 gas guideline: fields per combine transaction for a threshold t. */
export function fieldsPerCombineTx(t: number): number {
  return Math.min(MAX_COMBINE_FIELDS, Math.max(1, Math.floor(32 / t)));
}

/**
 * ElGamal encryption helper for tests and the davinci-test app:
 * C1 = k·G, C2 = m·G + k·P with fresh randomness k.
 */
export function elgamalEncrypt(publicKey: Point, message: bigint, randomness: bigint): { c1: Point; c2: Point } {
  return {
    c1: mulBase(randomness),
    c2: addPoints(mulBase(message), mulPoint(publicKey, randomness)),
  };
}
