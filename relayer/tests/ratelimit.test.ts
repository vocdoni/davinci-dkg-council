import { describe, expect, it } from 'vitest';
import { RateLimiter } from '../src/ratelimit.js';

describe('RateLimiter', () => {
  it('counts per key and window', () => {
    let now = 0;
    const rl = new RateLimiter(1000, () => now);
    expect([rl.take('a', 2), rl.take('a', 2), rl.take('a', 2), rl.take('b', 2)]).toEqual([true, true, false, true]);
    now = 1000;
    expect(rl.take('a', 2)).toBe(true);
  });

  it('drops expired keys once per window', () => {
    let now = 0;
    const rl = new RateLimiter(1000, () => now);
    for (let i = 0; i < 1000; i++) rl.take(`k${i}`, 1);
    expect(rl.size).toBe(1000);
    now = 1000;
    rl.take('fresh', 1);
    expect(rl.size).toBe(1);
  });
});
