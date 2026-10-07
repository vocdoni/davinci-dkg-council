/**
 * Months between the key ceremony and the opening (ops review P0/P1): members are reminded to
 * check their recovery words before the opening date (in the app and with a calendar file), and
 * the organizer can save and load the names that exist only on their device.
 */

import { Phase, PhaseMode, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { checkWordsAt, reminderCalendar } from '../src/lib/calendar';
import { resetInviteFragmentForTests } from '../src/lib/inviteCapture';
import {
  exportOrganizerRecord,
  importOrganizerRecord,
  parseOrganizerRecord,
  type OrganizerRecordFile,
} from '../src/lib/organizerRecord';
import { archiveAllRecords, getInviteMapping, getLabels, getVoteLabels, setLabel, setVoteLabel } from '../src/lib/records';
import { makeFixture, PROCESS_ID } from './helpers/fake';
import { fixtureRecord, renderApp } from './helpers/render';

vi.mock('../src/lib/download', () => ({
  downloadTextFile: vi.fn(),
  printTextSheet: vi.fn(() => false),
  copyToClipboard: vi.fn(async () => true),
}));
import { downloadTextFile } from '../src/lib/download';

beforeEach(async () => {
  resetInviteFragmentForTests();
  await archiveAllRecords();
  vi.mocked(downloadTextFile).mockClear();
});

const DAY = 86_400;
const now = () => Math.floor(Date.now() / 1000);

describe('calendar reminder file', () => {
  const opening = 1_800_000_000; // 2027-01-15T08:00:00Z
  const ics = reminderCalendar({
    openingAt: opening,
    committee: 'Budget; council, 2027',
    link: 'https://app.example/c/0xabababababababababababab',
    uid: '0xabababababababababababab',
    now: opening - 60 * DAY,
  });

  it('is a well-formed iCalendar file: CRLF, folded at 75 octets, two events with alarms', () => {
    expect(ics.startsWith('BEGIN:VCALENDAR\r\n')).toBe(true);
    expect(ics.endsWith('END:VCALENDAR\r\n')).toBe(true);
    expect(ics.replace(/\r\n/g, '')).not.toMatch(/[\r\n]/);
    for (const line of ics.split('\r\n')) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(ics.match(/BEGIN:VEVENT/g)).toHaveLength(2);
    expect(ics.match(/BEGIN:VALARM/g)).toHaveLength(2);
    const unfolded = ics.replace(/\r\n /g, '');
    expect(unfolded).toContain('DTSTART:20270101T080000Z'); // check the words two weeks before
    expect(unfolded).toContain('DTSTART:20270115T080000Z'); // the opening, alarm the day before
    expect(unfolded).toContain('TRIGGER:-P1D');
    expect(unfolded).toContain('SUMMARY:Check your recovery words (Budget\\; council\\, 2027)');
    expect(unfolded).toContain('URL:https://app.example/c/0xabababababababababababab');
    expect(unfolded).not.toMatch(/#v1\./);
  });

  it('checks halfway to the opening when it is less than four weeks away', () => {
    expect(checkWordsAt(opening, opening - 60 * DAY)).toBe(opening - 14 * DAY);
    expect(checkWordsAt(opening, opening - 10 * DAY)).toBe(opening - 5 * DAY);
  });
});

describe('member reminder before the opening date', () => {
  const member = (openAt: bigint) => {
    const f = makeFixture({
      policy: { decryptionMode: PhaseMode.Scheduled as number, decryptionOpenAt: openAt, manualOpenedAt: 0n },
    });
    return { f, mnemonic: f.memberMnemonics[0] as string, record: fixtureRecord(f, 'participant', 1) };
  };

  it('asks to check the words, checks them, and offers the calendar file', async () => {
    const user = userEvent.setup();
    const { f, mnemonic, record } = member(BigInt(now() + 60 * DAY));
    await renderApp(f, `/c/${f.cid}`, { mnemonic, record });
    await screen.findByText('Before the results open');

    await user.click(screen.getByRole('button', { name: 'Check my words' }));
    const box = screen.getByLabelText('Type your twelve recovery words to check them');
    await user.click(box);
    await user.paste(f.memberMnemonics[1] as string); // someone else's valid words
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await screen.findByText(/Those words do not rebuild your key/);
    expect(box).toHaveValue(''); // the words do not linger on screen
    await user.click(box);
    await user.paste(mnemonic.toUpperCase());
    await user.click(screen.getByRole('button', { name: 'Check' }));
    await screen.findByText(/Those are the right words/);

    await user.click(screen.getByRole('button', { name: 'Add a reminder to my calendar' }));
    const [name, text, mime] = vi.mocked(downloadTextFile).mock.calls.at(-1) ?? [];
    expect(name).toMatch(/\.ics$/);
    expect(mime).toBe('text/calendar');
    expect(text).toContain(`/c/${f.cid}`);
    expect(text).not.toContain(mnemonic.split(' ')[0] as string);
  });

  it('insists in the last two weeks', async () => {
    const { f, mnemonic, record } = member(BigInt(now() + 5 * DAY));
    await renderApp(f, `/c/${f.cid}`, { mnemonic, record });
    await screen.findByText('The results open soon — check your recovery words now');
  });

  it('is gone once the results can be opened', async () => {
    const f = makeFixture(); // manual, already opened
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.memberMnemonics[0] as string, record: fixtureRecord(f, 'participant', 1) });
    await screen.findByText(/Unlock requests/);
    expect(screen.queryByText(/Before the results open|check your recovery words now/)).toBeNull();
  });
});

describe('organizer record', () => {
  it('exports the local-only names and links with the public facts, and nothing secret', async () => {
    const f = makeFixture();
    const record = fixtureRecord(f, 'organizer');
    await setLabel(f.config.chainId, f.config.manager, f.cid, 0, 'Alice');
    await setVoteLabel(f.config.chainId, f.config.manager, f.cid, PROCESS_ID, 'City budget');
    const policy = await f.chain.getPolicy();
    const file = await exportOrganizerRecord({ ...record, name: 'Town council' }, f.config, {
      view: f.chain.view,
      policy,
      appUrl: 'https://app.example',
    });
    expect(file.inviteLabels).toEqual({ '0': 'Alice' });
    expect(file.voteLabels).toEqual({ [PROCESS_ID.toLowerCase()]: 'City budget' });
    expect(file.committee).toMatchObject({ ceremonyId: f.cid, name: 'Town council', threshold: 2, link: `https://app.example/c/${f.cid}` });
    const text = JSON.stringify(file);
    expect(text).not.toMatch(/#v1\./);
    expect(text).not.toContain(f.organizerMnemonic);
    expect(parseOrganizerRecord(text)).toEqual(file);
  });

  it('loads on another device and keeps names linked when the join history is gone', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ phase: Phase.Dealing });
    const file: OrganizerRecordFile = {
      format: 'davinci-dkg-council-organizer-record/v1',
      exportedAt: new Date().toISOString(),
      deployment: {
        chainId: String(f.config.chainId),
        manager: f.config.manager,
        appUrl: 'https://app.example',
        deploymentBlock: 0,
        relayerUrls: [],
        artifactsBaseUrls: [],
      },
      committee: { ceremonyId: f.cid, link: `https://app.example/c/${f.cid}`, name: 'Town council' },
      inviteLabels: { '0': 'Alice', '1': 'Bob', '2': 'Carol' },
      // Bob joined with invitation 2 and Carol with 1 — only this record knows.
      inviteMapping: [
        { index: 1, auth: f.memberKeys[0]?.auth.address as Hex, inviteId: 0 },
        { index: 2, auth: f.memberKeys[1]?.auth.address as Hex, inviteId: 2 },
        { index: 3, auth: f.memberKeys[2]?.auth.address as Hex, inviteId: 1 },
      ],
      voteLabels: {},
    };
    // The provider refuses every historical read: no join events at all.
    f.services.joinedEvents = async () => Promise.reject(new Error('history pruned'));
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    const input = screen.getByLabelText('Organizer record file') as HTMLInputElement;
    await user.upload(input, new File([JSON.stringify(file)], 'record.json', { type: 'application/json' }));
    await screen.findByText(/Loaded 3 names, 3 invitation links and 0 vote names/);
    expect(await getLabels(f.config.chainId, f.config.manager, f.cid)).toEqual({ 0: 'Alice', 1: 'Bob', 2: 'Carol' });
    expect((await getInviteMapping(f.config.chainId, f.config.manager, f.cid)).map((m) => m.inviteId)).toEqual([0, 2, 1]);
    expect(await getVoteLabels(f.config.chainId, f.config.manager, f.cid)).toEqual({});
  });

  it('refuses a damaged record (a name that is not text) before writing anything', async () => {
    const f = makeFixture();
    const record = fixtureRecord(f, 'organizer');
    const good = await exportOrganizerRecord(record, f.config, { appUrl: 'https://app.example' });
    const bad = JSON.stringify({ ...good, committee: { ...good.committee, name: { evil: true } }, inviteLabels: { '0': 'Zed' } });
    expect(() => parseOrganizerRecord(bad)).toThrow(/damaged/);
    expect(await getLabels(f.config.chainId, f.config.manager, f.cid)).toEqual({});
  });

  it('refuses a record of another committee and changes nothing', async () => {
    const f = makeFixture();
    const other = makeFixture();
    const record = fixtureRecord(f, 'organizer');
    const file = await exportOrganizerRecord(fixtureRecord(other, 'organizer'), other.config, { appUrl: 'https://app.example' });
    await expect(importOrganizerRecord(file, record)).rejects.toThrow(/belongs to another committee/);
    expect(() => parseOrganizerRecord('{"format":"davinci-dkg-council-kit/v1"}')).toThrow(/not an organizer record/);
  });
});

describe('organizer page: attrition note and names from the stored links', () => {
  it('says how many members the committee can lose', async () => {
    const f = makeFixture({ t: 2, n: 3 });
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    await screen.findByText(/can afford to lose at most 1 of its 3 members/);
  });

  it('shows names from stored links when the provider serves no join history', async () => {
    const f = makeFixture({ phase: Phase.Dealing });
    const record = fixtureRecord(f, 'organizer');
    await importOrganizerRecord(
      {
        ...(await exportOrganizerRecord(record, f.config, { appUrl: 'https://app.example' })),
        inviteLabels: { '1': 'Bob' },
        inviteMapping: [{ index: 3, auth: f.memberKeys[2]?.auth.address as Hex, inviteId: 1 }],
      },
      record,
    );
    f.services.joinedEvents = async () => Promise.reject(new Error('history pruned'));
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record });
    // The contribution list names the member (name and status are separate elements).
    await waitFor(() => expect(screen.getByText('Bob')).toBeInTheDocument());
  });
});
