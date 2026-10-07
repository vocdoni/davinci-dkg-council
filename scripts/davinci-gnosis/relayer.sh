#!/usr/bin/env bash
# A Council relayer for the DAVINCI round trip on Gnosis (roundtrip.gnosis.ts): restricted mode
# (a bearer token generated here, kept in the state directory), combine worker and scheduler on,
# its own hot key. It keeps running after this script returns; `stop` ends it.
#
#   COUNCIL_RELAYER_KEY_FILE=~/.davinci-gnosis/keys/council-relayer-test.key scripts/davinci-gnosis/relayer.sh start
#   scripts/davinci-gnosis/relayer.sh stop
#
# Environment:
#   COUNCIL_RELAYER_KEY_FILE  file holding the relayer's hot key (start only; read here, passed to
#                             the relayer through its environment, never printed)
#   COUNCIL_RUN_DIR           state directory (relayer state, token, logs), default ~/.davinci-gnosis/council-davinci
#   COUNCIL_RPC_URL           comma-separated Gnosis RPCs, default publicnode, gnosischain.com, drpc
#   COUNCIL_PORT              default 8797
set -euo pipefail

here=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
root=$(cd "$here/../.." && pwd)
RUN_DIR=${COUNCIL_RUN_DIR:-$HOME/.davinci-gnosis/council-davinci}
PORT=${COUNCIL_PORT:-8797}
RPCS=${COUNCIL_RPC_URL:-https://gnosis-rpc.publicnode.com,https://rpc.gnosischain.com,https://gnosis.drpc.org}
manager=$(jq -r .council.manager "$here/deployment.json")
start_block=$(jq -r .council.deploymentBlock "$here/deployment.json")
die() { echo "relayer: $*" >&2; exit 1; }

case ${1:-} in
  stop)
    [[ -f $RUN_DIR/relayer.pid ]] || die "not running (no $RUN_DIR/relayer.pid)"
    kill "$(cat "$RUN_DIR/relayer.pid")" && rm -f "$RUN_DIR/relayer.pid" && echo "relayer: stopped"
    exit 0
    ;;
  start) ;;
  *) die "usage: $0 start|stop" ;;
esac

: "${COUNCIL_RELAYER_KEY_FILE:?set COUNCIL_RELAYER_KEY_FILE to the file holding the relayer key}"
key=$(tr -d ' \t\r\n' <"$COUNCIL_RELAYER_KEY_FILE")
[[ $key == 0x* ]] || key=0x$key
[[ $key =~ ^0x[0-9a-fA-F]{64}$ ]] || die "COUNCIL_RELAYER_KEY_FILE does not hold a 32-byte hex key"

mkdir -p "$RUN_DIR/relayer" && chmod 700 "$RUN_DIR"
[[ -s $RUN_DIR/relayer.token ]] || (umask 077 && openssl rand -hex 24 >"$RUN_DIR/relayer.token")
token=$(cat "$RUN_DIR/relayer.token")

(cd "$root" && tests/node_modules/.bin/tsc -p sdk/tsconfig.json && tests/node_modules/.bin/tsc -p relayer/tsconfig.json)

log=$RUN_DIR/relayer-$(date -u +%Y%m%dT%H%M%SZ).log
COUNCIL_PRIVATE_KEY=$key \
  COUNCIL_API_TOKENS=$token \
  COUNCIL_RPC_URL=$RPCS \
  COUNCIL_MANAGER_ADDRESS=$manager \
  COUNCIL_PORT=$PORT \
  COUNCIL_HOST=127.0.0.1 \
  COUNCIL_DATA_DIR=$RUN_DIR/relayer \
  COUNCIL_COMBINER_ENABLED=true \
  COUNCIL_SCHEDULER_ENABLED=true \
  COUNCIL_START_BLOCK=$start_block \
  COUNCIL_LOG_RANGE=${COUNCIL_LOG_RANGE:-5000} \
  COUNCIL_COMBINER_POLL_MS=${COUNCIL_COMBINER_POLL_MS:-10000} \
  COUNCIL_TX_POLL_MS=${COUNCIL_TX_POLL_MS:-3000} \
  COUNCIL_DAILY_BUDGET_WEI=${COUNCIL_DAILY_BUDGET_WEI:-50000000000000000} \
  COUNCIL_ORGANIZER_DAILY_CEREMONIES=${COUNCIL_ORGANIZER_DAILY_CEREMONIES:-4} \
  COUNCIL_MAX_GRANTS=${COUNCIL_MAX_GRANTS:-4} \
  setsid nohup node "$root/relayer/dist/main.js" >"$log" 2>&1 </dev/null &
echo $! >"$RUN_DIR/relayer.pid"

for _ in $(seq 1 60); do
  kill -0 "$(cat "$RUN_DIR/relayer.pid")" 2>/dev/null || die "the relayer exited; see $log"
  /usr/bin/curl -fsS "http://127.0.0.1:$PORT/v1/health" >/dev/null 2>&1 && break
  sleep 1
done
/usr/bin/curl -fsS "http://127.0.0.1:$PORT/v1/health" || die "the relayer did not come up; see $log"
echo
echo "relayer: http://127.0.0.1:$PORT (pid $(cat "$RUN_DIR/relayer.pid"), log $log)"
