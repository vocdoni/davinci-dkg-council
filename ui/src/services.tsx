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
  RelayerClient,
  type Action,
  type Hex,
} from '@vocdoni/davinci-dkg-council-sdk';
import { createContext, useContext, type ReactNode } from 'react';
import { createPublicClient, createWalletClient, defineChain, http, type AbiEvent } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AppConfig } from './config';
import type { ChainReader, ManagerEvent } from './lib/chain';
import { proveInWorker, type OnProveProgress, type ProveProgress } from './lib/proving';
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
}

/** eth_getLogs requests one `joinedEvents` call may make (the next call resumes). */
const LOG_REQUESTS_PER_CALL = 40;

const PARTICIPANT_JOINED = COUNCIL_MANAGER_ABI.find(
  (e) => e.type === 'event' && e.name === 'ParticipantJoined',
) as AbiEvent;

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

  if (config.relayerUrl) {
    const relayer = new RelayerClient(config.relayerUrl);
    submit = (action) =>
      relayer.relay(chainId, config.manager, action).catch((err: unknown) => {
        throw plainSubmitError(err);
      });
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
    prove: (circuit, witnessInput, onProgress) =>
      proveInWorker(circuit, witnessInput, config.artifactsBaseUrl, onProgress),
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
  };
}

const ServicesContext = createContext<Services | null>(null);

export function ServicesProvider({ services, children }: { services: Services; children: ReactNode }) {
  return <ServicesContext.Provider value={services}>{children}</ServicesContext.Provider>;
}

export function useServices(): Services {
  const services = useContext(ServicesContext);
  if (!services) throw new Error('useServices outside ServicesProvider');
  return services;
}
