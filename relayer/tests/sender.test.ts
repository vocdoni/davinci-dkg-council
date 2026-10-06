import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { encodeAction, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { parseTransaction } from 'viem';
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
