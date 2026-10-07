#!/usr/bin/env bash
# CI entry point for the headless e2e suite (the e2e job of .github/workflows/main.yml, run on
# demand). Runs from the repository root.
#
# The suite's global setup hard-pins the released circuit setup: every file in
# $COUNCIL_ARTIFACTS_DIR is sha256-verified against sdk/src/artifacts.ts, and the deployed
# manager enforces the circuitReleaseId and verifier codehashes pinned in
# solidity/script/CouncilRelease.sol. A freshly regenerated dev phase-2 (circuits/build.sh,
# random contribution entropy) can never match those pins, so:
#   1. use the files already in $COUNCIL_ARTIFACTS_DIR when they verify;
#   2. else download the pinned release named in circuits/release/release.json, from the
#      DAVINCI CDN first and the GitHub release second;
#   3. else skip the suite with a notice instead of failing the run (the release is not
#      published yet).
#
# The DAVINCI round trip (tests/davinci.test.ts) needs the davinci-contracts and davinci-sdk
# sibling checkouts (DAVINCI_CONTRACTS_DIR / DAVINCI_SDK_DIR) on their `council` branches, which
# CI does not have, so that file is excluded.
set -euo pipefail

cd "$(dirname "$0")/.."

artifacts_dir=${COUNCIL_ARTIFACTS_DIR:?set COUNCIL_ARTIFACTS_DIR}
tag=$(node -e 'console.log(require("./circuits/release/release.json").tag)')
pin() { node -e 'const r=require("./circuits/release/release.json");console.log(r[process.argv[1]][process.argv[2]].sha256)' "$1" "$2"; }

# file:circuit:kind, the six artifacts devCircuitRelease() verifies against the SDK pins.
entries=(
  deal.wasm:deal:wasm
  deal_final.zkey:deal:zkey
  deal_vkey.json:deal:vkey
  partial.wasm:partial:wasm
  partial_final.zkey:partial:zkey
  partial_vkey.json:partial:vkey
)

verify_all() {
  local entry file circuit kind want got
  for entry in "${entries[@]}"; do
    file=${entry%%:*}
    circuit=${entry#*:}
    circuit=${circuit%%:*}
    kind=${entry##*:}
    [[ -f $artifacts_dir/$file ]] || return 1
    want=$(pin "$circuit" "$kind")
    want=${want#0x}
    got=$(sha256sum "$artifacts_dir/$file" | cut -d' ' -f1)
    [[ $got == "$want" ]] || return 1
  done
}

mkdir -p "$artifacts_dir"

if verify_all; then
  echo "circuit artifacts in $artifacts_dir match the pins"
else
  cdn="https://davinci-assets.fra1.cdn.digitaloceanspaces.com/council/$tag"
  base="https://github.com/vocdoni/davinci-dkg-council/releases/download/$tag"
  echo "staged artifacts do not match the pins; fetching the $tag release"
  # The CDN first; then the release, which may be private: `gh` with the job's token when
  # available, else its plain URL. verify_all checks whatever arrived against the pins.
  fetch() {
    curl -fsSL --retry 2 -o "$artifacts_dir/$1" "$cdn/$1" && return 0
    if [[ -n ${GH_TOKEN:-} ]] && command -v gh >/dev/null; then
      gh release download "$tag" -R "${GITHUB_REPOSITORY:-vocdoni/davinci-dkg-council}" -p "$1" -D "$artifacts_dir" --clobber
    else
      curl -fsSL -o "$artifacts_dir/$1" "$base/$1"
    fi
  }
  if ! { for entry in "${entries[@]}"; do fetch "${entry%%:*}"; done; } || ! verify_all; then
    echo "::notice::skipping the council e2e suite: the pinned circuit artifacts ($tag) are unavailable, and a fresh dev phase-2 cannot satisfy the SDK/contract pins. Publish the release (or re-pin a new setup) to enable it."
    exit 0
  fi
fi

# The suite only reads circuitReleaseId from release.json; the committed manifest's id equals
# the one derived from the pinned vkeys.
[[ -f $artifacts_dir/release.json ]] || cp circuits/release/release.json "$artifacts_dir/release.json"

exec pnpm --filter ./tests exec vitest run --exclude tests/davinci.test.ts
