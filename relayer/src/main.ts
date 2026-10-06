/** Relayer entry point: `node dist/main.js`, configured by COUNCIL_* env vars (see README.md). */

import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Combiner } from './combiner.js';
import { loadConfig } from './config.js';
import { WorkerDlogSolver } from './dlog.js';
import { shortMessage } from './errors.js';
import { jsonLogger as log } from './log.js';
import { Sponsor, SponsorPolicy } from './policy.js';
import { TxSender } from './sender.js';
import { createRelayerServer } from './server.js';
import { StateStore } from './state.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  const transports = config.rpcUrls.map((url) => http(url, { timeout: 30_000 }));
  const client = createPublicClient({
    transport: transports.length === 1 ? (transports[0] as ReturnType<typeof http>) : fallback(transports),
    pollingInterval: 1000,
    cacheTime: 0,
  }) as PublicClient;

  const chainId = BigInt(await client.getChainId());
  const code = await client.getCode({ address: config.manager });
  if (code === undefined || code === '0x') {
    throw new Error(`no contract at COUNCIL_MANAGER_ADDRESS ${config.manager} on chain ${chainId}`);
  }

  const account = privateKeyToAccount(config.privateKey);
  const store = new StateStore(StateStore.fileFor(config.dataDir, chainId, config.manager, account.address));
  // Broadcasts walk the endpoints one by one (broadcast.ts), not through viem's fallback, so an
  // endpoint that refuses sends cannot mask another endpoint's verdict on the transaction.
  const endpoints = config.rpcUrls.map((url) => ({
    name: new URL(url).host,
    client: createPublicClient({ transport: http(url, { timeout: 30_000, retryCount: 1 }), cacheTime: 0 }) as PublicClient,
  }));
  const sender = new TxSender({
    client,
    account,
    chainId,
    maxFeeWei: config.maxFeeWei,
    maxTxGas: config.maxTxGas,
    bumpAfterMs: config.bumpAfterMs,
    budgetWei: config.dailyBudgetWei,
    store,
    endpoints,
    nonceRefreshMs: config.nonceRefreshMs,
    log,
  });
  // Rebroadcast what an earlier run left pending before taking any new submission.
  await sender.recover();
  sender.start(config.txPollMs);

  const policy = new SponsorPolicy({
    client,
    chainId,
    manager: config.manager,
    store,
    config: {
      organizerAllowlist: config.organizerAllowlist,
      apiTokens: config.apiTokens,
      organizerDailyCeremonies: config.organizerDailyCeremonies,
      maxGrantsPerCeremony: config.maxGrantsPerCeremony,
      ceremonyRatePerMinute: config.rateLimitPerCeremony,
    },
  });
  const sponsor = new Sponsor(policy, sender, config.manager);

  const server = createRelayerServer({
    chainId,
    manager: config.manager,
    sponsor,
    sender,
    corsOrigins: config.corsOrigins,
    rateLimitPerIp: config.rateLimitPerIp,
    ingressRatePerIp: config.ingressRatePerIp,
    maxConcurrent: config.maxConcurrentRequests,
    trustedProxies: config.trustedProxies,
    log,
  });

  let combiner: Combiner | undefined;
  let solver: WorkerDlogSolver | undefined;
  if (config.combinerEnabled) {
    solver = new WorkerDlogSolver(new URL('./dlog-worker.js', import.meta.url), config.bsgsBabySteps);
    solver.warm();
    combiner = new Combiner({
      client,
      manager: config.manager,
      sponsor,
      sender,
      solver,
      startBlock: config.startBlock,
      logRange: config.logRange,
      log,
    });
    combiner.start(config.combinerPollMs);
  }

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  log.info('relayer listening', {
    port: config.port,
    chainId,
    manager: config.manager,
    relayer: sender.address,
    combiner: config.combinerEnabled,
    restricted: policy.restricted,
    dailyBudgetWei: config.dailyBudgetWei,
    state: store.file,
  });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    combiner?.stop();
    sender.stop();
    server.close();
    void solver?.close();
    setTimeout(() => process.exit(0), 2000).unref();
  };
  process.once('SIGINT', () => shutdown('SIGINT'));
  process.once('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err: unknown) => {
  log.error('relayer failed to start', { err: shortMessage(err) });
  process.exit(1);
});
