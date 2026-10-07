import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { StateStore } from '../src/state.js';

describe('state store (audit: no synchronous rewrite per bookkeeping change)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('coalesces bookkeeping writes into one, and writes what is held on close', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'council-state-')), 'state.json');
    const store = new StateStore(file);
    for (let i = 0; i < 100; i++) {
      store.state.watched.push(`0x${i.toString(16).padStart(24, '0')}`);
      store.flushSoon();
    }
    expect(existsSync(file)).toBe(false);
    await vi.advanceTimersByTimeAsync(1000);
    expect((JSON.parse(readFileSync(file, 'utf8')) as { watched: string[] }).watched).toHaveLength(100);
    store.state.watched.splice(0);
    store.flushSoon();
    store.close();
    expect((JSON.parse(readFileSync(file, 'utf8')) as { watched: string[] }).watched).toHaveLength(0);
  });

  it('reads files written before the tracked list existed', () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'council-state-')), 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        pending: [],
        history: [],
        spend: [],
        quotas: { 'cer:0x000000000000000000000001:join': 2 },
        admitted: [],
        organizerCreates: {},
        watched: ['0x000000000000000000000001'],
        republished: {},
      }),
    );
    const store = new StateStore(file);
    expect(store.state.tracked).toEqual([]);
    expect(store.state.watched).toEqual(['0x000000000000000000000001']);
    expect(store.state.quotas).toEqual({ 'cer:0x000000000000000000000001:join': 2 });
  });
});
