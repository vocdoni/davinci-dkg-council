import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    // The full-scale BSGS benchmark only runs via `pnpm bench:bsgs` (BSGS_BENCH=1).
    exclude: process.env.BSGS_BENCH ? ['**/node_modules/**'] : ['tests/bsgs-bench.test.ts', '**/node_modules/**'],
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
