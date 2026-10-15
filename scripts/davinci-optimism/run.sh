#!/usr/bin/env bash
# The DAVINCI + Council round trip on OP Mainnet: the Gnosis script (davinci-gnosis/roundtrip.gnosis.ts)
# with the OP record and OP defaults. Same prerequisites as davinci-gnosis/run.sh (a `council`
# davinci-sequencer for the registry in deployment.json, a file server, a built davinci-sdk), but
# the relayer may be the hosted one (open mode: COUNCIL_RELAYER_URL, no token). Real ETH is spent.
#
#   DAVINCI_ORGANIZER_KEY_FILE=... COUNCIL_RELAYER_URL=https://... DAVINCI_SEQUENCER_URL=... \
#     DAVINCI_FILES_DIR=... DAVINCI_FILES_URL=... scripts/davinci-optimism/run.sh
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export COUNCIL_DEPLOYMENT=${COUNCIL_DEPLOYMENT:-$here/deployment.json}
export COUNCIL_RUN_DIR=${COUNCIL_RUN_DIR:-$HOME/.davinci-optimism/council-davinci}
exec "$here/../davinci-gnosis/run.sh" "$@"
