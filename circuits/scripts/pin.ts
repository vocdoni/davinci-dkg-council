// Re-pins the SDK and the deployment to the circuit release in circuits/release/release.json
// (written by build.sh) and to the verifiers compiled from it (solidity/out, after `forge build`):
//   - sdk/src/artifacts.ts: release tag, download base URL, the sha256 of the six files and the
//     circuitReleaseId comment;
//   - solidity/script/CouncilRelease.sol: tag, DEVELOPMENT_SETUP (release.json "developmentSetup",
//     absent = true: build.sh's single-party setups never write it; the multi-party ceremony writes
//     false), both vkey sha256s, circuitReleaseId and the runtime code hash (EXTCODEHASH) of both
//     generated verifiers.
// `make circuits` runs it between build.sh and the proof fixtures; the ceremony's `install` step
// runs it after copying a ceremony release in. It never touches the vectors. COUNCIL_REPO_ROOT
// points it at another checkout (the ceremony dry run re-pins a scratch copy, never this one).
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { keccak256, type Hex } from "viem";

const REPO = process.env.COUNCIL_REPO_ROOT || join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOT = join(REPO, "circuits");
const ARTIFACTS_TS = join(REPO, "sdk", "src", "artifacts.ts");
const RELEASE_SOL = join(REPO, "solidity", "script", "CouncilRelease.sol");
const RELEASES = "https://github.com/vocdoni/davinci-dkg-council/releases/download";

interface FilePin {
  file: string;
  sha256: Hex;
}
interface Release {
  tag: string;
  developmentSetup?: boolean;
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
ts = replaceOne(
  ts,
  /(\)\.\n)( \* NOTE: [^\n]*\n)( \* [^\n]*\n)*? \*\//,
  (release.developmentSetup ?? true)
    ? ' * NOTE: this is the DEVELOPMENT phase-2 setup ("one local snarkjs contribution\n' +
        ' * + beacon. NOT FOR PRODUCTION"); a production ceremony re-pins every hash.\n */'
    : " * NOTE: a multi-party phase-2 ceremony release (circuits/scripts/ceremony);\n" +
        ' * its transcript is release.json "ceremony".\n */',
  "artifacts.ts setup note",
);
// The SDK's trust flag (ArtifactsRelease.developmentSetup): what circuitReleaseStatus and the
// app's test-setup banner key off, so a production re-pin must flip it together with the pins
// (sdk/tests/unit-io.test.ts asserts it against release.json).
ts = replaceOne(
  ts,
  /(\n  developmentSetup: )(?:true|false)/,
  String(release.developmentSetup ?? true),
  "artifacts.ts developmentSetup",
);
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
const dev = release.developmentSetup ?? true;
sol = replaceOne(
  sol,
  /(\n)    \/\/\/ @dev [^\n]*\n    bool internal constant DEVELOPMENT_SETUP = (?:true|false);/,
  dev
    ? "    /// @dev DEVELOPMENT setup (one local contribution + beacon): not for production.\n" +
        "    bool internal constant DEVELOPMENT_SETUP = true;"
    : "    /// @dev Multi-party phase 2 (circuits/scripts/ceremony; transcript in release.json \"ceremony\").\n" +
        "    bool internal constant DEVELOPMENT_SETUP = false;",
  "CouncilRelease.DEVELOPMENT_SETUP",
);
constant("DEAL_VKEY_SHA256", release.deal.vkey.sha256);
constant("PARTIAL_VKEY_SHA256", release.partial.vkey.sha256);
constant("CIRCUIT_RELEASE_ID", release.circuitReleaseId);
constant("DEAL_VERIFIER_CODEHASH", codehash("DealVerifier"));
constant("PARTIAL_VERIFIER_CODEHASH", codehash("PartialVerifier"));
writeFileSync(RELEASE_SOL, sol);

console.log(
  `pinned ${release.tag} (${release.circuitReleaseId}, developmentSetup ${dev}) in sdk/src/artifacts.ts and ` +
    `CouncilRelease.sol under ${REPO}`,
);
