// v2 composition: the verifiers see points the contract authenticated against compressed words
// (§2.5), or G padding. The circuits never check subgroup membership of a base, so these tests pin
// (a) that authentication admits exactly the stored point and no torsion or sign variant of it,
// (b) that the zero word and bit 254 never occur in what an honest run stores, (c) that keys and
// ciphertexts at the top of the x range prove against the vector the contract builds, and (d) that
// no Montgomery/Edwards hint row of either circuit sees a vanishing denominator on honest extreme
// inputs (a vanishing one would leave its hint free for a malicious prover).
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hex } from "viem";
import * as P from "../src/protocol.ts";
import * as S from "../src/scenario.ts";
import { Circuit, shutdown } from "../src/harness.ts";
import { EXCEPTIONAL } from "./util.ts";

const deal = new Circuit("deal");
const partial = new Circuit("partial");
after(shutdown);

const sc = S.buildScenario(S.SPECS[1]);
const neg = (p: P.Point): P.Point => [P.mod(-p[0], P.P), p[1]];
const NEG_G = neg(P.G);
const T2: P.Point = [0n, P.P - 1n];
const T8: P.Point = [
  17545522957889784193459637215142187266023652151580582754000402781682644312291n,
  17061719626832259898845741003733890968968767993363194771977168648564009544074n,
];
const TORSION = [0n, 1n, 2n, 3n, 4n, 5n, 6n, 7n].map((k) => P.mul(T8, k)); // O first
const BIT254 = 1n << 254n;
const ZERO_WORD = 0n;
const IDENTITY_WORD = 1n << 255n;

/** Every on-curve point ±S + T (T 8-torsion) other than S: same x up to sign, other parity, shifts. */
const alternatives = (s: P.Point) =>
  [s, neg(s)].flatMap((b) => TORSION.map((t) => P.pointAdd(b, t))).filter((q) => !P.eqPoint(q, s));

/** The contract's view of a stored point: what decompress(word) yields and authenticate admits. */
function viaWord(p: P.Point): P.Point {
  const word = P.compress(p);
  const d = P.decompressChecked(word);
  assert.ok("point" in d, "stored word does not decode");
  assert.equal(P.authenticate(word, d.point), "ok");
  return d.point;
}

// Subgroup points k·G with the largest x among k in [2, 400): x >= 2^253 for both y parities, the
// region where a codec bug (bit 254, carry into the parity bit) would show.
const HIGH: P.Point[] = (() => {
  const pts: P.Point[] = [];
  for (let k = 2n; k < 400n; k++) pts.push(P.mulG(k));
  return pts.sort((a, b) => (a[0] < b[0] ? 1 : -1)).slice(0, 16);
})();

describe("v2 codec: authentication pins the base the circuit multiplies", () => {
  test("the high-x fixture spans x >= 2^253 with both y parities", () => {
    assert.ok(HIGH.every((p) => p[0] >= 1n << 253n && P.inPrimeSubgroup(p)));
    assert.ok(HIGH.some((p) => (p[1] & 1n) === 0n) && HIGH.some((p) => (p[1] & 1n) === 1n));
  });

  test("every torsion, sign and parity variant of a stored point fails authentication", () => {
    const stored = [P.G, NEG_G, ...sc.members.map((m) => m.X), ...sc.cts.flatMap((c) => [c.C1, c.C2]), ...HIGH];
    for (const s of stored) {
      const word = P.compress(s);
      assert.equal(P.authenticate(word, s), "ok");
      const alts = alternatives(s);
      assert.equal(new Set(alts.map((q) => `${q[0]},${q[1]}`)).size, 15);
      for (const q of alts) {
        assert.ok(P.onCurve(q));
        assert.equal(P.authenticate(word, q), "CompressedPointMismatch", `variant of ${s[0]} authenticated`);
      }
      // the coordinate aliases a 256-bit word can still carry
      if (s[0] + P.P < 1n << 256n) assert.equal(P.authenticate(word, [s[0] + P.P, s[1]]), "NonCanonical");
      if (s[1] + P.P < 1n << 256n) assert.equal(P.authenticate(word, [s[0], s[1] + P.P]), "NonCanonical");
    }
  });

  test("only O and T2 have x = 0; they own the words 2^255 and 0, and no honest store produces either", () => {
    // y² = (1 - a·0)/(1 - d·0) = 1 at x = 0
    assert.deepEqual(P.decompressChecked(ZERO_WORD), { point: T2 });
    assert.deepEqual(P.decompressChecked(IDENTITY_WORD), { point: P.O });
    assert.equal(P.authenticate(ZERO_WORD, T2), "ok", "an unset slot would authenticate T2");
    assert.equal(P.inPrimeSubgroup(T2), false);
    assert.ok(P.P < BIT254);
    const words = [
      ...sc.members.map((m) => m.X),
      ...sc.dealings.map((d) => d.dealing.E),
      ...sc.cts.flatMap((c) => [c.C1, c.C2]),
      ...HIGH,
    ].map(P.compress);
    for (const w of words) {
      assert.ok(w !== ZERO_WORD && w !== IDENTITY_WORD && (w & BIT254) === 0n);
      assert.ok("point" in P.decompressChecked(w));
    }
  });
});

describe("completeness at the codec boundary, against the contract-built public vector", () => {
  test("16-member deal over high-x keys of both parities proves and verifies", async () => {
    const roster = HIGH.map(viaWord);
    assert.deepEqual(roster, HIGH);
    const coeffs = [P.R - 1n, 1n, 2n, (1n << 148n) - 1n, 1n << 148n, (1n << 148n) + 1n, ...EXCEPTIONAL];
    while (coeffs.length < 16) coeffs.push(P.R - BigInt(coeffs.length));
    const d = P.makeDealing(sc.ctx, 16, 16, roster, coeffs, P.R - 1n);
    const input = P.dealWitnessInput(sc.ctx, d, roster);
    const w = await deal.witness(input);
    assert.equal(await deal.firstViolation(w), -1);
    assert.deepEqual(await degenerateHints(deal, w), []);
    const { proof, publicSignals } = await deal.prove(input);
    assert.deepEqual(publicSignals, P.dealPublicInputs(input));
    assert.ok(await deal.verify(publicSignals, proof));
  });

  test("16-field partial over high-x C1 proves; the proof is context-free but binds the full point", async () => {
    const C1 = HIGH.map(viaWord);
    const s = EXCEPTIONAL[0];
    const input = P.partialWitnessInput(P.mulG(s), s, C1);
    const { proof, publicSignals } = await partial.prove(input);
    assert.deepEqual(publicSignals, P.partialPublicInputs(input));
    assert.ok(await partial.verify(publicSignals, proof));
    // Replay across requests with the same stored C1 words: the statement has no request id
    // (§10.2, D is context-free by design); the signed payload hash is what binds the request.
    const D = input.D.map((p) => [BigInt(p[0]), BigInt(p[1])] as P.Point);
    const other = `0x${"ab".repeat(32)}` as Hex;
    assert.notEqual(P.partialPayloadHash(sc.requestId, D, P.proofWords(proof)), P.partialPayloadHash(other, D, P.proofWords(proof)));
    // Same word, different full point: authentication refuses it, and so would the verifier.
    for (const k of [0, 15]) {
      for (const q of alternatives(C1[k])) {
        assert.equal(P.authenticate(P.compress(C1[k]), q), "CompressedPointMismatch");
        const bad = [...publicSignals];
        bad[3 + 2 * k] = P.dec(q[0]);
        bad[4 + 2 * k] = P.dec(q[1]);
        assert.equal(await partial.verify(bad, proof), false, `C1[${k}] variant accepted by the verifier`);
      }
    }
  });
});

// A hint row is A·B = C with one side a single hinted wire (λ of a Montgomery add/double, the
// output of an Edwards/Montgomery conversion, BabyAdd's x3/y3). If the other side evaluates to 0
// the row says nothing about the hint. Returns the names of every such row on witness w.
const HINT = /(lamda|xout|yout|e2m.*\.out\[\d+\]|m2e.*\.out\[\d+\])$/;
const hintRows = new Map<string, { wire: number; other: Map<number, bigint>; name: string }[]>();
async function rowsOf(c: Circuit) {
  if (!hintRows.has(c.name)) {
    const names = new Map<number, string>();
    for (const line of readFileSync(join(c.dir, `${c.name}.sym`), "utf8").split("\n")) {
      const f = line.split(",");
      if (f.length >= 4 && Number(f[1]) >= 0 && !names.has(Number(f[1]))) names.set(Number(f[1]), f[3]);
    }
    const rows = [];
    for (const [A, B] of (await c.r1cs()).constraints) {
      for (const [one, other] of [[A, B], [B, A]] as const) {
        if (one.size !== 1) continue;
        const [wire] = one.keys();
        const name = names.get(wire) ?? "";
        if (HINT.test(name)) rows.push({ wire, other, name });
      }
    }
    hintRows.set(c.name, rows);
  }
  return hintRows.get(c.name)!;
}
const evalLc = (lc: Map<number, bigint>, w: bigint[]) => {
  let a = 0n;
  for (const [i, k] of lc) a += k * w[i];
  return a % P.P;
};
async function degenerateHints(c: Circuit, w: bigint[]) {
  return (await rowsOf(c)).filter((r) => evalLc(r.other, w) === 0n).map((r) => r.name);
}

describe("no hint row of either circuit degenerates on honest extreme inputs", () => {
  const scalars = [1n, 2n, 3n, P.R - 1n, P.R - 2n, (1n << 148n) - 1n, 1n << 148n, (1n << 148n) + 1n, ...EXCEPTIONAL];
  const bases = [P.G, NEG_G, ...HIGH.slice(0, 14)];

  test("partial: every boundary share over [G, -G, 14 high-x bases]", async () => {
    assert.ok((await rowsOf(partial)).length > 30000, "hint-row pattern no longer matches the circuit");
    for (const s of scalars) {
      const w = await partial.witness(P.partialWitnessInput(P.mulG(s), s, bases));
      assert.equal(await partial.firstViolation(w), -1);
      assert.deepEqual(await degenerateHints(partial, w), [], `s = ${s}`);
    }
  });

  test("deal: boundary ephemerals over [G, -G, 14 high-x keys] with boundary coefficients", async () => {
    assert.ok((await rowsOf(deal)).length > 30000, "hint-row pattern no longer matches the circuit");
    const coeffs = [...scalars, 0n, 5n, 6n, 7n, 8n].slice(0, 16);
    for (const e of [1n, P.R - 1n, (1n << 148n) + 1n, EXCEPTIONAL[2]]) {
      const d = P.makeDealing(sc.ctx, 1, 16, bases, coeffs, e);
      const w = await deal.witness(P.dealWitnessInput(sc.ctx, d, bases));
      assert.equal(await deal.firstViolation(w), -1);
      assert.deepEqual(await degenerateHints(deal, w), [], `e = ${e}`);
    }
  });

  test("the scan flags a hint row whose denominator is forced to zero", async () => {
    const w = await partial.witness(P.partialWitnessInput(P.G, 1n, [P.G]));
    const row = (await rowsOf(partial)).find((r) => [...r.other.keys()].some((i) => i !== 0))!;
    const [v, coef] = [...row.other].find(([i]) => i !== 0)!;
    // shift wire v so the denominator is 0 (coef is invertible: non-zero mod a prime)
    w[v] = P.mod(w[v] - evalLc(row.other, w) * P.modPow(coef, P.P - 2n, P.P), P.P);
    assert.ok((await degenerateHints(partial, w)).includes(row.name));
  });
});
