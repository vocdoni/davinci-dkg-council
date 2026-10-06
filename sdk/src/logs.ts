/**
 * Paged event-log scans (architecture §4 `logs`). Cosmetic discovery only.
 *
 * Public RPC providers cap `eth_getLogs`: block ranges (often 1,000 to 50,000 blocks), result
 * counts (often 10,000 logs) and response sizes, and some refuse the method outright. One unpaged
 * scan from a deployment block to `latest` works for a few weeks and then fails for good, so no
 * critical path may read logs: the app and the SDK derive every binding, roster and request from
 * authenticated contract state. What is left for logs (labels, invite linkage) goes through this
 * scanner: bounded ranges, the range halved when a provider refuses it as too large, a cursor to
 * resume from, the next provider tried when one fails, and an incomplete result rather than an
 * exception, so a caller can show what it has and pick up later.
 */

import type { AbiEvent, Log, PublicClient } from 'viem';
import type { Hex } from './types.js';

/** Default blocks per `eth_getLogs` request: within the most common public-provider cap. */
export const DEFAULT_LOG_CHUNK = 10_000n;

/** The two calls the scanner needs from a viem public client. */
export type LogSource = Pick<PublicClient, 'getLogs' | 'getBlockNumber'>;

export interface LogScanOptions {
  /** Contract whose logs are read. */
  address: Hex;
  /** Only this event; its indexed arguments may be filtered with `args` (e.g. `{ cid }`). */
  event?: AbiEvent;
  args?: Record<string, unknown>;
  /**
   * First block, inclusive: the ceremony's creation block when the caller knows a lower bound
   * for it, else the manager's deployment block.
   */
  fromBlock: bigint;
  /** Last block, inclusive. Default: the head when the scan starts. */
  toBlock?: bigint;
  /** Blocks per request (default 10,000); halved, never below 1, when a provider refuses a range. */
  chunkSize?: bigint;
  /** Stop after this many `eth_getLogs` requests; resume from `nextBlock`. Default: no limit. */
  maxRequests?: number;
  signal?: AbortSignal;
}

export interface LogScanResult {
  logs: Log[];
  /** First block not scanned yet: pass it as `fromBlock` to resume. `toBlock + 1` once complete. */
  nextBlock: bigint;
  toBlock: bigint;
  /** Every block up to `toBlock` was scanned. */
  complete: boolean;
  /** The range that last worked (after any halving): carry it into a resumed scan. */
  chunkSize: bigint;
  /** `eth_getLogs` requests made, refused ones included. */
  requests: number;
  /** Why the scan stopped early, when it was not the request budget or a lagging provider. */
  error?: unknown;
}

/** Messages, codes and HTTP statuses along an error's cause chain. */
function errorChain(err: unknown): { text: string; codes: number[]; statuses: number[] } {
  const parts: string[] = [];
  const codes: number[] = [];
  const statuses: number[] = [];
  const seen = new Set<unknown>();
  let cur: unknown = err;
  while (cur && typeof cur === 'object' && !seen.has(cur)) {
    seen.add(cur);
    const e = cur as { message?: unknown; shortMessage?: unknown; details?: unknown; code?: unknown; status?: unknown };
    for (const v of [e.message, e.shortMessage, e.details]) if (typeof v === 'string') parts.push(v);
    if (typeof e.code === 'number') codes.push(e.code);
    if (typeof e.status === 'number') statuses.push(e.status);
    cur = (cur as { cause?: unknown }).cause;
  }
  if (typeof err === 'string') parts.push(err);
  return { text: parts.join(' | '), codes, statuses };
}

/** Rate limits and quotas: transient, never a reason to shrink the range. */
const RATE_LIMIT = /rate.?limit|too many requests|request limit|compute units|capacity|quota|throughput/i;

/**
 * How providers refuse a range that is too wide or a result that is too large (Infura, Alchemy,
 * QuickNode, publicnode, Ankr, dRPC, Chainstack, LlamaRPC, Nethermind, Erigon, 1RPC…).
 */
const RANGE_LIMIT = new RegExp(
  [
    'block ?range',
    'blocks range',
    'range (of blocks|limit|is too|too)',
    'ranges? over [\\d,]+',
    'max(imum)?( allowed)?( block)? range',
    'limited to (a )?[\\d,]+',
    'too many (results|logs)',
    'more than [\\d,]+ (results|logs)',
    'max(imum)? (results|logs)',
    'query exceeds',
    'query returned more',
    'response size',
    'response (is )?too (large|big)',
    'log response',
    'query timeout',
    'reduc(e|ing) (your |the )?(block )?range',
    'retry with (the|a) (range|smaller)',
    'exceeds? (the )?defined limit',
    'range too (large|wide)',
  ].join('|'),
  'i',
);

/** A load-balanced provider answered from a backend behind the head the scan was given. */
const BEHIND_HEAD = /beyond (the )?current head|header not found|unknown block|block not found|after last accepted block/i;

/** The provider refused the range (or the size of its answer): a smaller range may pass. */
export function isLogRangeError(err: unknown): boolean {
  const { text, statuses } = errorChain(err);
  if (RATE_LIMIT.test(text)) return false;
  return RANGE_LIMIT.test(text) || statuses.includes(413);
}

/** The provider is behind the head the scan targets; the same range works moments later. */
export function isBehindHeadError(err: unknown): boolean {
  return BEHIND_HEAD.test(errorChain(err).text);
}

const min = (a: bigint, b: bigint) => (a < b ? a : b);

/**
 * Scan `[fromBlock, toBlock]` in ranges of at most `chunkSize` blocks over `sources` (tried in
 * order; the next one takes over when one fails for another reason than the range). A refused
 * range is halved and retried; a provider behind the head ends the scan early (resume later);
 * when every source fails the scan stops with `error` set. Never throws for an RPC failure.
 */
export async function scanLogs(sources: LogSource | LogSource[], opts: LogScanOptions): Promise<LogScanResult> {
  const list = Array.isArray(sources) ? sources : [sources];
  if (list.length === 0) throw new Error('scanLogs: no log source');
  let chunk = opts.chunkSize ?? DEFAULT_LOG_CHUNK;
  if (chunk < 1n) throw new Error('scanLogs: chunkSize must be at least 1');
  let source = 0;
  const logs: Log[] = [];
  let requests = 0;
  let from = opts.fromBlock;
  let toBlock = opts.toBlock;
  if (toBlock === undefined) {
    let lastErr: unknown;
    for (let i = 0; i < list.length && toBlock === undefined; i++) {
      try {
        toBlock = await (list[i] as LogSource).getBlockNumber({ cacheTime: 0 });
        source = i;
      } catch (err) {
        lastErr = err;
      }
    }
    if (toBlock === undefined) {
      return { logs, nextBlock: from, toBlock: from - 1n, complete: false, chunkSize: chunk, requests, error: lastErr };
    }
  }
  const done = (error?: unknown): LogScanResult => ({
    logs,
    nextBlock: from,
    toBlock: toBlock as bigint,
    complete: from > (toBlock as bigint),
    chunkSize: chunk,
    requests,
    ...(error === undefined ? {} : { error }),
  });

  let failedSources = 0;
  while (from <= toBlock) {
    if (opts.maxRequests !== undefined && requests >= opts.maxRequests) return done();
    if (opts.signal?.aborted) return done(opts.signal.reason ?? new Error('log scan aborted'));
    const end = min(from + chunk - 1n, toBlock);
    requests++;
    try {
      const page = await (list[source] as LogSource).getLogs({
        address: opts.address,
        ...(opts.event ? { event: opts.event, args: opts.args as never } : {}),
        fromBlock: from,
        toBlock: end,
      } as never);
      logs.push(...(page as Log[]));
      from = end + 1n;
      failedSources = 0;
    } catch (err) {
      if (isBehindHeadError(err)) return done();
      if (isLogRangeError(err) && chunk > 1n) {
        chunk = chunk / 2n;
        continue;
      }
      // Anything else (method disabled, plan refusal, transport): try the next provider on the
      // same range; once every one failed in a row, stop with the cursor where it is.
      failedSources++;
      if (failedSources >= list.length) return done(err);
      source = (source + 1) % list.length;
    }
  }
  return done();
}

/**
 * A resumable scan that follows the head: each `advance` scans from where the previous one
 * stopped up to the current head (or as far as its request budget allows) and keeps every log
 * it has seen. Concurrent calls share one scan. Cosmetic use only (labels, linkage).
 */
export class LogScanner {
  private cursor: bigint;
  private chunk: bigint;
  private readonly found: Log[] = [];
  private inflight: Promise<LogScanResult> | undefined;
  private caughtUp = false;
  private lastError: unknown;

  constructor(
    private readonly sources: LogSource | LogSource[],
    private readonly opts: Omit<LogScanOptions, 'toBlock' | 'maxRequests' | 'signal'>,
  ) {
    this.cursor = opts.fromBlock;
    this.chunk = opts.chunkSize ?? DEFAULT_LOG_CHUNK;
  }

  /** Every log found so far, in block order. */
  get logs(): readonly Log[] {
    return this.found;
  }

  /** First block not scanned yet. */
  get nextBlock(): bigint {
    return this.cursor;
  }

  /** The last `advance` reached the head it targeted. */
  get complete(): boolean {
    return this.caughtUp;
  }

  /** Why the last `advance` stopped early, if a provider failed. */
  get error(): unknown {
    return this.lastError;
  }

  /** Scan on from the cursor, at most `maxRequests` requests (default 50). */
  advance(opts: { maxRequests?: number; signal?: AbortSignal } = {}): Promise<LogScanResult> {
    this.inflight ??= (async () => {
      try {
        const result = await scanLogs(this.sources, {
          ...this.opts,
          fromBlock: this.cursor,
          chunkSize: this.chunk,
          maxRequests: opts.maxRequests ?? 50,
          signal: opts.signal,
        });
        this.found.push(...result.logs);
        this.cursor = result.nextBlock;
        this.chunk = result.chunkSize;
        this.caughtUp = result.complete;
        this.lastError = result.error;
        return result;
      } finally {
        this.inflight = undefined;
      }
    })();
    return this.inflight;
  }
}
