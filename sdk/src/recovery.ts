/**
 * Share recovery from current chain state (protocol §8.6, v2).
 *
 * Inputs come from authenticated reads only — the recovery slice
 * (`getRecoverySlice`: compressed E_j + masked_{j,m} per QUAL dealer), the
 * aggregates (`getAggregates`) and `getMemberKey` — never event logs or old
 * calldata. The per-dealer Feldman check of v1 no longer exists (the C_j are
 * not durable state); the aggregate check `s_m·G == Horner(A, m) == PK_m`
 * replaces it. Every check is mandatory and hard-fails: a discrepancy between
 * an accepted proof and a failed check is a circuit/protocol incident
 * requiring a halt — never repair, omit a dealer, or re-reduce.
 *
 * Secret-handling module: pure computation, no I/O, no logging.
 */

import { P, R } from './constants.js';
import { decompressPoint } from './codec.js';
import {
  assertValidSubgroupPoint,
  G,
  hornerEval,
  isCanonical,
  isIdentity,
  isInPrimeSubgroup,
  isOnCurve,
  mulPoint,
  pointEq,
} from './curve.js';
import { assertCanonicalScalar } from './encoding.js';
import { shareMask } from './dealing.js';
import type { Hex, Point, RecoverySlice } from './types.js';

/** One QUAL dealer's recovery data, exactly as stored on chain. */
export interface RecoveryDealing {
  /** compressed(E_j) per §2.5. */
  compressedE: bigint;
  /** masked_{j,m} for this member. */
  masked: bigint;
}

export interface RecoveryInput {
  /** The stored dealing context (must already be verified against the local recomputation, §9.3). */
  ctx: Hex;
  /** This member's 1-based index m. */
  memberIndex: number;
  /** This member's share-encryption secret x_m. */
  shareSecret: bigint;
  /** QUAL: the 1-based dealer indexes with accepted dealings. */
  qual: number[];
  /** Per-QUAL-dealer recovery data (from `getRecoverySlice`). */
  dealings: ReadonlyMap<number, RecoveryDealing>;
  /** The stored aggregates A_0..A_15 (full TE, identity padded above t−1). */
  aggregates: Point[];
  /** PK_m as returned by the contract's `getMemberKey` (TE). */
  expectedMemberKey: Point;
}

export interface RecoveredShare {
  /** s_m = Σ_{j in QUAL} s_{j,m} mod r. */
  share: bigint;
  /** The per-dealer shares s_{j,m}. */
  perDealer: Map<number, bigint>;
}

export class RecoveryError extends Error {
  constructor(message: string) {
    super(`share recovery: ${message} — halt: this contradicts an accepted dealing proof`);
    this.name = 'RecoveryError';
  }
}

/** Turn a `getRecoverySlice` result into the QUAL list + per-dealer map. */
export function recoveryDealingsFromSlice(slice: RecoverySlice): {
  qual: number[];
  dealings: Map<number, RecoveryDealing>;
} {
  const qual: number[] = [];
  const dealings = new Map<number, RecoveryDealing>();
  for (let j = 1; j <= 16; j++) {
    if ((slice.qualBitmap & (1 << (j - 1))) === 0) continue;
    const compressedE = slice.compressedE[j - 1];
    const masked = slice.maskedShares[j - 1];
    if (compressedE === undefined || masked === undefined) {
      throw new Error(`recovery slice: missing slot for QUAL dealer ${j}`);
    }
    qual.push(j);
    dealings.set(j, { compressedE, masked });
  }
  return { qual, dealings };
}

/**
 * Recover the member's final share, enforcing all §8.6 checks: E_j validated
 * after decompression and before any secret-dependent arithmetic; s_{j,m} < r
 * per dealer; every A_k canonical/on-curve/subgroup (identity allowed);
 * s_m·G == Horner(A, m) == the stored PK_m.
 */
export function recoverShare(input: RecoveryInput): RecoveredShare {
  const { memberIndex: m, qual } = input;
  if (m < 1 || m > 16) throw new Error('recoverShare: member index out of range');
  assertCanonicalScalar(input.shareSecret, 'x_m');
  if (qual.length === 0) throw new Error('recoverShare: empty QUAL');
  const seen = new Set<number>();
  const perDealer = new Map<number, bigint>();
  let sum = 0n;
  for (const j of qual) {
    if (seen.has(j)) throw new Error(`recoverShare: duplicate dealer ${j} in QUAL`);
    seen.add(j);
    const dealing = input.dealings.get(j);
    if (!dealing) throw new Error(`recoverShare: missing recovery data for dealer ${j}`);
    // Decompress and validate E_j BEFORE any secret-dependent arithmetic.
    const E = decompressPoint(dealing.compressedE);
    assertValidSubgroupPoint(E, `recoverShare: E_${j}`);
    const S = mulPoint(E, input.shareSecret);
    const h = shareMask(input.ctx, j, m, S);
    const share = (((dealing.masked - h) % P) + P) % P;
    // Check 1: s_{j,m} < r (cannot fail for an accepted dealing; detects wrong context/implementation).
    if (share >= R) throw new RecoveryError(`dealer ${j}: unmasked share not a canonical scalar`);
    perDealer.set(j, share);
    sum = (sum + share) % R;
  }
  // Check 2: every stored aggregate is canonical, on curve and in the prime subgroup (identity allowed).
  if (input.aggregates.length !== 16) throw new Error('recoverShare: aggregates must have 16 entries');
  input.aggregates.forEach((A, k) => {
    if (!isCanonical(A) || !isOnCurve(A) || (!isIdentity(A) && !isInPrimeSubgroup(A))) {
      throw new RecoveryError(`aggregate A_${k} is not a valid subgroup point`);
    }
  });
  // Check 3: s_m·G == Horner(A, m) == PK_m as stored by the contract.
  const pk = hornerEval(input.aggregates, m);
  if (!pointEq(pk, input.expectedMemberKey)) {
    throw new RecoveryError('Horner(A, m) does not match the stored PK_m');
  }
  if (!pointEq(mulPoint(G, sum), pk)) {
    throw new RecoveryError('aggregated share does not match PK_m');
  }
  return { share: sum, perDealer };
}
