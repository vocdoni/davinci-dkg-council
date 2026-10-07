/**
 * The relayer's scheduler (architecture §5.2): a fully scheduled ceremony whose permissionless
 * transitions — the time-based close, the early finalize and a timeout abort — are sent by the
 * scheduler of the relayer that sponsored it, with nobody calling them; the decryption gate then
 * opens at its scheduled date with no transaction at all.
 *
 * The suite's main relayer keeps its scheduler off (it would race the abort tests), so this file
 * starts a dedicated relayer on its own funded account: the scheduler only watches ceremonies its
 * own relayer sponsored. The shared Anvil runs `--slots-in-an-epoch 0`, so `finalized` == latest
 * and the scheduler's finalized-anchor reads see every warp immediately.
 */

import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { COUNCIL_MANAGER_ABI, PhaseMode, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { anvilAccount, anvilKey } from '../src/accounts.js';
import { Member, Organizer } from '../src/actors.js';
import { recordGas } from '../src/gas.js';
import { Harness } from '../src/harness.js';
import { LOG_DIR, startRelayer, type RelayerProcess } from '../src/infra.js';

const PHASE = { Registration: 1, Dealing: 2, Live: 3, Aborted: 4 } as const;
/** A funded Anvil account no other service uses (the main relayer holds account 1). */
const SCHEDULER_ACCOUNT = 6;

describe('scheduled transitions fired by the relayer scheduler', () => {
  const ctx = inject('council');
  let sched: RelayerProcess;
  let h: Harness;

  beforeAll(async () => {
    sched = await startRelayer(
      {
        COUNCIL_RPC_URL: ctx.rpcUrl,
        COUNCIL_MANAGER_ADDRESS: ctx.manager,
        COUNCIL_PRIVATE_KEY: anvilKey(SCHEDULER_ACCOUNT),
        COUNCIL_DATA_DIR: mkdtempSync(path.join(tmpdir(), 'council-e2e-scheduler-')),
        COUNCIL_SCHEDULER_ENABLED: 'true',
        COUNCIL_SCHEDULER_POLL_MS: '300',
        COUNCIL_TX_POLL_MS: '200',
        COUNCIL_DAILY_BUDGET_WEI: (100n * 10n ** 18n).toString(),
        COUNCIL_RATE_LIMIT: '1000',
        COUNCIL_CEREMONY_RATE_LIMIT: '1000',
        COUNCIL_INGRESS_RATE_LIMIT: '100000',
      },
      { logDir: path.join(LOG_DIR, 'scheduler') },
    );
    // Every relayed action of this file goes through the dedicated relayer, so its scheduler
    // watches exactly the ceremonies created here.
    h = new Harness({
      ...ctx,
      relayerUrl: sched.url,
      relayerAddress: anvilAccount(SCHEDULER_ACCOUNT).address.toLowerCase() as Hex,
    });
  }, 60_000);

  afterAll(async () => {
    await sched?.stop();
  });

  const waitPhase = async (cid: Hex, phase: number, timeoutMs = 60_000): Promise<void> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      if ((await h.reader.getCeremony(cid)).phase === phase) return;
      if (Date.now() > deadline) throw new Error(`ceremony ${cid} did not reach phase ${phase} in time`);
      await new Promise((r) => setTimeout(r, 250));
    }
  };

  /** The one transaction that emitted `eventName` for this ceremony; asserts the scheduler sent it. */
  const schedulerTx = async (cid: Hex, eventName: string) => {
    const [log, ...rest] = await h.client.getContractEvents({
      address: h.manager,
      abi: COUNCIL_MANAGER_ABI,
      eventName: eventName as never,
      args: { cid } as never,
      fromBlock: 0n,
    });
    expect(rest).toEqual([]);
    if (!log) throw new Error(`no ${eventName} event for ${cid}`);
    const hash = (log as unknown as { transactionHash: Hex }).transactionHash;
    const receipt = await h.client.waitForTransactionReceipt({ hash });
    expect(receipt.from.toLowerCase()).toBe(h.relayerAddress);
    return receipt;
  };

  it('a fully scheduled n=2, t=2 ceremony: the scheduler closes at the deadline and finalizes early at QUAL = n', async () => {
    const organizer = new Organizer(h);
    const now = await h.now();
    const { cid, action } = await organizer.create({
      threshold: 2,
      invites: 2,
      registrationMode: PhaseMode.Scheduled,
      registrationWindow: 60n,
      dealingDuration: 600n,
      decryptionMode: PhaseMode.Scheduled,
      decryptionOpenAt: now + 720n, // strictly past registrationDeadline + dealingDuration (§8.1)
    });
    await h.submit(action, 'relayer', { action: 'createCeremony', params: 'invites=2' });
    const members = [new Member(h, cid), new Member(h, cid)];
    for (const [i, m] of members.entries()) {
      await h.submit(await m.join(organizer.inviteLink(cid, i)), 'relayer', { action: 'join' });
    }

    // Scheduled registration: the organizer's manual close is the wrong mode, and the
    // permissionless time-close is not due before the deadline.
    await h.expectRelayRevert(await organizer.close(cid, 2), 'WrongMode');
    await h.expectRelayRevert({ kind: 'closeRegistrationScheduled', ceremonyId: cid }, 'RegistrationNotDue');

    // Past the deadline the scheduler closes by itself: nobody calls anything.
    await h.warp(61n);
    await waitPhase(cid, PHASE.Dealing);
    const closeReceipt = await schedulerTx(cid, 'RegistrationClosed');
    recordGas('closeRegistrationScheduled', 'n=2', 'relayer (scheduler)', closeReceipt.gasUsed);

    // Both deal: QUAL = n, so the scheduler finalizes early, well before the dealing deadline.
    for (const m of members) await h.submit(await m.deal(), 'relayer', { action: 'deal', params: 'n=2, t=2' });
    await waitPhase(cid, PHASE.Live);
    await schedulerTx(cid, 'CeremonyFinalized');

    // Scheduled decryption opens by predicate alone: no transaction, no event — and the manual
    // opener is refused in this mode.
    expect(await h.reader.isDecryptionOpen(cid)).toBe(false);
    await h.expectRelayRevert(await organizer.openDecryption(cid), 'WrongMode');
    const { decryptionOpenAt } = await h.reader.getPolicy(cid);
    await h.warp(decryptionOpenAt - (await h.now()) + 1n);
    expect(await h.reader.isDecryptionOpen(cid)).toBe(true);
    const opened = await h.client.getContractEvents({
      address: h.manager,
      abi: COUNCIL_MANAGER_ABI,
      eventName: 'DecryptionOpened',
      args: { cid } as never,
      fromBlock: 0n,
    });
    expect(opened).toEqual([]);
  }, 300_000);

  it('a scheduled registration that misses t by its deadline is aborted by the scheduler', async () => {
    const organizer = new Organizer(h);
    const { cid, action } = await organizer.create({
      threshold: 2,
      invites: 2,
      registrationMode: PhaseMode.Scheduled,
      registrationWindow: 60n,
      dealingDuration: 600n,
    });
    await h.submit(action, 'relayer', { action: 'createCeremony', params: 'invites=2' });
    await h.submit(await new Member(h, cid).join(organizer.inviteLink(cid, 0)), 'relayer', { action: 'join' });

    await h.warp(61n); // one member < t = 2 at the deadline: abort is due, close never is
    await waitPhase(cid, PHASE.Aborted);
    const receipt = await schedulerTx(cid, 'CeremonyAborted');
    recordGas('abort', 'in Registration', 'relayer (scheduler)', receipt.gasUsed);
  }, 120_000);
});
