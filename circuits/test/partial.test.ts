// Partial decryption circuit (protocol §10.1): positive vectors and completeness battery,
// single-defect mutations at the expected constraint, hint tampering, public-signal mutations.
import { after, before, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as P from "../src/protocol.ts";
import * as S from "../src/scenario.ts";
import { Circuit, shutdown } from "../src/harness.ts";
import { clone, decPt, EXCEPTIONAL, expectFailure } from "./util.ts";

const vectors = JSON.parse(readFileSync(new URL("../../tests/vectors/combine.json", import.meta.url), "utf8"));
const partial = new Circuit("partial");
after(shutdown);

let C1all: P.Point[];
before(() => {
  C1all = S.buildScenario(S.SPECS[1]).cts.map((c) => c.C1); // 16 request-validated bases
});

type Raw = { s: bigint; activeCount: number; C1: P.Point[]; PK?: P.Point; D?: P.Point[] };

function build(raw: Raw) {
  const PK = raw.PK ?? P.mulG(raw.s);
  const D = raw.D ?? raw.C1.map((c, k) => (k < raw.activeCount ? P.mul(c, raw.s) : P.O));
  return {
    PK: decPt(PK),
    activeCount: P.dec(raw.activeCount),
    C1: raw.C1.map(decPt),
    D: D.map(decPt),
    s: P.dec(raw.s),
  };
}

const padded = (fields: number) => [...C1all.slice(0, fields), ...Array(16 - fields).fill(P.G)] as P.Point[];

async function proveAndVerify(input: ReturnType<typeof build>) {
  const w = await partial.witness(input);
  assert.equal(await partial.firstViolation(w), -1, "witness violates the optimized R1CS");
  const { proof, publicSignals } = await partial.prove(input);
  assert.deepEqual(publicSignals, P.partialPublicInputs(input));
  assert.ok(await partial.verify(publicSignals, proof), "proof does not verify");
  return { proof, publicSignals };
}

describe("partial: vectors", () => {
  test("every vector partial satisfies the optimized R1CS with the table-order public inputs", async () => {
    for (const sc of vectors.scenarios) {
      for (const p of sc.partials) {
        const w = await partial.witness(p.witnessInput);
        assert.equal(await partial.firstViolation(w), -1);
        assert.deepEqual(w.slice(1, 68).map(String), p.publicInputs);
      }
    }
  });

  test("one proof per scenario verifies; each of the 67 public signals perturbed is rejected", async () => {
    for (const sc of vectors.scenarios) {
      const { proof, publicSignals } = await proveAndVerify(sc.partials[0].witnessInput);
      if (sc.name !== "A") continue;
      for (let i = 0; i < 67; i++) {
        const bad = [...publicSignals];
        bad[i] = P.dec((BigInt(bad[i]) + 1n) % P.P);
        assert.equal(await partial.verify(bad, proof), false, `public signal ${i} perturbed but accepted`);
      }
    }
  });
});

describe("partial: completeness battery", () => {
  const scalars: [string, bigint][] = [
    ["s = 0 (PK = O, every D = O)", 0n],
    ["s = 1", 1n],
    ["s = r - 1", P.R - 1n],
    ["s = s*", EXCEPTIONAL[0]],
    ["s = s* + 2^249", EXCEPTIONAL[1]],
    ["s = s* + 2^250", EXCEPTIONAL[2]],
  ];
  for (const [name, s] of scalars) {
    test(`${name}, 16 fields`, async () => {
      await proveAndVerify(build({ s, activeCount: 16, C1: padded(16) }));
    });
  }
  test("activeCount = 1 with s = 0 and s = r - 1", async () => {
    await proveAndVerify(build({ s: 0n, activeCount: 1, C1: padded(1) }));
    await proveAndVerify(build({ s: P.R - 1n, activeCount: 1, C1: padded(1) }));
  });
});

describe("partial: mutations fail at the expected constraint", () => {
  const F = 3;
  const base = (): Raw => ({ s: 99n, activeCount: F, C1: padded(F) });
  const run = (raw: Raw) => () => partial.witness(build(raw));
  const honestD = (raw: Raw) => raw.C1.map((c, k) => (k < raw.activeCount ? P.mul(c, raw.s) : P.O));
  const DX = "D[k][0] === act.out[k] * mul[k].out[0]";

  test("honest base is accepted", async () => {
    const w = await partial.witness(build(base()));
    assert.equal(await partial.firstViolation(w), -1);
  });

  test("wrong PK fails the PK check", async () => {
    const b = base();
    await expectFailure(run({ ...b, PK: P.pointAdd(P.mulG(b.s), P.G) }), "Partial", "PK[0] === sG.out[0]");
    await expectFailure(run({ ...b, PK: P.O }), "Partial", "PK[0] === sG.out[0]");
  });

  test("wrong share with PK and D unchanged fails the PK check", async () => {
    const b = base();
    await expectFailure(run({ ...b, s: b.s + 1n, PK: P.mulG(b.s), D: honestD(b) }), "Partial", "PK[0] === sG.out[0]");
  });

  test("altered or identity D at an active field fails the product check", async () => {
    const b = base();
    const D1 = honestD(b);
    D1[1] = P.pointAdd(D1[1], P.G);
    await expectFailure(run({ ...b, D: D1 }), "Partial", DX);
    const D2 = honestD(b);
    D2[0] = P.O;
    await expectFailure(run({ ...b, D: D2 }), "Partial", DX);
  });

  test("altered C1 with D unchanged fails the product check", async () => {
    const b = base();
    const C1 = [...b.C1];
    C1[2] = P.pointAdd(C1[2], P.G);
    await expectFailure(run({ ...b, C1, D: honestD(b) }), "Partial", DX);
  });

  test("non-identity D at an inactive field fails the padding product check", async () => {
    const b = base();
    const D = honestD(b);
    D[F] = P.mul(P.G, b.s); // the honest-looking product with the Base8 padding
    await expectFailure(run({ ...b, D }), "Partial", DX);
  });

  test("non-Base8 C1 at an inactive field fails the padding check", async () => {
    const b = base();
    const C1 = [...b.C1];
    C1[F + 1] = C1all[10];
    await expectFailure(run({ ...b, C1 }), "Partial", "(1 - act.out[k]) * (C1[k][0] - G[0]) === 0");
  });

  test("activeCount larger than the request with D unchanged fails the product check", async () => {
    const b = base();
    await expectFailure(run({ ...b, activeCount: F + 1, D: honestD(b) }), "Partial", DX);
  });

  test("activeCount out of [1, 16] fails the activity vector", async () => {
    const b = base();
    await expectFailure(run({ ...b, activeCount: 0, C1: padded(0), D: Array(16).fill(P.O) }), "ActiveBits", "out[0] === 1");
    await expectFailure(run({ ...b, activeCount: 17, C1: padded(16) }), "ActiveBits", "sum === count");
  });

  test("share in [r, p) aliasing a valid one fails the range checks", async () => {
    const b = base();
    const PK = P.mulG(b.s);
    const D = honestD(b);
    await expectFailure(run({ ...b, s: b.s + P.R, PK, D }), "ScalarBits", "gt.out === 0");
    await expectFailure(run({ ...b, s: b.s + 7n * P.R, PK, D }), "Num2Bits", "lc1 === in");
  });
});

describe("partial: hint tampering is caught by the R1CS", () => {
  test("flipping constrained hint outputs violates the optimized R1CS", async () => {
    const input = vectors.scenarios[0].partials[0].witnessInput; // 3 fields
    const honestW = await partial.witness(input);
    assert.equal(await partial.firstViolation(honestW), -1);
    // the share bits survive --O2 under the name of the first multiplication's input
    for (const name of ["main.act.out[3]", "main.act.out[2]", "main.mul[0].e[0]", "main.mul[0].e[5]", "main.mul[0].e[148]"]) {
      const idx = partial.signal(name);
      assert.ok(idx > 0, `${name} was optimized away`);
      const w = clone(honestW);
      w[idx] = 1n - w[idx];
      assert.notEqual(await partial.firstViolation(w), -1, `${name} flip not caught`);
    }
  });
});
