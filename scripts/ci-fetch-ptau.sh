#!/usr/bin/env bash
# CI helper: download the Hermez powers of tau for 2^18 constraints (both circuits fit) and
# verify it against the blake2b digest snarkjs publishes ("Prepared (phase2) Ptau files").
#
#   scripts/ci-fetch-ptau.sh <output-path>
#
# Local builds may use another 2^18 phase-1 file (COUNCIL_PTAU); circuits/release/release.json
# records the sha256 of the one a release was set up from. circuits/build.sh carries the same URL
# and digest for its own first-run download — change both together.
set -euo pipefail

out=${1:?usage: ci-fetch-ptau.sh <output-path>}
b2=7e6a9c2e5f05179ddfc923f38f917c9e6831d16922a902b0b4758b8e79c2ab8a81bb5f29952e16ee6c5067ed044d7857b5de120a90704c1d3b637fd94b95b13e

curl -fsSL --retry 2 -o "$out" "https://circom.info/powersOfTau28_hez_final_18.ptau"
echo "$b2  $out" | b2sum -c -
sha256sum "$out"
