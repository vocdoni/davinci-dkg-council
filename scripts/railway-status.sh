#!/usr/bin/env bash
# Show the Council services of a Railway project: latest deployment, domain, log tail, and the
# relayer's /v1/health. Addresses and hashes in the logs are shortened.
#
#   RAILWAY_TOKEN_FILE=railway-api-key RAILWAY_PROJECT_ID=… RAILWAY_ENVIRONMENT_ID=… \
#   scripts/railway-status.sh [lines]      # default 20 log lines per service
#
#   SERVICES   default "council-relayer council-ui"
set -euo pipefail
# shellcheck source=scripts/railway-lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/railway-lib.sh"
lines=${1:-20}
: "${SERVICES:=council-relayer council-ui}"

for name in $SERVICES; do
	service=$(rw_service "$name")
	rw_vars "$rw_tmp/v" project="$RAILWAY_PROJECT_ID" env="$RAILWAY_ENVIRONMENT_ID" service="$service"
	resp=$(rw_gql 'query($project: String!, $env: String!, $service: String!) {
		deployments(first: 1, input: {projectId: $project, environmentId: $env, serviceId: $service}) { edges { node { id status createdAt meta } } }
		domains(projectId: $project, environmentId: $env, serviceId: $service) { serviceDomains { domain } } }' "$rw_tmp/v")
	read -r id status created domain msg < <(python3 -c 'import json, sys
d = json.loads(sys.argv[1])
if d.get("errors"): sys.exit("railway error: " + json.dumps(d["errors"])[:400])
e = d["data"]["deployments"]["edges"]; n = e[0]["node"] if e else {}
s = d["data"]["domains"]["serviceDomains"]
print(n.get("id", "-"), n.get("status", "-"), n.get("createdAt", "-"), s[0]["domain"] if s else "-",
      (n.get("meta") or {}).get("message") or "-")' "$resp")
	echo "== $name  https://$domain  deployment $status ($created, $msg)"
	if [[ $id != - ]]; then
		rw_vars "$rw_tmp/v" id="$id"
		python3 -c 'import json, sys; v = json.load(open(sys.argv[1])); v["limit"] = int(sys.argv[2]); print(json.dumps(v))' "$rw_tmp/v" "$lines" >"$rw_tmp/v2"
		rw_gql 'query($id: String!, $limit: Int!) { deploymentLogs(deploymentId: $id, limit: $limit) { timestamp message attributes { key value } } }' "$rw_tmp/v2" |
			python3 -c 'import json, re, sys
d = json.load(sys.stdin)
for l in (d.get("data") or {}).get("deploymentLogs") or []:
    attrs = " ".join(a["key"] + "=" + a["value"] for a in l.get("attributes") or [] if a["key"] not in ("level", "t"))
    m = re.sub(r"\x1b\[[0-9;]*m", "", l["message"]) + (" " + attrs if attrs else "")
    print(" ", l["timestamp"][11:19], re.sub(r"(0x[0-9a-fA-F]{6})[0-9a-fA-F]{8,}", r"\1…", m)[:200])
if d.get("errors"): print(json.dumps(d["errors"])[:300])'
	fi
	if [[ $name == *relayer* && $domain != - ]]; then
		echo "  health: $(curl -sS --max-time 20 "https://$domain/v1/health" || true)"
	fi
done
