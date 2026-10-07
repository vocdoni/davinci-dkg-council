/**
 * Usability-review regressions: the stale-kit banner never cries wolf (P0-1),
 * votes get names or ordinals (P0-2), waiting copy matches its own counters
 * (P1-1) and reminder buttons exist only while a step is pending (P1-4).
 */

import { NotFinalizedYetError, Phase } from '@vocdoni/davinci-dkg-council-sdk';
import { screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildKitForRecords, manifestFingerprint } from '../src/flows/kit';
import { resetInviteFragmentForTests } from '../src/lib/inviteCapture';
import { archiveAllRecords, getVoteLabels, setVoteLabel } from '../src/lib/records';
import { makeFixture, MANAGER, PROCESS_ID } from './helpers/fake';
import { fixtureRecord, renderApp } from './helpers/render';

URL.createObjectURL = vi.fn(() => 'blob:council-test');
URL.revokeObjectURL = vi.fn();

beforeEach(async () => {
  resetInviteFragmentForTests();
  // Records persist in the fake IDB across tests; the kit covers every active
  // record on the device, so leftovers would skew the fingerprint tests.
  await archiveAllRecords();
});

describe('manifest fingerprint (P0-1)', () => {
  it('ignores chain-recoverable fields and reacts to new committees', () => {
    const f = makeFixture();
    const base = fixtureRecord(f, 'participant');
    const mnemonic = f.memberMnemonics[0] as string;
    const fp = (records: Parameters<typeof buildKitForRecords>[1], extras = {}) =>
      manifestFingerprint(buildKitForRecords(mnemonic, records, extras).manifest);

    // participantIndex and rosterHash are re-derived on restore — no nudge.
    expect(fp([{ ...base, participantIndex: 2 }])).toBe(fp([base]));
    expect(fp([base], { [base.key]: { rosterHash: f.rosterHash } })).toBe(fp([base]));
    // A new committee under the same root genuinely needs a fresh export.
    const other = { ...base, cid: `0x${'cd'.repeat(12)}` as `0x${string}`, key: `${base.key}x` };
    expect(fp([base, other])).not.toBe(fp([base]));
  });
});

describe('kit banners (P0-1)', () => {
  it('says "no saved kit yet" after a words-only restore, never "save a fresh copy"', async () => {
    const f = makeFixture();
    await renderApp(f, `/c/${f.cid}`, {
      mnemonic: f.memberMnemonics[0] as string,
      record: fixtureRecord(f, 'participant', 1), // no kitExportFingerprint
    });
    await screen.findByText(/This device has no saved kit yet/);
    expect(screen.queryByText(/save a fresh copy/)).toBeNull();
  });

  it('never re-prompts right after joining (the kit saved while joining covers the record)', async () => {
    const f = makeFixture();
    const mnemonic = f.memberMnemonics[0] as string;
    const record = fixtureRecord(f, 'participant', 1);
    record.kitExportFingerprint = manifestFingerprint(buildKitForRecords(mnemonic, [record]).manifest);
    record.kitJoinNudge = true; // legacy flag from an older release: ignored
    await renderApp(f, `/c/${f.cid}`, { mnemonic, record });
    await screen.findByText(/Recovery kit/);
    expect(screen.queryByText(/after saving your kit|save a fresh copy|no saved kit yet/)).toBeNull();
  });

  it('stays silent when the saved kit covers this device', async () => {
    const f = makeFixture();
    const mnemonic = f.memberMnemonics[0] as string;
    const record = fixtureRecord(f, 'participant', 1);
    record.kitExportFingerprint = manifestFingerprint(buildKitForRecords(mnemonic, [record]).manifest);
    await renderApp(f, `/c/${f.cid}`, { mnemonic, record });
    await screen.findByText(/Recovery kit/);
    expect(screen.queryByText(/no saved kit yet|save a fresh copy|after saving your kit/)).toBeNull();
  });
});

describe('vote names (P0-2)', () => {
  it('falls back to an ordinal and says it is the member’s turn', async () => {
    const f = makeFixture();
    f.addRequest([7n, 0n, 3n]);
    await renderApp(f, `/c/${f.cid}`, {
      mnemonic: f.memberMnemonics[0] as string,
      record: fixtureRecord(f, 'participant', 1),
    });
    await screen.findByText('Vote #1 (0xcdcdcd…cdcd)');
    await screen.findByText(/turned their key — your turn\./);
  });

  it('shows the organizer-typed local label instead', async () => {
    const f = makeFixture();
    f.addRequest([7n]);
    await setVoteLabel(f.config.chainId, f.config.manager, f.cid, PROCESS_ID, 'City budget');
    expect((await getVoteLabels(f.config.chainId, f.config.manager, f.cid))[PROCESS_ID.toLowerCase()]).toBe(
      'City budget',
    );
    await renderApp(f, `/c/${f.cid}`, {
      mnemonic: f.memberMnemonics[0] as string,
      record: fixtureRecord(f, 'participant', 1),
    });
    await screen.findByText('City budget');
  });
});

describe('DAVINCI vote titles (2026-10-07 production run)', () => {
  it('member: shows the verified process title instead of the raw id', async () => {
    const f = makeFixture();
    f.addRequest([7n]);
    f.services.voteTitle = async () => 'Board election 2026';
    await renderApp(f, `/c/${f.cid}`, {
      mnemonic: f.memberMnemonics[0] as string,
      record: fixtureRecord(f, 'participant', 1),
    });
    await screen.findByText('Board election 2026');
  });

  it('a local label still wins over the fetched title', async () => {
    const f = makeFixture();
    f.addRequest([7n]);
    f.services.voteTitle = async () => 'Board election 2026';
    await setVoteLabel(f.config.chainId, f.config.manager, f.cid, PROCESS_ID, 'City budget');
    await renderApp(f, `/c/${f.cid}`, {
      mnemonic: f.memberMnemonics[0] as string,
      record: fixtureRecord(f, 'participant', 1),
    });
    await screen.findByText('City budget');
    expect(screen.queryByText('Board election 2026')).toBeNull();
  });
});

describe('organizer dashboard order (2026-10-07 production run)', () => {
  it('pairing is the obvious step; open-results and raw connections sit behind Advanced', async () => {
    const f = makeFixture({ davinci: true, policy: { manualOpenedAt: 0n } });
    f.addRequest([7n]);
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    const pairing = await screen.findByText('Connect to DAVINCI Elections');
    const advanced = await screen.findByText('Advanced');
    // The pairing card comes before the Advanced disclosure in the page.
    expect(pairing.compareDocumentPosition(advanced) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const details = advanced.closest('details');
    expect(details).not.toBeNull();
    // Both irreversible paths live inside the disclosure.
    expect(details?.contains(screen.getByRole('button', { name: 'Open the results now' }))).toBe(true);
    expect(details?.contains(screen.getByText('Connections'))).toBe(true);
    // A locked vote points at the disclosure, not "above".
    await screen.findByText(/open the results from the Advanced section below/);
  });

  it('without a pairing card the raw connections stay visible outside Advanced', async () => {
    const f = makeFixture({ policy: { manualOpenedAt: 0n } });
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    const connections = await screen.findByText('Connections');
    expect(connections.closest('details')).toBeNull();
    const advanced = await screen.findByText('Advanced');
    expect(advanced.closest('details')?.contains(screen.getByRole('button', { name: 'Open the results now' }))).toBe(
      true,
    );
  });
});

describe('waiting copy matches the counters (P1-1, P1-4)', () => {
  it('participant: all contributions in → "Finish the key" copy, not "waiting for the others"', async () => {
    const f = makeFixture({ phase: Phase.Dealing });
    f.chain.view = { ...f.chain.view, qualBitmap: 0b111 };
    await renderApp(f, `/c/${f.cid}`, {
      mnemonic: f.memberMnemonics[0] as string,
      record: fixtureRecord(f, 'participant', 1),
    });
    await screen.findByText(/All 3 contributions are in\. Next, someone presses/);
    expect(screen.queryByText(/waiting for the others/)).toBeNull();
  });

  it('organizer: all contributions in → "finish the key below" and no reminder buttons', async () => {
    const f = makeFixture({ phase: Phase.Dealing });
    f.chain.view = { ...f.chain.view, qualBitmap: 0b111 };
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    await screen.findByText(/All 3 contributions are in — finish the key below\./);
    expect(screen.queryByText(/Remind the missing ones/)).toBeNull();
    expect(screen.queryByRole('button', { name: /Remind|Nudge|^Invite$/ })).toBeNull();
  });

  it('organizer in Live: no invite or reminder buttons at all', async () => {
    const f = makeFixture();
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    await screen.findByText(/The key is ready/);
    expect(screen.queryByRole('button', { name: /Remind|Nudge|^Invite$/ })).toBeNull();
  });
});

describe('waiting for the network to confirm (never a failure)', () => {
  const CONFIRMING = /Waiting for the network to confirm — usually about 4 minutes on Gnosis/;

  it('a not-yet-finalized deployment shows the confirming note and keeps polling', async () => {
    const f = makeFixture();
    f.chain.getCeremony = async () => {
      throw new NotFinalizedYetError(MANAGER, 10n, 20n);
    };
    await renderApp(f, `/c/${f.cid}`);
    await screen.findByText(CONFIRMING);
    expect(screen.queryByText(/could not reach the public record/)).toBeNull();
  });

  it('a just-created committee not yet visible at the confirmed height shows the same note', async () => {
    const f = makeFixture();
    f.chain.view = { ...f.chain.view, phase: Phase.None };
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    await screen.findByText(CONFIRMING);
    expect(screen.queryByText(/does not exist here/)).toBeNull();
  });
});
