#!/usr/bin/env bash
# Deploy Council to one network: the two generated Groth16 verifiers and the CouncilManager
# through solidity/script/Deploy.s.sol (which enforces the release pins of
# solidity/script/CouncilRelease.sol and the DEVELOPMENT_SETUP policy), optionally the e2e test
# adapter (MockCouncilAdapter, a requester for testnet rehearsals), then re-checks the deployed
# code against the pins and writes the deployment record. The manager's constructor creates its
# two delegatecall targets (architecture §1.7): CouncilViews (CREATE nonce 1, served by views())
# and CouncilOps (nonce 2, no getter); both are located from the manager's address, checked byte
# for byte against the local build and recorded.
#
# Not run directly: scripts/sepolia/deploy.sh and scripts/gnosis/deploy.sh set the network
# defaults below and exec this file.
#
# Environment (the network wrapper sets the defaults):
#   NETWORK                  label for messages (sepolia, gnosis)
#   COUNCIL_KEY_FILE         file holding the funded deployer key (required). Read at runtime and
#                            handed to forge through the environment only; never printed.
#   RPC_URL                  one RPC endpoint; when unset, the first of RPC_URLS (space separated)
#                            that serves EXPECTED_CHAIN_ID
#   EXPECTED_CHAIN_ID        the chain the RPC must serve
#   ALLOW_DEV_SETUP          true|false (default false), passed to Deploy.s.sol explicitly: a
#                            DEVELOPMENT_SETUP release (single-party phase 2: its operator can
#                            forge every proof) is refused on any chain but 31337, 11155111 and
#                            10200 unless true. true is for rehearsal networks only.
#   TEST_ADAPTER             true|false: also deploy the MockCouncilAdapter test requester
#   COUNCIL_ARTIFACTS_DIR    the released artifacts, default ~/.davinci-dkg-council/artifacts
#                            (vkeys must match circuits/release byte for byte)
#   DEAL_VERIFIER, PARTIAL_VERIFIER
#                            reuse deployed verifiers (Deploy.s.sol checks their code hashes
#                            against the pins before it deploys the manager); the record keeps
#                            their original creation receipts, marked "reused"
#   MANAGER                  skip the manager deployment (only (re)deploy the test adapter and
#                            re-check / re-record the deployment)
#   FORGE_SCRIPT_ARGS        extra `forge script` arguments, e.g. "--with-gas-price 1.7gwei -g 110"
#   DEPLOYMENT_OUT           the deployment record (JSON)
#   COUNCIL_DEPLOY_STATE     local state directory (forge broadcast copies)
#   ETHERSCAN_API_KEY_FILE   optional: verify every contract on Etherscan (failures only warn)
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
contracts=$root/solidity
FORGE=${FORGE:-$HOME/.foundry/bin/forge}
CAST=${CAST:-$HOME/.foundry/bin/cast}
NETWORK=${NETWORK:?the network wrapper sets NETWORK}
EXPECTED_CHAIN_ID=${EXPECTED_CHAIN_ID:?the network wrapper sets EXPECTED_CHAIN_ID}
ALLOW_DEV_SETUP=${ALLOW_DEV_SETUP:-false}
TEST_ADAPTER=${TEST_ADAPTER:-false}
ARTIFACTS_DIR=${COUNCIL_ARTIFACTS_DIR:-$HOME/.davinci-dkg-council/artifacts}
OUT=${DEPLOYMENT_OUT:?the network wrapper sets DEPLOYMENT_OUT}
STATE=${COUNCIL_DEPLOY_STATE:?the network wrapper sets COUNCIL_DEPLOY_STATE}
: "${COUNCIL_KEY_FILE:?set COUNCIL_KEY_FILE to the file holding the deployer key}"

die() { echo "deploy: $*" >&2; exit 1; }
bool() { [[ $2 == true || $2 == false ]] || die "$1 must be true or false, got '$2'"; }
bool ALLOW_DEV_SETUP "$ALLOW_DEV_SETUP"
bool TEST_ADAPTER "$TEST_ADAPTER"

key=$(tr -d ' \t\r\n' <"$COUNCIL_KEY_FILE")
[[ $key == 0x* ]] || key=0x$key
[[ $key =~ ^0x[0-9a-fA-F]{64}$ ]] || die "COUNCIL_KEY_FILE does not hold a 32-byte hex key"

if [[ -z ${RPC_URL:-} ]]; then
  for url in ${RPC_URLS:-}; do
    if [[ $("$CAST" chain-id --rpc-url "$url" 2>/dev/null) == "$EXPECTED_CHAIN_ID" ]]; then
      RPC_URL=$url
      break
    fi
    echo "deploy: $url unreachable or not chain $EXPECTED_CHAIN_ID, trying the next RPC" >&2
  done
  [[ -n ${RPC_URL:-} ]] || die "no RPC serves chain $EXPECTED_CHAIN_ID (RPC_URLS: ${RPC_URLS:-none}); set RPC_URL"
fi
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
dev_setup=$(tr -s ' \n' ' ' <"$contracts/script/CouncilRelease.sol" | grep -oE 'DEVELOPMENT_SETUP = (true|false)' | grep -oE 'true|false') ||
  die "CouncilRelease.sol: no DEVELOPMENT_SETUP"

# Audit H-01, also enforced (authoritatively) by Deploy.s.sol before it broadcasts anything:
# refuse a DEV release off the test chains here too, before the build and any RPC spend.
case $chain_id in
  31337 | 11155111 | 10200) test_chain=true ;;
  *) test_chain=false ;;
esac
if [[ $dev_setup == true && $test_chain == false ]]; then
  if [[ $ALLOW_DEV_SETUP != true ]]; then
    die "$release_tag is a DEVELOPMENT_SETUP release (one-party phase 2: its operator can forge every" \
      "proof); refused on chain $chain_id. Run the multi-party ceremony (circuits/scripts/ceremony)," \
      "or set ALLOW_DEV_SETUP=true for a rehearsal network only."
  fi
  cat >&2 <<WARN
deploy: ##########################################################################
deploy: WARNING: ALLOW_DEV_SETUP=true: deploying the DEVELOPMENT_SETUP release
deploy: WARNING: $release_tag to chain $chain_id ($NETWORK), which is not a test chain.
deploy: WARNING: its phase 2 had ONE contributor, who can forge every deal and
deploy: WARNING: partial proof. Rehearsals only; never protect real elections.
deploy: ##########################################################################
WARN
fi

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
  echo "deploy: verifiers + CouncilManager ($release_tag, $release_id) on chain $chain_id ($NETWORK)"
  PRIVATE_KEY=$key CIRCUIT_RELEASE_ID=$release_id ALLOW_DEV_SETUP=$ALLOW_DEV_SETUP \
    "$FORGE" script script/Deploy.s.sol "${script_args[@]}"
  run=$(broadcast Deploy.s.sol)
  MANAGER=$(created "$run" CouncilManager)
  [[ -n $MANAGER ]] || die "no CouncilManager in $run"
  cp "$run" "$STATE/$chain_id-deploy-manager.json"
fi
manager_run=$STATE/$chain_id-deploy-manager.json
[[ -f $manager_run ]] || die "MANAGER given but $manager_run (the forge broadcast of its deployment) is missing"

adapter=
if [[ $TEST_ADAPTER == true ]]; then
  echo "deploy: test adapter for manager $MANAGER"
  PRIVATE_KEY=$key MANAGER=$MANAGER \
    "$FORGE" script ../scripts/sepolia/DeployTestAdapter.s.sol "${script_args[@]}"
  adapter_run=$(broadcast DeployTestAdapter.s.sol)
  # forge leaves contractName null for a script outside the project; it holds exactly one CREATE.
  adapter=$(jq -r '[.transactions[] | select(.transactionType == "CREATE")] | if length == 1 then .[0].contractAddress else empty end' "$adapter_run")
  [[ -n $adapter ]] || die "no MockCouncilAdapter in $adapter_run"
  cp "$adapter_run" "$STATE/$chain_id-deploy-adapter.json"
fi
unset key

# Re-check the deployment from chain state alone.
call() { "$CAST" call "$MANAGER" "$1" --rpc-url "$RPC_URL"; }
deal=$("$CAST" parse-bytes32-address "$(call 'dealVerifier()')")
partial=$("$CAST" parse-bytes32-address "$(call 'partialVerifier()')")
views=$("$CAST" parse-bytes32-address "$(call 'views()')")
[[ $(call 'circuitReleaseId()') == "$release_id" ]] || die "manager circuitReleaseId differs from the pin"
[[ $("$CAST" to-dec "$(call 'protocolVersion()')") == 2 ]] || die "manager is not a protocol v2 CouncilManager"
# The constructor's two CREATEs: views at nonce 1 (also served by views()), ops at nonce 2.
[[ $("$CAST" compute-address "$MANAGER" --nonce 1 | grep -oE '0x[0-9a-fA-F]{40}' | tr A-F a-f) == "${views,,}" ]] ||
  die "views() is not the manager's first CREATE"
ops=$("$CAST" compute-address "$MANAGER" --nonce 2 | grep -oE '0x[0-9a-fA-F]{40}')
# Runtime code a contract of the local build must carry, with its immutables (all bytes32 here)
# spliced in at the compiler's offsets.
expected_runtime() {
  jq -r --arg imm "${2:-}" '
    .deployedBytecode as $b | ($b.object | ltrimstr("0x")) as $code
    | [($b.immutableReferences // {})[][] | {start, length}] | sort_by(.start)
    | if length > 0 and $imm == "" then error("immutables but no value") else . end
    | reduce .[] as $r ({out: "", at: 0};
        .out += $code[.at * 2:$r.start * 2] + ($imm | ltrimstr("0x")) | .at = $r.start + $r.length)
    | .out + $code[.at * 2:] | "0x" + .' "$contracts/out/$1.sol/$1.json"
}
views_hash=$("$CAST" codehash "$views" --rpc-url "$RPC_URL")
ops_hash=$("$CAST" codehash "$ops" --rpc-url "$RPC_URL")
[[ $views_hash == "$("$CAST" keccak "$(expected_runtime CouncilViews)")" ]] ||
  die "CouncilViews at $views is not the local build's code"
[[ $ops_hash == "$("$CAST" keccak "$(expected_runtime CouncilOps "$release_id")")" ]] ||
  die "no CouncilOps of the local build at $ops (the manager's second CREATE)"
deal_hash=$("$CAST" codehash "$deal" --rpc-url "$RPC_URL")
partial_hash=$("$CAST" codehash "$partial" --rpc-url "$RPC_URL")
[[ $deal_hash == "$deal_pin" ]] || die "DealVerifier codehash $deal_hash != pin $deal_pin"
[[ $partial_hash == "$partial_pin" ]] || die "PartialVerifier codehash $partial_hash != pin $partial_pin"
if [[ -n $adapter ]]; then
  registry=$("$CAST" parse-bytes32-address "$("$CAST" call "$adapter" 'registry()' --rpc-url "$RPC_URL")")
  [[ $("$CAST" parse-bytes32-address "$("$CAST" call "$adapter" 'manager()' --rpc-url "$RPC_URL")") == "$("$CAST" to-check-sum-address "$MANAGER")" ]] ||
    die "adapter is bound to another manager"
fi
echo "deploy: verifier code hashes match CouncilRelease.sol; manager bound to $release_id"
echo "deploy: CouncilViews $views and CouncilOps $ops match the local build"

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
adapter_record=null
if [[ -n $adapter ]]; then
  adapter_record=$(jq -n --arg address "$adapter" --arg registry "$registry" \
    --arg codehash "$("$CAST" codehash "$adapter" --rpc-url "$RPC_URL")" \
    --argjson tx "$(receipt_of "$adapter_run" "$adapter")" \
    '{address: $address, codehash: $codehash, registry: ($registry | ascii_downcase), testOnly: true} + $tx')
fi
jq -n \
  --arg chainId "$chain_id" --arg tag "$release_tag" --arg releaseId "$release_id" \
  --argjson developmentSetup "$dev_setup" \
  --argjson allowDevSetup "$([[ $dev_setup == true && $test_chain == false ]] && echo true || echo false)" \
  --arg deployer "$(jq -r '.transactions[0].transaction.from' "$manager_run")" \
  --arg manager "$MANAGER" --arg views "$views" --arg deal "$deal" --arg partial "$partial" \
  --arg dealHash "$deal_hash" --arg partialHash "$partial_hash" \
  --arg managerHash "$("$CAST" codehash "$MANAGER" --rpc-url "$RPC_URL")" \
  --arg viewsHash "$views_hash" --arg ops "$ops" --arg opsHash "$ops_hash" \
  --argjson dealTx "$deal_tx" \
  --argjson partialTx "$partial_tx" \
  --argjson managerTx "$manager_receipt" \
  --argjson adapter "$adapter_record" \
  '{
    chainId: ($chainId | tonumber),
    protocolVersion: 2,
    circuitRelease: ({tag: $tag, circuitReleaseId: $releaseId, developmentSetup: $developmentSetup}
      + if $allowDevSetup then {allowDevSetup: true} else {} end),
    deployer: ($deployer | ascii_downcase),
    deploymentBlock: $managerTx.block,
    contracts: ({
      DealVerifier: ({address: $deal, codehash: $dealHash} + $dealTx),
      PartialVerifier: ({address: $partial, codehash: $partialHash} + $partialTx),
      CouncilManager: ({address: $manager, codehash: $managerHash} + $managerTx),
      CouncilViews: ({address: $views, codehash: $viewsHash, createdBy: "CouncilManager constructor (CREATE nonce 1)"} + ($managerTx | {tx, block})),
      CouncilOps: ({address: $ops, codehash: $opsHash, createdBy: "CouncilManager constructor (CREATE nonce 2)"} + ($managerTx | {tx, block}))
    } + if $adapter == null then {} else {MockCouncilAdapter: $adapter} end)
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
  verify "$ops" src/CouncilOps.sol:CouncilOps --constructor-args "$("$CAST" abi-encode 'f(bytes32)' "$release_id")"
  if [[ -n $adapter ]]; then
    verify "$adapter" test/mocks/MockCouncilAdapter.sol:MockCouncilAdapter \
      --constructor-args "$("$CAST" abi-encode 'f(address)' "$MANAGER")"
  fi
  unset ETHERSCAN_API_KEY
fi
