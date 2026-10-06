/**
 * Global setup: verify the dev circuit artifacts against the SDK pins, build the SDK, the
 * relayer and the contracts, start Anvil, deploy the real verifiers and the manager bound to
 * the dev circuit release, and start the relayer with its combine worker.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createPublicClient, http, type PublicClient } from 'viem';
import { foundry } from 'viem/chains';
import { ACCOUNT, anvilAccount, anvilKey, walletFor } from './accounts.js';
import { deployCouncil, devCircuitRelease } from './deploy.js';
import { resetGas, writeGasMarkdown } from './gas.js';
import type { E2EContext } from './harness.js';
import { ANVIL_HARDFORK, buildPackages, forgeBuild, startAnvil, startRelayer } from './infra.js';

interface Project {
  provide(key: 'council', value: E2EContext): void;
}

export default async function setup(project: Project): Promise<() => Promise<void>> {
  const release = devCircuitRelease();
  buildPackages();
  forgeBuild();
  resetGas();

  const anvil = await startAnvil();
  let relayer: Awaited<ReturnType<typeof startRelayer>> | undefined;
  try {
    const client = createPublicClient({ chain: foundry, transport: http(anvil.rpcUrl) }) as PublicClient;
    const deployment = await deployCouncil(walletFor(anvil.rpcUrl, ACCOUNT.deployer), client, release.releaseId);
    relayer = await startRelayer({
      COUNCIL_RPC_URL: anvil.rpcUrl,
      COUNCIL_MANAGER_ADDRESS: deployment.manager,
      COUNCIL_PRIVATE_KEY: anvilKey(ACCOUNT.relayer),
      COUNCIL_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'council-e2e-relayer-')),
      COUNCIL_COMBINER_ENABLED: 'true',
      COUNCIL_COMBINER_POLL_MS: '500',
      COUNCIL_TX_POLL_MS: '200',
      COUNCIL_DAILY_BUDGET_WEI: (100n * 10n ** 18n).toString(),
      COUNCIL_RATE_LIMIT: '1000',
      COUNCIL_CEREMONY_RATE_LIMIT: '1000',
      // The suite polls /v1/status every 100 ms from one address.
      COUNCIL_INGRESS_RATE_LIMIT: '100000',
      COUNCIL_CORS_ORIGINS: 'http://localhost:5173',
    });
    project.provide('council', {
      rpcUrl: anvil.rpcUrl,
      chainId: String(await client.getChainId()),
      manager: deployment.manager,
      releaseId: release.releaseId,
      relayerUrl: relayer.url,
      relayerAddress: anvilAccount(ACCOUNT.relayer).address.toLowerCase() as E2EContext['relayerAddress'],
      wasm: release.wasm,
      zkey: release.zkey,
    });
  } catch (err) {
    await relayer?.stop();
    anvil.stop();
    throw err;
  }

  return async () => {
    await relayer?.stop();
    anvil.stop();
    writeGasMarkdown({ anvil: `Anvil (chain id 31337, ${ANVIL_HARDFORK}, 17M block gas limit)` });
  };
}
