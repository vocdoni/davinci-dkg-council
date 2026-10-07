/**
 * The per-test-file view of the shared stack: chain clients, the SDK reader and relayer
 * client, the real prover, action submission (through the relayer or directly from any
 * funded account), time travel and the test adapter.
 */

import {
  COUNCIL_MANAGER_ABI,
  CouncilClient,
  elgamalEncrypt,
  RelayerClient,
  RelayerError,
  requestId as computeRequestId,
  sampleNonce,
  SnarkjsProver,
  type Action,
  type Hex,
  type Point,
} from '@vocdoni/davinci-dkg-council-sdk';
import {
  createPublicClient,
  createTestClient,
  decodeErrorResult,
  decodeFunctionData,
  http,
  type PublicClient,
  type TestClient,
  type TransactionReceipt,
  type WalletClient,
} from 'viem';
import { foundry } from 'viem/chains';
import { ACCOUNT, anvilAccount, walletFor } from './accounts.js';
import { deploy, loadArtifact } from './deploy.js';
import { recordGas } from './gas.js';

export interface E2EContext {
  rpcUrl: string;
  chainId: string;
  manager: Hex;
  releaseId: Hex;
  relayerUrl: string;
  relayerAddress: Hex;
  wasm: Record<'deal' | 'partial', string>;
  zkey: Record<'deal' | 'partial', string>;
}

declare module 'vitest' {
  export interface ProvidedContext {
    council: E2EContext;
  }
}

export type Via = 'relayer' | 'direct';

export interface GasLabel {
  action: string;
  params?: string;
}

const MOCK_ADAPTER = loadArtifact('MockCouncilAdapter.sol', 'MockCouncilAdapter');
/** Manager + fallback-dispatched CouncilOps/CouncilViews ABIs: decodes every custom error the deployment can raise. */
const MANAGER_ABI = [
  ...loadArtifact('CouncilManager.sol', 'CouncilManager').abi,
  ...loadArtifact('CouncilOps.sol', 'CouncilOps').abi,
  ...loadArtifact('CouncilViews.sol', 'CouncilViews').abi,
];

/** The custom error name in an RPC error's cause chain, decoded with the compiled ABI. */
export function revertName(err: unknown): string | undefined {
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const data = (cur as { data?: unknown }).data;
    if (typeof data === 'string' && /^0x[0-9a-fA-F]{8}/.test(data)) {
      try {
        return decodeErrorResult({ abi: MANAGER_ABI, data: data as Hex }).errorName;
      } catch {
        return undefined;
      }
    }
    cur = (cur as { cause?: unknown }).cause;
  }
  return undefined;
}

export class Harness {
  readonly chainId: bigint;
  readonly manager: Hex;
  readonly client: PublicClient;
  readonly test: TestClient;
  readonly reader: CouncilClient;
  readonly relayer: RelayerClient;
  readonly relayerAddress: Hex;
  readonly direct: WalletClient;
  readonly registry: WalletClient;
  readonly creator: Hex;
  readonly prover: SnarkjsProver;

  constructor(
    readonly ctx: E2EContext,
    opts: { manager?: Hex } = {},
  ) {
    this.chainId = BigInt(ctx.chainId);
    this.manager = opts.manager ?? ctx.manager;
    this.client = createPublicClient({ chain: foundry, transport: http(ctx.rpcUrl), cacheTime: 0 }) as PublicClient;
    this.test = createTestClient({ chain: foundry, mode: 'anvil', transport: http(ctx.rpcUrl) });
    this.reader = new CouncilClient({ chainId: this.chainId, manager: this.manager, rpcUrls: [ctx.rpcUrl], devMode: true });
    this.relayer = new RelayerClient(ctx.relayerUrl);
    this.relayerAddress = ctx.relayerAddress;
    this.direct = walletFor(ctx.rpcUrl, ACCOUNT.direct);
    this.registry = walletFor(ctx.rpcUrl, ACCOUNT.registry);
    this.creator = anvilAccount(ACCOUNT.creator).address.toLowerCase() as Hex;
    this.prover = new SnarkjsProver({
      deal: { wasm: ctx.wasm.deal, zkey: ctx.zkey.deal },
      partial: { wasm: ctx.wasm.partial, zkey: ctx.zkey.partial },
    });
  }

  // --- time ---

  async now(): Promise<bigint> {
    return (await this.client.getBlock({ blockTag: 'latest' })).timestamp;
  }

  async validUntil(seconds = 3600n): Promise<bigint> {
    return (await this.now()) + seconds;
  }

  /** Advance chain time and mine a block. */
  async warp(seconds: bigint): Promise<void> {
    await this.test.increaseTime({ seconds: Number(seconds) });
    await this.test.mine({ blocks: 1 });
  }

  // --- submission ---

  private async receipt(hash: Hex): Promise<TransactionReceipt> {
    return this.client.waitForTransactionReceipt({ hash, timeout: 60_000 });
  }

  /** Wait for a relayed transaction through the relayer's status endpoint, then read its receipt. */
  async waitRelayed(txHash: Hex): Promise<TransactionReceipt> {
    const deadline = Date.now() + 60_000;
    for (;;) {
      const st = await this.relayer.status(txHash);
      if (st.status === 'failed') throw new Error(`relayed tx ${txHash} failed: ${st.revertReason ?? 'reverted'}`);
      if (st.status === 'confirmed') {
        const mined = (st as { minedTxHash?: Hex }).minedTxHash ?? txHash;
        return this.receipt(mined);
      }
      if (Date.now() > deadline) throw new Error(`relayed tx ${txHash} still pending`);
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  /** Submit an action through the relayer or directly from a funded account; records its gas. */
  async submit(action: Action, via: Via, gas?: GasLabel): Promise<TransactionReceipt> {
    let receipt: TransactionReceipt;
    if (via === 'relayer') {
      receipt = await this.waitRelayed(await this.relayer.relay(this.chainId, this.manager, action));
    } else {
      const hash = await this.reader.sendAction(this.direct as never, action);
      receipt = await this.receipt(hash);
    }
    if (receipt.status !== 'success') throw new Error(`${action.kind} reverted (${receipt.transactionHash})`);
    recordGas(gas?.action ?? action.kind, gas?.params ?? '', via, receipt.gasUsed);
    return receipt;
  }

  /**
   * The relayer must refuse a reverting action after simulation, with the decoded custom error,
   * and must not spend anything on it.
   */
  async expectRelayRevert(action: Action, errorName: string): Promise<void> {
    const before = await this.client.getTransactionCount({ address: this.relayerAddress, blockTag: 'pending' });
    const err = await this.relayer.relay(this.chainId, this.manager, action).catch((e: unknown) => e);
    if (!(err instanceof RelayerError)) throw new Error(`expected a relayer error, got ${String(err)}`);
    if (err.code !== 'SIMULATION_REVERTED' || err.detail !== `${errorName}()`) {
      throw new Error(`expected SIMULATION_REVERTED ${errorName}(), got ${err.code}: ${err.detail}`);
    }
    const after = await this.client.getTransactionCount({ address: this.relayerAddress, blockTag: 'pending' });
    if (after !== before) throw new Error('the relayer sent a transaction for a reverting action');
  }

  /** A direct call must revert with `errorName` (checked by simulation, nothing sent). */
  async expectDirectRevert(action: Action, errorName: string): Promise<void> {
    const { to, data } = this.reader.actionCalldata(action);
    let failure: unknown;
    try {
      await this.client.call({ account: this.direct.account?.address as Hex, to, data });
    } catch (err) {
      failure = err;
    }
    if (failure === undefined) throw new Error(`${action.kind} unexpectedly succeeded`);
    const got = revertName(failure);
    if (got !== errorName) throw new Error(`expected ${errorName}(), got ${got ?? String(failure)}`);
  }

  // --- adapter (the test double of the DAVINCI CouncilAdapter; `registry` drives it) ---

  async deployAdapter(): Promise<Hex> {
    return deploy(this.registry, this.client, MOCK_ADAPTER, [this.manager]);
  }

  private async adapterTx(adapter: Hex, functionName: string, args: readonly unknown[], gas: GasLabel): Promise<TransactionReceipt> {
    const { request } = await this.client.simulateContract({
      address: adapter,
      abi: MOCK_ADAPTER.abi,
      functionName,
      args,
      account: this.registry.account ?? null,
    } as never);
    const hash = await this.registry.writeContract(request as never);
    const receipt = await this.receipt(hash);
    if (receipt.status !== 'success') throw new Error(`${functionName} reverted`);
    recordGas(gas.action, gas.params ?? '', 'adapter', receipt.gasUsed);
    return receipt;
  }

  /** Bind a process through the adapter; returns its request id (checked against §4.5). */
  async bind(adapter: Hex, cid: Hex, processId: Hex): Promise<Hex> {
    await this.adapterTx(adapter, 'register', [processId, this.creator, cid], { action: 'bindProcess' });
    const [boundCid, rid] = (await this.client.readContract({
      address: this.manager,
      abi: COUNCIL_MANAGER_ABI,
      functionName: 'getBinding',
      args: [adapter, processId],
    })) as readonly [Hex, Hex, boolean];
    const expected = computeRequestId(this.chainId, this.manager, cid, adapter, processId);
    if (boundCid.toLowerCase() !== cid.toLowerCase() || rid !== expected) throw new Error('binding mismatch');
    return rid;
  }

  /** Encrypt known plaintexts under the ceremony key and submit them as the request. */
  async request(adapter: Hex, cid: Hex, requestIdValue: Hex, plaintexts: bigint[], publicKey: Point): Promise<void> {
    const cts = plaintexts.map((m) => {
      const { c1, c2 } = elgamalEncrypt(publicKey, m, sampleNonce());
      return [c1.x, c1.y, c2.x, c2.y] as const;
    });
    await this.adapterTx(adapter, 'submit', [cid, requestIdValue, cts], {
      action: 'submitRequest',
      params: `fields=${plaintexts.length}`,
    });
  }

  async adapterPlaintexts(adapter: Hex, cid: Hex, requestIdValue: Hex, fieldCount: number): Promise<{ ready: boolean; values: bigint[] }> {
    const [ready, values] = (await this.client.readContract({
      address: adapter,
      abi: MOCK_ADAPTER.abi,
      functionName: 'plaintexts',
      args: [cid, requestIdValue, 0, fieldCount],
    })) as readonly [boolean, readonly bigint[]];
    return { ready, values: values.slice() };
  }

  /** Wait until the request is complete (combined by whoever), then return the plaintexts. */
  async waitPlaintexts(requestIdValue: Hex, timeoutMs = 180_000): Promise<bigint[]> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { ready, values } = await this.reader.getPlaintexts(requestIdValue);
      if (ready) return values;
      if (Date.now() > deadline) throw new Error(`request ${requestIdValue} not combined in time`);
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  /** Record the gas of every combine transaction of a request (whoever sent it); returns the chunks. */
  async recordCombineGas(
    requestIdValue: Hex,
    t: number,
  ): Promise<{ hash: Hex; fields: number; memberSet: number[]; sender: Hex }[]> {
    const logs = await this.client.getContractEvents({
      address: this.manager,
      abi: COUNCIL_MANAGER_ABI,
      eventName: 'FieldsCombined',
      args: { requestId: requestIdValue },
      fromBlock: 0n,
    });
    const out: { hash: Hex; fields: number; memberSet: number[]; sender: Hex }[] = [];
    for (const l of logs) {
      const hash = l.transactionHash as Hex;
      const fields = (l.args as { fieldIndexes: readonly number[] }).fieldIndexes.length;
      const receipt = await this.receipt(hash);
      const tx = await this.client.getTransaction({ hash });
      const { args } = decodeFunctionData({ abi: COUNCIL_MANAGER_ABI, data: tx.input });
      const sender = receipt.from.toLowerCase() as Hex;
      recordGas('combine', `t=${t}, fields=${fields}`, sender === this.relayerAddress ? 'relayer (worker)' : 'direct', receipt.gasUsed);
      out.push({ hash, fields, memberSet: [...((args as readonly unknown[])[1] as readonly number[])], sender });
    }
    return out;
  }
}

/** A random bytes31 process id. */
export function randomProcessId(): Hex {
  const bytes = new Uint8Array(31);
  globalThis.crypto.getRandomValues(bytes);
  return `0x${Buffer.from(bytes).toString('hex')}`;
}
