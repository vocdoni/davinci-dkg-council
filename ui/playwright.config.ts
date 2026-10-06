import { defineConfig } from '@playwright/test';

/**
 * Browser journeys (Chromium) against the local stack of `make dev`
 * (scripts/dev-stack.sh): Anvil, the real verifiers and manager, the
 * relayer with its combine worker, the pinned circuit files, the DAVINCI
 * registry, and real snarkjs proving in the app's worker.
 *
 * Without COUNCIL_E2E_URL the stack is started here, or reused when
 * `make dev` already serves the default URL. Each journey runs once per
 * project: desktop (1280×800) and phone (390×844).
 */
const url = process.env.COUNCIL_E2E_URL ?? 'http://127.0.0.1:5175';

export default defineConfig({
  testDir: './e2e',
  timeout: 180_000,
  expect: { timeout: 15_000 },
  // One chain, one relayer, chain-wide time travel: one browser journey at a time.
  workers: 1,
  fullyParallel: false,
  reporter: [['list']],
  use: {
    baseURL: url,
    browserName: 'chromium',
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'desktop', use: { viewport: { width: 1280, height: 800 } } },
    {
      name: 'phone',
      use: { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 },
    },
  ],
  webServer: process.env.COUNCIL_E2E_URL
    ? undefined
    : {
        command: 'bash ../scripts/dev-stack.sh',
        url,
        reuseExistingServer: true,
        timeout: 15 * 60_000,
        stdout: 'pipe',
        gracefulShutdown: { signal: 'SIGINT', timeout: 20_000 },
      },
});
