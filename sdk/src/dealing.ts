/**
 * Dealing construction (protocol §8.3, §8.5) and the join Schnorr proof of
 * possession (§8.2).
 *
 * Secret-handling module: pure computation, no I/O, no logging. The witness
 * JSON uses exactly the protocol-pinned signal keys with decimal-string values.
 */

import { poseidon7 } from 'poseidon-lite/poseidon7';
import { LIMIT_R, MASK_CONST, MAX_N, MAX_T, P, R, TAG_JOIN_POP } from './constants.js';
import {
  assertValidSubgroupPoint,
  G,
  IDENTITY,
  addPoints,
  hornerEval,
  isOnCurve,
  isCanonical,
  mulPoint,
  pointEq,
  pointNeg,
} from './curve.js';
import {
  assertCanonicalScalar,
  bytes32ToLimbs,
  hashToScalar,
  toDecimal,
} from './encoding.js';
import type { Hex, Point } from './types.js';

// --- share mask (protocol §8.3) ---

/** h_{j,m} = Poseidon7(MASK_CONST, ctxHi, ctxLo, j, m, S.x, S.y). */
export function shareMask(ctx: Hex, dealerIndex: number, memberIndex: number, S: Point): bigint {
  const { hi, lo } = bytes32ToLimbs(ctx);
  return poseidon7([MASK_CONST, hi, lo, BigInt(dealerIndex), BigInt(memberIndex), S.x, S.y]);
}

// --- dealing ---

export interface DealingInput {
  /** The dealing context bytes32 (protocol §4.3). */
  ctx: Hex;
  /** 1-based member index of the dealer. */
  dealerIndex: number;
  t: number;
  n: number;
  /** Frozen roster share-encryption keys X_1..X_n (TE), length n. */
  memberKeys: Point[];
  /** Coefficients a_0..a_{t-1} (zero allowed). */
  coefficients: bigint[];
  /** Ephemeral e != 0. */
  ephemeral: bigint;
}

/** The pinned witness-input JSON of `deal.circom` (protocol §8.5): decimal strings, nested as declared. */
export interface DealWitnessInput {
  ctxHi: string;
  ctxLo: string;
  dealerIndex: string;
  n: string;
  t: string;
  C: string[][];
  E: string[];
  X: string[][];
  masked: string[];
  a: string[];
  e: string;
  s: string[];
}

export interface BuiltDealing {
  /** C_0..C_15 in TE, identity padding for k >= t. */
  C: Point[];
  E: Point;
  /** Shares s_{j,m} for m = 1..n (length n, unpadded). */
  shares: bigint[];
  /** Masked shares, 16 slots, zero padding for i >= n. */
  masked: bigint[];
  /** ECDH points S_{j,m} for m = 1..n (length n). */
  ecdh: Point[];
  witnessInput: DealWitnessInput;
  /** The 87-word public input vector (protocol §8.5 table). */
  publicSignals: bigint[];
}

/** Evaluate f(z) = Σ a_k z^k mod r. */
export function evalPoly(coefficients: bigint[], z: bigint): bigint {
  let acc = 0n;
  for (let k = coefficients.length - 1; k >= 0; k--) {
    acc = (acc * z + (coefficients[k] as bigint)) % R;
  }
  return acc;
}

/** Pad the roster keys to 16 slots with G (the contract's padding, §8.5). */
export function padMemberKeys(memberKeys: Point[]): Point[] {
  const X: Point[] = memberKeys.slice();
  while (X.length < MAX_N) X.push(G);
  return X;
}

/**
 * Build a complete dealing: commitments, ephemeral, shares, masks, the pinned
 * witness JSON and the 87-word public input vector.
 */
export function buildDealing(input: DealingInput): BuiltDealing {
  const { t, n, dealerIndex } = input;
  if (!(t >= 1 && t <= MAX_T && n >= t && n <= MAX_N)) throw new Error('buildDealing: need 1 <= t <= n <= 16');
  if (!(dealerIndex >= 1 && dealerIndex <= n)) throw new Error('buildDealing: dealerIndex out of range');
  if (input.coefficients.length !== t) throw new Error('buildDealing: need exactly t coefficients');
  if (input.memberKeys.length !== n) throw new Error('buildDealing: need exactly n member keys');
  input.coefficients.forEach((a, k) => assertCanonicalScalar(a, `a_${k}`));
  assertCanonicalScalar(input.ephemeral, 'e');
  if (input.ephemeral === 0n) throw new Error('buildDealing: ephemeral must be nonzero');
  input.memberKeys.forEach((X, i) => assertValidSubgroupPoint(X, `X_${i + 1}`));

  const a: bigint[] = input.coefficients.slice();
  while (a.length < MAX_T) a.push(0n);

  const C: Point[] = a.map((ak, k) => (k < t ? mulPoint(G, ak) : IDENTITY));
  const E = mulPoint(G, input.ephemeral);

  const shares: bigint[] = [];
  const ecdh: Point[] = [];
  const masked: bigint[] = [];
  const s: bigint[] = [];
  for (let i = 0; i < MAX_N; i++) {
    const m = i + 1;
    if (i < n) {
      const share = evalPoly(input.coefficients, BigInt(m));
      const S = mulPoint(input.memberKeys[i] as Point, input.ephemeral);
      const h = shareMask(input.ctx, dealerIndex, m, S);
      shares.push(share);
      ecdh.push(S);
      s.push(share);
      masked.push((share + h) % P);
    } else {
      s.push(0n);
      masked.push(0n);
    }
  }

  const X = padMemberKeys(input.memberKeys);
  const { hi, lo } = bytes32ToLimbs(input.ctx);

  const witnessInput: DealWitnessInput = {
    ctxHi: toDecimal(hi),
    ctxLo: toDecimal(lo),
    dealerIndex: toDecimal(dealerIndex),
    n: toDecimal(n),
    t: toDecimal(t),
    C: C.map((p) => [toDecimal(p.x), toDecimal(p.y)]),
    E: [toDecimal(E.x), toDecimal(E.y)],
    X: X.map((p) => [toDecimal(p.x), toDecimal(p.y)]),
    masked: masked.map(toDecimal),
    a: a.map(toDecimal),
    e: toDecimal(input.ephemeral),
    s: s.map(toDecimal),
  };

  return {
    C,
    E,
    shares,
    masked,
    ecdh,
    witnessInput,
    publicSignals: dealPublicSignals({ ctx: input.ctx, dealerIndex, n, t, C, E, X, masked }),
  };
}

/**
 * The 87-word public input vector of the dealing circuit, in the §8.5 order:
 * [ctxHi, ctxLo, dealerIndex, n, t, C[0..15].{x,y}, E.{x,y}, X[0..15].{x,y}, masked[0..15]].
 */
export function dealPublicSignals(args: {
  ctx: Hex;
  dealerIndex: number;
  n: number;
  t: number;
  C: Point[];
  E: Point;
  /** Padded to 16 slots (G above n). */
  X: Point[];
  masked: bigint[];
}): bigint[] {
  if (args.C.length !== MAX_T || args.X.length !== MAX_N || args.masked.length !== MAX_N) {
    throw new Error('dealPublicSignals: arrays must be padded to capacity');
  }
  const { hi, lo } = bytes32ToLimbs(args.ctx);
  const out: bigint[] = [hi, lo, BigInt(args.dealerIndex), BigInt(args.n), BigInt(args.t)];
  for (const c of args.C) out.push(c.x, c.y);
  out.push(args.E.x, args.E.y);
  for (const x of args.X) out.push(x.x, x.y);
  for (const m of args.masked) out.push(m);
  if (out.length !== 87) throw new Error('dealPublicSignals: expected 87 words');
  return out;
}

// --- Schnorr proof of possession (protocol §8.2 item 4) ---

export interface PopContext {
  chainId: bigint;
  manager: Hex;
  ceremonyId: Hex;
  /** The participant's authorization address. */
  participant: Hex;
}

export interface PopProof {
  A: Point;
  z: bigint;
}

/** The PoP challenge c = HashToScalar("davinci-dkg-council/v1/join-pop", ...) (TE coordinates). */
export function popChallenge(ctx: PopContext, publicKey: Point, A: Point): bigint {
  return hashToScalar(
    TAG_JOIN_POP,
    'uint256, address, bytes12, address, uint256, uint256, uint256, uint256',
    [ctx.chainId, ctx.manager, ctx.ceremonyId, ctx.participant, publicKey.x, publicKey.y, A.x, A.y],
  );
}

/** Default CSPRNG; overridable for deterministic tests only. */
const defaultRandomBytes = (nBytes: number): Uint8Array => {
  const out = new Uint8Array(nBytes);
  globalThis.crypto.getRandomValues(out);
  return out;
};

/**
 * Sample a nonzero scalar per the §8.2 prover rule: 32 random bytes big-endian,
 * reject u >= LIMIT_R, k = u mod r, reject k = 0, retry.
 */
export function sampleNonce(randomBytes: (n: number) => Uint8Array = defaultRandomBytes): bigint {
  for (;;) {
    const bytes = randomBytes(32);
    let u = 0n;
    for (const b of bytes) u = (u << 8n) | BigInt(b);
    if (u >= LIMIT_R) continue;
    const k = u % R;
    if (k === 0n) continue;
    return k;
  }
}

/**
 * Prove possession of x_i: A = k·G, z = k + c·x_i mod r. The nonce is fresh
 * CSPRNG output, never derived from the recovery root.
 */
export function provePossession(
  ctx: PopContext,
  shareSecret: bigint,
  randomBytes?: (n: number) => Uint8Array,
): PopProof {
  assertCanonicalScalar(shareSecret, 'x_i');
  if (shareSecret === 0n) throw new Error('provePossession: zero secret');
  const publicKey = mulPoint(G, shareSecret);
  const k = sampleNonce(randomBytes);
  const A = mulPoint(G, k);
  const c = popChallenge(ctx, publicKey, A);
  const z = (k + c * shareSecret) % R;
  return { A, z };
}

/** Verify a PoP: z < r, A canonical and on curve, z·G - c·X == A (§8.2). */
export function verifyPossession(ctx: PopContext, publicKey: Point, proof: PopProof): boolean {
  if (proof.z < 0n || proof.z >= R) return false;
  if (!isCanonical(proof.A) || !isOnCurve(proof.A)) return false;
  const c = popChallenge(ctx, publicKey, proof.A);
  const lhs = addPoints(mulPoint(G, proof.z), pointNeg(mulPoint(publicKey, c)));
  return pointEq(lhs, proof.A);
}

/** The Feldman consistency check used by recovery and tests: s·G == Horner(C, m). */
export function checkShareAgainstCommitments(share: bigint, C: Point[], memberIndex: number): boolean {
  return pointEq(mulPoint(G, share), hornerEval(C, memberIndex));
}
