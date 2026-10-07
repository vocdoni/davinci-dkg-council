/**
 * App-wide services: config, chain reads, action submission and proving.
 * Screens consume this via React context; tests inject fakes.
 *
 * Submission goes through the relayer (architecture §5). In explicit local
 * development mode without a relayer, actions are sent directly from a
 * configured funded dev account (the SDK's relayer-bypass path).
 */

import {
  COUNCIL_MANAGER_ABI,
  CouncilClient,
  DEFAULT_LOG_CHUNK,
  decodeManagerLogs,
  LogScanner,
  RelayerPool,
  type Action,
  type Hex,
  type TrackCeremonyRequest,
} from '@vocdoni/davinci-dkg-council-sdk';
import { createContext, useContext, type ReactNode } from 'react';
import { createPublicClient, createWalletClient, defineChain, http, type AbiEvent } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AppConfig } from './config';
import type { Deployments } from './deployments';
import type { ChainReader, ManagerEvent } from './lib/chain';
import { MISMATCH_TEXT, PairingError } from './lib/davinci';
import { proveInWorker, type OnProveProgress, type ProveProgress } from './lib/proving';
import { releaseArtifacts } from './lib/release';
import { plainSubmitError, TxRejectedError } from './lib/relayerErrors';
import type {
  CircuitName,
  DealWitnessInput,
  PartialWitnessInput,
  ProveResult,
} from '@vocdoni/davinci-dkg-council-sdk';

export type { ProveProgress };

/** What the relayer (or the dev chain) says about a submitted action. */
export interface TxStatus {
  status: 'pending' | 'confirmed' | 'failed' | 'unknown';
  /** Why it failed, as the relayer reports it (a refusal name such as `WrongPhase()`). */
  reason?: string;
}

export interface Services {
  config: AppConfig;
  client: ChainReader;
  /** Submit one action (relayer or dev direct path); resolves to its receipt handle. */
  submit(action: Action): Promise<Hex>;
  /**
   * Wait until a submitted action is mined at the head (not finalized); throws a
   * TxRejectedError when it was refused, another error on timeout.
   */
  waitTx(txHash: Hex): Promise<void>;
  /** One status check of a submitted action; never throws (`unknown` instead). */
  txStatus(txHash: Hex): Promise<TxStatus>;
  /**
   * Register a committee with every configured relayer (`POST /v1/track`, architecture §5.1) so
   * their combine workers serve its decryption from state, without log discovery. Resolves true
   * once every relayer has it (trivially, when none is configured — the dev direct path needs no
   * tracking); false when at least one could not be reached, so the caller retries later.
   * Never throws; tracking is idempotent.
   */
  trackCeremony(request: TrackCeremonyRequest): Promise<boolean>;
  /** Download verified proving files and prove in a Web Worker. */
  prove(
    circuit: CircuitName,
    witnessInput: DealWitnessInput | PartialWitnessInput,
    onProgress?: OnProveProgress,
  ): Promise<ProveResult>;
  /**
   * Cosmetic only (which invite each member joined with): this committee's ParticipantJoined
   * events, scanned in bounded ranges from `fromBlock` (the committee's creation block when this
   * device knows a lower bound for it, else the deployment block) and resumed on every call, a
   * bounded number of requests at a time. `complete` is false while the scan has not reached the
   * head; what was found so far is returned either way. Nothing a member does waits on this.
   */
  joinedEvents(cid: Hex, fromBlock?: bigint): Promise<{ events: ManagerEvent[]; complete: boolean }>;
  /**
   * DAVINCI pairing: `councilAdapter()` read on chain from the pinned `davinci.registry` — the
   * address actually granted, never one from a link or an API response. Every configured provider
   * must agree; the adapter must be non-zero and its `manager()` this deployment's manager
   * (PairingError with the plain mismatch text otherwise).
   */
  readDavinciAdapter(): Promise<Hex>;
}

/** eth_getLogs requests one `joinedEvents` call may make (the next call resumes). */
const LOG_REQUESTS_PER_CALL = 40;

const PARTICIPANT_JOINED = COUNCIL_MANAGER_ABI.find(
  (e) => e.type === 'event' && e.name === 'ParticipantJoined',
) as AbiEvent;

const DAVINCI_REGISTRY_ABI = [
  { type: 'function', name: 'councilAdapter', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;
const COUNCIL_ADAPTER_ABI = [
  { type: 'function', name: 'manager', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
] as const;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function buildServices(config: AppConfig): Services {
  const chainId = BigInt(config.chainId);
  const client = new CouncilClient({
    chainId,
    manager: config.manager,
    rpcUrls: config.rpcUrls,
    devMode: config.devMode,
  });

  const publicClient = createPublicClient({ transport: http(config.rpcUrls[0]) });
  /** Every configured provider, in order: a label scan moves on when one refuses eth_getLogs. */
  const logSources = config.rpcUrls.map((url) => createPublicClient({ transport: http(url) }));
  const joinScans = new Map<string, LogScanner>();

  let submit: (action: Action) => Promise<Hex>;
  let waitTx: (txHash: Hex) => Promise<void>;
  let txStatus: (txHash: Hex) => Promise<TxStatus>;
  // Without a relayer there is nothing to register with: the dev direct path decrypts by hand.
  let trackCeremony: (request: TrackCeremonyRequest) => Promise<boolean> = async () => true;

  if (config.relayerUrls.length > 0) {
    // Several relayers, tried in order: the next one when one is down, busy, out of budget or
    // not sponsoring; a refusal of the action itself is final (RelayerPool).
    const relayer = new RelayerPool(config.relayerUrls);
    submit = (action) =>
      relayer.relay(chainId, config.manager, action).catch((err: unknown) => {
        throw plainSubmitError(err);
      });
    // Unlike relay, tracking goes to every relayer: each combine worker keeps its own list.
    trackCeremony = async (request) => {
      const outcomes = await relayer.track(chainId, config.manager, request);
      return outcomes.every((o) => o.tracked);
    };
    txStatus = async (txHash) => {
      const s = await relayer.status(txHash).catch(() => undefined);
      if (!s) return { status: 'unknown' };
      return s.status === 'failed' ? { status: 'failed', reason: s.revertReason } : { status: s.status };
    };
    waitTx = async (txHash) => {
      for (let i = 0; i < 120; i++) {
        const s = await txStatus(txHash);
        if (s.status === 'confirmed') return;
        if (s.status === 'failed') throw new TxRejectedError(s.reason);
        await sleep(1500);
      }
      throw new Error('the update is taking too long — please try again');
    };
  } else if (import.meta.env.DEV && config.devMode && config.devPrivateKey) {
    // Dev-only direct send; the import.meta.env.DEV guard makes this whole
    // branch dead code in production builds (eliminated by the bundler).
    const account = privateKeyToAccount(config.devPrivateKey);
    const devChain = defineChain({
      id: config.chainId,
      name: 'local',
      nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
      rpcUrls: { default: { http: [config.rpcUrls[0] as string] } },
    });
    const wallet = createWalletClient({ account, chain: devChain, transport: http(config.rpcUrls[0]) });
    submit = async (action) => {
      const { to, data } = client.actionCalldata(action);
      return wallet.sendTransaction({ to, data });
    };
    waitTx = async (txHash) => {
      const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash, timeout: 120_000 });
      if (receipt.status !== 'success') throw new TxRejectedError();
    };
    txStatus = async (txHash) => {
      const receipt = await publicClient.getTransactionReceipt({ hash: txHash }).catch(() => null);
      if (!receipt) return { status: 'pending' };
      return receipt.status === 'success' ? { status: 'confirmed' } : { status: 'failed' };
    };
  } else {
    const fail = () =>
      Promise.reject(new Error('no relayer is configured for this deployment — nothing can be submitted'));
    submit = fail;
    waitTx = fail;
    txStatus = async () => ({ status: 'unknown' });
  }

  return {
    config,
    client,
    submit,
    waitTx,
    txStatus,
    trackCeremony,
    // The files of this deployment's own release (its on-chain id), from the configured mirrors.
    prove: async (circuit, witnessInput, onProgress) =>
      proveInWorker(circuit, witnessInput, config.artifactsBaseUrls, onProgress, await releaseArtifacts(client)),
    joinedEvents: async (cid, fromBlock) => {
      const key = cid.toLowerCase();
      let scanner = joinScans.get(key);
      if (!scanner) {
        scanner = new LogScanner(logSources, {
          address: config.manager,
          event: PARTICIPANT_JOINED,
          args: { cid },
          fromBlock: fromBlock ?? BigInt(config.deploymentBlock),
          chunkSize: config.logChunkBlocks !== undefined ? BigInt(config.logChunkBlocks) : DEFAULT_LOG_CHUNK,
        });
        joinScans.set(key, scanner);
      }
      await scanner.advance({ maxRequests: LOG_REQUESTS_PER_CALL });
      return {
        events: decodeManagerLogs([...scanner.logs]) as unknown as ManagerEvent[],
        complete: scanner.complete,
      };
    },
    readDavinciAdapter: async () => {
      const davinci = config.davinci;
      if (!davinci) throw new Error('this deployment has no DAVINCI Elections connection configured');
      const read = async (address: Hex, abi: typeof DAVINCI_REGISTRY_ABI | typeof COUNCIL_ADAPTER_ABI, fn: string) => {
        const values = await Promise.all(
          logSources.map((c) => c.readContract({ address, abi, functionName: fn as never }) as Promise<Hex>),
        );
        const first = (values[0] as Hex).toLowerCase() as Hex;
        if (values.some((v) => v.toLowerCase() !== first)) {
          throw new Error(`the network providers disagree on ${fn} — refusing`);
        }
        return first;
      };
      const adapter = await read(davinci.registry, DAVINCI_REGISTRY_ABI, 'councilAdapter');
      if (BigInt(adapter) === 0n) throw new PairingError(MISMATCH_TEXT, 'councilAdapter() is zero');
      if ((await read(adapter, COUNCIL_ADAPTER_ABI, 'manager')) !== config.manager.toLowerCase()) {
        throw new PairingError(MISMATCH_TEXT, 'adapter.manager() is not this deployment');
      }
      return adapter;
    },
  };
}

const ServicesContext = createContext<Services | null>(null);
const DeploymentsContext = createContext<Deployments | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function DeploymentsProvider({ deployments, children }: { deployments: Deployments; children: ReactNode }) {
  return (
    <DeploymentsContext.Provider value={deployments}>
      <ServicesProvider services={deployments.current}>{children}</ServicesProvider>
    </DeploymentsContext.Provider>
  );
}

/** The services of the deployment in view: the current one, or a committee's own (Ceremony route). */
export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices outside ServicesProvider');
  return services;
}

/** Like useServices, but null outside any provider (start-up and error screens). */
export function useOptionalServices(): Services | null {
  return useContext(ServicesContext);
}

export function useDeployments(): Deployments {
  const deployments = useContext(DeploymentsContext);
  if (!deployments) throw new Error('useDeployments outside DeploymentsProvider');
  return deployments;
}
