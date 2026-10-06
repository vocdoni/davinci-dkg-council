// Re-pins the SDK and the deployment to the circuit release in circuits/release/release.json
// (written by build.sh) and to the verifiers compiled from it (solidity/out, after `forge build`):
//   - sdk/src/artifacts.ts: release tag, download base URL, the sha256 of the six files and the
//     circuitReleaseId comment;
//   - solidity/script/CouncilRelease.sol: tag, both vkey sha256s, circuitReleaseId and the
//     runtime code hash (EXTCODEHASH) of both generated verifiers.
// `make circuits` runs it between build.sh and the proof fixtures. It never touches the vectors.
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, type Hex } from "viem";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = join(ROOT, "..");
const ARTIFACTS_TS = join(REPO, "sdk", "src", "artifacts.ts");
const RELEASE_SOL = join(REPO, "solidity", "script", "CouncilRelease.sol");
const RELEASES = "https://github.com/vocdoni/davinci-dkg-council/releases/download";

interface FilePin {
  file: string;
  sha256: Hex;
}
interface Release {
  tag: string;
  circuitReleaseId: Hex;
  deal: Record<"wasm" | "zkey" | "vkey", FilePin>;
  partial: Record<"wasm" | "zkey" | "vkey", FilePin>;
}

const release = JSON.parse(readFileSync(join(ROOT, "release", "release.json"), "utf8")) as Release;

function codehash(name: string): Hex {
  const path = join(REPO, "solidity", "out", `${name}.sol`, `${name}.json`);
  const artifact = JSON.parse(readFileSync(path, "utf8")) as { deployedBytecode: { object: Hex } };
  return keccak256(artifact.deployedBytecode.object);
}

/** Replace the single match of `re` (whose last group is the value) or fail loudly. */
function replaceOne(text: string, re: RegExp, value: string, what: string): string {
  const matches = text.match(new RegExp(re.source, `${re.flags}g`));
  if (matches?.length !== 1) throw new Error(`${what}: expected one match of ${re}, found ${matches?.length ?? 0}`);
  return text.replace(re, (...m) => (m[1] as string) + value);
}

let ts = readFileSync(ARTIFACTS_TS, "utf8");
ts = replaceOne(ts, /(const BASE = ')[^']*/, `${RELEASES}/${release.tag}`, "artifacts.ts BASE");
ts = replaceOne(ts, /(\n  release: ')[^']*/, release.tag, "artifacts.ts release");
ts = replaceOne(ts, /(\(circuitReleaseId )0x[0-9a-f]{64}/, release.circuitReleaseId, "artifacts.ts release id");
for (const circuit of ["deal", "partial"] as const) {
  for (const kind of ["wasm", "zkey", "vkey"] as const) {
    const pin = release[circuit][kind];
    const re = new RegExp(`(\\$\\{BASE\\}/${pin.file.replace(".", "\\.")}\`,\\s*sha256: ')0x[0-9a-f]{64}`);
    ts = replaceOne(ts, re, pin.sha256, `artifacts.ts ${pin.file}`);
  }
}
writeFileSync(ARTIFACTS_TS, ts);

let sol = readFileSync(RELEASE_SOL, "utf8");
const constant = (name: string, value: string) => {
  sol = replaceOne(sol, new RegExp(`(${name} =\\s*)0x[0-9a-f]{64}`), value, `CouncilRelease.${name}`);
};
sol = replaceOne(sol, /(string internal constant TAG = ")[^"]*/, release.tag, "CouncilRelease.TAG");
constant("DEAL_VKEY_SHA256", release.deal.vkey.sha256);
constant("PARTIAL_VKEY_SHA256", release.partial.vkey.sha256);
constant("CIRCUIT_RELEASE_ID", release.circuitReleaseId);
constant("DEAL_VERIFIER_CODEHASH", codehash("DealVerifier"));
constant("PARTIAL_VERIFIER_CODEHASH", codehash("PartialVerifier"));
writeFileSync(RELEASE_SOL, sol);

console.log(`pinned ${release.tag} (${release.circuitReleaseId}) in sdk/src/artifacts.ts and CouncilRelease.sol`);
