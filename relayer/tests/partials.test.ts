import { mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { G, IDENTITY, partialVectorCacheKey, sourcePartialVectors, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { ChainState } from '../src/chainstate.js';
import { ChainPartialSource, PartialVectorStore } from '../src/partials.js';
import { ceremonyIdOf, encryptAll, MANAGER, MockChain, pad, partialOf, requestIdOf, rpcError, testKey } from './mockchain.js';

const HASH = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
const vector = (y: bigint) => pad([{ x: G.x, y }, IDENTITY]);
const tmp = () => mkdtempSync(path.join(tmpdir(), 'council-partials-'));

describe('PartialVectorStore', () => {
  it('persists one file per request, reloads it, and drops it', () => {
    const dir = tmp();
    const a = new PartialVectorStore(31337n, MANAGER, dir);
    a.put(requestIdOf(1), 2, HASH(7), vector(5n));
    a.put(requestIdOf(1), 3, HASH(8), vector(6n));
    a.put(requestIdOf(2), 1, HASH(9), vector(7n));
    expect(readdirSync(dir).sort()).toEqual([`${requestIdOf(1)}.json`, `${requestIdOf(2)}.json`]);

    const b = new PartialVectorStore(31337n, MANAGER, dir);
    expect(b.size).toBe(2);
    expect(b.get(partialVectorCacheKey(31337n, MANAGER, requestIdOf(1), 3, HASH(8)))).toEqual(vector(6n));
    expect(b.has(requestIdOf(1), 2, HASH(7))).toBe(true);
    expect(b.has(requestIdOf(1), 2, HASH(8))).toBe(false); // keyed by the commitment, not the member alone
    b.drop(requestIdOf(1));
    expect(readdirSync(dir)).toEqual([`${requestIdOf(2)}.json`]);
    expect(new PartialVectorStore(31337n, MANAGER, dir).has(requestIdOf(1), 2, HASH(7))).toBe(false);
  });

  it('ignores keys of another chain or manager, malformed vectors and torn files', () => {
    const dir = tmp();
    const s = new PartialVectorStore(31337n, MANAGER, dir);
    s.cache.set(partialVectorCacheKey(1n, MANAGER, requestIdOf(1), 1, HASH(1)), vector(1n));
    s.cache.set(partialVectorCacheKey(31337n, `0x${'00'.repeat(20)}`, requestIdOf(1), 1, HASH(1)), vector(1n));
    s.put(requestIdOf(1), 1, HASH(1), [G]); // not padded to 16
    expect(s.size).toBe(0);
    writeFileSync(path.join(dir, `${requestIdOf(3)}.json`), '{"version":1,"at":1,"vec');
    writeFileSync(path.join(dir, `${requestIdOf(4)}.json`), JSON.stringify({ version: 1, at: 1, vectors: { [`1:${HASH(1)}`]: [['1', '2']] } }));
    writeFileSync(path.join(dir, 'notes.txt'), 'hello');
    expect(new PartialVectorStore(31337n, MANAGER, dir).size).toBe(0);
  });

  it('evicts the least recently written request beyond its cap', () => {
    const dir = tmp();
    let t = 0;
    const s = new PartialVectorStore(31337n, MANAGER, dir, { maxRequests: 2, now: () => ++t });
    for (const r of [1, 2, 3]) s.put(requestIdOf(r), 1, HASH(r), vector(BigInt(r)));
    expect(s.has(requestIdOf(1), 1, HASH(1))).toBe(false);
    expect(readdirSync(dir).sort()).toEqual([`${requestIdOf(2)}.json`, `${requestIdOf(3)}.json`]);
    const file = JSON.parse(readFileSync(path.join(dir, `${requestIdOf(3)}.json`), 'utf8')) as { vectors: Record<string, unknown> };
    expect(Object.keys(file.vectors)).toEqual([`1:${HASH(3)}`]);
  });
});

describe('ChainPartialSource: the single-block log read (protocol §10.4)', () => {
  function published() {
    const chain = new MockChain();
    const cid = ceremonyIdOf(1);
    const rid = requestIdOf(1);
    chain.addCeremony(cid, { phase: 3, threshold: 2, n: 3 });
    const key = testKey(2, 3);
    const { cts, c1s } = encryptAll(key.P, [4n, 5n]);
    chain.addRequest(rid, cid, cts);
    chain.addRequest(requestIdOf(2), cid, cts);
    for (const i of [1, 2]) chain.addPartial(rid, i, partialOf(key.shares.get(i) as bigint, c1s));
    chain.addPartial(requestIdOf(2), 3, partialOf(key.shares.get(3) as bigint, c1s));
    const state = new ChainState(chain.client, MANAGER);
    return { chain, cid, rid, key, c1s, source: new ChainPartialSource(chain.client, state) };
  }

  it('reads one block and returns exactly that member’s vector of that request', async () => {
    const { chain, rid, key, c1s, source } = published();
    const block = chain.manager.requests.get(rid)?.published.get(2) as bigint;
    expect(await source.fetchPublishedVector(rid, 2, block)).toEqual(pad(partialOf(key.shares.get(2) as bigint, c1s)));
    expect(await source.fetchPublishedVector(rid, 1, block)).toBeUndefined(); // member 1 published elsewhere
    expect(await source.fetchPublishedVector(rid, 2, 0n)).toBeUndefined();
  });

  it('a refused or lagging read is "not there" for the combiner, and keeps the refusal for the policy', async () => {
    const { chain, rid, source } = published();
    const block = chain.manager.requests.get(rid)?.published.get(1) as bigint;
    chain.failRequests = (m) => (m === 'eth_getLogs' ? rpcError(-32000, 'missing trie node') : undefined);
    expect(await source.fetchPublishedVector(rid, 1, block)).toBeUndefined();
    expect((await source.fetch(rid, 1, block)).error).toBeDefined();
    chain.failRequests = undefined;
    chain.logsHeadLag = 10n;
    expect(await source.fetchPublishedVector(rid, 1, block)).toBeUndefined();
    chain.logsHeadLag = 0n;
    expect(await source.fetch(rid, 1, block)).toMatchObject({ vector: expect.any(Array) });
  });

  it('feeds the SDK sourcing, which authenticates every vector against the stored hash', async () => {
    const { chain, cid, rid, key, c1s, source } = published();
    const store = new PartialVectorStore(31337n, MANAGER);
    const res = await sourcePartialVectors({
      chainId: 31337n,
      manager: MANAGER,
      ceremonyId: cid,
      requestId: rid,
      fieldCount: 2,
      memberSet: [1, 2],
      source,
      cache: store.cache,
    });
    expect(res.missing).toEqual([]);
    expect(res.vectors.get(1)).toEqual(pad(partialOf(key.shares.get(1) as bigint, c1s)));
    expect(store.has(rid, 1, chain.manager.requests.get(rid)?.hashes.get(1) as Hex)).toBe(true);
  });
});
