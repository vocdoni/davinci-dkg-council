#!/usr/bin/env bash
# Deploy (or redeploy) the Council relayer as a Railway service, built on Railway from
# relayer/Dockerfile at the committed tree: no registry, so a private repository works. Creates
# the service, a volume for its state, a *.up.railway.app domain and the web app's domain (for
# CORS) on the first run; every run updates the variables and uploads a new build. See
# docs/deployments.md, "Hosting on Railway".
#
#   RAILWAY_TOKEN_FILE=railway-api-key RAILWAY_PROJECT_ID=… RAILWAY_ENVIRONMENT_ID=… \
#   COUNCIL_KEY_FILE=~/.davinci-dkg-council/sepolia-relayer.key scripts/railway-deploy-relayer.sh
#
# Environment (besides scripts/railway-lib.sh's):
#   COUNCIL_KEY_FILE     file holding the relayer's hot key (0x + 64 hex), used by nothing else;
#                        sent only inside a request body, never printed or passed as an argument
#   DEPLOYMENT           deployment record, default scripts/sepolia/deployment.json: the manager
#                        and the start block of the combine worker
#   RPC_URLS             default publicnode, then Tenderly's gateway
#   DAILY_BUDGET_WEI     default 60000000000000000 (0.06 ETH per rolling 24 h)
#   STATE_GAS            default true: Sepolia prices state gas separately since Glamsterdam
#                        (EIP-8037), so gas limits may exceed 2^24 (COUNCIL_STATE_GAS); set false
#                        for an Osaka chain such as Gnosis
#   CORS_ORIGINS         default https://<the UI service's Railway domain>
#   TRUSTED_PROXIES      default 0.0.0.0/0,::/0: every hop is Railway's. Its edge drops any
#                        client-supplied X-Forwarded-For and sends "<client>, <edge>" from
#                        100.64.0.0/10, so trusting all hops makes the relayer use the left-most
#                        one, the real client (with 100.64.0.0/10 alone every client would be
#                        the edge's address and share one rate limit)
#   SERVICE_NAME         default council-relayer;  UI_SERVICE_NAME  default council-ui
#   EXTRA_VARS           more COUNCIL_* settings, e.g. "COUNCIL_MAX_FEE_WEI=20000000000 COUNCIL_API_TOKENS=…"
set -euo pipefail
# shellcheck source=scripts/railway-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/railway-lib.sh"

: "${COUNCIL_KEY_FILE:?file holding the relayer hot key}"
: "${DEPLOYMENT:=$root/scripts/sepolia/deployment.json}"
: "${RPC_URLS:=https://ethereum-sepolia-rpc.publicnode.com,https://sepolia.gateway.tenderly.co}"
: "${DAILY_BUDGET_WEI:=60000000000000000}"
: "${STATE_GAS:=true}"
: "${TRUSTED_PROXIES:=0.0.0.0/0,::/0}"
: "${SERVICE_NAME:=council-relayer}"
: "${UI_SERVICE_NAME:=council-ui}"
: "${EXTRA_VARS:=}"

[[ -r $COUNCIL_KEY_FILE ]] || die "COUNCIL_KEY_FILE $COUNCIL_KEY_FILE is not readable"
[[ -r $DEPLOYMENT ]] || die "no deployment record at $DEPLOYMENT"
manager=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["contracts"]["CouncilManager"]["address"])' "$DEPLOYMENT")
start_block=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["deploymentBlock"])' "$DEPLOYMENT")

service=$(rw_service "$SERVICE_NAME")
domain=$(rw_domain "$service" 8080)
if [[ -z ${CORS_ORIGINS:-} ]]; then
	ui_service=$(rw_service "$UI_SERVICE_NAME")
	CORS_ORIGINS=https://$(rw_domain "$ui_service" 80)
fi

# Variables. The hot key is read from its file straight into the 0600 variables file.
python3 - "$COUNCIL_KEY_FILE" "$rw_tmp/vars" <<PY
import json, re, sys
key = open(sys.argv[1]).read().strip()
key = key if key.startswith("0x") else "0x" + key
if not re.fullmatch(r"0x[0-9a-fA-F]{64}", key):
    sys.exit("COUNCIL_KEY_FILE does not hold a 32-byte hex key")
v = {
    "COUNCIL_PRIVATE_KEY": key,
    "COUNCIL_RPC_URL": "$RPC_URLS",
    "COUNCIL_MANAGER_ADDRESS": "$manager",
    "COUNCIL_START_BLOCK": "$start_block",
    "COUNCIL_COMBINER_ENABLED": "true",
    "COUNCIL_DAILY_BUDGET_WEI": "$DAILY_BUDGET_WEI",
    "COUNCIL_STATE_GAS": "$STATE_GAS",
    "COUNCIL_CORS_ORIGINS": "$CORS_ORIGINS",
    "COUNCIL_TRUSTED_PROXIES": "$TRUSTED_PROXIES",
    "COUNCIL_DATA_DIR": "/data",
    "COUNCIL_PORT": "8080",
    "PORT": "8080",  # where Railway's health check and edge connect
    # Railway mounts volumes owned by root; the image runs as \`node\`.
    "RAILWAY_RUN_UID": "0",
}
v.update(a.split("=", 1) for a in "$EXTRA_VARS".split())
open(sys.argv[2], "w").write(json.dumps(v))
PY
chmod 600 "$rw_tmp/vars"
rw_upsert_vars "$service" "$rw_tmp/vars"
rm -f "$rw_tmp/vars"

rw_volume "$service" /data
# One replica: the relayer owns its key's nonces. Railway waits for /v1/health (it reads the
# chain id and the hot key's balance) before it routes to a new deployment.
rw_instance "$service" '{"numReplicas": 1, "restartPolicyType": "ALWAYS", "healthcheckPath": "/v1/health", "healthcheckTimeout": 120, "sleepApplication": false}'

# Build context: the relayer's workspace packages and its Dockerfile at the root. Railway refuses
# the VOLUME instruction (the volume above replaces it).
stage=$rw_tmp/stage
rw_stage "$stage" package.json pnpm-lock.yaml pnpm-workspace.yaml sdk relayer
grep -v '^VOLUME ' "$root/relayer/Dockerfile" >"$stage/Dockerfile"
cp "$root/relayer/Dockerfile.dockerignore" "$stage/.dockerignore"

rev=$(git -C "$root" rev-parse --short "${GIT_REF:-HEAD}")
echo "deploying relayer $rev: manager $manager, start block $start_block, CORS $CORS_ORIGINS"
rw_up "$service" "$stage" "relayer $rev"
echo "relayer: https://$domain  (health: https://$domain/v1/health)"
