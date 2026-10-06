import { describe, expect, it } from 'vitest';
import { timeLeft, voteName } from '../src/lib/format';

const NOW = 1_800_000_000;
const left = (seconds: number) => timeLeft(NOW + seconds, NOW);

describe('timeLeft', () => {
  it.each([
    [0, 'time is up'],
    [-5, 'time is up'],
    [30, 'less than a minute left'],
    [60, 'about 1 minute left'],
    [10 * 60 + 20, 'about 10 minutes left'],
    // Just under an hour rounds up to the hour, never "60 minutes".
    [3599, 'about 1 hour left'],
    [2 * 3600 + 15 * 60, 'about 2 h 15 min left'],
    [23 * 3600 + 20 * 60, 'about 23 h 20 min left'],
    // Above ~23.5 h nobody plans by the hour: round to whole days,
    // never "about 23 h 59 min left" or "23 h 60 min".
    [86_400 - 10, 'about 1 day left'],
    [86_400 - 29 * 60, 'about 1 day left'],
    [86_400, 'about 1 day left'],
    [2 * 86_400 + 3 * 3600, 'about 2 days left'],
    [3 * 86_400 - 60, 'about 3 days left'],
  ])('%i s → %s', (seconds, want) => {
    expect(left(seconds)).toBe(want);
  });
});

describe('voteName', () => {
  const pid = '0x15d34aaf54267db7d7c367839aaf71a00a2c6a650000000000000000000003';
  it('prefers the local label', () => {
    expect(voteName('City budget', 2, pid)).toBe('City budget');
  });
  it('falls back to an ordinal plus the short id', () => {
    expect(voteName(undefined, 2, pid)).toBe(`Vote #2 (0x15d34a…0003)`);
    expect(voteName('   ', 1, pid)).toMatch(/^Vote #1 \(0x15d34a…0003\)$/);
  });
});
