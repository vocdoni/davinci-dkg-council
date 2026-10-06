#!/usr/bin/env bash
# Deploy (or redeploy) the Council web app as a Railway service, built on Railway from
# ui/Dockerfile at the committed tree, with the six pinned circuit files baked into the image and
# served same-origin under /<release>/ (browsers cannot fetch a private repository's release
# assets, and the strict CSP stays as it is). Creates the service and its *.up.railway.app domain
# on the first run. Deploy the relayer first: its domain becomes the app's relayerUrl. See
# docs/deployments.md, "Hosting on Railway".
#
#   RAILWAY_TOKEN_FILE=railway-api-key RAILWAY_PROJECT_ID=… RAILWAY_ENVIRONMENT_ID=… \
#   scripts/railway-deploy-ui.sh
#
# Environment (besides scripts/railway-lib.sh's):
#   UI_CONFIG              starting config, default ui/public/config.sepolia.json
#   DEPLOYMENT             deployment record, default scripts/sepolia/deployment.json (manager and
#                          deployment block override UI_CONFIG's)
#   RPC_URLS               override UI_CONFIG's rpcUrls (two independent providers or more)
#   RELAYER_URL            default https://<the relayer service's Railway domain>
#   COUNCIL_ARTIFACTS_DIR  the released circuit files, default ~/.davinci-dkg-council/artifacts;
#                          each must match its sha256 pin in sdk/src/artifacts.ts
#   SERVICE_NAME           default council-ui;  RELAYER_SERVICE_NAME  default council-relayer
set -euo pipefail
# shellcheck source=scripts/railway-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/railway-lib.sh"

: "${UI_CONFIG:=ui/public/config.sepolia.json}"
: "${DEPLOYMENT:=$root/scripts/sepolia/deployment.json}"
: "${COUNCIL_ARTIFACTS_DIR:=$HOME/.davinci-dkg-council/artifacts}"
: "${SERVICE_NAME:=council-ui}"
: "${RELAYER_SERVICE_NAME:=council-relayer}"

[[ -r $DEPLOYMENT ]] || die "no deployment record at $DEPLOYMENT"
manager=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["contracts"]["CouncilManager"]["address"])' "$DEPLOYMENT")
block=$(python3 -c 'import json, sys; print(json.load(open(sys.argv[1]))["deploymentBlock"])' "$DEPLOYMENT")

service=$(rw_service "$SERVICE_NAME")
domain=$(rw_domain "$service" 80)
if [[ -z ${RELAYER_URL:-} ]]; then
	relayer_service=$(rw_service "$RELAYER_SERVICE_NAME")
	RELAYER_URL=https://$(rw_domain "$relayer_service" 8080)
fi
# nginx listens on 80; Railway's health check and edge go to $PORT.
rw_vars "$rw_tmp/vars" PORT=80
rw_upsert_vars "$service" "$rw_tmp/vars"
rw_instance "$service" '{"numReplicas": 1, "restartPolicyType": "ON_FAILURE", "healthcheckPath": "/", "sleepApplication": false}'

stage=$rw_tmp/stage
rw_stage "$stage" package.json pnpm-lock.yaml pnpm-workspace.yaml sdk ui scripts/render-ui-config.sh

# The circuit files, each checked against the SDK's pin before it goes into the image.
release=$(grep -oE "release: '[^']+'" "$stage/sdk/src/artifacts.ts" | cut -d"'" -f2)
[[ -n $release ]] || die "no release tag in sdk/src/artifacts.ts"
mkdir -p "$stage/ui/public/$release"
python3 - "$stage/sdk/src/artifacts.ts" "$COUNCIL_ARTIFACTS_DIR" "$stage/ui/public/$release" <<'PY'
import hashlib, re, shutil, sys
src, cache, out = sys.argv[1:]
pins = re.findall(r"url: `\$\{BASE\}/([\w.]+)`,\s*sha256: '(0x[0-9a-f]{64})'", open(src).read())
if len(pins) != 6: sys.exit(f"expected 6 pinned files in {src}, found {len(pins)}")
for name, pin in pins:
    h = hashlib.sha256(open(f"{cache}/{name}", "rb").read()).hexdigest()
    if "0x" + h != pin: sys.exit(f"{cache}/{name}: sha256 0x{h} is not the pin {pin}")
    shutil.copyfile(f"{cache}/{name}", f"{out}/{name}")
    print(f"  {name}  {pin}")
PY

# /config.json: rendered here and kept as is by the image build (UI_CONFIG defaults to it there).
(cd "$stage" && UI_CONFIG=$UI_CONFIG MANAGER_ADDRESS=$manager DEPLOYMENT_BLOCK=$block RPC_URLS=${RPC_URLS:-} \
	RELAYER_URL=$RELAYER_URL ARTIFACTS_BASE_URL=/$release bash scripts/render-ui-config.sh ui/public/config.json >/dev/null)
cat "$stage/ui/public/config.json"

# Railway only accepts cache mounts with its own id scheme; the build does without.
sed -E 's/--mount=type=cache,[^ ]+ //' "$root/ui/Dockerfile" >"$stage/Dockerfile"
cp "$root/ui/Dockerfile.dockerignore" "$stage/.dockerignore"

rev=$(git -C "$root" rev-parse --short "${GIT_REF:-HEAD}")
echo "deploying web app $rev with the $release circuit files, relayer $RELAYER_URL"
rw_up "$service" "$stage" "ui $rev"
echo "app: https://$domain"
