/**
 * Baby-step/giant-step discrete logarithm on BabyJubJub, bounded by 2^40
 * (protocol §10.3). Pure computation.
 *
 * The baby-step table (default 2^20 entries) is built once with extended
 * coordinates and chunked batch inversion (Montgomery's trick), then reused
 * across fields and requests. Giant steps are likewise normalized in chunks,
 * so the amortized cost per group element is one extended add plus ~3 field
 * multiplications, with one field inversion per chunk.
 */

import { RESULT_BOUND } from './constants.js';
import {
  batchToAffine,
  EXT_IDENTITY,
  extAdd,
  extMul,
  extNeg,
  G,
  isIdentity,
  mulBase,
  pointEq,
  toExtended,
  type ExtPoint,
} from './curve.js';
import type { Point } from './types.js';

const DEFAULT_BABY_STEPS = 1 << 20;
const CHUNK = 4096;

/** Map key encoding a point uniquely: (x << 1) | parity(y). */
const pointKey = (p: Point): bigint => (p.x << 1n) | (p.y & 1n);

export class BsgsTable {
  /** point key -> baby index j (0 <= j < m). */
  private readonly table: Map<bigint, number>;
  readonly babySteps: number;

  private constructor(table: Map<bigint, number>, babySteps: number) {
    this.table = table;
    this.babySteps = babySteps;
  }

  /**
   * Precompute the baby-step table j·G for j in [0, babySteps). With the
   * default 2^20 steps this takes a few seconds and on the order of 100 MB;
   * build it once and keep it.
   */
  static build(babySteps: number = DEFAULT_BABY_STEPS): BsgsTable {
    if (babySteps < 1 || !Number.isInteger(babySteps)) throw new Error('babySteps must be a positive integer');
    const table = new Map<bigint, number>();
    const gExt = toExtended(G);
    let cur: ExtPoint = EXT_IDENTITY;
    let j = 0;
    while (j < babySteps) {
      const chunk: ExtPoint[] = [];
      const count = Math.min(CHUNK, babySteps - j);
      for (let i = 0; i < count; i++) {
        chunk.push(cur);
        cur = extAdd(cur, gExt);
      }
      const affine = batchToAffine(chunk);
      for (let i = 0; i < count; i++) {
        table.set(pointKey(affine[i] as Point), j + i);
      }
      j += count;
    }
    return new BsgsTable(table, babySteps);
  }

  lookup(p: Point): number | undefined {
    return this.table.get(pointKey(p));
  }
}

export interface BsgsOptions {
  /** Exclusive upper bound on the exponent; defaults to RESULT_BOUND = 2^40. */
  bound?: bigint;
  /** A prebuilt baby-step table to reuse. */
  table?: BsgsTable;
}

/**
 * Find m with m·G == M and 0 <= m < bound, or throw. The result is verified
 * by a final scalar multiplication before being returned.
 */
export function solveDlog(M: Point, options: BsgsOptions = {}): bigint {
  const bound = options.bound ?? RESULT_BOUND;
  if (bound < 1n) throw new Error('solveDlog: bound must be positive');
  if (isIdentity(M)) return 0n;
  const table = options.table ?? BsgsTable.build();
  const m = BigInt(table.babySteps);
  const giantCount = (bound + m - 1n) / m;
  // -m·G, added each giant step: T_i = M - i·(m·G).
  const negStep = extNeg(extMul(toExtended(G), m));
  let cur: ExtPoint = toExtended(M);
  let i = 0n;
  while (i < giantCount) {
    const count = Number(giantCount - i < BigInt(CHUNK) ? giantCount - i : BigInt(CHUNK));
    const chunk: ExtPoint[] = [];
    for (let k = 0; k < count; k++) {
      chunk.push(cur);
      cur = extAdd(cur, negStep);
    }
    const affine = batchToAffine(chunk);
    for (let k = 0; k < count; k++) {
      const j = table.lookup(affine[k] as Point);
      if (j !== undefined) {
        const candidate = (i + BigInt(k)) * m + BigInt(j);
        if (candidate < bound && pointEq(mulBase(candidate), M)) return candidate;
      }
    }
    i += BigInt(count);
  }
  throw new Error(`solveDlog: no exponent below 2^${bound.toString(2).length - 1} found`);
}
