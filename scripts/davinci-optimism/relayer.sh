#!/usr/bin/env bash
# A local Council relayer for the OP round trip (the hosted one needs none of this); see
# davinci-gnosis/relayer.sh. COUNCIL_RELAYER_KEY_FILE as there.
set -euo pipefail
here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
export COUNCIL_DEPLOYMENT=${COUNCIL_DEPLOYMENT:-$here/deployment.json}
export COUNCIL_RUN_DIR=${COUNCIL_RUN_DIR:-$HOME/.davinci-optimism/council-davinci}
exec "$here/../davinci-gnosis/relayer.sh" "$@"
