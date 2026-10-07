/**
 * Restore keeps a kit's derivation account index (audit SDK/UI #2): a role authenticated with
 * accountIndex 1 must act with account-1 keys afterwards and export account-1 kit entries — not
 * silently fall back to account 0 (whose keys are not on the committee).
 */

import {
  buildKit,
  kitEntryIdentity,
  organizerAuthKey,
  parseKit,
  PhaseMode,
  recoverActionSigner,
  restoreFromKit,
  rootFromMnemonic,
  serializeKit,
  toDecimal,
  type Hex,
  type KitManifestEntry,
} from '@vocdoni/davinci-dkg-council-sdk';
import { cleanup, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { buildKitForRecords } from '../src/flows/kit';
import { participantKeys } from '../src/flows/participant';
import { resetInviteFragmentForTests } from '../src/lib/inviteCapture';
import { archiveAllRecords, getRecord, type CeremonyRecord } from '../src/lib/records';
import { makeFixture, MANAGER, type Fixture } from './helpers/fake';
import { renderApp } from './helpers/render';

URL.createObjectURL = vi.fn(() => 'blob:council-test');
URL.revokeObjectURL = vi.fn();

beforeEach(async () => {
  resetInviteFragmentForTests();
  await archiveAllRecords();
});

const ACCOUNT = 1;

function participantEntry(f: Fixture): KitManifestEntry {
  const keys = participantKeys(f.memberMnemonics[0] as string, f.config, f.cid, ACCOUNT);
  return {
    role: 'participant',
    chainId: String(f.config.chainId),
    manager: MANAGER,
    ceremonyId: f.cid,
    accountIndex: ACCOUNT,
    authAddress: keys.auth.address.toLowerCase() as Hex,
    sharePublicKey: { x: toDecimal(keys.share.publicKey.x), y: toDecimal(keys.share.publicKey.y) },
  };
}

function organizerEntry(f: Fixture): KitManifestEntry {
  const key = organizerAuthKey(rootFromMnemonic(f.organizerMnemonic), {
    chainId: BigInt(f.config.chainId),
    manager: MANAGER,
    accountIndex: ACCOUNT,
  });
  return {
    role: 'organizer',
    chainId: String(f.config.chainId),
    manager: MANAGER,
    ceremonyId: f.cid,
    accountIndex: ACCOUNT,
    authAddress: key.address.toLowerCase() as Hex,
  };
}

/** Restore `kitText` through the Restore screen; returns the record it stored. */
async function restoreKit(f: Fixture, kitText: string): Promise<CeremonyRecord> {
  const user = userEvent.setup();
  await renderApp(f, '/restore');
  const input = document.querySelector('input[type=file]') as HTMLInputElement;
  await user.upload(input, new File([kitText], 'kit.json', { type: 'application/json' }));
  await screen.findByText(/Your key is back/);
  const record = await getRecord(f.config.chainId, f.config.manager, f.cid);
  if (!record) throw new Error('restore stored no record');
  cleanup();
  return record;
}

/** The kit this device would export for `record`, re-parsed and checked against the chain. */
async function exportedKitRoundTrip(f: Fixture, mnemonic: string, record: CeremonyRecord) {
  const kit = parseKit(serializeKit(buildKitForRecords(mnemonic, [record])));
  const entry = kit.manifest[0] as KitManifestEntry;
  const verdict = await f.chain.verifyRestoredIdentity(kitEntryIdentity(restoreFromKit(kit).root, entry));
  return { entry, verdict };
}

describe('account index > 0 survives restore (SDK/UI #2)', () => {
  it('participant: restored with account 1, turns its key with account-1 keys, exports account 1', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ accountIndex: ACCOUNT });
    const mnemonic = f.memberMnemonics[0] as string;
    const rid = f.addRequest([5n]);
    const record = await restoreKit(f, serializeKit(buildKit(mnemonic, [participantEntry(f)])));
    expect(record.accountIndex).toBe(ACCOUNT);
    expect(record.participantIndex).toBe(1);

    await renderApp(f, `/c/${f.cid}`, { mnemonic, record });
    await user.click(await screen.findByRole('button', { name: 'Check and turn my key' }));
    await waitFor(() => expect(f.actions).toHaveLength(1));
    const action = f.actions[0];
    if (action?.kind !== 'submitPartial') throw new Error(`expected a partial, got ${action?.kind}`);
    expect(action.message.requestId).toBe(rid);
    expect(action.message.participantIndex).toBe(1);
    const signer = await recoverActionSigner(f.chain.chainId, MANAGER, 'Partial', action.message, action.signature);
    expect(signer.toLowerCase()).toBe(f.memberKeys[0]?.auth.address.toLowerCase());

    const { entry, verdict } = await exportedKitRoundTrip(f, mnemonic, record);
    expect(entry.accountIndex).toBe(ACCOUNT);
    expect(entry.authAddress).toBe(participantEntry(f).authAddress);
    expect(verdict.ok).toBe(true);
  });

  it('organizer: restored with account 1, opens the results signed by the account-1 key, exports account 1', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ accountIndex: ACCOUNT, policy: { decryptionMode: PhaseMode.Manual, manualOpenedAt: 0n } });
    const record = await restoreKit(f, serializeKit(buildKit(f.organizerMnemonic, [organizerEntry(f)])));
    expect(record.accountIndex).toBe(ACCOUNT);
    expect(record.role).toBe('organizer');

    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record });
    await user.click(await screen.findByRole('button', { name: 'Open the results now' }));
    await user.click(screen.getByRole('button', { name: /I understand — open the results/ }));
    await waitFor(() => expect(f.actions).toHaveLength(1));
    const action = f.actions[0];
    if (action?.kind !== 'openDecryption') throw new Error(`expected openDecryption, got ${action?.kind}`);
    const signer = await recoverActionSigner(
      f.chain.chainId,
      MANAGER,
      'OpenDecryption',
      action.message,
      action.signature,
    );
    expect(signer.toLowerCase()).toBe(f.chain.view.organizer.toLowerCase());

    const { entry, verdict } = await exportedKitRoundTrip(f, f.organizerMnemonic, record);
    expect(entry.accountIndex).toBe(ACCOUNT);
    expect(entry.authAddress).toBe(organizerEntry(f).authAddress);
    expect(verdict.ok).toBe(true);
  });
});
