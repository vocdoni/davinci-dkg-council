#!/usr/bin/env bash
# The whole Council stack on this machine (`make dev`): Anvil, the real verifiers and
# CouncilManager on the dev circuit release, the circuit files over HTTP, a DAVINCI
# ProcessRegistry (MockZiskVerifier) with its CouncilAdapter, the relayer with its combine
# worker, and the app. Prints the URLs; Ctrl-C stops everything. See tests/src/dev.ts.
#
#   scripts/dev-stack.sh                         start the stack (`up`)
#   scripts/dev-stack.sh settle --process 0x… --tally 7,0,3
#
# Needs Node 22, the dev circuit artifacts (COUNCIL_ARTIFACTS_DIR, default
# ~/.davinci-dkg-council/artifacts) and Foundry: the host install
# (~/.foundry/bin or PATH) when present, else Docker. The DAVINCI part needs the davinci-contracts
# and davinci-sdk checkouts (branch `council`, built SDK) next to this repository, or
# DAVINCI_CONTRACTS_DIR / DAVINCI_SDK_DIR; COUNCIL_DEV_DAVINCI=off runs without it.
set -euo pipefail

cd "$(dirname "$0")/.."

if [[ -z ${E2E_FOUNDRY:-} ]] && { [[ -x $HOME/.foundry/bin/anvil ]] || command -v anvil >/dev/null; }; then
  export E2E_FOUNDRY=host
fi

if [[ ! -x tests/node_modules/.bin/tsx || ! -x ui/node_modules/.bin/vite ]]; then
  npx -y pnpm@10 install --frozen-lockfile
fi

exec tests/node_modules/.bin/tsx tests/src/dev.ts "$@"
