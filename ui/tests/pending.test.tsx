/**
 * Just-sent actions (lib/pending.ts): the screens read the finalized block, which trails the
 * head by 15–20 minutes on Sepolia. Every action sent from this device is tracked until the
 * finalized state shows it: the screens show the confirming note instead of an error or a second
 * offer of the same step, and report it when the network rejected it.
 */

import {
  COUNCIL_MANAGER_ABI,
  Phase,
  RelayerError,
  type CeremonyView,
  type Hex,
} from '@vocdoni/davinci-dkg-council-sdk';
import { act, configure, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { ContractFunctionExecutionError, ContractFunctionRevertedError, encodeErrorResult } from 'viem';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CONFIRMING_TEXT } from '../src/components/ui';
import { isUnknownCeremony, readCeremony } from '../src/lib/chain';
import { resetInviteFragmentForTests } from '../src/lib/inviteCapture';
import {
  failedText,
  PENDING_MAX_AGE_MS,
  pendingSettled,
  sendTracked,
  settlePending,
  type PendingAction,
} from '../src/lib/pending';
import { archiveAllRecords, getRecord, putRecord, type CeremonyRecord } from '../src/lib/records';
import { plainSubmitError, submitRevertName, TxRejectedError } from '../src/lib/relayerErrors';
import type { TxStatus } from '../src/services';
import { ADAPTER, makeFixture, MANAGER, PROCESS_ID, type Fixture } from './helpers/fake';
import { fixtureRecord, renderApp } from './helpers/render';

// Each screen step chains several in-memory reads and IndexedDB writes: give a loaded CI runner room.
configure({ asyncUtilTimeout: 5_000 });

URL.createObjectURL = vi.fn(() => 'blob:council-test');
URL.revokeObjectURL = vi.fn();

const TX = `0x${'01'.repeat(32)}` as Hex;
const CONFIRMING = /Waiting for the network to confirm — about 15–20 minutes on Sepolia, 1–2 minutes on Gnosis\. You can close this page and come back\./;
const ERRORS = /could not reach the public record|That did not work|did not go through|UnknownCeremony/;

/** What viem throws for a view that reverts `UnknownCeremony()` (the committee is not at the finalized block). */
function unknownCeremony(): Error {
  const data = encodeErrorResult({ abi: COUNCIL_MANAGER_ABI, errorName: 'UnknownCeremony' });
  const reverted = new ContractFunctionRevertedError({ abi: COUNCIL_MANAGER_ABI, data, functionName: 'getCeremony' });
  return new ContractFunctionExecutionError(reverted, {
    abi: COUNCIL_MANAGER_ABI,
    args: [`0x${'ab'.repeat(12)}`],
    functionName: 'getCeremony',
    contractAddress: MANAGER,
  });
}

/** What services.submit throws for a refusal the relayer simulated at the head. */
const refusedAtHead = (name: string) => plainSubmitError(new RelayerError('SIMULATION_REVERTED', `${name}()`, undefined, 422));

const pending = (p: Partial<PendingAction> & Pick<PendingAction, 'kind'>): PendingAction => ({ sentAt: Date.now(), txHash: TX, ...p });

async function storedPending(f: Fixture): Promise<PendingAction[]> {
  return (await getRecord(f.config.chainId, f.config.manager, f.cid))?.pending ?? [];
}

/** Advance past one 8 s poll of the open screen. */
const nextPoll = () => act(() => vi.advanceTimersByTimeAsync(8_100));

beforeEach(async () => {
  resetInviteFragmentForTests();
  await archiveAllRecords();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('reading a committee the finalized block does not hold yet', () => {
  it('maps an UnknownCeremony() revert to null and rethrows anything else', async () => {
    const f = makeFixture();
    expect(isUnknownCeremony(unknownCeremony())).toBe(true);
    expect(isUnknownCeremony(new Error('The contract function "getCeremony" reverted.\n\nError: UnknownCeremony()'))).toBe(true);
    expect(isUnknownCeremony(new Error('council client: RPC providers disagree on the finalized block — refusing'))).toBe(false);

    f.chain.getCeremony = async () => {
      throw unknownCeremony();
    };
    await expect(readCeremony(f.chain, f.cid)).resolves.toBeNull();
    f.chain.getCeremony = async () => {
      throw new Error('fetch failed');
    };
    await expect(readCeremony(f.chain, f.cid)).rejects.toThrow('fetch failed');
    f.chain.getCeremony = async () => ({ ...f.chain.view, phase: Phase.None });
    await expect(readCeremony(f.chain, f.cid)).resolves.toBeNull();
  });

  it('finds the contract refusal behind a plain submission error', () => {
    expect(submitRevertName(refusedAtHead('WrongPhase'))).toBe('WrongPhase');
    expect(submitRevertName(plainSubmitError(new RelayerError('RATE_LIMITED', 'slow down', undefined, 429)))).toBeUndefined();
    expect(submitRevertName(new Error('WrongPhase()'))).toBeUndefined();
  });
});

describe('when a pending action counts as shown', () => {
  it('compares each kind with the finalized state', async () => {
    const f = makeFixture({ phase: Phase.Registration });
    const at = (patch: Partial<CeremonyView>) => ({ ...f.chain.view, ...patch });
    const settled = (p: PendingAction, view: CeremonyView | null) => pendingSettled(p, f.chain, f.cid, view);

    expect(await settled(pending({ kind: 'create' }), null)).toBe(false);
    expect(await settled(pending({ kind: 'create' }), at({}))).toBe(true);

    expect(await settled(pending({ kind: 'addInvites', inviteCount: 5 }), at({ inviteCount: 3 }))).toBe(false);
    expect(await settled(pending({ kind: 'addInvites', inviteCount: 5 }), at({ inviteCount: 5 }))).toBe(true);

    expect(await settled(pending({ kind: 'close' }), at({}))).toBe(false);
    expect(await settled(pending({ kind: 'close' }), at({ phase: Phase.Dealing }))).toBe(true);

    const me = f.memberKeys[2]?.auth.address as Hex;
    const listed = f.chain.participants;
    f.chain.participants = listed.slice(0, 2);
    expect(await settled(pending({ kind: 'join', address: me }), at({}))).toBe(false);
    f.chain.participants = listed;
    expect(await settled(pending({ kind: 'join', address: me }), at({}))).toBe(true);

    expect(await settled(pending({ kind: 'deal', memberIndex: 2 }), at({ phase: Phase.Dealing, qualBitmap: 0b001 }))).toBe(false);
    expect(await settled(pending({ kind: 'deal', memberIndex: 2 }), at({ phase: Phase.Dealing, qualBitmap: 0b011 }))).toBe(true);

    expect(await settled(pending({ kind: 'finish' }), at({ phase: Phase.Dealing }))).toBe(false);
    expect(await settled(pending({ kind: 'finish' }), at({ phase: Phase.Live }))).toBe(true);
    expect(await settled(pending({ kind: 'finish', abort: true }), at({ phase: Phase.Aborted }))).toBe(true);

    const grant = pending({ kind: 'grant', grant: 'creator', address: ADAPTER });
    expect(await settled(grant, at({ phase: Phase.Live }))).toBe(false);
    f.chain.authorizedCreators.add(ADAPTER.toLowerCase());
    expect(await settled(grant, at({ phase: Phase.Live }))).toBe(true);

    const rid = f.addRequest([1n]);
    const partial = pending({ kind: 'partial', requestId: rid, memberIndex: 2 });
    expect(await settled(partial, at({ phase: Phase.Live }))).toBe(false);
    (f.chain.requests.get(rid) as { partialBitmap: number }).partialBitmap = 0b010;
    expect(await settled(partial, at({ phase: Phase.Live }))).toBe(true);
  });
});

describe('settling the pending actions of a record', () => {
  it('drops what the finalized state shows or the relayer rejected, keeps the rest, forgets stale entries', async () => {
    const f = makeFixture({ phase: Phase.Registration });
    const rejected = `0x${'02'.repeat(32)}` as Hex;
    const record: CeremonyRecord = {
      ...fixtureRecord(f, 'organizer'),
      pending: [
        pending({ kind: 'create' }), // the committee is visible: shown
        pending({ kind: 'close' }), // still Registration: kept
        pending({ kind: 'addInvites', inviteCount: 9, txHash: rejected }), // rejected
        pending({ kind: 'grant', grant: 'adapter', address: ADAPTER, sentAt: Date.now() - PENDING_MAX_AGE_MS - 1 }), // stale
      ],
    };
    await putRecord(record);
    const asked: Hex[] = [];
    const txStatus = async (hash: Hex): Promise<TxStatus> => {
      asked.push(hash);
      return hash === rejected ? { status: 'failed', reason: 'replaced or dropped' } : { status: 'confirmed' };
    };
    const out = await settlePending({ client: f.chain, txStatus }, record, f.chain.view);
    expect(out.changed).toBe(true);
    expect(out.failed.map((x) => [x.action.kind, x.reason])).toEqual([['addInvites', 'replaced or dropped']]);
    expect((await storedPending(f)).map((p) => p.kind)).toEqual(['close']);
    expect(failedText(out.failed[0] as never)).toBe(
      'The network did not accept adding the invitations (replaced or dropped). Nothing changed — you can try again.',
    );

    // A hash the relayer already reported mined is not asked about again.
    const again = await settlePending({ client: f.chain, txStatus }, (await getRecord(f.config.chainId, f.config.manager, f.cid)) as CeremonyRecord, f.chain.view);
    expect(again).toEqual({ changed: false, failed: [] });
    expect(asked.filter((h) => h === TX)).toHaveLength(1);
  });
});

describe('sending a tracked action', () => {
  const action = { kind: 'finalize', ceremonyId: `0x${'ab'.repeat(12)}` } as const;

  async function setup() {
    const f = makeFixture({ phase: Phase.Dealing });
    const record = fixtureRecord(f, 'participant', 1);
    await putRecord(record);
    return { f, record, refresh: vi.fn(async () => {}) };
  }

  it('records the transaction once it is mined', async () => {
    const { f, record, refresh } = await setup();
    await sendTracked(f.services, record, action, { kind: 'finish' }, refresh);
    expect(await storedPending(f)).toMatchObject([{ kind: 'finish', txHash: TX }]);
    expect(refresh).toHaveBeenCalled();
  });

  it('treats "already done at the head" as pending, and any other refusal as an error with nothing pending', async () => {
    const { f, record, refresh } = await setup();
    f.services.submit = async () => {
      throw refusedAtHead('WrongPhase');
    };
    await sendTracked(f.services, record, action, { kind: 'finish' }, refresh);
    expect(await storedPending(f)).toMatchObject([{ kind: 'finish' }]);
    expect((await storedPending(f))[0]?.txHash).toBeUndefined();

    await putRecord(record);
    f.services.submit = async () => {
      throw refusedAtHead('FinalizeConditionNotMet');
    };
    await expect(sendTracked(f.services, record, action, { kind: 'finish' }, refresh)).rejects.toThrow();
    expect(await storedPending(f)).toEqual([]);
  });

  it('drops a rejected action and keeps a slow one pending', async () => {
    const { f, record, refresh } = await setup();
    f.services.waitTx = async () => {
      throw new TxRejectedError('FinalizeConditionNotMet()');
    };
    await expect(sendTracked(f.services, record, action, { kind: 'finish' }, refresh)).rejects.toThrow(/rejected/);
    expect(await storedPending(f)).toEqual([]);

    f.services.waitTx = async () => {
      throw new Error('the update is taking too long — please try again');
    };
    await expect(sendTracked(f.services, record, action, { kind: 'finish' }, refresh)).resolves.toBeUndefined();
    expect(await storedPending(f)).toMatchObject([{ kind: 'finish', txHash: TX }]);
  });

  it('never uses words the app avoids', () => {
    const banned = /wallet|\bgas\b|\bsign|transaction|key pair|on-chain|relayer/i;
    expect(CONFIRMING_TEXT).not.toMatch(banned);
    for (const kind of ['create', 'addInvites', 'join', 'close', 'deal', 'finish', 'grant', 'partial'] as const) {
      expect(failedText({ action: pending({ kind }), reason: 'WrongPhase()' })).not.toMatch(banned);
    }
  });
});

describe('screens right after an action (finalized block behind the head)', () => {
  it('create: the wizard lands on the confirming note, not UnknownCeremony(), and the dashboard follows', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const f = makeFixture({ phase: Phase.Registration });
    const finalized = f.chain.view;
    f.chain.getCeremony = async () => {
      throw unknownCeremony();
    };
    await renderApp(f, '/new', { mnemonic: f.organizerMnemonic });
    await user.click(await screen.findByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: 'Create the committee' }));
    await screen.findByText(/^Your committee was created\./);
    expect(screen.getByText(CONFIRMING)).toBeTruthy();
    expect(document.body.textContent).not.toMatch(ERRORS);
    expect(f.actions.map((a) => a.kind)).toEqual(['createCeremony']);

    // Finality catches up: the dashboard replaces the note and the record forgets the create.
    f.chain.getCeremony = async () => finalized;
    await nextPoll();
    await screen.findByRole('heading', { name: 'People' });
    expect(screen.queryByText(CONFIRMING)).toBeNull();
  });

  it('create: a creation the network rejected is reported instead of waiting forever', async () => {
    const f = makeFixture({ phase: Phase.Registration });
    f.chain.getCeremony = async () => {
      throw unknownCeremony();
    };
    f.services.txStatus = async () => ({ status: 'failed', reason: 'replaced or dropped' });
    await renderApp(f, `/c/${f.cid}`, {
      mnemonic: f.organizerMnemonic,
      record: { ...fixtureRecord(f, 'organizer'), pending: [pending({ kind: 'create', txHash: `0x${'03'.repeat(32)}` })] },
    });
    await screen.findByText(/The network did not accept creating the committee \(replaced or dropped\)/);
    expect(screen.queryByText(CONFIRMING)).toBeNull();
  });

  it('add invites: the button is off and the note explains, until the new invitations are finalized', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const f = makeFixture({ phase: Phase.Registration });
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    const add = await screen.findByRole('button', { name: 'Add' });
    await user.click(add);
    await screen.findByText(/^You added invitations; their links appear here once confirmed\./);
    expect(screen.getByRole('button', { name: 'Add' })).toBeDisabled();
    expect(f.actions.map((a) => a.kind)).toEqual(['addInvites']);

    f.chain.view = { ...f.chain.view, inviteCount: f.chain.view.inviteCount + 1 };
    await nextPoll();
    await waitFor(() => expect(screen.queryByText(/You added invitations/)).toBeNull());
    expect(screen.getByRole('button', { name: 'Add' })).toBeEnabled();
    expect(await storedPending(f)).toEqual([]);
  });

  it('close: the lock is not offered again while it waits for the network', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ phase: Phase.Registration });
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    await user.click(await screen.findByRole('button', { name: /lock the member list/ }));
    await user.click(await screen.findByRole('button', { name: /Yes, lock it/ }));
    await screen.findByText(/^You locked the member list\./);
    expect(screen.queryByRole('button', { name: /lock the member list/ })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add' })).toBeNull();
    expect(document.body.textContent).not.toMatch(ERRORS);
    expect(await storedPending(f)).toMatchObject([{ kind: 'close', txHash: TX }]);
  });

  it('close: a list already locked at the head (another device, a lost answer) waits instead of failing', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ phase: Phase.Registration });
    f.services.submit = async () => {
      throw refusedAtHead('WrongPhase');
    };
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    await user.click(await screen.findByRole('button', { name: /lock the member list/ }));
    await user.click(await screen.findByRole('button', { name: /Yes, lock it/ }));
    await screen.findByText(/^You locked the member list\./);
    expect(document.body.textContent).not.toMatch(/That did not work|no longer open/);
  });

  it('close: a pending lock the finalized state shows is cleared on the first read', async () => {
    const f = makeFixture({ phase: Phase.Dealing });
    f.chain.view = { ...f.chain.view, qualBitmap: 0 };
    await renderApp(f, `/c/${f.cid}`, {
      mnemonic: f.organizerMnemonic,
      record: { ...fixtureRecord(f, 'organizer'), pending: [pending({ kind: 'close' })] },
    });
    await screen.findByText(/0 of 3 members have added their contribution/);
    await waitFor(async () => expect(await storedPending(f)).toEqual([]));
    expect(screen.queryByText(CONFIRMING)).toBeNull();
  });

  it('join: the new member sees the confirming note, then "on the list" with the member index learned', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    const f = makeFixture({ phase: Phase.Registration });
    const me = f.memberKeys[2]?.auth.address as Hex;
    const listed = f.chain.participants;
    f.chain.participants = listed.slice(0, 2); // finalized block: before this member's join
    f.chain.view = { ...f.chain.view, joinedCount: 2, consumedInvites: 0b011n };
    await renderApp(f, `/c/${f.cid}`, {
      mnemonic: f.memberMnemonics[2] as string,
      record: { ...fixtureRecord(f, 'participant'), inviteId: 2, pending: [pending({ kind: 'join', address: me })] },
    });
    await screen.findByText(/^You joined the member list\./);
    expect(screen.queryByText(/You are on the list/)).toBeNull();

    f.chain.participants = listed;
    f.chain.view = { ...f.chain.view, joinedCount: 3, consumedInvites: 0b111n };
    await nextPoll();
    await screen.findByText(/You are on the list/);
    const stored = await getRecord(f.config.chainId, f.config.manager, f.cid);
    expect(stored?.pending).toBeUndefined();
    expect(stored?.participantIndex).toBe(3);
  });

  it('join: an invitation opened before its committee is finalized waits, then opens', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    const { accountFromSecret } = await import('@vocdoni/davinci-dkg-council-sdk');
    const f = makeFixture({ phase: Phase.Registration });
    const secret = 987654321n;
    f.chain.invites[0] = { key: accountFromSecret(secret).address, consumed: false };
    const finalized = f.chain.view;
    const getInvite = f.chain.getInvite.bind(f.chain);
    f.chain.getCeremony = async () => {
      throw unknownCeremony();
    };
    f.chain.getInvite = async () => {
      throw unknownCeremony();
    };
    await renderApp(f, `/c/${f.cid}#v1.0.${secret.toString(16).padStart(64, '0')}`);
    await screen.findByText(CONFIRMING);
    expect(document.body.textContent).not.toMatch(/not valid|could not reach/);

    f.chain.getCeremony = async () => finalized;
    f.chain.getInvite = getInvite;
    await nextPoll();
    await screen.findByText(/You are invited to hold a key/);
  });

  it('contribute: "sent" with the confirming note, no second offer, until the contribution is finalized', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const f = makeFixture({ phase: Phase.Dealing });
    f.chain.view = { ...f.chain.view, qualBitmap: 0 };
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.memberMnemonics[0] as string, record: fixtureRecord(f, 'participant', 1) });
    await user.click(await screen.findByRole('button', { name: /I approve this list/ }));
    await user.click(await screen.findByRole('button', { name: /Add my contribution now/ }));
    await screen.findByRole('heading', { name: 'Your contribution was sent' }, { timeout: 20_000 });
    expect(screen.getByText(CONFIRMING)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Add my contribution now|Try again/ })).toBeNull();
    expect(f.actions.map((a) => a.kind)).toEqual(['deal']);

    f.chain.view = { ...f.chain.view, qualBitmap: 0b001 };
    await nextPoll();
    await screen.findByRole('heading', { name: 'Your contribution is in' });
  }, 30_000);

  it('contribute: a contribution the network rejected is reported and offered again', async () => {
    const f = makeFixture({ phase: Phase.Dealing });
    f.chain.view = { ...f.chain.view, qualBitmap: 0 };
    f.services.txStatus = async () => ({ status: 'failed', reason: 'Expired()' });
    await renderApp(f, `/c/${f.cid}`, {
      mnemonic: f.memberMnemonics[0] as string,
      record: {
        ...fixtureRecord(f, 'participant', 1),
        approvedRosterHash: f.rosterHash,
        pending: [pending({ kind: 'deal', memberIndex: 1, txHash: `0x${'04'.repeat(32)}` })],
      },
    });
    await screen.findByText(/The network did not accept your contribution \(Expired\(\)\)/);
    await screen.findByRole('button', { name: /Add my contribution now/ });
  });

  it('finish: the key is "being finished" and the button is gone', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ phase: Phase.Dealing });
    f.chain.view = { ...f.chain.view, qualBitmap: 0b111 };
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    await user.click(await screen.findByRole('button', { name: 'Finish the key' }));
    await screen.findByText(/^The key is being finished\./);
    expect(screen.queryByRole('button', { name: 'Finish the key' })).toBeNull();
  });

  it('grants: confirming per address, the same approval not offered twice, "Done" once finalized', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const f = makeFixture();
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });
    await user.type(await screen.findByLabelText('Voting system connection'), ADAPTER);
    await user.click(screen.getByRole('button', { name: 'Approve…' }));
    await user.type(screen.getByLabelText(/last 6 characters/), ADAPTER.slice(-6));
    await user.click(screen.getByRole('button', { name: /approve it forever/ }));
    await screen.findByText(/^You approved the voting system connection 0x000000…00ad\./);
    expect(screen.getByRole('button', { name: 'Approve…' })).toBeDisabled();
    expect(screen.queryByText(/^Done — /)).toBeNull();

    f.chain.allowedAdapters.add(ADAPTER.toLowerCase());
    await nextPoll();
    await screen.findByText('Done — this voting system can now ask the committee to open results.');
    expect(screen.queryByText(/You approved the voting system connection/)).toBeNull();
  });

  it('unlock: "you turned your key" until the partial is finalized, then "done", never a second offer', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true, toFake: ['setTimeout', 'clearTimeout'] });
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
    const f = makeFixture();
    const rid = f.addRequest([7n, 3n]);
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.memberMnemonics[0] as string, record: fixtureRecord(f, 'participant', 1) });
    await screen.findByText(`Vote #1 (${PROCESS_ID.slice(0, 8)}…${PROCESS_ID.slice(-4)})`);
    await user.click(await screen.findByRole('button', { name: 'Check and turn my key' }));
    await screen.findByText(/^You turned your key\./, {}, { timeout: 20_000 });
    expect(screen.queryByRole('button', { name: 'Check and turn my key' })).toBeNull();
    expect(f.actions.map((a) => a.kind)).toEqual(['submitPartial']);

    (f.chain.requests.get(rid) as { partialBitmap: number }).partialBitmap = 0b001;
    await nextPoll(); // the dashboard settles the pending partial
    await nextPoll(); // the unlock list re-reads the request
    await screen.findByText('You have done your part.');
    expect(screen.queryByRole('button', { name: 'Check and turn my key' })).toBeNull();
    expect(f.actions).toHaveLength(1);
  }, 30_000);
});
