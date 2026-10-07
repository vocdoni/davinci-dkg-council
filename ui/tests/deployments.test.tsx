/**
 * Long-lived deployments (ops review P0): the development-setup banner, artifact mirrors and
 * relayers tried in order, and several deployments (current + legacy managers) served by one copy
 * of the app so kits and links of older committees keep working on the same origin.
 */

import { buildKit, serializeKit, toDecimal, type Hex, type KitManifestEntry } from '@vocdoni/davinci-dkg-council-sdk';
import { sha256 } from 'viem';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { validateConfig } from '../src/config';
import { participantKeys } from '../src/flows/participant';
import { resetInviteFragmentForTests } from '../src/lib/inviteCapture';
import { loadCircuitArtifacts } from '../src/lib/proving';
import { releaseArtifacts } from '../src/lib/release';
import { archiveAllRecords, getRecord } from '../src/lib/records';
import { buildDeployments, probeTiming, type Deployments } from '../src/deployments';
import { buildServices, type Services } from '../src/services';
import { makeConfig, makeFixture, type Fixture } from './helpers/fake';
import { fixtureRecord, renderApp } from './helpers/render';

URL.createObjectURL = vi.fn(() => 'blob:council-test');
URL.revokeObjectURL = vi.fn();

beforeEach(async () => {
  resetInviteFragmentForTests();
  await archiveAllRecords();
});
afterEach(() => vi.unstubAllGlobals());

describe('circuit release pins', () => {
  it('proving refuses a release this build has no files for, in plain words', async () => {
    const f = makeFixture();
    f.chain.releaseId = `0x${'34'.repeat(32)}` as Hex;
    await expect(releaseArtifacts(f.chain)).rejects.toThrow(/checking files this copy of the app does not have/);
    const known = makeFixture();
    expect((await releaseArtifacts(known.chain)).release).toBe('circuits-v1');
  });
});

describe('artifact mirrors', () => {
  it('falls through mirrors that are down or wrong to the first copy matching the pins', async () => {
    const bytes = new TextEncoder().encode('wasm-bytes');
    const zkey = new TextEncoder().encode('zkey-bytes');
    const pin = (b: Uint8Array): Hex => sha256(b);
    const file = (name: string, b: Uint8Array) => ({ url: `https://canonical.example/r9/${name}`, sha256: pin(b) });
    const release = {
      release: 'r9',
      developmentSetup: true,
      deal: { wasm: file('deal.wasm', bytes), zkey: file('deal_final.zkey', zkey), vkey: file('deal_vkey.json', bytes) },
      partial: { wasm: file('p.wasm', bytes), zkey: file('p.zkey', zkey), vkey: file('p.json', bytes) },
    };
    const seen: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = String(input);
        seen.push(url);
        if (url.startsWith('https://down.example')) throw new TypeError('Failed to fetch');
        if (url.startsWith('https://stale.example')) return new Response('old bytes');
        return new Response((url.endsWith('.zkey') ? zkey : bytes).slice());
      }),
    );
    const loaded = await loadCircuitArtifacts(
      'deal',
      ['https://down.example/{release}', 'https://stale.example/{release}', 'https://good.example/{release}'],
      undefined,
      release,
    );
    expect(Array.from(loaded.wasm as Uint8Array)).toEqual(Array.from(bytes));
    expect(Array.from(loaded.zkey as Uint8Array)).toEqual(Array.from(zkey));
    expect(seen.filter((u) => u.endsWith('deal.wasm'))).toEqual([
      'https://down.example/r9/deal.wasm',
      'https://stale.example/r9/deal.wasm',
      'https://good.example/r9/deal.wasm',
    ]);
  });
});

describe('relayers tried in order', () => {
  const action = { kind: 'abort', ceremonyId: `0x${'ab'.repeat(12)}` } as const;
  const services = (relayerUrls: string[]): Services => buildServices({ ...makeConfig(), relayerUrls });

  it('sends through the next relayer when the first is down', async () => {
    const asked: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input));
        asked.push(url.host);
        if (url.host === 'r1.example') throw new TypeError('Failed to fetch');
        return new Response(JSON.stringify({ txHash: '0xfeed' }));
      }),
    );
    expect(await services(['https://r1.example', 'https://r2.example']).submit(action)).toBe('0xfeed');
    expect(asked).toEqual(['r1.example', 'r2.example']);
  });

  it('says clearly when every relayer is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Promise.reject(new TypeError('Failed to fetch'))));
    await expect(services(['https://r1.example', 'https://r2.example']).submit(action)).rejects.toThrow(
      /none of our 2 services answered right now/,
    );
  });
});

describe('several deployments on one origin', () => {
  const LEGACY = '0x00000000000000000000000000000000000000bb' as Hex;

  /** The current deployment (fixture `now`) plus the legacy one holding `old`'s committee. */
  function twoDeployments(now: Fixture, old: Fixture): Deployments {
    const config = validateConfig({
      ...now.config,
      legacyDeployments: [{ manager: LEGACY, deploymentBlock: 5, label: '2026 rehearsal' }],
    });
    return buildDeployments(config, (c) => (c.manager.toLowerCase() === LEGACY ? old.services : now.services));
  }

  it('an old committee link (no record here) finds its legacy deployment and reads it there', async () => {
    const now = makeFixture();
    const old = makeFixture({ manager: LEGACY });
    await renderApp(now, `/c/${old.cid}`, { deployments: twoDeployments(now, old) });
    await screen.findByText(/set up with an earlier version of this service \(2026 rehearsal\)/);
    await screen.findByText(/You are viewing this as a visitor/);
    await screen.findByText(/The shared key is ready and in use/);
  });

  it('a failed read is not an answer: the lookup retries until the legacy deployment answers', async () => {
    const now = makeFixture();
    const old = makeFixture({ manager: LEGACY });
    const real = old.chain.getCeremony.bind(old.chain);
    let failures = 1;
    old.chain.getCeremony = async (cid?: Hex) => {
      if (failures > 0) {
        failures -= 1;
        throw new Error('RPC providers disagree on the finalized block — refusing');
      }
      return real(cid);
    };
    probeTiming.retryMs = 20;
    try {
      await renderApp(now, `/c/${old.cid}`, { deployments: twoDeployments(now, old) });
      await screen.findByText(/set up with an earlier version of this service/);
      await screen.findByText(/You are viewing this as a visitor/);
      expect(failures).toBe(0);
    } finally {
      probeTiming.retryMs = 8000;
    }
  });

  it('unknown everywhere is provisional: the lookup goes on and switches once a deployment knows it', async () => {
    const now = makeFixture();
    const old = makeFixture({ manager: LEGACY });
    const real = old.chain.getCeremony.bind(old.chain);
    let hidden = 2; // not at the finalized block yet for the first lookups
    old.chain.getCeremony = async (cid?: Hex) => {
      if (hidden > 0) {
        hidden -= 1;
        throw new Error('UnknownCeremony()');
      }
      return real(cid);
    };
    probeTiming.retryMs = 20;
    try {
      await renderApp(now, `/c/${old.cid}`, { deployments: twoDeployments(now, old) });
      await screen.findByText(/set up with an earlier version of this service/);
      await screen.findByText(/The shared key is ready and in use/);
      expect(hidden).toBe(0);
    } finally {
      probeTiming.retryMs = 8000;
    }
  });

  it('a member of an old committee acts through the legacy deployment', async () => {
    const user = userEvent.setup();
    const now = makeFixture();
    const old = makeFixture({ manager: LEGACY });
    old.addRequest([4n]);
    await renderApp(now, `/c/${old.cid}`, {
      deployments: twoDeployments(now, old),
      mnemonic: old.memberMnemonics[0] as string,
      record: fixtureRecord(old, 'participant', 1),
    });
    await user.click(await screen.findByRole('button', { name: 'Check and turn my key' }));
    await waitFor(() => expect(old.actions).toHaveLength(1));
    expect(old.actions[0]?.kind).toBe('submitPartial');
    expect(now.actions).toHaveLength(0);
  });

  it('a kit of an old committee restores against its legacy deployment', async () => {
    const user = userEvent.setup();
    const now = makeFixture();
    const old = makeFixture({ manager: LEGACY });
    const mnemonic = old.memberMnemonics[1] as string;
    const keys = participantKeys(mnemonic, old.config, old.cid);
    const entry: KitManifestEntry = {
      role: 'participant',
      chainId: String(old.config.chainId),
      manager: LEGACY,
      ceremonyId: old.cid,
      accountIndex: 0,
      authAddress: keys.auth.address.toLowerCase() as Hex,
      sharePublicKey: { x: toDecimal(keys.share.publicKey.x), y: toDecimal(keys.share.publicKey.y) },
    };
    await renderApp(now, '/restore', { deployments: twoDeployments(now, old) });
    const input = document.querySelector('input[type=file]') as HTMLInputElement;
    await user.upload(input, new File([serializeKit(buildKit(mnemonic, [entry]))], 'kit.json'));
    await screen.findByText(/Your key is back/);
    const record = await getRecord(old.config.chainId, LEGACY, old.cid);
    expect(record?.manager).toBe(LEGACY);
    expect(record?.participantIndex).toBe(2);
  });

  it('twelve words plus an old committee link restore there too', async () => {
    const user = userEvent.setup();
    const now = makeFixture();
    const old = makeFixture({ manager: LEGACY });
    await renderApp(now, '/restore', { deployments: twoDeployments(now, old) });
    await user.click(screen.getByLabelText('Your twelve recovery words'));
    await user.paste(old.memberMnemonics[2] as string);
    await user.type(screen.getByLabelText(/Committee link or code/), `https://example.org/c/${old.cid}`);
    await user.click(screen.getByRole('button', { name: /Rebuild my key/ }));
    await waitFor(async () => expect((await getRecord(old.config.chainId, LEGACY, old.cid))?.participantIndex).toBe(3));
  });
});
