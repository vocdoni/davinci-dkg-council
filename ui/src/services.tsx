/**
 * App-wide services: config, chain reads, action submission and proving.
 * Screens consume this via React context; tests inject fakes.
 *
 * Submission goes through the relayer (architecture §5). In explicit local
 * development mode without a relayer, actions are sent directly from a
 * configured funded dev account (the SDK's relayer-bypass path).
 */

import {
  CouncilClient,
  decodeManagerLogs,
  RelayerClient,
  type Action,
  type Hex,
} from '@vocdoni/davinci-dkg-council-sdk';
import { createContext, useContext, type ReactNode } from 'react';
import { createPublicClient, createWalletClient, defineChain, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import type { AppConfig } from './config';
import type { ChainReader, ManagerEvent } from './lib/chain';
import { proveInWorker, type OnProveProgress, type ProveProgress } from './lib/proving';
import { plainSubmitError } from './lib/relayerErrors';
import type {
  CircuitName,
  DealWitnessInput,
  PartialWitnessInput,
  ProveResult,
} from '@vocdoni/davinci-dkg-council-sdk';

export type { ProveProgress };

export interface Services {
  config: AppConfig;
  client: ChainReader;
  /** Submit one action (relayer or dev direct path); resolves to its receipt handle. */
  submit(action: Action): Promise<Hex>;
  /** Wait until a submitted action is confirmed; throws on failure/timeout. */
  waitTx(txHash: Hex): Promise<void>;
  /** Download verified proving files and prove in a Web Worker. */
  prove(
    circuit: CircuitName,
    witnessInput: DealWitnessInput | PartialWitnessInput,
    onProgress?: OnProveProgress,
  ): Promise<ProveResult>;
  /** Discovery-only event scan from the deployment block. */
  getEvents(fromBlock: bigint): Promise<ManagerEvent[]>;
}

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

  let submit: (action: Action) => Promise<Hex>;
  let waitTx: (txHash: Hex) => Promise<void>;

  if (config.relayerUrl) {
    const relayer = new RelayerClient(config.relayerUrl);
    submit = (action) =>
      relayer.relay(chainId, config.manager, action).catch((err: unknown) => {
        throw plainSubmitError(err);
      });
    waitTx = async (txHash) => {
      for (let i = 0; i < 120; i++) {
        const s = await relayer.status(txHash).catch(() => undefined);
        if (s?.status === 'confirmed') return;
        if (s?.status === 'failed') {
          throw new Error(s.revertReason ? `the update was rejected: ${s.revertReason}` : 'the update was rejected');
        }
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
      if (receipt.status !== 'success') throw new Error('the update was rejected');
    };
  } else {
    const fail = () =>
      Promise.reject(new Error('no relayer is configured for this deployment — nothing can be submitted'));
    submit = fail;
    waitTx = fail;
  }

  return {
    config,
    client,
    submit,
    waitTx,
    prove: (circuit, witnessInput, onProgress) =>
      proveInWorker(circuit, witnessInput, config.artifactsBaseUrl, onProgress),
    getEvents: async (fromBlock) => {
      const logs = await publicClient.getLogs({
        address: config.manager,
        fromBlock,
        toBlock: 'latest',
      });
      return decodeManagerLogs(logs) as unknown as ManagerEvent[];
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
