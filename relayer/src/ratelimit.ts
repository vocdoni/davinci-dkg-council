/** Fixed-window request counters keyed by an arbitrary string (IP+action, ceremony). */
export class RateLimiter {
  private readonly windows = new Map<string, { start: number; count: number }>();
  private lastPrune: number;

  constructor(
    private readonly windowMs = 60_000,
    private readonly now: () => number = Date.now,
  ) {
    this.lastPrune = now();
  }

  /** Count one request against `key`; false when the window already holds `limit`. */
  take(key: string, limit: number): boolean {
    const now = this.now();
    // Expired windows are dropped once per window, so memory tracks only recent keys.
    if (now - this.lastPrune >= this.windowMs) this.prune(now);
    const w = this.windows.get(key);
    if (!w || now - w.start >= this.windowMs) {
      this.windows.set(key, { start: now, count: 1 });
      return true;
    }
    if (w.count >= limit) return false;
    w.count++;
    return true;
  }

  /** Give back one request taken in the current window (a reservation that was undone). */
  refund(key: string): void {
    const w = this.windows.get(key);
    if (w && w.count > 0) w.count--;
  }

  /** Keys currently held (tests). */
  get size(): number {
    return this.windows.size;
  }

  private prune(now: number): void {
    this.lastPrune = now;
    for (const [key, w] of this.windows) {
      if (now - w.start >= this.windowMs) this.windows.delete(key);
    }
  }
}
