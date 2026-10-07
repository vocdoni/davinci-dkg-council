#!/usr/bin/env bash
# Self-check for railway-deploy-relayer.sh and railway-lib.sh against a fake Railway API (no
# network): the variables the relayer service gets (the scheduler and the combine worker on, the
# deployment's manager and start block, EXTRA_VARS on top), and that no secret — the workspace
# token, the short-lived project token, the hot key — is ever a process argument, where every
# local user can read it with `ps`. Run by the relayer tests (relayer/tests/railway.test.ts).
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
bin=$tmp/bin
mkdir -p "$bin"
real_python=$(command -v python3)
fail() { echo "FAIL: $*"; exit 1; }

ws_token=ws-secret-0123456789abcdef
project_token=project-secret-fedcba9876543210
hot_key=0x$(printf 'ab%.0s' {1..32})
printf '%s\n' "$ws_token" >"$tmp/railway-api-key"
printf '%s\n' "$hot_key" >"$tmp/hot.key"
: >"$tmp/argv.log"

# Every python3 and curl process records its arguments.
cat >"$bin/python3" <<EOF
#!/usr/bin/env bash
printf 'python3 %s\n' "\$*" >>"$tmp/argv.log"
exec "$real_python" "\$@"
EOF
cat >"$bin/curl" <<EOF
#!/usr/bin/env bash
printf 'curl %s\n' "\$*" >>"$tmp/argv.log"
exec "$real_python" "$tmp/railway_api.py" "\$@"
EOF
# The Railway CLI: records its arguments and the project token it got through its environment.
cat >"$bin/railway" <<EOF
#!/usr/bin/env bash
printf 'railway %s\n' "\$*" >>"$tmp/argv.log"
printf '%s' "\${RAILWAY_TOKEN:-}" >"$tmp/cli-token"
EOF
chmod +x "$bin/python3" "$bin/curl" "$bin/railway"

# The GraphQL endpoint: answers by operation, keeps the variables it was sent, and logs the
# curl config read from stdin (where the workspace token must arrive).
cat >"$tmp/railway_api.py" <<'PY'
import json, os, sys
d = os.environ["FAKE_RW_DIR"]
config = sys.stdin.read()
open(os.path.join(d, "auth.log"), "a").write(config)
body = next(a[1:] for a in sys.argv[1:] if a.startswith("@"))
req = json.load(open(body))
q, v = req["query"], req["variables"]
env = os.environ["RAILWAY_ENVIRONMENT_ID"]
def out(data):
    print(json.dumps({"data": data}))
if "variableCollectionUpsert" in q:
    json.dump(v["input"]["variables"], open(os.path.join(d, "vars.json"), "w"))
    out({"variableCollectionUpsert": True})
elif "projectTokenCreate" in q:
    open(os.path.join(d, "token-name"), "w").write(v["input"]["name"])
    out({"projectTokenCreate": os.environ["FAKE_PROJECT_TOKEN"]})
elif "projectTokenDelete" in q:
    open(os.path.join(d, "token-deleted"), "w").write(v["id"])
    out({"projectTokenDelete": True})
elif "projectTokens(" in q:
    name = open(os.path.join(d, "token-name")).read()
    out({"projectTokens": {"edges": [{"node": {"id": "tok-1", "name": name}}]}})
elif "serviceInstanceUpdate" in q:
    out({"serviceInstanceUpdate": True})
elif "domains(" in q:
    out({"domains": {"serviceDomains": [{"domain": v["service"] + ".up.railway.app"}]}})
elif "volumes" in q:
    inst = {"node": {"serviceId": "svc-relayer", "environmentId": env, "mountPath": "/data"}}
    out({"project": {"volumes": {"edges": [{"node": {"volumeInstances": {"edges": [inst]}}}]}}})
elif "services" in q:
    names = [("svc-relayer", "council-relayer"), ("svc-ui", "council-ui")]
    out({"project": {"services": {"edges": [{"node": {"id": i, "name": n}} for i, n in names]}}})
else:
    print(json.dumps({"errors": [{"message": "unexpected operation: " + q[:80]}]}))
PY

PATH="$bin:$PATH" FAKE_RW_DIR=$tmp FAKE_PROJECT_TOKEN=$project_token \
	RAILWAY_TOKEN_FILE=$tmp/railway-api-key RAILWAY_PROJECT_ID=proj-1 RAILWAY_ENVIRONMENT_ID=env-1 \
	RAILWAY_CLI=$bin/railway COUNCIL_KEY_FILE=$tmp/hot.key EXTRA_VARS='COUNCIL_SCHEDULER_POLL_MS=5000' \
	bash "$here/railway-deploy-relayer.sh" >"$tmp/out.log" 2>&1 || { cat "$tmp/out.log"; fail "the deploy script failed"; }

# The generated variables.
"$real_python" - "$tmp/vars.json" "$here/sepolia/deployment.json" "$hot_key" <<'PY' || fail "generated variables"
import json, sys
v = json.load(open(sys.argv[1]))
dep = json.load(open(sys.argv[2]))
want = {
    "COUNCIL_SCHEDULER_ENABLED": "true",
    "COUNCIL_COMBINER_ENABLED": "true",
    "COUNCIL_PRIVATE_KEY": sys.argv[3],
    "COUNCIL_MANAGER_ADDRESS": dep["contracts"]["CouncilManager"]["address"],
    "COUNCIL_START_BLOCK": str(dep["deploymentBlock"]),
    "COUNCIL_STATE_GAS": "true",
    "COUNCIL_CORS_ORIGINS": "https://svc-ui.up.railway.app",
    "COUNCIL_DATA_DIR": "/data",
    "COUNCIL_SCHEDULER_POLL_MS": "5000",
}
bad = {k: (v.get(k), w) for k, w in want.items() if v.get(k) != w}
if bad:
    sys.exit("unexpected variables (got, want): " + json.dumps(bad))
PY

# Secrets travel through stdin, files and the CLI's environment only.
grep -qF "$ws_token" "$tmp/auth.log" || fail "the workspace token did not reach the API through curl's stdin config"
[[ $(cat "$tmp/cli-token") == "$project_token" ]] || fail "the CLI did not get the project token"
[[ -f $tmp/token-deleted ]] || fail "the project token was not deleted"
for secret in "$ws_token" "$project_token" "$hot_key"; do
	if grep -qF "$secret" "$tmp/argv.log"; then
		fail "a secret appeared in a process argument: $(grep -F "$secret" "$tmp/argv.log" | head -c 200)"
	fi
done

echo "[railway-deploy-relayer.test] ok"
