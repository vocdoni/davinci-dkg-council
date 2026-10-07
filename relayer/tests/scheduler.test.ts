import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { COUNCIL_MANAGER_ABI, type Action, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { decodeFunctionData, keccak256, parseTransaction } from 'viem';
import type { Logger } from '../src/log.js';
import { Scheduler } from '../src/scheduler.js';
import { StateStore } from '../src/state.js';
import { ceremonyIdOf, MANAGER, MEMBER_KEYS, rpcError, type FakeCeremony, type MockChain } from './mockchain.js';
import { stack, type StackOptions } from './stack.js';

const SIG: Hex = `0x${'11'.repeat(32)}${'22'.repeat(32)}1b`;
const ORG_A: Hex = '0x00000000000000000000000000000000000000a1';
const ORG_B: Hex = '0x00000000000000000000000000000000000000b2';
const HTTP = { source: 'http' } as const;

function capture() {
  const entries: { level: string; msg: string; fields?: Record<string, unknown> }[] = [];
  const log: Logger = {
    info: (msg, fields) => entries.push({ level: 'info', msg, fields }),
    warn: (msg, fields) => entries.push({ level: 'warn', msg, fields }),
    error: (msg, fields) => entries.push({ level: 'error', msg, fields }),
  };
  return { log, entries };
}

function setup(opts: StackOptions & { log?: Logger } = {}) {
  const s = stack(opts);
  const woken: Hex[] = [];
  const scheduler = new Scheduler({
    client: s.chain.client,
    manager: MANAGER,
    sponsor: s.sponsor,
    sender: s.sender,
    store: s.store,
    chain: s.policy.chain,
    onDecryptionOpen: (cid) => woken.push(cid),
    backoffMs: 1000,
    log: opts.log,
    now: () => s.clock.t,
  });
  return { ...s, scheduler, woken };
}

/** Register and watch a ceremony. */
function watched(s: ReturnType<typeof setup>, n: number, c: FakeCeremony): Hex {
  const cid = ceremonyIdOf(n);
  s.chain.addCeremony(cid, c);
  s.scheduler.watch(cid);
  return cid;
}

const sent = (chain: MockChain) =>
  chain.sentRaw.map((raw) => decodeFunctionData({ abi: COUNCIL_MANAGER_ABI, data: parseTransaction(raw).data as Hex }));

/** View calls (eth_call) made while `fn` runs. */
async function viewCalls(chain: MockChain, fn: () => Promise<unknown>): Promise<number> {
  let calls = 0;
  const orig = chain.request.bind(chain);
  chain.request = async (method, params) => {
    if (method === 'eth_call') calls++;
    return orig(method, params);
  };
  try {
    await fn();
  } finally {
    chain.request = orig;
  }
  return calls;
}

/** Hold the finalized block where it is and move the head `seconds` ahead (a finality lag). */
function lag(chain: MockChain, seconds: bigint): void {
  chain.holdFinalized();
  chain.blockNumber += seconds;
}

const registration = (deadline: bigint, joined: number, mode = 1): FakeCeremony => ({
  phase: 1,
  threshold: 2,
  n: 0,
  joined,
  qual: 0,
  registrationMode: mode,
  registrationDeadline: deadline,
  dealingDuration: 600n,
});

describe('scheduler: registration', () => {
  it('closes a scheduled registration at its deadline with the roster from state, never before, reading nothing meanwhile', async () => {
    const s = setup();
    const deadline = s.chain.now + 100n;
    const cid = watched(s, 1, registration(deadline, 3));
    await s.scheduler.tick();
    expect(s.chain.sentRaw).toHaveLength(0);
    // Nothing can be due before the deadline: later passes read no view at all.
    expect(await viewCalls(s.chain, () => s.scheduler.tick())).toBe(0);
    s.chain.setTime(deadline);
    await s.scheduler.tick();
    const [close] = sent(s.chain);
    expect(close?.functionName).toBe('closeRegistrationScheduled');
    expect((close?.args as readonly unknown[])[1]).toEqual(MEMBER_KEYS.slice(0, 3).map((k) => [k.x, k.y]));
    const c = s.chain.manager.ceremonies.get(cid);
    expect(c?.phase).toBe(2);
    expect(c?.n).toBe(3);
    expect(c?.dealingDeadline).toBe(deadline + 600n); // the schedule's, not the caller's
  });

  it('closes a manual registration past its expiry with at least t members', async () => {
    const s = setup();
    const deadline = s.chain.now + 10n;
    const cid = watched(s, 2, registration(deadline, 2, 0));
    s.chain.setTime(deadline + 5n);
    await s.scheduler.tick();
    expect(sent(s.chain).map((c) => c.functionName)).toEqual(['closeRegistrationScheduled']);
    expect(s.chain.manager.ceremonies.get(cid)?.phase).toBe(2);
  });

  it('closes at the head time even while the finalized block is still before the deadline', async () => {
    const s = setup();
    const deadline = s.chain.now + 50n;
    const cid = watched(s, 3, registration(deadline, 3));
    lag(s.chain, 60n); // finalized: before the deadline, already 3 members; head: past it
    await s.scheduler.tick();
    expect(s.chain.manager.ceremonies.get(cid)?.phase).toBe(2);
  });

  it('late threshold join: closes on the head state when the join that reached t is not final yet', async () => {
    const s = setup();
    const deadline = s.chain.now + 100n;
    const cid = watched(s, 8, registration(deadline, 1)); // t = 2, a 10-minute close window
    s.chain.setTime(deadline - 10n);
    s.chain.holdFinalized(); // finalized: one member
    const head = s.chain.manager.ceremonies.get(cid);
    if (head) head.joined = 2; // the second member joins 10 s before the deadline
    s.chain.blockNumber += 15n; // the head passes the deadline; finality lags behind the join
    await s.scheduler.tick();
    expect(sent(s.chain).map((c) => c.functionName)).toEqual(['closeRegistrationScheduled']);
    expect(s.chain.manager.ceremonies.get(cid)).toMatchObject({ phase: 2, n: 2, dealingDeadline: deadline + 600n });
    await s.sender.tick();
    // The finalized block catches up: nothing else is sent (no abort of a timely ceremony).
    s.chain.releaseFinalized();
    await s.scheduler.tick();
    expect(sent(s.chain).map((c) => c.functionName)).toEqual(['closeRegistrationScheduled']);
    expect(s.scheduler.watching).toEqual([cid]); // now dealing
  });

  it('closes on the head a ceremony created after the finalized block once its deadline passed', async () => {
    const s = setup();
    s.chain.holdFinalized();
    const deadline = s.chain.now + 5n;
    const cid = watched(s, 9, registration(deadline, 2)); // exists at the head only
    s.chain.blockNumber += 10n;
    await s.scheduler.tick();
    expect(sent(s.chain).map((c) => c.functionName)).toEqual(['closeRegistrationScheduled']);
    expect(s.chain.manager.ceremonies.get(cid)?.phase).toBe(2);
    await s.scheduler.tick(); // the close is pending finality: not sent again
    expect(s.chain.sentRaw).toHaveLength(1);
  });

  it('never closes at the head below t, and leaves the abort to the finalized state', async () => {
    const s = setup();
    const deadline = s.chain.now + 50n;
    const cid = watched(s, 10, registration(deadline, 1));
    lag(s.chain, 60n);
    await s.scheduler.tick();
    expect(s.chain.sentRaw).toHaveLength(0);
    s.chain.releaseFinalized();
    await s.scheduler.tick();
    expect(sent(s.chain).map((c) => c.functionName)).toEqual(['abort']);
    expect(s.chain.manager.ceremonies.get(cid)?.phase).toBe(4);
  });

  it('aborts a registration that missed t only once the finalized block is past the deadline', async () => {
    const s = setup();
    const deadline = s.chain.now + 50n;
    const cid = watched(s, 4, registration(deadline, 1, 0));
    lag(s.chain, 60n);
    await s.scheduler.tick();
    // Joins could still land in blocks the finalized one does not cover: no abort yet.
    expect(s.chain.sentRaw).toHaveLength(0);
    s.chain.releaseFinalized();
    await s.scheduler.tick();
    expect(sent(s.chain).map((c) => c.functionName)).toEqual(['abort']);
    expect(s.chain.manager.ceremonies.get(cid)?.phase).toBe(4);
    await s.scheduler.tick();
    expect(s.scheduler.watching).toEqual([]);
  });

  it('aborts a registration nobody closed within its window, whatever the count', async () => {
    const s = setup();
    const deadline = s.chain.now + 10n;
    const cid = watched(s, 5, registration(deadline, 4));
    s.chain.setTime(deadline + 601n);
    await s.scheduler.tick();
    expect(sent(s.chain).map((c) => c.functionName)).toEqual(['abort']);
    expect(s.chain.manager.ceremonies.get(cid)?.phase).toBe(4);
  });

  it('does not sleep through an early manual close: finalizes before the original expiry', async () => {
    const s = setup();
    const expiry = s.chain.now + 10n ** 6n;
    const cid = watched(s, 7, registration(expiry, 3, 0));
    await s.scheduler.tick();
    expect(s.chain.sentRaw).toHaveLength(0);
    // The organizer closes long before the expiry and every member deals.
    s.chain.addCeremony(cid, { phase: 2, threshold: 2, n: 3, qual: 0b111, dealingDeadline: s.chain.now + 3600n });
    await s.scheduler.tick();
    expect(sent(s.chain).map((c) => c.functionName)).toEqual(['finalize']);
    expect(s.chain.manager.ceremonies.get(cid)?.phase).toBe(3);
  });

  it('a manual registration without expiry has nothing to send, ever', async () => {
    const s = setup();
    const cid = watched(s, 6, registration(0n, 5, 0));
    s.chain.setTime(s.chain.now + 10n ** 8n);
    await s.scheduler.tick();
    await s.scheduler.tick();
    expect(s.chain.sentRaw).toHaveLength(0);
    expect(s.scheduler.watching).toEqual([cid]);
  });
});

describe('scheduler: dealing', () => {
  const dealing = (now: bigint, qual: number, deadlineIn: bigint): FakeCeremony => ({
    phase: 2,
    threshold: 2,
    n: 3,
    qual,
    dealingDeadline: now + deadlineIn,
  });

  it('finalizes early once every member dealt', async () => {
    const s = setup();
    const cid = watched(s, 10, dealing(s.chain.now, 0b111, 3600n));
    await s.scheduler.tick();
    expect(sent(s.chain).map((c) => c.functionName)).toEqual(['finalize']);
    expect(s.chain.manager.ceremonies.get(cid)?.phase).toBe(3);
  });

  it('finalizes past the deadline with at least t dealers, and not before', async () => {
    const s = setup();
    const cid = watched(s, 11, dealing(s.chain.now, 0b011, 100n));
    await s.scheduler.tick();
    expect(s.chain.sentRaw).toHaveLength(0);
    s.chain.setTime(s.chain.now + 101n);
    await s.scheduler.tick();
    expect(s.chain.manager.ceremonies.get(cid)?.phase).toBe(3);
  });

  it('aborts a dealing past its deadline below t', async () => {
    const s = setup();
    const cid = watched(s, 12, dealing(s.chain.now, 0b001, 100n));
    s.chain.setTime(s.chain.now + 101n);
    await s.scheduler.tick();
    expect(sent(s.chain).map((c) => c.functionName)).toEqual(['abort']);
    expect(s.chain.manager.ceremonies.get(cid)?.phase).toBe(4);
  });
});

describe('scheduler: once, within budget, after simulation', () => {
  it('shares a pending transition with an identical relayed one and does not repeat it', async () => {
    const s = setup({ automine: false });
    const cid = watched(s, 20, { phase: 2, threshold: 2, n: 3 });
    await s.scheduler.tick();
    await s.scheduler.tick(); // pending: not sent again
    expect(s.chain.sentRaw).toHaveLength(1);
    const relayed = await s.sponsor.sponsor({ kind: 'finalize', ceremonyId: cid }, HTTP);
    expect(relayed).toBe(keccak256(s.chain.sentRaw[0] as Hex)); // the scheduler's pending transaction
    expect(s.chain.sentRaw).toHaveLength(1);
    s.chain.mine();
    await s.sender.tick();
    await s.scheduler.tick();
    expect(s.chain.sentRaw).toHaveLength(1);
    expect(s.chain.manager.ceremonies.get(cid)?.phase).toBe(3);
  });

  it('leaves a transition it already paid for once to others', async () => {
    const logs = capture();
    const s = setup({ automine: false, log: logs.log });
    const cid = watched(s, 21, { phase: 2, threshold: 2, n: 3 });
    await s.scheduler.tick();
    s.chain.manager.forced.set('finalize', 'FinalizeConditionNotMet');
    s.chain.mine(); // reverts on chain: paid, quota spent
    s.chain.manager.forced.delete('finalize');
    await s.sender.tick();
    await s.scheduler.tick();
    await s.scheduler.tick();
    expect(s.chain.sentRaw).toHaveLength(1);
    expect(s.chain.manager.ceremonies.get(cid)?.phase).toBe(2);
    expect(logs.entries.filter((e) => e.level === 'warn').map((e) => e.msg)).toEqual([
      'scheduled transition failed on chain',
      'scheduled transition already sponsored once; leaving it to others',
    ]);
    // Anyone else may still finalize it; the relayer does not pay twice.
    expect(s.scheduler.watching).toEqual([cid]);
  });

  it('backs off a transition the head refuses (someone else got there first)', async () => {
    const s = setup();
    const cid = watched(s, 22, { phase: 2, threshold: 2, n: 3 });
    s.chain.holdFinalized(); // finalized: still Dealing
    s.chain.manager.ceremonies.set(cid, { ...s.chain.manager.ceremonies.get(cid)!, phase: 3 }); // head: Live
    await s.scheduler.tick();
    expect(s.chain.sentRaw).toHaveLength(0);
    // Backing off: the next pass simulates nothing.
    let estimates = 0;
    s.chain.failRequests = (m) => (m === 'eth_call' ? (estimates++, undefined) : undefined);
    await s.scheduler.tick();
    expect(estimates).toBe(0);
    s.advance(1000);
    s.chain.releaseFinalized();
    await s.scheduler.tick();
    expect(s.scheduler.watching).toEqual([]); // Live and open: nothing left
  });

  it('stays within the global budget', async () => {
    const s = setup({ budgetWei: 1n });
    const cid = watched(s, 23, { phase: 2, threshold: 2, n: 3 });
    await s.scheduler.tick();
    expect(s.chain.sentRaw).toHaveLength(0);
    expect(s.scheduler.watching).toEqual([cid]);
  });

  it('restricted mode: drops a ceremony this relayer does not sponsor', async () => {
    const s = setup({ policy: { organizerAllowlist: [ORG_A] } });
    watched(s, 24, { phase: 2, threshold: 2, n: 3, organizer: ORG_B });
    const ours = watched(s, 25, { phase: 2, threshold: 2, n: 3, organizer: ORG_A });
    await s.scheduler.tick();
    expect(s.scheduler.watching).toEqual([ours]); // finalized: dropped once Live and open
    expect(s.chain.manager.ceremonies.get(ours)?.phase).toBe(3);
    expect(s.chain.manager.ceremonies.get(ceremonyIdOf(24))?.phase).toBe(2);
  });
});

describe('scheduler: a malformed roster word (a corrupted rpc answer)', () => {
  it('does not send the close, keeps serving other ceremonies, and closes once the true word is served', async () => {
    const s = setup();
    const deadline = s.chain.now + 10n;
    const bad = watched(s, 50, registration(deadline, 2));
    const other = watched(s, 51, { phase: 2, threshold: 2, n: 3 });
    s.chain.manager.wordOverride.participant.set(`${bad}:1`, (1n << 254n) | 7n);
    s.chain.setTime(deadline);
    await expect(s.scheduler.tick()).resolves.toBeUndefined();
    expect(sent(s.chain).map((c) => c.functionName)).toEqual(['finalize']);
    expect(s.chain.manager.ceremonies.get(other)?.phase).toBe(3);
    expect(s.chain.manager.ceremonies.get(bad)?.phase).toBe(1);
    s.chain.manager.wordOverride.participant.clear();
    s.advance(1000);
    await s.scheduler.tick();
    expect(s.chain.manager.ceremonies.get(bad)?.phase).toBe(2);
  });
});

describe('scheduler: decryption opening (no transaction, protocol §8.7)', () => {
  it('notices a scheduled opening at its date, wakes the combiner and stops watching', async () => {
    const s = setup();
    const opensAt = s.chain.now + 500n;
    const cid = watched(s, 30, { phase: 3, threshold: 2, n: 3, decryptionMode: 1, decryptionOpenAt: opensAt });
    await s.scheduler.tick();
    expect(await viewCalls(s.chain, () => s.scheduler.tick())).toBe(0); // a scheduled date cannot come early
    expect(s.woken).toEqual([]);
    s.chain.setTime(opensAt);
    await s.scheduler.tick();
    expect(s.woken).toEqual([cid]);
    expect(s.scheduler.watching).toEqual([]);
    expect(s.chain.sentRaw).toHaveLength(0);
  });

  it('polls a manual opening until the organizer opens it (or its fallback date passes)', async () => {
    const s = setup();
    const manual = watched(s, 31, { phase: 3, threshold: 2, n: 3, decryptionMode: 0 });
    const fallback = watched(s, 32, { phase: 3, threshold: 2, n: 3, decryptionMode: 0, manualDecryptionFallbackAt: s.chain.now + 50n });
    await s.scheduler.tick();
    expect(s.woken).toEqual([]);
    const open: Action = { kind: 'openDecryption', message: { ceremonyId: manual, validUntil: 2_000_000_000n }, signature: SIG };
    await s.sponsor.sponsor(open, HTTP);
    await s.scheduler.tick();
    expect(s.woken).toEqual([manual]);
    s.chain.setTime(s.chain.now + 50n);
    await s.scheduler.tick();
    expect(s.woken).toEqual([manual, fallback]);
    expect(s.chain.sentRaw).toHaveLength(1); // only the organizer's opening
  });
});

describe('scheduler: the watch list', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('services ceremonies recorded by relayed actions, across a restart', async () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), 'council-scheduler-')), 'state.json');
    const first = setup({ store: new StateStore(file) });
    const cid = ceremonyIdOf(40);
    const deadline = first.chain.now + 100n;
    first.chain.addCeremony(cid, registration(deadline, 2));
    const join: Action = {
      kind: 'join',
      message: { ceremonyId: cid, participant: ORG_A, inviteId: 0, pkX: 1n, pkY: 2n, popAx: 1n, popAy: 2n, popZ: 3n, validUntil: 9n },
      signature: SIG,
      invite: { ceremonyId: cid, inviteId: 0, participant: ORG_A, pkX: 1n, pkY: 2n, validUntil: 9n },
      inviteSignature: SIG,
    };
    await first.sponsor.sponsor(join, HTTP);
    expect(first.scheduler.watching).toEqual([cid]);
    await first.sender.tick();

    const second = setup({ chain: first.chain, store: new StateStore(file), clock: first.clock });
    second.chain.setTime(deadline);
    await second.scheduler.tick();
    expect(second.chain.manager.ceremonies.get(cid)?.phase).toBe(2);
  });

  it('keeps a ceremony the finalized block does not know yet, and drops it after a day', async () => {
    const s = setup();
    const cid = ceremonyIdOf(41);
    s.scheduler.watch(cid);
    await s.scheduler.tick();
    expect(s.scheduler.watching).toEqual([cid]);
    s.advance(24 * 3_600_000);
    await s.scheduler.tick();
    expect(s.scheduler.watching).toEqual([]);
  });

  it('backs off failed passes, logging transient rpc errors at info until they persist', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const logs = capture();
    const s = setup({ log: logs.log });
    let blocks = 0;
    s.chain.failRequests = (m) => (m === 'eth_getBlockByNumber' ? (blocks++, rpcError(-32005, 'rate limit exceeded')) : undefined);
    s.scheduler.start(1000);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(15_000); // 1 s, 2 s, 4 s, 8 s
    s.scheduler.stop();
    const passes = logs.entries.filter((e) => /scheduler/.test(e.msg));
    expect(passes.map((e) => e.level)).toEqual(['info', 'info', 'info', 'info', 'warn']);
    expect(passes[0]?.msg).toBe('scheduler pass deferred: transient rpc error');
    expect(blocks).toBeGreaterThanOrEqual(5);
  });
});
