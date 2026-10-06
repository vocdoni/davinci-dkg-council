/**
 * Combine worker (architecture §5.2, protocol §10.3). Discovers requests from
 * `RequestSubmitted` logs, waits for t accepted partials, picks the t lowest
 * member indexes, computes M_k = C2_k - Σ λ_i·D_{i,k} and solves m_k with the
 * SDK BSGS, then submits `combine` chunks of fieldsPerCombineTx(t) fields.
 *
 * Every chunk goes through the sponsor — the same policy (field slots, the
 * per-request quota, restricted-mode admission) and global budget as a relayed
 * action — so it is simulated first; losing a race to another combiner
 * (FieldCompleted, or a conflicting chunk pending) only triggers a re-read.
 * A request is forgotten only once it is complete at the `finalized` block: a
 * reorg that undoes a combine brings the work back.
 */

import {
  buildCombineArgs,
  COUNCIL_MANAGER_ABI,
  combinedPoint,
  fieldsPerCombineTx,
  isLogRangeError,
  verifyCombine,
  type Hex,
  type Point,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { PublicClient } from 'viem';
import { describeSendError as describeRpcError, isBehindHead, isTransientReadError } from './broadcast.js';
import { DlogNotFoundError, type DlogSolver } from './dlog.js';
import { RelayError, revertName, shortMessage } from './errors.js';
import { silentLogger, type Logger } from './log.js';
import type { Sponsor } from './policy.js';
import type { TxSender } from './sender.js';

export interface CombinerOptions {
  client: PublicClient;
  manager: Hex;
  sponsor: Pick<Sponsor, 'sponsor' | 'admits'>;
  sender: Pick<TxSender, 'status'>;
  solver: DlogSolver;
  /** First block scanned for RequestSubmitted. */
  startBlock: bigint;
  /** Max blocks per eth_getLogs query; halved (down to 1) when a provider refuses a range. */
  logRange: bigint;
  /** Base of the exponential backoff after a failed attempt. */
  backoffMs?: number;
  log?: Logger;
  now?: () => number;
}

interface OpenRequest {
  requestId: Hex;
  failures: number;
  retryAt: number;
  /** Solved plaintexts, keyed by field and ciphertext (a reorg may change the ciphertext). */
  plaintexts: Map<string, bigint>;
  /** Fields with no plaintext below 2^40 (same key): they can never complete (protocol §10.3). */
  unsolvable: Set<string>;
  inflight: { hash: Hex; fields: number[] }[];
}

type RequestTuple = readonly [Hex, number, number, number, readonly (readonly bigint[])[]];

const MAX_BACKOFF_MS = 5 * 60_000;
/** Cap of the pause between passes after consecutive failed passes. */
const MAX_TICK_BACKOFF_MS = 60_000;
/** Consecutive transient failures logged at info before they become a warning. */
const TRANSIENT_WARN_AFTER = 5;
/** Blocks rescanned on every pass (reorg tolerance of request discovery). */
const REORG_WINDOW = 64n;
const MAX_DONE = 100_000;

const fieldKey = (k: number, row: readonly bigint[]): string => `${k}:${row.join(':')}`;

export class Combiner {
  private readonly client: PublicClient;
  private readonly manager: Hex;
  private readonly sponsor: Pick<Sponsor, 'sponsor' | 'admits'>;
  private readonly sender: Pick<TxSender, 'status'>;
  private readonly solver: DlogSolver;
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
  private readonly partialCache = new Map<string, Point[]>();
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  /** Consecutive failed passes (discovery), for the loop's backoff. */
  private tickFailures = 0;

  constructor(opts: CombinerOptions) {
    this.client = opts.client;
    this.manager = opts.manager;
    this.sponsor = opts.sponsor;
    this.sender = opts.sender;
    this.solver = opts.solver;
    this.startBlock = opts.startBlock;
    this.nextBlock = opts.startBlock;
    this.logRange = opts.logRange > 0n ? opts.logRange : 1n;
    this.backoffMs = opts.backoffMs ?? 5000;
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  /** Request ids still being watched. */
  get watching(): Hex[] {
    return [...this.open.keys()];
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

  /** One pass: discover new requests, then try to complete every open one. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.discover();
      for (const req of [...this.open.values()]) {
        if (this.now() < req.retryAt) continue;
        try {
          await this.process(req);
        } catch (err) {
          this.backoff(
            req,
            err instanceof RelayError ? `${err.code}: ${err.detail}` : describeRpcError(err),
            isTransientReadError(err),
          );
        }
      }
    } finally {
      this.running = false;
    }
  }

  private backoff(req: OpenRequest, reason: string, transient = false): void {
    req.failures++;
    req.retryAt = this.now() + Math.min(MAX_BACKOFF_MS, this.backoffMs * 2 ** (req.failures - 1));
    const fields = { requestId: req.requestId, failures: req.failures, err: reason };
    if (transient && req.failures < TRANSIENT_WARN_AFTER) this.log.info('combine attempt deferred: transient rpc error', fields);
    else this.log.warn('combine attempt failed', fields);
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
    while (from <= latest) {
      const to = from + this.logRange - 1n < latest ? from + this.logRange - 1n : latest;
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
        throw err;
      }
      for (const l of logs) {
        const requestId = (l.args as { requestId: Hex }).requestId.toLowerCase() as Hex;
        if (this.open.has(requestId) || this.done.has(requestId)) continue;
        this.open.set(requestId, {
          requestId,
          failures: 0,
          retryAt: 0,
          plaintexts: new Map(),
          unsolvable: new Set(),
          inflight: [],
        });
        this.log.info('request discovered', { requestId, block: l.blockNumber });
      }
      from = to + 1n;
      if (from > this.nextBlock) this.nextBlock = from;
    }
    this.nextBlock = latest + 1n;
  }

  private async threshold(cid: Hex): Promise<number> {
    const cached = this.thresholds.get(cid);
    if (cached !== undefined) return cached;
    const view = (await this.client.readContract({
      address: this.manager,
      abi: COUNCIL_MANAGER_ABI,
      functionName: 'getCeremony',
      args: [cid],
    })) as { threshold: number };
    this.thresholds.set(cid, view.threshold);
    return view.threshold;
  }

  /** An accepted partial is D = s_i·C1 (unique for a valid proof), so it is read once. */
  private async partial(requestId: Hex, index: number): Promise<Point[]> {
    const key = `${requestId}:${index}`;
    const cached = this.partialCache.get(key);
    if (cached) return cached;
    const D = (await this.client.readContract({
      address: this.manager,
      abi: COUNCIL_MANAGER_ABI,
      functionName: 'getPartial',
      args: [requestId, index],
    })) as readonly (readonly [bigint, bigint])[];
    const points = D.map(([x, y]) => ({ x, y }));
    this.partialCache.set(key, points);
    return points;
  }

  private getRequest(requestId: Hex, blockTag?: 'finalized'): Promise<RequestTuple> {
    return this.client.readContract({
      address: this.manager,
      abi: COUNCIL_MANAGER_ABI,
      functionName: 'getRequest',
      args: [requestId],
      ...(blockTag ? { blockTag } : {}),
    }) as Promise<RequestTuple>;
  }

  private forget(requestId: Hex): void {
    this.open.delete(requestId);
    this.done.add(requestId);
    while (this.done.size > MAX_DONE) this.done.delete(this.done.values().next().value as Hex);
    for (const key of [...this.partialCache.keys()]) {
      if (key.startsWith(`${requestId}:`)) this.partialCache.delete(key);
    }
  }

  /** Complete with at least one field, at the finalized block: only then is it safe to forget. */
  private async completeAtFinalized(requestId: Hex): Promise<boolean> {
    try {
      const [, fieldCount, completed] = await this.getRequest(requestId, 'finalized');
      const full = (1 << fieldCount) - 1;
      return fieldCount > 0 && (completed & full) === full;
    } catch {
      return false; // not finalized yet (or the node has no finalized tag): keep watching
    }
  }

  private async process(req: OpenRequest): Promise<void> {
    // Settle chunks sent earlier; their fields are retried only once they failed.
    for (const chunk of [...req.inflight]) {
      const st = await this.sender.status(chunk.hash).catch(() => ({ status: 'pending' as const }));
      if (st.status === 'pending') continue;
      req.inflight = req.inflight.filter((c) => c !== chunk);
      if (st.status === 'failed') this.log.warn('combine tx failed', { requestId: req.requestId, hash: chunk.hash });
    }

    const [cid, fieldCount, completed, partialBitmap, cts] = await this.getRequest(req.requestId);
    if (fieldCount === 0) {
      // Bound but not (or no longer, after a reorg) requested: nothing to do, never "complete".
      this.backoff(req, 'request has no fields at the head');
      return;
    }
    const full = (1 << fieldCount) - 1;
    if ((completed & full) === full) {
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
      return;
    }
    const t = await this.threshold(cid.toLowerCase() as Hex);
    const members: number[] = [];
    for (let i = 1; i <= 16; i++) if (partialBitmap & (1 << (i - 1))) members.push(i);
    if (members.length < t) return;
    const memberSet = members.slice(0, t);
    const partials = new Map<number, Point[]>();
    for (const i of memberSet) partials.set(i, await this.partial(req.requestId, i));

    const busy = new Set(req.inflight.flatMap((c) => c.fields));
    const ready: { fieldIndex: number; plaintext: bigint }[] = [];
    for (let k = 0; k < fieldCount; k++) {
      if (completed & (1 << k) || busy.has(k)) continue;
      const row = cts[k] as readonly bigint[];
      const key = fieldKey(k, row);
      if (req.unsolvable.has(key)) continue;
      const c2: Point = { x: row[2] as bigint, y: row[3] as bigint };
      const perField = new Map<number, Point>(memberSet.map((i) => [i, (partials.get(i) as Point[])[k] as Point]));
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
      ready.push({ fieldIndex: k, plaintext: m });
    }

    const per = fieldsPerCombineTx(t);
    for (let off = 0; off < ready.length; off += per) {
      const args = buildCombineArgs(req.requestId, memberSet, ready.slice(off, off + per));
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
