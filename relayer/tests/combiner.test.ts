import { afterEach, describe, expect, it, vi } from 'vitest';
import { COUNCIL_MANAGER_ABI, encodeAction, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { decodeFunctionData, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { Combiner } from '../src/combiner.js';
import { InlineDlogSolver, type DlogSolver } from '../src/dlog.js';
import type { Logger } from '../src/log.js';
import { TxSender } from '../src/sender.js';
import {
  ceremonyIdOf,
  encryptAll,
  MANAGER,
  MockChain,
  partialOf,
  requestIdOf,
  rpcError,
  testKey,
  type TestKey,
} from './mockchain.js';
import { stack } from './stack.js';

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

function setup(opts: { automine?: boolean; bound?: bigint; solver?: DlogSolver; budgetWei?: bigint; log?: Logger } = {}) {
  const s = stack({ automine: opts.automine, budgetWei: opts.budgetWei });
  const combiner = new Combiner({
    client: s.chain.client,
    manager: MANAGER,
    sponsor: s.sponsor,
    sender: s.sender,
    solver: opts.solver ?? new InlineDlogSolver(BABY_STEPS, opts.bound ?? TEST_BOUND),
    startBlock: 0n,
    logRange: 2n, // force chunked log scanning
    backoffMs: 1000,
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
    request(chain, key, 3, 3, [5n, 6n, 7n, 8n, 9n, 10n], [1, 3]);
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
        encodeAction({ kind: 'combine', requestId: requestIdOf(3), memberSet: [1, 3], fieldIndexes: [field], plaintexts: [m] }),
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
    let failed = false;
    s.chain.request = async (method, params) => {
      // The first getCeremony of ceremony 14 fails like a dropped connection.
      if (!failed && method === 'eth_call' && JSON.stringify(params).includes(ceremonyIdOf(14).slice(2))) {
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

  it('keeps the chunks a failed pass already scanned', async () => {
    const { chain, combiner } = setup();
    const key = ceremony(chain, 21, 2, 2);
    request(chain, key, 21, 21, [4n], [1, 2]); // an early block
    chain.blockNumber += 200n;
    let logCalls = 0;
    // Rate limited after 60 chunks of 2 blocks (block 120 of about 200).
    chain.failRequests = (method) => (method === 'eth_getLogs' && ++logCalls > 60 ? rpcError(-32005, 'rate limited') : undefined);
    await expect(combiner.tick()).rejects.toThrow();
    // The request in the scanned chunks was found, and the next pass resumes near the failure.
    expect(combiner.watching).toEqual([requestIdOf(21)]);
    logCalls = 0;
    chain.failRequests = (method) => {
      if (method === 'eth_getLogs') logCalls++;
      return undefined;
    };
    await combiner.tick();
    // From block 120 - 64: about 75 chunks, not the 100 of the whole range again.
    expect(logCalls).toBeLessThan(80);
    expect(chain.manager.requests.get(requestIdOf(21))?.plaintexts).toEqual([4n]);
  });

  it('backs off between failed passes, logging transient rpc errors at info until they persist', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const logs = capture();
    const { chain, combiner } = setup({ log: logs.log });
    let heads = 0;
    let down = true;
    chain.failRequests = (method) => {
      if (method !== 'eth_blockNumber') return undefined;
      heads++;
      return down ? rpcError(-32005, 'rate limit exceeded') : undefined;
    };
    combiner.start(1000);
    await vi.advanceTimersByTimeAsync(0);
    expect(heads).toBe(1);
    // 1 s, 2 s, 4 s, 8 s between the failed passes: four more by t = 15 s, not fifteen.
    await vi.advanceTimersByTimeAsync(15_000);
    expect(heads).toBe(5);
    const failures = logs.entries.filter((e) => /combiner/.test(e.msg));
    expect(failures.map((e) => e.level)).toEqual(['info', 'info', 'info', 'info', 'warn']);
    expect(failures[0]?.msg).toBe('combiner pass deferred: transient rpc error');
    expect(failures[0]?.fields).toMatchObject({ err: 'rate limit exceeded', failures: 1, retryInMs: 1000 });
    expect(failures[4]?.msg).toBe('combiner tick failed');

    down = false;
    await vi.advanceTimersByTimeAsync(16_000); // the sixth pass succeeds
    expect(logs.entries.at(-1)?.msg).toBe('combiner recovered');
    const before = heads;
    await vi.advanceTimersByTimeAsync(3_000); // back to the 1 s poll
    expect(heads - before).toBe(3);
    combiner.stop();
  });

  it('warns at once on an error that is not transient', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const logs = capture();
    const { chain, combiner } = setup({ log: logs.log });
    chain.failRequests = (method) =>
      method === 'eth_blockNumber' ? rpcError(-32601, 'the method eth_blockNumber does not exist/is not available') : undefined;
    combiner.start(1000);
    await vi.advanceTimersByTimeAsync(0);
    combiner.stop();
    expect(logs.entries.map((e) => [e.level, e.msg])).toEqual([['warn', 'combiner tick failed']]);
  });
});
