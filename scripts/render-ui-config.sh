#!/usr/bin/env bash
# Write the app's runtime config (ui/public/config.json, served as /config.json) from environment
# variables. Used by `make ui-config` and by the app image build (ui/Dockerfile).
#
# The starting point is UI_CONFIG (a committed file, default ui/public/config.json, the local dev
# stack); every variable that is set replaces one key, every unset one keeps the starting value,
# so a partial override never resets the rest. The result is checked against the rules the app
# enforces at load time (ui/src/config.ts): a production chain needs two independent RPCs.
#
#   UI_CONFIG          starting file, e.g. ui/public/config.sepolia.json
#   CHAIN_ID           chain id (decimal)
#   MANAGER_ADDRESS    CouncilManager address
#   RPC_URLS           comma-separated JSON-RPC endpoints (two independent providers or more)
#   RELAYER_URL        one relayer base URL; "null" for none (direct sending, dev mode only)
#   RELAYER_URLS       comma-separated relayers, tried in order ("null" for none); writes
#                      `relayerUrls` and drops `relayerUrl`; exclusive with RELAYER_URL
#   ARTIFACTS_BASE_URL one mirror of the pinned circuit files; "null" for the GitHub release
#   ARTIFACTS_BASE_URLS comma-separated mirrors, tried in order ("null" for the release URL;
#                      `{release}` in an entry is replaced with the release tag at download
#                      time); writes `artifactsBaseUrls` and drops `artifactsBaseUrl`;
#                      exclusive with ARTIFACTS_BASE_URL
#   LEGACY_DEPLOYMENTS JSON array of older managers this copy still serves ("null" for none),
#                      entries as ui/src/config.ts LegacyDeployment:
#                      [{"manager":"0x…","deploymentBlock":N,"relayerUrls":["https://…"],"label":"…"}]
#   DAVINCI_REGISTRY   DAVINCI ProcessRegistry address ("null" to drop it), reserved for the
#                      DAVINCI Elections connection (docs/davinci-integration.md)
#   DEPLOYMENT_BLOCK   block the manager was deployed at (where the app's label scans start)
#   LOG_CHUNK_BLOCKS   blocks per eth_getLogs request of those scans (default 10000)
#   DEV_MODE           true/false: local chain (31337/1337) with a single RPC
#
# Usage: [VAR=… …] scripts/render-ui-config.sh [output-path]
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=${1:-ui/public/config.json}
export UI_CONFIG=${UI_CONFIG:-ui/public/config.json} OUT

node --input-type=module <<'EOF'
import { readFileSync, writeFileSync } from 'node:fs';

const env = process.env;
const cfg = JSON.parse(readFileSync(env.UI_CONFIG, 'utf8'));
const set = (name, key, parse = (v) => v) => {
  if (env[name] !== undefined && env[name] !== '') cfg[key] = parse(env[name]);
};
const int = (name) => (v) => {
  if (!/^\d+$/.test(v)) throw new Error(`${name} must be a non-negative integer, got ${v}`);
  return Number(v);
};
const nullable = (v) => (v === 'null' ? null : v.replace(/\/+$/, ''));

set('CHAIN_ID', 'chainId', int('CHAIN_ID'));
set('MANAGER_ADDRESS', 'manager', (v) => {
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`MANAGER_ADDRESS is not an address: ${v}`);
  return v.toLowerCase();
});
set('RPC_URLS', 'rpcUrls', (v) => v.split(',').map((u) => u.trim()).filter(Boolean));
set('RELAYER_URL', 'relayerUrl', nullable);
set('ARTIFACTS_BASE_URL', 'artifactsBaseUrl', nullable);
// The multi-URL keys (ui/src/config.ts): a comma-separated list replaces both the list key and
// its single-URL counterpart, so the rendered config carries exactly the given entries.
const urlList = (v) => (v === 'null' ? [] : v.split(',').map((u) => u.trim().replace(/\/+$/, '')).filter(Boolean));
const setList = (name, key, singular) => {
  if (env[name] === undefined || env[name] === '') return;
  if (env[singular.env] !== undefined && env[singular.env] !== '') {
    throw new Error(`set one of ${singular.env} and ${name}, not both`);
  }
  cfg[key] = urlList(env[name]);
  delete cfg[singular.key];
};
setList('RELAYER_URLS', 'relayerUrls', { env: 'RELAYER_URL', key: 'relayerUrl' });
setList('ARTIFACTS_BASE_URLS', 'artifactsBaseUrls', { env: 'ARTIFACTS_BASE_URL', key: 'artifactsBaseUrl' });
set('LEGACY_DEPLOYMENTS', 'legacyDeployments', (v) => {
  const parsed = v === 'null' ? [] : JSON.parse(v);
  if (!Array.isArray(parsed)) throw new Error('LEGACY_DEPLOYMENTS must be a JSON array');
  return parsed;
});
set('DAVINCI_REGISTRY', 'davinciRegistry', (v) => {
  if (v === 'null') return null;
  if (!/^0x[0-9a-fA-F]{40}$/.test(v)) throw new Error(`DAVINCI_REGISTRY is not an address: ${v}`);
  return v.toLowerCase();
});
set('DEPLOYMENT_BLOCK', 'deploymentBlock', int('DEPLOYMENT_BLOCK'));
set('LOG_CHUNK_BLOCKS', 'logChunkBlocks', int('LOG_CHUNK_BLOCKS'));
set('DEV_MODE', 'devMode', (v) => v === 'true');

const local = cfg.chainId === 31337 || cfg.chainId === 1337;
if (cfg.devMode && !local) throw new Error('devMode is only allowed on a local chain (31337 or 1337)');
if (!cfg.devMode && cfg.rpcUrls.length < 2) {
  throw new Error('a production config needs at least two independent RPC_URLS (protocol §9.3)');
}
if (!cfg.devMode) delete cfg.devPrivateKey;

// One-element arrays on one line, as the committed files and tests/src/dev.ts write them.
writeFileSync(env.OUT, `${JSON.stringify(cfg, null, 2).replace(/\[\n\s+("[^"]*")\n\s+\]/g, '[$1]')}\n`);
console.log(`[render-ui-config] wrote ${env.OUT} from ${env.UI_CONFIG}:`);
console.log(JSON.stringify(cfg, null, 2));
EOF
