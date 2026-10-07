/**
 * Cross-implementation vector tests for the protocol flows: dealing (§8),
 * recovery (§8.6), partial decryption (§10.1) and combine (§10.3).
 */

import { describe, expect, it } from 'vitest';
import { compressPoint, decompressPoint } from '../src/codec.js';
import { buildDealing, shareMask } from '../src/dealing.js';
import { dealPayloadHash, partialPayloadHash } from '../src/eip712.js';
import { recoverShare } from '../src/recovery.js';
import { computePartialUnchecked, partialDataHash, validateCiphertextFields } from '../src/partial.js';
import {
  combinedPoint,
  elgamalEncrypt,
  lagrangeCoefficients,
  verifyCombine,
} from '../src/combine.js';
import { BsgsTable, solveDlog } from '../src/bsgs.js';
import { addPoints, G, IDENTITY, mulBase, mulPoint, pointEq } from '../src/curve.js';
import { toDecimal } from '../src/encoding.js';
import { loadVectors, skipMsg, vp } from './helpers.js';
import type { CiphertextField, Groth16Proof, Hex, Point } from '../src/types.js';

interface PlaceholderProof {
  pA: string[];
  pB: string[][];
  pC: string[];
}

const toProof = (p: PlaceholderProof): Groth16Proof => ({
  pA: [BigInt(p.pA[0] as string), BigInt(p.pA[1] as string)],
  pB: [
    [BigInt((p.pB[0] as string[])[0] as string), BigInt((p.pB[0] as string[])[1] as string)],
    [BigInt((p.pB[1] as string[])[0] as string), BigInt((p.pB[1] as string[])[1] as string)],
  ],
  pC: [BigInt(p.pC[0] as string), BigInt(p.pC[1] as string)],
});

interface DealingVec {
  dealerIndex: number;
  a: string[];
  e: string;
  C: string[][];
  E: string[];
  shares: string[];
  S: string[][];
  masks: string[];
  masked: string[];
  payloadHash: Hex;
  witnessInput: Record<string, unknown>;
  publicInputs: string[];
}

interface DealingVectors {
  placeholderProof: PlaceholderProof;
  scenarios: {
    name: string;
    chainId: string;
    manager: Hex;
    ceremonyId: Hex;
    t: number;
    n: number;
    ctx: Hex;
    roster: string[][];
    qual: number[];
    dealings: DealingVec[];
  }[];
}

const dealingVectors = loadVectors<DealingVectors>('dealing');

describe.skipIf(!dealingVectors)(dealingVectors ? 'vectors: dealing' : skipMsg('dealing'), () => {
  const v = dealingVectors as DealingVectors;

  for (const sc of dealingVectors?.scenarios ?? []) {
    it(`scenario ${sc.name}: every dealing reproduces bit-for-bit`, () => {
      // The vector roster is padded to 16 slots with G; buildDealing takes the n real keys.
      const memberKeys = sc.roster.slice(0, sc.n).map(vp);
      for (const d of sc.dealings) {
        const built = buildDealing({
          ctx: sc.ctx,
          dealerIndex: d.dealerIndex,
          t: sc.t,
          n: sc.n,
          memberKeys,
          coefficients: d.a.slice(0, sc.t).map(BigInt),
          ephemeral: BigInt(d.e),
        });
        expect(built.C.map((p) => [toDecimal(p.x), toDecimal(p.y)])).toEqual(d.C);
        expect([toDecimal(built.E.x), toDecimal(built.E.y)]).toEqual(d.E);
        // The vector pads shares to 16 slots with zeros; built.shares holds the n real shares.
        expect(built.shares.map(toDecimal)).toEqual(d.shares.slice(0, sc.n));
        expect(d.shares.slice(sc.n).every((s) => s === '0')).toBe(true);
        expect(built.ecdh.map((p) => [toDecimal(p.x), toDecimal(p.y)])).toEqual(d.S);
        built.ecdh.forEach((S, i) => {
          expect(toDecimal(shareMask(sc.ctx, d.dealerIndex, i + 1, S))).toBe(d.masks[i]);
        });
        expect(built.masked.map(toDecimal)).toEqual(d.masked);
        expect(built.witnessInput).toEqual(d.witnessInput);
        expect(built.publicSignals.map(toDecimal)).toEqual(d.publicInputs);
        const payloadHash = dealPayloadHash(sc.ctx, {
          C: built.C,
          E: built.E,
          masked: built.masked,
          proof: toProof(v.placeholderProof),
        });
        expect(payloadHash).toBe(d.payloadHash);
      }
    });
  }
});

interface RecoveryVectors {
  scenarios: {
    name: string;
    chainId: string;
    manager: Hex;
    ceremonyId: Hex;
    ctx: Hex;
    t: number;
    n: number;
    qual: number[];
    qualBitmap: number;
    aggregates: string[][];
    /** The contract's biased storage encoding: every coordinate stored +1 (§8.3). */
    aggregatesBiased: string[][];
    publicKey: string[];
    dealers: { dealerIndex: number; E: string[]; compressedE: Hex }[];
    members: {
      index: number;
      compressedX: Hex;
      shareSecret: string;
      perDealer: { dealerIndex: number; S: string[]; mask: string; masked: string; share: string }[];
      share: string;
      PK: string[];
    }[];
  }[];
}

const recoveryVectors = loadVectors<RecoveryVectors>('recovery');

const dealingCommitments = (name: string): Map<number, Point[]> => {
  const out = new Map<number, Point[]>();
  const sc = (dealingVectors as DealingVectors).scenarios.find((s) => s.name === name);
  if (!sc) throw new Error(`dealing scenario ${name} missing`);
  for (const d of sc.dealings) out.set(d.dealerIndex, d.C.map(vp));
  return out;
};

describe.skipIf(!recoveryVectors || !dealingVectors)(
  recoveryVectors ? 'vectors: recovery' : skipMsg('recovery'),
  () => {
    for (const sc of recoveryVectors?.scenarios ?? []) {
      // Padded aggregates as the contract serves them (identity above t−1).
      const agg16 = (rows: string[][]): Point[] =>
        Array.from({ length: 16 }, (_, k) => (rows[k] ? vp(rows[k] as string[]) : IDENTITY));

      it(`scenario ${sc.name}: QUAL, dealer encodings, aggregates and bias`, () => {
        expect(sc.qual.reduce((acc, j) => acc | (1 << (j - 1)), 0)).toBe(sc.qualBitmap);
        expect(sc.dealers.map((d) => d.dealerIndex)).toEqual(sc.qual);
        for (const d of sc.dealers) {
          const E = vp(d.E);
          expect(compressPoint(E)).toBe(BigInt(d.compressedE));
          expect(decompressPoint(BigInt(d.compressedE))).toEqual(E);
        }
        // Aggregates A_k = sum over QUAL of C_{j,k} (from dealing.json); PK = A_0.
        const C = dealingCommitments(sc.name);
        for (let k = 0; k < sc.t; k++) {
          let acc = IDENTITY;
          for (const j of sc.qual) acc = addPoints(acc, (C.get(j) as Point[])[k] as Point);
          expect(acc).toEqual(vp(sc.aggregates[k] as string[]));
        }
        expect(vp(sc.publicKey)).toEqual(vp(sc.aggregates[0] as string[]));
        // The biased storage rows are exactly (x+1, y+1) of the true aggregates.
        expect(sc.aggregatesBiased.length).toBe(sc.aggregates.length);
        sc.aggregatesBiased.forEach((row, k) => {
          const a = vp(sc.aggregates[k] as string[]);
          expect(vp(row)).toEqual({ x: a.x + 1n, y: a.y + 1n });
        });
      });

      it(`scenario ${sc.name}: share recovery from the self-contained slice data`, () => {
        for (const m of sc.members) {
          // The member's roster key X_m = x_m·G, stored compressed.
          expect(compressPoint(mulBase(BigInt(m.shareSecret)))).toBe(BigInt(m.compressedX));
          const recDealings = new Map(
            sc.dealers.map((d) => {
              const pd = m.perDealer.find((p) => p.dealerIndex === d.dealerIndex);
              if (!pd) throw new Error(`perDealer ${d.dealerIndex} missing for member ${m.index}`);
              return [d.dealerIndex, { compressedE: BigInt(d.compressedE), masked: BigInt(pd.masked) }];
            }),
          );
          const recovered = recoverShare({
            ctx: sc.ctx,
            memberIndex: m.index,
            shareSecret: BigInt(m.shareSecret),
            qual: sc.qual,
            dealings: recDealings,
            aggregates: agg16(sc.aggregates),
            expectedMemberKey: vp(m.PK),
          });
          expect(toDecimal(recovered.share)).toBe(m.share);
          expect(pointEq(mulBase(recovered.share), vp(m.PK))).toBe(true);
          for (const pd of m.perDealer) {
            expect(toDecimal(recovered.perDealer.get(pd.dealerIndex) as bigint)).toBe(pd.share);
            // Cross-check the vector's intermediate values too.
            const E = vp((sc.dealers.find((d) => d.dealerIndex === pd.dealerIndex) as { E: string[] }).E);
            const S = mulPoint(E, BigInt(m.shareSecret));
            expect([toDecimal(S.x), toDecimal(S.y)]).toEqual(pd.S);
            expect(toDecimal(shareMask(sc.ctx, pd.dealerIndex, m.index, S))).toBe(pd.mask);
          }
        }
      });

      it(`scenario ${sc.name}: recovery halts on the biased aggregate encoding`, () => {
        const m = sc.members[0] as RecoveryVectors['scenarios'][number]['members'][number];
        const recDealings = new Map(
          sc.dealers.map((d) => {
            const pd = m.perDealer.find((p) => p.dealerIndex === d.dealerIndex);
            return [d.dealerIndex, { compressedE: BigInt(d.compressedE), masked: BigInt((pd as { masked: string }).masked) }];
          }),
        );
        expect(() =>
          recoverShare({
            ctx: sc.ctx,
            memberIndex: m.index,
            shareSecret: BigInt(m.shareSecret),
            qual: sc.qual,
            dealings: recDealings,
            aggregates: agg16(sc.aggregatesBiased),
            expectedMemberKey: vp(m.PK),
          }),
        ).toThrow(/halt/);
      });
    }
  },
);

interface CombineVectors {
  placeholderProof: PlaceholderProof;
  scenarios: {
    name: string;
    chainId: string;
    manager: Hex;
    ceremonyId: Hex;
    t: number;
    n: number;
    request: {
      requestId: Hex;
      fieldCount: number;
      plaintexts: string[];
      randomness: string[];
      cts: string[][];
      /** Per field: [compressed(C1_k), compressed(C2_k)] as the contract stores them. */
      compressedCts: Hex[][];
    };
    publicKey: string[];
    partials: {
      index: number;
      D: string[][];
      payloadHash: Hex;
      partialDataHash: Hex;
      witnessInput: Record<string, unknown>;
      publicInputs: string[];
    }[];
    combines: {
      memberSet: number[];
      lambdas: string[];
      fields: { field: number; sumLambdaD: string[]; M: string[]; plaintext: string; plaintextG: string[] }[];
    }[];
  }[];
}

const combineVectors = loadVectors<CombineVectors>('combine');

// One small shared table for in-suite dlog checks (full 2^40 runs in the bench).
const smallTable = combineVectors ? BsgsTable.build(1 << 16) : undefined;
const SMALL_SOLVE_LIMIT = 1n << 24n;

describe.skipIf(!combineVectors || !recoveryVectors)(
  combineVectors ? 'vectors: partials and combine' : skipMsg('combine'),
  () => {
    const v = combineVectors as CombineVectors;

    for (const sc of combineVectors?.scenarios ?? []) {
      const recSc = () => {
        const r = (recoveryVectors as RecoveryVectors).scenarios.find((s) => s.name === sc.name);
        if (!r) throw new Error(`recovery scenario ${sc.name} missing`);
        return r;
      };

      const ctFields = (): CiphertextField[] =>
        sc.request.cts.map((row) => ({
          c1: { x: BigInt(row[0] as string), y: BigInt(row[1] as string) },
          c2: { x: BigInt(row[2] as string), y: BigInt(row[3] as string) },
        }));

      it(`scenario ${sc.name}: ciphertexts and ElGamal consistency`, () => {
        const cts = ctFields();
        expect(cts).toHaveLength(sc.request.fieldCount);
        validateCiphertextFields(cts);
        const pk = vp(sc.publicKey);
        cts.forEach((ct, k) => {
          const enc = elgamalEncrypt(pk, BigInt(sc.request.plaintexts[k] as string), BigInt(sc.request.randomness[k] as string));
          expect(enc.c1).toEqual(ct.c1);
          expect(enc.c2).toEqual(ct.c2);
        });
      });

      it(`scenario ${sc.name}: stored compressed ciphertext words round-trip (§2.5)`, () => {
        const cts = ctFields();
        expect(sc.request.compressedCts).toHaveLength(sc.request.fieldCount);
        sc.request.compressedCts.forEach((row, k) => {
          const ct = cts[k] as CiphertextField;
          expect(compressPoint(ct.c1)).toBe(BigInt((row as Hex[])[0] as Hex));
          expect(compressPoint(ct.c2)).toBe(BigInt((row as Hex[])[1] as Hex));
          expect(decompressPoint(BigInt((row as Hex[])[0] as Hex))).toEqual(ct.c1);
          expect(decompressPoint(BigInt((row as Hex[])[1] as Hex))).toEqual(ct.c2);
        });
      });

      it(`scenario ${sc.name}: partialDataHash commitments reproduce (§10.2)`, () => {
        for (const p of sc.partials) {
          expect(
            partialDataHash({
              chainId: BigInt(sc.chainId),
              manager: sc.manager,
              ceremonyId: sc.ceremonyId,
              requestId: sc.request.requestId,
              participantIndex: p.index,
              fieldCount: sc.request.fieldCount,
              D: p.D.map(vp),
            }),
          ).toBe(p.partialDataHash);
        }
      });

      it(`scenario ${sc.name}: partial decryptions reproduce bit-for-bit`, () => {
        const cts = ctFields();
        const members = recSc().members;
        for (const p of sc.partials) {
          const share = BigInt((members.find((m) => m.index === p.index) as (typeof members)[number]).share);
          const built = computePartialUnchecked(share, cts.map((ct) => ct.c1));
          expect(built.D.map((d) => [toDecimal(d.x), toDecimal(d.y)])).toEqual(p.D);
          expect(built.witnessInput).toEqual(p.witnessInput);
          expect(built.publicSignals.map(toDecimal)).toEqual(p.publicInputs);
          expect(
            partialPayloadHash(sc.request.requestId, { D: built.D, proof: toProof(v.placeholderProof) }),
          ).toBe(p.payloadHash);
        }
      });

      it(`scenario ${sc.name}: Lagrange, combine and plaintexts`, () => {
        const cts = ctFields();
        for (const cb of sc.combines) {
          const lambda = lagrangeCoefficients(cb.memberSet);
          expect(cb.memberSet.map((i) => toDecimal(lambda.get(i) as bigint))).toEqual(cb.lambdas);
          for (const f of cb.fields) {
            const partialsForField = new Map<number, Point>();
            for (const i of cb.memberSet) {
              const p = sc.partials.find((x) => x.index === i);
              if (!p) throw new Error(`partial for member ${i} missing`);
              partialsForField.set(i, vp(p.D[f.field] as string[]));
            }
            // sumLambdaD = sum of lambda_i * D_i.
            let sum = IDENTITY;
            for (const i of cb.memberSet) {
              sum = addPoints(sum, mulPoint(partialsForField.get(i) as Point, lambda.get(i) as bigint));
            }
            expect(sum).toEqual(vp(f.sumLambdaD));

            const c2 = (cts[f.field] as CiphertextField).c2;
            const M = combinedPoint(c2, cb.memberSet, partialsForField, lambda);
            expect(M).toEqual(vp(f.M));
            const plaintext = BigInt(f.plaintext);
            expect(mulBase(plaintext)).toEqual(vp(f.plaintextG));
            expect(pointEq(M, vp(f.plaintextG))).toBe(true);
            expect(verifyCombine(plaintext, c2, cb.memberSet, partialsForField)).toBe(true);
            expect(verifyCombine(plaintext + 1n, c2, cb.memberSet, partialsForField)).toBe(false);
            if (plaintext < SMALL_SOLVE_LIMIT) {
              expect(solveDlog(M, { bound: SMALL_SOLVE_LIMIT, table: smallTable })).toBe(plaintext);
            }
          }
        }
      });
    }

    it('equal G-padding convention between C1 inputs and the contract', () => {
      // C1 padding is G, D padding identity (§10.1): computePartialUnchecked already
      // asserted vector equality above; pin the convention explicitly.
      const built = computePartialUnchecked(1n, [G]);
      expect(built.C1.slice(1).every((p) => pointEq(p, G))).toBe(true);
      expect(built.D.slice(1).every((p) => pointEq(p, IDENTITY))).toBe(true);
    });
  },
);
