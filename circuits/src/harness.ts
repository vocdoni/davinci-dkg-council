// Witness generation, in-memory R1CS evaluation and signal lookup for the circuit tests and the
// fixture generator. Reads the compiled artifacts under build/ (restore the pinned release with
// `make circuits-restore` from the repository root, or run build.sh for a new dev setup).
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import * as snarkjs from "snarkjs";
import { P as FIELD } from "./protocol.ts";

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BUILD = join(ROOT, "build");
const require = createRequire(import.meta.url);

export type CircuitName = "deal" | "partial";

type Constraint = [Map<number, bigint>, Map<number, bigint>, Map<number, bigint>];

export type R1cs = {
  nVars: number;
  nOutputs: number;
  nPubInputs: number;
  nPrvInputs: number;
  nConstraints: number;
  constraints: Constraint[];
};

type WitnessCalculator = { calculateWitness(input: unknown, sanityCheck: boolean): Promise<bigint[]> };

export class Circuit {
  readonly name: string;
  readonly dir: string;
  readonly wasm: string;
  readonly zkey: string;
  readonly vkey: string;
  private wc?: WitnessCalculator;
  private r1csCache?: R1cs;
  private symCache?: Map<string, number>;

  constructor(name: CircuitName | string, dir = BUILD) {
    this.name = name;
    this.dir = dir;
    this.wasm = join(dir, `${name}_js`, `${name}.wasm`);
    this.zkey = join(dir, `${name}_final.zkey`);
    this.vkey = join(dir, `${name}_vkey.json`);
    if (!existsSync(this.wasm))
      throw new Error(
        `${this.wasm} missing: run 'make circuits-restore' from the repository root to restore the pinned ` +
          `release, or 'bash build.sh' for a new dev setup (random phase-2 that re-pins the vkeys, ` +
          `verifiers, circuitReleaseId and fixtures)`,
      );
  }

  async calculator(): Promise<WitnessCalculator> {
    if (!this.wc) {
      const builder = require(join(this.dir, `${this.name}_js`, "witness_calculator.js"));
      this.wc = (await builder(readFileSync(this.wasm))) as WitnessCalculator;
    }
    return this.wc;
  }

  /**
   * Runs the circom witness generator; throws on any failed `===` / `<==` assertion. The
   * generated calculator accumulates assertion traces across calls on one instance, so only the
   * part produced by this call is kept in the thrown message.
   */
  async witness(input: unknown): Promise<bigint[]> {
    const calc = await this.calculator();
    try {
      return await calc.calculateWitness(input, true);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      const nl = msg.indexOf("\n");
      const kind = nl < 0 ? msg : msg.slice(0, nl + 1);
      const trace = nl < 0 ? "" : msg.slice(nl + 1);
      const fresh = trace.startsWith(this.traceSeen) ? trace.slice(this.traceSeen.length) : trace;
      this.traceSeen = trace;
      throw new Error(kind + fresh);
    }
  }

  private traceSeen = "";

  async r1cs(): Promise<R1cs> {
    if (!this.r1csCache) {
      const json = (await snarkjs.r1cs.exportJson(join(this.dir, `${this.name}.r1cs`), undefined)) as {
        nVars: number;
        nOutputs: number;
        nPubInputs: number;
        nPrvInputs: number;
        nConstraints: number;
        constraints: Record<string, string>[][];
      };
      const toMap = (lc: Record<string, string>) => new Map(Object.entries(lc).map(([k, v]) => [Number(k), BigInt(v)]));
      this.r1csCache = {
        nVars: json.nVars,
        nOutputs: json.nOutputs,
        nPubInputs: json.nPubInputs,
        nPrvInputs: json.nPrvInputs,
        nConstraints: json.nConstraints,
        constraints: json.constraints.map((c) => [toMap(c[0]), toMap(c[1]), toMap(c[2])] as Constraint),
      };
    }
    return this.r1csCache;
  }

  /** Index of the first violated constraint, or -1 when the witness satisfies the R1CS. */
  async firstViolation(w: bigint[]): Promise<number> {
    const r = await this.r1cs();
    if (w.length !== r.nVars) throw new Error(`witness has ${w.length} wires, r1cs ${r.nVars}`);
    const ev = (lc: Map<number, bigint>) => {
      let acc = 0n;
      for (const [i, c] of lc) acc += c * w[i];
      return acc % FIELD;
    };
    for (let i = 0; i < r.constraints.length; i++) {
      const [a, b, c] = r.constraints[i];
      if ((ev(a) * ev(b) - ev(c)) % FIELD !== 0n) return i;
    }
    return -1;
  }

  /** Witness index of a signal name ("main.u.out[3]"), -1 if the optimizer removed it. */
  signal(name: string): number {
    if (!this.symCache) {
      this.symCache = new Map();
      for (const line of readFileSync(join(this.dir, `${this.name}.sym`), "utf8").split("\n")) {
        if (!line) continue;
        const [, wit, , n] = line.split(",");
        this.symCache.set(n, Number(wit));
      }
    }
    const idx = this.symCache.get(name);
    if (idx === undefined) throw new Error(`unknown signal ${name}`);
    return idx;
  }

  async prove(input: unknown) {
    return snarkjs.groth16.fullProve(input as never, this.wasm, this.zkey);
  }

  async verify(publicSignals: string[], proof: unknown): Promise<boolean> {
    const vk = JSON.parse(readFileSync(this.vkey, "utf8"));
    return snarkjs.groth16.verify(vk, publicSignals, proof as never);
  }
}

/** snarkjs keeps worker threads alive; call at the end of scripts. */
export async function shutdown() {
  const g = globalThis as { curve_bn128?: { terminate(): Promise<void> } };
  if (g.curve_bn128) await g.curve_bn128.terminate();
}
