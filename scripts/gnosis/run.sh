#!/usr/bin/env bash
# Real Council ceremonies against the Gnosis deployment (scripts/gnosis/deployment.json, a TEST
# deployment of the development circuit release, with the test-only MockCouncilAdapter):
#   1. builds the SDK, the relayer and the contracts (the run reuses the e2e actors and ABIs);
#   2. runs ceremonies.gnosis.ts, which starts the relayer itself (open mode, scheduler and
#      combine worker on, behind a local RPC proxy that records its eth_getLogs) and drives
#      scenarios A (manual phases), B+C (scheduled phases, a non-dealer decrypts), D (partial-data
#      sourcing: cache dropped, then logs gone) and E (abort), with real proofs and authenticated
#      reads; it writes a JSON run record and a Markdown summary.
#
#   scripts/gnosis/run.sh
#
# Environment (every key is read from its file by the run and passed to the relayer child through
# its environment only; never printed):
#   COUNCIL_RELAYER_KEY_FILE  relayer hot key, default ~/.davinci-dkg-council/gnosis-relayer.key
#   COUNCIL_TESTER_KEY_FILE   the test adapter's registry (bind, request) and the direct sender,
#                              default ~/.davinci-dkg-council/gnosis-tester.key
#   COUNCIL_DEPLOYMENT        default scripts/gnosis/deployment.json
#   COUNCIL_RPC_URL           sending/progress RPCs and the relayer's upstreams, comma-separated
#   COUNCIL_READ_RPC_URLS     authenticated-read RPCs, >= 2 independent providers
#   COUNCIL_DAILY_BUDGET_WEI  relayer rolling 24 h budget, default 0.2 xDAI
#   COUNCIL_RELAYER_PORT      default 8791
#   COUNCIL_SCENARIOS         subset of a,b,d,e (default all; d runs on a's ceremony)
#   COUNCIL_B_REGISTRATION_S  B's scheduled registration window, default 300 s
#   COUNCIL_B_OPEN_GAP_S      B's opening date past registration + dealing (600 s), default 180 s
#   COUNCIL_GNOSIS_STATE      relayer data, logs, run records; default ~/.davinci-dkg-council/gnosis
#   COUNCIL_ARTIFACTS_DIR     pinned circuit files, default ~/.davinci-dkg-council/artifacts
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
FORGE=${FORGE:-$HOME/.foundry/bin/forge}
DEPLOYMENT=${COUNCIL_DEPLOYMENT:-$here/deployment.json}

die() { echo "run: $*" >&2; exit 1; }
[[ -f $DEPLOYMENT ]] || die "no deployment record at $DEPLOYMENT (scripts/gnosis/deploy.sh writes it)"
[[ $(jq -r '.contracts.MockCouncilAdapter.address // empty' "$DEPLOYMENT") ]] ||
  die "$DEPLOYMENT has no MockCouncilAdapter: deploy the test-only requester (MANAGER=… TEST_ADAPTER=true scripts/gnosis/deploy.sh)"
for f in "${COUNCIL_RELAYER_KEY_FILE:-$HOME/.davinci-dkg-council/gnosis-relayer.key}" \
  "${COUNCIL_TESTER_KEY_FILE:-$HOME/.davinci-dkg-council/gnosis-tester.key}"; do
  [[ -f $f ]] || die "missing key file $f"
done

echo "run: building the SDK, the relayer and the contracts"
cd "$root"
tests/node_modules/.bin/tsc -p sdk/tsconfig.json
tests/node_modules/.bin/tsc -p relayer/tsconfig.json
(cd solidity && "$FORGE" build >/dev/null)

COUNCIL_DEPLOYMENT=$DEPLOYMENT tests/node_modules/.bin/vitest run --config scripts/gnosis/vitest.config.ts
