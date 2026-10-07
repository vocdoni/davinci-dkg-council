// pin.ts re-pins a scratch checkout from release.json: a production (multi-party) release must
// flip the SDK's developmentSetup flag and CouncilRelease.DEVELOPMENT_SETUP together with the
// pins, and a development release (flag absent) must flip them back. Uses only committed files
// plus synthetic verifier build outputs (no circuits/build needed).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { keccak256, type Hex } from "viem";
import { ROOT } from "../src/harness.ts";

const REPO = join(ROOT, "..");
const TSX = join(ROOT, "node_modules", ".bin", "tsx");
const FAKE_CODE: Hex = "0x60016001";

/** A scratch checkout with just what pin.ts reads and writes. */
function scratchRepo(releaseJson: Record<string, unknown>): string {
  const dir = mkdtempSync(join(tmpdir(), "council-pin-test-"));
  mkdirSync(join(dir, "circuits", "release"), { recursive: true });
  mkdirSync(join(dir, "sdk", "src"), { recursive: true });
  mkdirSync(join(dir, "solidity", "script"), { recursive: true });
  writeFileSync(join(dir, "circuits", "release", "release.json"), JSON.stringify(releaseJson, null, 2));
  cpSync(join(REPO, "sdk", "src", "artifacts.ts"), join(dir, "sdk", "src", "artifacts.ts"));
  cpSync(join(REPO, "solidity", "script", "CouncilRelease.sol"), join(dir, "solidity", "script", "CouncilRelease.sol"));
  for (const name of ["DealVerifier", "PartialVerifier"]) {
    const out = join(dir, "solidity", "out", `${name}.sol`);
    mkdirSync(out, { recursive: true });
    writeFileSync(join(out, `${name}.json`), JSON.stringify({ deployedBytecode: { object: FAKE_CODE } }));
  }
  return dir;
}

const pin = (repo: string) =>
  execFileSync(TSX, [join(ROOT, "scripts", "pin.ts")], { env: { ...process.env, COUNCIL_REPO_ROOT: repo }, encoding: "utf8" });

test("a ceremony re-pin flips the SDK developmentSetup flag and DEVELOPMENT_SETUP together with the pins", () => {
  const committed = JSON.parse(readFileSync(join(ROOT, "release", "release.json"), "utf8")) as Record<string, unknown>;
  const repo = scratchRepo({ ...committed, tag: "circuits-v2-test", developmentSetup: false });
  try {
    pin(repo);
    const ts = readFileSync(join(repo, "sdk", "src", "artifacts.ts"), "utf8");
    assert.match(ts, /\n {2}developmentSetup: false,\n/);
    assert.match(ts, /\n {2}release: 'circuits-v2-test',\n/);
    assert.match(ts, /releases\/download\/circuits-v2-test'/);
    assert.match(ts, /multi-party phase-2 ceremony release/);
    assert.doesNotMatch(ts, /NOT FOR PRODUCTION/);
    const sol = readFileSync(join(repo, "solidity", "script", "CouncilRelease.sol"), "utf8");
    assert.match(sol, /DEVELOPMENT_SETUP = false;/);
    assert.match(sol, /TAG = "circuits-v2-test"/);
    assert.match(sol, new RegExp(`DEAL_VERIFIER_CODEHASH =\\s*${keccak256(FAKE_CODE)}`));

    // A development release (flag absent, as build.sh writes it) flips everything back.
    writeFileSync(join(repo, "circuits", "release", "release.json"), JSON.stringify(committed, null, 2));
    pin(repo);
    const back = readFileSync(join(repo, "sdk", "src", "artifacts.ts"), "utf8");
    assert.match(back, /\n {2}developmentSetup: true,\n/);
    assert.match(back, /NOT FOR PRODUCTION/);
    assert.match(readFileSync(join(repo, "solidity", "script", "CouncilRelease.sol"), "utf8"), /DEVELOPMENT_SETUP = true;/);
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});
