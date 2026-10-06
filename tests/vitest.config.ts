import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // The suite drives the SDK sources; the relayer child process runs the built packages.
  resolve: { alias: { '@vocdoni/davinci-dkg-council-sdk': path.join(here, '../sdk/src/index.ts') } },
  test: {
    include: ['tests/**/*.test.ts'],
    globalSetup: ['src/setup.ts'],
    // One Anvil, one relayer, shared funded accounts and chain-wide time travel: run files in order.
    fileParallelism: false,
    sequence: { concurrent: false },
    testTimeout: 15 * 60_000,
    hookTimeout: 15 * 60_000,
  },
});
