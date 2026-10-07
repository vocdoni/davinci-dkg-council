/**
 * Combine worker (architecture §5.2, protocol §10.3–§10.4). Finds requests from contract state
 * and, as a convenience, from `RequestSubmitted` logs; waits for t accepted partials and an open
 * decryption gate, sources
 * the members' padded D vectors (SDK `sourcePartialVectors`: the relayer's cache, else one
 * `eth_getLogs` at each stored publication block, else a member's re-publication), picks the
 * t lowest members whose vectors it holds, computes M_k = C2_k - Σ λ_i·D_{i,k} and solves m_k
 * with the SDK BSGS, then submits `combine` chunks of fieldsPerCombineTx(t) fields with the
 * vectors and C2 re-supplied (C2 decompressed from the stored words).
 *
 * Every chunk goes through the sponsor — the same policy (field slots, the per-request quota,
 * restricted-mode admission) and global budget as a relayed action — so it is simulated first;
 * losing a race to another combiner (FieldCompleted, or a conflicting chunk pending) only
 * triggers a re-read. A request whose gate is closed is parked: one view read per pass, no
 * BSGS, no transaction (the contract would refuse DecryptionNotOpen anyway). A request is
 * forgotten only once it is complete at the `finalized` block: a reorg that undoes a combine
 * brings the work back.
 *
 * Request sources (no critical path reads logs, architecture §6.6):
 * - State: for every tracked ceremony (state file `tracked`: ceremonies this relayer sponsored a
 *   decryption action for, whose gate the scheduler saw open, registered through `/v1/track`, or
 *   met in a log) it reads `getRequestCount` and the `getRequestIdsPage` pages past the ids
 *   already final (count and pages at one head block; the not-yet-final suffix is read again on
 *   every check, so a reorg that replaces a binding is seen), a bounded number of ceremonies per
 *   pass, each re-checked every minute. This works from any archive-free RPC however old the
 *   ceremony.
 * - Logs: `RequestSubmitted` scanning from COUNCIL_START_BLOCK, with its own backoff. A failed
 *   scan never holds back known requests; a range the provider keeps refusing (pruned history)
 *   is skipped after a few attempts, its requests left to the state source.
 */

import {
  buildCombineArgs,
  COUNCIL_MANAGER_ABI,
  combinedPoint,
  fieldPartials,
  fieldsPerCombineTx,
  isLogRangeError,
  sourcePartialVectors,
  verifyCombine,
  type Hex,
  type PartialVectorSource,
  type Point,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { PublicClient } from 'viem';
import { describeSendError as describeRpcError, isBehindHead, isTransientReadError } from './broadcast.js';
import { ChainState, MalformedPointError } from './chainstate.js';
import { DlogNotFoundError, type DlogSolver } from './dlog.js';
import { extractRevertData, RelayError, revertName, shortMessage } from './errors.js';
import { silentLogger, type Logger } from './log.js';
import { ChainPartialSource, PartialVectorStore } from './partials.js';
import type { Sponsor } from './policy.js';
import type { LoopStatus, TxSender } from './sender.js';
import { StateStore, trackCeremony } from './state.js';

export interface CombinerOptions {
  client: PublicClient;
  chainId: bigint;
  manager: Hex;
  sponsor: Pick<Sponsor, 'sponsor' | 'admits'>;
  sender: Pick<TxSender, 'status'>;
  solver: DlogSolver;
  /** First block scanned for RequestSubmitted. */
  startBlock: bigint;
  /** Max blocks per eth_getLogs query; halved (down to 1) when a provider refuses a range. */
  logRange: bigint;
  /** State reads (shared with the sponsor when given). */
  chain?: ChainState;
  /** The D-vector cache (shared with the sponsor, which fills it with what it relays). */
  partials?: PartialVectorStore;
  /** Where uncached vectors come from (default: the single-block log read). */
  source?: PartialVectorSource;
  /** Base of the exponential backoff after a failed attempt. */
  backoffMs?: number;
  /** Holds the tracked ceremonies (`state.tracked`); in memory when omitted. */
  store?: StateStore;
  /** Tracked ceremonies whose request count is read per pass (default 16). */
  enumeratePerPass?: number;
  /** A tracked ceremony's request count is re-read this often (default 60 s). */
  enumerateIntervalMs?: number;
  log?: Logger;
  now?: () => number;
}

/** Request discovery from logs: its own backoff, never the worker's. */
interface DiscoveryState extends LoopStatus {
  retryAt: number;
  /** The chunk start a non-transient refusal keeps hitting, and how often in a row. */
  stuckFrom?: bigint;
  stuck: number;
  /** The last range skipped as refused for good: later scans step over it without asking. */
  skipped?: { from: bigint; to: bigint };
}

interface TrackedCeremony {
  /** Request ids final and enumerated (offsets below it are never read again). */
  count: number;
  nextAt: number;
  failures: number;
}

interface OpenRequest {
  requestId: Hex;
  /** Known after the first read. */
  cid?: Hex;
  failures: number;
  retryAt: number;
  /** Waiting for the decryption gate (logged once). */
  parked: boolean;
  /** Solved plaintexts, keyed by field and C2 (a reorg may change the ciphertext). */
  plaintexts: Map<string, bigint>;
  /** Fields with no plaintext below 2^40 (same key): they can never complete (protocol §10.3). */
  unsolvable: Set<string>;
  inflight: { hash: Hex; fields: number[] }[];
}

const MAX_BACKOFF_MS = 5 * 60_000;
/** Cap of the pause between passes after consecutive failed passes. */
const MAX_TICK_BACKOFF_MS = 60_000;
/** Consecutive transient failures logged at info before they become a warning. */
const TRANSIENT_WARN_AFTER = 5;
/** Blocks rescanned on every pass (reorg tolerance of request discovery). */
const REORG_WINDOW = 64n;
const MAX_DONE = 100_000;
/** Request ids per getRequestIdsPage call. */
const PAGE_SIZE = 64n;
/** A chunk start refused this many times in a row (not a rate limit, not a range cap) is skipped. */
const SKIP_AFTER = 3;

const fieldKey = (k: number, c2: Point): string => `${k}:${c2.x}:${c2.y}`;

export class Combiner {
  private readonly client: PublicClient;
  private readonly chainId: bigint;
  private readonly manager: Hex;
  private readonly sponsor: Pick<Sponsor, 'sponsor' | 'admits'>;
  private readonly sender: Pick<TxSender, 'status'>;
  private readonly solver: DlogSolver;
  private readonly chain: ChainState;
  private readonly partials: PartialVectorStore;
  private readonly source: PartialVectorSource;
  private logRange: bigint;
  private readonly backoffMs: number;
  private readonly log: Logger;
  private readonly now: () => number;

  private readonly startBlock: bigint;
  private nextBlock: bigint;
  private readonly open = new Map<Hex, OpenRequest>();
  /** Requests complete at a finalized block (or not ours to combine): never re-added. */
  private readonly done = new Set<Hex>();
  private readonly thresholds = new Map<Hex, number>();
  private readonly store: StateStore;
  private readonly ceremonies = new Map<Hex, TrackedCeremony>();
  private readonly enumeratePerPass: number;
  private readonly enumerateIntervalMs: number;
  private cursor = 0;
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  /** Consecutive failed passes, for the loop's backoff. */
  private tickFailures = 0;
  private readonly loop: LoopStatus = { failures: 0 };
  private readonly discovery: DiscoveryState = { failures: 0, retryAt: 0, stuck: 0 };

  constructor(opts: CombinerOptions) {
    this.client = opts.client;
    this.chainId = opts.chainId;
    this.manager = opts.manager;
    this.sponsor = opts.sponsor;
    this.sender = opts.sender;
    this.solver = opts.solver;
    this.chain = opts.chain ?? new ChainState(opts.client, opts.manager);
    this.partials = opts.partials ?? new PartialVectorStore(opts.chainId, opts.manager);
    this.source = opts.source ?? new ChainPartialSource(opts.client, this.chain);
    this.startBlock = opts.startBlock;
    this.nextBlock = opts.startBlock;
    this.logRange = opts.logRange > 0n ? opts.logRange : 1n;
    this.backoffMs = opts.backoffMs ?? 5000;
    this.store = opts.store ?? new StateStore();
    this.enumeratePerPass = opts.enumeratePerPass ?? 16;
    this.enumerateIntervalMs = opts.enumerateIntervalMs ?? 60_000;
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  /** Request ids still being watched. */
  get watching(): Hex[] {
    return [...this.open.keys()];
  }

  /** Ceremonies whose requests are enumerated from state. */
  get tracking(): Hex[] {
    return [...this.store.state.tracked];
  }

  /** The pass loop's and the log discovery's health, for /v1/metrics. */
  status(): LoopStatus & { open: number; tracked: number; discovery: LoopStatus & { nextBlock: string } } {
    const d = this.discovery;
    return {
      ...this.loop,
      open: this.open.size,
      tracked: this.store.state.tracked.length,
      discovery: {
        lastSuccessAt: d.lastSuccessAt,
        lastFailureAt: d.lastFailureAt,
        failures: d.failures,
        nextBlock: this.nextBlock.toString(),
      },
    };
  }

  /**
   * Enumerate a ceremony's requests from contract state (`getRequestCount`, `getRequestIdsPage`)
   * on the next pass, and every minute from then on. Persisted in the state file.
   */
  track(cid: Hex): void {
    const id = cid.toLowerCase() as Hex;
    if (trackCeremony(this.store.state, id)) this.store.flushSoon();
    const known = this.ceremonies.get(id);
    if (known) known.nextAt = 0;
  }

  private untrack(cid: Hex, reason: string): void {
    const id = cid.toLowerCase() as Hex;
    if (!this.store.state.tracked.includes(id)) return;
    this.store.state.tracked = this.store.state.tracked.filter((c) => c !== id);
    this.ceremonies.delete(id);
    this.store.flushSoon();
    this.log.info('combiner stops tracking ceremony', { cid: id, reason });
  }

  /** Its decryption gate just opened: enumerate its requests now and retry the known ones. */
  wake(cid: Hex): void {
    const id = cid.toLowerCase();
    this.track(id as Hex);
    for (const req of this.open.values()) {
      if (req.cid !== id) continue;
      req.retryAt = 0;
      req.failures = 0;
    }
  }

  start(pollMs: number): void {
    this.stop();
    const loop = (): void => {
      this.tick()
        .then(
          () => this.passSucceeded(pollMs),
          (err: unknown) => this.passFailed(err, pollMs),
        )
        .then((delay) => {
          if (this.timer !== undefined) this.timer = setTimeout(loop, delay);
        });
    };
    this.timer = setTimeout(loop, 0);
  }

  private passSucceeded(pollMs: number): number {
    if (this.tickFailures >= TRANSIENT_WARN_AFTER) this.log.info('combiner recovered', { failures: this.tickFailures });
    this.tickFailures = 0;
    return pollMs;
  }

  /**
   * A failed pass backs off exponentially. Public RPCs fail now and then (rate limits, a lagging
   * backend, timeouts): those are logged at info until they persist; anything else warns.
   */
  private passFailed(err: unknown, pollMs: number): number {
    this.tickFailures++;
    const delay = Math.min(MAX_TICK_BACKOFF_MS, pollMs * 2 ** (this.tickFailures - 1));
    const fields = { err: describeRpcError(err), failures: this.tickFailures, retryInMs: delay };
    if (isTransientReadError(err) && this.tickFailures < TRANSIENT_WARN_AFTER) {
      this.log.info('combiner pass deferred: transient rpc error', fields);
    } else {
      this.log.warn('combiner tick failed', fields);
    }
    return delay;
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /**
   * One pass: find new requests (logs, then state), then try to complete every open one. Neither
   * source failing holds back the requests already known.
   */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.discoverQuietly();
      await this.enumerate();
      for (const req of [...this.open.values()]) {
        if (this.now() < req.retryAt) continue;
        try {
          await this.process(req);
        } catch (err) {
          if (err instanceof MalformedPointError) {
            // A corrupted answer (the contract only stores valid points): no search, no
            // transaction, nothing remembered; read again after the backoff.
            this.backoff(req, err.detail, { msg: 'combine refused a malformed stored point' });
            continue;
          }
          this.backoff(
            req,
            err instanceof RelayError ? `${err.code}: ${err.detail}` : describeRpcError(err),
            { transient: isTransientReadError(err) },
          );
        }
      }
      this.loop.lastSuccessAt = this.now();
      this.loop.failures = 0;
    } catch (err) {
      this.loop.lastFailureAt = this.now();
      this.loop.failures++;
      throw err;
    } finally {
      this.running = false;
    }
  }

  /**
   * Back off a request. `transient` failures (an RPC hiccup, partial data not available yet) log
   * at info until they persist; `quiet` ones (a request bound but not submitted yet) always log at
   * info; anything else warns at once.
   */
  private backoff(req: OpenRequest, reason: string, opts: { transient?: boolean; quiet?: boolean; msg?: string } = {}): void {
    req.failures++;
    req.retryAt = this.now() + Math.min(MAX_BACKOFF_MS, this.backoffMs * 2 ** (req.failures - 1));
    const fields = { requestId: req.requestId, failures: req.failures, err: reason };
    if (opts.quiet || (opts.transient && req.failures < TRANSIENT_WARN_AFTER)) {
      this.log.info(opts.msg ?? 'combine attempt deferred: transient rpc error', fields);
    } else {
      this.log.warn(opts.msg ?? 'combine attempt failed', fields);
    }
  }

  private add(requestId: Hex, source: 'log' | 'state', block?: bigint): void {
    const id = requestId.toLowerCase() as Hex;
    if (this.open.has(id) || this.done.has(id)) return;
    this.open.set(id, {
      requestId: id,
      failures: 0,
      retryAt: 0,
      parked: false,
      plaintexts: new Map(),
      unsolvable: new Set(),
      inflight: [],
    });
    this.log.info('request discovered', { requestId: id, source, ...(block !== undefined ? { block } : {}) });
  }

  /**
   * Log discovery with its own exponential backoff: a failure is logged (transient ones at info
   * until they persist) and never fails the pass.
   */
  private async discoverQuietly(): Promise<void> {
    const d = this.discovery;
    if (this.now() < d.retryAt) return;
    try {
      await this.discover();
      if (d.failures >= TRANSIENT_WARN_AFTER) this.log.info('request discovery recovered', { failures: d.failures });
      d.failures = 0;
      d.retryAt = 0;
      d.lastSuccessAt = this.now();
    } catch (err) {
      d.failures++;
      d.lastFailureAt = this.now();
      const delay = Math.min(MAX_BACKOFF_MS, this.backoffMs * 2 ** (d.failures - 1));
      d.retryAt = this.now() + delay;
      const fields = { err: describeRpcError(err), failures: d.failures, retryInMs: delay };
      if (isTransientReadError(err) && d.failures < TRANSIENT_WARN_AFTER) {
        this.log.info('request discovery deferred: transient rpc error', fields);
      } else {
        this.log.warn('request discovery failed', fields);
      }
    }
  }

  /**
   * Request ids from contract state for the tracked ceremonies: `getRequestCount`, then only the
   * pages past what was already enumerated. At most `enumeratePerPass` ceremonies per pass, in
   * rotation; each is re-read every `enumerateIntervalMs`, at once when tracked or woken.
   */
  private async enumerate(): Promise<void> {
    const list = [...this.store.state.tracked];
    if (list.length === 0) return;
    let reads = this.enumeratePerPass;
    let k = 0;
    for (; k < list.length && reads > 0; k++) {
      const cid = list[(this.cursor + k) % list.length] as Hex;
      let e = this.ceremonies.get(cid);
      if (!e) {
        e = { count: 0, nextAt: 0, failures: 0 };
        this.ceremonies.set(cid, e);
      }
      if (this.now() < e.nextAt) continue;
      reads--;
      try {
        await this.enumerateCeremony(cid, e);
        e.failures = 0;
        e.nextAt = this.now() + this.enumerateIntervalMs;
      } catch (err) {
        if (revertName(err) === 'UnknownCeremony') {
          this.untrack(cid, 'unknown ceremony');
          continue;
        }
        e.failures++;
        e.nextAt = this.now() + Math.min(MAX_BACKOFF_MS, this.backoffMs * 2 ** (e.failures - 1));
        const fields = { cid, failures: e.failures, err: describeRpcError(err) };
        if (isTransientReadError(err) && e.failures < TRANSIENT_WARN_AFTER) this.log.info('request enumeration deferred', fields);
        else this.log.warn('request enumeration failed', fields);
      }
    }
    this.cursor = (this.cursor + k) % Math.max(1, this.store.state.tracked.length);
  }

  /**
   * The count and every page are read at one head block (one consistent list), from the
   * finalized boundary on: ids past the finalized count are read again on every check, so a
   * reorg that replaces a binding at an offset already read is still found.
   */
  private async enumerateCeremony(cid: Hex, e: TrackedCeremony): Promise<void> {
    const at = { blockNumber: await this.client.getBlockNumber({ cacheTime: 0 }) };
    const count = Number(await this.chain.read<bigint>('getRequestCount', [cid], at));
    let final = 0;
    try {
      final = Number(await this.chain.read<bigint>('getRequestCount', [cid], { blockTag: 'finalized' }));
    } catch (err) {
      if (extractRevertData(err) === undefined) throw err; // unknown at the finalized block: nothing final yet
    }
    let offset = Math.min(e.count, count);
    while (offset < count) {
      const page = await this.chain.read<readonly Hex[]>('getRequestIdsPage', [cid, BigInt(offset), PAGE_SIZE], at);
      if (page.length === 0) break;
      for (const id of page) this.add(id, 'state');
      offset += page.length;
    }
    e.count = Math.min(final, offset);
  }

  /**
   * Scan RequestSubmitted logs up to the head. The last REORG_WINDOW blocks are scanned
   * again on every pass, so a request a short reorg moved into an already-scanned height
   * is still found. The cursor advances chunk by chunk, so a failed chunk only repeats itself.
   *
   * Public endpoints are load-balanced: the backend answering eth_getLogs may be a block or two
   * behind the one that answered eth_blockNumber, and refuses a range past its own head
   * (-32602). That ends the pass where it is; the next pass picks the rest up. A range the
   * provider refuses as too large is halved for this and every later pass, so a relayer
   * restarted months after its start block catches up through any public provider's cap.
   */
  private async discover(): Promise<void> {
    const latest = await this.client.getBlockNumber({ cacheTime: 0 });
    let from = this.nextBlock > this.startBlock + REORG_WINDOW ? this.nextBlock - REORG_WINDOW : this.startBlock;
    const d = this.discovery;
    while (from <= latest) {
      if (d.skipped && from >= d.skipped.from && from <= d.skipped.to) {
        from = d.skipped.to + 1n;
        continue;
      }
      let to = from + this.logRange - 1n < latest ? from + this.logRange - 1n : latest;
      if (d.skipped && from < d.skipped.from && to >= d.skipped.from) to = d.skipped.from - 1n; // stop short of it
      let logs;
      try {
        logs = await this.client.getContractEvents({
          address: this.manager,
          abi: COUNCIL_MANAGER_ABI,
          eventName: 'RequestSubmitted',
          fromBlock: from,
          toBlock: to,
          strict: true,
        });
      } catch (err) {
        if (isBehindHead(err)) return;
        // A provider that caps eth_getLogs below the configured range (or the size of its
        // answer): retry the same blocks in half the range, and keep the smaller range.
        if (isLogRangeError(err) && this.logRange > 1n) {
          this.logRange /= 2n;
          this.log.info('log range refused by the rpc, halving it', { logRange: this.logRange.toString(), err: shortMessage(err) });
          continue;
        }
        // The same blocks refused again and again for another reason than load (history the
        // provider pruned, a block it cannot serve): logs are a convenience, so move past them
        // (to 64 blocks below the head when the refused range is older). Requests there are
        // still found from state for every tracked ceremony.
        if (!isTransientReadError(err)) {
          d.stuck = d.stuckFrom === from ? d.stuck + 1 : 1;
          d.stuckFrom = from;
          if (d.stuck >= SKIP_AFTER) {
            const recent = latest + 1n > REORG_WINDOW ? latest + 1n - REORG_WINDOW : 0n;
            const resume = recent > to + 1n ? recent : to + 1n;
            this.log.warn('request discovery skips blocks the rpc keeps refusing; their requests are found from state for tracked ceremonies', {
              fromBlock: from.toString(),
              toBlock: (resume - 1n).toString(),
              err: shortMessage(err),
            });
            d.skipped = { from, to: resume - 1n };
            d.stuck = 0;
            d.stuckFrom = undefined;
            if (resume > this.nextBlock) this.nextBlock = resume;
            from = resume;
            continue;
          }
        }
        throw err;
      }
      // Only the refused range itself (or a scan past it) clears its failures, not an earlier
      // chunk of the rewind window.
      if (d.stuckFrom !== undefined && d.stuckFrom <= to) {
        d.stuck = 0;
        d.stuckFrom = undefined;
      }
      for (const l of logs) {
        const a = l.args as { requestId: Hex; cid: Hex };
        this.add(a.requestId, 'log', l.blockNumber);
        // Its ceremony's later requests are then found from state too, whatever the logs do.
        if (!this.store.state.tracked.includes(a.cid.toLowerCase() as Hex)) this.track(a.cid);
      }
      from = to + 1n;
      if (from > this.nextBlock) this.nextBlock = from;
    }
    this.nextBlock = latest + 1n;
  }

  private async threshold(cid: Hex): Promise<number> {
    const cached = this.thresholds.get(cid);
    if (cached !== undefined) return cached;
    const view = await this.chain.ceremony(cid);
    this.thresholds.set(cid, view.threshold);
    return view.threshold;
  }

  private forget(requestId: Hex): void {
    this.open.delete(requestId);
    this.done.add(requestId);
    while (this.done.size > MAX_DONE) this.done.delete(this.done.values().next().value as Hex);
    this.partials.drop(requestId);
  }

  /** Complete with at least one field, at the finalized block: only then is it safe to forget. */
  private async completeAtFinalized(requestId: Hex): Promise<boolean> {
    try {
      const { fieldCount, completedBitmap } = await this.chain.requestMeta(requestId, { blockTag: 'finalized' });
      const full = (1 << fieldCount) - 1;
      return fieldCount > 0 && (completedBitmap & full) === full;
    } catch {
      return false; // not finalized yet (or the node has no finalized tag): keep watching
    }
  }

  /**
   * The padded D vectors of t members, lowest indexes first among those whose vector can be
   * authenticated against its stored hash (protocol §10.4 order, via the SDK). Undefined while
   * fewer than t are available: their members must re-publish (publishPartialData).
   */
  private async vectors(
    req: OpenRequest,
    cid: Hex,
    fieldCount: number,
    members: number[],
    t: number,
  ): Promise<Map<number, Point[]> | undefined> {
    const chosen = new Map<number, Point[]>();
    const missing: number[] = [];
    let next = 0;
    while (chosen.size < t && next < members.length) {
      const batch = members.slice(next, next + (t - chosen.size));
      next += batch.length;
      const sourced = await sourcePartialVectors({
        chainId: this.chainId,
        manager: this.manager,
        ceremonyId: cid,
        requestId: req.requestId,
        fieldCount,
        memberSet: batch,
        source: this.source,
        cache: this.partials.cache,
      });
      for (const [i, v] of sourced.vectors) chosen.set(i, v);
      missing.push(...sourced.missing);
    }
    if (chosen.size >= t) return chosen;
    this.backoff(
      req,
      `partial data of members ${missing.join(', ')} is neither cached nor at its publication block; ` +
        `${chosen.size} of ${t} vectors available until they re-publish`,
      { transient: true, msg: 'combine waiting for partial data re-publication' },
    );
    return undefined;
  }

  private async process(req: OpenRequest): Promise<void> {
    // Settle chunks sent earlier; their fields are retried only once they failed.
    for (const chunk of [...req.inflight]) {
      const st = await this.sender.status(chunk.hash).catch(() => ({ status: 'pending' as const }));
      if (st.status === 'pending') continue;
      req.inflight = req.inflight.filter((c) => c !== chunk);
      if (st.status === 'failed') this.log.warn('combine tx failed', { requestId: req.requestId, hash: chunk.hash });
    }

    const meta = await this.chain.requestMeta(req.requestId);
    const cid = meta.ceremonyId;
    req.cid = cid;
    if (meta.fieldCount === 0) {
      // Bound but not (or no longer, after a reorg) requested: nothing to do, never "complete".
      this.backoff(req, 'request has no fields at the head', { quiet: true, msg: 'request bound but not submitted yet' });
      return;
    }
    const full = (1 << meta.fieldCount) - 1;
    if ((meta.completedBitmap & full) === full) {
      if (await this.completeAtFinalized(req.requestId)) {
        this.log.info('request complete', { requestId: req.requestId });
        this.forget(req.requestId);
      }
      return;
    }
    // Admission before any work: a request this relayer will not sponsor costs no BSGS search.
    if (!(await this.sponsor.admits(cid))) {
      this.log.info('request not sponsored by this relayer; leaving it to others', { requestId: req.requestId });
      this.forget(req.requestId);
      this.untrack(cid, 'not sponsored');
      return;
    }
    const t = await this.threshold(cid);
    const members: number[] = [];
    for (let i = 1; i <= 16; i++) if (meta.partialBitmap & (1 << (i - 1))) members.push(i);
    if (members.length < t) return;
    // The decryption gate (protocol §8.7): never combine before it opens. Partials cannot exist
    // before it, so this only parks work a reorg brought back; it costs one view read.
    if (!(await this.chain.isDecryptionOpen(cid))) {
      if (!req.parked) this.log.info('combine parked until the decryption gate opens', { requestId: req.requestId, cid });
      req.parked = true;
      return;
    }
    req.parked = false;

    const vectors = await this.vectors(req, cid, meta.fieldCount, members, t);
    if (!vectors) return;
    const memberSet = [...vectors.keys()].sort((a, b) => a - b);
    const { c2: c2s } = await this.chain.requestPoints(req.requestId);

    const busy = new Set(req.inflight.flatMap((c) => c.fields));
    const ready: { fieldIndex: number; plaintext: bigint; c2: Point }[] = [];
    for (let k = 0; k < meta.fieldCount; k++) {
      if (meta.completedBitmap & (1 << k) || busy.has(k)) continue;
      const c2 = c2s[k] as Point;
      const key = fieldKey(k, c2);
      if (req.unsolvable.has(key)) continue;
      const perField = fieldPartials(vectors, k);
      let m = req.plaintexts.get(key);
      if (m === undefined) {
        try {
          m = await this.solver.solve(combinedPoint(c2, memberSet, perField));
        } catch (err) {
          if (!(err instanceof DlogNotFoundError)) throw err; // operational: retried after backoff
          req.unsolvable.add(key);
          this.log.error('field has no plaintext below 2^40; it can never complete', {
            requestId: req.requestId,
            field: k,
            err: shortMessage(err),
          });
          continue;
        }
        if (!verifyCombine(m, c2, memberSet, perField)) {
          req.unsolvable.add(key);
          this.log.error('solved plaintext fails the combine equation', { requestId: req.requestId, field: k });
          continue;
        }
        req.plaintexts.set(key, m);
      }
      ready.push({ fieldIndex: k, plaintext: m, c2 });
    }

    const per = fieldsPerCombineTx(t);
    for (let off = 0; off < ready.length; off += per) {
      const args = buildCombineArgs(req.requestId, memberSet, ready.slice(off, off + per), vectors);
      try {
        const hash = await this.sponsor.sponsor({ kind: 'combine', ...args }, { source: 'combiner' });
        req.inflight.push({ hash, fields: args.fieldIndexes });
        req.failures = 0;
        this.log.info('combine sent', { requestId: req.requestId, fields: args.fieldIndexes, memberSet, hash });
      } catch (err) {
        const code = err instanceof RelayError ? err.code : undefined;
        if (revertName(err) === 'FieldCompleted' || code === 'CONFLICT') {
          // Another combiner won (or holds) this chunk: re-read the request on the next pass.
          this.log.info('combine race lost', { requestId: req.requestId, fields: args.fieldIndexes });
          return;
        }
        if (code === 'NOT_SPONSORED') {
          this.log.info('request not sponsored by this relayer; leaving it to others', { requestId: req.requestId });
          this.forget(req.requestId);
          return;
        }
        throw err;
      }
    }
  }
}
