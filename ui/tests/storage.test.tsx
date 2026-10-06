/**
 * Device storage over months (architecture §6.4): the app asks the browser to keep its data once a
 * key is stored, tolerates a refusal or a missing API, shows the member whether the browser keeps
 * it, and says to keep the twelve words until the results are opened wherever the words come up.
 */

import { Phase } from '@vocdoni/davinci-dkg-council-sdk';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { archiveAllRecords } from '../src/lib/records';
import { KEEP_WORDS_UNTIL_RESULTS, requestPersistentStorage, storageState } from '../src/lib/storage';
import { makeFixture } from './helpers/fake';
import { fixtureRecord, renderApp } from './helpers/render';

URL.createObjectURL = vi.fn(() => 'blob:council-test');
URL.revokeObjectURL = vi.fn();

/** Install a navigator.storage double; `undefined` removes the API. */
function stubStorage(api: { persisted?: () => Promise<boolean>; persist?: () => Promise<boolean> } | undefined) {
  Object.defineProperty(navigator, 'storage', { value: api, configurable: true });
}

afterEach(async () => {
  stubStorage(undefined);
  await archiveAllRecords();
});

describe('persistent storage request', () => {
  it('asks once not yet persistent, and reports what the browser answered', async () => {
    let kept = false;
    const persist = vi.fn(async () => (kept = true));
    stubStorage({ persisted: async () => kept, persist });
    expect(await storageState()).toBe('best-effort');
    expect(await requestPersistentStorage()).toBe('persistent');
    expect(await requestPersistentStorage()).toBe('persistent');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(await storageState()).toBe('persistent');
  });

  it('survives a refusal, an exception and a browser without the API', async () => {
    stubStorage({ persisted: async () => false, persist: async () => false });
    expect(await requestPersistentStorage()).toBe('best-effort');
    stubStorage({
      persisted: async () => false,
      persist: async () => {
        throw new Error('denied');
      },
    });
    expect(await requestPersistentStorage()).toBe('best-effort');
    stubStorage(undefined);
    expect(await requestPersistentStorage()).toBe('unknown');
    expect(await storageState()).toBe('unknown');
  });

  it('is requested when a key is first stored on this device (words restore)', async () => {
    const persist = vi.fn(async () => false);
    stubStorage({ persisted: async () => false, persist });
    const user = userEvent.setup();
    const f = makeFixture();
    await renderApp(f, '/restore');
    expect(persist).not.toHaveBeenCalled();
    await user.click(screen.getByLabelText('Your twelve recovery words'));
    await user.paste(f.memberMnemonics[0] as string);
    await user.type(screen.getByLabelText(/Committee link or code/), `https://example.org/c/${f.cid}`);
    await user.click(screen.getByRole('button', { name: /Rebuild my key/ }));
    await waitFor(() => expect(persist).toHaveBeenCalledTimes(1));
    await screen.findByText(/Your key is back/); // a refusal changes nothing in the flow
  });
});

describe('what the member sees', () => {
  const memberPage = async (phase = Phase.Live) => {
    const f = makeFixture({ phase });
    await renderApp(f, `/c/${f.cid}`, {
      mnemonic: f.memberMnemonics[0] as string,
      record: fixtureRecord(f, 'participant', 1),
    });
    return f;
  };

  it('a browser that may delete the data: the warning, and a way to ask again', async () => {
    let kept = false;
    stubStorage({ persisted: async () => kept, persist: async () => (kept = true) });
    const user = userEvent.setup();
    await memberPage();
    await screen.findByText('This browser may delete what this site stores, your key included.');
    expect(screen.getByText(/Safari does after about a week without a visit; other browsers may/)).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Ask this browser to keep it' }));
    await screen.findByText('This browser keeps your key for this site until you delete it.');
  });

  it('a browser that keeps it, and one that will not say', async () => {
    stubStorage({ persisted: async () => true, persist: async () => true });
    await memberPage();
    await screen.findByText('This browser keeps your key for this site until you delete it.');
    stubStorage(undefined);
    await archiveAllRecords();
    await memberPage();
    await screen.findAllByText('This browser may delete what this site stores, your key included.');
    expect(screen.queryByRole('button', { name: 'Ask this browser to keep it' })).toBeNull();
  });

  it('says to keep the twelve words until the results are opened: kit card and after contributing', async () => {
    const f = makeFixture({ phase: Phase.Dealing });
    f.chain.view = { ...f.chain.view, qualBitmap: 0b001 };
    await renderApp(f, `/c/${f.cid}`, { mnemonic: f.memberMnemonics[0] as string, record: fixtureRecord(f, 'participant', 1) });
    await screen.findByRole('heading', { name: 'Your contribution is in' });
    expect(screen.getAllByText(KEEP_WORDS_UNTIL_RESULTS)).toHaveLength(2); // the card and the kit card
  });

  it('says it on the recovery-kit step too', async () => {
    const user = userEvent.setup();
    const f = makeFixture();
    await renderApp(f, '/new');
    await user.click(await screen.findByRole('button', { name: /Continue/ }));
    await screen.findByText(/Save your recovery kit/);
    expect(screen.getByText(KEEP_WORDS_UNTIL_RESULTS)).toBeTruthy();
  });
});
