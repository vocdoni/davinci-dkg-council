/**
 * Scheduler (architecture §5.2 "scheduler duties", protocol §8.3–§8.4, §8.7): sends the due
 * permissionless phase transitions of the ceremonies this relayer sponsors — the time-based
 * close (`closeRegistrationScheduled`: a Scheduled registration, or a Manual one past its
 * expiry, with at least t members), `abort` (registration or dealing that can no longer go
 * Live) and `finalize` (dealing complete) — and notices decryption opening.
 *
 * - The watched ceremonies are those the relayer sponsored an action for (the state file); no
 *   log is read. Each pass reads the views at the latest finalized block (`getCeremony`,
 *   `getPolicy`) and evaluates the SDK predicates (schedule.ts). The abort predicates depend on
 *   counts that are final only once the finalized block is past the deadline, so they are
 *   evaluated on the finalized state at the finalized timestamp, and an abort is never sent
 *   while a transition this relayer sent is not final.
 * - A due close is decided on the head: the window of `closeRegistrationScheduled` (deadline to
 *   deadline + dealingDuration, at least 10 minutes) can be shorter than the finality lag (about
 *   13 minutes on Sepolia), so a threshold reached by a join shortly before the deadline would
 *   reach the finalized block only after the window. Once the head is past the deadline the
 *   scheduler reads `getCeremony` at the head and, if the close is due there, sends it (the
 *   sponsor simulates it at the head; nothing is paid for a close that would revert). Finalize
 *   (whose inputs only grow and which has no upper bound) is evaluated on the finalized counts
 *   at the head's timestamp.
 * - A due transition goes through the sponsor: admission, the one-shot slot and quota
 *   (`cer:<cid>:phase`, one close / finalize / abort per ceremony), simulation at the head and
 *   the global budget. So it is sent at most once, never paid for when it would revert, and an
 *   identical transition relayed for a browser shares its pending transaction.
 * - Decryption opening needs no transaction (protocol §8.7: Scheduled dates and the Manual
 *   fallback open the gate by predicate alone; only the organizer's signed openDecryption
 *   writes). The scheduler watches a Live ceremony until `getPolicy.decryptionOpen` is true at
 *   the finalized block, then logs it, wakes the combiner for its requests and stops watching.
 */

import {
  abortDue,
  finalizeDue,
  Phase,
  PhaseMode,
  scheduledCloseDue,
  type Action,
  type CeremonyView,
  type Hex,
  type PhasePolicyView,
  type ScheduleState,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { PublicClient } from 'viem';
import { describeSendError, isTransientReadError } from './broadcast.js';
import { ChainState, type ReadAt } from './chainstate.js';
import { RelayError, revertName } from './errors.js';
import { silentLogger, type Logger } from './log.js';
import type { Sponsor } from './policy.js';
import type { LoopStatus, TxSender } from './sender.js';
import type { StateStore } from './state.js';

export type Transition = 'closeRegistrationScheduled' | 'abort' | 'finalize';

export interface SchedulerOptions {
  client: PublicClient;
  manager: Hex;
  sponsor: Pick<Sponsor, 'sponsor'>;
  sender: Pick<TxSender, 'status'>;
  /** Holds the watched ceremonies (`state.watched`). */
  store: StateStore;
  chain?: ChainState;
  /** Called once when a watched ceremony's decryption gate is open (the combiner's `wake`). */
  onDecryptionOpen?: (cid: Hex) => void;
  /** Base of the per-ceremony exponential backoff after a failed attempt. */
  backoffMs?: number;
  log?: Logger;
  now?: () => number;
}

interface Watch {
  failures: number;
  retryAt: number;
  /** Nothing can be due before this head timestamp (a registration deadline, a scheduled opening). */
  wakeAt?: bigint;
  /** The immutable policy fields, read once. */
  policy?: PhasePolicyView;
  /** The last transition sent, until the finalized phase moves past `phase`, it fails or times out. */
  sent?: { kind: Transition; hash: Hex; phase: number; at: number };
  /** Transitions this relayer already paid for once (quota spent): left to others. */
  spent: Set<Transition>;
  /** When the ceremony was first missing at the finalized block. */
  unknownSince?: number;
}

const MAX_BACKOFF_MS = 5 * 60_000;
const MAX_TICK_BACKOFF_MS = 5 * 60_000;
/** A sent transition whose effect the finalized state still lacks after this long is re-examined. */
const SENT_TIMEOUT_MS = 30 * 60_000;
/** A watched id unknown at the finalized block for this long (a reverted create) is dropped. */
const UNKNOWN_DROP_MS = 24 * 3_600_000;
const TRANSIENT_WARN_AFTER = 5;

/** viem's "returned no data": no contract at that block. */
const zeroData = (err: unknown): boolean => {
  for (let e: unknown = err; e && typeof e === 'object'; e = (e as { cause?: unknown }).cause) {
    if ((e as { name?: unknown }).name === 'ContractFunctionZeroDataError') return true;
  }
  return false;
};

const popcount = (v: number): number => {
  let n = 0;
  for (let x = v; x; x &= x - 1) n++;
  return n;
};

export class Scheduler {
  private readonly client: PublicClient;
  private readonly chain: ChainState;
  private readonly store: StateStore;
  private readonly sponsor: Pick<Sponsor, 'sponsor'>;
  private readonly sender: Pick<TxSender, 'status'>;
  private readonly onDecryptionOpen: ((cid: Hex) => void) | undefined;
  private readonly backoffMs: number;
  private readonly log: Logger;
  private readonly now: () => number;
  private readonly watches = new Map<Hex, Watch>();
  private running = false;
  private timer: NodeJS.Timeout | undefined;
  private tickFailures = 0;
  private readonly loop: LoopStatus = { failures: 0 };

  constructor(opts: SchedulerOptions) {
    this.client = opts.client;
    this.chain = opts.chain ?? new ChainState(opts.client, opts.manager);
    this.store = opts.store;
    this.sponsor = opts.sponsor;
    this.sender = opts.sender;
    this.onDecryptionOpen = opts.onDecryptionOpen;
    this.backoffMs = opts.backoffMs ?? 5000;
    this.log = opts.log ?? silentLogger;
    this.now = opts.now ?? Date.now;
  }

  /** Ceremonies being watched. */
  get watching(): Hex[] {
    return [...this.store.state.watched];
  }

  /** The pass loop's health, for /v1/metrics. */
  status(): LoopStatus & { watching: number } {
    return { ...this.loop, watching: this.store.state.watched.length };
  }

  /** Watch a ceremony (the policy records every sponsored one; tests and tools may add more). */
  watch(cid: Hex): void {
    const id = cid.toLowerCase() as Hex;
    if (this.store.state.watched.includes(id)) return;
    this.store.state.watched.push(id);
    this.store.flushSoon();
  }

  private drop(cid: Hex, reason: string): void {
    this.watches.delete(cid);
    this.store.state.watched = this.store.state.watched.filter((c) => c !== cid);
    this.store.flushSoon();
    this.log.info('scheduler stops watching ceremony', { cid, reason });
  }

  start(pollMs: number): void {
    this.stop();
    const loop = (): void => {
      this.tick()
        .then(
          () => {
            this.tickFailures = 0;
            return pollMs;
          },
          (err: unknown) => {
            this.tickFailures++;
            const delay = Math.min(MAX_TICK_BACKOFF_MS, pollMs * 2 ** (this.tickFailures - 1));
            const fields = { err: describeSendError(err), failures: this.tickFailures, retryInMs: delay };
            if (isTransientReadError(err) && this.tickFailures < TRANSIENT_WARN_AFTER) {
              this.log.info('scheduler pass deferred: transient rpc error', fields);
            } else {
              this.log.warn('scheduler tick failed', fields);
            }
            return delay;
          },
        )
        .then((delay) => {
          if (this.timer !== undefined) this.timer = setTimeout(loop, delay);
        });
    };
    this.timer = setTimeout(loop, 0);
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
  }

  /** One pass over every watched ceremony. */
  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      await this.pass();
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

  private async pass(): Promise<void> {
    const [head, fin] = await Promise.all([
      this.client.getBlock({ blockTag: 'latest' }),
      this.client.getBlock({ blockTag: 'finalized' }),
    ]);
    const anchor = { number: fin.number as bigint, timestamp: fin.timestamp };
    const headAt = { number: head.number as bigint, timestamp: head.timestamp };
    for (const cid of [...this.store.state.watched]) {
      let w = this.watches.get(cid);
      if (!w) {
        w = { failures: 0, retryAt: 0, spent: new Set() };
        this.watches.set(cid, w);
      }
      if (this.now() < w.retryAt) continue;
      if (w.wakeAt !== undefined && head.timestamp < w.wakeAt) continue;
      try {
        await this.service(cid, w, headAt, anchor);
      } catch (err) {
        const reason = err instanceof RelayError ? `${err.code}: ${err.detail}` : describeSendError(err);
        this.backoff(cid, w, reason, isTransientReadError(err));
      }
    }
  }

  private backoff(cid: Hex, w: Watch, reason: string, transient: boolean): void {
    w.failures++;
    w.retryAt = this.now() + Math.min(MAX_BACKOFF_MS, this.backoffMs * 2 ** (w.failures - 1));
    const fields = { cid, failures: w.failures, err: reason };
    if (transient && w.failures < TRANSIENT_WARN_AFTER) this.log.info('scheduled transition deferred', fields);
    else this.log.warn('scheduled transition failed', fields);
  }

  private async service(
    cid: Hex,
    w: Watch,
    head: { number: bigint; timestamp: bigint },
    fin: { number: bigint; timestamp: bigint },
  ): Promise<void> {
    const headTime = head.timestamp;
    const at: ReadAt = { blockNumber: fin.number };
    let view: CeremonyView;
    try {
      view = await this.chain.ceremony(cid, at);
    } catch (err) {
      // Created after the finalized block (or never: a create that reverted on chain), or a
      // manager whose deployment is not finalized yet (no code there: no data).
      if (revertName(err) !== 'UnknownCeremony' && !zeroData(err)) throw err;
      w.unknownSince ??= this.now();
      if (this.now() - w.unknownSince >= UNKNOWN_DROP_MS) return this.drop(cid, 'unknown at the finalized block');
      // A ceremony created moments ago may already be due a close (a short deadline): its
      // window does not wait for finality.
      if (!w.sent) await this.closeAtHead(cid, w, head);
      return;
    }
    w.unknownSince = undefined;
    if (view.phase === Phase.Aborted || view.phase === Phase.None) return this.drop(cid, 'aborted');
    // A transition already sent: wait while it is pending or mined and the finalized phase has
    // not moved on yet; a failed one frees the ceremony (its quota decides about a retry).
    if (w.sent) {
      if (view.phase !== w.sent.phase || this.now() - w.sent.at >= SENT_TIMEOUT_MS) w.sent = undefined;
      else {
        const st = await this.sender.status(w.sent.hash).catch(() => undefined);
        if (st === undefined || st.status !== 'failed') return;
        this.log.warn('scheduled transition failed on chain', { cid, transition: w.sent.kind, hash: w.sent.hash });
        w.sent = undefined;
      }
    }
    const live = view.phase === Phase.Live;
    // The policy is immutable except the opening fields, which a Live ceremony re-reads.
    const policy = w.policy && !live ? w.policy : await this.chain.policy(cid, at);
    w.policy = policy;
    const s: ScheduleState = {
      phase: view.phase,
      registrationMode: policy.registrationMode,
      decryptionMode: policy.decryptionMode,
      registrationDeadline: view.registrationDeadline,
      dealingDuration: policy.dealingDuration,
      decryptionOpenAt: policy.decryptionOpenAt,
      manualDecryptionFallbackAt: policy.manualDecryptionFallbackAt,
      manualOpenedAt: policy.manualOpenedAt,
      dealingDeadline: view.dealingDeadline,
      joinedCount: view.joinedCount,
      threshold: view.threshold,
      n: view.n,
      qualCount: popcount(view.qualBitmap),
    };
    switch (view.phase) {
      case Phase.Registration:
        if (abortDue(s, fin.timestamp)) return this.transition(cid, w, 'abort', view.phase);
        if (view.registrationDeadline !== 0n && headTime >= view.registrationDeadline) {
          // Due at the head: a join near the deadline is not final yet, and the window may close
          // before it is (the finalized count would then only ever say "abort").
          if (await this.closeAtHead(cid, w, head)) return;
        }
        // A Scheduled registration cannot change before its deadline; a Manual one can (the
        // organizer's close), so it is polled.
        w.wakeAt =
          policy.registrationMode === PhaseMode.Scheduled && headTime < view.registrationDeadline
            ? view.registrationDeadline
            : undefined;
        return;
      case Phase.Dealing:
        w.wakeAt = undefined;
        if (finalizeDue(s, headTime)) return this.transition(cid, w, 'finalize', view.phase);
        if (abortDue(s, fin.timestamp)) return this.transition(cid, w, 'abort', view.phase);
        return;
      default: {
        // Live: no transaction opens decryption (protocol §8.7); report the gate once it is open.
        const scheduled = policy.decryptionMode === PhaseMode.Scheduled;
        if (policy.decryptionOpen) {
          this.log.info('decryption gate open', { cid, mode: scheduled ? 'scheduled' : 'manual' });
          this.onDecryptionOpen?.(cid);
          return this.drop(cid, 'live and open');
        }
        // A scheduled date cannot come early; a manual opening (or its fallback) is polled.
        w.wakeAt = scheduled && headTime < policy.decryptionOpenAt ? policy.decryptionOpenAt : undefined;
        return;
      }
    }
  }

  /**
   * Read the ceremony at the head and send `closeRegistrationScheduled` if it is due there (the
   * sponsor simulates it at the head). True when a close was attempted.
   */
  private async closeAtHead(cid: Hex, w: Watch, head: { number: bigint; timestamp: bigint }): Promise<boolean> {
    const at: ReadAt = { blockNumber: head.number };
    let view: CeremonyView;
    try {
      view = await this.chain.ceremony(cid, at);
    } catch (err) {
      if (revertName(err) === 'UnknownCeremony' || zeroData(err)) return false;
      throw err;
    }
    if (view.phase !== Phase.Registration || view.registrationDeadline === 0n) return false;
    const policy = w.policy ?? (await this.chain.policy(cid, at));
    w.policy = policy;
    const s: ScheduleState = {
      phase: view.phase,
      registrationMode: policy.registrationMode,
      decryptionMode: policy.decryptionMode,
      registrationDeadline: view.registrationDeadline,
      dealingDuration: policy.dealingDuration,
      decryptionOpenAt: policy.decryptionOpenAt,
      manualDecryptionFallbackAt: policy.manualDecryptionFallbackAt,
      manualOpenedAt: policy.manualOpenedAt,
      dealingDeadline: view.dealingDeadline,
      joinedCount: view.joinedCount,
      threshold: view.threshold,
      n: view.n,
      qualCount: popcount(view.qualBitmap),
    };
    if (!scheduledCloseDue(s, head.timestamp)) return false;
    await this.transition(cid, w, 'closeRegistrationScheduled', Phase.Registration);
    return true;
  }

  private async transition(cid: Hex, w: Watch, kind: Transition, phase: number): Promise<void> {
    if (w.spent.has(kind)) return;
    const action: Action = { kind, ceremonyId: cid };
    try {
      const hash = await this.sponsor.sponsor(action, { source: 'scheduler' });
      w.sent = { kind, hash, phase, at: this.now() };
      w.failures = 0;
      w.retryAt = 0;
      this.log.info('scheduled transition sent', { cid, transition: kind, hash });
    } catch (err) {
      const code = err instanceof RelayError ? err.code : undefined;
      if (code === 'QUOTA_EXCEEDED') {
        // Sponsored once already (it failed or was reorged out): anyone may still send it.
        w.spent.add(kind);
        this.log.warn('scheduled transition already sponsored once; leaving it to others', { cid, transition: kind });
        return;
      }
      if (code === 'NOT_SPONSORED') return this.drop(cid, 'not sponsored');
      // SIMULATION_REVERTED: the head moved on (another caller, a lagging finalized view);
      // CONFLICT: an identical-slot transition is pending; BUDGET_EXHAUSTED: wait for the window.
      const transient = code === 'SIMULATION_REVERTED' || code === 'CONFLICT' || isTransientReadError(err);
      const reason = err instanceof RelayError ? `${err.code}: ${err.detail}` : describeSendError(err);
      this.backoff(cid, w, `${kind}: ${reason}`, transient);
    }
  }
}
