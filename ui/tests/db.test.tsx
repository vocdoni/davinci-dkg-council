/**
 * IndexedDB writes settle with their transaction (audit SDK/UI #3): a request that succeeds in a
 * transaction that then aborts (quota, I/O) must reject, and nothing may read as stored.
 */

import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { idbGet, idbPut, STORE_LABELS, STORE_VAULT } from '../src/lib/db';
import { loadRoot, saveRoot, type VaultStore } from '../src/lib/vault';
import { makeFixture } from './helpers/fake';
import { renderApp } from './helpers/render';

vi.mock('../src/lib/download', () => ({
  downloadTextFile: vi.fn(),
  printTextSheet: vi.fn(() => false),
  copyToClipboard: vi.fn(async () => true),
}));
import { downloadTextFile } from '../src/lib/download';

const realPut = IDBObjectStore.prototype.put;

/** Abort the transaction right after its put request succeeded — the commit then never happens. */
function abortAfterPutSucceeds(): void {
  IDBObjectStore.prototype.put = function (this: IDBObjectStore, ...args: Parameters<IDBObjectStore['put']>) {
    const req = realPut.apply(this, args);
    const t = this.transaction;
    req.addEventListener('success', () => t.abort());
    return req;
  };
}

afterEach(() => {
  IDBObjectStore.prototype.put = realPut;
});

describe('indexedDB writes', () => {
  it('resolve once the transaction commits', async () => {
    await idbPut(STORE_LABELS, 'k-ok', { a: 1 });
    expect(await idbGet(STORE_LABELS, 'k-ok')).toEqual({ a: 1 });
  });

  it('reject when the transaction aborts after the request succeeded, and store nothing', async () => {
    abortAfterPutSucceeds();
    await expect(idbPut(STORE_LABELS, 'k-abort', { a: 2 })).rejects.toBeTruthy();
    IDBObjectStore.prototype.put = realPut;
    expect(await idbGet(STORE_LABELS, 'k-abort')).toBeUndefined();
  });

  it('a seed is never reported saved before its transaction commits', async () => {
    abortAfterPutSucceeds();
    await expect(saveRoot('abandon '.repeat(11) + 'about')).rejects.toBeTruthy();
    IDBObjectStore.prototype.put = realPut;
    expect(await idbGet(STORE_VAULT, 'council.root.v1')).toBeUndefined();
  });
});

describe('the app never treats a key as saved before the browser stored it', () => {
  it('create: a storage write that fails keeps the person on the check step, with nothing stored', async () => {
    const user = userEvent.setup();
    const f = makeFixture();
    const vault: VaultStore = {
      get: async () => undefined,
      put: async () => {
        throw new Error('QuotaExceededError');
      },
      delete: async () => undefined,
    };
    await renderApp(f, '/new', { vault });
    await user.click(screen.getByRole('button', { name: 'Continue' }));
    await user.click(await screen.findByRole('button', { name: /Download the kit file/ }));
    const kitText = vi.mocked(downloadTextFile).mock.calls.at(-1)?.[1] as string;
    await user.click(screen.getByRole('button', { name: /I saved it/ }));
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File([kitText], 'kit.json', { type: 'application/json' }));
    await screen.findByText(/could not store your key \(QuotaExceededError\)/);
    expect(screen.queryByText('Ready to create')).toBeNull();
    expect(await loadRoot(vault)).toBeNull();
    expect(f.actions).toHaveLength(0);
  });
});
