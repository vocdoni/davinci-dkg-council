// Shared helpers for the circuit tests.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import * as P from "../src/protocol.ts";
import { BUILD, ROOT } from "../src/harness.ts";

export const CIRCOM = process.env.CIRCOM ?? join(process.env.HOME ?? "", ".local/bin/circom");
const CIRCOMLIB = join(ROOT, "node_modules/circomlib/circuits");

const SOURCES = [
  join(ROOT, "deal.circom"),
  join(ROOT, "partial.circom"),
  join(ROOT, "lib/gadgets.circom"),
  ...readdirSync(CIRCOMLIB)
    .filter((f) => f.endsWith(".circom"))
    .map((f) => join(CIRCOMLIB, f)),
];

/** Source line of the innermost failed assertion reported by the circom witness generator. */
export function failureLocation(err: unknown): { template: string; file: string; line: number; source: string } {
  const msg = String(err);
  const m = /Error in template (\w+?)_\d+ line: (\d+)/.exec(msg);
  if (!m) throw new Error(`not a circom assertion failure: ${msg}`);
  const template = m[1];
  const line = Number(m[2]);
  const file = SOURCES.find((f) => new RegExp(`template\\s+${template}\\s*\\(`).test(readFileSync(f, "utf8")));
  if (!file) throw new Error(`template ${template} not found`);
  return { template, file, line, source: readFileSync(file, "utf8").split("\n")[line - 1].trim() };
}

/** Asserts that witness generation fails at an assertion whose source line contains `snippet`. */
export async function expectFailure(
  run: () => Promise<unknown>,
  template: string,
  snippet: string,
): Promise<void> {
  let err: unknown;
  try {
    await run();
  } catch (e) {
    err = e;
  }
  assert.ok(err, `expected witness generation to fail in ${template} at "${snippet}"`);
  const loc = failureLocation(err);
  assert.equal(loc.template, template, `failed in ${loc.template} at "${loc.source}"`);
  assert.ok(loc.source.includes(snippet), `failed at "${loc.source}", expected "${snippet}"`);
}

/** Compiles a test-only circuit from test/circuits into build/test (wasm + r1cs + sym). */
export function compileTestCircuit(name: string): string {
  const out = join(BUILD, "test");
  mkdirSync(out, { recursive: true });
  const src = join(ROOT, "test/circuits", `${name}.circom`);
  if (!existsSync(join(out, `${name}_js`, `${name}.wasm`)) || process.env.RECOMPILE) {
    execFileSync(CIRCOM, [src, "--r1cs", "--wasm", "--sym", "--O2", "-l", join(ROOT, "node_modules"), "-o", out], {
      stdio: "pipe",
    });
  }
  return out;
}

/** Coefficients a_0..a_{t-1} of the unique degree < t polynomial with f(m) = ys[m-1], m = 1..t. */
export function interpolate(ys: bigint[]): bigint[] {
  const t = ys.length;
  const coeffs = Array<bigint>(t).fill(0n);
  for (let i = 0; i < t; i++) {
    const xi = BigInt(i + 1);
    let basis = [1n]; // Π_{j != i} (z - x_j)
    let den = 1n;
    for (let j = 0; j < t; j++) {
      if (j === i) continue;
      const xj = BigInt(j + 1);
      const next = Array<bigint>(basis.length + 1).fill(0n);
      basis.forEach((c, k) => {
        next[k + 1] = (next[k + 1] + c) % P.R;
        next[k] = P.mod(next[k] - c * xj, P.R);
      });
      basis = next;
      den = P.mod(den * (xi - xj), P.R);
    }
    const scale = (ys[i] * P.invMod(den, P.R)) % P.R;
    basis.forEach((c, k) => (coeffs[k] = (coeffs[k] + c * scale) % P.R));
  }
  for (let m = 1; m <= t; m++) assert.equal(P.evalPoly(coeffs, BigInt(m)), ys[m - 1] % P.R);
  return coeffs;
}

export const EXCEPTIONAL = (() => {
  const Q = (1n << 250n) + ((1n << 249n) - 1n) / 7n;
  const s = P.R - Q;
  return [s, s + (1n << 249n), s + (1n << 250n)];
})();

export const clone = <T>(x: T): T => structuredClone(x);
export const decPt = (p: P.Point): string[] => [P.dec(p[0]), P.dec(p[1])];
export const ptOf = (a: string[]): P.Point => [BigInt(a[0]), BigInt(a[1])];
