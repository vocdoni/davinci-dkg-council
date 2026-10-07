/**
 * Organizer screen regressions: the close-registration confirmation signs
 * exactly the reviewed, anchored member snapshot (no silent inclusions), and
 * permanent access grants need an explicit address confirmation.
 */

import {
  Phase,
  trackDomain,
  TRACK_TYPES,
  type Hex,
  type TrackCeremonyRequest,
} from '@vocdoni/davinci-dkg-council-sdk';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { recoverTypedDataAddress } from 'viem';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { organizerAddress } from '../src/flows/organizer';
import { identityCode } from '../src/lib/format';
import { resetInviteFragmentForTests } from '../src/lib/inviteCapture';
import { getRecord } from '../src/lib/records';
import { ADAPTER, makeFixture } from './helpers/fake';
import { fixtureRecord, renderApp } from './helpers/render';

URL.createObjectURL = vi.fn(() => 'blob:council-test');
URL.revokeObjectURL = vi.fn();

beforeEach(() => resetInviteFragmentForTests());

describe('close registration (finding 2)', () => {
  it('reviews one anchored snapshot even when the dashboard read failed, and signs its exact count', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ phase: Phase.Registration });
    // The dashboard's own participant read fails once: the live list is
    // stale/empty, but the review must still fetch its own atomic snapshot.
    f.chain.participantReadFailures = 1;
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });

    await user.click(await screen.findByRole('button', { name: /lock the member list/ }));
    await screen.findByText(/Lock the list with these 3 members/);
    // Every member shown comes from the authenticated snapshot.
    for (const k of f.memberKeys) {
      expect(document.body.textContent).toContain(identityCode(k.auth.address, k.share.publicKey));
    }
    await user.click(screen.getByRole('button', { name: /Yes, lock it/ }));
    await waitFor(() => expect(f.actions).toHaveLength(1));
    const action = f.actions[0];
    expect(action?.kind).toBe('closeRegistration');
    if (action?.kind === 'closeRegistration') {
      expect(action.message.participantCount).toBe(3);
    }
  });

  it('shows an error and never offers to sign when the snapshot read fails', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ phase: Phase.Registration });
    f.chain.participantReadFailures = 2; // dashboard poll + the review read
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });

    await user.click(await screen.findByRole('button', { name: /lock the member list/ }));
    await screen.findByText(/participant read failed/);
    expect(screen.queryByRole('button', { name: /Yes, lock it/ })).toBeNull();
    expect(f.actions).toHaveLength(0);
  });

  it('invalidates the confirmation when the member list changes after review', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ phase: Phase.Registration });
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });

    await user.click(await screen.findByRole('button', { name: /lock the member list/ }));
    await screen.findByText(/Lock the list with these 3 members/);
    // A fourth member joins after the review was frozen.
    f.chain.view = { ...f.chain.view, joinedCount: 4 };
    await screen.findByText(/changed since you reviewed/, {}, { timeout: 15_000 });
    expect(screen.queryByRole('button', { name: /Yes, lock it/ })).toBeNull();
    expect(f.actions).toHaveLength(0);
  }, 25_000);
});

describe('permanent grants (finding 8)', () => {
  it('requires confirming the exact address before an approval is signed', async () => {
    const user = userEvent.setup();
    const f = makeFixture(); // Live
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });

    await user.type(await screen.findByLabelText('Voting system connection'), ADAPTER);
    await user.click(screen.getByRole('button', { name: 'Approve…' }));
    await screen.findByText(/This approval is permanent/);
    expect(screen.getByText(ADAPTER)).toBeTruthy(); // the full address is shown

    const confirm = screen.getByRole('button', { name: /approve it forever/ });
    expect(confirm).toBeDisabled();
    const typedField = screen.getByLabelText(/last 6 characters/);
    await user.type(typedField, 'ffffff');
    expect(confirm).toBeDisabled();
    expect(f.actions).toHaveLength(0);

    await user.clear(typedField);
    await user.type(typedField, ADAPTER.slice(-6));
    expect(confirm).toBeEnabled();
    await user.click(confirm);
    await waitFor(() => expect(f.actions).toHaveLength(1));
    const action = f.actions[0];
    expect(action?.kind).toBe('allowAdapter');
    if (action?.kind === 'allowAdapter') {
      expect(action.message.adapter.toLowerCase()).toBe(ADAPTER.toLowerCase());
    }
  });
});

describe('relayer tracking (/v1/track)', () => {
  it('registers an untracked committee from the dashboard and flags the record', async () => {
    const f = makeFixture({ phase: Phase.Dealing });
    const requests: TrackCeremonyRequest[] = [];
    f.services.trackCeremony = async (request) => {
      requests.push(request);
      return true;
    };
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record: fixtureRecord(f, 'organizer') });

    await waitFor(() => expect(requests).toHaveLength(1));
    const req = requests[0] as TrackCeremonyRequest;
    expect(req.ceremonyId).toBe(f.cid);
    // Signed by the organizer key, in the relayer's own domain (never the protocol's).
    const signer = await recoverTypedDataAddress({
      domain: trackDomain(BigInt(f.config.chainId), f.config.manager),
      types: TRACK_TYPES,
      primaryType: 'TrackCeremony',
      message: { ceremonyId: req.ceremonyId, validUntil: req.validUntil as bigint },
      signature: req.signature as Hex,
    });
    expect(signer.toLowerCase()).toBe(organizerAddress(f.organizerMnemonic, f.config).toLowerCase());
    await waitFor(async () => {
      const rec = await getRecord(f.config.chainId, f.config.manager, f.cid);
      expect(rec?.relayerTracked).toBe(true);
    });
  });

  it('leaves an already-tracked committee alone', async () => {
    const f = makeFixture({ phase: Phase.Dealing });
    let calls = 0;
    f.services.trackCeremony = async () => {
      calls += 1;
      return true;
    };
    const record = { ...fixtureRecord(f, 'organizer'), relayerTracked: true };
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record });
    await screen.findByText('Your committee');
    expect(calls).toBe(0);
  });
});
