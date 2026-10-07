#!/usr/bin/env bash
# Deploy Council to Sepolia: verifiers + CouncilManager (solidity/script/Deploy.s.sol, pinned to
# solidity/script/CouncilRelease.sol), the MockCouncilAdapter test requester the ceremony run
# uses, then a chain-state re-check and the record scripts/sepolia/deployment.json. The work is
# scripts/lib/deploy-council.sh, which documents every variable.
#
#   COUNCIL_KEY_FILE=~/sepolia_privkey.txt scripts/sepolia/deploy.sh
#
# Sepolia (11155111) is a test chain: the DEVELOPMENT_SETUP release deploys without
# ALLOW_DEV_SETUP, which is still passed to Deploy.s.sol explicitly (default false).
# Defaults: RPC_URL https://ethereum-sepolia-rpc.publicnode.com, EXPECTED_CHAIN_ID 11155111,
# TEST_ADAPTER true, DEPLOYMENT_OUT scripts/sepolia/deployment.json, state in
# COUNCIL_SEPOLIA_STATE (default ~/.davinci-dkg-council/sepolia).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export NETWORK=sepolia
export RPC_URL=${RPC_URL:-https://ethereum-sepolia-rpc.publicnode.com}
export EXPECTED_CHAIN_ID=${EXPECTED_CHAIN_ID:-11155111}
export ALLOW_DEV_SETUP=${ALLOW_DEV_SETUP:-false}
export TEST_ADAPTER=${TEST_ADAPTER:-true}
export DEPLOYMENT_OUT=${DEPLOYMENT_OUT:-$here/deployment.json}
export COUNCIL_DEPLOY_STATE=${COUNCIL_SEPOLIA_STATE:-$HOME/.davinci-dkg-council/sepolia}
exec bash "$here/../lib/deploy-council.sh"
