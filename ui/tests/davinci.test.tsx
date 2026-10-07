/**
 * DAVINCI Elections pairing (docs/davinci-integration.md): code normalization, the pairing API
 * client's plain-language errors, the fail-closed deployment check, the allowlisted return link,
 * the Connect card's full flow (grants from the pinned registry/origin only, idempotent retries)
 * and the cosmetic-only deep link into /new. Every substitution attempt must abort with zero
 * actions signed.
 */

import { Phase, type Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  BAD_CODE_SHAPE_TEXT,
  CODE_INVALID_TEXT,
  checkDeployment,
  completePairing,
  formatPairingCode,
  GRANTS_UNCONFIRMED_TEXT,
  grantWaitTuning,
  MISMATCH_TEXT,
  normalizePairingCode,
  resolvePairing,
  returnLink,
  UNAVAILABLE_TEXT,
  UNREACHABLE_TEXT,
  type ResolvedPairing,
} from '../src/lib/davinci';
import { getRecord, type CeremonyRecord } from '../src/lib/records';
import { ADAPTER, CREATOR, DAVINCI_REGISTRY, ELECTIONS_ORIGIN, makeFixture, MANAGER } from './helpers/fake';
import { fixtureRecord, renderApp } from './helpers/render';

const CODE = 'K7F4Q2ND8HXR';
const ORG_ID = '123e4567-e89b-42d3-a456-426614174000';

/** A minimal Response-alike; the client only reads ok/status/json()/headers.get. */
const res = (status: number, body?: unknown, headers: Record<string, string> = {}) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => {
      if (body === undefined) throw new Error('no body');
      return body;
    },
    headers: { get: (k: string) => headers[k] ?? null },
  }) as unknown as Response;

const resolveBody = (over: Partial<Record<keyof ResolvedPairing | 'version', unknown>> = {}) => ({
  version: 1,
  orgId: ORG_ID,
  orgName: 'Acme',
  creator: CREATOR,
  chainId: 31337,
  manager: MANAGER,
  registry: DAVINCI_REGISTRY,
  adapter: ADAPTER,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  ...over,
});

/** A fetch stub answering the two pairing endpoints; records every call it served. */
function electionsFetch(resolve: Response | (() => Response), complete: Response | (() => Response)) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    // Once stubbed globally, every fetch of the app under test lands here (on a slow CI machine
    // even after an assertion ran); only pairing-API calls count, the rest keeps its old answer.
    if (u.startsWith(ELECTIONS_ORIGIN)) calls.push({ url: u, init: init ?? {} });
    if (u.endsWith('/complete')) return typeof complete === 'function' ? complete() : complete;
    return typeof resolve === 'function' ? resolve() : resolve;
  });
  return { fn: fn as unknown as typeof fetch, calls };
}

afterEach(() => vi.unstubAllGlobals());

describe('pairing code normalization', () => {
  it('normalizes Crockford input and refuses anything else', () => {
    expect(normalizePairingCode('K7F4-Q2ND-8HXR')).toBe(CODE);
    expect(normalizePairingCode(' k7f4 q2nd 8hxr ')).toBe(CODE);
    expect(normalizePairingCode('KOF4-Q2ND-8HXR')).toBe('K0F4Q2ND8HXR'); // O → 0
    expect(normalizePairingCode('KIF4-QlND-8HXR')).toBe('K1F4Q1ND8HXR'); // I/L → 1
    expect(normalizePairingCode('K7F4-Q2ND-8HX')).toBeNull(); // 11 symbols
    expect(normalizePairingCode('K7F4-Q2ND-8HXRA')).toBeNull(); // 13 symbols
    expect(normalizePairingCode('K7F4-Q2ND-8HXU')).toBeNull(); // U not in the alphabet
    expect(normalizePairingCode('')).toBeNull();
    expect(formatPairingCode(CODE)).toBe('K7F4-Q2ND-8HXR');
  });
});

describe('return link allowlist', () => {
  const path = `/organizer/orgs/${ORG_ID}/committees`;
  it('uses the returned path only with the one allowed shape and the resolved orgId', () => {
    expect(returnLink(ELECTIONS_ORIGIN, path, ORG_ID)).toBe(`${ELECTIONS_ORIGIN}${path}`);
    const home = `${ELECTIONS_ORIGIN}/organizer`;
    // Another org's path, an absolute URL, a traversal, extra segments: all fall back home.
    expect(returnLink(ELECTIONS_ORIGIN, `/organizer/orgs/${'0'.repeat(8)}-0000-0000-0000-${'0'.repeat(12)}/committees`, ORG_ID)).toBe(home);
    expect(returnLink(ELECTIONS_ORIGIN, 'https://evil.example/organizer', ORG_ID)).toBe(home);
    expect(returnLink(ELECTIONS_ORIGIN, `${path}/../../admin`, ORG_ID)).toBe(home);
    expect(returnLink(ELECTIONS_ORIGIN, `/organizer/orgs/${ORG_ID}/committees?x=1`, ORG_ID)).toBe(home);
    expect(returnLink(ELECTIONS_ORIGIN, '', ORG_ID)).toBe(home);
  });
});

describe('resolvePairing', () => {
  const resolveAt = (r: Response, fn?: typeof fetch) =>
    resolvePairing(ELECTIONS_ORIGIN, CODE, fn ?? (electionsFetch(r, res(500)).fn));

  it('returns the validated payload and calls the pinned origin without credentials', async () => {
    const { fn, calls } = electionsFetch(res(200, resolveBody({ orgName: '  Acme  ' })), res(500));
    const r = await resolvePairing(ELECTIONS_ORIGIN, CODE, fn);
    expect(r.orgName).toBe('Acme');
    expect(r.creator).toBe(CREATOR);
    expect(calls[0]?.url).toBe(`${ELECTIONS_ORIGIN}/api/public/council-pairing/${CODE}`);
    expect(calls[0]?.init.credentials).toBe('omit');
    // A followed redirect would let another server answer for the pinned origin.
    expect(calls[0]?.init.redirect).toBe('error');
  });

  it('maps the API errors to the organizer texts', async () => {
    await expect(resolveAt(res(404, { error: { code: 'not_found' } }))).rejects.toThrow(CODE_INVALID_TEXT);
    await expect(resolveAt(res(400, { error: { code: 'validation_error' } }))).rejects.toThrow(CODE_INVALID_TEXT);
    await expect(resolveAt(res(503))).rejects.toThrow(UNAVAILABLE_TEXT);
    await expect(resolveAt(res(429, undefined, { 'Retry-After': '600' }))).rejects.toThrow(/about 10 min/);
    await expect(
      resolveAt(res(200), (async () => {
        throw new TypeError('network down');
      }) as unknown as typeof fetch),
    ).rejects.toThrow(UNREACHABLE_TEXT);
  });

  it('refuses another protocol version and malformed payloads', async () => {
    await expect(resolveAt(res(200, resolveBody({ version: 2 })))).rejects.toThrow(/newer version/);
    await expect(resolveAt(res(200, resolveBody({ creator: '0x1234' })))).rejects.toThrow(UNAVAILABLE_TEXT);
    await expect(resolveAt(res(200, resolveBody({ orgId: '' })))).rejects.toThrow(UNAVAILABLE_TEXT);
    await expect(resolveAt(res(200, 'nope'))).rejects.toThrow(UNAVAILABLE_TEXT);
  });
});

describe('checkDeployment (fail closed, §5)', () => {
  const config = makeFixture({ davinci: true }).config;
  const ok = resolveBody() as unknown as ResolvedPairing;

  it('passes when everything matches', () => {
    expect(() => checkDeployment(ok, config, ADAPTER)).not.toThrow();
  });

  it('throws the one mismatch text for every §5 divergence', () => {
    const cases: Partial<ResolvedPairing>[] = [
      { chainId: 1 },
      { manager: '0x00000000000000000000000000000000000000bb' as Hex },
      { registry: '0x0000000000000000000000000000000000000099' as Hex },
      { adapter: '0x0000000000000000000000000000000000000066' as Hex }, // ≠ the on-chain read
      { creator: `0x${'00'.repeat(20)}` as Hex },
    ];
    for (const over of cases) {
      expect(() => checkDeployment({ ...ok, ...over }, config, ADAPTER)).toThrow(MISMATCH_TEXT);
    }
    // No pinned davinci object at all: nothing can match.
    expect(() => checkDeployment(ok, makeFixture().config, ADAPTER)).toThrow(MISMATCH_TEXT);
  });
});

describe('completePairing', () => {
  it('posts the cid and reads the result leniently', async () => {
    const { fn, calls } = electionsFetch(
      res(500),
      res(200, { ok: true, status: 'ready', statusReason: null, returnPath: '/x' }),
    );
    const cid = `0x${'ab'.repeat(12)}` as Hex;
    const r = await completePairing(ELECTIONS_ORIGIN, CODE, cid, fn);
    expect(r.status).toBe('ready');
    expect(calls[0]?.url).toBe(`${ELECTIONS_ORIGIN}/api/public/council-pairing/${CODE}/complete`);
    expect(calls[0]?.init.redirect).toBe('error'); // a redirected completion is never followed
    expect(String(calls[0]?.init.body)).toContain(cid);
    const lenient = await completePairing(ELECTIONS_ORIGIN, CODE, cid, electionsFetch(res(500), res(200, {})).fn);
    expect(lenient).toEqual({ status: 'forming', statusReason: null, returnPath: '' });
    await expect(
      completePairing(ELECTIONS_ORIGIN, CODE, cid, electionsFetch(res(500), res(404)).fn),
    ).rejects.toThrow(CODE_INVALID_TEXT);
  });
});

describe('Connect to DAVINCI Elections card', () => {
  const setup = async (opts: {
    resolve?: Response | (() => Response);
    complete?: Response | (() => Response);
    phase?: Phase;
    davinci?: boolean;
    forDavinci?: boolean;
    /** An accepted grant reaches the fake's (finalized) state at once; false models unmined. */
    applyGrants?: boolean;
    record?: Partial<CeremonyRecord>;
  } = {}) => {
    const f = makeFixture({ davinci: opts.davinci ?? true, phase: opts.phase });
    const submit0 = f.services.submit;
    f.services.submit = async (action) => {
      const hash = await submit0(action);
      if (opts.applyGrants !== false) {
        if (action.kind === 'allowAdapter') f.chain.allowedAdapters.add(action.message.adapter.toLowerCase());
        if (action.kind === 'authorizeCreator') f.chain.authorizedCreators.add(action.message.creator.toLowerCase());
      }
      return hash;
    };
    const stub = electionsFetch(
      opts.resolve ?? res(200, resolveBody()),
      opts.complete ?? res(200, { ok: true, status: 'ready', statusReason: null, returnPath: `/organizer/orgs/${ORG_ID}/committees` }),
    );
    vi.stubGlobal('fetch', stub.fn);
    const record = {
      ...fixtureRecord(f, 'organizer'),
      ...(opts.forDavinci ? { forDavinciElections: true } : {}),
      ...(opts.record ?? {}),
    };
    const utils = await renderApp(f, `/c/${f.cid}`, { mnemonic: f.organizerMnemonic, record });
    return { f, stub, record, utils };
  };

  const typeAndContinue = async (user: ReturnType<typeof userEvent.setup>, typed = 'K7F4-Q2ND-8HXR') => {
    await user.type(await screen.findByLabelText('Pairing code'), typed);
    await user.click(screen.getByRole('button', { name: 'Continue' }));
  };

  it('resolves, confirms with the organization and creator, grants, completes and links back', async () => {
    const user = userEvent.setup();
    const { f, stub } = await setup();
    await typeAndContinue(user);

    // The irreversible confirmation names the org, the committee (with its creation date,
    // this record not being a restored one) and the creator account.
    await screen.findByText(/cannot be undone/);
    expect(document.body.textContent).toContain('Acme');
    expect(document.body.textContent).toContain(CREATOR);
    expect(document.body.textContent).toContain('Created');
    await user.click(screen.getByRole('button', { name: 'Connect' }));

    await waitFor(() => expect(f.actions).toHaveLength(2));
    expect(f.actions.map((a) => a.kind)).toEqual(['allowAdapter', 'authorizeCreator']);
    const [allow, authorize] = f.actions;
    if (allow?.kind === 'allowAdapter') expect(allow.message.adapter.toLowerCase()).toBe(ADAPTER.toLowerCase());
    if (authorize?.kind === 'authorizeCreator') {
      expect(authorize.message.creator.toLowerCase()).toBe(CREATOR.toLowerCase());
    }

    await screen.findByText(/Connected to Acme on DAVINCI Elections\./);
    // The completion carried the cid; the return link is the allowlisted path on the pinned origin.
    const complete = stub.calls.find((c) => c.url.endsWith('/complete'));
    expect(String(complete?.init.body)).toContain(f.cid);
    const link = screen.getByRole('link', { name: /back to DAVINCI Elections/ });
    expect(link.getAttribute('href')).toBe(`${ELECTIONS_ORIGIN}/organizer/orgs/${ORG_ID}/committees`);
    // The connection is remembered on the record.
    await waitFor(async () => {
      const rec = await getRecord(f.config.chainId, f.config.manager, f.cid);
      expect(rec?.davinciConnections?.[0]).toMatchObject({ orgId: ORG_ID, orgName: 'Acme', origin: ELECTIONS_ORIGIN });
    });
  });

  it('aborts on every deployment substitution with zero actions and no completion', async () => {
    const cases: Record<string, unknown>[] = [
      { chainId: 1 },
      { manager: '0x00000000000000000000000000000000000000bb' },
      { registry: '0x0000000000000000000000000000000000000099' },
      // A code whose payload names another adapter than the pinned registry's on-chain one.
      { adapter: '0x0000000000000000000000000000000000000066' },
    ];
    for (const over of cases) {
      const user = userEvent.setup();
      const { f, stub, utils } = await setup({ resolve: res(200, resolveBody(over)) });
      await typeAndContinue(user);
      await screen.findByText(MISMATCH_TEXT);
      expect(screen.queryByRole('button', { name: 'Connect' })).toBeNull();
      expect(f.actions).toHaveLength(0);
      expect(stub.calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
      utils.unmount();
      vi.unstubAllGlobals();
    }
  });

  it('never grants the payload adapter: the granted address is the on-chain read', async () => {
    const user = userEvent.setup();
    const other = '0x0000000000000000000000000000000000000077' as Hex;
    const { f } = await setup({ resolve: res(200, resolveBody({ adapter: other })) });
    f.services.readDavinciAdapter = async () => other; // the registry really points there
    await typeAndContinue(user);
    await screen.findByText(/cannot be undone/);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await waitFor(() => expect(f.actions).toHaveLength(2));
    const allow = f.actions[0];
    if (allow?.kind === 'allowAdapter') expect(allow.message.adapter.toLowerCase()).toBe(other.toLowerCase());
    // Drain the flow: ending at the grants leaves the completion fetch to race into the next test.
    await screen.findByText(/Connected to Acme/);
  });

  it('shows plain errors for a malformed code, an expired code and a failed chain read', async () => {
    const user = userEvent.setup();
    const { f, stub, utils } = await setup();
    await typeAndContinue(user, 'abc');
    await screen.findByText(BAD_CODE_SHAPE_TEXT);
    expect(stub.calls).toHaveLength(0); // never sent anywhere
    utils.unmount();
    vi.unstubAllGlobals();

    const expired = await setup({ resolve: res(404, { error: { code: 'not_found' } }) });
    await typeAndContinue(userEvent.setup());
    await screen.findByText(CODE_INVALID_TEXT);
    expect(expired.f.actions).toHaveLength(0);
    expired.utils.unmount();
    vi.unstubAllGlobals();

    const down = await setup();
    down.f.services.readDavinciAdapter = async () => {
      throw new Error('rpc down');
    };
    await typeAndContinue(userEvent.setup());
    await screen.findByText(/could not check the connection on the network/);
    expect(down.f.actions).toHaveLength(0);
    expect(f.actions).toHaveLength(0);
  });

  it('skips grants already on chain but still completes (retry with a new code)', async () => {
    const user = userEvent.setup();
    const { f, stub } = await setup();
    f.chain.allowedAdapters.add(ADAPTER.toLowerCase());
    f.chain.authorizedCreators.add(CREATOR.toLowerCase());
    await typeAndContinue(user);
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByText(/Connected to Acme/);
    expect(f.actions).toHaveLength(0);
    expect(stub.calls.some((c) => c.url.endsWith('/complete'))).toBe(true);
  });

  it('explains a code that expired between the grants and the completion', async () => {
    const user = userEvent.setup();
    const { f } = await setup({ complete: res(404, { error: { code: 'not_found' } }) });
    await typeAndContinue(user);
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByText(/approvals themselves are done/);
    expect(f.actions).toHaveLength(2); // the grants landed; only the report is missing
  });

  it('refuses a redirected resolve: no grants, nothing reported to Elections', async () => {
    const user = userEvent.setup();
    const { f, stub } = await setup({
      resolve: () => {
        // What fetch does on a 3xx with redirect: 'error' — it rejects instead of following.
        throw new TypeError('redirect refused');
      },
    });
    await typeAndContinue(user);
    await screen.findByText(UNREACHABLE_TEXT);
    expect(f.actions).toHaveLength(0);
    expect(stub.calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
  });

  it('refuses a redirected or lost completion, then recovers without re-sending grants', async () => {
    const user = userEvent.setup();
    let failCompletion = true;
    const { f, stub } = await setup({
      complete: () => {
        if (failCompletion) throw new TypeError('redirect refused');
        return res(200, { ok: true, status: 'ready', statusReason: null, returnPath: `/organizer/orgs/${ORG_ID}/committees` });
      },
    });
    await typeAndContinue(user);
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByText(UNREACHABLE_TEXT);
    // Both grants are on chain, but the committee is not reported as connected.
    expect(f.actions).toHaveLength(2);
    expect(screen.queryByText(/Connected to Acme/)).toBeNull();
    failCompletion = false;
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByText(/Connected to Acme/);
    expect(f.actions).toHaveLength(2); // nothing was re-sent
    expect(stub.calls.filter((c) => c.url.endsWith('/complete'))).toHaveLength(2);
  });

  it('retries a rejected grant without re-sending the one that succeeded', async () => {
    const user = userEvent.setup();
    const { f, stub } = await setup();
    const submit1 = f.services.submit;
    let reject = true;
    f.services.submit = async (a) => {
      if (a.kind === 'authorizeCreator' && reject) {
        reject = false;
        throw new Error('the relayer refused it');
      }
      return submit1(a);
    };
    await typeAndContinue(user);
    await user.click(await screen.findByRole('button', { name: 'Connect' }));
    await screen.findByText(/That did not work: the relayer refused it/);
    expect(stub.calls.some((c) => c.url.endsWith('/complete'))).toBe(false); // the code is intact
    expect(f.actions.map((a) => a.kind)).toEqual(['allowAdapter']);
    await user.click(screen.getByRole('button', { name: 'Connect' }));
    await screen.findByText(/Connected to Acme/);
    // The adapter grant that landed the first time was not re-sent.
    expect(f.actions.map((a) => a.kind)).toEqual(['allowAdapter', 'authorizeCreator']);
  });

  it('holds the completion until the finalized state shows both grants', async () => {
    const saved = { ...grantWaitTuning };
    Object.assign(grantWaitTuning, { pollMs: 25, maxMs: 150 });
    try {
      const user = userEvent.setup();
      const { f, stub } = await setup({ applyGrants: false });
      await typeAndContinue(user);
      await user.click(await screen.findByRole('button', { name: 'Connect' }));
      await screen.findByText(GRANTS_UNCONFIRMED_TEXT);
      // Both grants were sent but neither is finalized: the one-use code must not be consumed.
      expect(f.actions).toHaveLength(2);
      expect(stub.calls.some((c) => c.url.endsWith('/complete'))).toBe(false);
      // They reach the finalized state; the retry completes without re-sending anything.
      f.chain.allowedAdapters.add(ADAPTER.toLowerCase());
      f.chain.authorizedCreators.add(CREATOR.toLowerCase());
      await user.click(screen.getByRole('button', { name: 'Connect' }));
      await screen.findByText(/Connected to Acme/);
      expect(f.actions).toHaveLength(2);
      expect(stub.calls.filter((c) => c.url.endsWith('/complete'))).toHaveLength(1);
    } finally {
      Object.assign(grantWaitTuning, saved);
    }
  });

  it('omits the creation date for a restored record (its createdAt is the restore time)', async () => {
    const user = userEvent.setup();
    await setup({ record: { restored: true } });
    await typeAndContinue(user);
    await screen.findByText(/cannot be undone/);
    expect(document.body.textContent).not.toContain('Created');
  });

  it('is absent without a pinned connection; before Live only the deep-link note shows', async () => {
    const none = await setup({ davinci: false });
    await screen.findByText('Your committee');
    expect(screen.queryByText('Connect to DAVINCI Elections')).toBeNull();
    none.utils.unmount();

    const plain = await setup({ phase: Phase.Dealing });
    await screen.findByText('Your committee');
    expect(screen.queryByText('Connect to DAVINCI Elections')).toBeNull();
    plain.utils.unmount();

    await setup({ phase: Phase.Dealing, forDavinci: true });
    await screen.findByText(/started for DAVINCI Elections/);
    expect(screen.queryByLabelText('Pairing code')).toBeNull();
  });
});

describe('deep link into /new (§9, cosmetic only)', () => {
  it('prefills only the display name and ignores every other parameter', async () => {
    const f = makeFixture({ davinci: true });
    await renderApp(
      f,
      '/new?davinci=v1&label=%20Acme%20%20Board%20&creator=0xdead&return=https://evil.example&code=K7F4Q2ND8HXR',
    );
    await screen.findByText(/This committee is for DAVINCI Elections/);
    const name = screen.getByLabelText('Name (only you see this)') as HTMLInputElement;
    expect(name.value).toBe('Acme Board'); // collapsed and trimmed
    expect(document.body.textContent).not.toContain('0xdead');
    expect(document.body.textContent).not.toContain('evil.example');
    expect(document.body.textContent).not.toContain('K7F4');
  });

  it('shows no Elections note without the versioned marker', async () => {
    const f = makeFixture({ davinci: true });
    await renderApp(f, '/new?label=Acme');
    await screen.findByText('Set up your committee');
    expect(screen.queryByText(/DAVINCI Elections/)).toBeNull();
    expect((screen.getByLabelText('Name (only you see this)') as HTMLInputElement).value).toBe('');
  });
});
