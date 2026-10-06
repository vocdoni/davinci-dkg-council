/**
 * Share recovery from on-chain dealings (protocol §8.6).
 *
 * Every check here is mandatory and hard-fails: a discrepancy between an
 * accepted proof and a failed check is a circuit/protocol incident requiring a
 * halt, not a dispute to adjudicate.
 *
 * Secret-handling module: pure computation, no I/O, no logging.
 */

import { P, R } from './constants.js';
import { G, hornerEval, mulPoint, pointEq } from './curve.js';
import { assertCanonicalScalar } from './encoding.js';
import { shareMask } from './dealing.js';
import type { Dealing, Hex, Point } from './types.js';

export interface RecoveryInput {
  /** The stored dealing context (must already be verified against the local recomputation, §9.3). */
  ctx: Hex;
  /** This member's 1-based index m. */
  memberIndex: number;
  /** This member's share-encryption secret x_m. */
  shareSecret: bigint;
  /** QUAL: the 1-based dealer indexes with accepted dealings. */
  qual: number[];
  /** Accepted dealings by dealer index (each as read back from the contract). */
  dealings: ReadonlyMap<number, Dealing>;
  /** PK_m as stored by the contract (TE). */
  expectedMemberKey: Point;
}

export interface RecoveredShare {
  /** s_m = Σ_{j in QUAL} s_{j,m} mod r. */
  share: bigint;
  /** The per-dealer shares s_{j,m}. */
  perDealer: Map<number, bigint>;
}

class RecoveryError extends Error {
  constructor(message: string) {
    super(`share recovery: ${message} — halt: this contradicts an accepted dealing proof`);
    this.name = 'RecoveryError';
  }
}

/**
 * Recover the member's final share from the accepted dealings, enforcing all
 * §8.6 checks (per-dealer range + Feldman, aggregate against PK_m).
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
    if (!dealing) throw new Error(`recoverShare: missing dealing from dealer ${j}`);
    const maskedShare = dealing.masked[m - 1];
    if (maskedShare === undefined) throw new Error(`recoverShare: dealing ${j} has no slot for member ${m}`);
    const S = mulPoint(dealing.E, input.shareSecret);
    const h = shareMask(input.ctx, j, m, S);
    const share = (((maskedShare - h) % P) + P) % P;
    // Check 1: s_{j,m} < r (cannot fail for an accepted dealing; detects wrong context/implementation).
    if (share >= R) throw new RecoveryError(`dealer ${j}: unmasked share not a canonical scalar`);
    // Check 2: s_{j,m}·G == Horner(C_j, m).
    if (!pointEq(mulPoint(G, share), hornerEval(dealing.C, m))) {
      throw new RecoveryError(`dealer ${j}: share does not match the Feldman commitments`);
    }
    perDealer.set(j, share);
    sum = (sum + share) % R;
  }
  // Check 3: s_m·G == PK_m as stored by the contract.
  if (!pointEq(mulPoint(G, sum), input.expectedMemberKey)) {
    throw new RecoveryError('aggregated share does not match the stored PK_m');
  }
  return { share: sum, perDealer };
}
