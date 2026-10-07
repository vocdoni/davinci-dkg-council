/**
 * The relayer's local state: one JSON file under COUNCIL_DATA_DIR, written atomically
 * (temp file + rename). It holds what a restart must not forget — signed pending transactions
 * and mined ones not final yet (so evicted or reorged-out ones are rebroadcast and their nonces
 * never reused), recent transaction outcomes (for /v1/status), the rolling spend log of the
 * budget, the sponsorship counters and re-publication backoffs, the ceremonies the scheduler
 * watches and those whose requests the combine worker enumerates. The D-vector cache lives next
 * to it, one file per request (partials.ts). Chain state remains the only truth about the
 * protocol.
 *
 * Size is bounded by construction: settled outcomes are capped in count and age, the spend log
 * by the budget window, and the policy's garbage collection (policy.ts `gc`) prunes counters of
 * terminal ceremonies and requests, expired organizer records and backoffs. Journal writes (a
 * transaction about to be broadcast) are synchronous (`flush`); everything else is coalesced
 * (`flushSoon`) so bursts of bookkeeping cost one write.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';

export type PersistedFees =
  | { type: 'eip1559'; maxFeePerGas: string; maxPriorityFeePerGas: string }
  | { type: 'legacy'; gasPrice: string };

/** A transaction mined at least once and not final yet: kept replayable until it is. */
export interface PersistedMined {
  state: 'confirmed' | 'failed';
  blockNumber: string;
  blockHash?: Hex;
  hash: Hex;
  revertReason?: string;
  settledAt: number;
}

export interface PersistedTx {
  nonce: number;
  to: Hex;
  data: Hex;
  gas: string;
  fees: PersistedFees;
  raw: Hex;
  hashes: Hex[];
  lastSentAt: number;
  /** First broadcast (absent in files written before it existed: lastSentAt). */
  firstSentAt?: number;
  slots: string[];
  reservedWei: string;
  /** Highest worst case (gas limit × max fee) of any version signed for this nonce. */
  maxWorstWei?: string;
  /** Spend-log entries written for this nonce (its mined cost), to credit a re-mined replay. */
  charges?: { t: number; wei: string }[];
  /** Set while the transaction is mined but not final. */
  mined?: PersistedMined;
}

export interface SettledTx {
  hashes: Hex[];
  state: 'confirmed' | 'failed';
  blockNumber?: string;
  revertReason?: string;
  minedHash?: Hex;
  settledAt: number;
}

export interface RelayerState {
  version: 1;
  /** Unmined and mined-but-not-final transactions (`mined` set), with everything to replay them. */
  pending: PersistedTx[];
  history: SettledTx[];
  /** Spend log of the rolling budget window. */
  spend: { t: number; wei: string }[];
  /** Sponsorship counters, key -> units used. */
  quotas: Record<string, number>;
  /** Ceremonies admitted by this relayer (restricted mode). */
  admitted: Hex[];
  /** Organizer -> timestamps of sponsored createCeremony (last 24 h only). */
  organizerCreates: Record<string, number[]>;
  /**
   * Ceremonies this relayer sponsored an action for, oldest first: the scheduler services their
   * due permissionless transitions (scheduler.ts) and drops them once nothing is left to send.
   */
  watched: Hex[];
  /**
   * Ceremonies whose requests the combine worker enumerates from contract state
   * (`getRequestCount` / `getRequestIdsPage`), oldest first: those it sponsored a decryption
   * action for, whose gate the scheduler saw open, that were registered through `/v1/track`, or
   * whose requests it discovered in logs (combiner.ts).
   */
  tracked: Hex[];
  /** `requestId:index` -> sponsored publishPartialData re-publications (protocol §10.4 backoff). */
  republished: Record<string, { count: number; at: number }>;
}

export const emptyState = (): RelayerState => ({
  version: 1,
  pending: [],
  history: [],
  spend: [],
  quotas: {},
  admitted: [],
  organizerCreates: {},
  watched: [],
  tracked: [],
  republished: {},
});

/** Ceremonies whose requests the combine worker enumerates, at most (oldest dropped first). */
export const MAX_TRACKED = 10_000;

/** Add a ceremony to `state.tracked` (bounded); true when it was not there. */
export function trackCeremony(state: RelayerState, cid: Hex): boolean {
  const id = cid.toLowerCase() as Hex;
  if (state.tracked.includes(id)) return false;
  state.tracked.push(id);
  if (state.tracked.length > MAX_TRACKED) state.tracked.splice(0, state.tracked.length - MAX_TRACKED);
  return true;
}

/** Coalescing delay of `flushSoon`. */
const FLUSH_DELAY_MS = 1000;

export class StateStore {
  readonly state: RelayerState;
  private timer: NodeJS.Timeout | undefined;
  /** Bytes of the last write (metrics). */
  lastWriteBytes = 0;

  /** `file` undefined keeps the state in memory only (tests). */
  constructor(readonly file?: string) {
    this.state = file ? StateStore.read(file) : emptyState();
  }

  /** The state file of one deployment and hot key: `<dir>/<chainId>-<manager>-<relayer>.json`. */
  static fileFor(dir: string, chainId: bigint, manager: Hex, relayer: Hex): string {
    return path.join(dir, `${chainId}-${manager.toLowerCase()}-${relayer.toLowerCase()}.json`);
  }

  private static read(file: string): RelayerState {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw err;
    }
    const parsed = JSON.parse(text) as Partial<RelayerState>;
    if (parsed.version !== 1) throw new Error(`state file ${file}: unsupported version ${String(parsed.version)}`);
    return { ...emptyState(), ...parsed } as RelayerState;
  }

  /** Persist atomically, now (the transaction journal: before a broadcast). */
  flush(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    const text = JSON.stringify(this.state);
    writeFileSync(tmp, text);
    renameSync(tmp, this.file);
    this.lastWriteBytes = text.length;
  }

  /** Persist shortly, coalescing every change until then into one write (bookkeeping). */
  flushSoon(): void {
    if (!this.file || this.timer) return;
    this.timer = setTimeout(() => {
      this.timer = undefined;
      this.flush();
    }, FLUSH_DELAY_MS);
    this.timer.unref();
  }

  /** Write anything `flushSoon` still holds (shutdown). */
  close(): void {
    if (this.timer) this.flush();
  }
}
