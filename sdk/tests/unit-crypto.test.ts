/** Unit tests for the curve, polynomial, Lagrange, BSGS, PoP and a full local ceremony. */

import { describe, expect, it } from 'vitest';
import { Base8, addPoint, mulPointEscalar } from '@zk-kit/baby-jubjub';
import { P, R, FORM_K } from '../src/constants.js';
import {
  addPoints,
  batchToAffine,
  G,
  IDENTITY,
  hornerEval,
  isInPrimeSubgroup,
  isOnCurve,
  mulBase,
  mulPoint,
  pointEq,
  reducedToTe,
  subPoints,
  teToReduced,
  toExtended,
} from '../src/curve.js';
import { evalPoly, buildDealing, provePossession, verifyPossession, type PopContext } from '../src/dealing.js';
import { compressPoint } from '../src/codec.js';
import { recoverShare, type RecoveryDealing } from '../src/recovery.js';
import { computePartialUnchecked, validateCiphertextFields } from '../src/partial.js';
import {
  buildCombineArgs,
  combinedPoint,
  elgamalEncrypt,
  fieldsPerCombineTx,
  lagrangeCoefficients,
  solvePlaintext,
  verifyCombine,
} from '../src/combine.js';
import { BsgsTable, solveDlog } from '../src/bsgs.js';
import {
  dealerCoefficients,
  dealerEphemeral,
  generateMnemonic,
  participantAuthKey,
  rootFromMnemonic,
  shareEncryptionKey,
} from '../src/keys.js';
import { ceremonyId, circuitReleaseId, dealContext, rosterHash } from '../src/encoding.js';
import type { Dealing, Hex, Point } from '../src/types.js';

const rand = (mod: bigint): bigint => {
  const b = new Uint8Array(32);
  globalThis.crypto.getRandomValues(b);
  let v = 0n;
  for (const x of b) v = (v << 8n) | BigInt(x);
  return v % mod;
};

describe('curve arithmetic vs @zk-kit/baby-jubjub', () => {
  it('generator matches Base8', () => {
    expect([G.x, G.y]).toEqual([Base8[0], Base8[1]]);
  });

  it('add and scalar mul agree on random inputs', () => {
    for (let i = 0; i < 10; i++) {
      const a = rand(R);
      const b = rand(R);
      const PA = mulBase(a);
      const PB = mulBase(b);
      const refA = mulPointEscalar(Base8, a);
      expect([PA.x, PA.y]).toEqual([refA[0], refA[1]]);
      const sum = addPoints(PA, PB);
      const refSum = addPoint([PA.x, PA.y], [PB.x, PB.y]);
      expect([sum.x, sum.y]).toEqual([refSum[0], refSum[1]]);
      expect(mulPoint(PA, b)).toEqual(mulPoint(PB, a));
    }
  });

  it('identity and order', () => {
    expect(mulBase(0n)).toEqual(IDENTITY);
    expect(mulBase(R)).toEqual(IDENTITY);
    expect(addPoints(mulBase(5n), mulBase(R - 5n))).toEqual(IDENTITY);
    expect(subPoints(mulBase(7n), mulBase(7n))).toEqual(IDENTITY);
  });

  it('the small-torsion point (0, p-1) is on curve but not in the prime subgroup', () => {
    const torsion: Point = { x: 0n, y: P - 1n };
    expect(isOnCurve(torsion)).toBe(true);
    expect(isInPrimeSubgroup(torsion)).toBe(false);
    expect(isInPrimeSubgroup(G)).toBe(true);
    expect(isInPrimeSubgroup(IDENTITY)).toBe(true);
  });

  it('te <-> reduced round trip and the K scaling', () => {
    for (let i = 0; i < 5; i++) {
      const p1 = mulBase(rand(R));
      const red = teToReduced(p1);
      expect(red.x).toBe((FORM_K * p1.x) % P);
      expect(reducedToTe(red)).toEqual(p1);
    }
  });

  it('batchToAffine matches per-point normalization', () => {
    const pts = [0n, 1n, 2n, 99n, R - 1n].map(mulBase);
    const affine = batchToAffine(pts.map(toExtended));
    expect(affine).toEqual(pts);
  });

  it('hornerEval matches direct polynomial commitment evaluation', () => {
    const coeffs = [rand(R), rand(R), rand(R)];
    const C = [...coeffs.map(mulBase), IDENTITY, IDENTITY];
    for (const m of [1, 2, 7, 16]) {
      expect(hornerEval(C, m)).toEqual(mulBase(evalPoly(coeffs, BigInt(m))));
    }
  });
});

describe('lagrange coefficients', () => {
  it('interpolates f(0) for random polynomials on random member sets', () => {
    const coeffs = [rand(R), rand(R), rand(R)];
    for (const set of [[1, 2, 3], [2, 5, 9], [1, 7, 16]]) {
      const lambda = lagrangeCoefficients(set);
      let acc = 0n;
      for (const i of set) acc = (acc + (lambda.get(i) as bigint) * evalPoly(coeffs, BigInt(i))) % R;
      expect(acc).toBe(coeffs[0]);
    }
  });

  it('rejects malformed sets', () => {
    expect(() => lagrangeCoefficients([])).toThrow();
    expect(() => lagrangeCoefficients([2, 1])).toThrow();
    expect(() => lagrangeCoefficients([1, 1])).toThrow();
    expect(() => lagrangeCoefficients([0, 1])).toThrow();
    expect(() => lagrangeCoefficients([1, 17])).toThrow();
  });
});

describe('bsgs', () => {
  const table = BsgsTable.build(1 << 10);

  it('solves small discrete logs and verifies the result', () => {
    for (const m of [0n, 1n, 1023n, 1024n, 65537n, (1n << 20n) - 1n]) {
      expect(solveDlog(mulBase(m), { bound: 1n << 20n, table })).toBe(m);
    }
  });

  it('throws when the exponent is out of bound', () => {
    expect(() => solveDlog(mulBase(1n << 21n), { bound: 1n << 20n, table })).toThrow(/no exponent/);
  });
});

describe('proof of possession', () => {
  const ctx: PopContext = {
    chainId: 31337n,
    manager: '0x5fbdb2315678afecb367f032d93f642f64180aa3',
    ceremonyId: '0xba92d83fa5be494b998b1667',
    participant: '0x08b90e5bbcec77ad3aac7e4289c70d6685a7e177',
  };

  it('round trips and rejects tampering', () => {
    const x = rand(R - 1n) + 1n;
    const X = mulBase(x);
    const proof = provePossession(ctx, x);
    expect(verifyPossession(ctx, X, proof)).toBe(true);
    expect(verifyPossession(ctx, mulBase(x + 1n), proof)).toBe(false);
    expect(verifyPossession(ctx, X, { ...proof, z: (proof.z + 1n) % R })).toBe(false);
    expect(verifyPossession(ctx, X, { ...proof, A: mulBase(123n) })).toBe(false);
    expect(verifyPossession({ ...ctx, participant: ctx.manager }, X, proof)).toBe(false);
    expect(verifyPossession(ctx, X, { ...proof, z: proof.z + R })).toBe(false);
  });
});

describe('full local ceremony (n=3, t=2)', () => {
  it('deal -> recover -> encrypt -> partial -> combine round trips', () => {
    const chainId = 31337n;
    const manager: Hex = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
    const t = 2;
    const n = 3;

    const roots = [0, 1, 2].map(() => rootFromMnemonic(generateMnemonic()));
    const cid = ceremonyId(chainId, manager, '0x08b90e5bbcec77ad3aac7e4289c70d6685a7e177', 1n);
    const keyCtx = { chainId, manager, ceremonyId: cid };
    const shareKeys = roots.map((root) => shareEncryptionKey(root, keyCtx));
    const roster = {
      t,
      n,
      authAddresses: roots.map((root) => participantAuthKey(root, keyCtx).address),
      memberKeys: shareKeys.map((k) => k.publicKey),
    };
    const rh = rosterHash(chainId, manager, cid, roster);
    const crid = circuitReleaseId(`0x${'11'.repeat(32)}`, `0x${'22'.repeat(32)}`);
    const ctx = dealContext(chainId, manager, cid, rh, crid);

    // Everyone deals (QUAL = all).
    const dealings = new Map<number, Dealing>();
    for (let j = 1; j <= n; j++) {
      const dctx = { chainId, manager, ceremonyId: cid, rosterHash: rh, dealerIndex: j, t, circuitReleaseId: crid };
      const root = roots[j - 1];
      if (!root) throw new Error('unreachable');
      const built = buildDealing({
        ctx,
        dealerIndex: j,
        t,
        n,
        memberKeys: roster.memberKeys,
        coefficients: dealerCoefficients(root, dctx),
        ephemeral: dealerEphemeral(root, dctx),
      });
      dealings.set(j, { C: built.C, E: built.E, masked: built.masked });
    }
    const qual = [1, 2, 3];

    // Aggregate commitments -> PK and per-member PK_m (padded to 16, as stored).
    const agg: Point[] = [];
    for (let k = 0; k < 16; k++) {
      let acc = IDENTITY;
      if (k < t) for (const j of qual) acc = addPoints(acc, (dealings.get(j) as Dealing).C[k] as Point);
      agg.push(acc);
    }
    const publicKey = agg[0] as Point;

    // v2 recovery inputs: per dealer compressed(E_j) + this member's masked share.
    const recDealingsFor = (m: number): Map<number, RecoveryDealing> =>
      new Map(
        qual.map((j) => {
          const d = dealings.get(j) as Dealing;
          return [j, { compressedE: compressPoint(d.E), masked: d.masked[m - 1] as bigint }];
        }),
      );

    const shares: bigint[] = [];
    for (let m = 1; m <= n; m++) {
      const key = shareKeys[m - 1];
      if (!key) throw new Error('unreachable');
      const { share } = recoverShare({
        ctx,
        memberIndex: m,
        shareSecret: key.secret,
        qual,
        dealings: recDealingsFor(m),
        aggregates: agg,
        expectedMemberKey: hornerEval(agg, m),
      });
      shares.push(share);
    }

    // Encrypt three fields, decrypt with members {1, 3}.
    const plaintexts = [0n, 1n, 777777n];
    const cts = plaintexts.map((m) => elgamalEncrypt(publicKey, m, rand(R - 1n) + 1n));
    validateCiphertextFields(cts);

    const memberSet = [1, 3];
    const partials = new Map(memberSet.map((i) => [i, computePartialUnchecked(shares[i - 1] as bigint, cts.map((c) => c.c1))]));
    const table = BsgsTable.build(1 << 12);
    cts.forEach((ct, k) => {
      const dForField = new Map(memberSet.map((i) => [i, (partials.get(i)?.D as Point[])[k] as Point]));
      const M = combinedPoint(ct.c2, memberSet, dForField);
      expect(M).toEqual(mulBase(plaintexts[k] as bigint));
      expect(solvePlaintext(ct.c2, memberSet, dForField, { bound: 1n << 20n, table })).toBe(plaintexts[k]);
      expect(verifyCombine(plaintexts[k] as bigint, ct.c2, memberSet, dForField)).toBe(true);
      expect(verifyCombine((plaintexts[k] as bigint) + 1n, ct.c2, memberSet, dForField)).toBe(false);
    });

    // A wrong share-encryption secret cannot recover (the aggregate check fires).
    expect(() =>
      recoverShare({
        ctx,
        memberIndex: 1,
        shareSecret: ((shareKeys[0] as { secret: bigint }).secret + 1n) % R,
        qual,
        dealings: recDealingsFor(1),
        aggregates: agg,
        expectedMemberKey: hornerEval(agg, 1),
      }),
    ).toThrow(/halt/);

    const vectors = new Map(memberSet.map((i) => [i, (partials.get(i) as { D: Point[] }).D]));
    const args = buildCombineArgs(
      `0x${'ab'.repeat(32)}`,
      memberSet,
      [
        { fieldIndex: 2, plaintext: plaintexts[2] as bigint, c2: (cts[2] as { c2: Point }).c2 },
        { fieldIndex: 0, plaintext: plaintexts[0] as bigint, c2: (cts[0] as { c2: Point }).c2 },
      ],
      vectors,
    );
    expect(args.fieldIndexes).toEqual([0, 2]);
    expect(args.C2).toEqual([(cts[0] as { c2: Point }).c2, (cts[2] as { c2: Point }).c2]);
    expect(args.partialVectors.map((v) => v.length)).toEqual([16, 16]);
    expect(args.partialVectors[0]).toEqual(vectors.get(1));
    expect(fieldsPerCombineTx(t)).toBe(4);
    expect(fieldsPerCombineTx(16)).toBe(2);
  });
});
