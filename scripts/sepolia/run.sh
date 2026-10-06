#!/usr/bin/env bash
# A real Council ceremony against an existing deployment (scripts/sepolia/deployment.json):
#   1. builds the SDK, the relayer and the contracts (the run reuses the e2e helpers and ABIs);
#   2. starts the relayer locally in restricted mode — a fresh API token generated for this run,
#      a modest rolling daily budget, its combine worker on, two RPCs as fallbacks;
#   3. runs ceremony.sepolia.ts through it (n=3, t=2, real proofs, authenticated reads), which
#      writes a JSON run record and a Markdown summary.
#
#   COUNCIL_KEY_FILE=~/sepolia_privkey.txt scripts/sepolia/run.sh
#
# Environment:
#   COUNCIL_KEY_FILE          file holding the funded key (required): the relayer's hot key, the
#                              test adapter's registry and the funder of the direct-partial key.
#                              Read at runtime, passed to the children through the environment,
#                              never printed.
#   COUNCIL_DEPLOYMENT        default scripts/sepolia/deployment.json
#   COUNCIL_RPC_URL           relayer + sending RPCs, comma-separated fallbacks
#   COUNCIL_READ_RPC_URLS     authenticated-read RPCs, >= 2 independent providers
#   COUNCIL_DAILY_BUDGET_WEI  relayer rolling 24 h budget, default 0.03 ether
#   COUNCIL_MAX_FEE_WEI       relayer fee cap, default 20 gwei
#   COUNCIL_PORT              relayer port, default 8790
#   COUNCIL_SEPOLIA_STATE     state directory (relayer state, logs, run records), default ~/.davinci-dkg-council/sepolia
#   COUNCIL_ARTIFACTS_DIR     pinned dev circuit artifacts, default ~/.davinci-dkg-council/artifacts
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
FORGE=${FORGE:-$HOME/.foundry/bin/forge}
DEPLOYMENT=${COUNCIL_DEPLOYMENT:-$here/deployment.json}
STATE=${COUNCIL_SEPOLIA_STATE:-$HOME/.davinci-dkg-council/sepolia}
# 1rpc.io serves Sepolia reads but refuses eth_sendRawTransaction on its free plan, and viem's
# fallback transport surfaces the last provider's error — so it is not a sending fallback.
SEND_RPCS=${COUNCIL_RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.gateway.tenderly.co}
READ_RPCS=${COUNCIL_READ_RPC_URLS:-https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.gateway.tenderly.co}
PORT=${COUNCIL_PORT:-8790}
: "${COUNCIL_KEY_FILE:?set COUNCIL_KEY_FILE to the file holding the funded key}"

die() { echo "run: $*" >&2; exit 1; }
[[ -f $DEPLOYMENT ]] || die "no deployment record at $DEPLOYMENT (scripts/sepolia/deploy.sh writes it)"
superseded=$(jq -r '.superseded // empty' "$DEPLOYMENT")
[[ -z $superseded ]] || die "$DEPLOYMENT is superseded: $superseded"
manager=$(jq -r .contracts.CouncilManager.address "$DEPLOYMENT")
start_block=$(jq -r .deploymentBlock "$DEPLOYMENT")
chain_id=$(jq -r .chainId "$DEPLOYMENT")

key=$(tr -d ' \t\r\n' <"$COUNCIL_KEY_FILE")
[[ $key == 0x* ]] || key=0x$key
[[ $key =~ ^0x[0-9a-fA-F]{64}$ ]] || die "COUNCIL_KEY_FILE does not hold a 32-byte hex key"
token=$(openssl rand -hex 24)

echo "run: building the SDK, the relayer and the contracts"
cd "$root"
tests/node_modules/.bin/tsc -p sdk/tsconfig.json
tests/node_modules/.bin/tsc -p relayer/tsconfig.json
(cd solidity && "$FORGE" build >/dev/null)

stamp=$(date -u +%Y%m%dT%H%M%SZ)
mkdir -p "$STATE/relayer"
relayer_log=$STATE/relayer-$chain_id-$stamp.log
echo "run: relayer for manager $manager on chain $chain_id (log $relayer_log)"
COUNCIL_PRIVATE_KEY=$key \
  COUNCIL_API_TOKENS=$token \
  COUNCIL_RPC_URL=$SEND_RPCS \
  COUNCIL_MANAGER_ADDRESS=$manager \
  COUNCIL_PORT=$PORT \
  COUNCIL_HOST=127.0.0.1 \
  COUNCIL_DATA_DIR=$STATE/relayer \
  COUNCIL_COMBINER_ENABLED=true \
  COUNCIL_START_BLOCK=$start_block \
  COUNCIL_LOG_RANGE=${COUNCIL_LOG_RANGE:-1000} \
  COUNCIL_COMBINER_POLL_MS=${COUNCIL_COMBINER_POLL_MS:-12000} \
  COUNCIL_TX_POLL_MS=${COUNCIL_TX_POLL_MS:-4000} \
  COUNCIL_TX_BUMP_AFTER_MS=${COUNCIL_TX_BUMP_AFTER_MS:-60000} \
  COUNCIL_DAILY_BUDGET_WEI=${COUNCIL_DAILY_BUDGET_WEI:-30000000000000000} \
  COUNCIL_MAX_FEE_WEI=${COUNCIL_MAX_FEE_WEI:-20000000000} \
  COUNCIL_ORGANIZER_DAILY_CEREMONIES=${COUNCIL_ORGANIZER_DAILY_CEREMONIES:-3} \
  COUNCIL_MAX_GRANTS=${COUNCIL_MAX_GRANTS:-4} \
  node relayer/dist/main.js >"$relayer_log" 2>&1 &
relayer_pid=$!
trap 'kill "$relayer_pid" 2>/dev/null || true; wait "$relayer_pid" 2>/dev/null || true' EXIT

for _ in $(seq 1 60); do
  kill -0 "$relayer_pid" 2>/dev/null || die "the relayer exited; see $relayer_log"
  curl -fsS "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/v1/health" || die "the relayer did not come up; see $relayer_log"
echo

COUNCIL_PRIVATE_KEY=$key \
  COUNCIL_RELAYER_TOKEN=$token \
  COUNCIL_RELAYER_URL=http://127.0.0.1:$PORT \
  COUNCIL_DEPLOYMENT=$DEPLOYMENT \
  COUNCIL_RPC_URL=$SEND_RPCS \
  COUNCIL_READ_RPC_URLS=$READ_RPCS \
  COUNCIL_RUN_OUT=$STATE/run-$chain_id-$stamp.json \
  tests/node_modules/.bin/vitest run --config scripts/sepolia/vitest.config.ts
