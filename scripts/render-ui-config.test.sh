#!/usr/bin/env bash
# Self-check for render-ui-config.sh: with no environment it reproduces the committed config, the
# environment wins key by key, a partial override keeps the other keys, and a production config
# with a single RPC or a dev flag off the local chain is refused.
set -euo pipefail

here=$(cd "$(dirname "$0")" && pwd)
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
out=$tmp/config.json
render() { bash "$here/render-ui-config.sh" "$out" >/dev/null; }
get() { node -e 'const c=require(process.argv[1]);const v=c[process.argv[2]];console.log(typeof v==="object"?JSON.stringify(v):String(v))' "$out" "$1"; }
want() { [ "$(get "$1")" = "$2" ] || { echo "FAIL: $1 = $(get "$1"), want $2"; exit 1; }; }
refuse() { if "$@" >/dev/null 2>&1; then echo "FAIL: accepted: $*"; exit 1; fi; }

# No environment: byte-for-byte the committed local dev config.
render
diff -q "$here/../ui/public/config.json" "$out" >/dev/null || { echo "FAIL: differs from ui/public/config.json"; exit 1; }

# A starting file plus overrides: the environment wins, the rest keeps the file's values.
UI_CONFIG=ui/public/config.sepolia.json MANAGER_ADDRESS=0x00000000000000000000000000000000000000AA \
  DEPLOYMENT_BLOCK=123 RELAYER_URL=https://relayer.example/ render
want chainId 11155111
want manager 0x00000000000000000000000000000000000000aa
want deploymentBlock 123
want relayerUrl https://relayer.example
want devMode false
[ "$(node -e 'console.log(require(process.argv[1]).rpcUrls.length)' "$out")" = 2 ] || { echo "FAIL: rpcUrls"; exit 1; }

# "null" clears a URL; RPC_URLS splits on commas.
UI_CONFIG=ui/public/config.sepolia.json ARTIFACTS_BASE_URL=null RPC_URLS='https://a.example, https://b.example' render
want artifactsBaseUrl null
want rpcUrls '["https://a.example","https://b.example"]'

# Multi-URL keys: a list replaces both the list key and its single-URL counterpart; the
# {release} placeholder survives; legacy deployments are passed through as JSON.
UI_CONFIG=ui/public/config.sepolia.json RELAYER_URLS='https://r1.example, https://r2.example/' \
  ARTIFACTS_BASE_URLS='https://m1.example/{release},https://m2.example/council/{release}' \
  LEGACY_DEPLOYMENTS='[{"manager":"0x00000000000000000000000000000000000000bb","deploymentBlock":7,"relayerUrls":["https://old.example"],"label":"2026 rehearsal"}]' \
  render
want relayerUrls '["https://r1.example","https://r2.example"]'
want relayerUrl undefined
want artifactsBaseUrls '["https://m1.example/{release}","https://m2.example/council/{release}"]'
want artifactsBaseUrl undefined
want legacyDeployments '[{"manager":"0x00000000000000000000000000000000000000bb","deploymentBlock":7,"relayerUrls":["https://old.example"],"label":"2026 rehearsal"}]'

# The DAVINCI Elections connection: DAVINCI_REGISTRY and ELECTIONS_ORIGINS fill the one pinned
# object (the gnosis file ships a zero-registry placeholder), "null" drops it, a registry
# without origins (starting from a file that has none) is refused.
UI_CONFIG=ui/public/config.gnosis.json DAVINCI_REGISTRY=0x00000000000000000000000000000000000000CC render
want davinci '{"registry":"0x00000000000000000000000000000000000000cc","electionsOrigins":["https://elections.davinci.vote"]}'
UI_CONFIG=ui/public/config.gnosis.json DAVINCI_REGISTRY=0x00000000000000000000000000000000000000CC \
  ELECTIONS_ORIGINS='https://elections.example/, https://staging.example' render
want davinci '{"registry":"0x00000000000000000000000000000000000000cc","electionsOrigins":["https://elections.example","https://staging.example"]}'
UI_CONFIG=ui/public/config.gnosis.json DAVINCI_REGISTRY=null render
want davinci undefined
refuse env UI_CONFIG=ui/public/config.gnosis.json DAVINCI_REGISTRY=0x12 bash "$here/render-ui-config.sh" "$out"
refuse env UI_CONFIG=ui/public/config.sepolia.json DAVINCI_REGISTRY=0x00000000000000000000000000000000000000CC \
  bash "$here/render-ui-config.sh" "$out"

# "null" empties a list ("no relayers"); clearing legacy deployments works the same way.
UI_CONFIG=ui/public/config.sepolia.json RELAYER_URLS=null LEGACY_DEPLOYMENTS=null render
want relayerUrls '[]'
want legacyDeployments '[]'

# Refusals: one RPC on a production chain, devMode off the local chain, a malformed address,
# a single-URL variable together with its list, legacy deployments that are not a JSON array.
refuse env UI_CONFIG=ui/public/config.sepolia.json RPC_URLS=https://a.example bash "$here/render-ui-config.sh" "$out"
refuse env UI_CONFIG=ui/public/config.sepolia.json DEV_MODE=true bash "$here/render-ui-config.sh" "$out"
refuse env MANAGER_ADDRESS=0x1234 bash "$here/render-ui-config.sh" "$out"
refuse env UI_CONFIG=ui/public/config.sepolia.json RELAYER_URL=https://a.example RELAYER_URLS=https://b.example \
  bash "$here/render-ui-config.sh" "$out"
refuse env UI_CONFIG=ui/public/config.sepolia.json ARTIFACTS_BASE_URL=null ARTIFACTS_BASE_URLS=https://m.example \
  bash "$here/render-ui-config.sh" "$out"
refuse env UI_CONFIG=ui/public/config.sepolia.json LEGACY_DEPLOYMENTS='{"manager":"0x"}' bash "$here/render-ui-config.sh" "$out"

echo "[render-ui-config.test] ok"
