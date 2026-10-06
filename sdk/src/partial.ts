/**
 * Partial decryption: §9.3 pre-checks, D computation, the pinned witness JSON
 * and the 67-word public input vector (protocol §10.1).
 *
 * The authenticated-read parts of §9.3 (items 1–3) live in the client module;
 * this module provides the pure checks (items 4–6) and must be fed state that
 * was read through the authenticated snapshot.
 *
 * Secret-handling module: pure computation, no I/O, no logging.
 */

import { MAX_FIELDS, Phase } from './constants.js';
import {
  assertValidSubgroupPoint,
  G,
  IDENTITY,
  mulPoint,
  pointEq,
} from './curve.js';
import { assertCanonicalScalar, toDecimal } from './encoding.js';
import type { CiphertextField, Hex, PartialRequestSnapshot, Point } from './types.js';

/**
 * §9.3 item 4: every C1_k and C2_k must be canonical, on curve and in the
 * prime subgroup, re-checked locally in TE; an invalid point is rejected,
 * never "repaired" by cofactor multiplication.
 */
export function validateCiphertextFields(cts: CiphertextField[]): void {
  if (cts.length < 1 || cts.length > MAX_FIELDS) throw new Error('fieldCount must be 1..16');
  cts.forEach((ct, k) => {
    assertValidSubgroupPoint(ct.c1, `C1[${k}]`);
    assertValidSubgroupPoint(ct.c2, `C2[${k}]`);
  });
}

/** §9.3 item 5: the recovered s_i is canonical and s_i·G == PK_i as stored on chain. */
export function checkRecoveredShare(share: bigint, expectedMemberKey: Point): void {
  assertCanonicalScalar(share, 's_i');
  if (!pointEq(mulPoint(G, share), expectedMemberKey)) {
    throw new Error('recovered share does not match the on-chain PK_i');
  }
}

/** The pinned witness-input JSON of `partial.circom` (protocol §10.1). */
export interface PartialWitnessInput {
  PK: string[];
  activeCount: string;
  C1: string[][];
  D: string[][];
  s: string;
}

export interface BuiltPartial {
  /** D_0..D_15 in TE, identity padding for k >= fieldCount. */
  D: Point[];
  /** C1 padded with G for k >= fieldCount (the contract's padding). */
  C1: Point[];
  witnessInput: PartialWitnessInput;
  /** The 67-word public input vector (protocol §10.1 table). */
  publicSignals: bigint[];
}

/**
 * Perform EVERY §9.3 pre-check against an authenticated snapshot and only
 * then compute the partial decryption D_k = s_i·C1_k (padding, witness JSON
 * and public input vector per §10.1).
 *
 * This is the only public entry point for computing a partial. `snapshot`
 * must come from `CouncilClient.getPartialRequestSnapshot` (authenticated
 * multi-provider reads at one finalized anchor); `pins` are the caller's own
 * pinned deployment, cross-checked against the snapshot's. Checks, in order:
 *
 * 1. snapshot chain id and manager equal the caller's pins;
 * 2. the ceremony is Live;
 * 3. the request exists (fieldCount 1..16) and the snapshot is internally
 *    consistent (cts length, participantIndex within 1..n);
 * 4. every C1_k and C2_k is canonical, on curve and in the prime subgroup
 *    (torsion points such as (0, p−1) are rejected, never "repaired");
 * 5. the share is canonical and s_i·G equals the on-chain PK_i.
 *
 * Throws on any violation; no scalar multiplication with the share happens
 * before all checks pass.
 */
export function buildPartialDecryption(
  snapshot: PartialRequestSnapshot,
  share: bigint,
  pins: { chainId: bigint; manager: Hex },
): BuiltPartial {
  if (snapshot.chainId !== pins.chainId) {
    throw new Error(`partial: snapshot chain ${snapshot.chainId} does not match the pinned chain ${pins.chainId}`);
  }
  if (snapshot.manager.toLowerCase() !== pins.manager.toLowerCase()) {
    throw new Error('partial: snapshot manager does not match the pinned manager');
  }
  if (snapshot.phase !== Phase.Live) {
    throw new Error(`partial: ceremony is not Live (phase ${snapshot.phase})`);
  }
  if (snapshot.fieldCount < 1 || snapshot.fieldCount > MAX_FIELDS) {
    throw new Error('partial: request does not exist (fieldCount must be 1..16)');
  }
  if (snapshot.cts.length !== snapshot.fieldCount) {
    throw new Error('partial: snapshot ciphertext count does not match fieldCount');
  }
  if (
    !Number.isInteger(snapshot.participantIndex) ||
    snapshot.participantIndex < 1 ||
    snapshot.participantIndex > snapshot.n
  ) {
    throw new Error('partial: participantIndex is outside the roster (1..n)');
  }
  validateCiphertextFields(snapshot.cts.slice());
  checkRecoveredShare(share, snapshot.memberKey);
  return computePartialUnchecked(
    share,
    snapshot.cts.map((ct) => ct.c1),
  );
}

/**
 * Unchecked arithmetic: D_k = s_i·C1_k with the §10.1 padding. Not exported
 * from the package — use `buildPartialDecryption`, which performs the §9.3
 * checks against an authenticated snapshot first.
 */
export function computePartialUnchecked(share: bigint, c1Fields: Point[]): BuiltPartial {
  const fieldCount = c1Fields.length;
  if (fieldCount < 1 || fieldCount > MAX_FIELDS) throw new Error('fieldCount must be 1..16');
  assertCanonicalScalar(share, 's_i');
  const PK = mulPoint(G, share);
  const C1: Point[] = [];
  const D: Point[] = [];
  for (let k = 0; k < MAX_FIELDS; k++) {
    if (k < fieldCount) {
      const c1 = c1Fields[k] as Point;
      C1.push(c1);
      D.push(mulPoint(c1, share));
    } else {
      C1.push(G);
      D.push(IDENTITY);
    }
  }
  const witnessInput: PartialWitnessInput = {
    PK: [toDecimal(PK.x), toDecimal(PK.y)],
    activeCount: toDecimal(fieldCount),
    C1: C1.map((p) => [toDecimal(p.x), toDecimal(p.y)]),
    D: D.map((p) => [toDecimal(p.x), toDecimal(p.y)]),
    s: toDecimal(share),
  };
  return {
    D,
    C1,
    witnessInput,
    publicSignals: partialPublicSignals({ PK, activeCount: fieldCount, C1, D }),
  };
}

/**
 * The 67-word public input vector of the partial circuit, in the §10.1 order:
 * [PK.x, PK.y, activeCount, C1[0..15].{x,y}, D[0..15].{x,y}].
 */
export function partialPublicSignals(args: {
  PK: Point;
  activeCount: number;
  /** Padded to 16 (G above activeCount). */
  C1: Point[];
  /** Padded to 16 (identity above activeCount). */
  D: Point[];
}): bigint[] {
  if (args.C1.length !== MAX_FIELDS || args.D.length !== MAX_FIELDS) {
    throw new Error('partialPublicSignals: arrays must be padded to capacity');
  }
  if (args.activeCount < 1 || args.activeCount > MAX_FIELDS) {
    throw new Error('partialPublicSignals: activeCount must be 1..16');
  }
  const out: bigint[] = [args.PK.x, args.PK.y, BigInt(args.activeCount)];
  for (const c of args.C1) out.push(c.x, c.y);
  for (const d of args.D) out.push(d.x, d.y);
  if (out.length !== 67) throw new Error('partialPublicSignals: expected 67 words');
  return out;
}
