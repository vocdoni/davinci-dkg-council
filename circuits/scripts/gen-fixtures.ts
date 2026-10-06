// Canned Groth16 proofs for the Foundry tests, built from the vectors' scenarios with the
// compiled DEV artifacts in build/ (run build.sh first). Proof words follow snarkjs
// exportSolidityCallData (protocol §7.2). Proofs are randomized: regenerate after every setup.
//
//   fixtures/deal_A.json     scenario A (n=3, t=2): dealings of QUAL = {1, 3}
//   fixtures/deal_B.json     scenario B (n=16, t=16): all 16 dealings
//   fixtures/partial_A.json  scenario A request (3 fields): partials of members 1..3
//   fixtures/partial_B.json  scenario B request (16 fields): partials of members 1..16
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import type { Hex } from "viem";
import * as P from "../src/protocol.ts";
import * as S from "../src/scenario.ts";
import { BUILD, Circuit, ROOT, shutdown } from "../src/harness.ts";

const OUT = join(ROOT, "fixtures");
const release = JSON.parse(readFileSync(join(BUILD, "release.json"), "utf8"));
const only = process.argv[2]; // optional scenario filter, e.g. "A"

const dec = (x: bigint) => x.toString(10);
const pt = (p: P.Point) => [dec(p[0]), dec(p[1])];

async function callDataWords(proof: unknown, pub: string[]) {
  const raw = (await snarkjs.groth16.exportSolidityCallData(proof as never, pub)) as string;
  const [pA, pB, pC, pubSignals] = JSON.parse(`[${raw}]`) as [string[], string[][], string[], string[]];
  const words = {
    pA: pA.map((x) => dec(BigInt(x))),
    pB: pB.map((r) => r.map((x) => dec(BigInt(x)))),
    pC: pC.map((x) => dec(BigInt(x))),
  };
  const ours = P.proofWords(proof as never);
  const same =
    words.pA.every((x, i) => BigInt(x) === ours.pA[i]) &&
    words.pB.every((r, i) => r.every((x, j) => BigInt(x) === ours.pB[i][j])) &&
    words.pC.every((x, i) => BigInt(x) === ours.pC[i]);
  if (!same) throw new Error("exportSolidityCallData order differs from protocol §7.2");
  if (pubSignals.length !== pub.length || pubSignals.some((x, i) => BigInt(x) !== BigInt(pub[i])))
    throw new Error("calldata public signals differ");
  return { words, ours };
}

function header(sc: S.Scenario) {
  return {
    setup: release.setup,
    circuitReleaseIdOfArtifacts: release.circuitReleaseId,
    scenario: sc.spec.name,
    chainId: dec(S.CHAIN_ID),
    manager: S.MANAGER,
    ceremonyId: sc.ceremonyId,
    circuitReleaseIdInCtx: sc.circuitReleaseId,
    rosterHash: sc.rosterHash,
    ctx: sc.ctx,
    t: sc.spec.t,
    n: sc.spec.n,
    validUntil: dec(S.VALID_UNTIL),
  };
}

async function dealFixtures(sc: S.Scenario, circuit: Circuit) {
  const vkSha = release.deal.vkey.sha256 as Hex;
  const dealings = [];
  for (const { dealing: d } of sc.dealings) {
    const input = P.dealWitnessInput(
      sc.ctx,
      d,
      sc.members.map((m) => m.X),
    );
    const expected = P.dealPublicInputs(input);
    const t0 = performance.now();
    const { proof, publicSignals } = await circuit.prove(input);
    const ms = performance.now() - t0;
    if (publicSignals.length !== 87 || publicSignals.some((x: string, i: number) => x !== expected[i]))
      throw new Error("deal public signals differ from protocol §8.5 order");
    if (!(await circuit.verify(publicSignals, proof))) throw new Error("deal proof does not verify");
    const { words, ours } = await callDataWords(proof, publicSignals);
    const payloadHash = P.dealPayloadHash(sc.ctx, d.C, d.E, d.masked, ours);
    const message = { ceremonyId: sc.ceremonyId, dealerIndex: d.dealerIndex, payloadHash, validUntil: S.VALID_UNTIL };
    const sig = await P.signAction(S.CHAIN_ID, S.MANAGER, "Deal", message, sc.members[d.dealerIndex - 1].auth.value);
    console.log(`deal ${sc.spec.name}/${d.dealerIndex}: proved in ${ms.toFixed(0)} ms`);
    dealings.push({
      dealerIndex: d.dealerIndex,
      authAddress: sc.members[d.dealerIndex - 1].authAddress,
      C: d.C.map(pt),
      E: pt(d.E),
      masked: d.masked.map(dec),
      proof: words,
      pubSignals: publicSignals,
      payloadHash,
      deal: { message: { ...message, validUntil: dec(S.VALID_UNTIL) }, digest: sig.digest, signature: sig.signature },
    });
  }
  return { circuit: "deal", vkeySha256: vkSha, ...header(sc), qual: sc.spec.qual, dealings };
}

async function partialFixtures(sc: S.Scenario, circuit: Circuit) {
  const vkSha = release.partial.vkey.sha256 as Hex;
  const C1 = sc.cts.map((c) => c.C1);
  const partials = [];
  for (const m of sc.members) {
    const input = P.partialWitnessInput(sc.memberKeys[m.index - 1], sc.shares[m.index - 1], C1);
    const expected = P.partialPublicInputs(input);
    const t0 = performance.now();
    const { proof, publicSignals } = await circuit.prove(input);
    const ms = performance.now() - t0;
    if (publicSignals.length !== 67 || publicSignals.some((x: string, i: number) => x !== expected[i]))
      throw new Error("partial public signals differ from protocol §10.1 order");
    if (!(await circuit.verify(publicSignals, proof))) throw new Error("partial proof does not verify");
    const { words, ours } = await callDataWords(proof, publicSignals);
    const D = input.D.map((d) => [BigInt(d[0]), BigInt(d[1])] as P.Point);
    const payloadHash = P.partialPayloadHash(sc.requestId, D, ours);
    const message = {
      ceremonyId: sc.ceremonyId,
      requestId: sc.requestId,
      participantIndex: m.index,
      payloadHash,
      validUntil: S.VALID_UNTIL,
    };
    const sig = await P.signAction(S.CHAIN_ID, S.MANAGER, "Partial", message, m.auth.value);
    console.log(`partial ${sc.spec.name}/${m.index}: proved in ${ms.toFixed(0)} ms`);
    partials.push({
      participantIndex: m.index,
      authAddress: m.authAddress,
      PK: input.PK,
      D: input.D,
      proof: words,
      pubSignals: publicSignals,
      payloadHash,
      partial: { message: { ...message, validUntil: dec(S.VALID_UNTIL) }, digest: sig.digest, signature: sig.signature },
    });
  }
  return {
    circuit: "partial",
    vkeySha256: vkSha,
    ...header(sc),
    request: {
      adapter: S.ADAPTER,
      processId: sc.processId,
      requestId: sc.requestId,
      fieldCount: sc.cts.length,
      cts: sc.cts.map((c) => [...pt(c.C1), ...pt(c.C2)]),
      plaintexts: sc.spec.plaintexts.map(dec),
    },
    publicKey: pt(sc.publicKey),
    partials,
  };
}

mkdirSync(OUT, { recursive: true });
const deal = new Circuit("deal");
const partial = new Circuit("partial");
for (const spec of S.SPECS) {
  if (only && spec.name !== only) continue;
  const sc = S.buildScenario(spec);
  const df = await dealFixtures(sc, deal);
  writeFileSync(join(OUT, `deal_${spec.name}.json`), JSON.stringify(df, null, 2) + "\n");
  const pf = await partialFixtures(sc, partial);
  writeFileSync(join(OUT, `partial_${spec.name}.json`), JSON.stringify(pf, null, 2) + "\n");
}
await shutdown();
