/**
 * Screen tests: invite-fragment hygiene, mandatory kit rehearsal, and the
 * explicit roster approval gate before contributing (§8.3).
 */

import { accountFromSecret, generateMnemonic } from '@vocdoni/davinci-dkg-council-sdk';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { BrowserRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AppProvider, AppRoutes } from '../src/App';
import { RecoveryKitStep } from '../src/components/RecoveryKitStep';
import { buildKitForRecords } from '../src/flows/kit';
import { resetInviteFragmentForTests } from '../src/lib/inviteCapture';
import { putRecord, recordKey, type CeremonyRecord } from '../src/lib/records';
import { saveRoot, type VaultStore } from '../src/lib/vault';
import { makeFixture, type Fixture } from './helpers/fake';
import { Phase } from '@vocdoni/davinci-dkg-council-sdk';

// jsdom has no createObjectURL; downloads only need it to exist.
URL.createObjectURL = vi.fn(() => 'blob:council-test');
URL.revokeObjectURL = vi.fn();

beforeEach(() => resetInviteFragmentForTests());

function memStore(): VaultStore {
  const m = new Map<string, unknown>();
  return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v), delete: async (k) => m.delete(k) };
}

async function renderApp(fixture: Fixture, path: string, opts: { mnemonic?: string; record?: CeremonyRecord } = {}) {
  const vault = memStore();
  if (opts.mnemonic) await saveRoot(opts.mnemonic, vault);
  if (opts.record) await putRecord(opts.record);
  window.history.replaceState(null, '', path);
  return render(
    <AppProvider services={fixture.services} vaultStore={vault}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProvider>,
  );
}

describe('invite links', () => {
  it('strips the secret fragment from the address bar and starts the join flow', async () => {
    const f = makeFixture({ phase: Phase.Registration });
    const secret = 123456789n;
    f.chain.invites[0] = { key: accountFromSecret(secret).address, consumed: false };
    await renderApp(f, `/c/${f.cid}#v1.0.${secret.toString(16).padStart(64, '0')}`);
    await screen.findByText(/You are invited/);
    expect(window.location.hash).toBe('');
  });
});

describe('recovery kit rehearsal', () => {
  it('blocks until saved, rejects a different valid mnemonic, passes with the right one', async () => {
    const user = userEvent.setup();
    const mnemonic = generateMnemonic();
    const record: CeremonyRecord = {
      key: recordKey(31337, '0x00000000000000000000000000000000000000aa', `0x${'ab'.repeat(12)}`),
      chainId: 31337,
      manager: '0x00000000000000000000000000000000000000aa',
      cid: `0x${'ab'.repeat(12)}`,
      role: 'organizer',
      createdAt: Date.now(),
    };
    const onDone = vi.fn();
    render(<RecoveryKitStep kit={buildKitForRecords(mnemonic, [record])} onDone={onDone} />);

    const check = screen.getByRole('button', { name: /I saved it/ });
    expect(check).toBeDisabled();
    await user.click(screen.getByRole('button', { name: /Download the kit file/ }));
    expect(check).toBeEnabled();
    await user.click(check);

    const box = screen.getByLabelText('Your twelve recovery words');
    // A *different but valid* mnemonic must be rejected — the exact miss a
    // two-word spot check could pass.
    await user.click(box);
    await user.paste(generateMnemonic());
    await user.click(screen.getByRole('button', { name: /Check the words/ }));
    expect(onDone).not.toHaveBeenCalled();
    await screen.findByText(/do not rebuild the same key/);

    await user.clear(box);
    await user.click(box);
    await user.paste(`  ${mnemonic.toUpperCase()}  `);
    await user.click(screen.getByRole('button', { name: /Check the words/ }));
    expect(onDone).toHaveBeenCalledOnce();
  });
});

describe('contribute gate (§8.3)', () => {
  it('requires explicit approval of the exact member list before any contribution', async () => {
    const user = userEvent.setup();
    const f = makeFixture({ phase: Phase.Dealing });
    const record: CeremonyRecord = {
      key: recordKey(f.config.chainId, f.config.manager, f.cid),
      chainId: f.config.chainId,
      manager: f.config.manager,
      cid: f.cid,
      role: 'participant',
      participantIndex: 1,
      createdAt: Date.now(),
    };
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.memberMnemonics[0] as string, record });

    await screen.findByText('(you)', { exact: false });
    expect(screen.queryByRole('button', { name: /Add my contribution now/ })).toBeNull();

    await user.click(screen.getByRole('button', { name: /I approve this list/ }));
    const contribute = await screen.findByRole('button', { name: /Add my contribution now/ });
    await user.click(contribute);

    await waitFor(() => expect(f.actions.length).toBeGreaterThan(0), { timeout: 20_000 });
    expect(f.actions[0]?.kind).toBe('deal');
  }, 30_000);
});

describe('create wizard', () => {
  it('forces the recovery kit step before anything is created', async () => {
    const user = userEvent.setup();
    const f = makeFixture();
    await renderApp(f, '/new');
    await screen.findByText(/Set up your committee/);
    await user.click(screen.getByRole('button', { name: /Continue/ }));
    await screen.findByText(/Save your recovery kit/);
    expect(f.actions).toHaveLength(0);
  });
});
