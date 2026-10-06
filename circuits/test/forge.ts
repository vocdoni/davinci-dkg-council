// R1CS-level forging helpers for the adversarial suite: a malicious prover is not bound by the
// circom witness generator (`<--` hints, `assert`s), only by the optimized R1CS. These helpers edit
// a witness vector wire by wire and report exactly which constraints the edit violates.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Circuit } from "../src/harness.ts";
import { P as FIELD } from "../src/protocol.ts";

type Index = {
  byWire: number[][]; // wire -> constraints that reference it
  names: Map<number, string[]>; // wire -> every signal name the optimizer mapped onto it
};
const indexes = new WeakMap<Circuit, Index>();

async function index(c: Circuit): Promise<Index> {
  let ix = indexes.get(c);
  if (ix) return ix;
  const r = await c.r1cs();
  const byWire: number[][] = Array.from({ length: r.nVars }, () => []);
  r.constraints.forEach((con, ci) => {
    const seen = new Set<number>();
    for (const lc of con) for (const k of lc.keys()) seen.add(k);
    for (const k of seen) byWire[k].push(ci);
  });
  const names = new Map<number, string[]>();
  for (const line of readFileSync(join(c.dir, `${c.name}.sym`), "utf8").split("\n")) {
    if (!line) continue;
    const [, wit, , n] = line.split(",");
    const wi = Number(wit);
    if (wi < 0) continue;
    const list = names.get(wi) ?? [];
    list.push(n);
    names.set(wi, list);
  }
  ix = { byWire, names };
  indexes.set(c, ix);
  return ix;
}

const evalLc = (lc: Map<number, bigint>, w: bigint[]) => {
  let acc = 0n;
  for (const [i, k] of lc) acc += k * w[i];
  return acc % FIELD;
};

/** A mutable witness vector for one circuit. */
export class Forge {
  readonly c: Circuit;
  readonly w: bigint[];

  constructor(c: Circuit, w: bigint[]) {
    this.c = c;
    this.w = [...w];
  }

  /** Witness index of a signal that survived --O2 (throws if it was optimized away). */
  idx(name: string): number {
    const i = this.c.signal(name);
    if (i <= 0) throw new Error(`${name} has no witness wire after --O2`);
    return i;
  }

  get(name: string): bigint {
    return this.w[this.idx(name)];
  }

  set(name: string, v: bigint): this {
    this.w[this.idx(name)] = ((v % FIELD) + FIELD) % FIELD;
    return this;
  }

  /** Sets a public input and the wire of its dedicated `pubSq[row] <== x·x` row. */
  setPub(name: string, row: number, v: bigint): this {
    const x = ((v % FIELD) + FIELD) % FIELD;
    this.set(name, x);
    return this.set(`main.pubSq[${row}]`, (x * x) % FIELD);
  }

  /** Copies every wire whose signal names all start with one of `prefixes` from `other`. */
  async spliceFrom(other: bigint[], prefixes: string[]): Promise<number> {
    const { names } = await index(this.c);
    let n = 0;
    for (const [wire, list] of names) {
      if (list.every((nm) => prefixes.some((p) => nm.startsWith(p)))) {
        this.w[wire] = other[wire];
        n++;
      }
    }
    return n;
  }

  /** Every violated constraint, as the sorted, deduplicated signal names it references. */
  async violations(): Promise<string[][]> {
    const r = await this.c.r1cs();
    const { names } = await index(this.c);
    const out: string[][] = [];
    for (const [a, b, cc] of r.constraints) {
      if ((evalLc(a, this.w) * evalLc(b, this.w) - evalLc(cc, this.w)) % FIELD === 0n) continue;
      const wires = new Set<number>([...a.keys(), ...b.keys(), ...cc.keys()]);
      wires.delete(0);
      out.push([...wires].map((wi) => (names.get(wi) ?? [`#${wi}`])[0]).sort());
    }
    return out;
  }
}

/**
 * Wires that stay satisfying when perturbed alone: for every wire except the constant, each of
 * `deltas` is added and only the constraints referencing that wire are re-evaluated. A wire
 * listed here is not pinned by any of its own constraints (an under-constrained hint candidate).
 */
export async function locallyFreeWires(c: Circuit, w: bigint[], deltas = [1n, 2n, FIELD - 1n]): Promise<string[]> {
  const r = await c.r1cs();
  const { byWire, names } = await index(c);
  const ww = [...w];
  const ok = (ci: number) => {
    const [a, b, cc] = r.constraints[ci];
    return (evalLc(a, ww) * evalLc(b, ww) - evalLc(cc, ww)) % FIELD === 0n;
  };
  const free: string[] = [];
  for (let i = 1; i < r.nVars; i++) {
    const old = ww[i];
    for (const d of deltas) {
      ww[i] = (old + d) % FIELD;
      const still = byWire[i].every(ok);
      ww[i] = old;
      if (still) {
        free.push((names.get(i) ?? [`#${i}`])[0]);
        break;
      }
    }
  }
  return free;
}
