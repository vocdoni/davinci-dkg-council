// Dealing circuit (protocol §8.5): positive vectors and completeness battery (witness satisfies the
// optimized R1CS, proof verifies), single-defect mutations that must fail at the expected
// constraint, hint tampering at the R1CS level, and public-signal mutations of a real proof.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { Hex } from "viem";
import * as P from "../src/protocol.ts";
import * as S from "../src/scenario.ts";
import { Circuit, shutdown } from "../src/harness.ts";
import { clone, decPt, EXCEPTIONAL, expectFailure, interpolate } from "./util.ts";

const vectors = JSON.parse(readFileSync(new URL("../../tests/vectors/dealing.json", import.meta.url), "utf8"));
const deal = new Circuit("deal");
after(shutdown);

let scB: S.Scenario;
before(() => {
  scB = S.buildScenario(S.SPECS[1]);
});

/**
 * Builds a deal witness input from raw parameters with no validity checks, so a test can violate
 * exactly one relation. Defaults are the honest, consistent values.
 */
type Raw = {
  ctx: Hex;
  ctxHi?: bigint;
  ctxLo?: bigint;
  dealerIndex: number;
  n: number;
  t: number;
  a: bigint[]; // 16 entries, integers (not reduced)
  e: bigint;
  s?: bigint[]; // 16 entries; default f(i+1) for i < n, 0 otherwise
  X: P.Point[]; // 16 entries
  C?: P.Point[];
  E?: P.Point;
  masked?: bigint[];
};

function build(raw: Raw) {
  const limbs = P.limbs(raw.ctx);
  const hi = raw.ctxHi ?? limbs.hi;
  const lo = raw.ctxLo ?? limbs.lo;
  const s = raw.s ?? raw.a.map((_, i) => (i < raw.n ? P.evalPoly(raw.a, BigInt(i + 1)) : 0n));
  const C = raw.C ?? raw.a.map((ak) => P.mulG(ak));
  const E = raw.E ?? P.mulG(raw.e);
  const masked =
    raw.masked ??
    s.map((si, i) => {
      if (i >= raw.n) return 0n;
      const S_ = P.mul(raw.X[i], raw.e);
      const h = P.poseidon7Hash([P.MASK_CONST, hi, lo, BigInt(raw.dealerIndex), BigInt(i + 1), S_[0], S_[1]]);
      return (si + h) % P.P;
    });
  return {
    ctxHi: P.dec(hi),
    ctxLo: P.dec(lo),
    dealerIndex: P.dec(raw.dealerIndex),
    n: P.dec(raw.n),
    t: P.dec(raw.t),
    C: C.map(decPt),
    E: decPt(E),
    X: raw.X.map(decPt),
    masked: masked.map(P.dec),
    a: raw.a.map(P.dec),
    e: P.dec(raw.e),
    s: s.map(P.dec),
  };
}

/** Honest raw parameters for a dealing over the first n scenario-B members. */
function honest(n: number, t: number, coeffs: bigint[], e: bigint, dealerIndex = 1): Raw {
  return {
    ctx: scB.ctx,
    dealerIndex,
    n,
    t,
    a: [...coeffs, ...Array(16 - coeffs.length).fill(0n)],
    e,
    X: P.paddedRoster(scB.members.slice(0, n).map((m) => m.X)),
  };
}

async function proveAndVerify(input: ReturnType<typeof build> | P.DealWitnessInput) {
  const w = await deal.witness(input);
  assert.equal(await deal.firstViolation(w), -1, "witness violates the optimized R1CS");
  const { proof, publicSignals } = await deal.prove(input);
  assert.deepEqual(publicSignals, P.dealPublicInputs(input as P.DealWitnessInput));
  assert.ok(await deal.verify(publicSignals, proof), "proof does not verify");
  return { proof, publicSignals };
}

describe("deal: vectors", () => {
  test("every vector dealing satisfies the optimized R1CS with the table-order public inputs", async () => {
    for (const sc of vectors.scenarios) {
      for (const dl of sc.dealings) {
        const w = await deal.witness(dl.witnessInput);
        assert.equal(await deal.firstViolation(w), -1);
        assert.deepEqual(w.slice(1, 88).map(String), dl.publicInputs);
      }
    }
  });

  test("one proof per scenario verifies; each of the 87 public signals perturbed is rejected", async () => {
    for (const sc of vectors.scenarios) {
      const dl = sc.dealings[0];
      const { proof, publicSignals } = await proveAndVerify(dl.witnessInput);
      if (sc.name !== "A") continue;
      for (let i = 0; i < 87; i++) {
        const bad = [...publicSignals];
        bad[i] = P.dec((BigInt(bad[i]) + 1n) % P.P);
        assert.equal(await deal.verify(bad, proof), false, `public signal ${i} perturbed but accepted`);
      }
    }
  });
});

describe("deal: completeness battery", () => {
  const r1 = P.R - 1n;
  const cases: [string, () => Raw][] = [
    ["all-zero polynomial: identity commitments, zero shares", () => honest(3, 2, [0n, 0n], 777n)],
    ["zero constant term (C_0 = O)", () => honest(3, 2, [0n, 5n], 778n)],
    ["zero shares for members 1 and 2", () => honest(5, 3, interpolate([0n, 0n, 7n]), 779n)],
    ["r - 1 coefficients and ephemeral", () => honest(3, 2, [r1, r1], r1)],
    ["every share r - 1 (zero top coefficient)", () => honest(4, 2, interpolate([r1, r1]), 780n)],
    ["exceptional scalars as coefficients and ephemeral", () => honest(3, 3, EXCEPTIONAL, EXCEPTIONAL[0])],
    ["exceptional scalars as shares", () => honest(3, 3, interpolate(EXCEPTIONAL), EXCEPTIONAL[2], 3)],
    ["exceptional ephemeral s* + 2^249", () => honest(2, 1, [EXCEPTIONAL[1]], EXCEPTIONAL[1], 2)],
    ["t = n = 1", () => honest(1, 1, [123n], 456n)],
    ["t = 1, n = 16, last dealer", () => honest(16, 1, [99n], 100n, 16)],
  ];
  for (const [name, mk] of cases) {
    test(name, async () => {
      await proveAndVerify(build(mk()));
    });
  }
});

describe("deal: mutations fail at the expected constraint", () => {
  // honest base: n = 3, t = 2 (slots 3..15 inactive), small coefficients/ephemeral so that
  // value + r stays below 2^251 for the [r, 2^251) aliasing cases
  const base = () => honest(3, 2, [11n, 13n], 17n);
  const run = (raw: Raw) => () => deal.witness(build(raw));
  const rawWitness = (raw: Raw, edit: (w: ReturnType<typeof build>) => void) => () => {
    const w = build(raw);
    edit(w);
    return deal.witness(w);
  };
  const MASKED = "masked[i] === u.out[i] * (s[i] + mask[i].out)";

  test("honest base is accepted", async () => {
    const w = await deal.witness(build(base()));
    assert.equal(await deal.firstViolation(w), -1);
  });

  test("wrong share (consistently masked) fails Feldman", async () => {
    const b = base();
    const s = b.a.map((_, i) => (i < 3 ? P.evalPoly(b.a, BigInt(i + 1)) : 0n));
    s[1] += 1n;
    await expectFailure(run({ ...b, s }), "Deal", "u.out[i] * (sG[i].out[0] - horner[i].out[0]) === 0");
  });

  test("zero share substituted for a non-zero share fails Feldman", async () => {
    const b = base();
    const s = b.a.map((_, i) => (i < 3 ? P.evalPoly(b.a, BigInt(i + 1)) : 0n));
    s[0] = 0n;
    await expectFailure(run({ ...b, s }), "Deal", "u.out[i] * (sG[i].out[0] - horner[i].out[0]) === 0");
  });

  test("wrong mask fails the mask equation", async () => {
    await expectFailure(rawWitness(base(), (w) => (w.masked[0] = P.dec(BigInt(w.masked[0]) + 1n))), "Deal", MASKED);
  });

  test("wrong context limb fails the mask equation", async () => {
    const b = base();
    const honestMasked = build(b).masked;
    await expectFailure(rawWitness(b, (w) => ((w.ctxLo = P.dec(BigInt(w.ctxLo) ^ 1n)), (w.masked = honestMasked))), "Deal", MASKED);
    await expectFailure(rawWitness(b, (w) => ((w.ctxHi = P.dec(BigInt(w.ctxHi) ^ 1n)), (w.masked = honestMasked))), "Deal", MASKED);
  });

  test("context limb >= 2^128 (consistently masked) fails the limb range check", async () => {
    const b = base();
    const { hi, lo } = P.limbs(b.ctx);
    await expectFailure(run({ ...b, ctxHi: hi + (1n << 128n) }), "Num2Bits", "lc1 === in");
    await expectFailure(run({ ...b, ctxLo: lo + (1n << 128n) }), "Num2Bits", "lc1 === in");
  });

  test("wrong or swapped recipient key fails the mask equation", async () => {
    const b = base();
    const honestMasked = build(b).masked;
    const other = scB.members[10].X;
    await expectFailure(rawWitness(b, (w) => ((w.X[1] = decPt(other)), (w.masked = honestMasked))), "Deal", MASKED);
    await expectFailure(
      rawWitness(b, (w) => {
        [w.X[0], w.X[1]] = [w.X[1], w.X[0]];
        w.masked = honestMasked;
      }),
      "Deal",
      MASKED,
    );
  });

  test("wrong dealer index fails the mask equation", async () => {
    await expectFailure(rawWitness(base(), (w) => (w.dealerIndex = "2")), "Deal", MASKED);
  });

  test("a_k != 0 beyond t (consistent degree-t dealing) fails the coefficient gate", async () => {
    const b = base();
    b.a[2] = 5n; // t = 2, so a_2 must be zero
    await expectFailure(run(b), "Deal", "(1 - v.out[k]) * a[k] === 0");
  });

  test("non-identity C_k beyond t with a_k = 0 fails the commitment check", async () => {
    const b = base();
    const C = b.a.map((ak) => P.mulG(ak));
    C[2] = P.G;
    await expectFailure(run({ ...b, C }), "Deal", "C[k][0] === aG[k].out[0]");
  });

  test("altered commitment, identity commitment, zero coefficient each fail the commitment check", async () => {
    const b = base();
    const C1 = b.a.map((ak) => P.mulG(ak));
    C1[0] = P.pointAdd(C1[0], P.G);
    await expectFailure(run({ ...b, C: C1 }), "Deal", "C[k][0] === aG[k].out[0]");
    const C2 = b.a.map((ak) => P.mulG(ak));
    C2[1] = P.O;
    await expectFailure(run({ ...b, C: C2 }), "Deal", "C[k][0] === aG[k].out[0]");
    const C3 = b.a.map((ak) => P.mulG(ak));
    const a = [...b.a];
    a[0] = 0n; // shares recomputed from the zeroed polynomial, commitment kept
    await expectFailure(run({ ...b, a, C: C3 }), "Deal", "C[k][0] === aG[k].out[0]");
  });

  test("altered or identity E fails the ephemeral check", async () => {
    const b = base();
    await expectFailure(run({ ...b, E: P.pointAdd(P.mulG(b.e), P.G) }), "Deal", "E[0] === eG.out[0]");
    await expectFailure(run({ ...b, E: P.O }), "Deal", "E[0] === eG.out[0]");
  });

  test("e = 0 (consistent E = O, S = O) fails the non-zero check", async () => {
    await expectFailure(run({ ...base(), e: 0n }), "Deal", "e * eInv === 1");
  });

  test("coefficient in [r, 2^251) aliasing a valid one fails the explicit < r row", async () => {
    const b = base();
    const a = [...b.a];
    a[0] += P.R; // same commitment and shares mod r
    assert.ok(a[0] < 1n << 251n);
    await expectFailure(run({ ...b, a, C: b.a.map((ak) => P.mulG(ak)), s: [...b.a.keys()].map((i) => (i < 3 ? P.evalPoly(b.a, BigInt(i + 1)) : 0n)) }), "ScalarBits", "gt.out === 0");
  });

  test("coefficient in [2^251, p) fails the 251-bit decomposition", async () => {
    const b = base();
    const a = [...b.a];
    a[1] += 7n * P.R;
    assert.ok(a[1] >= 1n << 251n && a[1] < P.P);
    await expectFailure(run({ ...b, a, C: b.a.map((ak) => P.mulG(ak)), s: [...b.a.keys()].map((i) => (i < 3 ? P.evalPoly(b.a, BigInt(i + 1)) : 0n)) }), "Num2Bits", "lc1 === in");
  });

  test("share in [r, p) with a matching masked value fails the range checks", async () => {
    const b = base();
    const s = b.a.map((_, i) => (i < 3 ? P.evalPoly(b.a, BigInt(i + 1)) : 0n));
    const s1 = [...s];
    s1[0] += P.R; // recipient would unmask s + r >= r
    await expectFailure(run({ ...b, s: s1 }), "ScalarBits", "gt.out === 0");
    const s2 = [...s];
    s2[2] += 7n * P.R;
    await expectFailure(run({ ...b, s: s2 }), "Num2Bits", "lc1 === in");
  });

  test("ephemeral in [r, p) fails the range checks", async () => {
    const b = base();
    await expectFailure(run({ ...b, e: b.e + P.R }), "ScalarBits", "gt.out === 0");
    await expectFailure(run({ ...b, e: b.e + 7n * P.R }), "Num2Bits", "lc1 === in");
  });

  test("non-zero masked output at an inactive slot fails the mask equation", async () => {
    await expectFailure(rawWitness(base(), (w) => (w.masked[3] = "1")), "Deal", MASKED);
  });

  test("non-zero share at an inactive slot fails, including a leaked real evaluation", async () => {
    const b = base();
    const s = b.a.map((_, i) => (i < 3 ? P.evalPoly(b.a, BigInt(i + 1)) : 0n));
    s[3] = 7n;
    await expectFailure(run({ ...b, s }), "Deal", "(1 - u.out[i]) * s[i] === 0");
    // dummy recipient at slot 3 (member 4) with a known key: the real evaluation f(4) masked to it
    const leak = [...s];
    leak[3] = P.evalPoly(b.a, 4n);
    const X = [...b.X];
    X[3] = scB.members[3].X;
    const w = build({ ...b, s: leak, X });
    const S4 = P.mul(X[3], b.e);
    w.masked[3] = P.dec((leak[3] + P.maskOf(b.ctx, 1, 4, S4)) % P.P);
    await expectFailure(() => deal.witness(w), "Deal", "(1 - u.out[i]) * s[i] === 0");
  });

  test("non-Base8 recipient key at an inactive slot fails the padding check", async () => {
    const b = base();
    const X = [...b.X];
    X[5] = scB.members[5].X;
    await expectFailure(run({ ...b, X }), "Deal", "(1 - u.out[i]) * (X[i][0] - G[0]) === 0");
  });

  test("dealer index out of range (consistently masked) fails the one-hot checks", async () => {
    await expectFailure(run({ ...base(), dealerIndex: 0 }), "Deal", "wSum === 1");
    await expectFailure(run({ ...base(), dealerIndex: 4 }), "Deal", "w[i] * (1 - u.out[i]) === 0");
    await expectFailure(run({ ...base(), dealerIndex: 17 }), "Deal", "wSum === 1");
  });

  test("t > n fails the t <= n check", async () => {
    await expectFailure(run({ ...base(), t: 4 }), "Deal", "v.out[k] * (1 - u.out[k]) === 0");
  });

  test("t and n out of [1, 16] fail the activity vectors", async () => {
    await expectFailure(run({ ...base(), t: 0 }), "ActiveBits", "out[0] === 1");
    await expectFailure(run({ ...base(), t: 17 }), "ActiveBits", "sum === count");
    const b = base();
    await expectFailure(run({ ...b, n: 0, s: Array(16).fill(0n), masked: Array(16).fill(0n), X: Array(16).fill(P.G) }), "ActiveBits", "out[0] === 1");
    await expectFailure(run({ ...b, n: 17, X: P.paddedRoster(scB.members.map((m) => m.X)) }), "ActiveBits", "sum === count");
  });
});

describe("deal: hint tampering is caught by the R1CS", () => {
  test("flipping constrained hint outputs violates the optimized R1CS", async () => {
    const input = vectors.scenarios[0].dealings[0].witnessInput; // n = 3, t = 2, dealer 1
    const honestW = await deal.witness(input);
    assert.equal(await deal.firstViolation(honestW), -1);
    const flips = ["main.u.out[3]", "main.v.out[2]", "main.w[0]", "main.w[1]", "main.eInv", "main.aBits[0].out[0]", "main.eBits.out[5]", "main.sBits[0].out[3]"];
    for (const name of flips) {
      const idx = deal.signal(name);
      assert.ok(idx > 0, `${name} was optimized away`);
      const w = clone(honestW);
      w[idx] = name === "main.eInv" ? (w[idx] + 1n) % P.P : 1n - w[idx];
      assert.notEqual(await deal.firstViolation(w), -1, `${name} flip not caught`);
    }
  });
});
