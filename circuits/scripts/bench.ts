// Proving-time benchmark with snarkjs in Node: witness generation + Groth16 prove for one deal
// (n = t = 16) and one partial (16 fields). Usage: tsx scripts/bench.ts [--single-thread] [runs]
import * as snarkjs from "snarkjs";
import * as P from "../src/protocol.ts";
import * as S from "../src/scenario.ts";
import { Circuit, shutdown } from "../src/harness.ts";

const singleThread = process.argv.includes("--single-thread");
const runs = Number(process.argv.find((a) => /^\d+$/.test(a)) ?? 3);
const sc = S.buildScenario(S.SPECS[1]);
const d = sc.dealings[0].dealing;
const dealInput = P.dealWitnessInput(
  sc.ctx,
  d,
  sc.members.map((m) => m.X),
);
const partialInput = P.partialWitnessInput(
  sc.memberKeys[0],
  sc.shares[0],
  sc.cts.map((c) => c.C1),
);

async function bench(c: Circuit, input: unknown) {
  const times: number[] = [];
  for (let i = 0; i < runs; i++) {
    const t0 = performance.now();
    await snarkjs.groth16.fullProve(input as never, c.wasm, c.zkey, undefined, undefined, { singleThread });
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  return { medianMs: Math.round(times[Math.floor(times.length / 2)]), allMs: times.map(Math.round) };
}

console.log(JSON.stringify({ singleThread, runs, deal: await bench(new Circuit("deal"), dealInput), partial: await bench(new Circuit("partial"), partialInput) }));
await shutdown();
