/**
 * DAVINCI vote titles are display-only but trust-checked (lib/voteMeta.ts): providers must agree
 * on the registry's (metadataURI, metadataHash) pair and the fetched bytes must hash to it.
 */

import { describe, expect, it, vi } from 'vitest';
import { fetchVoteTitle, makeVoteTitle, type ProcessReader } from '../src/lib/voteMeta';
import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';

const REGISTRY = `0x${'22'.repeat(20)}` as Hex;
const PID = `0x${'cd'.repeat(31)}` as Hex;

const bytesOf = (doc: unknown): Uint8Array<ArrayBuffer> => new TextEncoder().encode(JSON.stringify(doc));
const hashOf = async (bytes: Uint8Array<ArrayBuffer>): Promise<Hex> => {
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  return `0x${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}` as Hex;
};

const reader = (metadataURI: string, metadataHash: Hex): ProcessReader => ({
  readContract: async () => ({ metadataURI, metadataHash }),
});
const failing: ProcessReader = {
  readContract: async () => {
    throw new Error('provider down');
  },
};

const serving = (bytes: Uint8Array<ArrayBuffer>): typeof fetch =>
  vi.fn(async () => new Response(new Uint8Array(bytes), { status: 200 })) as unknown as typeof fetch;

describe('fetchVoteTitle', () => {
  it('returns the verified title (MultiLanguage default)', async () => {
    const bytes = bytesOf({ title: { default: '  Board election 2026  ' } });
    const hash = await hashOf(bytes);
    const title = await fetchVoteTitle([reader('https://x.example/m.json', hash)], REGISTRY, PID, serving(bytes));
    expect(title).toBe('Board election 2026');
  });

  it('accepts a plain string title and a provider that is down (the rest agree)', async () => {
    const bytes = bytesOf({ title: 'Annual vote' });
    const hash = await hashOf(bytes);
    const clients = [failing, reader('https://x.example/m.json', hash), reader('https://x.example/m.json', hash)];
    expect(await fetchVoteTitle(clients, REGISTRY, PID, serving(bytes))).toBe('Annual vote');
  });

  it('refuses when providers disagree on the pointer', async () => {
    const bytes = bytesOf({ title: 'Annual vote' });
    const hash = await hashOf(bytes);
    const clients = [reader('https://x.example/m.json', hash), reader('https://y.example/other.json', hash)];
    expect(await fetchVoteTitle(clients, REGISTRY, PID, serving(bytes))).toBeUndefined();
  });

  it('refuses bytes that do not hash to the registry pointer', async () => {
    const bytes = bytesOf({ title: 'Tampered' });
    const hash = await hashOf(bytesOf({ title: 'Original' }));
    expect(await fetchVoteTitle([reader('https://x.example/m.json', hash)], REGISTRY, PID, serving(bytes))).toBeUndefined();
  });

  it('skips a zero hash and a non-http uri without fetching', async () => {
    const fetchFn = vi.fn() as unknown as typeof fetch;
    const zero = `0x${'00'.repeat(32)}` as Hex;
    expect(await fetchVoteTitle([reader('https://x.example/m.json', zero)], REGISTRY, PID, fetchFn)).toBeUndefined();
    const hash = await hashOf(bytesOf({}));
    expect(await fetchVoteTitle([reader('ipfs://abc', hash)], REGISTRY, PID, fetchFn)).toBeUndefined();
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('returns undefined when every provider fails or the title is missing', async () => {
    expect(await fetchVoteTitle([failing], REGISTRY, PID, serving(bytesOf({})))).toBeUndefined();
    const bytes = bytesOf({ description: 'no title' });
    const hash = await hashOf(bytes);
    expect(await fetchVoteTitle([reader('https://x.example/m.json', hash)], REGISTRY, PID, serving(bytes))).toBeUndefined();
  });
});

describe('makeVoteTitle', () => {
  it('memoizes a hit and never throws on a miss', async () => {
    const bytes = bytesOf({ title: 'Cached vote' });
    const hash = await hashOf(bytes);
    const fetchFn = serving(bytes);
    const titles = makeVoteTitle([reader('https://x.example/m.json', hash)], REGISTRY, fetchFn);
    expect(await titles(PID)).toBe('Cached vote');
    expect(await titles(PID.toUpperCase() as Hex)).toBe('Cached vote');
    expect(fetchFn).toHaveBeenCalledTimes(1);
    const missing = makeVoteTitle([failing], REGISTRY, fetchFn);
    await expect(missing(PID)).resolves.toBeUndefined();
  });
});
