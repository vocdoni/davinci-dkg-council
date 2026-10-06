/** Shared screen-test harness: memory vault + app render at a path. */

import { render, waitFor } from '@testing-library/react';
import { BrowserRouter } from 'react-router-dom';
import { AppProvider, AppRoutes } from '../../src/App';
import { putRecord, recordKey, type CeremonyRecord, type Role } from '../../src/lib/records';
import { saveRoot, type VaultStore } from '../../src/lib/vault';
import type { Fixture } from './fake';

export function memStore(): VaultStore {
  const m = new Map<string, unknown>();
  return { get: async (k) => m.get(k), put: async (k, v) => m.set(k, v), delete: async (k) => m.delete(k) };
}

export function fixtureRecord(f: Fixture, role: Role, participantIndex?: number): CeremonyRecord {
  return {
    key: recordKey(f.config.chainId, f.config.manager, f.cid),
    chainId: f.config.chainId,
    manager: f.config.manager,
    cid: f.cid,
    role,
    participantIndex,
    createdAt: Date.now(),
  };
}

export async function renderApp(
  fixture: Fixture,
  path: string,
  opts: { mnemonic?: string; record?: CeremonyRecord } = {},
) {
  const vault = memStore();
  if (opts.mnemonic) await saveRoot(opts.mnemonic, vault);
  if (opts.record) await putRecord(opts.record);
  window.history.replaceState(null, '', path);
  const utils = render(
    <AppProvider services={fixture.services} vaultStore={vault}>
      <BrowserRouter>
        <AppRoutes />
      </BrowserRouter>
    </AppProvider>,
  );
  // AppProvider shows its "Opening…" spinner until the vault/records load.
  await waitFor(() => {
    if (utils.queryByText('Opening…')) throw new Error('app still opening');
  });
  return { vault, ...utils };
}
