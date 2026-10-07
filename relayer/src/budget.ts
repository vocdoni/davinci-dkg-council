/**
 * Global spending circuit breaker: a rolling-window wei budget for everything the hot key
 * sponsors (relayed actions and the combine worker alike). A transaction reserves its
 * worst case (gas limit × max fee) when it is sent; its first receipt replaces the reservation
 * with the actual cost (gasUsed × effectiveGasPrice); a transaction verified dropped releases it.
 * A reorged-out transaction is reserved again for what its replay may cost beyond what was
 * already charged, and a re-mined one is charged only the difference (sender.ts).
 */

import { RelayError } from './errors.js';
import type { StateStore } from './state.js';

export class SpendBudget {
  private readonly reserved = new Map<number, bigint>();

  constructor(
    private readonly store: StateStore,
    /** 0 disables the breaker. */
    readonly limitWei: bigint,
    readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Actual spend inside the window. */
  spent(): bigint {
    const since = this.now() - this.windowMs;
    const log = this.store.state.spend;
    while (log.length > 0 && (log[0] as { t: number }).t <= since) log.shift();
    return log.reduce((s, e) => s + BigInt(e.wei), 0n);
  }

  /** Worst-case cost of transactions still in flight. */
  inFlight(): bigint {
    let s = 0n;
    for (const v of this.reserved.values()) s += v;
    return s;
  }

  /** Refuse a new worst-case cost that does not fit the window. */
  check(cost: bigint): void {
    if (this.limitWei === 0n) return;
    const used = this.spent() + this.inFlight();
    if (used + cost > this.limitWei) {
      throw new RelayError(
        'BUDGET_EXHAUSTED',
        `sponsorship paused: the ${Math.round(this.windowMs / 3_600_000)} h budget of ${this.limitWei} wei is used up (${used} spent or in flight)`,
      );
    }
  }

  /** True when raising a reservation by `extra` still fits (fee bumps). */
  fits(extra: bigint): boolean {
    return this.limitWei === 0n || this.spent() + this.inFlight() + extra <= this.limitWei;
  }

  reserve(nonce: number, cost: bigint): void {
    this.reserved.set(nonce, cost);
  }

  reservedFor(nonce: number): bigint {
    return this.reserved.get(nonce) ?? 0n;
  }

  /** Remaining room in the window (spent and in flight counted); undefined when disabled. */
  remaining(): bigint | undefined {
    if (this.limitWei === 0n) return undefined;
    const left = this.limitWei - this.spent() - this.inFlight();
    return left > 0n ? left : 0n;
  }

  /** Write a mined cost to the spend log (the caller flushes the store). */
  charge(wei: bigint): void {
    if (wei > 0n) this.store.state.spend.push({ t: this.now(), wei: wei.toString() });
  }

  /** Replace a reservation with the actual cost (the caller flushes the store). */
  settle(nonce: number, actualWei: bigint): void {
    this.reserved.delete(nonce);
    this.charge(actualWei);
  }

  release(nonce: number): void {
    this.reserved.delete(nonce);
  }
}
