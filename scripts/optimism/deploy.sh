#!/usr/bin/env bash
# Deploy Council to OP Mainnet (chain 10): verifiers + CouncilManager
# (solidity/script/Deploy.s.sol, pinned to solidity/script/CouncilRelease.sol), a chain-state
# re-check and the record scripts/optimism/deployment.json. No test adapter by default: on OP the
# requester is the DAVINCI ProcessRegistry's CouncilAdapter. The work is
# scripts/lib/deploy-council.sh, which documents every variable.
#
#   COUNCIL_KEY_FILE=~/optimism-privkey.txt ALLOW_DEV_SETUP=true scripts/optimism/deploy.sh
#
# OP Mainnet is a production chain: a DEVELOPMENT_SETUP circuit release (one-party phase 2, whose
# operator can forge every proof) is refused, here and by Deploy.s.sol before it broadcasts,
# unless ALLOW_DEV_SETUP=true is passed explicitly (default false). The owner accepted
# circuits-v1 for the OP deployment as for the Gnosis production beta.
# Defaults: the first of RPC_URLS serving chain 10 (RPC_URL overrides), TEST_ADAPTER false,
# DEPLOYMENT_OUT scripts/optimism/deployment.json, state in COUNCIL_OPTIMISM_STATE (default
# ~/.davinci-dkg-council/optimism). OP runs no state gas (EIP-8037): leave COUNCIL_STATE_GAS unset
# or false. Every transaction also pays OP's L1 data fee, which forge does not show.
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export NETWORK=optimism
export RPC_URLS=${RPC_URLS:-"https://optimism-rpc.publicnode.com https://optimism.drpc.org https://mainnet.optimism.io"}
export EXPECTED_CHAIN_ID=${EXPECTED_CHAIN_ID:-10}
export ALLOW_DEV_SETUP=${ALLOW_DEV_SETUP:-false}
export TEST_ADAPTER=${TEST_ADAPTER:-false}
export DEPLOYMENT_OUT=${DEPLOYMENT_OUT:-$here/deployment.json}
export COUNCIL_DEPLOY_STATE=${COUNCIL_OPTIMISM_STATE:-$HOME/.davinci-dkg-council/optimism}
exec bash "$here/../lib/deploy-council.sh"
