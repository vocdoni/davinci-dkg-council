#!/usr/bin/env bash
# The DAVINCI + Council round trip on Gnosis (roundtrip.gnosis.ts) against the TEST deployment in
# deployment.json. Needs, already running:
#   - the Council relayer of relayer.sh (its token in $COUNCIL_RUN_DIR/relayer.token);
#   - a davinci-sequencer `council` build for the registry, with --census-allow-private
#     (docs/davinci-integration.md, "The test sequencer");
#   - a static file server for the census and metadata files at DAVINCI_FILES_URL, serving
#     DAVINCI_FILES_DIR, reachable from this host and from the sequencer;
#   - a built davinci-sdk `council` checkout (DAVINCI_SDK_DIR).
#
#   DAVINCI_ORGANIZER_KEY_FILE=~/.davinci-gnosis/keys/davinci-org-council-test.key scripts/davinci-gnosis/run.sh
#
# Environment (defaults in roundtrip.gnosis.ts): DAVINCI_ORGANIZER_KEY_FILE (required: the
# process creator, funded), DAVINCI_SDK_DIR, DAVINCI_SEQUENCER_URL, DAVINCI_FILES_DIR,
# DAVINCI_FILES_URL, DAVINCI_SDK_ARTIFACTS, COUNCIL_RELAYER_URL, COUNCIL_RUN_DIR, COUNCIL_RPC_URL,
# COUNCIL_B_OPEN_AFTER_MIN (75), COUNCIL_RESUME (a secrets file of an earlier run: reuse its
# ceremonies), COUNCIL_ARTIFACTS_DIR (the pinned Council circuit files).
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
: "${DAVINCI_ORGANIZER_KEY_FILE:?set DAVINCI_ORGANIZER_KEY_FILE to the process creator key file}"
RUN_DIR=${COUNCIL_RUN_DIR:-$HOME/.davinci-gnosis/council-davinci}
mkdir -p "$RUN_DIR" && chmod 700 "$RUN_DIR"
log=$RUN_DIR/run-$(date -u +%Y%m%dT%H%M%SZ).log

cd "$root"
tests/node_modules/.bin/vitest run --config scripts/davinci-gnosis/vitest.config.ts "$@" 2>&1 | tee "$log"
