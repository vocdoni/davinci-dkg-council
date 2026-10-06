/**
 * The test app: a davinci-sdk session on one ProcessRegistry that creates COUNCIL-mode
 * processes (keyed by a Council ceremony), ends them and reads their results. Everything goes
 * through the `DavinciSDK` facade; the only direct contract reads are the Council adapter's
 * back-pointers and the ceremony key, to show that the process key is the ceremony's.
 */

import {
  COUNCIL_ADAPTER_ABI,
  COUNCIL_MANAGER_ABI,
  DavinciSDK,
  KeyMode,
  OffchainCensus,
  ProcessRegistryService,
  type DeploymentPins,
  type ResultsState,
} from '@vocdoni/davinci-sdk';
import { Contract, JsonRpcProvider, Wallet, getAddress } from 'ethers';
import { LocalNode } from './localNode.js';

export interface AppConfig {
  /** JSON-RPC of the chain. */
  rpcUrl: string;
  /** The ProcessRegistry (davinci-contracts with the COUNCIL key mode). */
  registry: string;
  /** Private key of the account that creates (and ends) processes. */
  organizerKey: string;
  /** The Council manager the registry's adapter must point at; unchecked when omitted. */
  manager?: string;
  /**
   * Sequencer node URLs. Omitted: a local stand-in serves `/info` and hosts the uploads
   * (local chains only).
   */
  sequencerUrls?: string[];
  /**
   * Deployment check at init: the davinci-sdk release pins (`release`, default), explicit pins
   * for a local deployment, or `off` (a registry on MockZiskVerifier has no real verifier to pin).
   */
  verify?: 'release' | 'off' | DeploymentPins;
}

export interface CreateOptions {
  /** The Council ceremony (bytes12 hex). It must be Live, allow the registry's adapter and
   *  authorize the creating account. */
  ceremonyId: string;
  /** Ballot fields (1..16): one rating question with this many choices. */
  fields?: number;
  /** Largest value per field and ballot. */
  maxValue?: number;
  /** maxValue * maxVoters is capped at 1e12 by the registry. */
  maxVoters?: number;
  /** Seconds. */
  duration?: number;
  title?: string;
}

export interface CreatedProcess {
  processId: string;
  transactionHash: string;
  ceremonyId: string;
  /** The process encryption key (circomlib TE), equal to the ceremony key. */
  encryptionKey: { x: bigint; y: bigint };
  /** The Council request id the process is bound under (the registry's dkgAid). */
  requestId: string;
  /** The registry's CouncilAdapter. */
  adapter: string;
}

export interface ResultsReport {
  processId: string;
  state: ResultsState;
  /** One total per ballot field once the tally is on chain (`results`). */
  values?: bigint[];
  /** Ballot fields the registry recorded as zero without decryption (identity ciphertexts). */
  zeroSkipped?: number;
}

export class DavinciCouncilApp {
  private constructor(
    readonly sdk: DavinciSDK,
    private readonly provider: JsonRpcProvider,
    private readonly config: AppConfig,
    private readonly node?: LocalNode,
  ) {}

  static async connect(config: AppConfig): Promise<DavinciCouncilApp> {
    const provider = new JsonRpcProvider(config.rpcUrl, undefined, { cacheTimeout: -1, pollingInterval: 250 });
    const chainId = Number((await provider.getNetwork()).chainId);
    const signer = new Wallet(config.organizerKey, provider);
    const local = !config.sequencerUrls?.length;
    const node = local ? await LocalNode.start(new ProcessRegistryService(config.registry, provider)) : undefined;
    const verify = config.verify ?? 'release';
    const sdk = new DavinciSDK({
      signer,
      network: { name: `chain ${chainId}`, chainId, processRegistry: config.registry },
      sequencerUrls: node ? [node.url] : config.sequencerUrls,
      ...(node && { uploader: node.uploader, documents: { allowPrivateHosts: true } }),
      verifyDeployment: verify === 'release' ? true : verify === 'off' ? false : { pins: verify },
    });
    try {
      await sdk.init();
    } catch (err) {
      await node?.close();
      provider.destroy();
      throw err;
    }
    return new DavinciCouncilApp(sdk, provider, config, node);
  }

  async close(): Promise<void> {
    await this.node?.close();
    this.provider.destroy();
  }

  /**
   * The registry's CouncilAdapter, checked to point back at the registry and, when configured,
   * at the expected Council manager.
   */
  async councilAdapter(): Promise<{ adapter: string; manager: string }> {
    const adapter = await this.sdk.registry.getCouncilAdapter();
    if (!adapter) throw new Error('the registry has no CouncilAdapter: the COUNCIL key mode is disabled');
    const a = new Contract(adapter, COUNCIL_ADAPTER_ABI, this.provider);
    const registry = getAddress((await a.getFunction('registry').staticCall()) as string);
    if (registry !== getAddress(this.config.registry)) throw new Error(`CouncilAdapter ${adapter} serves ${registry}`);
    const manager = getAddress((await a.getFunction('manager').staticCall()) as string);
    if (this.config.manager && manager !== getAddress(this.config.manager)) {
      throw new Error(`CouncilAdapter ${adapter} binds to manager ${manager}, not ${this.config.manager}`);
    }
    return { adapter, manager };
  }

  /** Creates a COUNCIL-mode process bound to `ceremonyId` and checks it carries the ceremony key. */
  async create(opts: CreateOptions): Promise<CreatedProcess> {
    const { adapter, manager } = await this.councilAdapter();
    const fields = opts.fields ?? 4;
    const census = new OffchainCensus();
    census.add([new Wallet(this.config.organizerKey).address]);
    const created = await this.sdk.createProcess({
      title: opts.title ?? 'Council-keyed process',
      description: 'Created by tools/davinci-test',
      census,
      maxVoters: opts.maxVoters ?? 1_000_000,
      electionPreset: { type: 'rating', maxValue: opts.maxValue ?? 1_000_000 },
      questions: [
        {
          title: 'Rate each option',
          choices: Array.from({ length: fields }, (_, i) => ({ title: `Option ${i + 1}`, value: i })),
        },
      ],
      timing: { duration: opts.duration ?? 3600 },
      keyMode: 'council',
      ceremonyId: opts.ceremonyId,
    });

    const p = await this.sdk.registry.getProcess(created.processId);
    if (p.keyMode !== KeyMode.Council || !p.dkg?.council) throw new Error('the process is not in COUNCIL mode');
    const m = new Contract(manager, COUNCIL_MANAGER_ABI, this.provider);
    const [x, y] = (await m.getFunction('getPublicKey').staticCall(opts.ceremonyId)) as [bigint, bigint];
    if (p.encryptionKey.x !== x || p.encryptionKey.y !== y) throw new Error('the process key is not the ceremony key');
    return {
      processId: created.processId,
      transactionHash: created.transactionHash,
      ceremonyId: p.dkg.epochId,
      encryptionKey: { x, y },
      requestId: p.dkg.aid,
      adapter,
    };
  }

  /** Ends a READY or PAUSED process now (organizer only). */
  async end(processId: string): Promise<void> {
    await this.sdk.endProcess(processId);
  }

  /**
   * Where the process stands on the way to its results, and the tally once it is on chain.
   * `finalize` sends the permissionless `finalizeResultsFromDKG` when the committee's
   * plaintexts are ready but nobody stored them yet.
   */
  async results(processId: string, opts: { finalize?: boolean } = {}): Promise<ResultsReport> {
    let status = await this.sdk.getResultsStatus(processId);
    if (status.state === 'finalizable' && opts.finalize) {
      await this.sdk.finalizeResults(processId);
      status = await this.sdk.getResultsStatus(processId);
    }
    const p = await this.sdk.registry.getProcess(processId);
    return {
      processId,
      state: status.state,
      ...(status.results && { values: status.results.values }),
      ...(p.dkg?.resultsRequested && { zeroSkipped: p.dkg.zeroSkipped }),
    };
  }
}
