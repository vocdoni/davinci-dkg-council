#!/usr/bin/env bash
# Restore circuits/build/ for the PINNED circuit release (release/release.json) without
# ever running a phase-2: compile both circuits with circom 2.2.3 exactly as build.sh does (same
# flags, same paths — compilation is deterministic, so the r1cs and wasm bytes are verified
# against the release pins), then copy the released deal_final.zkey, partial_final.zkey and both
# vkeys from ${COUNCIL_ARTIFACTS_DIR:-~/.davinci-dkg-council/artifacts},
# downloading them when that cache is missing from the release named by release/release.json
# "tag", at the URLs sdk/src/artifacts.ts pins: the DAVINCI CDN first, then the GitHub release.
# Every file is sha256-verified against release/release.json. The cache ends up with all six
# files plus release.json.
#
# This is what a fresh clone wants to run the circuit tests: the restored setup matches the
# committed verifiers, contract pins (CouncilRelease.sol), SDK pins (sdk/src/artifacts.ts) and
# proof fixtures. A NEW dev phase-2 (build.sh) re-pins all of those instead. The setup markers
# written here (build/<c>.setup.r1cs.sha256) make a later build.sh keep the restored zkeys
# (FORCE_SETUP=1 overrides, as in build.sh).
#
# Needs node_modules (circomlib includes): run `npx -y pnpm@10 install` at the repository root first.
set -euo pipefail

cd "$(dirname "$0")/.."
CIRCOM="${CIRCOM:-$HOME/.local/bin/circom}"
ARTIFACTS_DIR="${COUNCIL_ARTIFACTS_DIR:-$HOME/.davinci-dkg-council/artifacts}"

[ -x "$CIRCOM" ] || { echo "circom not found at $CIRCOM (set CIRCOM)" >&2; exit 1; }
"$CIRCOM" --version | grep -q "2.2.3" || { echo "circom 2.2.3 required" >&2; exit 1; }
[ -d node_modules/circomlib ] || { echo "node_modules missing: run 'npx -y pnpm@10 install' at the repository root first" >&2; exit 1; }

pin() { node -e 'const r=require("./release/release.json");console.log(r[process.argv[1]][process.argv[2]].sha256)' "$1" "$2"; }

# check <file> <circuit> <kind>: fatal unless the file's sha256 equals the release.json pin.
check() {
  local want got
  want=$(pin "$2" "$3"); want=${want#0x}
  got=$(sha256sum "$1" | cut -d' ' -f1)
  [ "$got" = "$want" ] || { echo "sha256 mismatch for $1: got $got, pinned 0x$want" >&2; exit 1; }
}

# matches <file> <circuit> <kind>: same test, as a return value (missing file = mismatch).
matches() {
  local want got
  want=$(pin "$2" "$3"); want=${want#0x}
  [ -f "$1" ] && got=$(sha256sum "$1" | cut -d' ' -f1) && [ "$got" = "$want" ]
}

mkdir -p build
for c in deal partial; do
  echo "== compile $c"
  "$CIRCOM" "$c.circom" --r1cs --wasm --sym --O2 -l node_modules -o build
  # One circom version produces one byte string: a mismatch is toolchain drift, not a restorable
  # build — do not paper over it by copying the released files over a different circuit.
  check "build/$c.r1cs" "$c" r1cs
  check "build/${c}_js/${c}.wasm" "$c" wasm
done

# Pinned phase-2 outputs (never regenerated here): the local cache first, else the CDN, else the
# GitHub release.
tag=$(node -e 'console.log(require("./release/release.json").tag)')
cdn="https://davinci-assets.fra1.cdn.digitaloceanspaces.com/council/$tag"
base="https://github.com/vocdoni/davinci-dkg-council/releases/download/$tag"
mkdir -p "$ARTIFACTS_DIR"
for e in deal_final.zkey:deal:zkey partial_final.zkey:partial:zkey deal_vkey.json:deal:vkey partial_vkey.json:partial:vkey; do
  file=${e%%:*}
  c=${e#*:}
  c=${c%%:*}
  kind=${e##*:}
  if ! matches "$ARTIFACTS_DIR/$file" "$c" "$kind"; then
    echo "== fetch $file from $cdn/$file"
    # The CDN, then the release's plain URL, then `gh` (authenticated), which a private
    # repository needs. A wrong copy fails the check below.
    curl -fsSL --retry 2 -o "$ARTIFACTS_DIR/$file" "$cdn/$file" ||
      curl -fsSL --retry 2 -o "$ARTIFACTS_DIR/$file" "$base/$file" ||
      { command -v gh >/dev/null &&
        gh release download "$tag" -R vocdoni/davinci-dkg-council -p "$file" -D "$ARTIFACTS_DIR" --clobber; } || {
      rm -f "$ARTIFACTS_DIR/$file"
      echo "cannot get $file: not in $ARTIFACTS_DIR and the pinned release is unreachable at $cdn and $base" \
        "(it may not be published yet). Publish the release, or populate $ARTIFACTS_DIR with the" \
        "files from the machine that made this setup." >&2
      exit 1
    }
  fi
  check "$ARTIFACTS_DIR/$file" "$c" "$kind"
  cp "$ARTIFACTS_DIR/$file" "build/$file"
done

# Byte-identical to what release.ts wrote for this setup (release.json is committed from there).
cp release/release.json build/release.json

# Complete the cache with the verified wasm and the manifest: the SDK's real-prover tests, the e2e
# suite and `make dev` read all six files (and release.json) from there.
for c in deal partial; do
  matches "$ARTIFACTS_DIR/$c.wasm" "$c" wasm || cp "build/${c}_js/$c.wasm" "$ARTIFACTS_DIR/$c.wasm"
done
cp release/release.json "$ARTIFACTS_DIR/release.json"

# Mark the restored zkeys as made from this r1cs so a later build.sh keeps them.
for c in deal partial; do
  sha256sum "build/$c.r1cs" | cut -d' ' -f1 >"build/$c.setup.r1cs.sha256"
done

echo "== restored the pinned release $(node -e 'console.log(require("./release/release.json").circuitReleaseId)')"
