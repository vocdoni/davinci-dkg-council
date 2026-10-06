import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const here = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  // Unit tests run against the SDK sources, so they need no SDK build.
  resolve: { alias: { '@vocdoni/davinci-dkg-council-sdk': path.join(here, '../sdk/src/index.ts') } },
  test: {
    include: ['tests/**/*.test.ts'],
    testTimeout: 60_000,
  },
});
