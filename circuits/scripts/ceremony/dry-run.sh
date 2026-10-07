#!/usr/bin/env bash
# Rehearses the whole production ceremony on this machine, in a scratch directory, without
# touching this checkout or the committed DEV release:
#   1. the coordinator compiles the circuits and starts phase 2 from the Hermez ptau;
#   2. three simulated contributors, each with their own inbox/outbox, contribute in turn, and the
#      coordinator verifies every contribution from the r1cs and the ptau before accepting it;
#   3. a drand quicknet round a few seconds ahead is announced, awaited, BLS-verified and applied
#      as the beacon;
#   4. export (vkeys, verifiers, release.json), then install into a scratch copy of this checkout
#      and re-pin it with pin.ts (CouncilRelease.sol: DEVELOPMENT_SETUP = false);
#   5. the auditor's `verify`, then in the scratch copy: real proof fixtures from the ceremony
#      keys, the circuit release test, the whole forge suite (real verifiers included) and the
#      deployment policy on Anvil (the ceremony release deploys on chain 100 without override).
#
#   make ceremony-dry-run                 (or: bash circuits/scripts/ceremony/dry-run.sh [DIR])
#
# Needs circom 2.2.3, node_modules (make install), forge/anvil/cast, jq, network access (drand)
# and the Hermez ptau ($COUNCIL_PTAU, default ~/.davinci-dkg-council/ptau/…, downloaded if
# missing). DIR (default a new mktemp directory) is kept for inspection.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
circuits=$(cd "$here/../.." && pwd)
repo=$(cd "$circuits/.." && pwd)
tmp=${1:-$(mktemp -d -t council-ceremony-XXXXXX)}
mkdir -p "$tmp"
tmp=$(cd "$tmp" && pwd)
tag=circuits-v2-dryrun
export COUNCIL_PTAU=${COUNCIL_PTAU:-$HOME/.davinci-dkg-council/ptau/powersOfTau28_hez_final_18.ptau}
FORGE=${FORGE:-$(command -v forge || echo "$HOME/.foundry/bin/forge")}
export FORGE

say() { printf '\n== %s\n' "$*"; }
cer() { (cd "$circuits" && node_modules/.bin/tsx scripts/ceremony/ceremony.ts "$@"); }

[[ -x $circuits/node_modules/.bin/tsx ]] || { echo "dry-run: run 'make install' first" >&2; exit 1; }
if [[ ! -f $COUNCIL_PTAU ]]; then
  say "fetching the Hermez ptau into $COUNCIL_PTAU"
  mkdir -p "$(dirname "$COUNCIL_PTAU")"
  bash "$repo/scripts/ci-fetch-ptau.sh" "$COUNCIL_PTAU"
fi
echo "dry-run: scratch directory $tmp"
dev_before=$(git -C "$repo" status --porcelain -- circuits/release solidity/src/verifiers solidity/script sdk/src/artifacts.ts circuits/fixtures)

coord=$tmp/coordinator
say "init (coordinator)"
cer init --dir "$coord" --tag "$tag"

for i in 1 2 3; do
  prev=$(printf %04d $((i - 1)))
  inbox=$tmp/contributor-$i/inbox
  outbox=$tmp/contributor-$i/outbox
  mkdir -p "$inbox"
  # what the coordinator sends: the current head and the ceremony state
  cp "$coord/zkeys/deal_$prev.zkey" "$coord/zkeys/partial_$prev.zkey" "$coord/ceremony.json" "$inbox/"
  say "contribution #$i (simulated contributor $i, on their own copy)"
  cer contribute --in "$inbox" --out "$outbox" --name "Simulated contributor $i" </dev/null
  say "accept #$i (coordinator: zkey verify from r1cs + ptau)"
  cer accept --dir "$coord" --from "$outbox"
done

say "announce a drand round ~15 s ahead, wait for it, apply the beacon"
cer announce-beacon --dir "$coord" --drand-in 15
cer beacon --dir "$coord" --wait

say "export"
cer export --dir "$coord"

say "install + re-pin a scratch copy of the checkout"
scratch=$tmp/repo
mkdir -p "$scratch/sdk/src" "$scratch/tests"
tar -C "$repo" --exclude=out --exclude=cache --exclude=cache_forge --exclude=broadcast --exclude=build \
  --exclude=node_modules -cf - solidity circuits scripts | tar -x -C "$scratch"
cp "$repo/sdk/src/artifacts.ts" "$scratch/sdk/src/"
cp -r "$repo/tests/vectors" "$scratch/tests/"
ln -s "$circuits/node_modules" "$scratch/circuits/node_modules"
cer install --dir "$coord" --repo "$scratch"
grep -q 'DEVELOPMENT_SETUP = false' "$scratch/solidity/script/CouncilRelease.sol" || { echo "dry-run: not re-pinned" >&2; exit 1; }
grep -q 'developmentSetup: false' "$scratch/sdk/src/artifacts.ts" || { echo "dry-run: sdk trust flag not re-pinned" >&2; exit 1; }

say "verify (what an auditor runs on the published directory)"
cer verify --dir "$coord" --repo "$scratch"

say "scratch copy: real proof fixtures from the ceremony keys, release test, forge suite, deploy policy"
(cd "$scratch/circuits" && node_modules/.bin/tsx scripts/gen-fixtures.ts)
(cd "$scratch/circuits" && node --import tsx --test test/release.test.ts)
(cd "$scratch/solidity" && "$FORGE" test)
bash "$scratch/scripts/deploy.test.sh"

[[ $(git -C "$repo" status --porcelain -- circuits/release solidity/src/verifiers solidity/script sdk/src/artifacts.ts circuits/fixtures) == "$dev_before" ]] ||
  { echo "dry-run: the checkout's release files changed" >&2; exit 1; }
say "dry run OK: $(jq -r '.circuitReleaseId' "$coord/release/release.json") ($tag), transcript in $coord"
