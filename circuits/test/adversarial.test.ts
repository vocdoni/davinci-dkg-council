// Malicious-prover suite. A cheating prover is bound only by the optimized R1CS, not by the
// witness generator (`<--` hints and `assert`s), so most cases here edit the witness vector wire by
// wire (./forge.ts) and assert exactly which constraint rejects it: each forgery is fully
// consistent except for the row under test, so the row is load-bearing. The y-coordinate rows,
// the variable-base segment boundaries and the contract preconditions the circuits rely on are
// covered at the end.
import { after, describe, test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import * as P from "../src/protocol.ts";
import * as S from "../src/scenario.ts";
import { Circuit, shutdown } from "../src/harness.ts";
import { Forge, locallyFreeWires } from "./forge.ts";
import { decPt, expectFailure } from "./util.ts";

const deal = new Circuit("deal");
const partial = new Circuit("partial");
after(shutdown);

const sc = S.buildScenario(S.SPECS[1]);
const X = sc.members.map((m) => m.X);
const C1all = sc.cts.map((c) => c.C1);
const negY = (p: P.Point): P.Point => [p[0], P.mod(-p[1], P.P)];
const NEG_G: P.Point = [P.mod(-P.G[0], P.P), P.G[1]];
const T2: P.Point = [0n, P.P - 1n]; // the order-2 point
// a point of order 8 (on curve, 8·T8 = O, 4·T8 != O; asserted below)
const T8: P.Point = [
  17545522957889784193459637215142187266023652151580582754000402781682644312291n,
  17061719626832259898845741003733890968968767993363194771977168648564009544074n,
];

type DealRaw = { dealerIndex: number; n: number; t: number; a: bigint[]; e: bigint; roster: P.Point[] };

/** Honest deal witness input: roster padded with G, shares f(i+1) for i < n, zeros above. */
function dealInput(r: DealRaw) {
  const { hi, lo } = P.limbs(sc.ctx);
  const a = [...r.a, ...Array(16 - r.a.length).fill(0n)];
  const Xp = [...r.roster, ...Array(16 - r.roster.length).fill(P.G)] as P.Point[];
  const s = a.map((_, i) => (i < r.n ? P.evalPoly(a, BigInt(i + 1)) : 0n));
  const masked = s.map((si, i) => (i < r.n ? (si + P.maskOf(sc.ctx, r.dealerIndex, i + 1, P.mul(Xp[i], r.e))) % P.P : 0n));
  return {
    ctxHi: P.dec(hi),
    ctxLo: P.dec(lo),
    dealerIndex: P.dec(r.dealerIndex),
    n: P.dec(r.n),
    t: P.dec(r.t),
    C: a.map((ak) => decPt(P.mulG(ak))),
    E: decPt(P.mulG(r.e)),
    X: Xp.map(decPt),
    masked: masked.map(P.dec),
    a: a.map(P.dec),
    e: P.dec(r.e),
    s: s.map(P.dec),
  };
}

function partialInput(s: bigint, C1: P.Point[], activeCount: number) {
  const D = C1.map((c, k) => (k < activeCount ? P.mul(c, s) : P.O));
  return { PK: decPt(P.mulG(s)), activeCount: P.dec(activeCount), C1: C1.map(decPt), D: D.map(decPt), s: P.dec(s) };
}

const padC1 = (head: P.Point[]) => [...head, ...Array(16 - head.length).fill(P.G)] as P.Point[];

async function satisfies(c: Circuit, input: object) {
  const w = await c.witness(input);
  assert.equal(await c.firstViolation(w), -1, "honest witness violates the optimized R1CS");
  return w;
}

// pubSq rows (src/publicrows.ts): deal 3 = n, 4 = t, 71 + i = masked[i]; partial 2 = activeCount,
// 35 + 2k / 36 + 2k = D[k].
describe("deal: forged witnesses against the optimized R1CS", () => {
  test("no wire of an honest witness can be perturbed alone without breaking a constraint", async () => {
    const vec = JSON.parse(readFileSync(new URL("../../tests/vectors/dealing.json", import.meta.url), "utf8"));
    const w = await satisfies(deal, vec.scenarios[0].dealings[0].witnessInput);
    assert.deepEqual(await locallyFreeWires(deal, w), []);
  });

  test("non-monotone recipient activity u = [1,1,0,1,0..] with n = 3 fails only the monotonicity row", async () => {
    // honest n = 4 dealing with f(3) = 0 and X[2] = G, so slot 2 can be switched off consistently
    const a1 = 5n;
    const f = new Forge(deal, await satisfies(deal, dealInput({ dealerIndex: 1, n: 4, t: 2, a: [P.mod(-3n * a1, P.R), a1], e: 17n, roster: [X[0], X[1], P.G, P.G] })));
    f.setPub("main.n", 3, 3n).set("main.u.out[2]", 0n).setPub("main.masked[2]", 73, 0n);
    // without it slot 3 (padding key G, so S = e·G = E is public) would carry f(4) in the clear
    assert.deepEqual(await f.violations(), [["main.u.out[2]", "main.u.out[3]"]]);
  });

  test("non-boolean recipient activity u[2] = 2 with n = 4 fails only the booleanity row", async () => {
    const a1 = 5n;
    const f = new Forge(deal, await satisfies(deal, dealInput({ dealerIndex: 1, n: 3, t: 2, a: [P.mod(-3n * a1, P.R), a1], e: 17n, roster: [X[0], X[1], P.G] })));
    const m2 = f.get("main.masked[2]");
    f.setPub("main.n", 3, 4n).set("main.u.out[2]", 2n).setPub("main.masked[2]", 73, 2n * m2);
    assert.deepEqual(await f.violations(), [["main.u.out[2]"]]);
  });

  test("non-monotone degree vector v = [1,0,1,0..] with t = 2 fails only the monotonicity row", async () => {
    // a = [a0, 0, a2]: a degree-2 polynomial posing as t = 2
    const f = new Forge(deal, await satisfies(deal, dealInput({ dealerIndex: 1, n: 3, t: 3, a: [11n, 0n, 13n], e: 17n, roster: X.slice(0, 3) })));
    f.setPub("main.t", 4, 2n).set("main.v.out[1]", 0n);
    assert.deepEqual(await f.violations(), [["main.v.out[1]", "main.v.out[2]"]]);
  });

  test("dealer index 4 > n = 3 through w = [-1,1,1,0..] fails only the w booleanity row", async () => {
    const a1 = 5n;
    const f = new Forge(deal, await satisfies(deal, dealInput({ dealerIndex: 4, n: 4, t: 2, a: [P.mod(-4n * a1, P.R), a1], e: 17n, roster: X.slice(0, 3) })));
    f.setPub("main.n", 3, 3n).set("main.u.out[3]", 0n).setPub("main.masked[3]", 74, 0n);
    f.set("main.w[0]", -1n).set("main.w[1]", 1n).set("main.w[2]", 1n).set("main.w[3]", 0n); // sum 1, Σ w·(i+1) = 4
    assert.deepEqual(await f.violations(), [["main.w[0]"]]);
  });

  test("ECDH, masks and masked shares of another ephemeral under the same E are rejected at the ECDH bits", async () => {
    const base = { dealerIndex: 1, n: 3, t: 2, a: [11n, 13n], roster: X.slice(0, 3) };
    const f = new Forge(deal, await satisfies(deal, dealInput({ ...base, e: 17n })));
    const other = await deal.witness(dealInput({ ...base, e: 18n }));
    await f.spliceFrom(other, ["main.ecdh[", "main.mask[", "main.masked[", "main.pubSq[71]", "main.pubSq[72]", "main.pubSq[73]"]);
    const v = await f.violations();
    assert.ok(v.length > 0, "spliced ECDH accepted");
    assert.ok(v.every((c) => c.some((nm) => nm.startsWith("main.ecdh["))), "violation outside the ECDH");
    assert.ok(v.some((c) => c.some((nm) => nm.startsWith("main.eBits.out["))), "ECDH not tied to the bits of e");
  });

  // Payload points E and C are not on-curve checked by the contract: (x, -y) is a curve point and
  // only the y rows tell it apart.
  test("E with a negated y fails the E y row", async () => {
    const inp = dealInput({ dealerIndex: 1, n: 3, t: 2, a: [11n, 13n], e: 17n, roster: X.slice(0, 3) });
    inp.E = decPt(negY(P.mulG(17n)));
    await expectFailure(() => deal.witness(inp), "Deal", "E[1] === eG.out[1]");
  });

  test("C_0 with a negated y and C_k = (0, -1) above the degree fail the C y row", async () => {
    const inp = dealInput({ dealerIndex: 1, n: 3, t: 2, a: [11n, 13n], e: 17n, roster: X.slice(0, 3) });
    inp.C[0] = decPt(negY(P.mulG(11n)));
    await expectFailure(() => deal.witness(inp), "Deal", "C[k][1] === aG[k].out[1]");
    const inp2 = dealInput({ dealerIndex: 1, n: 3, t: 2, a: [11n, 13n], e: 17n, roster: X.slice(0, 3) });
    inp2.C[5] = decPt(T2);
    await expectFailure(() => deal.witness(inp2), "Deal", "C[k][1] === aG[k].out[1]");
  });

  test("inactive roster slot (G.x, -G.y) fails the padding y row", async () => {
    const inp = dealInput({ dealerIndex: 1, n: 3, t: 2, a: [11n, 13n], e: 17n, roster: X.slice(0, 3) });
    inp.X[7] = decPt(negY(P.G));
    await expectFailure(() => deal.witness(inp), "Deal", "(1 - u.out[i]) * (X[i][1] - G[1]) === 0");
  });
});

describe("partial: forged witnesses against the optimized R1CS", () => {
  test("no wire of an honest witness can be perturbed alone without breaking a constraint", async () => {
    const vec = JSON.parse(readFileSync(new URL("../../tests/vectors/combine.json", import.meta.url), "utf8"));
    const w = await satisfies(partial, vec.scenarios[0].partials[0].witnessInput);
    assert.deepEqual(await locallyFreeWires(partial, w), []);
  });

  test("non-monotone activity [1,0,1,0..] with activeCount = 2 fails only the monotonicity row", async () => {
    const f = new Forge(partial, await satisfies(partial, partialInput(99n, padC1([C1all[0]]), 3)));
    f.setPub("main.activeCount", 2, 2n).set("main.act.out[1]", 0n).setPub("main.D[1][0]", 37, 0n).setPub("main.D[1][1]", 38, 1n);
    assert.deepEqual(await f.violations(), [["main.act.out[1]", "main.act.out[2]"]]);
  });

  test("non-boolean activity act[1] = 2 with activeCount = 3 fails only the booleanity row", async () => {
    const f = new Forge(partial, await satisfies(partial, partialInput(99n, padC1([C1all[0]]), 2)));
    const [x, y] = P.mulG(99n);
    f.setPub("main.activeCount", 2, 3n).set("main.act.out[1]", 2n);
    f.setPub("main.D[1][0]", 37, 2n * x).setPub("main.D[1][1]", 38, 2n * y - 1n); // D = 2·(s·G) - 1 coordinate-wise
    assert.deepEqual(await f.violations(), [["main.act.out[1]"]]);
  });

  test("partials of another share under the same PK are rejected at the share bits", async () => {
    const C1 = padC1(C1all.slice(0, 3));
    const f = new Forge(partial, await satisfies(partial, partialInput(99n, C1, 3)));
    const other = await partial.witness(partialInput(100n, C1, 3));
    const rows = [35, 36, 37, 38, 39, 40].map((r) => `main.pubSq[${r}]`);
    await f.spliceFrom(other, ["main.mul[", "main.D[", ...rows]);
    const v = await f.violations();
    assert.ok(v.length > 0, "spliced partials accepted");
    assert.ok(v.every((c) => c.some((nm) => nm.startsWith("main.mul["))), "violation outside the multiplications");
    assert.ok(v.some((c) => c.includes("main.s")), "multiplications not tied to s");
  });

  test("PK, active D and inactive D with a negated y fail their y rows", async () => {
    const DY = "D[k][1] - 1 === act.out[k] * (mul[k].out[1] - 1)";
    const mk = () => partialInput(99n, padC1(C1all.slice(0, 3)), 3);
    const a = mk();
    a.PK = decPt(negY(P.mulG(99n)));
    await expectFailure(() => partial.witness(a), "Partial", "PK[1] === sG.out[1]");
    const b = mk();
    b.D[1] = decPt(negY(P.mul(C1all[1], 99n)));
    await expectFailure(() => partial.witness(b), "Partial", DY);
    const c = mk();
    c.D[9] = decPt(T2);
    await expectFailure(() => partial.witness(c), "Partial", DY);
  });

  test("inactive C1 (G.x, -G.y) fails the padding y row", async () => {
    const inp = partialInput(99n, padC1(C1all.slice(0, 3)), 3);
    inp.C1[12] = decPt(negY(P.G));
    await expectFailure(() => partial.witness(inp), "Partial", "(1 - act.out[k]) * (C1[k][1] - G[1]) === 0");
  });
});

describe("completeness: variable-base scalars at the 148-bit segment boundary, bases ±G", () => {
  const B = 1n << 148n;
  const scalars = [2n, 1n << 147n, B - 1n, B, B + 1n, (B << 1n) - 1n, 1n << 250n, P.R - B, P.R - 1n];

  test("partial: every boundary share over C1 = [G, -G, 14 request bases]", async () => {
    const C1 = [P.G, NEG_G, ...C1all.slice(0, 14)];
    for (const s of scalars) await satisfies(partial, partialInput(s, C1, 16));
  });

  test("deal: every boundary ephemeral over roster [G, -G, X3, X4]", async () => {
    for (const e of scalars) {
      await satisfies(deal, dealInput({ dealerIndex: 2, n: 4, t: 3, a: [7n, 8n, 9n], e, roster: [P.G, NEG_G, X[2], X[3]] }));
    }
  });
});

// Not circuit bugs: inputs outside the domain the contract admits (protocol.md §8.5 and §10.1:
// non-identity, prime-subgroup roster keys and C1). They pass here and document that those
// contract checks are load-bearing; dropping any of them turns the case into a live attack.
describe("preconditions the circuits rely on (accepted out-of-domain inputs)", () => {
  test("T8 has order 8", () => {
    assert.ok(P.onCurve(T8));
    assert.ok(P.eqPoint(P.mul(T8, 8n), P.O) && !P.eqPoint(P.mul(T8, 4n), P.O));
  });

  test("deal: an active roster key with x = 0 (O or (0, -1)) is accepted with S = O, a public mask", async () => {
    const base = { dealerIndex: 1, n: 3, t: 2, a: [11n, 13n], e: 17n };
    for (const bad of [P.O, T2]) {
      const inp = dealInput({ ...base, roster: [X[0], bad, X[2]] });
      // the circuit substitutes the base and forces S = O; 17·(0, -1) is (0, -1), not O
      inp.masked[1] = P.dec((P.evalPoly(base.a, 2n) + P.maskOf(sc.ctx, 1, 2, P.O)) % P.P);
      await satisfies(deal, inp);
    }
  });

  test("partial: C1 = (0, -1) is accepted with D = O although s·C1 = (0, -1) for odd s", async () => {
    const inp = partialInput(99n, padC1([C1all[0], T2]), 2);
    assert.ok(P.eqPoint(P.mul(T2, 99n), T2));
    inp.D[1] = decPt(P.O);
    await satisfies(partial, inp);
  });

  test("partial: an 8-torsion-shifted C1 is proven, so D leaks s mod 8", async () => {
    await satisfies(partial, partialInput(99n, padC1([C1all[0], P.pointAdd(C1all[1], T8)]), 2));
  });
});
