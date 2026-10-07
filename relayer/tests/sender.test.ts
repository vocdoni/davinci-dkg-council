import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { encodeAction, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { keccak256, parseTransaction } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { RelayError } from '../src/errors.js';
import { MAX_TX_GAS, TxSender } from '../src/sender.js';
import { StateStore } from '../src/state.js';
import { ceremonyIdOf, MANAGER, MockChain, RELAYER_KEY, rpcError } from './mockchain.js';
import { stack } from './stack.js';

const account = privateKeyToAccount(RELAYER_KEY);

const finalizeData = (n: number): Hex => encodeAction({ kind: 'finalize', ceremonyId: ceremonyIdOf(n) });
const abortData = (n: number): Hex => encodeAction({ kind: 'abort', ceremonyId: ceremonyIdOf(n) });

function dealing(chain: MockChain, count: number): void {
  for (let i = 1; i <= count; i++) chain.addCeremony(ceremonyIdOf(i), { phase: 2, threshold: 2, n: 3 });
}

const errorOf = async (p: Promise<unknown>): Promise<RelayError> => {
  const err = await p.catch((e: unknown) => e);
  expect(err).toBeInstanceOf(RelayError);
  return err as RelayError;
};

/** Worst case of one mocked send: 120k gas (100k + 20%) × 3 gwei (2·base + tip). */
const WORST = 120_000n * 3_000_000_000n;
/** Actual cost: 50k gas used × 2 gwei effective price. */
const ACTUAL = 50_000n * 2_000_000_000n;

describe('TxSender', () => {
  it('simulates, signs and sends with consecutive local nonces', async () => {
    const { chain, sender } = stack();
    dealing(chain, 3);
    const hashes = await Promise.all([1, 2, 3].map((i) => sender.send(MANAGER, finalizeData(i))));
    expect(new Set(hashes).size).toBe(3);
    expect(chain.sentRaw.map((raw) => parseTransaction(raw).nonce)).toEqual([0, 1, 2]);
    expect((await sender.status(hashes[0] as Hex)).status).toBe('pending'); // until the monitor settles it
    await sender.tick();
    for (const h of hashes) expect((await sender.status(h)).status).toBe('confirmed');
    expect(chain.manager.calls.map((c) => c.fn)).toEqual(['finalize', 'finalize', 'finalize']);
    const tx = parseTransaction(chain.sentRaw[0] as Hex);
    expect(tx.gas).toBe(120_000n);
    expect(tx.maxFeePerGas).toBe(3_000_000_000n);
  });

  it('never broadcasts an action that reverts in simulation, and decodes the custom error', async () => {
    const { chain, sender } = stack();
    chain.addCeremony(ceremonyIdOf(1), { phase: 3, threshold: 2, n: 3 });
    const err = await errorOf(sender.send(MANAGER, finalizeData(1)));
    expect(err.code).toBe('SIMULATION_REVERTED');
    expect(err.detail).toBe('WrongPhase()');
    expect(err.revertData).toMatch(/^0x[0-9a-f]{8}$/);
    expect(chain.sentRaw).toHaveLength(0);
    chain.addCeremony(ceremonyIdOf(2), { phase: 2, threshold: 2, n: 3 });
    await sender.send(MANAGER, finalizeData(2));
    expect(parseTransaction(chain.sentRaw[0] as Hex).nonce).toBe(0);
  });

  it('resyncs the nonce when another sender used the key', async () => {
    const { chain, sender } = stack();
    dealing(chain, 2);
    await sender.syncNonce();
    for (const nonce of [0, 1]) {
      const raw = await account.signTransaction({
        chainId: 31337,
        type: 'eip1559',
        nonce,
        to: account.address,
        gas: 21_000n,
        maxFeePerGas: 3_000_000_000n,
        maxPriorityFeePerGas: 1n,
      });
      await chain.request('eth_sendRawTransaction', [raw]);
    }
    const hash = await sender.send(MANAGER, finalizeData(1));
    await sender.tick();
    expect((await sender.status(hash)).status).toBe('confirmed');
    expect(parseTransaction(chain.sentRaw.at(-1) as Hex).nonce).toBe(2);
  });

  it('reports TX_FAILED, undoes the reservation and keeps the nonce on a rejected broadcast', async () => {
    const { chain, sender } = stack();
    dealing(chain, 2);
    chain.failNextSend = rpcError(-32000, 'insufficient funds for gas * price + value');
    let undone = 0;
    const err = await errorOf(sender.send(MANAGER, finalizeData(1), { reserve: () => () => undone++ }));
    expect(err.code).toBe('TX_FAILED');
    expect(undone).toBe(1);
    await sender.send(MANAGER, finalizeData(2));
    expect(parseTransaction(chain.sentRaw[0] as Hex).nonce).toBe(0);
  });

  it('bumps the fees of a stuck transaction, keeps the nonce and tracks the replacement', async () => {
    const { chain, sender, advance } = stack({ automine: false });
    dealing(chain, 1);
    const first = await sender.send(MANAGER, finalizeData(1));
    await sender.tick();
    expect(chain.sentRaw).toHaveLength(1);
    advance(10_000);
    await sender.tick();
    expect(chain.sentRaw).toHaveLength(2);
    const [a, b] = chain.sentRaw.map((raw) => parseTransaction(raw));
    expect(b?.nonce).toBe(a?.nonce);
    expect((b?.maxFeePerGas as bigint) * 10n >= (a?.maxFeePerGas as bigint) * 11n).toBe(true);
    expect((await sender.status(first)).status).toBe('pending');
    chain.mine();
    await sender.tick();
    const st = await sender.status(first);
    expect(st.status).toBe('confirmed');
    expect(st.minedTxHash).toBeDefined();
    expect(st.minedTxHash).not.toBe(first);
    expect(sender.pendingCount).toBe(0);
  });

  it('never bumps above COUNCIL_MAX_FEE_WEI; at the cap it rebroadcasts the same transaction', async () => {
    const cap = 3_200_000_000n;
    const { chain, sender, advance } = stack({ automine: false, maxFeeWei: cap });
    dealing(chain, 1);
    await sender.send(MANAGER, finalizeData(1));
    advance(10_000);
    await sender.tick();
    expect(chain.sentRaw).toHaveLength(1);
    for (const raw of chain.sentRaw) expect(parseTransaction(raw).maxFeePerGas as bigint).toBeLessThanOrEqual(cap);
  });

  it('caps the gas limit at min(block gas limit, EIP-7825 maximum)', async () => {
    expect(MAX_TX_GAS).toBe(16_777_216n);
    const { chain, sender } = stack();
    dealing(chain, 3);
    chain.gasEstimate = 15_000_000n; // + 20% headroom = 18M: above 2^24, below the 30M block
    await sender.send(MANAGER, finalizeData(1));
    expect(parseTransaction(chain.sentRaw[0] as Hex).gas).toBe(MAX_TX_GAS);
    chain.gasLimit = 12_000_000n; // a block below 2^24 still bounds it
    chain.gasEstimate = 11_000_000n;
    await sender.send(MANAGER, finalizeData(2));
    expect(parseTransaction(chain.sentRaw[1] as Hex).gas).toBe(12_000_000n);
    chain.gasLimit = 60_000_000n; // a chain without EIP-7825: COUNCIL_MAX_TX_GAS raises the cap
    chain.gasEstimate = 27_000_000n;
    const raised = new TxSender({
      client: chain.client,
      account,
      chainId: 31337n,
      maxFeeWei: 10n ** 11n,
      bumpAfterMs: 1000,
      maxTxGas: 30_000_000n,
    });
    await raised.send(MANAGER, finalizeData(3));
    expect(parseTransaction(chain.sentRaw[2] as Hex).gas).toBe(30_000_000n);
  });

  it('with state gas (EIP-8037), only the block gas limit caps the gas limit', async () => {
    const chain = new MockChain();
    dealing(chain, 3);
    const sender = new TxSender({ client: chain.client, account, chainId: 31337n, maxFeeWei: 10n ** 11n, bumpAfterMs: 1000, stateGas: true });
    // A 16-member finalize after Glamsterdam: 10.97M execution + 6.27M state gas.
    chain.gasLimit = 60_000_000n;
    chain.gasEstimate = 17_240_000n;
    await sender.send(MANAGER, finalizeData(1));
    expect(parseTransaction(chain.sentRaw[0] as Hex).gas).toBe(20_688_000n); // + 20%, above 2^24
    chain.gasEstimate = 55_000_000n; // the block still bounds it
    await sender.send(MANAGER, finalizeData(2));
    expect(parseTransaction(chain.sentRaw[1] as Hex).gas).toBe(60_000_000n);
    // An explicit COUNCIL_MAX_TX_GAS still applies.
    const capped = new TxSender({
      client: chain.client,
      account,
      chainId: 31337n,
      maxFeeWei: 10n ** 11n,
      bumpAfterMs: 1000,
      stateGas: true,
      maxTxGas: 25_000_000n,
    });
    await capped.send(MANAGER, finalizeData(3));
    expect(parseTransaction(chain.sentRaw[2] as Hex).gas).toBe(25_000_000n);
  });

  it('refuses plainly, before broadcasting, when the key cannot cover the worst case', async () => {
    const logs: { msg: string; fields?: Record<string, unknown> }[] = [];
    const log = { info: () => {}, warn: () => {}, error: (msg: string, fields?: Record<string, unknown>) => logs.push({ msg, fields }) };
    const chain = new MockChain();
    dealing(chain, 2);
    const sender = new TxSender({ client: chain.client, account, chainId: 31337n, maxFeeWei: 10n ** 11n, bumpAfterMs: 1000, log });
    chain.balance = WORST - 1n;
    const err = await errorOf(sender.send(MANAGER, finalizeData(1)));
    expect(err.code).toBe('BUDGET_EXHAUSTED');
    expect(err.detail).toBe(`sponsorship paused: the relayer key holds ${WORST - 1n} wei, and this action may cost up to ${WORST} wei; the operator must top it up`);
    expect(chain.sentRaw).toHaveLength(0);
    expect(logs.map((l) => l.msg)).toEqual(['hot key balance too low: top it up']);
    // What is already in flight counts too: the node checks the key's pending total.
    chain.automine = false;
    chain.balance = 2n * WORST - 1n;
    await sender.send(MANAGER, finalizeData(1));
    expect((await errorOf(sender.send(MANAGER, finalizeData(2)))).detail).toMatch(/plus 360000000000000 wei in flight/);
  });

  it('says plainly why a node refused the broadcast for insufficient funds', async () => {
    const { chain, sender } = stack();
    dealing(chain, 1);
    chain.failNextSend = rpcError(-32000, 'insufficient funds for gas * price + value: balance 1, tx cost 360000000000000');
    const err = await errorOf(sender.send(MANAGER, finalizeData(1)));
    expect(err.code).toBe('TX_FAILED');
    expect(err.detail).toMatch(/^the relayer key cannot pay for this action; the operator must top it up \(insufficient funds/);
  });

  it('refuses to send when the base fee reaches the cap', async () => {
    const { chain, sender } = stack({ maxFeeWei: 1_000_000_000n });
    dealing(chain, 1);
    expect((await errorOf(sender.send(MANAGER, finalizeData(1)))).code).toBe('TX_FAILED');
    expect(chain.sentRaw).toHaveLength(0);
  });

  it('reports a transaction that reverted on chain as failed with the decoded reason', async () => {
    const { chain, sender } = stack({ automine: false });
    dealing(chain, 1);
    const hash = await sender.send(MANAGER, finalizeData(1));
    chain.manager.forced.set('finalize', 'FinalizeConditionNotMet');
    chain.mine();
    await sender.tick();
    expect(await sender.status(hash)).toMatchObject({ status: 'failed', revertReason: 'FinalizeConditionNotMet()' });
  });

  it('answers an identical pending action with its existing transaction instead of paying twice', async () => {
    const { chain, sender } = stack({ automine: false });
    dealing(chain, 1);
    const first = await sender.send(MANAGER, finalizeData(1), { slots: ['phase'] });
    expect(await sender.send(MANAGER, finalizeData(1), { slots: ['phase'] })).toBe(first);
    expect(chain.sentRaw).toHaveLength(1);
    chain.mine();
    await sender.tick();
    const err = await errorOf(sender.send(MANAGER, finalizeData(1), { slots: ['phase'] }));
    expect(err.code).toBe('SIMULATION_REVERTED');
    expect(chain.sentRaw).toHaveLength(1);
  });

  it('refuses a conflicting variant while the slot it consumes is pending, until settlement', async () => {
    const { chain, sender } = stack({ automine: false });
    dealing(chain, 1);
    const first = await sender.send(MANAGER, finalizeData(1), { slots: ['cer:1:phase'] });
    // abort targets the same one-shot transition: a different action for the same slot.
    const err = await errorOf(sender.send(MANAGER, abortData(1), { slots: ['cer:1:phase'] }));
    expect(err.code).toBe('CONFLICT');
    expect(err.status).toBe(409);
    expect(err.detail).toContain(first);
    expect(chain.sentRaw).toHaveLength(1);
    // Unrelated slots are not blocked.
    chain.addCeremony(ceremonyIdOf(2), { phase: 2, threshold: 2, n: 3 });
    await sender.send(MANAGER, finalizeData(2), { slots: ['cer:2:phase'] });
    chain.mine();
    await sender.tick();
    // Settled: the slot is free; the chain (via simulation) now decides.
    const after = await errorOf(sender.send(MANAGER, abortData(1), { slots: ['cer:1:phase'] }));
    expect(after.code).toBe('SIMULATION_REVERTED');
  });

  it('adopts a transaction the node accepted behind a lost response', async () => {
    const { chain, sender } = stack();
    dealing(chain, 2);
    chain.loseNextResponse = rpcError(-32603, 'request timed out');
    const hash = await sender.send(MANAGER, finalizeData(1));
    expect(chain.sentRaw).toHaveLength(1);
    await sender.tick();
    expect((await sender.status(hash)).status).toBe('confirmed');
    await sender.send(MANAGER, finalizeData(2));
    expect(chain.sentRaw.map((raw) => parseTransaction(raw).nonce)).toEqual([0, 1]);
  });

  it('never reuses the nonce of a tracked transaction after a resync; the monitor refills the gap', async () => {
    const { chain, sender, advance } = stack({ automine: false });
    dealing(chain, 2);
    const a = await sender.send(MANAGER, finalizeData(1));
    chain.mempool.splice(0, chain.mempool.length);
    chain.failNextSend = rpcError(-32000, 'nonce too low');
    const b = await sender.send(MANAGER, finalizeData(2));
    expect(parseTransaction(chain.sentRaw.at(-1) as Hex).nonce).toBe(1);
    advance(10_000);
    await sender.tick();
    chain.mine();
    await sender.tick();
    expect((await sender.status(a)).status).toBe('confirmed');
    expect((await sender.status(b)).status).toBe('confirmed');
    expect(chain.manager.calls.map((c) => c.args[0])).toEqual([ceremonyIdOf(1), ceremonyIdOf(2)]);
  });

  it('finds a fee-bumped replacement that was accepted behind a lost response', async () => {
    const { chain, sender, advance } = stack({ automine: false });
    dealing(chain, 1);
    const hash = await sender.send(MANAGER, finalizeData(1));
    advance(10_000);
    chain.loseNextResponse = rpcError(-32603, 'request timed out');
    await sender.tick();
    chain.mine();
    await sender.tick();
    const st = await sender.status(hash);
    expect(st.status).toBe('confirmed');
    expect(st.minedTxHash).toBeDefined();
  });

  it('answers /v1/status only for its own transactions, from memory', async () => {
    const { chain, sender } = stack();
    dealing(chain, 1);
    const other = new TxSender({ client: chain.client, account, chainId: 31337n, maxFeeWei: 10n ** 11n, bumpAfterMs: 1000 });
    const foreign = await other.send(MANAGER, finalizeData(1));
    expect((await errorOf(sender.status(foreign))).code).toBe('NOT_FOUND');
    expect((await errorOf(sender.status(`0x${'99'.repeat(32)}`))).code).toBe('NOT_FOUND');
  });
});

describe('spending budget', () => {
  it('reserves the worst case, settles to the actual cost, refuses beyond the window budget', async () => {
    const { chain, sender, advance } = stack({ budgetWei: WORST + ACTUAL + 1n });
    dealing(chain, 4);
    await sender.send(MANAGER, finalizeData(1));
    // In flight: the first transaction's worst case still counts.
    const err = await errorOf(sender.send(MANAGER, finalizeData(2)));
    expect(err.code).toBe('BUDGET_EXHAUSTED');
    expect(err.status).toBe(503);
    expect(chain.sentRaw).toHaveLength(1);
    await sender.tick(); // settled: ACTUAL spent, nothing in flight
    expect(sender.budget.spent()).toBe(ACTUAL);
    await sender.send(MANAGER, finalizeData(2));
    await sender.tick();
    expect((await errorOf(sender.send(MANAGER, finalizeData(3)))).code).toBe('BUDGET_EXHAUSTED');
    advance(24 * 3_600_000 + 1);
    expect(sender.budget.spent()).toBe(0n);
    await sender.send(MANAGER, finalizeData(3));
  });

  it('reserves a fee bump before broadcasting it, even when its response is lost', async () => {
    const bumpedWorst = 120_000n * (3_000_000_000n * 1125n / 1000n + 1n);
    // Fits the bumped transaction plus a new one only if the bump were left unreserved.
    const { chain, sender, advance } = stack({ automine: false, budgetWei: bumpedWorst + WORST - 1n });
    dealing(chain, 2);
    await sender.send(MANAGER, finalizeData(1));
    advance(10_000);
    chain.loseNextResponse = rpcError(-32603, 'request timed out');
    await sender.tick();
    expect(chain.sentRaw).toHaveLength(2); // the replacement reached the node
    expect(sender.budget.inFlight()).toBe(bumpedWorst);
    expect((await errorOf(sender.send(MANAGER, finalizeData(2)))).code).toBe('BUDGET_EXHAUSTED');
  });

  it('rebroadcasts instead of bumping when the bump would not fit the budget', async () => {
    const { chain, sender, advance } = stack({ automine: false, budgetWei: WORST + 1n });
    dealing(chain, 1);
    await sender.send(MANAGER, finalizeData(1));
    advance(10_000);
    await sender.tick();
    expect(chain.sentRaw).toHaveLength(1);
  });
});

describe('persistence', () => {
  it('journals the signed transaction before broadcasting it (crash at the broadcast boundary)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'davinci-dkg-council-relayer-'));
    const file = path.join(dir, 'state.json');
    const chain = new MockChain({ automine: false });
    dealing(chain, 2);
    const clock = { t: 1_000_000 };
    const first = stack({ chain, store: new StateStore(file), clock, budgetWei: 10n ** 18n });
    // The process dies the moment the node receives the transaction: copy the state file then.
    let atBroadcast: string | undefined;
    chain.beforeSend = () => (atBroadcast ??= readFileSync(file, 'utf8'));
    const a = await first.sender.send(MANAGER, finalizeData(1), { slots: ['cer:1:phase'] });
    chain.beforeSend = undefined;
    const journaled = JSON.parse(atBroadcast as string) as { pending: { hashes: string[]; slots: string[] }[] };
    expect(journaled.pending.map((p) => p.hashes)).toEqual([[a]]);
    expect(journaled.pending[0]?.slots).toEqual(['cer:1:phase']);

    // Restart from that file after the node evicted the transaction.
    const crashed = path.join(dir, 'crashed.json');
    writeFileSync(crashed, atBroadcast as string);
    chain.mempool.splice(0, chain.mempool.length);
    const second = stack({ chain, store: new StateStore(crashed), clock, budgetWei: 10n ** 18n });
    await second.sender.recover();
    expect(chain.mempool.map((t) => t.hash)).toEqual([a]);
    expect(second.sender.budget.inFlight()).toBe(WORST);
    await second.sender.send(MANAGER, finalizeData(2));
    expect(parseTransaction(chain.sentRaw.at(-1) as Hex).nonce).toBe(1);
  });

  it('drops the journal entry when the node definitively refuses the transaction', async () => {
    const { chain, sender, store } = stack();
    dealing(chain, 1);
    chain.failNextSend = rpcError(-32000, 'insufficient funds for gas * price + value');
    expect((await errorOf(sender.send(MANAGER, finalizeData(1), { slots: ['cer:1:phase'] }))).code).toBe('TX_FAILED');
    expect(sender.pendingCount).toBe(0);
    expect(store.state.pending).toEqual([]);
    expect(sender.budget.inFlight()).toBe(0n);
    await sender.send(MANAGER, finalizeData(1), { slots: ['cer:1:phase'] }); // slot not leaked
  });

  it('restart followed by eviction: rebroadcasts the signed pending tx, keeps its nonce, slots and status', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'davinci-dkg-council-relayer-'));
    const file = path.join(dir, 'state.json');
    const chain = new MockChain({ automine: false });
    dealing(chain, 3);
    const clock = { t: 1_000_000 };
    const first = stack({ chain, store: new StateStore(file), clock, budgetWei: 10n ** 18n });
    const settledHash = await first.sender.send(MANAGER, finalizeData(3));
    chain.mine();
    await first.sender.tick();
    const a = await first.sender.send(MANAGER, finalizeData(1), { slots: ['cer:1:phase'] });
    expect(JSON.parse(readFileSync(file, 'utf8')).pending).toHaveLength(1);

    // The process dies; the node evicts the transaction.
    first.sender.stop();
    chain.mempool.splice(0, chain.mempool.length);

    const second = stack({ chain, store: new StateStore(file), clock, budgetWei: 10n ** 18n });
    expect((await second.sender.status(settledHash)).status).toBe('confirmed');
    expect(second.sender.budget.spent()).toBe(ACTUAL);
    expect(second.sender.budget.inFlight()).toBe(WORST);
    await second.sender.recover();
    expect(chain.mempool.map((t) => t.hash)).toEqual([a]);
    expect((await errorOf(second.sender.send(MANAGER, abortData(1), { slots: ['cer:1:phase'] }))).code).toBe('CONFLICT');
    const b = await second.sender.send(MANAGER, finalizeData(2));
    expect(parseTransaction(chain.sentRaw.at(-1) as Hex).nonce).toBe(2);
    chain.mine();
    await second.sender.tick();
    expect((await second.sender.status(a)).status).toBe('confirmed');
    expect((await second.sender.status(b)).status).toBe('confirmed');
    expect(JSON.parse(readFileSync(file, 'utf8')).pending).toHaveLength(0);
  });
});

describe('bounded history', () => {
  it('forgets settled outcomes after a week, so the state file stays bounded', async () => {
    const { chain, sender, store, advance } = stack();
    dealing(chain, 2);
    const old = await sender.send(MANAGER, finalizeData(1));
    await sender.tick();
    expect(store.state.history).toHaveLength(1);
    advance(7 * 24 * 3_600_000 + 1);
    const recent = await sender.send(MANAGER, finalizeData(2));
    await sender.tick();
    expect(store.state.history.map((h) => h.hashes[0])).toEqual([recent]);
    expect((await errorOf(sender.status(old))).code).toBe('NOT_FOUND');
  });
});

describe('budget and journal under RPC uncertainty (audit: unavailable is not "not found")', () => {
  const transient = () => rpcError(-32005, 'rate limit exceeded');

  it('never releases a reservation or reports a drop while receipt lookups fail; charges the mined cost when it appears', async () => {
    const { chain, sender } = stack({ automine: false, budgetWei: 10n ** 18n });
    dealing(chain, 1);
    const hash = await sender.send(MANAGER, finalizeData(1));
    chain.mine(); // mined: the nonce moved on, but the provider cannot serve receipts
    chain.failRequests = (m) => (m === 'eth_getTransactionReceipt' ? transient() : undefined);
    for (let i = 0; i < 6; i++) await sender.tick();
    expect((await sender.status(hash)).status).toBe('pending');
    expect(sender.budget.inFlight()).toBe(WORST);
    expect(sender.budget.spent()).toBe(0n);
    expect(sender.foreignTransactions).toBe(0);
    chain.failRequests = undefined;
    await sender.tick();
    expect((await sender.status(hash)).status).toBe('confirmed');
    expect(sender.budget.spent()).toBe(ACTUAL);
    expect(sender.budget.inFlight()).toBe(0n);
  });

  it('keeps the journal entry of a broadcast whose outcome cannot be verified, and never pays for the action twice', async () => {
    const { chain, sender, store } = stack({ automine: false, budgetWei: 10n ** 18n });
    dealing(chain, 2);
    // The node accepts the transaction but the reply is lost, and the lookup that would tell fails too.
    chain.loseNextResponse = rpcError(-32603, 'request timed out');
    chain.failRequests = (m) => (m === 'eth_getTransactionByHash' ? transient() : undefined);
    const hash = await sender.send(MANAGER, finalizeData(1));
    chain.failRequests = undefined;
    expect(chain.sentRaw).toHaveLength(1);
    expect(keccak256(chain.sentRaw[0] as Hex)).toBe(hash);
    expect(store.state.pending.map((p) => p.hashes)).toEqual([[hash]]);
    expect(sender.budget.inFlight()).toBe(WORST);
    // The same action again resolves to the journaled transaction instead of a second payment.
    expect(await sender.send(MANAGER, finalizeData(1))).toBe(hash);
    await sender.send(MANAGER, finalizeData(2));
    expect(chain.sentRaw.map((raw) => parseTransaction(raw).nonce)).toEqual([0, 1]);
    chain.mine();
    await sender.tick();
    expect((await sender.status(hash)).status).toBe('confirmed');
  });

  it('a refused broadcast with an unavailable lookup stays journaled; the monitor rebroadcasts it', async () => {
    const { chain, sender, advance } = stack({ automine: false, budgetWei: 10n ** 18n });
    dealing(chain, 1);
    chain.failNextSend = rpcError(-32603, 'request timed out');
    chain.failRequests = (m) => (m === 'eth_getTransactionByHash' ? transient() : undefined);
    const hash = await sender.send(MANAGER, finalizeData(1));
    chain.failRequests = undefined;
    expect(chain.mempool).toHaveLength(0); // it never reached the node
    expect(sender.pendingCount).toBe(1);
    advance(10_000);
    await sender.tick(); // stuck: rebroadcast (or bumped) at the same nonce
    expect(chain.mempool.map((t) => t.nonce)).toEqual([0]);
    chain.mine();
    await sender.tick();
    expect((await sender.status(hash)).status).toBe('confirmed');
  });

  it('reports a transaction dropped only once another transaction consumed its nonce at the finalized block', async () => {
    const { chain, sender } = stack({ automine: false, budgetWei: 10n ** 18n });
    dealing(chain, 1);
    const hash = await sender.send(MANAGER, finalizeData(1));
    chain.holdFinalized();
    // Someone else uses the key's nonce 0; ours is gone from the mempool.
    chain.mempool.splice(0, chain.mempool.length);
    const foreign = await account.signTransaction({
      chainId: 31337,
      type: 'eip1559',
      nonce: 0,
      to: account.address,
      gas: 21_000n,
      maxFeePerGas: 3_000_000_000n,
      maxPriorityFeePerGas: 1n,
    });
    await chain.request('eth_sendRawTransaction', [foreign]);
    chain.mine();
    for (let i = 0; i < 5; i++) await sender.tick();
    // Consumed at the head only: a reorg could still bring ours back, so the reservation stays.
    expect((await sender.status(hash)).status).toBe('pending');
    expect(sender.budget.inFlight()).toBe(WORST);
    chain.releaseFinalized();
    await sender.tick();
    await sender.tick();
    expect((await sender.status(hash)).status).toBe('pending'); // a few passes, not one
    await sender.tick();
    expect(await sender.status(hash)).toMatchObject({ status: 'failed', revertReason: 'replaced or dropped' });
    expect(sender.budget.inFlight()).toBe(0n);
    expect(sender.foreignTransactions).toBe(1);
  });
});

describe('reorgs (audit: keep replayable mined transactions until finality)', () => {
  it('rebroadcasts a reorged-out transaction at its original nonce, so later nonces are not stuck; charges it once', async () => {
    const { chain, sender, store, advance } = stack({ automine: false, budgetWei: 10n ** 18n });
    dealing(chain, 2);
    chain.holdFinalized();
    const a = await sender.send(MANAGER, finalizeData(1));
    chain.mine();
    await sender.tick();
    expect((await sender.status(a)).status).toBe('confirmed');
    expect(sender.awaitingFinality).toBe(1);
    expect(sender.budget.inFlight()).toBe(WORST - ACTUAL); // replayable until final
    // Mined, not final: still replayable from the state file.
    const [kept] = store.state.pending;
    expect(kept?.mined?.hash).toBe(a);
    expect(kept?.raw).not.toBe('0x');
    expect(sender.budget.spent()).toBe(ACTUAL);

    const b = await sender.send(MANAGER, finalizeData(2));
    expect(parseTransaction(chain.sentRaw.at(-1) as Hex).nonce).toBe(1);
    // A reorg removes A's block, and the node does not keep A: B (nonce 1) can never mine alone.
    chain.reorg();
    chain.mine();
    expect(chain.receipts.size).toBe(0);
    // Not final: re-checked every 15 s; absent on two checks, it is replayed at nonce 0.
    advance(15_000);
    await sender.tick();
    expect((await sender.status(a)).status).toBe('confirmed');
    advance(15_000);
    await sender.tick();
    expect(chain.mempool.map((t) => t.nonce).sort()).toEqual([0, 1]);
    expect((await sender.status(a)).status).toBe('pending');
    expect(sender.budget.inFlight()).toBeGreaterThanOrEqual(WORST + (WORST - ACTUAL)); // B, and A beyond its charge
    chain.mine();
    await sender.tick();
    expect((await sender.status(a)).status).toBe('confirmed');
    expect((await sender.status(b)).status).toBe('confirmed');
    expect(chain.manager.calls.map((c) => c.args[0])).toEqual([ceremonyIdOf(1), ceremonyIdOf(1), ceremonyIdOf(2)]);
    // Charged exactly what the canonical receipts cost: A once (not again when re-mined), B once.
    const canonical = [...chain.receipts.values()].reduce(
      (sum, r) => sum + BigInt(r.gasUsed as string) * BigInt(r.effectiveGasPrice as string),
      0n,
    );
    expect(chain.receipts.size).toBe(2);
    expect(sender.budget.spent()).toBe(canonical);
    // Mined, not final: the rest of each worst case stays reserved until finality.
    expect(sender.budget.inFlight()).toBeGreaterThan(0n);
    chain.releaseFinalized();
    await sender.tick();
    expect(sender.awaitingFinality).toBe(0);
    expect(sender.budget.inFlight()).toBe(0n);
    expect(store.state.pending).toEqual([]);
  });

  it('a mined transaction survives a restart until final, and is replayed after a reorg', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'davinci-dkg-council-relayer-'));
    const file = path.join(dir, 'state.json');
    const chain = new MockChain({ automine: false });
    dealing(chain, 1);
    chain.holdFinalized();
    const clock = { t: 1_000_000 };
    const first = stack({ chain, store: new StateStore(file), clock, budgetWei: 10n ** 18n });
    const a = await first.sender.send(MANAGER, finalizeData(1));
    chain.mine();
    await first.sender.tick();
    chain.reorg();
    const second = stack({ chain, store: new StateStore(file), clock, budgetWei: 10n ** 18n });
    expect((await second.sender.status(a)).status).toBe('confirmed');
    expect(second.sender.awaitingFinality).toBe(1);
    await second.sender.tick();
    second.advance(15_000);
    await second.sender.tick();
    chain.mine();
    await second.sender.tick();
    expect((await second.sender.status(a)).status).toBe('confirmed');
    expect(second.sender.budget.spent()).toBe(ACTUAL);
    expect(chain.receipts.size).toBe(1);
  });
});

describe('reorg accounting (review follow-ups)', () => {
  const bumpedWorst = 120_000n * ((3_000_000_000n * 1125n) / 1000n + 1n);

  it('never evicts a transaction before finality; pauses new sends past the cap instead', async () => {
    const chain = new MockChain();
    dealing(chain, 3);
    chain.holdFinalized();
    const sender = new TxSender({ client: chain.client, account, chainId: 31337n, maxFeeWei: 10n ** 11n, bumpAfterMs: 10_000, maxUnfinal: 2 });
    await sender.send(MANAGER, finalizeData(1));
    await sender.send(MANAGER, finalizeData(2));
    await sender.tick();
    expect(sender.awaitingFinality).toBe(2);
    expect((await errorOf(sender.send(MANAGER, finalizeData(3)))).code).toBe('BUSY');
    expect(sender.awaitingFinality).toBe(2); // both still replayable
    chain.releaseFinalized();
    await sender.tick();
    expect(sender.awaitingFinality).toBe(0);
    await sender.send(MANAGER, finalizeData(3));
  });

  it('keeps the highest signed worst case reserved when a bump accepted behind a lost reply is the one mined', async () => {
    const { chain, sender, advance } = stack({ automine: false, budgetWei: 10n ** 18n });
    dealing(chain, 1);
    chain.holdFinalized();
    await sender.send(MANAGER, finalizeData(1));
    advance(10_000);
    chain.loseNextResponse = rpcError(-32603, 'request timed out');
    await sender.tick(); // the replacement reaches the node; the sender never hears so
    chain.mine();
    await sender.tick();
    const [r] = [...chain.receipts.values()];
    const actual = BigInt(r?.gasUsed as string) * BigInt(r?.effectiveGasPrice as string);
    expect(sender.budget.spent()).toBe(actual);
    expect(sender.budget.inFlight()).toBe(bumpedWorst - actual);
  });

  it('charges a replay re-mined after the budget window again, in the new window', async () => {
    const { chain, sender, advance } = stack({ automine: false, budgetWei: 10n ** 18n });
    dealing(chain, 1);
    chain.holdFinalized();
    await sender.send(MANAGER, finalizeData(1));
    chain.mine();
    await sender.tick();
    expect(sender.budget.spent()).toBe(ACTUAL);
    advance(24 * 3_600_000 + 1); // the charge leaves the window; finality never came
    expect(sender.budget.spent()).toBe(0n);
    chain.reorg();
    await sender.tick();
    advance(15_000);
    await sender.tick(); // replayed
    expect(sender.budget.inFlight()).toBe(WORST); // nothing left to credit
    chain.mine();
    await sender.tick();
    expect(sender.budget.spent()).toBe(ACTUAL);
  });

  it('bumps a replayed transaction within a tight budget, crediting what it was already charged', async () => {
    const { chain, sender, advance } = stack({ automine: false, budgetWei: bumpedWorst + 1n });
    dealing(chain, 1);
    chain.holdFinalized();
    await sender.send(MANAGER, finalizeData(1));
    chain.mine();
    await sender.tick();
    chain.reorg();
    advance(15_000);
    await sender.tick();
    advance(15_000);
    await sender.tick(); // replayed at its fees; the node keeps it pending
    expect(chain.sentRaw).toHaveLength(2);
    advance(10_000);
    await sender.tick(); // stuck: bumped, which fits once the earlier charge is credited
    expect(chain.sentRaw).toHaveLength(3);
    expect(parseTransaction(chain.sentRaw[2] as Hex).maxFeePerGas).toBe((3_000_000_000n * 1125n) / 1000n + 1n);
    expect(sender.budget.spent() + sender.budget.inFlight()).toBe(bumpedWorst);
  });

  it('loads a state file written before this release (no finality, exposure or tracking fields)', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'davinci-dkg-council-relayer-'));
    const file = path.join(dir, 'state.json');
    const chain = new MockChain({ automine: false });
    dealing(chain, 1);
    const first = stack({ chain, store: new StateStore(file), budgetWei: 10n ** 18n });
    const hash = await first.sender.send(MANAGER, finalizeData(1), { slots: ['cer:1:phase'] });
    const legacy = JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown> & { pending: Record<string, unknown>[] };
    delete legacy.tracked;
    for (const p of legacy.pending) {
      delete p.firstSentAt;
      delete p.maxWorstWei;
      delete p.charges;
    }
    writeFileSync(file, JSON.stringify(legacy));
    const second = stack({ chain, store: new StateStore(file), budgetWei: 10n ** 18n });
    expect(second.store.state.tracked).toEqual([]);
    expect(second.sender.pendingCount).toBe(1);
    expect(second.sender.budget.inFlight()).toBe(WORST);
    expect((await errorOf(second.sender.send(MANAGER, abortData(1), { slots: ['cer:1:phase'] }))).code).toBe('CONFLICT');
    chain.mine();
    await second.sender.tick();
    expect((await second.sender.status(hash)).status).toBe('confirmed');
    expect(second.sender.budget.spent()).toBe(ACTUAL);
  });
});

describe('monitor loop (audit: no queued passes)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('schedules the next pass only after the previous one completed', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] });
    const { chain, sender } = stack({ automine: false });
    dealing(chain, 1);
    await sender.send(MANAGER, finalizeData(1));
    let passes = 0;
    let release: (() => void) | undefined;
    const orig = chain.request.bind(chain);
    chain.request = async (method, params) => {
      if (method === 'eth_getTransactionCount' && params[1] === 'latest') {
        passes++;
        if (passes === 1) await new Promise<void>((r) => (release = r)); // a very slow RPC
      }
      return orig(method, params);
    };
    sender.start(100);
    await vi.advanceTimersByTimeAsync(2_000); // twenty intervals while the first pass hangs
    expect(passes).toBe(1);
    release?.();
    await vi.advanceTimersByTimeAsync(0);
    expect(passes).toBe(1); // nothing queued behind it
    await vi.advanceTimersByTimeAsync(100);
    expect(passes).toBe(2);
    sender.stop();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(passes).toBe(2);
    expect(sender.monitorStatus()).toMatchObject({ failures: 0 });
  });
});
