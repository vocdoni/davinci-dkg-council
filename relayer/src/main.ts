/** Relayer entry point: `node dist/main.js`, configured by COUNCIL_* env vars (see README.md). */

import { COUNCIL_MANAGER_ABI, PROTOCOL_VERSION } from '@vocdoni/davinci-dkg-council-sdk';
import { createPublicClient, fallback, http, type PublicClient } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { ChainState } from './chainstate.js';
import { Combiner } from './combiner.js';
import { loadConfig } from './config.js';
import { WorkerDlogSolver } from './dlog.js';
import { isRevert, shortMessage } from './errors.js';
import { jsonLogger as log } from './log.js';
import { Metrics } from './metrics.js';
import { PartialVectorStore } from './partials.js';
import { Sponsor, SponsorPolicy } from './policy.js';
import { Scheduler } from './scheduler.js';
import { TxSender } from './sender.js';
import { createRelayerServer } from './server.js';
import { StateStore } from './state.js';
import { trackCeremony } from './track.js';

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
  // A deployment's protocol is its manager's protocolVersion(), never guessed (protocol §5.3):
  // this release encodes v2 actions only, which a v1 manager would refuse one by one.
  const version = await client
    .readContract({ address: config.manager, abi: COUNCIL_MANAGER_ABI, functionName: 'protocolVersion' })
    .catch((err: unknown) => {
      if (isRevert(err)) return undefined; // a v1 manager has no such view
      throw err;
    });
  if (version !== PROTOCOL_VERSION) {
    throw new Error(
      `COUNCIL_MANAGER_ADDRESS ${config.manager} is not a protocol v${PROTOCOL_VERSION} CouncilManager ` +
        `(protocolVersion ${version ?? 'missing'}); run the relayer release matching that manager`,
    );
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
    stateGas: config.stateGas,
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

  // Contract reads and calldata rebuilds, and the D-vector cache (protocol §10.4), shared by the
  // sponsor, the combine worker and the scheduler.
  const chain = new ChainState(client, config.manager);
  const partialsDir = PartialVectorStore.dirFor(config.dataDir, chainId, config.manager);
  const partials = new PartialVectorStore(chainId, config.manager, partialsDir);
  const policy = new SponsorPolicy({
    client,
    chainId,
    manager: config.manager,
    store,
    chain,
    partials,
    config: {
      organizerAllowlist: config.organizerAllowlist,
      apiTokens: config.apiTokens,
      organizerDailyCeremonies: config.organizerDailyCeremonies,
      maxGrantsPerCeremony: config.maxGrantsPerCeremony,
      ceremonyRatePerMinute: config.rateLimitPerCeremony,
    },
  });
  const sponsor = new Sponsor(policy, sender, config.manager);
  // Prune terminal counters, expired records and backoffs (bounded state file).
  policy.startGc(10 * 60_000, log);

  let combiner: Combiner | undefined;
  let solver: WorkerDlogSolver | undefined;
  if (config.combinerEnabled) {
    solver = new WorkerDlogSolver(new URL('./dlog-worker.js', import.meta.url), config.bsgsBabySteps);
    solver.warm();
    combiner = new Combiner({
      client,
      chainId,
      manager: config.manager,
      sponsor,
      sender,
      solver,
      chain,
      partials,
      startBlock: config.startBlock,
      logRange: config.logRange,
      store,
      log,
    });
    combiner.start(config.combinerPollMs);
  }

  let scheduler: Scheduler | undefined;
  if (config.schedulerEnabled) {
    scheduler = new Scheduler({
      client,
      manager: config.manager,
      sponsor,
      sender,
      store,
      chain,
      onDecryptionOpen: (cid) => combiner?.wake(cid),
      log,
    });
    scheduler.start(config.schedulerPollMs);
  }

  const metrics = new Metrics({
    chainId,
    manager: config.manager,
    sender,
    scheduler,
    combiner,
    endpoints,
    store,
    thresholds: {
      minBalanceWei: config.alertMinBalanceWei,
      minBudgetPercent: config.alertBudgetPercent,
      maxPendingMs: config.alertPendingMs,
      maxStaleMs: config.alertStaleMs,
      maxRpcLagBlocks: config.alertRpcLagBlocks,
    },
  });
  const worker = combiner;
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
    metrics: () => metrics.collect(),
    track: worker
      ? (body, token) =>
          trackCeremony({ chainId, manager: config.manager, chain, policy, track: (cid) => worker.track(cid) }, body, token)
      : undefined,
    log,
  });

  await new Promise<void>((resolve) => server.listen(config.port, config.host, resolve));
  log.info('relayer listening', {
    port: config.port,
    chainId,
    manager: config.manager,
    relayer: sender.address,
    combiner: config.combinerEnabled,
    scheduler: config.schedulerEnabled,
    restricted: policy.restricted,
    dailyBudgetWei: config.dailyBudgetWei,
    stateGas: config.stateGas,
    maxTxGas: config.maxTxGas ?? 'block gas limit',
    state: store.file,
  });

  const shutdown = (signal: string): void => {
    log.info('shutting down', { signal });
    combiner?.stop();
    scheduler?.stop();
    sender.stop();
    policy.stopGc();
    store.close();
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
