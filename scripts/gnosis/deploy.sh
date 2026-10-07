#!/usr/bin/env bash
# Deploy Council to Gnosis Chain (chain 100): verifiers + CouncilManager
# (solidity/script/Deploy.s.sol, pinned to solidity/script/CouncilRelease.sol), a chain-state
# re-check and the record scripts/gnosis/deployment.json. No test adapter by default: on Gnosis the
# requester is the DAVINCI ProcessRegistry's CouncilAdapter. A TEST deployment's rehearsals
# (scripts/gnosis/run.sh) add the test-only MockCouncilAdapter afterwards, from a key of their own
# that becomes its registry (recorded with "testOnly": true). The work is
# scripts/lib/deploy-council.sh, which documents every variable.
#
#   COUNCIL_KEY_FILE=~/gnosis_privkey.txt scripts/gnosis/deploy.sh
#   MANAGER=0x… TEST_ADAPTER=true ALLOW_DEV_SETUP=true COUNCIL_KEY_FILE=<tester key> scripts/gnosis/deploy.sh
#
# Gnosis is a production chain: a DEVELOPMENT_SETUP circuit release (one-party phase 2, whose
# operator can forge every proof) is refused, here and by Deploy.s.sol before it broadcasts,
# unless ALLOW_DEV_SETUP=true, passed explicitly (default false) and meant for a rehearsal
# deployment only. Production deploys the multi-party ceremony release (circuits/scripts/ceremony).
# Defaults: the first of RPC_URLS serving chain 100 (RPC_URL overrides), TEST_ADAPTER false,
# DEPLOYMENT_OUT scripts/gnosis/deployment.json, state in COUNCIL_GNOSIS_STATE (default
# ~/.davinci-dkg-council/gnosis).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export NETWORK=gnosis
export RPC_URLS=${RPC_URLS:-"https://rpc.gnosischain.com https://gnosis-rpc.publicnode.com https://gnosis.drpc.org"}
export EXPECTED_CHAIN_ID=${EXPECTED_CHAIN_ID:-100}
export ALLOW_DEV_SETUP=${ALLOW_DEV_SETUP:-false}
export TEST_ADAPTER=${TEST_ADAPTER:-false}
export DEPLOYMENT_OUT=${DEPLOYMENT_OUT:-$here/deployment.json}
export COUNCIL_DEPLOY_STATE=${COUNCIL_GNOSIS_STATE:-$HOME/.davinci-dkg-council/gnosis}
exec bash "$here/../lib/deploy-council.sh"
