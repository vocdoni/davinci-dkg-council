// Computes circuitReleaseId (protocol §4.4) from the byte-exact vkey files and writes
// build/release.json; copies the vkeys and the manifest to release/ (committed).
import { copyFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { BUILD, ROOT, shutdown } from "../src/harness.ts";
import { releaseManifest } from "./release-manifest.ts";

const RELEASE = join(ROOT, "release");
const file = (name: string) => join(BUILD, name);

const release = await releaseManifest(BUILD, {
  tag: "circuits-v1",
  // Honest provenance of the pinned circuits-v1: the phase-1 file was generated locally (its
  // sha256 is recorded below), not the Hermez/PPoT ceremony output. Keep any retagging honest too.
  setup:
    "DEVELOPMENT: phase 1 from a locally generated 2^18 ptau (toolchain.ptauSha256 below, not the " +
    "Hermez/PPoT file) and phase 2 one local snarkjs contribution + beacon. NOT FOR PRODUCTION: " +
    "production releases must start from the Hermez/PPoT powersOfTau28_hez_final_18.ptau and run a " +
    "multi-party phase 2.",
  // The phase-1 file the setup started from (build.sh passes its path).
  ptauFile: process.env.COUNCIL_PTAU_FILE,
});
writeFileSync(file("release.json"), JSON.stringify(release, null, 2) + "\n");
mkdirSync(RELEASE, { recursive: true });
copyFileSync(file("release.json"), join(RELEASE, "release.json"));
copyFileSync(file("deal_vkey.json"), join(RELEASE, "deal_vkey.json"));
copyFileSync(file("partial_vkey.json"), join(RELEASE, "partial_vkey.json"));
console.log(`circuitReleaseId ${release.circuitReleaseId}`);
console.log(`deal: ${release.deal.constraints} constraints; partial: ${release.partial.constraints} constraints`);
await shutdown();
