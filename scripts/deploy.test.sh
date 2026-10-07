#!/usr/bin/env bash
# The deployment policy end to end on throwaway Anvil chains (audit H-01): the network deploy
# scripts against an Anvil that claims chain 100 (Gnosis) or 11155111 (Sepolia).
#   1. chain 100, DEV release, no ALLOW_DEV_SETUP: scripts/gnosis/deploy.sh refuses, and so does
#      Deploy.s.sol on its own (forge script --broadcast, the shell pre-check bypassed); the
#      deployer's nonce stays 0: nothing was broadcast.
#   2. chain 100, ALLOW_DEV_SETUP=true: deploys, warns loudly, records the override.
#   3. chain 11155111: scripts/sepolia/deploy.sh deploys the DEV release (a test chain) with its
#      test adapter, no override.
# A ceremony release (DEVELOPMENT_SETUP = false) deploys in case 1 instead.
#
#   bash scripts/deploy.test.sh        (needs forge, cast, anvil and jq)
set -euo pipefail

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
bin() { command -v "$1" 2>/dev/null || { [[ -x $HOME/.foundry/bin/$1 ]] && echo "$HOME/.foundry/bin/$1"; } || { echo "deploy.test: $1 not found" >&2; exit 1; }; }
FORGE=$(bin forge)
CAST=$(bin cast)
ANVIL=$(bin anvil)
export FORGE CAST
command -v jq >/dev/null || { echo "deploy.test: jq not found" >&2; exit 1; }

tmp=$(mktemp -d)
pids=()
cleanup() {
  for p in "${pids[@]}"; do kill "$p" 2>/dev/null || true; done
  rm -rf "$tmp"
}
trap cleanup EXIT

fail() { echo "[deploy.test] FAIL: $*" >&2; exit 1; }
# Anvil's first default account: a public test key.
key=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
deployer=0xf39Fd6e51aad88F6F4ce6aB8827279cffFb92266
printf '%s\n' "$key" >"$tmp/key"
dev=$(tr -s ' \n' ' ' <"$root/solidity/script/CouncilRelease.sol" | grep -oE 'DEVELOPMENT_SETUP = (true|false)' | grep -oE 'true|false')

# anvil <chain-id> <port>: a fresh chain; the RPC URL once it answers.
anvil_on() {
  "$ANVIL" --chain-id "$1" --port "$2" --silent &
  pids+=($!)
  for _ in $(seq 50); do
    "$CAST" chain-id --rpc-url "http://127.0.0.1:$2" >/dev/null 2>&1 && return 0
    sleep 0.1
  done
  fail "anvil on port $2 did not start"
}

common=(COUNCIL_KEY_FILE="$tmp/key" COUNCIL_ARTIFACTS_DIR="$root/circuits/release")

port=$((20000 + RANDOM % 20000))
anvil_on 100 "$port"
rpc=http://127.0.0.1:$port

if [[ $dev == true ]]; then
  echo "[deploy.test] chain 100, DEV release, no override: refused"
  if env "${common[@]}" RPC_URL="$rpc" DEPLOYMENT_OUT="$tmp/gnosis.json" COUNCIL_GNOSIS_STATE="$tmp/state" \
    bash "$root/scripts/gnosis/deploy.sh" >"$tmp/out1" 2>&1; then
    cat "$tmp/out1"
    fail "scripts/gnosis/deploy.sh deployed a DEVELOPMENT_SETUP release on chain 100"
  fi
  grep -q "DEVELOPMENT_SETUP release" "$tmp/out1" || { cat "$tmp/out1"; fail "unexpected refusal"; }

  echo "[deploy.test] chain 100, DEV release, Deploy.s.sol alone: refused before broadcast"
  if (cd "$root/solidity" && PRIVATE_KEY=$key ALLOW_DEV_SETUP=false \
    "$FORGE" script script/Deploy.s.sol --rpc-url "$rpc" --broadcast --skip-simulation) >"$tmp/out2" 2>&1; then
    cat "$tmp/out2"
    fail "Deploy.s.sol broadcast a DEVELOPMENT_SETUP release on chain 100"
  fi
  grep -q "DEVELOPMENT_SETUP release refused on a production chain" "$tmp/out2" || { cat "$tmp/out2"; fail "unexpected forge failure"; }
  [[ $("$CAST" nonce "$deployer" --rpc-url "$rpc") == 0 ]] || fail "a transaction was broadcast"
  [[ ! -f $tmp/gnosis.json ]] || fail "a deployment record was written"

  echo "[deploy.test] chain 100, DEV release, ALLOW_DEV_SETUP=true: deployed with a warning"
  env "${common[@]}" RPC_URL="$rpc" DEPLOYMENT_OUT="$tmp/gnosis.json" COUNCIL_GNOSIS_STATE="$tmp/state" ALLOW_DEV_SETUP=true \
    bash "$root/scripts/gnosis/deploy.sh" >"$tmp/out3" 2>&1 || { cat "$tmp/out3"; fail "the explicit override did not deploy"; }
  grep -q "WARNING: ALLOW_DEV_SETUP=true" "$tmp/out3" || { cat "$tmp/out3"; fail "no warning"; }
  jq -e '.chainId == 100 and .circuitRelease.developmentSetup == true and .circuitRelease.allowDevSetup == true
    and (.contracts | has("MockCouncilAdapter") | not)' "$tmp/gnosis.json" >/dev/null ||
    fail "unexpected record: $(cat "$tmp/gnosis.json")"
else
  echo "[deploy.test] chain 100, ceremony release: deployed without any override"
  env "${common[@]}" RPC_URL="$rpc" DEPLOYMENT_OUT="$tmp/gnosis.json" COUNCIL_GNOSIS_STATE="$tmp/state" \
    bash "$root/scripts/gnosis/deploy.sh" >"$tmp/out1" 2>&1 || { cat "$tmp/out1"; fail "the ceremony release did not deploy"; }
  jq -e '.chainId == 100 and .circuitRelease.developmentSetup == false and (.circuitRelease | has("allowDevSetup") | not)' \
    "$tmp/gnosis.json" >/dev/null || fail "unexpected record: $(cat "$tmp/gnosis.json")"
fi

port2=$((port + 1))
anvil_on 11155111 "$port2"
echo "[deploy.test] chain 11155111 (a test chain): deployed with the test adapter, no override"
env "${common[@]}" RPC_URL="http://127.0.0.1:$port2" DEPLOYMENT_OUT="$tmp/sepolia.json" COUNCIL_SEPOLIA_STATE="$tmp/state" \
  bash "$root/scripts/sepolia/deploy.sh" >"$tmp/out4" 2>&1 || { cat "$tmp/out4"; fail "Sepolia deploy failed"; }
jq -e --argjson dev "$dev" '.chainId == 11155111 and .circuitRelease.developmentSetup == $dev
  and (.circuitRelease | has("allowDevSetup") | not) and (.contracts.MockCouncilAdapter.address | test("^0x[0-9a-f]{40}$"))' \
  "$tmp/sepolia.json" >/dev/null || fail "unexpected record: $(cat "$tmp/sepolia.json")"

echo "[deploy.test] ok"
