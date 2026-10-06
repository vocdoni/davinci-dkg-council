// Computes circuitReleaseId (protocol §4.4) from the byte-exact vkey files and writes
// build/release.json; copies the vkeys and the manifest to release/ (committed).
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import { circuitReleaseIdOf, sha256Hex } from "../src/protocol.ts";
import { BUILD, ROOT, shutdown } from "../src/harness.ts";

const RELEASE = join(ROOT, "release");
const file = (name: string) => join(BUILD, name);
const digest = (path: string) => ({ sha256: sha256Hex(readFileSync(path)), bytes: statSync(path).size });

async function circuit(c: "deal" | "partial") {
  const info = (await snarkjs.r1cs.info(file(`${c}.r1cs`), undefined)) as {
    nConstraints: number;
    nPubInputs: number;
    nPrvInputs: number;
    nOutputs: number;
    nVars: number;
  };
  return {
    constraints: info.nConstraints,
    publicInputs: info.nPubInputs,
    publicOutputs: info.nOutputs,
    privateInputs: info.nPrvInputs,
    wires: info.nVars,
    wasm: { file: `${c}.wasm`, ...digest(file(`${c}_js/${c}.wasm`)) },
    zkey: { file: `${c}_final.zkey`, ...digest(file(`${c}_final.zkey`)) },
    vkey: { file: `${c}_vkey.json`, ...digest(file(`${c}_vkey.json`)) },
    r1cs: { file: `${c}.r1cs`, ...digest(file(`${c}.r1cs`)) },
  };
}

const deal = await circuit("deal");
const partial = await circuit("partial");
if (deal.publicInputs !== 87 || partial.publicInputs !== 67 || deal.publicOutputs + partial.publicOutputs !== 0)
  throw new Error("public input counts differ from protocol §8.5/§10.1");

const release = {
  tag: "circuits-v1",
  // Honest provenance of the pinned circuits-v1: the phase-1 file was generated locally (its
  // sha256 is recorded below), not the Hermez/PPoT ceremony output. Keep any retagging honest too.
  setup:
    "DEVELOPMENT: phase 1 from a locally generated 2^18 ptau (toolchain.ptauSha256 below, not the " +
    "Hermez/PPoT file) and phase 2 one local snarkjs contribution + beacon. NOT FOR PRODUCTION: " +
    "production releases must start from the Hermez/PPoT powersOfTau28_hez_final_18.ptau and run a " +
    "multi-party phase 2.",
  toolchain: {
    circom: "2.2.3",
    circomlib: "2.0.5",
    snarkjs: "0.7.6",
    ptauPower: 18,
    // The phase-1 file the setup started from (build.sh passes its path).
    ptauSha256: process.env.COUNCIL_PTAU_FILE ? sha256Hex(readFileSync(process.env.COUNCIL_PTAU_FILE)) : null,
  },
  circuitReleaseId: circuitReleaseIdOf(deal.vkey.sha256, partial.vkey.sha256),
  deal,
  partial,
};
writeFileSync(file("release.json"), JSON.stringify(release, null, 2) + "\n");
mkdirSync(RELEASE, { recursive: true });
copyFileSync(file("release.json"), join(RELEASE, "release.json"));
copyFileSync(file("deal_vkey.json"), join(RELEASE, "deal_vkey.json"));
copyFileSync(file("partial_vkey.json"), join(RELEASE, "partial_vkey.json"));
console.log(`circuitReleaseId ${release.circuitReleaseId}`);
console.log(`deal: ${deal.constraints} constraints; partial: ${partial.constraints} constraints`);
await shutdown();
