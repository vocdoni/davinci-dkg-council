// Gadget-level tests: the forbidden EscalarMulFix(251, Base8) defect, the split fixed-base
// replacement, canonical scalar boundaries, and the public-row checker itself.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import * as P from "../src/protocol.ts";
import { Circuit, shutdown } from "../src/harness.ts";
import { missingDedicatedPublicRows } from "../src/publicrows.ts";
import { compileTestCircuit, EXCEPTIONAL, expectFailure } from "./util.ts";

let forbidden: Circuit;
let mulg: Circuit;
let norows: Circuit;

before(() => {
  forbidden = new Circuit("fixmul251", compileTestCircuit("fixmul251"));
  mulg = new Circuit("mulg", compileTestCircuit("mulg"));
  norows = new Circuit("norows", compileTestCircuit("norows"));
});
after(shutdown);

test("forbidden EscalarMulFix(251, Base8) fails witness generation on the three exceptional scalars", async () => {
  for (const k of EXCEPTIONAL) {
    assert.ok(k < P.R);
    // the last Montgomery addition adds inverse points: lamda = 0/0 has no witness
    await expectFailure(() => forbidden.witness({ k: P.dec(k) }), "MontgomeryAdd", "lamda * (in2[0] - in1[0]) === (in2[1] - in1[1])");
  }
  // and works on ordinary scalars (the defect is completeness only)
  const w = await forbidden.witness({ k: "123456789" });
  assert.deepEqual([w[1], w[2]], P.mulG(123456789n));
});

test("split fixed-base MulG is complete: exceptional scalars, 0, 1, r-1, segment boundaries", async () => {
  const cases = [
    ...EXCEPTIONAL,
    0n,
    1n,
    2n,
    P.R - 1n,
    P.R - 2n,
    (1n << 246n) - 1n,
    1n << 246n,
    (1n << 246n) + 1n,
    (1n << 249n) - 1n,
    1n << 249n,
    1n << 250n,
    (1n << 250n) + (1n << 249n) - 1n,
    P.R - (1n << 246n),
  ];
  for (const k of cases) {
    const w = await mulg.witness({ k: P.dec(k) });
    assert.deepEqual([w[1], w[2]], P.mulG(k), `k = ${k}`);
    assert.equal(await mulg.firstViolation(w), -1);
  }
});

test("ScalarBits rejects every value in [r, p)", async () => {
  // [r, 2^251): Num2Bits(251) accepts, the explicit CompConstant(r - 1) row rejects
  for (const k of [P.R, P.R + 1n, (1n << 251n) - 1n]) {
    await expectFailure(() => mulg.witness({ k: P.dec(k) }), "ScalarBits", "gt.out === 0");
  }
  // [2^251, p): Num2Bits(251) itself rejects
  for (const k of [1n << 251n, 7n * P.R + 5n, P.P - 1n]) {
    await expectFailure(() => mulg.witness({ k: P.dec(k) }), "Num2Bits", "lc1 === in");
  }
});

test("public-row checker flags a public input without a dedicated left row", async () => {
  const r = await norows.r1cs();
  assert.deepEqual(missingDedicatedPublicRows(r), [1]); // x (wire 1) missing, y (wire 2) present
});

test("deal and partial: every public input has a dedicated left row in the optimized R1CS", async () => {
  for (const name of ["deal", "partial"] as const) {
    const r = await new Circuit(name).r1cs();
    assert.equal(r.nOutputs, 0);
    assert.equal(r.nPubInputs, name === "deal" ? 87 : 67);
    assert.deepEqual(missingDedicatedPublicRows(r), [], name);
  }
});
