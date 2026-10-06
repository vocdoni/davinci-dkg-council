# Shared helpers for scripts/railway-*.sh: Railway's GraphQL API with a workspace token, and
# `railway up` with a short-lived project token. Sourced, not executed. Needs curl, python3, git
# and npx (Node 22). See docs/deployments.md, "Hosting on Railway".
#
#   RAILWAY_TOKEN_FILE      file holding a Railway workspace (or account) token, default
#                           ./railway-api-key (git-ignored); never printed
#   RAILWAY_PROJECT_ID      the project (projectCreate, or the dashboard)
#   RAILWAY_ENVIRONMENT_ID  its environment, usually `production`
#   RAILWAY_CLI             default `npx -y @railway/cli@5`

: "${RAILWAY_TOKEN_FILE:=railway-api-key}"
: "${RAILWAY_PROJECT_ID:?project id (projectCreate output)}"
: "${RAILWAY_ENVIRONMENT_ID:?environment id (usually the production environment of the project)}"
: "${RAILWAY_CLI:=npx -y @railway/cli@5}"
RAILWAY_API=https://backboard.railway.com/graphql/v2

root=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
rw_tmp=$(mktemp -d)
chmod 700 "$rw_tmp"
trap 'rm -rf "$rw_tmp"' EXIT

die() { echo "${0##*/}: $*" >&2; exit 1; }
[[ -r $RAILWAY_TOKEN_FILE ]] || die "RAILWAY_TOKEN_FILE $RAILWAY_TOKEN_FILE is not readable"

# rw_gql QUERY [VARS_JSON_FILE]: post one GraphQL document, print the JSON response. Variables
# travel in a 0600 file so a secret among them never becomes a process argument.
rw_gql() {
	python3 - "$1" "${2:-}" >"$rw_tmp/body" <<'PY'
import json, sys
q, vf = sys.argv[1], sys.argv[2]
print(json.dumps({"query": q, "variables": json.load(open(vf)) if vf else {}}))
PY
	# The token goes to curl through a config file on stdin, not the command line.
	printf 'header = "Authorization: Bearer %s"\n' "$(tr -d '[:space:]' <"$RAILWAY_TOKEN_FILE")" |
		curl -sS --max-time 90 -K - "$RAILWAY_API" -H 'Content-Type: application/json' --data @"$rw_tmp/body"
}

# rw_field RESPONSE PATH: print a dot-separated JSON path, or fail on a GraphQL error.
rw_field() {
	python3 -c 'import json, sys
d = json.loads(sys.argv[1])
if d.get("errors"): sys.exit("railway error: " + json.dumps(d["errors"])[:400])
for k in sys.argv[2].split("."):
    d = d[int(k)] if isinstance(d, list) else d[k]
print(d if not isinstance(d, (dict, list)) else json.dumps(d))' "$1" "$2"
}

# rw_vars FILE KEY=VALUE…: write a GraphQL variables file (0600) from plain pairs.
rw_vars() {
	local f=$1
	shift
	python3 - "$@" >"$f" <<'PY'
import json, sys
print(json.dumps(dict(a.split("=", 1) for a in sys.argv[1:])))
PY
	chmod 600 "$f"
}

# rw_service NAME: print the id of service NAME, creating an empty one if the project has none.
rw_service() {
	local resp id
	rw_vars "$rw_tmp/v" project="$RAILWAY_PROJECT_ID"
	resp=$(rw_gql 'query($project: String!) { project(id: $project) { services { edges { node { id name } } } } }' "$rw_tmp/v")
	id=$(python3 -c 'import json, sys
d = json.loads(sys.argv[1])
if d.get("errors"): sys.exit("railway error: " + json.dumps(d["errors"])[:400])
print(next((e["node"]["id"] for e in d["data"]["project"]["services"]["edges"] if e["node"]["name"] == sys.argv[2]), ""))' "$resp" "$1")
	if [[ -z $id ]]; then
		python3 -c 'import json, sys; print(json.dumps({"input": {"projectId": sys.argv[1], "environmentId": sys.argv[2], "name": sys.argv[3]}}))' \
			"$RAILWAY_PROJECT_ID" "$RAILWAY_ENVIRONMENT_ID" "$1" >"$rw_tmp/v"
		resp=$(rw_gql 'mutation($input: ServiceCreateInput!) { serviceCreate(input: $input) { id } }' "$rw_tmp/v")
		id=$(rw_field "$resp" data.serviceCreate.id)
		echo "created service $1 ($id)" >&2
	fi
	echo "$id"
}

# rw_domain SERVICE_ID PORT: print the service's Railway domain (*.up.railway.app), creating
# one that routes to PORT if it has none.
rw_domain() {
	local resp domain
	rw_vars "$rw_tmp/v" project="$RAILWAY_PROJECT_ID" env="$RAILWAY_ENVIRONMENT_ID" service="$1"
	resp=$(rw_gql 'query($project: String!, $env: String!, $service: String!) { domains(projectId: $project, environmentId: $env, serviceId: $service) { serviceDomains { domain } } }' "$rw_tmp/v")
	domain=$(python3 -c 'import json, sys
d = json.loads(sys.argv[1])
if d.get("errors"): sys.exit("railway error: " + json.dumps(d["errors"])[:400])
s = d["data"]["domains"]["serviceDomains"]
print(s[0]["domain"] if s else "")' "$resp")
	if [[ -z $domain ]]; then
		python3 -c 'import json, sys; print(json.dumps({"input": {"environmentId": sys.argv[1], "serviceId": sys.argv[2], "targetPort": int(sys.argv[3])}}))' \
			"$RAILWAY_ENVIRONMENT_ID" "$1" "$2" >"$rw_tmp/v"
		resp=$(rw_gql 'mutation($input: ServiceDomainCreateInput!) { serviceDomainCreate(input: $input) { domain } }' "$rw_tmp/v")
		domain=$(rw_field "$resp" data.serviceDomainCreate.domain)
		echo "created domain $domain -> port $2" >&2
	fi
	echo "$domain"
}

# rw_volume SERVICE_ID MOUNT_PATH: attach a volume at MOUNT_PATH unless the service has one.
rw_volume() {
	local resp has
	rw_vars "$rw_tmp/v" project="$RAILWAY_PROJECT_ID"
	resp=$(rw_gql 'query($project: String!) { project(id: $project) { volumes { edges { node { volumeInstances { edges { node { serviceId environmentId mountPath } } } } } } } }' "$rw_tmp/v")
	has=$(python3 -c 'import json, sys
d = json.loads(sys.argv[1])
if d.get("errors"): sys.exit("railway error: " + json.dumps(d["errors"])[:400])
print(any(i["node"]["serviceId"] == sys.argv[2] and i["node"]["environmentId"] == sys.argv[3]
          for v in d["data"]["project"]["volumes"]["edges"] for i in v["node"]["volumeInstances"]["edges"]))' "$resp" "$1" "$RAILWAY_ENVIRONMENT_ID")
	[[ $has == True ]] && return 0
	rw_vars "$rw_tmp/v" projectId="$RAILWAY_PROJECT_ID" environmentId="$RAILWAY_ENVIRONMENT_ID" serviceId="$1" mountPath="$2"
	python3 -c 'import json, sys; print(json.dumps({"input": json.load(open(sys.argv[1]))}))' "$rw_tmp/v" >"$rw_tmp/v2"
	resp=$(rw_gql 'mutation($input: VolumeCreateInput!) { volumeCreate(input: $input) { id } }' "$rw_tmp/v2")
	echo "created volume $(rw_field "$resp" data.volumeCreate.id) at $2" >&2
}

# rw_instance SERVICE_ID JSON: update the service instance settings (restart policy, health check…).
rw_instance() {
	python3 -c 'import json, sys; print(json.dumps({"service": sys.argv[1], "env": sys.argv[2], "input": json.loads(sys.argv[3])}))' \
		"$1" "$RAILWAY_ENVIRONMENT_ID" "$2" >"$rw_tmp/v"
	rw_field "$(rw_gql 'mutation($service: String!, $env: String!, $input: ServiceInstanceUpdateInput!) { serviceInstanceUpdate(serviceId: $service, environmentId: $env, input: $input) }' "$rw_tmp/v")" \
		data.serviceInstanceUpdate >/dev/null
}

# rw_upsert_vars SERVICE_ID VARS_FILE: merge the variables in VARS_FILE (a JSON object, 0600)
# into the service without triggering a deployment.
rw_upsert_vars() {
	python3 -c 'import json, sys; print(json.dumps({"input": {"projectId": sys.argv[1], "environmentId": sys.argv[2], "serviceId": sys.argv[3], "variables": json.load(open(sys.argv[4])), "skipDeploys": True}}))' \
		"$RAILWAY_PROJECT_ID" "$RAILWAY_ENVIRONMENT_ID" "$1" "$2" >"$rw_tmp/v"
	chmod 600 "$rw_tmp/v"
	rw_field "$(rw_gql 'mutation($input: VariableCollectionUpsertInput!) { variableCollectionUpsert(input: $input) }' "$rw_tmp/v")" \
		data.variableCollectionUpsert >/dev/null
	rm -f "$rw_tmp/v"
}

# rw_stage DIR PATH…: export PATHs of the committed tree (GIT_REF, default HEAD) into DIR.
rw_stage() {
	local dir=$1
	shift
	[[ -z $(git -C "$root" status --porcelain -- "$@") ]] ||
		echo "warning: uncommitted changes under $* are NOT deployed (${GIT_REF:-HEAD} is)" >&2
	mkdir -p "$dir"
	git -C "$root" archive "${GIT_REF:-HEAD}" -- "$@" | tar -x -C "$dir"
}

# rw_up SERVICE_ID DIR MESSAGE: upload DIR and build its root Dockerfile on Railway. A project
# token is created for the upload and deleted afterwards.
rw_up() {
	local resp name tok_id rc=0
	name="cli-up-$(date -u +%Y%m%dT%H%M%SZ)"
	rw_vars "$rw_tmp/v" projectId="$RAILWAY_PROJECT_ID" environmentId="$RAILWAY_ENVIRONMENT_ID" name="$name"
	python3 -c 'import json, sys; print(json.dumps({"input": json.load(open(sys.argv[1]))}))' "$rw_tmp/v" >"$rw_tmp/v2"
	resp=$(rw_gql 'mutation($input: ProjectTokenCreateInput!) { projectTokenCreate(input: $input) }' "$rw_tmp/v2")
	rw_field "$resp" data.projectTokenCreate >"$rw_tmp/ptok"
	chmod 600 "$rw_tmp/ptok"
	(
		cd "$2"
		RAILWAY_TOKEN=$(cat "$rw_tmp/ptok") $RAILWAY_CLI up . --path-as-root --no-gitignore --service "$1" --ci --message "$3"
	) || rc=$?
	rm -f "$rw_tmp/ptok"
	rw_vars "$rw_tmp/v" project="$RAILWAY_PROJECT_ID"
	resp=$(rw_gql 'query($project: String!) { projectTokens(projectId: $project) { edges { node { id name } } } }' "$rw_tmp/v")
	tok_id=$(python3 -c 'import json, sys
d = json.loads(sys.argv[1])
print(next((e["node"]["id"] for e in d.get("data", {}).get("projectTokens", {}).get("edges", []) if e["node"]["name"] == sys.argv[2]), ""))' "$resp" "$name")
	if [[ -n $tok_id ]]; then
		rw_vars "$rw_tmp/v" id="$tok_id"
		rw_gql 'mutation($id: String!) { projectTokenDelete(id: $id) }' "$rw_tmp/v" >/dev/null
	else
		echo "warning: could not find project token $name to delete it" >&2
	fi
	return "$rc"
}
