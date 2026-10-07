import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { compressPoint, COUNCIL_MANAGER_ABI, encodeAction, type Hex, type Point } from '@vocdoni/davinci-dkg-council-sdk';
import { decodeFunctionData, encodeFunctionData, parseTransaction, toFunctionSelector, type AbiFunction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Combiner } from '../src/combiner.js';
import { InlineDlogSolver, type DlogSolver } from '../src/dlog.js';
import type { Logger } from '../src/log.js';
import { PartialVectorStore } from '../src/partials.js';
import { TxSender } from '../src/sender.js';
import { StateStore } from '../src/state.js';
import {
  ceremonyIdOf,
  encryptAll,
  MANAGER,
  MockChain,
  pad,
  partialOf,
  requestIdOf,
  rpcError,
  testKey,
  type TestKey,
} from './mockchain.js';
import { stack, type StackOptions } from './stack.js';

/** A small BSGS table keeps the tests fast; plaintexts stay below 2^24 here. */
const BABY_STEPS = 1 << 12;
const TEST_BOUND = 1n << 24n;

function capture() {
  const entries: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const log: Logger = {
    info: (msg, fields) => entries.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => entries.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => entries.push({ level: 'error', msg, fields }),
  };
  return { log, entries, loud: () => entries.filter((e) => e.level !== 'info') };
}

function setup(
  opts: {
    automine?: boolean;
    bound?: bigint;
    solver?: DlogSolver;
    budgetWei?: bigint;
    log?: Logger;
    stack?: StackOptions;
    store?: StateStore;
  } = {},
) {
  const s = stack({ automine: opts.automine, budgetWei: opts.budgetWei, store: opts.store, ...opts.stack });
  const combiner = new Combiner({
    client: s.chain.client,
    chainId: s.chain.chainId,
    manager: MANAGER,
    sponsor: s.sponsor,
    sender: s.sender,
    solver: opts.solver ?? new InlineDlogSolver(BABY_STEPS, opts.bound ?? TEST_BOUND),
    startBlock: 0n,
    logRange: 2n, // force chunked log scanning
    chain: s.policy.chain,
    partials: s.policy.partials,
    backoffMs: 1000,
    store: s.store,
    log: opts.log,
    now: () => s.clock.t,
  });
  return { ...s, combiner };
}

function ceremony(chain: MockChain, id: number, t: number, n: number): TestKey {
  chain.addCeremony(ceremonyIdOf(id), { phase: 3, threshold: t, n });
  return testKey(t, n);
}

function request(chain: MockChain, key: TestKey, cid: number, rid: number, plaintexts: bigint[], members: number[]) {
  const { cts, c1s } = encryptAll(key.P, plaintexts);
  chain.addRequest(requestIdOf(rid), ceremonyIdOf(cid), cts);
  for (const i of members) chain.addPartial(requestIdOf(rid), i, partialOf(key.shares.get(i) as bigint, c1s));
  return c1s;
}

const combineCalls = (chain: MockChain) =>
  chain.sentRaw
    .map((raw) => decodeFunctionData({ abi: COUNCIL_MANAGER_ABI, data: parseTransaction(raw).data as Hex }))
    .filter((d) => d.functionName === 'combine')
    .map((d) => d.args as unknown as [Hex, number[], number[], bigint[]]);

describe('combine worker', () => {
  it('waits for t partials, then combines every field with the t lowest members in chunks of 4', async () => {
    const { chain, combiner } = setup();
    const key = ceremony(chain, 1, 3, 5);
    const values = [0n, 1n, 42n, 1000n, 65_535n, (1n << 24n) - 1n];
    const c1s = request(chain, key, 1, 1, values, [5, 2]);
    await combiner.tick();
    expect(combineCalls(chain)).toHaveLength(0);
    expect(combiner.watching).toEqual([requestIdOf(1)]);

    chain.addPartial(requestIdOf(1), 4, partialOf(key.shares.get(4) as bigint, c1s));
    chain.addPartial(requestIdOf(1), 3, partialOf(key.shares.get(3) as bigint, c1s));
    await combiner.tick();

    const calls = combineCalls(chain);
    expect(calls.map((c) => c[2])).toEqual([[0, 1, 2, 3], [4, 5]]);
    for (const c of calls) expect(c[1]).toEqual([2, 3, 4]);
    const req = chain.manager.requests.get(requestIdOf(1));
    expect(req?.plaintexts).toEqual(values);
    expect(req?.completed).toBe(0b111111);

    await combiner.tick();
    expect(combiner.watching).toEqual([]);
  });

  it('uses fieldsPerTx = 2 at t = 16', async () => {
    const { chain, combiner } = setup();
    const key = ceremony(chain, 2, 16, 16);
    const members = Array.from({ length: 16 }, (_, i) => i + 1);
    request(chain, key, 2, 2, [7n, 8n, 9n, 10n, 11n], members);
    await combiner.tick();
    expect(combineCalls(chain).map((c) => c[2])).toEqual([[0, 1], [2, 3], [4]]);
    expect(chain.manager.requests.get(requestIdOf(2))?.plaintexts).toEqual([7n, 8n, 9n, 10n, 11n]);
  });

  it('survives losing a race to another combiner (FieldCompleted) and finishes the rest', async () => {
    const { chain, combiner } = setup();
    const key = ceremony(chain, 3, 2, 3);
    const c1s = request(chain, key, 3, 3, [5n, 6n, 7n, 8n, 9n, 10n], [1, 3]);
    const vectors = [1, 3].map((i) => pad(partialOf(key.shares.get(i) as bigint, c1s)));
    const c2 = (k: number): Point => {
      const row = chain.manager.requests.get(requestIdOf(3))?.cts[k] as bigint[];
      return { x: row[2] as bigint, y: row[3] as bigint };
    };
    // Another combiner completes field 0 and field 5 before us.
    const other = new TxSender({
      client: chain.client,
      account: privateKeyToAccount(`0x${'59'.repeat(32)}`),
      chainId: chain.chainId,
      maxFeeWei: 10n ** 11n,
      bumpAfterMs: 60_000,
    });
    for (const [field, m] of [
      [0, 5n],
      [5, 10n],
    ] as const) {
      await other.send(
        MANAGER,
        encodeAction({
          kind: 'combine',
          requestId: requestIdOf(3),
          memberSet: [1, 3],
          fieldIndexes: [field],
          plaintexts: [m],
          partialVectors: vectors,
          C2: [c2(field)],
        }),
      );
    }
    await combiner.tick();
    expect(combineCalls(chain).at(-1)?.[2]).toEqual([1, 2, 3, 4]);
    expect(chain.manager.requests.get(requestIdOf(3))?.completed).toBe(0b111111);
  });

  it('re-reads after a race lost in simulation and resumes on the next pass', async () => {
    const { chain, combiner } = setup();
    const key = ceremony(chain, 4, 2, 2);
    request(chain, key, 4, 4, [1n, 2n], [1, 2]);
    chain.manager.forced.set('combine', 'FieldCompleted');
    await combiner.tick();
    expect(combineCalls(chain)).toHaveLength(0);
    chain.manager.forced.delete('combine');
    await combiner.tick(); // no backoff for a lost race
    expect(chain.manager.requests.get(requestIdOf(4))?.plaintexts).toEqual([1n, 2n]);
  });

  it('backs off after other failures', async () => {
    const { chain, combiner, advance } = setup();
    const key = ceremony(chain, 5, 2, 2);
    request(chain, key, 5, 5, [3n], [1, 2]);
    chain.manager.forced.set('combine', 'CombineCheckFailed');
    await combiner.tick();
    chain.manager.forced.delete('combine');
    await combiner.tick(); // still backing off
    expect(chain.manager.requests.get(requestIdOf(5))?.completed).toBe(0);
    advance(1000);
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(5))?.plaintexts).toEqual([3n]);
  });

  it('completes the solvable fields when one field has no plaintext below the bound', async () => {
    const { chain, combiner } = setup({ bound: 1n << 16n });
    const key = ceremony(chain, 6, 2, 3);
    request(chain, key, 6, 6, [11n, 1n << 20n, 13n], [2, 3]);
    await combiner.tick();
    const req = chain.manager.requests.get(requestIdOf(6));
    expect(req?.completed).toBe(0b101);
    expect(req?.plaintexts).toEqual([11n, 0n, 13n]);
    await combiner.tick(); // the unsolvable field is not searched again
    expect(combineCalls(chain)).toHaveLength(1);
    expect(combiner.watching).toEqual([requestIdOf(6)]);
  });

  it('retries a field after an operational solver failure instead of giving it up', async () => {
    const inner = new InlineDlogSolver(BABY_STEPS, TEST_BOUND);
    let failures = 1;
    const flaky: DlogSolver = {
      solve: (M) => (failures-- > 0 ? Promise.reject(new Error('dlog worker exited with code 1')) : inner.solve(M)),
      close: () => inner.close(),
    };
    const { chain, combiner, advance } = setup({ solver: flaky });
    const key = ceremony(chain, 8, 2, 2);
    request(chain, key, 8, 8, [77n], [1, 2]);
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(8))?.completed).toBe(0);
    advance(1000);
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(8))?.plaintexts).toEqual([77n]);
  });

  it('finds a request that a reorg placed in an already-scanned block', async () => {
    const { chain, combiner } = setup();
    const key = ceremony(chain, 9, 2, 2);
    chain.blockNumber += 10n; // empty blocks
    await combiner.tick();
    const { cts, c1s } = encryptAll(key.P, [5n]);
    chain.addRequest(requestIdOf(9), ceremonyIdOf(9), cts, chain.blockNumber - 3n);
    for (const i of [1, 2]) chain.addPartial(requestIdOf(9), i, partialOf(key.shares.get(i) as bigint, c1s));
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(9))?.plaintexts).toEqual([5n]);
  });

  it('never treats a request with no fields as complete', async () => {
    const { chain, combiner, advance } = setup();
    const key = ceremony(chain, 10, 2, 2);
    // A RequestSubmitted log whose request is (no longer) at the head: bound, fieldCount 0.
    chain.manager.bound.set(requestIdOf(10), ceremonyIdOf(10));
    chain.addRequest(requestIdOf(10), ceremonyIdOf(10), [], chain.blockNumber);
    chain.manager.requests.delete(requestIdOf(10));
    await combiner.tick();
    expect(combiner.watching).toEqual([requestIdOf(10)]);
    // The request lands again (re-org back in): it is still watched and gets combined.
    request(chain, key, 10, 10, [31n], [1, 2]);
    advance(1000);
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(10))?.plaintexts).toEqual([31n]);
  });

  it('forgets a request only once it is complete at the finalized block; a rollback brings the work back', async () => {
    const { chain, combiner, sender } = setup();
    const key = ceremony(chain, 11, 2, 2);
    request(chain, key, 11, 11, [41n, 42n], [1, 2]);
    chain.holdFinalized(); // finalized: request open, partials in
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(11))?.completed).toBe(0b11);
    await sender.tick();
    await combiner.tick();
    expect(combiner.watching).toEqual([requestIdOf(11)]); // complete at the head only

    chain.rollback(); // the combine is reorged out
    expect(chain.manager.requests.get(requestIdOf(11))?.completed).toBe(0);
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(11))?.plaintexts).toEqual([41n, 42n]);
    expect(combineCalls(chain)).toHaveLength(2);

    chain.releaseFinalized(); // finalized catches up
    await combiner.tick();
    expect(combiner.watching).toEqual([]);
  });

  it('restricted mode: checks admission before any BSGS work, and retries a failed check', async () => {
    let solves = 0;
    const inner = new InlineDlogSolver(BABY_STEPS, TEST_BOUND);
    const counting: DlogSolver = { solve: (M) => (solves++, inner.solve(M)), close: () => inner.close() };
    const s = stack({ policy: { organizerAllowlist: ['0x00000000000000000000000000000000000000a1'] } });
    const combiner = new Combiner({
      client: s.chain.client,
      chainId: s.chain.chainId,
      manager: MANAGER,
      sponsor: s.sponsor,
      sender: s.sender,
      solver: counting,
      startBlock: 0n,
      logRange: 100n,
      backoffMs: 1000,
      now: () => s.clock.t,
    });
    // Not sponsored: an outsider's request with out-of-range plaintexts costs no search.
    s.chain.addCeremony(ceremonyIdOf(13), { phase: 3, threshold: 2, n: 2, organizer: '0x00000000000000000000000000000000000000b2' });
    request(s.chain, testKey(2, 2), 13, 13, [1n << 30n, 1n << 31n], [1, 2]);
    // Sponsored (allow-listed organizer), but the first admission read fails in transit.
    s.chain.addCeremony(ceremonyIdOf(14), { phase: 3, threshold: 2, n: 2, organizer: '0x00000000000000000000000000000000000000a1' });
    const key = testKey(2, 2);
    request(s.chain, key, 14, 14, [8n], [1, 2]);

    const getCeremony = s.chain.request.bind(s.chain);
    const admission = encodeFunctionData({ abi: COUNCIL_MANAGER_ABI, functionName: 'getCeremony', args: [ceremonyIdOf(14)] });
    let failed = false;
    s.chain.request = async (method, params) => {
      // The first getCeremony of ceremony 14 fails like a dropped connection.
      if (!failed && method === 'eth_call' && (params[0] as { data?: Hex }).data === admission) {
        failed = true;
        throw new Error('fetch failed: socket hang up');
      }
      return getCeremony(method, params);
    };
    await combiner.tick();
    expect(solves).toBe(0);
    expect(combiner.watching).toEqual([requestIdOf(14)]); // 13 forgotten as not ours; 14 backing off
    s.advance(1000);
    await combiner.tick();
    expect(s.chain.manager.requests.get(requestIdOf(14))?.plaintexts).toEqual([8n]);
    expect(solves).toBe(1);
  });

  it('spends from the same global budget as relayed actions', async () => {
    const { chain, combiner, advance } = setup({ budgetWei: 1n });
    const key = ceremony(chain, 12, 2, 2);
    request(chain, key, 12, 12, [5n], [1, 2]);
    await combiner.tick();
    expect(combineCalls(chain)).toHaveLength(0);
    expect(combiner.watching).toEqual([requestIdOf(12)]);
    advance(1000);
    await combiner.tick();
    expect(combineCalls(chain)).toHaveLength(0);
  });

  it('does not resubmit fields whose combine is still pending', async () => {
    const { chain, combiner } = setup({ automine: false });
    const key = ceremony(chain, 7, 2, 2);
    request(chain, key, 7, 7, [21n, 22n], [1, 2]);
    await combiner.tick();
    await combiner.tick();
    expect(combineCalls(chain)).toHaveLength(1);
    chain.mine();
    await combiner.tick();
    await combiner.tick();
    expect(combineCalls(chain)).toHaveLength(1);
    expect(chain.manager.requests.get(requestIdOf(7))?.plaintexts).toEqual([21n, 22n]);
    expect(combiner.watching).toEqual([]);
  });
});

describe('combine worker on public RPCs (Railway: "combiner tick failed" every few minutes)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('a log backend behind the head ends the pass quietly, and the next pass finds the request', async () => {
    const logs = capture();
    const { chain, combiner } = setup({ log: logs.log });
    const key = ceremony(chain, 20, 2, 2);
    chain.blockNumber += 6n;
    request(chain, key, 20, 20, [9n], [1, 2]); // the request and its two partials: the last three blocks
    // The eth_getLogs backend is three blocks behind the eth_blockNumber one: a range up to the
    // head is refused with -32602, like publicnode and Tenderly do.
    chain.logsHeadLag = 3n;
    await expect(combiner.tick()).resolves.toBeUndefined();
    expect(combiner.watching).toEqual([]);
    chain.logsHeadLag = 0n;
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(20))?.plaintexts).toEqual([9n]);
    expect(logs.loud()).toEqual([]);
  });

  it('halves its log range when the rpc caps eth_getLogs below it, and keeps the smaller range', async () => {
    const logs = capture();
    const s = stack({});
    const combiner = new Combiner({
      client: s.chain.client,
      chainId: s.chain.chainId,
      manager: MANAGER,
      sponsor: s.sponsor,
      sender: s.sender,
      solver: new InlineDlogSolver(BABY_STEPS, TEST_BOUND),
      startBlock: 0n,
      logRange: 16n,
      log: logs.log,
      now: () => s.clock.t,
    });
    const key = ceremony(s.chain, 22, 2, 2);
    s.chain.blockNumber += 40n;
    request(s.chain, key, 22, 22, [6n], [1, 2]);
    s.chain.maxLogRange = 5n; // a provider capped below the configured range
    await combiner.tick();
    expect(s.chain.manager.requests.get(requestIdOf(22))?.plaintexts).toEqual([6n]);
    expect(logs.loud()).toEqual([]);
  });

  it('keeps the chunks a failed pass already scanned', async () => {
    const { chain, combiner, advance } = setup();
    const key = ceremony(chain, 21, 2, 2);
    request(chain, key, 21, 21, [4n], [1, 2]); // an early block
    chain.blockNumber += 200n;
    let logCalls = 0;
    // Rate limited after 60 chunks of 2 blocks (block 120 of about 200).
    chain.failRequests = (method) => (method === 'eth_getLogs' && ++logCalls > 60 ? rpcError(-32005, 'rate limited') : undefined);
    await combiner.tick(); // discovery fails part way; the pass itself does not
    // The request in the scanned chunks was found, and the next scan resumes near the failure.
    expect(combiner.watching).toEqual([requestIdOf(21)]);
    logCalls = 0;
    chain.failRequests = (method) => {
      if (method === 'eth_getLogs') logCalls++;
      return undefined;
    };
    advance(1000); // past the discovery backoff
    await combiner.tick();
    // From block 120 - 64: about 75 chunks, not the 100 of the whole range again.
    expect(logCalls).toBeLessThan(80);
    expect(chain.manager.requests.get(requestIdOf(21))?.plaintexts).toEqual([4n]);
  });

  it('backs off request discovery on its own, logging transient rpc errors at info until they persist', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    const logs = capture();
    const s = stack({});
    const combiner = new Combiner({
      client: s.chain.client,
      chainId: s.chain.chainId,
      manager: MANAGER,
      sponsor: s.sponsor,
      sender: s.sender,
      solver: new InlineDlogSolver(BABY_STEPS, TEST_BOUND),
      startBlock: 0n,
      logRange: 2n,
      backoffMs: 1000,
      log: logs.log,
    });
    let heads = 0;
    let down = true;
    s.chain.failRequests = (method) => {
      if (method !== 'eth_blockNumber') return undefined;
      heads++;
      return down ? rpcError(-32005, 'rate limit exceeded') : undefined;
    };
    combiner.start(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(heads).toBe(1);
    // 1 s, 2 s, 4 s, 8 s between the failed scans: four more by t = 15 s, not fifteen.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(heads).toBe(5);
    const failures = logs.entries.filter((e) => /discovery/.test(e.msg));
    expect(failures.map((e) => e.level)).toEqual(['info', 'info', 'info', 'info', 'warn']);
    expect(failures[0]?.msg).toBe('request discovery deferred: transient rpc error');
    expect(failures[0]?.fields).toMatchObject({ err: 'rate limit exceeded', failures: 1, retryInMs: 1000 });
    expect(failures[4]?.msg).toBe('request discovery failed');
    // The passes themselves never failed: known requests kept being served every second.
    expect(combiner.status()).toMatchObject({ failures: 0, discovery: { failures: 5 } });

    down = false;
    await vi.advanceTimersByTimeAsync(17_000); // the sixth scan succeeds
    expect(logs.entries.at(-1)?.msg).toBe('request discovery recovered');
    const before = heads;
    await vi.advanceTimersByTimeAsync(3_000); // back to every pass
    expect(heads - before).toBe(3);
    combiner.stop();
  });

  it('warns at once on a discovery error that is not transient', async () => {
    const logs = capture();
    const { chain, combiner } = setup({ log: logs.log });
    chain.failRequests = (method) =>
      method === 'eth_blockNumber' ? rpcError(-32601, 'the method eth_blockNumber does not exist/is not available') : undefined;
    await combiner.tick();
    expect(logs.entries.map((e) => [e.level, e.msg])).toEqual([['warn', 'request discovery failed']]);
  });
});

describe('combine worker v2: partial-data sourcing and the decryption gate (protocol §10.3–§10.4, §8.7)', () => {
  /** eth_getLogs calls for PartialDataPublished at one block (the §10.4 single-block read). */
  function spyLogs(chain: MockChain) {
    const reads: { from: bigint; to: bigint }[] = [];
    const orig = chain.request.bind(chain);
    chain.request = async (method, params) => {
      if (method === 'eth_getLogs') {
        const f = params[0] as { fromBlock: Hex; toBlock: Hex; topics?: unknown[] };
        if (f.topics?.[1] !== undefined) reads.push({ from: BigInt(f.fromBlock), to: BigInt(f.toBlock) });
      }
      return orig(method, params);
    };
    return reads;
  }

  it('re-supplies t padded vectors (from the single-block log, then its cache) and C2 from state', async () => {
    const { chain, combiner } = setup();
    const key = ceremony(chain, 30, 2, 3);
    const c1s = request(chain, key, 30, 30, [12n, 13n, 14n], [2, 3]);
    const req = chain.manager.requests.get(requestIdOf(30));
    const reads = spyLogs(chain);
    await combiner.tick();
    // One getLogs per member, each at exactly its stored publication block.
    expect(reads).toEqual([2, 3].map((i) => ({ from: req?.published.get(i), to: req?.published.get(i) })));
    const [call] = chain.sentRaw.map((raw) => decodeFunctionData({ abi: COUNCIL_MANAGER_ABI, data: parseTransaction(raw).data as Hex }));
    const [, memberSet, fields, , vectors, c2] = call?.args as unknown as [Hex, number[], number[], bigint[], bigint[][][], bigint[][]];
    expect(memberSet).toEqual([2, 3]);
    expect(vectors).toEqual([2, 3].map((i) => pad(partialOf(key.shares.get(i) as bigint, c1s)).map((p) => [p.x, p.y])));
    expect(c2).toEqual(fields.map((k) => [req?.cts[k]?.[2], req?.cts[k]?.[3]]));
    expect(req?.plaintexts).toEqual([12n, 13n, 14n]);
  });

  it('keeps the vectors it read in its data directory, so a restarted worker needs no log', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'council-partials-'));
    const first = setup({ stack: { partials: (chainId) => new PartialVectorStore(chainId, MANAGER, dir) } });
    const key = ceremony(first.chain, 31, 2, 2);
    request(first.chain, key, 31, 31, [5n, 6n], [1, 2]);
    first.chain.manager.forced.set('combine', 'CombineCheckFailed'); // stop before completion
    await first.combiner.tick();
    expect(readdirSync(dir)).toEqual([`${requestIdOf(31)}.json`]);
    first.chain.manager.forced.delete('combine');
    first.chain.dropPublishedLogs(); // months later: the provider no longer serves those blocks

    const second = setup({ stack: { chain: first.chain, partials: (chainId) => new PartialVectorStore(chainId, MANAGER, dir) } });
    const reads = spyLogs(second.chain);
    await second.combiner.tick();
    expect(reads).toEqual([]);
    expect(second.chain.manager.requests.get(requestIdOf(31))?.plaintexts).toEqual([5n, 6n]);
    await second.combiner.tick(); // complete at the finalized block: forgotten, its file removed
    expect(second.combiner.watching).toEqual([]);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('never uses a cached vector that does not hash to the stored commitment', async () => {
    const { chain, combiner, policy } = setup();
    const key = ceremony(chain, 32, 2, 2);
    request(chain, key, 32, 32, [9n], [1, 2]);
    const req = chain.manager.requests.get(requestIdOf(32));
    // A corrupted cache entry under member 1's key: ignored, the log supplies the real one.
    policy.partials.put(requestIdOf(32), 1, req?.hashes.get(1) as Hex, pad([{ x: 0n, y: 1n }]));
    await combiner.tick();
    expect(req?.plaintexts).toEqual([9n]);
  });

  it('waits for re-publication when no copy of a vector is left, then combines', async () => {
    const logs = capture();
    const { chain, combiner, advance } = setup({ log: logs.log });
    const key = ceremony(chain, 33, 2, 2);
    const c1s = request(chain, key, 33, 33, [21n], [1, 2]);
    chain.dropPublishedLogs();
    await combiner.tick();
    expect(combineCalls(chain)).toHaveLength(0);
    expect(logs.entries.at(-1)).toMatchObject({ level: 'info', msg: 'combine waiting for partial data re-publication' });
    expect(String(logs.entries.at(-1)?.fields?.err)).toMatch(/members 1, 2/);
    // Both members return (months later, from their words) and re-publish D = s_i·C1 directly.
    const member = new TxSender({
      client: chain.client,
      account: privateKeyToAccount(`0x${'59'.repeat(32)}`),
      chainId: chain.chainId,
      maxFeeWei: 10n ** 11n,
      bumpAfterMs: 60_000,
    });
    for (const i of [1, 2]) {
      const D = pad(partialOf(key.shares.get(i) as bigint, c1s));
      await member.send(MANAGER, encodeAction({ kind: 'publishPartialData', requestId: requestIdOf(33), participantIndex: i, D }));
    }
    advance(1000);
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(33))?.plaintexts).toEqual([21n]);
    expect(logs.loud()).toEqual([]);
  });

  it('combines with the t lowest members whose vectors it can source', async () => {
    const { chain, combiner } = setup();
    const key = ceremony(chain, 34, 2, 4);
    const c1s = request(chain, key, 34, 34, [3n], [1]);
    chain.dropPublishedLogs(); // member 1's vector is gone
    for (const i of [2, 3, 4]) chain.addPartial(requestIdOf(34), i, partialOf(key.shares.get(i) as bigint, c1s));
    await combiner.tick();
    expect(combineCalls(chain).map((c) => c[1])).toEqual([[2, 3]]);
    expect(chain.manager.requests.get(requestIdOf(34))?.plaintexts).toEqual([3n]);
  });

  it('parks a request while its decryption gate is closed: no search, no transaction', async () => {
    let solves = 0;
    const inner = new InlineDlogSolver(BABY_STEPS, TEST_BOUND);
    const { chain, combiner } = setup({ solver: { solve: (M) => (solves++, inner.solve(M)), close: () => inner.close() } });
    const key = ceremony(chain, 35, 2, 2);
    request(chain, key, 35, 35, [17n], [1, 2]);
    // A reorg (say) leaves accepted partials behind a gate that is closed again at the head.
    const c = chain.manager.ceremonies.get(ceremonyIdOf(35));
    if (c) c.decryptionOpenAt = chain.now + 3600n;
    await combiner.tick();
    await combiner.tick();
    expect(solves).toBe(0);
    expect(chain.sentRaw).toHaveLength(0);
    expect(combiner.watching).toEqual([requestIdOf(35)]);
    chain.setTime(chain.now + 3600n);
    await combiner.tick(); // parked work is not backed off: the next pass after opening combines
    expect(chain.manager.requests.get(requestIdOf(35))?.plaintexts).toEqual([17n]);
  });

  it('wake() retries a backed-off request of a ceremony at once', async () => {
    const { chain, combiner } = setup();
    const key = ceremony(chain, 36, 2, 2);
    request(chain, key, 36, 36, [2n], [1, 2]);
    chain.manager.forced.set('combine', 'CombineCheckFailed');
    await combiner.tick();
    chain.manager.forced.delete('combine');
    await combiner.tick(); // backing off
    expect(chain.manager.requests.get(requestIdOf(36))?.completed).toBe(0);
    combiner.wake(ceremonyIdOf(36));
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(36))?.plaintexts).toEqual([2n]);
  });
});

describe('combine worker without logs (audit M-02: request ids from contract state)', () => {
  /** eth_call count of one view function while `fn` runs. */
  async function calls(chain: MockChain, fn: string, run: () => Promise<unknown>): Promise<number> {
    const item = COUNCIL_MANAGER_ABI.find((x) => x.type === 'function' && x.name === fn) as AbiFunction;
    const selector = toFunctionSelector(item);
    let n = 0;
    const orig = chain.request.bind(chain);
    chain.request = async (method, params) => {
      if (method === 'eth_call' && (params[0] as { data?: string }).data?.startsWith(selector)) n++;
      return orig(method, params);
    };
    try {
      await run();
    } finally {
      chain.request = orig;
    }
    return n;
  }

  it('keeps combining the requests it knows while log discovery fails', async () => {
    const logs = capture();
    const { chain, combiner } = setup({ log: logs.log });
    const key = ceremony(chain, 40, 2, 3);
    const c1s = request(chain, key, 40, 40, [12n, 13n], [1]); // one partial: not combinable yet
    await combiner.tick();
    expect(combiner.watching).toEqual([requestIdOf(40)]);
    // Discovery now fails on every pass (a provider that refuses the scan for good).
    chain.failRequests = (m) => (m === 'eth_blockNumber' ? rpcError(-32000, 'pruned history unavailable') : undefined);
    chain.addPartial(requestIdOf(40), 3, partialOf(key.shares.get(3) as bigint, c1s));
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(40))?.plaintexts).toEqual([12n, 13n]);
    expect(logs.entries.some((e) => e.msg === 'request discovery failed')).toBe(true);
  });

  it('finds the requests of a supplied ceremony from state alone, later ones at the next re-read of its count', async () => {
    const { chain, combiner, advance } = setup();
    chain.logsPrunedBelow = chain.blockNumber + 1n; // a scan from the start block is refused for good
    const key = ceremony(chain, 41, 2, 2);
    request(chain, key, 41, 41, [5n], [1, 2]);
    request(chain, key, 41, 42, [6n, 7n], [1, 2]);
    await combiner.tick();
    expect(combiner.watching).toEqual([]); // nothing known, nothing found
    combiner.track(ceremonyIdOf(41)); // the app or organizer registered it (POST /v1/track)
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(41))?.plaintexts).toEqual([5n]);
    expect(chain.manager.requests.get(requestIdOf(42))?.plaintexts).toEqual([6n, 7n]);
    // A later request of the same ceremony is found at the next re-read of its count.
    request(chain, key, 41, 43, [8n], [1, 2]);
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(43))?.completed).toBe(0); // within the minute
    advance(60_000);
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(43))?.plaintexts).toEqual([8n]);
  });

  it('a decryption gate the scheduler saw open enumerates the ceremony from state', async () => {
    const { chain, combiner } = setup();
    chain.logsPrunedBelow = chain.blockNumber + 1n;
    const key = ceremony(chain, 44, 2, 2);
    request(chain, key, 44, 44, [3n], [1, 2]);
    combiner.wake(ceremonyIdOf(44));
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(44))?.plaintexts).toEqual([3n]);
  });

  it('tracks ceremonies across a restart (state file), re-reading each count once a minute', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'council-combiner-')), 'state.json');
    const first = setup({ store: new StateStore(file) });
    first.chain.logsPrunedBelow = first.chain.blockNumber + 1n;
    const key = ceremony(first.chain, 1, 2, 2);
    request(first.chain, key, 1, 50, [9n], [1, 2]);
    first.combiner.track(ceremonyIdOf(1));
    await first.combiner.tick();
    expect(first.chain.manager.requests.get(requestIdOf(50))?.plaintexts).toEqual([9n]);
    first.store.flush();

    const second = setup({ store: new StateStore(file), stack: { chain: first.chain, clock: first.clock } });
    expect(second.combiner.tracking).toEqual([ceremonyIdOf(1)]);
    request(first.chain, key, 1, 51, [10n], [1, 2]);
    await second.combiner.tick();
    expect(first.chain.manager.requests.get(requestIdOf(51))?.plaintexts).toEqual([10n]);
    // Re-read once a minute (the head count and the finalized boundary), not on every pass; no
    // page below the finalized count is read again.
    expect(await calls(first.chain, 'getRequestCount', () => second.combiner.tick())).toBe(0);
    second.advance(60_000);
    expect(await calls(first.chain, 'getRequestCount', () => second.combiner.tick())).toBe(2);
    second.advance(60_000);
    expect(await calls(first.chain, 'getRequestIdsPage', () => second.combiner.tick())).toBe(0);
  });

  it('finds a request a reorg put at an offset it already read (same count, logs refused)', async () => {
    const { chain, combiner, advance } = setup();
    chain.logsPrunedBelow = chain.blockNumber + 1n;
    const key = ceremony(chain, 46, 2, 2);
    chain.holdFinalized(); // nothing of what follows is final
    chain.addRequest(requestIdOf(46), ceremonyIdOf(46), encryptAll(key.P, [1n]).cts);
    combiner.track(ceremonyIdOf(46));
    await combiner.tick();
    expect(combiner.watching).toEqual([requestIdOf(46)]);
    // A reorg replaces the binding at offset 0 with another request: the count stays 1.
    chain.manager.requests.delete(requestIdOf(46));
    request(chain, key, 46, 47, [2n], [1, 2]);
    advance(60_000);
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(47))?.plaintexts).toEqual([2n]);
  });

  it('steps over an interior block the provider keeps refusing, even when the chunks before it are served', async () => {
    const logs = capture();
    const { chain, combiner, advance } = setup({ log: logs.log }); // 2-block chunks, 64-block rewind
    chain.blockNumber += 300n;
    chain.logsRefusedAt = 250n;
    const key = ceremony(chain, 48, 2, 2);
    for (let i = 0; i < 4; i++) {
      await combiner.tick();
      advance(10_000);
    }
    expect(logs.entries.filter((e) => /skips blocks/.test(e.msg)).map((e) => e.fields?.fromBlock)).toEqual(['250']);
    request(chain, key, 48, 48, [7n], [1, 2]); // after the refused block
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(48))?.plaintexts).toEqual([7n]);
    // Later scans step over the skipped range instead of failing on it again.
    const failures = logs.entries.filter((e) => /discovery (failed|deferred)/.test(e.msg)).length;
    for (let i = 0; i < 3; i++) {
      advance(10_000);
      await combiner.tick();
    }
    expect(logs.entries.filter((e) => /discovery (failed|deferred)/.test(e.msg)).length).toBe(failures);
  });

  it('moves past a range the provider keeps refusing, so new requests are still found in its logs', async () => {
    const logs = capture();
    const { chain, combiner, advance } = setup({ log: logs.log });
    chain.blockNumber += 300n;
    chain.logsPrunedBelow = 200n; // blocks below 200 are gone from this provider
    const key = ceremony(chain, 45, 2, 2);
    for (let i = 0; i < 3; i++) {
      await combiner.tick();
      advance(10_000);
    }
    expect(logs.entries.some((e) => /skips blocks the rpc keeps refusing/.test(e.msg))).toBe(true);
    request(chain, key, 45, 45, [4n], [1, 2]); // a new request near the head
    advance(10_000);
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(45))?.plaintexts).toEqual([4n]);
    expect(combiner.tracking).toEqual([ceremonyIdOf(45)]); // its ceremony is tracked from now on
  });
});

describe('combine worker and malformed stored points (a corrupted rpc answer)', () => {
  it('refuses the request with a malformed C2 word without a search or a transaction, serves the others, and retries', async () => {
    let solves = 0;
    const inner = new InlineDlogSolver(BABY_STEPS, TEST_BOUND);
    const counting: DlogSolver = { solve: (M) => (solves++, inner.solve(M)), close: () => inner.close() };
    const logs = capture();
    const { chain, combiner, advance } = setup({ solver: counting, log: logs.log });
    const key = ceremony(chain, 60, 2, 2);
    request(chain, key, 60, 60, [11n], [1, 2]);
    request(chain, key, 60, 61, [12n], [1, 2]);
    const good = chain.manager.requests.get(requestIdOf(60))?.cts[0] as [bigint, bigint, bigint, bigint];
    // The rpc serves an odd-parity zero-root word (y = p) for request 60's C2.
    const zeroRootX = 18930368022820495955728484915491405972470733850014661777449844430438130630919n;
    chain.manager.wordOverride.request.set(requestIdOf(60), [
      [compressPoint({ x: good[0], y: good[1] }), zeroRootX | (1n << 255n)],
    ]);
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(61))?.plaintexts).toEqual([12n]);
    expect(chain.manager.requests.get(requestIdOf(60))?.completed).toBe(0);
    expect(solves).toBe(1); // request 61 only
    expect(combineCalls(chain).map((c) => c[0])).toEqual([requestIdOf(61)]);
    expect(logs.entries.find((e) => e.msg === 'combine refused a malformed stored point')?.fields?.err).toMatch(/zeroRootOddParity/);
    chain.manager.wordOverride.request.clear();
    advance(1000);
    await combiner.tick();
    expect(chain.manager.requests.get(requestIdOf(60))?.plaintexts).toEqual([11n]);
  });
});
