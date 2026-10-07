// The release manifest (release.json) of a circuits build directory: constraint counts, the
// sha256 and size of the six released files plus the r1cs, and the circuitReleaseId (protocol
// §4.4) derived from the byte-exact vkey files. Shared by release.ts (a DEV setup from build.sh)
// and the multi-party ceremony (scripts/ceremony/ceremony.ts), so both describe the files alike.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as snarkjs from "snarkjs";
import { circuitReleaseIdOf, sha256Hex } from "../src/protocol.ts";

const digest = (path: string) => ({ sha256: sha256Hex(readFileSync(path)), bytes: statSync(path).size });

async function circuit(build: string, c: "deal" | "partial") {
  const file = (name: string) => join(build, name);
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

export interface ManifestOptions {
  tag: string;
  /** Human-readable provenance of the setup. */
  setup: string;
  /** The phase-1 file the setup started from (its sha256 is recorded), if known. */
  ptauFile?: string;
  /** Written only when given: build.sh's DEV releases omit it (pin.ts reads a missing flag as true). */
  developmentSetup?: boolean;
  /** Ceremony summary, written between toolchain and circuitReleaseId when given. */
  ceremony?: unknown;
}

export async function releaseManifest(build: string, o: ManifestOptions) {
  const deal = await circuit(build, "deal");
  const partial = await circuit(build, "partial");
  if (deal.publicInputs !== 87 || partial.publicInputs !== 67 || deal.publicOutputs + partial.publicOutputs !== 0)
    throw new Error("public input counts differ from protocol §8.5/§10.1");
  return {
    tag: o.tag,
    setup: o.setup,
    ...(o.developmentSetup === undefined ? {} : { developmentSetup: o.developmentSetup }),
    toolchain: {
      circom: "2.2.3",
      circomlib: "2.0.5",
      snarkjs: "0.7.6",
      ptauPower: 18,
      ptauSha256: o.ptauFile ? sha256Hex(readFileSync(o.ptauFile)) : null,
    },
    ...(o.ceremony === undefined ? {} : { ceremony: o.ceremony }),
    circuitReleaseId: circuitReleaseIdOf(deal.vkey.sha256, partial.vkey.sha256),
    deal,
    partial,
  };
}
