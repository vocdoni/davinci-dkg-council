/**
 * Restore regressions (finding 3 and finding 6): a kit holding a different
 * root never overwrites the vault silently — only an explicit switch that
 * archives the old root and records; and the twelve words alone restore a
 * role verified against the (fake) public record.
 */

import { generateMnemonic, serializeKit } from '@vocdoni/davinci-dkg-council-sdk';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it } from 'vitest';
import { buildKitForRecords } from '../src/flows/kit';
import { resetInviteFragmentForTests } from '../src/lib/inviteCapture';
import { getRecord, listRecords, recordKey, type CeremonyRecord } from '../src/lib/records';
import { loadRoot } from '../src/lib/vault';
import { makeFixture } from './helpers/fake';
import { fixtureRecord, renderApp } from './helpers/render';

beforeEach(() => resetInviteFragmentForTests());

describe('restore over a populated vault (finding 3)', () => {
  it('keeps root A intact until the user explicitly switches, then archives it', async () => {
    const user = userEvent.setup();
    const f = makeFixture();
    const rootA = generateMnemonic();
    // Root A's own record points at a *different* ceremony.
    const otherCid = `0x${'cd'.repeat(12)}` as `0x${string}`;
    const recordA: CeremonyRecord = {
      key: recordKey(f.config.chainId, f.config.manager, otherCid),
      chainId: f.config.chainId,
      manager: f.config.manager,
      cid: otherCid,
      role: 'participant',
      participantIndex: 2,
      createdAt: Date.now(),
    };
    const { vault } = await renderApp(f, '/restore', { mnemonic: rootA, record: recordA });

    // Kit B: the fixture organizer's kit (verifies against the fake chain).
    const kitB = buildKitForRecords(f.organizerMnemonic, [fixtureRecord(f, 'organizer')]);
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File([serializeKit(kitB)], 'kit.json', { type: 'application/json' }));

    await screen.findByText(/already holds a different key/i);
    // Nothing was written yet: A is still the active root, its record active.
    expect(await loadRoot(vault)).toBe(rootA);
    expect((await listRecords()).some((r) => r.key === recordA.key)).toBe(true);

    await user.click(screen.getByRole('button', { name: /Switch to the restored key/ }));
    await waitFor(async () => expect(await loadRoot(vault)).toBe(f.organizerMnemonic));
    // A's record is archived (hidden), not destroyed; B's record is active.
    const active = await listRecords();
    expect(active.some((r) => r.key === recordA.key)).toBe(false);
    expect(active.some((r) => r.cid === f.cid && r.role === 'organizer')).toBe(true);
    const all = await listRecords(true);
    const archivedA = all.find((r) => r.key === recordA.key);
    expect(archivedA?.archived).toBe(true);
    expect(archivedA?.participantIndex).toBe(2);
  });
});

describe('words-only restore (finding 6)', () => {
  it('rebuilds a member role from the twelve words plus the committee link', async () => {
    const user = userEvent.setup();
    const f = makeFixture();
    const { vault } = await renderApp(f, '/restore');

    await user.click(screen.getByLabelText('Your twelve recovery words'));
    await user.paste(f.memberMnemonics[0] as string);
    await user.type(screen.getByLabelText(/Committee link or code/), `https://example.org/c/${f.cid}`);
    await user.click(screen.getByRole('button', { name: /Rebuild my key/ }));

    await waitFor(async () => {
      const rec = await getRecord(f.config.chainId, f.config.manager, f.cid);
      expect(rec?.role).toBe('participant');
      expect(rec?.participantIndex).toBe(1);
    });
    expect(await loadRoot(vault)).toBe(f.memberMnemonics[0]);
  });

  it('refuses words the public record does not recognize', async () => {
    const user = userEvent.setup();
    const f = makeFixture();
    const { vault } = await renderApp(f, '/restore');

    await user.click(screen.getByLabelText('Your twelve recovery words'));
    await user.paste(generateMnemonic());
    await user.type(screen.getByLabelText(/Committee link or code/), `https://example.org/c/${f.cid}`);
    await user.click(screen.getByRole('button', { name: /Rebuild my key/ }));

    await screen.findByText(/does not recognize these words/);
    expect(await loadRoot(vault)).toBeNull();
  });
});
