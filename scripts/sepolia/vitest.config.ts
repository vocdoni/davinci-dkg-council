/**
 * Runs the Sepolia ceremony (`ceremony.sepolia.ts`) with the e2e package's vitest, so it reuses
 * the e2e actors and helpers verbatim. No imports beyond Node built-ins: the config is loaded
 * from this directory, which has no node_modules of its own. `root` is the e2e package and
 * `viem` is deduped, so bare imports here resolve to the e2e package's copy; the SDK is used
 * from source, as in the e2e suite.
 *
 *   tests/node_modules/.bin/vitest run --config scripts/sepolia/vitest.config.ts   (from the repository root)
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const e2e = path.resolve(here, '../../tests');

export default {
  root: e2e,
  resolve: {
    alias: { '@vocdoni/davinci-dkg-council-sdk': path.resolve(e2e, '../sdk/src/index.ts') },
    dedupe: ['viem'],
  },
  test: {
    dir: here,
    include: ['**/*.sepolia.ts'],
    fileParallelism: false,
    sequence: { concurrent: false },
    // A live-network run waits for finality (~13-20 min on Sepolia) several times.
    testTimeout: 90 * 60_000,
    hookTimeout: 30 * 60_000,
    bail: 1,
    disableConsoleIntercept: true,
    reporters: ['verbose'],
  },
};
