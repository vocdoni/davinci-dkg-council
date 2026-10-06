/**
 * Recovery-kit regressions (finding 5 and finding 6): a failed print never
 * marks the kit as saved, and the rehearsal re-derives the full root instead
 * of spot-checking two words.
 */

import { generateMnemonic } from '@vocdoni/davinci-dkg-council-sdk';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { RecoveryKitStep } from '../src/components/RecoveryKitStep';
import { buildKitForRecords, mnemonicMatchesKit } from '../src/flows/kit';
import { recordKey, type CeremonyRecord } from '../src/lib/records';

vi.mock('../src/lib/download', () => ({
  downloadTextFile: vi.fn(),
  printTextSheet: vi.fn(() => false),
  copyToClipboard: vi.fn(async () => true),
}));
import { printTextSheet } from '../src/lib/download';

function kitFor(mnemonic: string) {
  const record: CeremonyRecord = {
    key: recordKey(31337, '0x00000000000000000000000000000000000000aa', `0x${'ab'.repeat(12)}`),
    chainId: 31337,
    manager: '0x00000000000000000000000000000000000000aa',
    cid: `0x${'ab'.repeat(12)}`,
    role: 'organizer',
    createdAt: Date.now(),
  };
  return buildKitForRecords(mnemonic, [record]);
}

describe('print failure handling (finding 5)', () => {
  it('never marks the kit saved when printing fails, recovers when it works', async () => {
    const user = userEvent.setup();
    render(<RecoveryKitStep kit={kitFor(generateMnemonic())} onDone={vi.fn()} />);

    const check = screen.getByRole('button', { name: /I saved it/ });
    await user.click(screen.getByRole('button', { name: /Print the words/ }));
    await screen.findByText(/Printing did not open/);
    expect(check).toBeDisabled();

    vi.mocked(printTextSheet).mockReturnValue(true);
    await user.click(screen.getByRole('button', { name: /Print the words/ }));
    expect(check).toBeEnabled();
    expect(screen.queryByText(/Printing did not open/)).toBeNull();
  });
});

describe('mnemonicMatchesKit (finding 6)', () => {
  it('accepts only the kit root, with whitespace and case tolerance', () => {
    const mnemonic = generateMnemonic();
    const kit = kitFor(mnemonic);
    expect(mnemonicMatchesKit(mnemonic, kit)).toBe(true);
    expect(mnemonicMatchesKit(`  ${mnemonic.toUpperCase().split(' ').join('   ')} `, kit)).toBe(true);
    expect(mnemonicMatchesKit(generateMnemonic(), kit)).toBe(false); // different valid root
    expect(mnemonicMatchesKit('not twelve words', kit)).toBe(false);
    expect(mnemonicMatchesKit('', kit)).toBe(false);
  });
});
