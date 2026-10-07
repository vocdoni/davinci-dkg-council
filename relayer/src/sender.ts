/**
 * Transaction sender for the relayer's one hot key (architecture §5.2):
 * simulate-before-send, local nonce allocation, capped EIP-1559 fees, receipt
 * tracking, fee bump / rebroadcast for stuck transactions, and the global
 * spending budget.
 *
 * Every sponsored action names the one-shot protocol state it consumes (its
 * "slots": a dealer's dealing, a member's partial for a request, a combine
 * field, …). A slot is reserved from acceptance until the transaction
 * settles: an identical action resolves to the pending transaction, and a
 * conflicting variant (other expiry, signature or member set) is refused
 * with CONFLICT instead of being paid for as a certain revert.
 *
 * Signed pending transactions, recent outcomes and the spend log persist in
 * the state store, so a restart rebroadcasts evicted transactions instead of
 * reusing their nonces, and keeps answering /v1/status for what it sent.
 *
 * Only verified answers move a transaction on. A read that fails (a receipt or
 * transaction lookup, the finalized nonce) is "unavailable", never "not found":
 * it neither releases a reservation nor deletes a journal entry. A transaction
 * is charged its mined cost when its receipt appears, and kept replayable
 * (signed bytes, nonce, and the rest of its worst case reserved) until its
 * block is finalized: one a reorg removes is rebroadcast at its original nonce,
 * so later nonces never queue behind a hole, and a re-mined one is charged only
 * the difference. A transaction is reported dropped only once its nonce is
 * consumed at the finalized block with no receipt of any of its hashes.
 */

import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { keccak256, type PublicClient, type TransactionReceipt, type TransactionSerializable } from 'viem';
import type { PrivateKeyAccount } from 'viem/accounts';
import { broadcastRaw, BroadcastError, classifySendError, type Endpoint } from './broadcast.js';
import { SpendBudget } from './budget.js';
import { decodeRevert, extractRevertData, isRevert, RelayError, shortMessage, simulationError } from './errors.js';
import { silentLogger, type Logger } from './log.js';
import { StateStore, type PersistedFees, type PersistedTx, type SettledTx } from './state.js';

export interface SenderOptions {
  client: PublicClient;
  account: PrivateKeyAccount;
  chainId: bigint;
  /** Cap on maxFeePerGas / gasPrice, including every bump (COUNCIL_MAX_FEE_WEI). */
  maxFeeWei: bigint;
  /** Bump or rebroadcast a transaction still pending after this long. */
  bumpAfterMs: number;
  /** Rolling-window spending limit in wei; 0 disables it (COUNCIL_DAILY_BUDGET_WEI). */
  budgetWei?: bigint;
  budgetWindowMs?: number;
  /** Persistence (pending transactions, outcomes, spend log); in memory when omitted. */
  store?: StateStore;
  /**
   * Endpoints a signed transaction is broadcast to, in order (one per COUNCIL_RPC_URL entry);
   * defaults to `client`. Reads keep going through `client`.
   */
  endpoints?: Endpoint[];
  /**
   * Re-read the key's on-chain pending nonce before a send when the last check or successful
   * broadcast is older than this, so transactions sent with the key from elsewhere self-heal.
   */
  nonceRefreshMs?: number;
  /** Gas limit = estimate · (100 + headroom) / 100. */
  gasHeadroomPercent?: number;
  /**
   * Cap on one transaction's gas limit, below the block gas limit (COUNCIL_MAX_TX_GAS);
   * defaults to the EIP-7825 (Osaka) per-transaction maximum, or to none with `stateGas`.
   */
  maxTxGas?: bigint;
  /**
   * The chain prices state growth separately (EIP-8037, Glamsterdam; COUNCIL_STATE_GAS): the
   * EIP-7825 maximum then bounds execution gas only, and a transaction sets a larger gas limit to
   * cover its state gas, so without an explicit `maxTxGas` only the block gas limit caps it.
   */
  stateGas?: boolean;
  /** Fallback priority fee when the node has no eth_maxPriorityFeePerGas. */
  defaultTipWei?: bigint;
  /**
   * Mined transactions awaiting finality at most; beyond it new sends are refused (BUSY) until
   * the finalized block catches up. Never evicted: each must stay replayable until final.
   */
  maxUnfinal?: number;
  log?: Logger;
  now?: () => number;
}

export interface SendOptions {
  /** One-shot protocol state this action consumes (see the module comment). */
  slots?: string[];
  /**
   * Called once simulation succeeded, inside the send queue, with the worst-case
   * cost: charge quotas here (throw to refuse). The returned undo runs if the
   * broadcast fails.
   */
  reserve?: (cost: bigint) => (() => void) | void;
}

type Fees =
  | { type: 'eip1559'; maxFeePerGas: bigint; maxPriorityFeePerGas: bigint }
  | { type: 'legacy'; gasPrice: bigint };

export type TxState = 'pending' | 'confirmed' | 'failed';

interface TrackedTx {
  nonce: number;
  to: Hex;
  data: Hex;
  gas: bigint;
  fees: Fees;
  raw: Hex;
  hashes: Hex[];
  slots: string[];
  firstSentAt: number;
  lastSentAt: number;
  state: TxState;
  /** Passes in a row the nonce was consumed at the finalized block with no receipt of ours. */
  orphanTicks: number;
  /** Checks in a row a mined transaction's receipt was verified absent (a reorg). */
  absentTicks: number;
  /** When a mined transaction's receipt was last checked. */
  checkedAt: number;
  /** Highest worst case of any version signed for this nonce (a bump accepted behind a lost reply included). */
  maxWorstWei: bigint;
  /** Spend-log entries written for this nonce: what a re-mined replay is credited within the window. */
  charges: { t: number; wei: bigint }[];
  blockNumber?: bigint;
  blockHash?: Hex;
  minedHash?: Hex;
  revertReason?: string;
  settledAt?: number;
}

/** A sender loop's health, for /v1/metrics. */
export interface LoopStatus {
  lastSuccessAt?: number;
  lastFailureAt?: number;
  /** Consecutive failed passes. */
  failures: number;
}

export interface TxStatus {
  status: TxState;
  blockNumber?: string;
  revertReason?: string;
  /** Set when a fee bump replaced the queried hash and the replacement was mined. */
  minedTxHash?: Hex;
}

/** Settled outcomes kept for /v1/status: at most this many, for at most HISTORY_TTL_MS. */
const MAX_HISTORY = 2000;
const HISTORY_TTL_MS = 7 * 24 * 3_600_000;
/** Passes a consumed nonce must look final and receipt-less before its transaction is dropped. */
const DROP_AFTER = 3;
/** Checks a mined transaction's receipt must be verified absent before it counts as reorged out. */
const ORPHAN_AFTER = 2;
/** A mined transaction that is not final yet has its receipt re-checked at most this often. */
const MINED_RECHECK_MS = 15_000;
/** Default cap on mined transactions awaiting finality before sends pause (SenderOptions.maxUnfinal). */
const MAX_UNFINAL = 512;
const INSUFFICIENT_FUNDS = /insufficient funds/i;
/** A lookup that failed: not an answer (never "not found"). */
const UNAVAILABLE = Symbol('unavailable');
type Lookup<T> = T | undefined | typeof UNAVAILABLE;

/** viem raises a named error when the node answers null (a verified absence). */
const notFound = (err: unknown, name: string): boolean => {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { name?: unknown }).name === name) return true;
  }
  return false;
};
/** EIP-7825 (Osaka): a transaction whose gas limit exceeds 2^24 is invalid. */
export const MAX_TX_GAS = 16_777_216n;
const DAY_MS = 24 * 3_600_000;

const bumped = (v: bigint): bigint => (v * 1125n) / 1000n + 1n;
const maxOf = (a: bigint, b: bigint): bigint => (a > b ? a : b);
const worstCase = (gas: bigint, fees: Fees): bigint => gas * (fees.type === 'eip1559' ? fees.maxFeePerGas : fees.gasPrice);

const feesOut = (f: Fees): PersistedFees =>
  f.type === 'eip1559'
    ? { type: 'eip1559', maxFeePerGas: f.maxFeePerGas.toString(), maxPriorityFeePerGas: f.maxPriorityFeePerGas.toString() }
    : { type: 'legacy', gasPrice: f.gasPrice.toString() };

const feesIn = (f: PersistedFees): Fees =>
  f.type === 'eip1559'
    ? { type: 'eip1559', maxFeePerGas: BigInt(f.maxFeePerGas), maxPriorityFeePerGas: BigInt(f.maxPriorityFeePerGas) }
    : { type: 'legacy', gasPrice: BigInt(f.gasPrice) };

export class TxSender {
  readonly address: Hex;
  readonly budget: SpendBudget;
  private readonly client: PublicClient;
  private readonly account: PrivateKeyAccount;
  private readonly chainId: bigint;
  private readonly maxFeeWei: bigint;
  private readonly bumpAfterMs: number;
  private readonly headroom: bigint;
  /** Undefined: only the block gas limit caps a transaction (EIP-8037 chains). */
  private readonly maxTxGas: bigint | undefined;
  private readonly defaultTip: bigint;
  private readonly store: StateStore;
  private readonly log: Logger;
  private readonly now: () => number;

  private readonly endpoints: Endpoint[];
  private readonly nonceRefreshMs: number;
  private readonly maxUnfinal: number;
  private nextNonce: number | undefined;
  /** When the local nonce was last confirmed against the chain (a check or a successful send). */
  private nonceFreshAt = Number.NEGATIVE_INFINITY;
  /** Transactions seen on chain from this key that this relayer did not send. */
  foreignTransactions = 0;
  private lock: Promise<unknown> = Promise.resolve();
  /** Unmined transactions, by nonce. */
  private readonly pending = new Map<number, TrackedTx>();
  /** Mined, not final yet: replayable until their block is finalized. */
  private readonly mined = new Map<number, TrackedTx>();
  /** Every hash this relayer sent (pending and settled, bounded). */
  private readonly byHash = new Map<Hex, TrackedTx>();
  private settled: TrackedTx[] = [];
  /** slot -> nonce of the pending transaction holding it. */
  private readonly slots = new Map<string, number>();
  private timer: NodeJS.Timeout | undefined;
  private monitoring = false;
  private readonly monitor: LoopStatus = { failures: 0 };

  constructor(opts: SenderOptions) {
    this.client = opts.client;
    this.account = opts.account;
    this.address = opts.account.address.toLowerCase() as Hex;
    this.chainId = opts.chainId;
    this.maxFeeWei = opts.maxFeeWei;
    this.bumpAfterMs = opts.bumpAfterMs;
    this.headroom = BigInt(opts.gasHeadroomPercent ?? 20);
    this.maxTxGas = opts.maxTxGas ?? (opts.stateGas ? undefined : MAX_TX_GAS);
    this.defaultTip = opts.defaultTipWei ?? 1_000_000_000n;
    this.store = opts.store ?? new StateStore();
    this.endpoints = opts.endpoints && opts.endpoints.length > 0 ? opts.endpoints : [{ name: 'rpc', client: opts.client }];
    this.nonceRefreshMs = opts.nonceRefreshMs ?? 15_000;
    this.maxUnfinal = opts.maxUnfinal ?? MAX_UNFINAL;
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
    this.budget = new SpendBudget(this.store, opts.budgetWei ?? 0n, opts.budgetWindowMs ?? DAY_MS, this.now);
    this.load();
  }

  /** Rebuild in-memory tracking from the state store. */
  private load(): void {
    const s = this.store.state;
    for (const h of s.history) {
      const tx: TrackedTx = {
        nonce: -1,
        to: '0x',
        data: '0x',
        gas: 0n,
        fees: { type: 'legacy', gasPrice: 0n },
        raw: '0x',
        hashes: h.hashes,
        slots: [],
        firstSentAt: 0,
        lastSentAt: 0,
        state: h.state,
        orphanTicks: 0,
        absentTicks: 0,
        checkedAt: 0,
        maxWorstWei: 0n,
        charges: [],
        blockNumber: h.blockNumber !== undefined ? BigInt(h.blockNumber) : undefined,
        minedHash: h.minedHash,
        revertReason: h.revertReason,
        settledAt: h.settledAt,
      };
      this.settled.push(tx);
      for (const hash of tx.hashes) this.byHash.set(hash, tx);
    }
    this.pruneHistory();
    for (const p of s.pending) {
      const fees = feesIn(p.fees);
      const tx: TrackedTx = {
        nonce: p.nonce,
        to: p.to,
        data: p.data,
        gas: BigInt(p.gas),
        fees,
        raw: p.raw,
        hashes: p.hashes,
        slots: p.slots,
        firstSentAt: p.firstSentAt ?? p.lastSentAt,
        lastSentAt: p.lastSentAt,
        state: 'pending',
        orphanTicks: 0,
        absentTicks: 0,
        checkedAt: 0,
        // Files from before these fields: the reservation and the current fees bound it.
        maxWorstWei: BigInt(p.maxWorstWei ?? maxOf(BigInt(p.reservedWei), worstCase(BigInt(p.gas), fees)).toString()),
        charges: (p.charges ?? []).map((c) => ({ t: c.t, wei: BigInt(c.wei) })),
      };
      for (const hash of tx.hashes) this.byHash.set(hash, tx);
      this.budget.reserve(tx.nonce, BigInt(p.reservedWei));
      if (p.mined) {
        tx.state = p.mined.state;
        tx.blockNumber = BigInt(p.mined.blockNumber);
        tx.blockHash = p.mined.blockHash;
        tx.minedHash = p.mined.hash;
        tx.revertReason = p.mined.revertReason;
        tx.settledAt = p.mined.settledAt;
        this.mined.set(tx.nonce, tx);
        continue;
      }
      this.pending.set(tx.nonce, tx);
      for (const slot of tx.slots) this.slots.set(slot, tx.nonce);
    }
  }

  private persist(): void {
    const s = this.store.state;
    s.pending = [...this.pending.values(), ...this.mined.values()].map(
      (t): PersistedTx => ({
        nonce: t.nonce,
        to: t.to,
        data: t.data,
        gas: t.gas.toString(),
        fees: feesOut(t.fees),
        raw: t.raw,
        hashes: t.hashes,
        lastSentAt: t.lastSentAt,
        firstSentAt: t.firstSentAt,
        slots: t.slots,
        reservedWei: this.budget.reservedFor(t.nonce).toString(),
        maxWorstWei: t.maxWorstWei.toString(),
        charges: t.charges.map((c) => ({ t: c.t, wei: c.wei.toString() })),
        mined:
          t.state === 'pending'
            ? undefined
            : {
                state: t.state,
                blockNumber: (t.blockNumber ?? 0n).toString(),
                blockHash: t.blockHash,
                hash: t.minedHash as Hex,
                revertReason: t.revertReason,
                settledAt: t.settledAt ?? 0,
              },
      }),
    );
    s.history = this.settled.map(
      (t): SettledTx => ({
        hashes: t.hashes,
        state: t.state as 'confirmed' | 'failed',
        blockNumber: t.blockNumber?.toString(),
        revertReason: t.revertReason,
        minedHash: t.minedHash,
        settledAt: t.settledAt ?? 0,
      }),
    );
    this.store.flush();
  }

  /** Run `fn` after every previously queued send/monitor step (one account, one queue). */
  private serialize<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  private chainNonce(): Promise<number> {
    return this.client.getTransactionCount({ address: this.address, blockTag: 'pending' });
  }

  /**
   * Adopt the chain's pending nonce: never below a nonce this instance still tracks (an
   * evicted transaction keeps its nonce and is rebroadcast instead of being overwritten),
   * and below the local value only when `allowLower` (after a refused broadcast). A chain
   * ahead of `expected` means the key sent transactions this relayer did not: warn.
   */
  private adoptNonce(chain: number, expected: number | undefined, allowLower: boolean): number {
    let next = chain;
    // Mined but not final counts too: a reorg may hand such a nonce back, and it is replayed.
    for (const nonce of [...this.pending.keys(), ...this.mined.keys()]) if (nonce + 1 > next) next = nonce + 1;
    if (!allowLower && this.nextNonce !== undefined && this.nextNonce > next) next = this.nextNonce;
    if (expected !== undefined && chain > expected) {
      this.foreignTransactions += chain - expected;
      this.log.warn('hot key used outside the relayer: its on-chain nonce moved by transactions this relayer did not send', {
        expected,
        onChain: chain,
        foreign: chain - expected,
        hint: 'give the relayer a key nothing else uses',
      });
    }
    this.nextNonce = next;
    this.nonceFreshAt = this.now();
    return next;
  }

  /** Resync the local nonce from the node's `pending` count (may move it down). */
  async syncNonce(): Promise<number> {
    return this.adoptNonce(await this.chainNonce(), this.nextNonce, true);
  }

  /** Before a send after a quiet spell: catch up with the chain, never moving down. */
  private async reconcileNonce(): Promise<void> {
    if (this.nextNonce !== undefined && this.now() - this.nonceFreshAt < this.nonceRefreshMs) return;
    this.adoptNonce(await this.chainNonce(), this.nextNonce, this.nextNonce === undefined);
  }

  /**
   * Startup: rebroadcast every persisted pending transaction (a node restart or
   * pool eviction may have lost it) and resync the nonce above them. Run before
   * accepting new submissions.
   */
  recover(): Promise<void> {
    return this.serialize(async () => {
      for (const tx of [...this.pending.values()].sort((a, b) => a.nonce - b.nonce)) {
        try {
          await this.broadcast(tx.raw);
          this.log.info('recovered pending tx', { nonce: tx.nonce, hash: tx.hashes[tx.hashes.length - 1] });
        } catch (err) {
          // Mined already (nonce too low) or replaced: the monitor settles it from receipts.
          this.log.warn('recovered tx not rebroadcast', { nonce: tx.nonce, err: shortMessage(err) });
        }
        tx.lastSentAt = this.now();
      }
      await this.syncNonce();
      this.persist();
    });
  }

  /** True while a pending transaction holds a slot starting with `prefix` (e.g. a request's combine fields). */
  holds(prefix: string): boolean {
    for (const slot of this.slots.keys()) if (slot.startsWith(prefix)) return true;
    return false;
  }

  /** Number of transactions this instance is still tracking as pending (not mined). */
  get pendingCount(): number {
    return this.pending.size;
  }

  /** Mined transactions whose block is not finalized yet (kept replayable). */
  get awaitingFinality(): number {
    return this.mined.size;
  }

  /** How long the oldest mined transaction has awaited finality (0 when none). */
  oldestUnfinalMs(): number {
    let first = Number.POSITIVE_INFINITY;
    for (const tx of this.mined.values()) if ((tx.settledAt ?? first) < first) first = tx.settledAt as number;
    return first === Number.POSITIVE_INFINITY ? 0 : Math.max(0, this.now() - first);
  }

  /** Age of the oldest unmined transaction (0 when none). */
  oldestPendingMs(): number {
    let first = Number.POSITIVE_INFINITY;
    for (const tx of this.pending.values()) if (tx.firstSentAt < first) first = tx.firstSentAt;
    return first === Number.POSITIVE_INFINITY ? 0 : Math.max(0, this.now() - first);
  }

  /** The monitor loop's health. */
  monitorStatus(): LoopStatus {
    return { ...this.monitor };
  }

  async balance(): Promise<bigint> {
    return this.client.getBalance({ address: this.address });
  }

  /**
   * eth_call with the exact calldata from the relayer's address. A revert is
   * returned as SIMULATION_REVERTED with the decoded custom error.
   */
  async simulate(to: Hex, data: Hex): Promise<void> {
    try {
      await this.client.call({ account: this.address, to, data });
    } catch (err) {
      if (isRevert(err)) throw simulationError(err);
      throw new RelayError('INTERNAL', `simulation failed: ${shortMessage(err)}`);
    }
  }

  private async estimateGas(to: Hex, data: Hex): Promise<bigint> {
    try {
      return await this.client.estimateGas({ account: this.address, to, data });
    } catch (err) {
      if (isRevert(err)) throw simulationError(err);
      throw new RelayError('INTERNAL', `gas estimation failed: ${shortMessage(err)}`);
    }
  }

  private async suggestFees(): Promise<Fees> {
    const block = await this.client.getBlock({ blockTag: 'latest' });
    const base = block.baseFeePerGas;
    if (base === null || base === undefined) {
      const gasPrice = await this.client.getGasPrice();
      if (gasPrice > this.maxFeeWei) {
        throw new RelayError('TX_FAILED', `gas price ${gasPrice} exceeds COUNCIL_MAX_FEE_WEI ${this.maxFeeWei}`);
      }
      return { type: 'legacy', gasPrice };
    }
    if (base >= this.maxFeeWei) {
      throw new RelayError('TX_FAILED', `base fee ${base} reaches COUNCIL_MAX_FEE_WEI ${this.maxFeeWei}`);
    }
    let tip: bigint;
    try {
      tip = BigInt(await this.client.request({ method: 'eth_maxPriorityFeePerGas' }));
    } catch {
      tip = this.defaultTip;
    }
    let maxFeePerGas = base * 2n + tip;
    if (maxFeePerGas > this.maxFeeWei) maxFeePerGas = this.maxFeeWei;
    if (tip > maxFeePerGas - base) tip = maxFeePerGas - base;
    return { type: 'eip1559', maxFeePerGas, maxPriorityFeePerGas: tip };
  }

  private async sign(nonce: number, to: Hex, data: Hex, gas: bigint, fees: Fees): Promise<Hex> {
    const base = { chainId: Number(this.chainId), nonce, to, data, gas, value: 0n };
    const tx: TransactionSerializable =
      fees.type === 'eip1559'
        ? { ...base, type: 'eip1559', maxFeePerGas: fees.maxFeePerGas, maxPriorityFeePerGas: fees.maxPriorityFeePerGas }
        : { ...base, type: 'legacy', gasPrice: fees.gasPrice };
    return this.account.signTransaction(tx);
  }

  /**
   * eth_sendRawTransaction over the endpoints (broadcast.ts): endpoint refusals move on to the
   * next endpoint, "already known" counts as accepted, the most informative refusal is raised.
   */
  private async broadcast(raw: Hex): Promise<void> {
    await broadcastRaw(this.endpoints, raw, (endpoint, kind, err) =>
      this.log.warn('broadcast endpoint refused, trying the next one', { endpoint, kind, err: shortMessage(err) }),
    );
    this.nonceFreshAt = this.now();
  }

  /**
   * A node refuses a transaction whose worst case (gas limit × max fee), with what the key
   * already has in flight, exceeds the key's balance. Refuse it here with a plain answer
   * instead of a broadcast error.
   */
  private async checkBalance(cost: bigint): Promise<void> {
    const balance = await this.balance().catch(() => undefined);
    if (balance === undefined) return; // the broadcast will tell
    if (balance < cost + this.unminedExposure()) throw this.underfunded(balance, cost);
  }

  /** Worst cases of the unmined transactions: what a node holds against the key's balance. */
  private unminedExposure(): bigint {
    let sum = 0n;
    for (const nonce of this.pending.keys()) sum += this.budget.reservedFor(nonce);
    return sum;
  }

  private underfunded(balance: bigint | undefined, cost: bigint): RelayError {
    const inFlight = this.unminedExposure();
    this.log.error('hot key balance too low: top it up', { balanceWei: balance, needsWei: cost + inFlight, address: this.address });
    return new RelayError(
      'BUDGET_EXHAUSTED',
      `sponsorship paused: the relayer key holds ${balance ?? 'too little'} wei, and this action may cost up to ${cost} wei` +
        (inFlight > 0n ? ` (plus ${inFlight} wei in flight)` : '') +
        '; the operator must top it up',
    );
  }

  /** Does the node know this transaction? A failed lookup is 'unavailable', not 'no'. */
  private async known(hash: Hex): Promise<'yes' | 'no' | 'unavailable'> {
    try {
      await this.client.getTransaction({ hash });
      return 'yes';
    } catch (err) {
      return notFound(err, 'TransactionNotFoundError') ? 'no' : 'unavailable';
    }
  }

  /**
   * Simulate, estimate, check the budget, sign with the next local nonce and
   * broadcast. Never pays for an action that reverts in simulation. Resolves
   * to the tx hash. An identical action still pending resolves to that
   * transaction; a different action holding one of the same slots is refused.
   */
  send(to: Hex, data: Hex, opts: SendOptions = {}): Promise<Hex> {
    const slots = [...new Set(opts.slots ?? [])];
    return this.serialize(async () => {
      for (const tx of this.pending.values()) {
        if (tx.to === to && tx.data === data) return tx.hashes[tx.hashes.length - 1] as Hex;
      }
      for (const slot of slots) {
        const holder = this.slots.get(slot);
        if (holder !== undefined) {
          const tx = this.pending.get(holder) as TrackedTx;
          throw new RelayError(
            'CONFLICT',
            `a conflicting action for ${slot} is pending (${tx.hashes[tx.hashes.length - 1]}); retry once it settles`,
          );
        }
      }
      if (this.mined.size >= this.maxUnfinal) {
        // Each must stay replayable until final; refusing new work is the only safe bound.
        this.log.error('sponsorship paused: too many transactions await finality', {
          awaitingFinality: this.mined.size,
          hint: 'the rpc reports no advancing finalized block',
        });
        throw new RelayError(
          'BUSY',
          `sponsorship paused: ${this.mined.size} sent transactions await finality (the finalized block does not advance); retry later`,
        );
      }
      let undo: (() => void) | undefined;
      let reserved = false;
      try {
        for (let attempt = 0; ; attempt++) {
          await this.simulate(to, data);
          const estimate = await this.estimateGas(to, data);
          let gas = (estimate * (100n + this.headroom)) / 100n;
          const block = await this.client.getBlock({ blockTag: 'latest' });
          const cap = this.maxTxGas !== undefined && this.maxTxGas < block.gasLimit ? this.maxTxGas : block.gasLimit;
          if (gas > cap) gas = cap;
          const fees = await this.suggestFees();
          const cost = worstCase(gas, fees);
          this.budget.check(cost);
          await this.checkBalance(cost);
          if (!reserved) {
            undo = opts.reserve?.(cost) ?? undefined;
            reserved = true;
          }
          await this.reconcileNonce();
          const nonce = this.nextNonce as number;
          const raw = await this.sign(nonce, to, data, gas, fees);
          const hash = keccak256(raw);
          // Journaled before broadcasting: a crash after the node accepted it must not
          // lose the signed transaction, its nonce, its slots or its budget reservation.
          this.track(nonce, to, data, gas, fees, raw, hash, slots, cost);
          try {
            await this.broadcast(raw);
          } catch (err) {
            // A failed response may hide an accepted transaction (lost reply, retried
            // request): keep it rather than paying for the same action twice. Only a node
            // that verifiably does not know it frees the journal entry; when the lookup
            // fails too, the signed transaction keeps its nonce, slots and reservation and
            // the monitor rebroadcasts it.
            const seen = await this.known(hash);
            if (seen === 'yes') return this.sent(hash, nonce, gas);
            if (seen === 'unavailable') {
              this.log.warn('broadcast outcome unknown: the transaction stays journaled and the monitor rebroadcasts it', {
                hash,
                nonce,
                err: shortMessage(err),
              });
              return this.sent(hash, nonce, gas);
            }
            this.untrack(nonce);
            // Any failed send reconciles the nonce. If the chain is past the nonce we
            // tried (the key was used elsewhere), retry once even when no endpoint said
            // "nonce too low" in so many words.
            const kind = err instanceof BroadcastError ? err.kind : classifySendError(err);
            const chain = await this.chainNonce().catch(() => undefined);
            if (chain !== undefined) {
              if (chain > nonce && (await this.known(hash)) !== 'no') {
                this.track(nonce, to, data, gas, fees, raw, hash, slots, cost);
                return this.sent(hash, nonce, gas);
              }
              this.adoptNonce(chain, nonce, true);
            }
            if (attempt === 0 && (kind === 'nonce' || (chain !== undefined && chain > nonce))) {
              this.log.warn('nonce resync', { tried: nonce, next: this.nextNonce, refusal: kind });
              continue; // simulated again against the fresh state
            }
            if (INSUFFICIENT_FUNDS.test(shortMessage(err))) {
              this.log.error('hot key balance too low: top it up', { address: this.address, err: shortMessage(err) });
              throw new RelayError('TX_FAILED', `the relayer key cannot pay for this action; the operator must top it up (${shortMessage(err)})`);
            }
            throw new RelayError('TX_FAILED', shortMessage(err));
          }
          return this.sent(hash, nonce, gas);
        }
      } catch (err) {
        undo?.();
        throw err;
      }
    });
  }

  private track(
    nonce: number,
    to: Hex,
    data: Hex,
    gas: bigint,
    fees: Fees,
    raw: Hex,
    hash: Hex,
    slots: string[],
    cost: bigint,
  ): void {
    this.nextNonce = Math.max(this.nextNonce ?? 0, nonce + 1);
    const tracked: TrackedTx = {
      nonce,
      to,
      data,
      gas,
      fees,
      raw,
      hashes: [hash],
      slots,
      firstSentAt: this.now(),
      lastSentAt: this.now(),
      state: 'pending',
      orphanTicks: 0,
      absentTicks: 0,
      checkedAt: 0,
      maxWorstWei: cost,
      charges: [],
    };
    this.pending.set(nonce, tracked);
    this.byHash.set(hash, tracked);
    for (const slot of slots) this.slots.set(slot, nonce);
    this.budget.reserve(nonce, cost);
    this.persist();
  }

  /** A journaled transaction the node verifiably does not have and refused: forget it. */
  private untrack(nonce: number): void {
    const tx = this.pending.get(nonce);
    if (!tx) return;
    this.pending.delete(nonce);
    for (const h of tx.hashes) if (this.byHash.get(h) === tx) this.byHash.delete(h);
    this.releaseSlots(tx);
    this.budget.release(nonce);
    this.persist();
  }

  private sent(hash: Hex, nonce: number, gas: bigint): Hex {
    this.log.info('tx sent', { hash, nonce, gas });
    return hash;
  }

  private releaseSlots(tx: TrackedTx): void {
    for (const slot of tx.slots) if (this.slots.get(slot) === tx.nonce) this.slots.delete(slot);
  }

  /** A final outcome: release what is left of its reservation, keep only what /v1/status reports. */
  private archive(tx: TrackedTx): void {
    this.budget.release(tx.nonce);
    tx.settledAt ??= this.now();
    tx.raw = '0x';
    tx.data = '0x';
    this.settled.push(tx);
    this.pruneHistory();
  }

  private pruneHistory(): void {
    const expired = this.now() - HISTORY_TTL_MS;
    while (this.settled.length > MAX_HISTORY || (this.settled.length > 0 && (this.settled[0]?.settledAt ?? 0) < expired)) {
      const old = this.settled.shift() as TrackedTx;
      for (const h of old.hashes) if (this.byHash.get(h) === old) this.byHash.delete(h);
    }
  }

  /** A receipt, verified absent (undefined), or UNAVAILABLE when the lookup failed. */
  private async receiptOf(hash: Hex): Promise<Lookup<TransactionReceipt>> {
    try {
      return await this.client.getTransactionReceipt({ hash });
    } catch (err) {
      return notFound(err, 'TransactionReceiptNotFoundError') ? undefined : UNAVAILABLE;
    }
  }

  /** The receipt of any of the transaction's hashes; absent only if every lookup said so. */
  private async findReceipt(tx: TrackedTx): Promise<Lookup<TransactionReceipt>> {
    let unavailable = false;
    for (let i = tx.hashes.length - 1; i >= 0; i--) {
      const r = await this.receiptOf(tx.hashes[i] as Hex);
      if (r === UNAVAILABLE) unavailable = true;
      else if (r) return r;
    }
    return unavailable ? UNAVAILABLE : undefined;
  }

  /** Replay one of our reverted transactions at its parent block to recover the error (monitor only). */
  private async replayRevert(to: Hex, data: Hex, blockNumber: bigint): Promise<string> {
    try {
      await this.client.call({ account: this.address, to, data, blockNumber: blockNumber > 0n ? blockNumber - 1n : 0n });
      return 'reverted';
    } catch (err) {
      const revertData = extractRevertData(err);
      return revertData !== undefined ? decodeRevert(revertData) : 'reverted';
    }
  }

  /** What this nonce was charged inside the current budget window (older charges left it). */
  private credit(tx: TrackedTx): bigint {
    const since = this.now() - this.budget.windowMs;
    tx.charges = tx.charges.filter((c) => c.t > since);
    return tx.charges.reduce((sum, c) => sum + c.wei, 0n);
  }

  /** What a replay of any signed version could still cost beyond the credited charge. */
  private residual(tx: TrackedTx, worst: bigint = tx.maxWorstWei): bigint {
    const rest = worst - this.credit(tx);
    return rest > 0n ? rest : 0n;
  }

  /**
   * Record a receipt: charge what it cost beyond what this nonce was already charged in the
   * window (a re-mined transaction pays the difference only), keep the rest of its highest
   * signed worst case reserved until it is final (a reorg may replay it), set the outcome.
   */
  private async record(tx: TrackedTx, receipt: TransactionReceipt): Promise<void> {
    const actual = receipt.gasUsed * receipt.effectiveGasPrice;
    const credit = this.credit(tx);
    if (actual > credit) {
      this.budget.charge(actual - credit);
      tx.charges.push({ t: this.now(), wei: actual - credit });
    }
    this.budget.reserve(tx.nonce, this.residual(tx));
    const moved = tx.blockHash !== receipt.blockHash || tx.minedHash !== receipt.transactionHash;
    tx.blockNumber = receipt.blockNumber;
    tx.blockHash = receipt.blockHash;
    tx.minedHash = receipt.transactionHash;
    tx.absentTicks = 0;
    tx.checkedAt = this.now();
    tx.settledAt ??= this.now();
    if (receipt.status === 'success') {
      tx.state = 'confirmed';
      tx.revertReason = undefined;
    } else {
      tx.state = 'failed';
      if (moved || tx.revertReason === undefined) {
        tx.revertReason = await this.replayRevert(tx.to, tx.data, receipt.blockNumber);
        this.log.warn('tx reverted on chain', { hash: receipt.transactionHash, reason: tx.revertReason });
      }
    }
  }

  /** First receipt: report the outcome and free the slots, but keep it replayable until final. */
  private async settle(tx: TrackedTx, receipt: TransactionReceipt): Promise<void> {
    if (tx.state !== 'pending') return;
    this.pending.delete(tx.nonce);
    this.releaseSlots(tx);
    await this.record(tx, receipt);
    this.mined.set(tx.nonce, tx);
  }

  /**
   * A mined transaction whose receipt is gone (its block was reorged out): pending again at its
   * original nonce, reserved for what a replay may cost beyond its charge, and rebroadcast, so a
   * node that did not keep it cannot leave a hole that later nonces queue behind.
   */
  private async orphan(tx: TrackedTx): Promise<void> {
    this.mined.delete(tx.nonce);
    tx.state = 'pending';
    tx.blockNumber = undefined;
    tx.blockHash = undefined;
    tx.minedHash = undefined;
    tx.revertReason = undefined;
    tx.settledAt = undefined;
    tx.absentTicks = 0;
    tx.orphanTicks = 0;
    this.pending.set(tx.nonce, tx);
    for (const slot of tx.slots) if (!this.slots.has(slot)) this.slots.set(slot, tx.nonce);
    this.budget.reserve(tx.nonce, this.residual(tx));
    this.persist();
    this.log.warn('tx reorged out of the chain: rebroadcasting it at its nonce', {
      nonce: tx.nonce,
      hash: tx.hashes[tx.hashes.length - 1],
    });
    tx.lastSentAt = this.now();
    try {
      await this.broadcast(tx.raw);
    } catch (err) {
      this.log.warn('rebroadcast failed', { nonce: tx.nonce, err: shortMessage(err) });
    }
  }

  private async bump(tx: TrackedTx): Promise<void> {
    const suggested = await this.suggestFees().catch(() => undefined);
    let next: Fees | undefined;
    if (tx.fees.type === 'eip1559') {
      const s = suggested?.type === 'eip1559' ? suggested : undefined;
      let maxFeePerGas = maxOf(bumped(tx.fees.maxFeePerGas), s?.maxFeePerGas ?? 0n);
      let maxPriorityFeePerGas = maxOf(bumped(tx.fees.maxPriorityFeePerGas), s?.maxPriorityFeePerGas ?? 0n);
      if (maxFeePerGas > this.maxFeeWei) maxFeePerGas = this.maxFeeWei;
      if (maxPriorityFeePerGas > maxFeePerGas) maxPriorityFeePerGas = maxFeePerGas;
      // A replacement must raise both fees by >= 10%; at the cap, rebroadcast instead.
      if (
        maxFeePerGas * 10n >= tx.fees.maxFeePerGas * 11n &&
        maxPriorityFeePerGas * 10n >= tx.fees.maxPriorityFeePerGas * 11n
      ) {
        next = { type: 'eip1559', maxFeePerGas, maxPriorityFeePerGas };
      }
    } else {
      const s = suggested?.type === 'legacy' ? suggested.gasPrice : 0n;
      let gasPrice = maxOf(bumped(tx.fees.gasPrice), s);
      if (gasPrice > this.maxFeeWei) gasPrice = this.maxFeeWei;
      if (gasPrice * 10n >= tx.fees.gasPrice * 11n) next = { type: 'legacy', gasPrice };
    }
    // A bump raises the worst case; it must still fit the budget, else rebroadcast as is. A
    // replay of a reorged-out transaction is credited what it was already charged.
    if (next) {
      const extra = this.residual(tx, maxOf(tx.maxWorstWei, worstCase(tx.gas, next))) - this.budget.reservedFor(tx.nonce);
      if (extra > 0n && !this.budget.fits(extra)) next = undefined;
    }
    tx.lastSentAt = this.now();
    if (next) {
      const raw = await this.sign(tx.nonce, tx.to, tx.data, tx.gas, next);
      // Watched, reserved and journaled before broadcasting: a replacement accepted
      // behind a failed response must still be found when it mines, and its higher
      // worst case stays charged to the budget until the nonce settles.
      const hash = keccak256(raw);
      tx.hashes.push(hash);
      this.byHash.set(hash, tx);
      tx.maxWorstWei = maxOf(tx.maxWorstWei, worstCase(tx.gas, next));
      this.budget.reserve(tx.nonce, maxOf(this.budget.reservedFor(tx.nonce), this.residual(tx)));
      this.persist();
      try {
        await this.broadcast(raw);
        tx.fees = next;
        tx.raw = raw;
        this.persist();
        this.log.info('tx fee bumped', { nonce: tx.nonce, hash, fees: next });
        return;
      } catch (err) {
        this.log.warn('fee bump rejected, rebroadcasting', { nonce: tx.nonce, err: shortMessage(err) });
      }
    }
    try {
      await this.broadcast(tx.raw);
      this.log.info('tx rebroadcast', { nonce: tx.nonce, hash: tx.hashes[tx.hashes.length - 1] });
    } catch (err) {
      this.log.warn('rebroadcast failed', { nonce: tx.nonce, err: shortMessage(err) });
    }
  }

  /**
   * One monitor pass: settle mined transactions, follow mined ones to finality (replaying any a
   * reorg removed), drop transactions whose nonce another transaction consumed for good, and
   * bump or rebroadcast stuck ones. A lookup that fails decides nothing.
   */
  tick(): Promise<void> {
    return this.serialize(async () => {
      if (this.pending.size === 0 && this.mined.size === 0) return;
      let changed = false;
      if (this.pending.size > 0) changed = await this.followPending();
      // After the pending pass, so a transaction mined in an already finalized block is archived at once.
      if (this.mined.size > 0) changed = (await this.followMined()) || changed;
      if (changed) this.persist();
    });
  }

  /**
   * Mined, not final: finalize, re-record a re-mined one, replay one a reorg removed. A receipt is
   * re-checked once its block is final, and every MINED_RECHECK_MS before that (public RPCs
   * should not see one receipt read per transaction per pass over a 13-minute finality lag).
   */
  private async followMined(): Promise<boolean> {
    let changed = false;
    const fin = await this.client
      .getBlock({ blockTag: 'finalized' })
      .then((b) => b.number ?? undefined)
      .catch(() => undefined);
    for (const tx of [...this.mined.values()].sort((a, b) => a.nonce - b.nonce)) {
      const final = fin !== undefined && tx.blockNumber !== undefined && fin >= tx.blockNumber;
      if (!final && this.now() - tx.checkedAt < MINED_RECHECK_MS) continue;
      tx.checkedAt = this.now();
      const receipt = await this.findReceipt(tx);
      if (receipt === UNAVAILABLE) continue;
      if (receipt === undefined) {
        if (++tx.absentTicks >= ORPHAN_AFTER) {
          await this.orphan(tx);
          changed = true;
        }
        continue;
      }
      if (receipt.blockHash !== tx.blockHash || receipt.transactionHash !== tx.minedHash || tx.absentTicks > 0) {
        await this.record(tx, receipt);
        changed = true;
      }
      if (fin !== undefined && fin >= receipt.blockNumber) {
        this.mined.delete(tx.nonce);
        this.archive(tx);
        changed = true;
      }
    }
    return changed;
  }

  /** Unmined: settle on a receipt, drop on a nonce consumed for good, else bump when stuck. */
  private async followPending(): Promise<boolean> {
    let changed = false;
    const latest = await this.client
      .getTransactionCount({ address: this.address, blockTag: 'latest' })
      .catch(() => undefined);
    let finalized: number | undefined | null = null; // read once, when needed
    for (const tx of [...this.pending.values()].sort((a, b) => a.nonce - b.nonce)) {
      const receipt = await this.findReceipt(tx);
      if (receipt === UNAVAILABLE) continue; // no answer: nothing is concluded, nothing is sent
      if (receipt) {
        await this.settle(tx, receipt);
        changed = true;
        continue;
      }
      if (latest !== undefined && latest > tx.nonce) {
        // The nonce is used but none of our hashes has a receipt: either a node that has not
        // indexed it yet or another transaction. Only the finalized nonce, seen over a few
        // passes, says it is gone for good; until then the reservation stays.
        if (finalized === null) {
          finalized = await this.client
            .getTransactionCount({ address: this.address, blockTag: 'finalized' })
            .catch(() => undefined);
        }
        if (finalized === undefined || finalized <= tx.nonce) {
          tx.orphanTicks = 0;
          continue;
        }
        if (++tx.orphanTicks < DROP_AFTER) continue;
        this.pending.delete(tx.nonce);
        this.releaseSlots(tx);
        tx.state = 'failed';
        tx.revertReason = 'replaced or dropped';
        this.budget.release(tx.nonce);
        this.archive(tx);
        changed = true;
        this.foreignTransactions++;
        this.log.warn('tx dropped: its nonce was consumed by a transaction this relayer did not send', {
          nonce: tx.nonce,
          hashes: tx.hashes,
          hint: 'give the relayer a key nothing else uses',
        });
        continue;
      }
      tx.orphanTicks = 0;
      if (this.now() - tx.lastSentAt >= this.bumpAfterMs) await this.bump(tx);
    }
    return changed;
  }

  /**
   * Run the monitor every `intervalMs` after the previous pass completed: passes never queue up
   * behind a slow RPC (they would delay every send sharing the queue).
   */
  start(intervalMs: number): void {
    this.stop();
    this.monitoring = true;
    const loop = (): void => {
      this.tick()
        .then(
          () => {
            this.monitor.lastSuccessAt = this.now();
            this.monitor.failures = 0;
          },
          (err: unknown) => {
            this.monitor.lastFailureAt = this.now();
            this.monitor.failures++;
            this.log.warn('tx monitor failed', { err: shortMessage(err), failures: this.monitor.failures });
          },
        )
        .finally(() => {
          if (!this.monitoring) return;
          this.timer = setTimeout(loop, intervalMs);
          this.timer.unref();
        });
    };
    this.timer = setTimeout(loop, intervalMs);
    this.timer.unref();
  }

  stop(): void {
    this.monitoring = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * GET /v1/status: answered from memory for transactions this relayer sent
   * (the monitor settles them from receipts); no RPC, no revert replay here.
   */
  status(hash: Hex): Promise<TxStatus> {
    const key = hash.toLowerCase() as Hex;
    const tx = this.byHash.get(key);
    if (!tx) return Promise.reject(new RelayError('NOT_FOUND', 'not a transaction sent by this relayer'));
    const out: TxStatus = { status: tx.state };
    if (tx.blockNumber !== undefined) out.blockNumber = tx.blockNumber.toString();
    if (tx.revertReason !== undefined) out.revertReason = tx.revertReason;
    if (tx.minedHash !== undefined && tx.minedHash.toLowerCase() !== key) out.minedTxHash = tx.minedHash;
    return Promise.resolve(out);
  }
}
