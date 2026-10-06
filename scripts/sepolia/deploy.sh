#!/usr/bin/env bash
# Deploy Council to Sepolia (or any chain given EXPECTED_CHAIN_ID): the two generated Groth16
# verifiers and the CouncilManager through solidity/script/Deploy.s.sol (which enforces the
# release pins of solidity/script/CouncilRelease.sol), then the e2e test adapter
# (MockCouncilAdapter, the requester the ceremony run uses), then re-checks the deployed code
# against the pins and writes the deployment record (default scripts/sepolia/deployment.json).
#
#   COUNCIL_KEY_FILE=~/sepolia_privkey.txt scripts/sepolia/deploy.sh
#
# Environment:
#   COUNCIL_KEY_FILE        file holding the funded deployer key (required). Read at runtime and
#                            handed to forge through the environment only; never printed.
#   RPC_URL                  default https://ethereum-sepolia-rpc.publicnode.com
#   EXPECTED_CHAIN_ID        default 11155111
#   COUNCIL_ARTIFACTS_DIR   the released dev artifacts, default
#                            ~/.davinci-dkg-council/artifacts (vkeys must
#                            match circuits/release byte for byte)
#   DEAL_VERIFIER, PARTIAL_VERIFIER
#                            reuse deployed verifiers (Deploy.s.sol checks their code hashes
#                            against the pins before it deploys the manager); the record keeps
#                            their original creation receipts, marked "reused"
#   MANAGER                  skip the manager deployment and only (re)deploy the test adapter
#   FORGE_SCRIPT_ARGS        extra `forge script` arguments, e.g. "--with-gas-price 1.7gwei -g 110"
#   DEPLOYMENT_OUT           default scripts/sepolia/deployment.json
#   COUNCIL_SEPOLIA_STATE   local state directory (forge broadcast copies), default ~/.davinci-dkg-council/sepolia
#   ETHERSCAN_API_KEY_FILE   optional: verify every contract on Etherscan (failures only warn)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
contracts=$root/solidity
FORGE=${FORGE:-$HOME/.foundry/bin/forge}
CAST=${CAST:-$HOME/.foundry/bin/cast}
RPC_URL=${RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}
EXPECTED_CHAIN_ID=${EXPECTED_CHAIN_ID:-11155111}
ARTIFACTS_DIR=${COUNCIL_ARTIFACTS_DIR:-$HOME/.davinci-dkg-council/artifacts}
OUT=${DEPLOYMENT_OUT:-$here/deployment.json}
STATE=${COUNCIL_SEPOLIA_STATE:-$HOME/.davinci-dkg-council/sepolia}
: "${COUNCIL_KEY_FILE:?set COUNCIL_KEY_FILE to the file holding the deployer key}"

die() { echo "deploy: $*" >&2; exit 1; }

key=$(tr -d ' \t\r\n' <"$COUNCIL_KEY_FILE")
[[ $key == 0x* ]] || key=0x$key
[[ $key =~ ^0x[0-9a-fA-F]{64}$ ]] || die "COUNCIL_KEY_FILE does not hold a 32-byte hex key"

chain_id=$("$CAST" chain-id --rpc-url "$RPC_URL")
[[ $chain_id == "$EXPECTED_CHAIN_ID" ]] || die "RPC serves chain $chain_id, expected $EXPECTED_CHAIN_ID"

# The released artifacts the clients prove with must be the vkeys the contracts are pinned to.
for f in deal_vkey.json partial_vkey.json; do
  a=$(sha256sum "$ARTIFACTS_DIR/$f" | cut -d' ' -f1)
  b=$(sha256sum "$root/circuits/release/$f" | cut -d' ' -f1)
  [[ $a == "$b" ]] || die "$ARTIFACTS_DIR/$f differs from circuits/release/$f"
done
pin() {
  tr -s ' \n' ' ' <"$contracts/script/CouncilRelease.sol" | grep -oE "$1 = 0x[0-9a-fA-F]{64}" | grep -oE '0x[0-9a-fA-F]{64}' ||
    die "CouncilRelease.sol: no $1"
}
release_id=$(pin CIRCUIT_RELEASE_ID)
deal_pin=$(pin DEAL_VERIFIER_CODEHASH)
partial_pin=$(pin PARTIAL_VERIFIER_CODEHASH)
release_tag=$(jq -r .tag "$root/circuits/release/release.json")
[[ $(jq -r .circuitReleaseId "$ARTIFACTS_DIR/release.json") == "$release_id" ]] || die "artifacts release.json is another release"

mkdir -p "$STATE"
cd "$contracts"
"$FORGE" build >/dev/null

broadcast() { echo "$contracts/broadcast/$1/$chain_id/run-latest.json"; }
# Contract name -> address of a CREATE in a forge broadcast file (top-level or nested).
created() {
  jq -r --arg n "$2" '[.transactions[] | (select(.transactionType == "CREATE" and .contractName == $n) | .contractAddress),
    (.additionalContracts[]? | select(.contractName == $n) | .address)] | first // empty' "$1"
}
# Address -> {tx, block, gasUsed, effectiveGasPrice} of the transaction that created it.
receipt_of() {
  jq -c --arg a "$2" '
    def num: if type == "number" then . else ltrimstr("0x") | ascii_downcase | explode
      | reduce .[] as $c (0; . * 16 + (if $c >= 97 then $c - 87 else $c - 48 end)) end;
    ([.transactions[] | select((.contractAddress // "" | ascii_downcase) == ($a | ascii_downcase)
       or any(.additionalContracts[]?; (.address | ascii_downcase) == ($a | ascii_downcase)))] | first | .hash) as $h
    | (.receipts[] | select(.transactionHash == $h))
    | {tx: $h, block: (.blockNumber | num), gasUsed: (.gasUsed | num),
       effectiveGasPrice: (.effectiveGasPrice | num)}' "$1"
}

# Gas limits come from the RPC's eth_estimateGas (--skip-simulation), not from forge's local
# simulation: that one does not price Glamsterdam's state gas (EIP-8037, about 1,530 gas per
# byte of deployed code), so on Sepolia it underestimates a CREATE about fivefold and the
# transaction would run out of gas.
# shellcheck disable=SC2206
script_args=(--rpc-url "$RPC_URL" --broadcast --slow --skip-simulation ${FORGE_SCRIPT_ARGS:-})

if [[ -z ${MANAGER:-} ]]; then
  echo "deploy: verifiers + CouncilManager ($release_tag, $release_id) on chain $chain_id"
  PRIVATE_KEY=$key CIRCUIT_RELEASE_ID=$release_id \
    "$FORGE" script script/Deploy.s.sol "${script_args[@]}"
  run=$(broadcast Deploy.s.sol)
  MANAGER=$(created "$run" CouncilManager)
  [[ -n $MANAGER ]] || die "no CouncilManager in $run"
  cp "$run" "$STATE/$chain_id-deploy-manager.json"
fi
manager_run=$STATE/$chain_id-deploy-manager.json
[[ -f $manager_run ]] || die "MANAGER given but $manager_run (the forge broadcast of its deployment) is missing"

echo "deploy: test adapter for manager $MANAGER"
PRIVATE_KEY=$key MANAGER=$MANAGER \
  "$FORGE" script ../scripts/sepolia/DeployTestAdapter.s.sol "${script_args[@]}"
adapter_run=$(broadcast DeployTestAdapter.s.sol)
# forge leaves contractName null for a script outside the project; it holds exactly one CREATE.
adapter=$(jq -r '[.transactions[] | select(.transactionType == "CREATE")] | if length == 1 then .[0].contractAddress else empty end' "$adapter_run")
[[ -n $adapter ]] || die "no MockCouncilAdapter in $adapter_run"
cp "$adapter_run" "$STATE/$chain_id-deploy-adapter.json"
unset key

# Re-check the deployment from chain state alone.
call() { "$CAST" call "$MANAGER" "$1" --rpc-url "$RPC_URL"; }
deal=$("$CAST" parse-bytes32-address "$(call 'dealVerifier()')")
partial=$("$CAST" parse-bytes32-address "$(call 'partialVerifier()')")
views=$("$CAST" parse-bytes32-address "$(call 'views()')")
[[ $(call 'circuitReleaseId()') == "$release_id" ]] || die "manager circuitReleaseId differs from the pin"
deal_hash=$("$CAST" codehash "$deal" --rpc-url "$RPC_URL")
partial_hash=$("$CAST" codehash "$partial" --rpc-url "$RPC_URL")
[[ $deal_hash == "$deal_pin" ]] || die "DealVerifier codehash $deal_hash != pin $deal_pin"
[[ $partial_hash == "$partial_pin" ]] || die "PartialVerifier codehash $partial_hash != pin $partial_pin"
registry=$("$CAST" parse-bytes32-address "$("$CAST" call "$adapter" 'registry()' --rpc-url "$RPC_URL")")
[[ $("$CAST" parse-bytes32-address "$("$CAST" call "$adapter" 'manager()' --rpc-url "$RPC_URL")") == "$("$CAST" to-check-sum-address "$MANAGER")" ]] ||
  die "adapter is bound to another manager"
echo "deploy: verifier code hashes match CouncilRelease.sol; manager bound to $release_id"

manager_receipt=$(receipt_of "$manager_run" "$MANAGER")
# A reused verifier has no creation in this run: keep its receipt from the previous record.
creation_of() {
  local r
  r=$(receipt_of "$manager_run" "$1")
  if [[ -z $r ]]; then
    r=$(jq -c --arg a "${1,,}" 'first(.contracts[] | select(.address == $a) | {tx, block, gasUsed, effectiveGasPrice}) // {}' \
      "$OUT" 2>/dev/null || echo '{}')
    r=$(jq -c '. + {reused: true}' <<<"$r")
  fi
  echo "$r"
}
deal_tx=$(creation_of "$deal")
partial_tx=$(creation_of "$partial")
jq -n \
  --arg chainId "$chain_id" --arg tag "$release_tag" --arg releaseId "$release_id" \
  --arg deployer "$(jq -r '.transactions[0].transaction.from' "$manager_run")" \
  --arg manager "$MANAGER" --arg views "$views" --arg deal "$deal" --arg partial "$partial" \
  --arg adapter "$adapter" --arg registry "$registry" \
  --arg dealHash "$deal_hash" --arg partialHash "$partial_hash" \
  --arg managerHash "$("$CAST" codehash "$MANAGER" --rpc-url "$RPC_URL")" \
  --arg viewsHash "$("$CAST" codehash "$views" --rpc-url "$RPC_URL")" \
  --arg adapterHash "$("$CAST" codehash "$adapter" --rpc-url "$RPC_URL")" \
  --argjson dealTx "$deal_tx" \
  --argjson partialTx "$partial_tx" \
  --argjson managerTx "$manager_receipt" \
  --argjson adapterTx "$(receipt_of "$adapter_run" "$adapter")" \
  '{
    chainId: ($chainId | tonumber),
    circuitRelease: {tag: $tag, circuitReleaseId: $releaseId, developmentSetup: true},
    deployer: ($deployer | ascii_downcase),
    deploymentBlock: $managerTx.block,
    contracts: {
      DealVerifier: ({address: $deal, codehash: $dealHash} + $dealTx),
      PartialVerifier: ({address: $partial, codehash: $partialHash} + $partialTx),
      CouncilManager: ({address: $manager, codehash: $managerHash} + $managerTx),
      CouncilViews: ({address: $views, codehash: $viewsHash, createdBy: "CouncilManager constructor"} + ($managerTx | {tx, block})),
      MockCouncilAdapter: ({address: $adapter, codehash: $adapterHash, registry: ($registry | ascii_downcase)} + $adapterTx)
    }
  } | (.contracts[] |= (.address |= ascii_downcase))' >"$OUT"
echo "deploy: wrote $OUT"

if [[ -n ${ETHERSCAN_API_KEY_FILE:-} ]]; then
  ETHERSCAN_API_KEY=$(tr -d ' \t\r\n' <"$ETHERSCAN_API_KEY_FILE")
  export ETHERSCAN_API_KEY
  verify() {
    "$FORGE" verify-contract --chain "$chain_id" --watch "$@" ||
      echo "deploy: warning: Etherscan verification of $2 failed" >&2
  }
  verify "$deal" src/verifiers/DealVerifier.sol:DealVerifier
  verify "$partial" src/verifiers/PartialVerifier.sol:PartialVerifier
  verify "$MANAGER" src/CouncilManager.sol:CouncilManager \
    --constructor-args "$("$CAST" abi-encode 'f(address,address,bytes32)' "$deal" "$partial" "$release_id")"
  verify "$views" src/CouncilViews.sol:CouncilViews
  verify "$adapter" test/mocks/MockCouncilAdapter.sol:MockCouncilAdapter \
    --constructor-args "$("$CAST" abi-encode 'f(address)' "$MANAGER")"
  unset ETHERSCAN_API_KEY
fi
