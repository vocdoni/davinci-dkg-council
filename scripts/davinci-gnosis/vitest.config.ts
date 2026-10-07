/**
 * Runs the DAVINCI round trip on Gnosis (`roundtrip.gnosis.ts`) with the e2e package's vitest, so
 * it reuses the e2e actors verbatim (like scripts/sepolia). Only Node built-ins here: the config
 * loads from this directory, which has no node_modules of its own.
 *
 * - The Council SDK is used from source, as in the e2e suite; `viem` is deduped to the e2e copy.
 * - davinci-sdk comes from a built checkout of its `council` branch, `DAVINCI_SDK_DIR` (default:
 *   `davinci-sdk` next to this repository's main checkout), and `ethers` from that checkout's own
 *   node_modules, so the wallets built here are the class the SDK checks.
 *
 *   tests/node_modules/.bin/vitest run --config scripts/davinci-gnosis/vitest.config.ts   (from the repository root)
 */

import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2e = path.resolve(here, '../../tests');

function siblingOfMainCheckout(name: string): string {
  let root = path.resolve(here, '../..');
  try {
    const common = execFileSync('git', ['-C', root, 'rev-parse', '--path-format=absolute', '--git-common-dir'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    root = path.dirname(common);
  } catch {
    // not a git checkout
  }
  return path.join(root, '..', name);
}

const sdkDir = path.resolve(process.env.DAVINCI_SDK_DIR || siblingOfMainCheckout('davinci-sdk'));
if (!existsSync(path.join(sdkDir, 'dist', 'index.mjs'))) {
  throw new Error(`no built davinci-sdk at ${sdkDir}: set DAVINCI_SDK_DIR and run \`yarn install && yarn build\` there`);
}

export default {
  root: e2e,
  resolve: {
    alias: {
      '@vocdoni/davinci-dkg-council-sdk': path.resolve(e2e, '../sdk/src/index.ts'),
      '@vocdoni/davinci-sdk': path.join(sdkDir, 'dist', 'index.mjs'),
      ethers: path.join(sdkDir, 'node_modules', 'ethers'),
    },
    dedupe: ['viem'],
  },
  test: {
    dir: here,
    include: ['**/*.gnosis.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    // Ceremonies wait for Gnosis finality several times; a scheduled opening waits for its date.
    testTimeout: 4 * 60 * 60_000,
    hookTimeout: 30 * 60_000,
    bail: 1,
    disableConsoleIntercept: true,
    reporters: ['verbose'],
  },
};
