/**
 * v2 schedule features: the create wizard's §8.1 phase choices, the §8.7
 * decryption gate on the member and organizer screens, the §9.3
 * not-submitted state (a bound vote with nothing to unlock must never offer
 * the key button) and §10.4 partial republication.
 */

import {
  buildPartialDecryption,
  partialDataHash,
  Phase,
  PhaseMode,
  recoverShare,
  recoveryDealingsFromSlice,
  type Hex,
} from '@vocdoni/davinci-dkg-council-sdk';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FlowRefusal,
  listRequests,
  participantKeys,
  preparePartial,
  prepareRepublish,
} from '../src/flows/participant';
import { republishCheck } from '../src/lib/chain';
import { resetInviteFragmentForTests } from '../src/lib/inviteCapture';
import { archiveAllRecords } from '../src/lib/records';
import { makeFixture, PROCESS_ID, type Fixture } from './helpers/fake';
import { fixtureRecord, renderApp } from './helpers/render';

URL.createObjectURL = vi.fn(() => 'blob:council-test');
URL.revokeObjectURL = vi.fn();

beforeEach(async () => {
  resetInviteFragmentForTests();
  await archiveAllRecords();
});

const refusalReasons = async (p: Promise<unknown>): Promise<string[]> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof FlowRefusal) return err.reasons;
    throw err;
  }
  throw new Error('expected a FlowRefusal');
};

/** datetime-local string for a unix-ms timestamp (mirrors the wizard's own formatter). */
function localInput(ms: number): string {
  const d = new Date(ms);
  const pad = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** The exact hash the contract stores for member 1's admitted partial of `rid`. */
async function admittedHash(f: Fixture, rid: Hex): Promise<{ hash: Hex; D: { x: bigint; y: bigint }[] }> {
  const keys = participantKeys(f.memberMnemonics[0] as string, f.config, f.cid);
  const snap = await f.chain.getPartialRequestSnapshot(rid, 1, { expectedCeremonyId: f.cid });
  const { qual, dealings } = recoveryDealingsFromSlice(await f.chain.getRecoverySlice(f.cid, 1));
  const share = recoverShare({
    ctx: f.chain.view.ctx,
    memberIndex: 1,
    shareSecret: keys.share.secret,
    qual,
    dealings,
    aggregates: await f.chain.getAggregates(),
    expectedMemberKey: snap.memberKey,
  }).share;
  const built = buildPartialDecryption(snap, share, { chainId: f.chain.chainId, manager: f.chain.manager });
  const hash = partialDataHash({
    chainId: f.chain.chainId,
    manager: f.chain.manager,
    ceremonyId: f.cid,
    requestId: rid,
    participantIndex: 1,
    fieldCount: snap.fieldCount,
    D: built.D,
  });
  return { hash, D: built.D };
}

describe('request states (§9.3)', () => {
  it('marks a bound-but-not-submitted vote and keeps its label', async () => {
    const f = makeFixture();
    f.addRequest([5n], { submitted: false });
    const list = await listRequests(f.services, f.cid, 1);
    expect(list).toHaveLength(1);
    expect(list[0]?.notSubmitted).toBe(true);
    // The origin is safe to show (every prior binding check passed in order).
    expect(list[0]?.processId?.toLowerCase()).toBe(PROCESS_ID.toLowerCase());
    expect(list[0]?.myPartialDone).toBe(false);
  });

  it('refuses to turn a key while the decryption gate is closed (§8.7)', async () => {
    const f = makeFixture({ policy: { manualOpenedAt: 0n } });
    const rid = f.addRequest([5n]);
    const reasons = await refusalReasons(preparePartial(f.memberMnemonics[0] as string, f.services, f.cid, rid));
    expect(reasons[0]).toMatch(/nothing was revealed/);
    expect(reasons[1]).toMatch(/gate is closed/);
  });
});

describe('republish (§10.4)', () => {
  it('rebuilds exactly the admitted data', async () => {
    const f = makeFixture();
    const rid = f.addRequest([5n]);
    const { hash, D } = await admittedHash(f, rid);
    f.chain.partials.set(`${rid.toLowerCase()}:1`, { accepted: true, dataHash: hash, publishedBlock: 0n });
    const prepared = await prepareRepublish(f.memberMnemonics[0] as string, f.services, f.cid, rid);
    expect(prepared.participantIndex).toBe(1);
    expect(prepared.action.kind).toBe('publishPartialData');
    if (prepared.action.kind === 'publishPartialData') {
      expect(prepared.action.requestId).toBe(rid);
      expect(prepared.action.D).toEqual(D);
    }
  });

  it('history pruned everywhere: the check says unverifiable and the original vector is rebuilt from state (M-01)', async () => {
    const f = makeFixture();
    const rid = f.addRequest([5n]);
    const { hash, D } = await admittedHash(f, rid);
    f.chain.partials.set(`${rid.toLowerCase()}:1`, { accepted: true, dataHash: hash, publishedBlock: 123n });
    f.chain.published.set(`${rid.toLowerCase()}:1`, D);
    f.chain.historyError = 'history pruned';
    const check = await republishCheck(f.chain, f.cid, rid, 1, 1);
    expect(check).toEqual({ state: 'unverifiable', publishedBlock: 123n });
    const prepared = await prepareRepublish(f.memberMnemonics[0] as string, f.services, f.cid, rid);
    expect(prepared.publishedBlock).toBe(123n);
    expect(prepared.action.kind === 'publishPartialData' && prepared.action.D).toEqual(D);
    // With history readable again the same data is available: nothing to republish.
    f.chain.historyError = null;
    expect((await republishCheck(f.chain, f.cid, rid, 1, 1)).state).toBe('not-needed');
  });

  it('refuses when nothing was admitted or the rebuilt data differs', async () => {
    const f = makeFixture();
    const rid = f.addRequest([5n]);
    expect((await refusalReasons(prepareRepublish(f.memberMnemonics[0] as string, f.services, f.cid, rid)))[0]).toMatch(
      /nothing to republish/,
    );
    f.chain.partials.set(`${rid.toLowerCase()}:1`, {
      accepted: true,
      dataHash: `0x${'aa'.repeat(32)}` as Hex,
      publishedBlock: 0n,
    });
    expect((await refusalReasons(prepareRepublish(f.memberMnemonics[0] as string, f.services, f.cid, rid)))[0]).toMatch(
      /does not match what you originally published/,
    );
  });
});

describe('create wizard (§8.1 schedule)', () => {
  it('sends the v2 schedule fields with the defaults', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ phase: Phase.Registration });
    await renderApp(f, '/new', { mnemonic: f.organizerMnemonic });
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    // The review restates the schedule before anything is sent.
    expect(document.body.textContent).toMatch(/Joining closes on/);
    expect(document.body.textContent).toMatch(/or they unlock automatically on/);
    await user.click(await screen.findByRole('button', { name: 'Create the committee' }));
    await waitFor(() => expect(f.actions).toHaveLength(1));
    const a = f.actions[0];
    expect(a?.kind).toBe('createCeremony');
    if (a?.kind === 'createCeremony') {
      const now = BigInt(Math.floor(Date.now() / 1000));
      expect(a.message.registrationMode).toBe(PhaseMode.Scheduled as number);
      expect(a.message.registrationDeadline).toBeGreaterThan(now);
      expect(a.message.decryptionMode).toBe(PhaseMode.Manual as number);
      expect(a.message.decryptionOpenAt).toBe(0n);
      // The safety date defaults ON: the organizer disappearing never locks results forever.
      expect(a.message.manualDecryptionFallbackAt).toBeGreaterThan(now);
    }
  });

  it('validates the schedule and warns about a missing safety date', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ phase: Phase.Registration });
    await renderApp(f, '/new', { mnemonic: f.organizerMnemonic });

    // Scheduled results in the past: blocked with a friendly message.
    await user.click(await screen.findByLabelText(/From a date I pick — nobody needs me/));
    fireEvent.change(screen.getByLabelText('Results can be opened from'), {
      target: { value: localInput(Date.now() - 3600_000) },
    });
    await screen.findByText('The results opening date must be in the future.');
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(true);

    // Before the joining deadline plus the contribution window: still blocked.
    fireEvent.change(screen.getByLabelText('Results can be opened from'), {
      target: { value: localInput(Date.now() + 49 * 3600_000) }, // deadline +48h, window 24h
    });
    await screen.findByText(/must be after joining closes plus the contribution window/);

    // Manual joining without an automatic cutoff: explained, not blocked.
    await user.click(screen.getByLabelText(/close joining myself/));
    await user.click(screen.getByLabelText(/close automatically on a date/)); // uncheck
    await screen.findByText(/no automatic cutoff/);

    // Manual results with the safety date off: the consequence is stated.
    await user.click(screen.getByLabelText(/open the results myself/));
    await user.click(screen.getByLabelText(/safety date, in case I never do/)); // uncheck
    await screen.findByText(/can never be opened if you lose access or disappear/);
    expect((screen.getByRole('button', { name: 'Continue' }) as HTMLButtonElement).disabled).toBe(false);
  });
});

describe('organizer dashboard (schedule)', () => {
  it('scheduled joining: no lock button, the automatic close is explained', async () => {
    const f = makeFixture({ phase: Phase.Registration, policy: { registrationMode: PhaseMode.Scheduled as number } });
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    await screen.findByText(/Joining closes by itself on/);
    expect(screen.queryByRole('button', { name: /lock the member list/ })).toBeNull();
  });

  it('manual results: opening needs an explicit, irreversible confirmation', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ policy: { manualOpenedAt: 0n } });
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });

    await user.click(await screen.findByRole('button', { name: 'Open the results now' }));
    // The consequence is stated before the confirming button, and nothing was sent yet.
    await screen.findByText('Opening the results cannot be undone.');
    expect(f.actions).toHaveLength(0);
    await user.click(screen.getByRole('button', { name: /I understand — open the results/ }));
    await waitFor(() => expect(f.actions).toHaveLength(1));
    const a = f.actions[0];
    expect(a?.kind).toBe('openDecryption');
    if (a?.kind === 'openDecryption') {
      expect(a.message.ceremonyId).toBe(f.cid);
      // The bearer instruction is short-lived and built at the moment of opening.
      const now = BigInt(Math.floor(Date.now() / 1000));
      expect(a.message.validUntil).toBeGreaterThan(now);
      expect(a.message.validUntil).toBeLessThanOrEqual(now + 900n);
    }
    await screen.findByText(/You opened the results\./);
  });
});

describe('unlock screen states (§8.7/§9.3)', () => {
  const member = (f: Fixture) => ({
    mnemonic: f.memberMnemonics[0] as string,
    record: fixtureRecord(f, 'participant', 1),
  });

  it('a not-submitted vote shows waiting copy and never an unlock button', async () => {
    const f = makeFixture();
    f.addRequest([5n], { submitted: false });
    await renderApp(f, `/c/${f.cid}`, member(f));
    await screen.findByText(/has not sent in its locked results yet/);
    expect(document.body.textContent).toContain('Vote #1');
    expect(screen.queryByRole('button', { name: /turn my key/ })).toBeNull();
  });

  it('a scheduled lock shows the date and offers no button', async () => {
    const openAt = BigInt(Math.floor(Date.now() / 1000) + 86400);
    const f = makeFixture({
      policy: { decryptionMode: PhaseMode.Scheduled as number, decryptionOpenAt: openAt, manualOpenedAt: 0n },
    });
    f.addRequest([5n]);
    await renderApp(f, `/c/${f.cid}`, member(f));
    expect((await screen.findAllByText(/the results are locked until/)).length).toBeGreaterThan(0);
    // Honest about what the date is: a rule members honor, not a lock inside the math.
    await screen.findByText(/relies on them honoring it/);
    expect(screen.queryByRole('button', { name: /turn my key/ })).toBeNull();
  });

  it('a manual lock names the organizer and the safety date', async () => {
    const fallback = BigInt(Math.floor(Date.now() / 1000) + 86400);
    const f = makeFixture({ policy: { manualOpenedAt: 0n, manualDecryptionFallbackAt: fallback } });
    f.addRequest([5n]);
    await renderApp(f, `/c/${f.cid}`, member(f));
    expect((await screen.findAllByText(/locked until the organizer opens them — or until/)).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: /turn my key/ })).toBeNull();
  });

  it('offers republication when every historical read is refused, and sends the original vector (M-01)', async () => {
    const user = userEvent.setup();
    const f = makeFixture();
    const rid = f.addRequest([5n]);
    (f.chain.requests.get(rid.toLowerCase()) as { partialBitmap: number }).partialBitmap = 0b011;
    const { hash, D } = await admittedHash(f, rid);
    f.chain.partials.set(`${rid.toLowerCase()}:1`, { accepted: true, dataHash: hash, publishedBlock: 77n });
    f.chain.historyError = 'history pruned';
    await renderApp(f, `/c/${f.cid}`, member(f));
    await screen.findByText(/cannot check whether the copy the others need/);
    await user.click(await screen.findByRole('button', { name: 'Help finish opening the results' }));
    await waitFor(() => expect(f.actions).toHaveLength(1));
    const sent = f.actions[0];
    expect(sent?.kind).toBe('publishPartialData');
    if (sent?.kind === 'publishPartialData') {
      expect(sent.requestId).toBe(rid);
      expect(sent.participantIndex).toBe(1);
      expect(sent.D).toEqual(D);
    }
    await screen.findByText(/Your unlock data was re-sent/);
  });

  it('offers to republish missing unlock data and refuses a mismatch', async () => {
    const user = userEvent.setup();
    const f = makeFixture();
    const rid = f.addRequest([5n]);
    // Both needed members turned their key, but member 1's admitted data is
    // gone and the results never opened: §10.4 republication applies.
    (f.chain.requests.get(rid.toLowerCase()) as { partialBitmap: number }).partialBitmap = 0b011;
    f.chain.partials.set(`${rid.toLowerCase()}:1`, {
      accepted: true,
      dataHash: `0x${'aa'.repeat(32)}` as Hex,
      publishedBlock: 0n,
    });
    await renderApp(f, `/c/${f.cid}`, member(f));
    await user.click(await screen.findByRole('button', { name: 'Help finish opening the results' }));
    // The stored commitment does not match what this device rebuilds: hard refusal.
    await screen.findByText(/does not match what you originally published/);
    expect(f.actions).toHaveLength(0);
  });
});
