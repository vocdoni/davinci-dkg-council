/**
 * Combine (protocol §10.3): Lagrange coefficients over F_r, per-field M_k
 * computation, plaintext search via BSGS, and the combine call arguments.
 *
 * The combiner needs no trust: it only proposes plaintexts the contract
 * verifies with the exact per-field group equation.
 */

import { MAX_COMBINE_FIELDS, MAX_FIELDS, R, RESULT_BOUND } from './constants.js';
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
import { partialDataHash } from './partial.js';
import type { Hex, PartialCommitment, Point } from './types.js';

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
  /** One padded D vector (16 slots) per memberSet entry, in memberSet order (§10.3). */
  partialVectors: Point[][];
  /** C2_k per fieldIndexes entry — the contract authenticates them against the stored compressed words. */
  C2: Point[];
}

/**
 * Build validated `combine(...)` call arguments for one chunk
 * (1..MAX_COMBINE_FIELDS strictly increasing field indexes). `partialVectors`
 * maps member index -> that member's full padded D vector (use
 * `sourcePartialVectors`); the args carry them in memberSet order.
 */
export function buildCombineArgs(
  requestId: Hex,
  memberSet: number[],
  fields: { fieldIndex: number; plaintext: bigint; c2: Point }[],
  partialVectors: ReadonlyMap<number, Point[]>,
): CombineArgs {
  if (fields.length < 1 || fields.length > MAX_COMBINE_FIELDS) {
    throw new Error(`combine: 1..${MAX_COMBINE_FIELDS} fields per transaction`);
  }
  lagrangeCoefficients(memberSet); // validates the set shape
  const sorted = fields.slice().sort((a, b) => a.fieldIndex - b.fieldIndex);
  for (let k = 0; k < sorted.length; k++) {
    const f = sorted[k] as { fieldIndex: number };
    if (!Number.isInteger(f.fieldIndex) || f.fieldIndex < 0 || f.fieldIndex > 15) {
      throw new Error('combine: field index out of range');
    }
    if (k > 0 && f.fieldIndex === (sorted[k - 1] as { fieldIndex: number }).fieldIndex) {
      throw new Error('combine: duplicate field index');
    }
    const pt = (sorted[k] as { plaintext: bigint }).plaintext;
    if (pt < 0n || pt >= RESULT_BOUND) throw new Error('combine: plaintext out of range');
  }
  const vectors = memberSet.map((i) => {
    const v = partialVectors.get(i);
    if (!v) throw new Error(`combine: missing partial vector for member ${i}`);
    if (v.length !== MAX_FIELDS) throw new Error(`combine: member ${i} vector must be padded to 16 slots`);
    return v.slice();
  });
  return {
    requestId,
    memberSet,
    fieldIndexes: sorted.map((f) => f.fieldIndex),
    plaintexts: sorted.map((f) => f.plaintext),
    partialVectors: vectors,
    C2: sorted.map((f) => f.c2),
  };
}

/** Per-field view of sourced vectors: member index -> D_{i,k}, for `solvePlaintext`/`verifyCombine`. */
export function fieldPartials(vectors: ReadonlyMap<number, Point[]>, fieldIndex: number): Map<number, Point> {
  const out = new Map<number, Point>();
  for (const [i, v] of vectors) {
    const d = v[fieldIndex];
    if (!d) throw new Error(`combine: member ${i} vector has no slot ${fieldIndex}`);
    out.set(i, d);
  }
  return out;
}

/** Keyed D-vector cache; a plain `Map` satisfies it. */
export type PartialVectorCache = Pick<Map<string, Point[]>, 'get' | 'set'>;

export function partialVectorCacheKey(
  chainId: bigint,
  manager: Hex,
  requestId: Hex,
  index: number,
  dataHash: Hex,
): string {
  return `${chainId}:${manager.toLowerCase()}:${requestId.toLowerCase()}:${index}:${dataHash.toLowerCase()}`;
}

/** The narrow reads `sourcePartialVectors` needs (implemented by the client). */
export interface PartialVectorSource {
  /** `getPartialCommitment(requestId, index)` through authenticated reads. */
  getPartialCommitment(requestId: Hex, index: number): Promise<PartialCommitment>;
  /**
   * ONE `eth_getLogs` restricted to the stored `publishedBlock`, filtered on
   * the pinned manager address and `PartialDataPublished(requestId)` for this
   * member — the single owner-approved log read of the protocol (§10.4).
   * Returns the emitted padded D vector, or undefined if the block no longer
   * holds it (pruned node, reorged provider). May reject when every provider
   * refuses the historical read; `sourcePartialVectors` treats that as a
   * missing vector, never as an error.
   */
  fetchPublishedVector(requestId: Hex, index: number, publishedBlock: bigint): Promise<Point[] | undefined>;
}

/**
 * Source the D vector of every member in `memberSet` in the normative §10.4
 * order: own cache, else the single-block log fetch at the stored
 * `publishedBlock` — either way the vector is only used if its recomputed
 * `partialDataHash` equals the hash stored on chain. Members whose vector
 * cannot be authenticated land in `missing`: republish via a
 * `publishPartialData` action (permissionless) and call this again.
 *
 * History is optional: a log read that fails (a provider that prunes or
 * refuses old blocks) makes that member's vector missing — listed in
 * `unavailable` as well — and never fails the call, so the deterministic
 * republication from authenticated current state stays reachable. Only the
 * authenticated commitment read can throw.
 */
export async function sourcePartialVectors(args: {
  chainId: bigint;
  manager: Hex;
  ceremonyId: Hex;
  requestId: Hex;
  fieldCount: number;
  memberSet: number[];
  source: PartialVectorSource;
  cache?: PartialVectorCache;
}): Promise<{
  vectors: Map<number, Point[]>;
  /** Members whose vector could not be authenticated (republish, then call again). */
  missing: number[];
  /** The subset of `missing` whose historical read failed outright (history unavailable). */
  unavailable: number[];
}> {
  const vectors = new Map<number, Point[]>();
  const missing: number[] = [];
  const unavailable: number[] = [];
  for (const i of args.memberSet) {
    const c = await args.source.getPartialCommitment(args.requestId, i);
    if (!c.accepted) throw new Error(`combine: member ${i} has no admitted partial`);
    const matches = (D: Point[]): boolean =>
      D.length === MAX_FIELDS &&
      partialDataHash({
        chainId: args.chainId,
        manager: args.manager,
        ceremonyId: args.ceremonyId,
        requestId: args.requestId,
        participantIndex: i,
        fieldCount: args.fieldCount,
        D,
      }).toLowerCase() === c.dataHash.toLowerCase();
    const key = partialVectorCacheKey(args.chainId, args.manager, args.requestId, i, c.dataHash);
    const cached = args.cache?.get(key);
    if (cached && matches(cached)) {
      vectors.set(i, cached);
      continue;
    }
    let fetched: Point[] | undefined;
    try {
      fetched = await args.source.fetchPublishedVector(args.requestId, i, c.publishedBlock);
    } catch {
      unavailable.push(i);
      missing.push(i);
      continue;
    }
    if (fetched && matches(fetched)) {
      args.cache?.set(key, fetched);
      vectors.set(i, fetched);
      continue;
    }
    missing.push(i);
  }
  return { vectors, missing, unavailable };
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
