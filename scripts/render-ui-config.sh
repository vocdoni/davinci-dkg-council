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
#   RELAYER_URL        relayer base URL; "null" for none (direct sending, dev mode only)
#   ARTIFACTS_BASE_URL mirror of the pinned circuit files; "null" for the GitHub release
#   DEPLOYMENT_BLOCK   block the manager was deployed at (first block the app scans)
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
set('DEPLOYMENT_BLOCK', 'deploymentBlock', int('DEPLOYMENT_BLOCK'));
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
