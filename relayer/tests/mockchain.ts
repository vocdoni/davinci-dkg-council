/**
 * A mocked chain for the relayer unit tests: an in-memory EIP-1193 node
 * (nonces, mempool, EIP-1559 fee checks, automine or manual mining, receipts,
 * logs) hosting a fake CouncilManager. The fake implements the parts of the
 * manager the relayer observes: phase transitions for finalize/abort, request
 * and partial views, and the exact per-field combine check (via the SDK).
 * Every other signed action is accepted unless a revert is forced.
 */

import {
  COUNCIL_MANAGER_ABI,
  evalPoly,
  elgamalEncrypt,
  IDENTITY,
  MAX_COMBINE_FIELDS,
  mulBase,
  mulPoint,
  R,
  RESULT_BOUND,
  sampleNonce,
  verifyCombine,
  type Hex,
  type Point,
} from '@vocdoni/davinci-dkg-council-sdk';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  RpcRequestError,
  toHex,
  type AbiEvent,
  type PublicClient,
} from 'viem';

const ABI = COUNCIL_MANAGER_ABI;

export const MANAGER: Hex = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
export const RELAYER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const RELAYER_ADDRESS: Hex = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';

class Revert extends Error {
  constructor(readonly errorName: string) {
    super(errorName);
  }
}

export function rpcError(code: number, message: string, data?: Hex): RpcRequestError {
  return new RpcRequestError({ body: {}, error: { code, message, data }, url: 'mock://chain' });
}

interface LogEntry {
  eventName: string;
  args: Record<string, unknown>;
}

export interface FakeRequest {
  cid: Hex;
  fieldCount: number;
  cts: [bigint, bigint, bigint, bigint][];
  partials: Map<number, Point[]>;
  completed: number;
  plaintexts: bigint[];
}

export interface FakeCeremony {
  phase: number;
  threshold: number;
  n: number;
  organizer?: Hex;
}

const cloneRequest = (r: FakeRequest): FakeRequest => ({
  ...r,
  cts: r.cts.slice(),
  partials: new Map(r.partials),
  plaintexts: r.plaintexts.slice(),
});

export const cloneRequests = (m: Map<Hex, FakeRequest>): Map<Hex, FakeRequest> =>
  new Map([...m].map(([k, r]) => [k, cloneRequest(r)]));

export class FakeManager {
  readonly ceremonies = new Map<Hex, FakeCeremony>();
  requests = new Map<Hex, FakeRequest>();
  /** Bound processes without a request (getRequest returns fieldCount 0, like the contract). */
  readonly bound = new Map<Hex, Hex>();
  /** Force `fn` to revert with a custom error until deleted. */
  readonly forced = new Map<string, string>();
  /** Committed state-changing calls, in order. */
  readonly calls: { fn: string; args: readonly unknown[]; from: Hex }[] = [];

  exec(fn: string, args: readonly unknown[], from: Hex, commit: boolean): LogEntry[] {
    const forced = this.forced.get(fn);
    if (forced) throw new Revert(forced);
    const logs: LogEntry[] = [];
    switch (fn) {
      case 'finalize': {
        const cid = (args[0] as string).toLowerCase() as Hex;
        const c = this.ceremonies.get(cid);
        if (!c) throw new Revert('UnknownCeremony');
        if (c.phase !== 2) throw new Revert('WrongPhase');
        if (commit) {
          c.phase = 3;
          logs.push({ eventName: 'CeremonyFinalized', args: { cid, qualBitmap: 0, pkX: 0n, pkY: 1n } });
        }
        break;
      }
      case 'abort': {
        const cid = (args[0] as string).toLowerCase() as Hex;
        const c = this.ceremonies.get(cid);
        if (!c) throw new Revert('UnknownCeremony');
        if (c.phase !== 1 && c.phase !== 2) throw new Revert('AbortConditionNotMet');
        if (commit) {
          logs.push({ eventName: 'CeremonyAborted', args: { cid, phaseAtAbort: c.phase } });
          c.phase = 4;
        }
        break;
      }
      case 'combine':
        logs.push(...this.combine(args, commit));
        break;
      default:
        break;
    }
    if (commit) this.calls.push({ fn, args, from });
    return logs;
  }

  private combine(args: readonly unknown[], commit: boolean): LogEntry[] {
    const [requestId, memberSet, fieldIndexes, plaintexts] = args as [Hex, number[], number[], bigint[]];
    const req = this.requests.get(requestId.toLowerCase() as Hex);
    if (!req) throw new Revert('UnknownRequest');
    const c = this.ceremonies.get(req.cid) as FakeCeremony;
    if (memberSet.length !== c.threshold) throw new Revert('BadMemberSet');
    memberSet.forEach((i, k) => {
      if (i < 1 || i > c.n || (k > 0 && i <= (memberSet[k - 1] as number))) throw new Revert('BadMemberSet');
      if (!req.partials.has(i)) throw new Revert('MissingPartial');
    });
    if (fieldIndexes.length < 1 || fieldIndexes.length > MAX_COMBINE_FIELDS) throw new Revert('BadFieldIndexes');
    if (plaintexts.length !== fieldIndexes.length) throw new Revert('BadFieldIndexes');
    fieldIndexes.forEach((k, j) => {
      if (k >= req.fieldCount || (j > 0 && k <= (fieldIndexes[j - 1] as number))) throw new Revert('BadFieldIndexes');
      if (req.completed & (1 << k)) throw new Revert('FieldCompleted');
      const m = plaintexts[j] as bigint;
      if (m >= RESULT_BOUND) throw new Revert('PlaintextTooLarge');
      const row = req.cts[k] as [bigint, bigint, bigint, bigint];
      const perField = new Map(memberSet.map((i) => [i, (req.partials.get(i) as Point[])[k] as Point]));
      if (!verifyCombine(m, { x: row[2], y: row[3] }, memberSet, perField)) throw new Revert('CombineCheckFailed');
    });
    const logs: LogEntry[] = [];
    if (commit) {
      fieldIndexes.forEach((k, j) => {
        req.completed |= 1 << k;
        req.plaintexts[k] = plaintexts[j] as bigint;
      });
      logs.push({ eventName: 'FieldsCombined', args: { requestId, fieldIndexes, plaintexts } });
      if (req.completed === (1 << req.fieldCount) - 1) logs.push({ eventName: 'RequestCompleted', args: { requestId } });
    }
    return logs;
  }

  view(fn: string, args: readonly unknown[], requests: Map<Hex, FakeRequest> = this.requests): unknown {
    switch (fn) {
      case 'getCeremony': {
        const c = this.ceremonies.get((args[0] as string).toLowerCase() as Hex);
        if (!c) throw new Revert('UnknownCeremony');
        return {
          phase: c.phase,
          organizer: c.organizer ?? '0x0000000000000000000000000000000000000001',
          threshold: c.threshold,
          n: c.n,
          registrationDeadline: 0n,
          dealingDeadline: 0n,
          joinedCount: c.n,
          dealtCount: c.n,
          rosterHash: `0x${'00'.repeat(32)}`,
          ctx: `0x${'00'.repeat(32)}`,
          inviteCount: c.n,
          consumedInvites: 0n,
          qualBitmap: 0,
          pkX: 0n,
          pkY: 1n,
        };
      }
      case 'getRequest': {
        const id = (args[0] as string).toLowerCase() as Hex;
        const r = requests.get(id);
        const boundCid = this.bound.get(id);
        if (!r && boundCid) return [boundCid, 0, 0, 0, []];
        if (!r) throw new Revert('UnknownRequest');
        let bitmap = 0;
        for (const i of r.partials.keys()) bitmap |= 1 << (i - 1);
        return [r.cid, r.fieldCount, r.completed, bitmap, r.cts];
      }
      case 'getPartial': {
        const r = requests.get((args[0] as string).toLowerCase() as Hex);
        const D = r?.partials.get(args[1] as number);
        if (!D) throw new Revert('MissingPartial');
        return D.map((p) => [p.x, p.y]);
      }
      case 'getPlaintexts': {
        const r = requests.get((args[0] as string).toLowerCase() as Hex);
        if (!r) throw new Revert('UnknownRequest');
        return [r.completed === (1 << r.fieldCount) - 1, r.plaintexts];
      }
      case 'circuitReleaseId':
        return `0x${'ab'.repeat(32)}`;
      default:
        throw new Revert('UnknownCeremony');
    }
  }
}

interface MempoolTx {
  hash: Hex;
  raw: Hex;
  from: Hex;
  nonce: number;
  to: Hex;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

interface StoredLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

const hex = (v: bigint | number): Hex => toHex(v);
const blockHash = (n: bigint): Hex => keccak256(toHex(n, { size: 32 }));

export interface MockChainOptions {
  chainId?: bigint;
  automine?: boolean;
}

export class MockChain {
  readonly chainId: bigint;
  readonly manager = new FakeManager();
  automine: boolean;
  baseFee = 1_000_000_000n;
  tip = 1_000_000_000n;
  gasLimit = 30_000_000n;
  gasEstimate = 100_000n;
  /** The relayer key's balance (eth_getBalance). */
  balance = 10n ** 21n;
  blockNumber = 1n;
  /** Throw this (once) from the next eth_sendRawTransaction. */
  failNextSend: RpcRequestError | undefined;
  /** Accept the next eth_sendRawTransaction, then throw this (a lost response). */
  loseNextResponse: RpcRequestError | undefined;
  /** Fail the next eth_call with this transport error (not a revert). */
  failNextCall: Error | undefined;
  /** Observe every eth_sendRawTransaction before the node handles it. */
  beforeSend: ((raw: Hex) => void) | undefined;
  /**
   * Blocks the backend answering eth_getLogs lags behind the one answering eth_blockNumber (a
   * load-balanced public RPC): a range past its head is refused like publicnode and Tenderly do.
   */
  logsHeadLag = 0n;
  /** Widest eth_getLogs range served; wider ones are refused like a public provider's cap. */
  maxLogRange: bigint | undefined;
  /** Fail every request whose method this returns an error for (until cleared). */
  failRequests: ((method: string) => Error | undefined) | undefined;
  readonly mined = new Map<string, number>();
  readonly mempool: MempoolTx[] = [];
  readonly sentRaw: Hex[] = [];
  readonly txs = new Map<Hex, MempoolTx & { blockNumber?: bigint }>();
  readonly receipts = new Map<Hex, Record<string, unknown>>();
  readonly logs: StoredLog[] = [];
  readonly client: PublicClient;

  constructor(opts: MockChainOptions = {}) {
    this.chainId = opts.chainId ?? 31337n;
    this.automine = opts.automine ?? true;
    this.client = createPublicClient({
      transport: custom({ request: ({ method, params }) => this.request(method, (params ?? []) as unknown[]) }, { retryCount: 0 }),
      cacheTime: 0,
      pollingInterval: 50,
    }) as PublicClient;
  }

  /**
   * Another RPC endpoint onto this chain (another provider). `send` may replace the node's
   * handling of eth_sendRawTransaction — refuse it like a provider plan, rate-limit it, or
   * rewrite the node's error into something uninformative. `calls` counts its sends.
   */
  endpoint(send?: (raw: Hex, forward: () => Promise<unknown>) => Promise<unknown>): { client: PublicClient; calls: () => number } {
    let calls = 0;
    const client = createPublicClient({
      transport: custom(
        {
          request: ({ method, params }) => {
            const p = (params ?? []) as unknown[];
            if (method !== 'eth_sendRawTransaction') return this.request(method, p);
            calls++;
            const forward = () => this.request(method, p);
            return send ? send(p[0] as Hex, forward) : forward();
          },
        },
        { retryCount: 0 },
      ),
      cacheTime: 0,
    }) as PublicClient;
    return { client, calls: () => calls };
  }

  minedNonce(addr: string): number {
    return this.mined.get(addr.toLowerCase()) ?? 0;
  }

  pendingNonce(addr: string): number {
    let n = this.minedNonce(addr);
    const mine = this.mempool.filter((t) => t.from === addr.toLowerCase()).map((t) => t.nonce);
    while (mine.includes(n)) n++;
    return n;
  }

  private block(tag: unknown): Record<string, unknown> {
    const n = tag === 'latest' || tag === 'pending' || tag === undefined ? this.blockNumber : BigInt(tag as string);
    return {
      number: hex(n),
      hash: blockHash(n),
      parentHash: blockHash(n - 1n),
      timestamp: hex(1_700_000_000n + n),
      gasLimit: hex(this.gasLimit),
      gasUsed: '0x0',
      baseFeePerGas: hex(this.baseFee),
      miner: '0x0000000000000000000000000000000000000000',
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: '0x',
      logsBloom: `0x${'00'.repeat(256)}`,
      nonce: '0x0000000000000000',
      sha3Uncles: `0x${'00'.repeat(32)}`,
      size: '0x0',
      stateRoot: `0x${'00'.repeat(32)}`,
      receiptsRoot: `0x${'00'.repeat(32)}`,
      transactionsRoot: `0x${'00'.repeat(32)}`,
      mixHash: `0x${'00'.repeat(32)}`,
      transactions: [],
      uncles: [],
    };
  }

  /** Run a call against the fake manager; returns encoded output or throws a revert RPC error. */
  private run(
    from: Hex,
    to: Hex | undefined,
    data: Hex,
    commit: boolean,
    blockTag?: unknown,
  ): { output: Hex; logs: LogEntry[] } {
    if (to?.toLowerCase() !== MANAGER) return { output: '0x', logs: [] };
    try {
      const { functionName, args } = decodeFunctionData({ abi: ABI, data });
      const item = ABI.find((x) => x.type === 'function' && x.name === functionName) as { stateMutability: string };
      if (item.stateMutability === 'view' || item.stateMutability === 'pure') {
        const atFinalized = blockTag === 'finalized' && this.finalizedRequests !== undefined;
        const result = this.manager.view(functionName, args ?? [], atFinalized ? this.finalizedRequests : undefined);
        return { output: encodeFunctionResult({ abi: ABI, functionName, result } as never), logs: [] };
      }
      const logs = this.manager.exec(functionName, args ?? [], from, commit);
      return { output: '0x', logs };
    } catch (err) {
      if (err instanceof Revert) {
        const revertData = encodeErrorResult({ abi: ABI, errorName: err.errorName } as never);
        throw rpcError(3, `execution reverted: ${err.errorName}`, revertData);
      }
      throw rpcError(3, 'execution reverted', '0x');
    }
  }

  private encodeLogs(entries: LogEntry[], txHash: Hex, block: bigint): StoredLog[] {
    return entries.map((e, logIndex) => {
      const item = ABI.find((x) => x.type === 'event' && x.name === e.eventName) as AbiEvent;
      const topics = encodeEventTopics({ abi: [item], eventName: e.eventName, args: e.args } as never) as Hex[];
      const nonIndexed = item.inputs.filter((i) => !i.indexed);
      const data = encodeAbiParameters(
        nonIndexed,
        nonIndexed.map((i) => e.args[i.name as string]),
      );
      return { address: MANAGER, topics, data, blockNumber: block, transactionHash: txHash, logIndex };
    });
  }

  private emitBlock(entries: LogEntry[]): void {
    this.blockNumber++;
    const txHash = keccak256(toHex(`event-block-${this.blockNumber}`));
    this.logs.push(...this.encodeLogs(entries, txHash, this.blockNumber));
  }

  /**
   * Request state at the `finalized` tag; undefined means finalized = latest. `holdFinalized`
   * freezes it at the current state, `rollback` reorgs latest back to it.
   */
  finalizedRequests: Map<Hex, FakeRequest> | undefined;

  holdFinalized(): void {
    this.finalizedRequests = cloneRequests(this.manager.requests);
  }

  releaseFinalized(): void {
    this.finalizedRequests = undefined;
  }

  rollback(): void {
    if (this.finalizedRequests) this.manager.requests = cloneRequests(this.finalizedRequests);
  }

  /** Test setup: register a ceremony in the fake manager. */
  addCeremony(cid: Hex, c: FakeCeremony): void {
    this.manager.ceremonies.set(cid.toLowerCase() as Hex, c);
  }

  /**
   * Test setup: a request admitted by an adapter (emits RequestSubmitted in a new block, or
   * at `atBlock` — a log a reorg placed at an already-scanned height).
   */
  addRequest(requestId: Hex, cid: Hex, cts: [bigint, bigint, bigint, bigint][], atBlock?: bigint): void {
    const id = requestId.toLowerCase() as Hex;
    this.manager.requests.set(id, {
      cid: cid.toLowerCase() as Hex,
      fieldCount: cts.length,
      cts,
      partials: new Map(),
      completed: 0,
      plaintexts: cts.map(() => 0n),
    });
    const entry = { eventName: 'RequestSubmitted', args: { requestId: id, cid, fieldCount: cts.length } };
    if (atBlock === undefined) this.emitBlock([entry]);
    else this.logs.push(...this.encodeLogs([entry], keccak256(toHex(`reorg-${id}`)), atBlock));
  }

  /** Test setup: an accepted partial (D padded to 16 with the identity). */
  addPartial(requestId: Hex, index: number, D: Point[]): void {
    const req = this.manager.requests.get(requestId.toLowerCase() as Hex) as FakeRequest;
    const padded = D.slice();
    while (padded.length < 16) padded.push(IDENTITY);
    req.partials.set(index, padded);
    this.emitBlock([{ eventName: 'PartialAccepted', args: { requestId, index } }]);
  }

  private async sendRaw(raw: Hex): Promise<Hex> {
    this.beforeSend?.(raw);
    if (this.failNextSend) {
      const err = this.failNextSend;
      this.failNextSend = undefined;
      throw err;
    }
    const tx = parseTransaction(raw);
    if (tx.chainId !== Number(this.chainId)) throw rpcError(-32000, 'invalid chain id');
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase() as Hex;
    const hash = keccak256(raw);
    const nonce = tx.nonce as number;
    if (nonce < this.minedNonce(from)) throw rpcError(-32000, 'nonce too low');
    const maxFeePerGas = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
    const maxPriorityFeePerGas = tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n;
    const existing = this.mempool.findIndex((t) => t.from === from && t.nonce === nonce);
    if (existing >= 0) {
      const old = this.mempool[existing] as MempoolTx;
      if (old.hash === hash) throw rpcError(-32000, 'already known');
      if (maxFeePerGas * 10n < old.maxFeePerGas * 11n || maxPriorityFeePerGas * 10n < old.maxPriorityFeePerGas * 11n) {
        throw rpcError(-32000, 'replacement transaction underpriced');
      }
      this.mempool.splice(existing, 1);
    }
    const entry: MempoolTx = {
      hash,
      raw,
      from,
      nonce,
      to: (tx.to ?? '0x') as Hex,
      data: (tx.data ?? '0x') as Hex,
      gas: tx.gas ?? 0n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
    this.mempool.push(entry);
    this.sentRaw.push(raw);
    this.txs.set(hash, entry);
    if (this.automine) this.mine();
    if (this.loseNextResponse) {
      const err = this.loseNextResponse;
      this.loseNextResponse = undefined;
      throw err; // accepted, but the caller never hears so
    }
    return hash;
  }

  /** Mine every executable mempool transaction, one per block (in nonce order per sender). */
  mine(): void {
    for (;;) {
      const next = this.mempool.find((t) => t.nonce === this.minedNonce(t.from) && t.maxFeePerGas >= this.baseFee);
      if (!next) return;
      this.mempool.splice(this.mempool.indexOf(next), 1);
      this.blockNumber++;
      let status = '0x1';
      let logs: StoredLog[] = [];
      try {
        const { logs: entries } = this.run(next.from, next.to, next.data, true);
        logs = this.encodeLogs(entries, next.hash, this.blockNumber);
      } catch {
        status = '0x0';
      }
      this.logs.push(...logs);
      this.mined.set(next.from, next.nonce + 1);
      const stored = this.txs.get(next.hash);
      if (stored) stored.blockNumber = this.blockNumber;
      this.receipts.set(next.hash, {
        transactionHash: next.hash,
        transactionIndex: '0x0',
        blockHash: blockHash(this.blockNumber),
        blockNumber: hex(this.blockNumber),
        from: next.from,
        to: next.to,
        cumulativeGasUsed: hex(50_000n),
        gasUsed: hex(50_000n),
        effectiveGasPrice: hex(this.baseFee + next.maxPriorityFeePerGas),
        contractAddress: null,
        logs: logs.map((l) => this.formatLog(l)),
        logsBloom: `0x${'00'.repeat(256)}`,
        status,
        type: '0x2',
      });
    }
  }

  private formatLog(l: StoredLog): Record<string, unknown> {
    return {
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: hex(l.blockNumber),
      blockHash: blockHash(l.blockNumber),
      transactionHash: l.transactionHash,
      transactionIndex: '0x0',
      logIndex: hex(l.logIndex),
      removed: false,
    };
  }

  private getLogs(filter: { address?: Hex; topics?: (Hex | Hex[] | null)[]; fromBlock?: string; toBlock?: string }): unknown[] {
    const from = filter.fromBlock && filter.fromBlock !== 'latest' ? BigInt(filter.fromBlock) : 0n;
    const to = filter.toBlock && filter.toBlock !== 'latest' ? BigInt(filter.toBlock) : this.blockNumber;
    const head = this.blockNumber - this.logsHeadLag;
    if (to > head) {
      throw rpcError(-32602, `block range extends beyond current head block: requested ${to}, head ${head}`);
    }
    if (this.maxLogRange !== undefined && to - from + 1n > this.maxLogRange) {
      throw rpcError(-32005, `query exceeds max block range ${this.maxLogRange}`);
    }
    const topic0 = filter.topics?.[0];
    return this.logs
      .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
      .filter((l) => !filter.address || l.address === filter.address.toLowerCase())
      .filter((l) => !topic0 || (Array.isArray(topic0) ? topic0.includes(l.topics[0] as Hex) : topic0 === l.topics[0]))
      .map((l) => this.formatLog(l));
  }

  private txByHash(hash: Hex): Record<string, unknown> | null {
    const t = this.txs.get(hash);
    if (!t) return null;
    return {
      hash: t.hash,
      from: t.from,
      to: t.to,
      input: t.data,
      nonce: hex(t.nonce),
      gas: hex(t.gas),
      maxFeePerGas: hex(t.maxFeePerGas),
      maxPriorityFeePerGas: hex(t.maxPriorityFeePerGas),
      value: '0x0',
      type: '0x2',
      chainId: hex(this.chainId),
      blockNumber: t.blockNumber !== undefined ? hex(t.blockNumber) : null,
      blockHash: t.blockNumber !== undefined ? blockHash(t.blockNumber) : null,
      transactionIndex: t.blockNumber !== undefined ? '0x0' : null,
      v: '0x0',
      r: '0x1',
      s: '0x1',
      yParity: '0x0',
      accessList: [],
    };
  }

  async request(method: string, params: unknown[]): Promise<unknown> {
    const failure = this.failRequests?.(method);
    if (failure) throw failure;
    switch (method) {
      case 'eth_chainId':
        return hex(this.chainId);
      case 'eth_blockNumber':
        return hex(this.blockNumber);
      case 'eth_getBlockByNumber':
        return this.block(params[0]);
      case 'eth_gasPrice':
        return hex(this.baseFee);
      case 'eth_maxPriorityFeePerGas':
        return hex(this.tip);
      case 'eth_getBalance':
        return hex(this.balance);
      case 'eth_getCode':
        return (params[0] as string).toLowerCase() === MANAGER ? '0x6080' : '0x';
      case 'eth_getTransactionCount': {
        const [addr, tag] = params as [string, string];
        return hex(tag === 'pending' ? this.pendingNonce(addr) : this.minedNonce(addr));
      }
      case 'eth_call': {
        if (this.failNextCall) {
          const err = this.failNextCall;
          this.failNextCall = undefined;
          throw err;
        }
        const call = params[0] as { from?: Hex; to?: Hex; data?: Hex; input?: Hex };
        const from = (call.from ?? RELAYER_ADDRESS).toLowerCase() as Hex;
        return this.run(from, call.to, call.data ?? call.input ?? '0x', false, params[1]).output;
      }
      case 'eth_estimateGas': {
        const call = params[0] as { from?: Hex; to?: Hex; data?: Hex; input?: Hex };
        this.run((call.from ?? RELAYER_ADDRESS).toLowerCase() as Hex, call.to, call.data ?? call.input ?? '0x', false);
        return hex(this.gasEstimate);
      }
      case 'eth_sendRawTransaction':
        return this.sendRaw(params[0] as Hex);
      case 'eth_getTransactionReceipt':
        return this.receipts.get(params[0] as Hex) ?? null;
      case 'eth_getTransactionByHash':
        return this.txByHash(params[0] as Hex);
      case 'eth_getLogs':
        return this.getLogs(params[0] as never);
      default:
        throw rpcError(-32601, `method ${method} not supported by the mock`);
    }
  }
}

// --- threshold-key fixtures (real BabyJubJub arithmetic through the SDK) ---

export interface TestKey {
  P: Point;
  shares: Map<number, bigint>;
}

/** A random degree-(t-1) sharing among members 1..n. */
export function testKey(t: number, n: number): TestKey {
  const coeffs = Array.from({ length: t }, () => sampleNonce() % R);
  const shares = new Map<number, bigint>();
  for (let i = 1; i <= n; i++) shares.set(i, evalPoly(coeffs, BigInt(i)));
  return { P: mulBase(coeffs[0] as bigint), shares };
}

/** Encrypt plaintexts under P: cts rows [C1.x, C1.y, C2.x, C2.y] and the C1 points. */
export function encryptAll(P: Point, plaintexts: bigint[]): { cts: [bigint, bigint, bigint, bigint][]; c1s: Point[] } {
  const cts: [bigint, bigint, bigint, bigint][] = [];
  const c1s: Point[] = [];
  for (const m of plaintexts) {
    const { c1, c2 } = elgamalEncrypt(P, m, sampleNonce());
    cts.push([c1.x, c1.y, c2.x, c2.y]);
    c1s.push(c1);
  }
  return { cts, c1s };
}

/** D_k = s·C1_k for every field. */
export const partialOf = (share: bigint, c1s: Point[]): Point[] => c1s.map((c1) => mulPoint(c1, share));

export const ceremonyIdOf = (n: number): Hex => `0x${n.toString(16).padStart(24, '0')}`;
export const requestIdOf = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
