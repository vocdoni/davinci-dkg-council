/**
 * The whole Council journey in a real browser, against `make dev`: the
 * organizer creates a 2-of-3 committee in the app, choosing to close joining
 * himself and to open the results himself (with the default safety date on);
 * three people join from their invite links on their own devices (browser
 * contexts), each saving and rehearsing a recovery kit; the organizer locks
 * the list; every member
 * approves the frozen list and contributes with real snarkjs proving in the
 * app's worker; the key goes live; the organizer approves the DAVINCI adapter
 * and a process creator; davinci-test creates a DAVINCI process on the
 * ceremony; the dev stack settles a known tally and requests its decryption
 * (as the e2e DAVINCI round-trip does); the results are locked until the
 * organizer opens them (§8.7), which he does through the irreversible
 * confirmation; two members unlock the vote in the browser,
 * the relayer combines, davinci-test finalizes, and the organizer dashboard
 * and davinci-test show the tally. Then about six months pass (700,000 blocks),
 * every device's RPC behaves like a public provider (eth_getLogs refused above
 * 10,000 blocks), a member clears the browser, restores from the twelve words
 * plus the committee link, and unlocks a vote created after the gap without a
 * single log read.
 *
 * Every step is captured full-page into e2e/screenshots/<project>/ (copied to
 * /tmp/council-screens with an index); in-browser proving times are printed
 * and written next to the screenshots.
 */

import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  alignClock,
  davinciCli,
  inviteLink,
  mineGap,
  newDevice,
  passKitStep,
  publicProviderLimits,
  readStack,
  settleTally,
  Shots,
  type DevStack,
  type RpcRecord,
} from './helpers';

const N = 3;
const T = 2;
const NAMES = ['Alice', 'Bob', 'Carol'];
const COMMITTEE = 'Board election 2026';
/** The gap before the second vote: 700,000 blocks of 22 s, about six months. */
const GAP_BLOCKS = 700_000;
const GAP_BLOCK_TIME = 22;
/** The known final tallies of the two DAVINCI processes (one value per ballot field). */
const TALLY_A = [7, 0, 3, 12];
const TALLY_B = [42, 1_000_000, 5];

interface CreatedProcess {
  processId: string;
  ceremonyId: string;
  requestId: string;
  encryptionKey: { x: string; y: string };
}

interface ResultsReport {
  state: string;
  values?: string[];
}

interface Member {
  device: BrowserContext;
  page: Page;
  words: string[];
}

/** How the app labels an unnamed vote: ordinal + lib/format.ts shortId of the process id. */
const voteLabel = (ordinal: number, processId: string) =>
  `Vote #${ordinal} (${processId.slice(0, 8)}…${processId.slice(-4)})`;

interface Timing {
  step: string;
  member: string;
  downloadMs: number;
  proveMs: number;
}

/**
 * Click `button`, then time the two phases the app shows: fetching the
 * circuit files (progress bar) and "Doing the math" (witness + Groth16 proof
 * in the worker). Resolves once `done` shows (the relayed update confirmed).
 */
async function proveInBrowser(page: Page, button: string, done: Locator, onProving?: () => Promise<void>) {
  const math = page.getByText('Doing the math');
  const t0 = Date.now();
  await page.getByRole('button', { name: button }).click();
  await math.waitFor({ state: 'visible', timeout: 180_000 });
  const t1 = Date.now();
  await onProving?.();
  await math.waitFor({ state: 'hidden', timeout: 600_000 });
  const t2 = Date.now();
  await expect(done).toBeVisible({ timeout: 90_000 });
  return { downloadMs: t1 - t0, proveMs: t2 - t1 };
}

test.describe.serial('Council journey in the browser (n=3, t=2)', () => {
  test.setTimeout(30 * 60_000);

  let stack: DevStack;
  let shots: Shots;
  let organizer: BrowserContext;
  let org: Page;
  const members: Member[] = [];
  const timings: Timing[] = [];
  let cid = '';

  const shot = (page: Page, name: string, what: string) => shots.take(page, name, what);

  test.beforeAll(async ({ browser }, testInfo) => {
    const s = readStack();
    test.skip(!s?.davinci, 'needs `make dev` with the DAVINCI registry (.dev/stack.json)');
    stack = s as DevStack;
    shots = new Shots(testInfo.project.name);
    organizer = await newDevice(browser, testInfo);
    org = await organizer.newPage();
  });

  test.afterAll(async () => {
    if (!shots) return;
    const lines = timings.map(
      (t) =>
        `- ${t.step} (${t.member}): checks + circuit files ${(t.downloadMs / 1000).toFixed(1)} s, proof ${(t.proveMs / 1000).toFixed(1)} s`,
    );
    writeFileSync(path.join(shots.dir, 'timings.json'), `${JSON.stringify(timings, null, 2)}\n`);
    shots.publish(lines.length ? ['In-browser proving (Chromium, this run):', '', ...lines] : []);
    console.log(`[${shots.project}] in-browser proving:\n${lines.join('\n')}`);
    for (const m of members) await m.device.close();
    await organizer?.close();
  });

  test('the organizer creates the committee, three members join, contribute with in-browser proofs, the key goes live', async ({
    browser,
  }, testInfo) => {
    // --- organizer: create, with the recovery kit saved and rehearsed ---
    await org.goto('/');
    await expect(org.getByRole('heading', { name: 'Shared keys for elections' })).toBeVisible();
    await shot(org, 'landing', 'landing page of a fresh browser: start a committee, or restore from a kit');
    await org.getByRole('button', { name: 'Start a new committee' }).click();
    await org.getByLabel('Name (only you see this)').fill(COMMITTEE);
    await org.getByLabel('How many people are in the committee?').fill(String(N));
    await org.getByLabel('How many of them are needed to open the results?').fill(String(T));
    await expect(org.getByText(`any ${T} of ${N} together can open the results`)).toBeVisible();
    // Schedule (§8.1): close joining by hand, open the results by hand — with the default
    // safety date on, so a disappearing organizer cannot lock the results away forever.
    await org.getByLabel("I'll close joining myself when everyone is in").check();
    await expect(org.getByLabel('…or automatically on a safety date, in case I never do')).toBeChecked();
    await shot(org, 'org-create', `organizer: creation wizard filled in (${N} members, any ${T} open the results)`);
    await org.getByRole('button', { name: 'Continue' }).click();
    await passKitStep(org, {
      saveAs: testInfo.outputPath('organizer-kit.json'),
      shot: (name, what) => shot(org, `org-${name}`, `organizer: ${what}`),
    });
    await expect(org.getByText('Ready to create')).toBeVisible();
    await expect(org.getByText(/You close joining yourself — or it closes automatically on/)).toBeVisible();
    await expect(org.getByText(/You open the results yourself — or they unlock automatically on/)).toBeVisible();
    await shot(org, 'org-review', 'organizer: review before creating (nothing sent to anyone yet)');
    await org.getByRole('button', { name: 'Create the committee' }).click();
    await expect(org.getByText(`0 of ${N} invited people have joined`)).toBeVisible({ timeout: 60_000 });
    cid = /\/c\/(0x[0-9a-f]{24})/.exec(org.url())?.[1] ?? '';
    expect(cid).toMatch(/^0x[0-9a-f]{24}$/);

    // Local-only labels, then the three invite links.
    const links: string[] = [];
    for (let i = 0; i < N; i++) {
      await org.getByLabel(`Name for invitation ${i + 1} (stays on this device)`).fill(NAMES[i] as string);
      links.push(await inviteLink(org, i));
      if (i > 0) await org.getByRole('button', { name: 'Close' }).nth(1).click();
    }
    for (const link of links) expect(link).toMatch(new RegExp(`/c/${cid}#v1\\.\\d\\.[0-9a-f]{64}$`));
    await shot(org, 'org-invites', 'organizer dashboard: three labelled invitations; Alice\'s link open with copy, email and QR code');
    await org.getByRole('button', { name: 'Close' }).click();

    // --- three members, each on a fresh device: open the link, save + rehearse the kit, join ---
    for (let i = 0; i < N; i++) {
      const who = NAMES[i] as string;
      const device = await newDevice(browser, testInfo);
      const page = await device.newPage();
      await page.goto(links[i] as string);
      await expect(page.getByText('You are invited to hold a key')).toBeVisible();
      expect(new URL(page.url()).hash, 'the invite secret is stripped from the address bar').toBe('');
      await shot(page, `m${i + 1}-invite`, `${who}: opened the invite link (secret already stripped from the URL)`);
      await page.getByRole('button', { name: 'Create my key' }).click();
      const words = await passKitStep(page, {
        saveAs: testInfo.outputPath(`member${i + 1}-kit.json`),
        shot: i === 0 ? (name, what) => shot(page, `m1-${name}`, `${who}: ${what}`) : undefined,
      });
      await expect(page.getByText('You are on the list')).toBeVisible({ timeout: 60_000 });
      await shot(page, `m${i + 1}-joined`, `${who}: joined, waiting for the organizer to lock the list`);
      members.push({ device, page, words });
    }

    // --- organizer: review and lock the list ---
    await expect(org.getByText(`${N} of ${N} invited people have joined`)).toBeVisible({ timeout: 45_000 });
    await shot(org, 'org-all-joined', 'organizer: everyone joined, each row with its identity code');
    await org.getByRole('button', { name: 'Everyone is in — lock the member list' }).click();
    await expect(org.getByText(`Lock the list with these ${N} members?`)).toBeVisible({ timeout: 30_000 });
    for (const name of NAMES) await expect(org.getByText(new RegExp(`\\d\\. ${name} — [0-9A-F]{8}`))).toBeVisible();
    await shot(org, 'org-lock-review', 'organizer: "do you recognize everyone?" review of the frozen list');
    await org.getByRole('button', { name: 'Yes, lock it' }).click();
    await expect(org.getByText(`0 of ${N} members have added their contribution`)).toBeVisible({ timeout: 60_000 });
    await shot(org, 'org-locked', 'organizer: list locked, waiting for contributions');

    // --- members: approve the frozen roster, contribute (real proof in the browser worker) ---
    for (let i = 0; i < N; i++) {
      const { page } = members[i] as Member;
      const who = NAMES[i] as string;
      const approve = page.getByRole('button', { name: 'These are the right people — I approve this list' });
      await expect(approve).toBeVisible({ timeout: 45_000 });
      await expect(page.getByText('(you)')).toBeVisible();
      await shot(page, `m${i + 1}-roster`, `${who}: the locked member list to approve (codes comparable over the phone)`);
      await approve.click();
      const t = await proveInBrowser(
        page,
        'Add my contribution now',
        // At QUAL = n the relayer's scheduler finalizes within a second: the last member's
        // page may jump straight to the Live dashboard, skipping the "contribution is in" card.
        page
          .getByRole('heading', { name: 'Your contribution is in' })
          .or(page.getByText('The shared key is ready and in use.')),
        i === 0 ? () => shot(page, 'm1-proving', `${who}: contribution proof running in the browser worker`) : undefined,
      );
      timings.push({ step: 'contribution (deal circuit)', member: who, ...t });
      await shot(page, `m${i + 1}-contributed`, `${who}: contribution in (${(t.proveMs / 1000).toFixed(1)} s of in-browser proving)`);
    }

    // --- the key goes live (the scheduler finalizes at QUAL = n within a second; if the
    // button still shows, the organizer presses it — the end state, Live, is what counts) ---
    const ready = org.getByText(`The key is ready: any ${T} of ${N} together can open the results`);
    const finish = org.getByRole('button', { name: 'Finish the key' });
    await expect(ready.or(finish)).toBeVisible({ timeout: 45_000 });
    if (await finish.isVisible().catch(() => false)) {
      await shot(org, 'org-finish', 'organizer: all contributions in, "Finish the key"');
      await finish.click({ timeout: 5_000 }).catch(() => {}); // the scheduler may win the race mid-click
    }
    await expect(ready).toBeVisible({ timeout: 60_000 });
    await shot(org, 'org-live', 'organizer: the shared key is ready; connections and votes appear');
    await expect(members[0]?.page.getByText('No vote has asked to be opened yet') as Locator).toBeVisible({ timeout: 45_000 });
    await shot(members[0]?.page as Page, 'm1-live', 'Alice: key ready, nothing to unlock yet');
  });

  test('a DAVINCI vote on the committee key is unlocked by two members in the browser', async () => {
    const davinci = stack.davinci as NonNullable<DevStack['davinci']>;

    // Before the organizer allows the adapter, the registry refuses the process.
    await expect(davinciCli(stack, ['create', '--ceremony', cid])).rejects.toThrow();

    // --- organizer: approve the DAVINCI adapter and the process creator (typed confirmation) ---
    const grant = async (field: string, button: string, address: string, name: string, what: string) => {
      await org.getByLabel(field).fill(address);
      await org.getByRole('button', { name: button }).click();
      await expect(org.getByText('This approval is permanent')).toBeVisible();
      await org.getByLabel(/To confirm, type its last 6 characters/).fill(address.slice(-6));
      const confirm = org.getByRole('button', { name: 'I checked the address — approve it forever' });
      await expect(confirm).toBeEnabled();
      await shot(org, name, what);
      await confirm.click();
      await expect(org.getByText(/^Done — /)).toBeVisible({ timeout: 60_000 });
    };
    await grant(
      'Voting system connection',
      'Approve…',
      davinci.adapter,
      'org-approve-adapter',
      'organizer: approving the DAVINCI CouncilAdapter, confirmed by typing its last characters',
    );
    await grant(
      'Election organizer',
      'Allow…',
      davinci.creator,
      'org-allow-creator',
      'organizer: allowing the DAVINCI process creator',
    );
    await shot(org, 'org-connections', 'organizer: both connections approved');

    // --- DAVINCI: a process keyed by the ceremony (davinci-test), its tally settled and its decryption requested ---
    const created = await davinciCli<CreatedProcess>(stack, [
      'create',
      '--ceremony',
      cid,
      '--fields',
      String(TALLY_A.length),
      '--title',
      `${COMMITTEE}: process A`,
    ]);
    expect(created.ceremonyId.toLowerCase()).toBe(cid);
    const settled = await settleTally(created.processId, TALLY_A);
    expect(settled.requestId).toBe(created.requestId);

    // --- the results are locked until the organizer opens them (§8.7: the contract's gate) ---
    const alice = members[0]?.page as Page;
    await expect(alice.getByText(voteLabel(1, created.processId))).toBeVisible({ timeout: 45_000 });
    await expect(alice.getByText(/Waiting — the results stay locked until the organizer opens them/)).toBeVisible();
    await expect(alice.getByRole('button', { name: 'Check and turn my key' })).toHaveCount(0);
    await shot(alice, 'm1-locked', 'Alice: the vote arrived, but the results stay locked until the organizer opens them');

    // --- organizer: open the results (irreversible; the consequence is stated before the button) ---
    await expect(org.getByText(/Results open when you say so — or on .* at the latest\./)).toBeVisible();
    await org.getByRole('button', { name: 'Open the results now' }).click();
    await expect(org.getByText('Opening the results cannot be undone.')).toBeVisible();
    await shot(org, 'org-open-confirm', 'organizer: opening the results, the consequence stated first');
    await org.getByRole('button', { name: 'I understand — open the results' }).click();
    await expect(org.getByText('The results are open').or(org.getByText('You opened the results.'))).toBeVisible({
      timeout: 90_000,
    });
    await shot(org, 'org-opened', 'organizer: results opened for every vote on this key, current and future');

    // --- two members unlock it in the browser ---
    for (const i of [0, 1]) {
      const { page } = members[i] as Member;
      const who = NAMES[i] as string;
      const unlock = page.getByRole('button', { name: 'Check and turn my key' });
      await expect(unlock).toBeVisible({ timeout: 45_000 });
      await expect(page.getByText(voteLabel(1, created.processId))).toBeVisible();
      await shot(page, `m${i + 1}-unlock-request`, `${who}: an unlock request for the DAVINCI vote, bound and verified`);
      const t = await proveInBrowser(page, 'Check and turn my key', page.getByText('You have done your part.').or(page.getByText('Open — results')));
      timings.push({ step: 'unlock (partial circuit)', member: who, ...t });
      await shot(page, `m${i + 1}-unlocked`, `${who}: partial decryption sent (${(t.proveMs / 1000).toFixed(1)} s of in-browser proving)`);
    }

    // --- the relayer combines; the organizer dashboard shows the tally ---
    const opened = `Open — results: ${TALLY_A.join(', ')}`;
    await expect(members[0]?.page.getByText(opened) as Locator).toBeVisible({ timeout: 90_000 });
    await shot(members[0]?.page as Page, 'm1-opened', 'Alice: the vote is open, the decrypted tally shown');
    await expect(org.getByText(opened)).toBeVisible({ timeout: 45_000 });
    await shot(org, 'org-results', `organizer dashboard: the decrypted tally ${TALLY_A.join(', ')}`);

    // --- finalize into the DAVINCI registry and read it back through davinci-sdk ---
    const results = await davinciCli<ResultsReport>(stack, ['results', '--process', created.processId, '--finalize']);
    expect(results.state).toBe('results');
    expect(results.values).toEqual(TALLY_A.map(String));
  });

  test('six months later, through public-provider RPC limits, a member who cleared the browser restores from twelve words and the committee link, then unlocks', async () => {
    const carol = members[2] as Member;
    const alice = members[0] as Member;

    // About six months pass. Every device lives through them (its clock moves with the chain's)
    // and from now on reaches the chain through an RPC with public-provider limits.
    await mineGap(stack, GAP_BLOCKS, GAP_BLOCK_TIME);
    const rpc = new Map<string, RpcRecord[]>();
    for (const [name, context] of [
      ['organizer', organizer],
      ['alice', alice.device],
      ['carol', carol.device],
    ] as const) {
      await alignClock(context, stack);
      rpc.set(name, await publicProviderLimits(context, stack));
    }

    // Clear everything this origin stored (root, records, cached circuit files) with no app page open.
    await carol.page.close();
    const blank = await carol.device.newPage();
    await blank.goto('/config.json');
    await blank.evaluate(async () => {
      localStorage.clear();
      sessionStorage.clear();
      await new Promise<void>((resolve, reject) => {
        const req = indexedDB.deleteDatabase('council');
        req.onsuccess = () => resolve();
        req.onerror = () => reject(req.error ?? new Error('deleteDatabase failed'));
        req.onblocked = () => reject(new Error('deleteDatabase blocked'));
      });
      for (const key of await caches.keys()) await caches.delete(key);
    });
    await blank.close();
    const page = await carol.device.newPage();
    carol.page = page;
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'Shared keys for elections' })).toBeVisible();
    await expect(page.getByText('Your committees')).toHaveCount(0);
    await shot(page, 'm3-cleared', 'Carol, about six months later: browser storage cleared, the app knows nothing about her');

    // Restore from the twelve words + the committee link.
    await page.getByRole('button', { name: 'Restore from a recovery kit' }).click();
    await page.getByLabel('Your twelve recovery words').fill(carol.words.join(' '));
    await page.getByLabel('Committee link or code').fill(`${new URL(page.url()).origin}/c/${cid}`);
    await shot(page, 'm3-restore', 'Carol: restoring from the twelve words and the committee link');
    await page.getByRole('button', { name: 'Rebuild my key' }).click();
    await expect(page.getByText('Your key is back. You can act for this committee again.')).toBeVisible({
      timeout: 60_000,
    });
    await expect(page.getByText('Your committees')).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText('you are a member')).toBeVisible();
    await shot(page, 'm3-restored', 'Carol: key rebuilt and checked against the public record, committee back');
    await page.getByRole('link', { name: /you are a member/ }).click();
    await expect(page.getByText('The shared key is ready and in use.')).toBeVisible({ timeout: 30_000 });

    // A second vote, unlocked by the restored member and one other.
    const created = await davinciCli<CreatedProcess>(stack, [
      'create',
      '--ceremony',
      cid,
      '--fields',
      String(TALLY_B.length),
      '--title',
      `${COMMITTEE}: process B`,
    ]);
    await settleTally(created.processId, TALLY_B);
    const opened = `Open — results: ${TALLY_B.join(', ')}`;
    for (const [m, who, name] of [
      [carol, 'Carol', 'm3'],
      [alice, 'Alice', 'm1'],
    ] as const) {
      const row = m.page.locator('li', { hasText: voteLabel(2, created.processId) });
      const unlock = row.getByRole('button', { name: 'Check and turn my key' });
      await expect(unlock).toBeVisible({ timeout: 45_000 });
      await shot(m.page, `${name}-unlock-request-b`, `${who}: unlock request for the second vote`);
      const t0 = Date.now();
      await unlock.click();
      const math = m.page.getByText('Doing the math');
      await math.waitFor({ state: 'visible', timeout: 180_000 });
      const t1 = Date.now();
      await math.waitFor({ state: 'hidden', timeout: 600_000 });
      const t2 = Date.now();
      await expect(row.getByText('You have done your part.').or(row.getByText(opened))).toBeVisible({ timeout: 90_000 });
      timings.push({ step: 'unlock after restore (partial circuit)', member: who, downloadMs: t1 - t0, proveMs: t2 - t1 });
      await shot(m.page, `${name}-unlocked-b`, `${who}: partial decryption for the second vote sent`);
    }
    await expect(carol.page.getByText(opened)).toBeVisible({ timeout: 90_000 });
    await shot(carol.page, 'm3-opened-b', `Carol (restored): the second vote is open, tally ${TALLY_B.join(', ')}`);
    await expect(org.getByText(opened)).toBeVisible({ timeout: 45_000 });
    await shot(org, 'org-results-b', 'organizer dashboard: both votes open with their tallies');

    const results = await davinciCli<ResultsReport>(stack, ['results', '--process', created.processId, '--finalize']);
    expect(results.state).toBe('results');
    expect(results.values).toEqual(TALLY_B.map(String));

    // The restored member and the other unlocker never asked for a log; the organizer's labels
    // were read in ranges a public provider serves; nothing was refused.
    const carolCalls = rpc.get('carol') ?? [];
    expect(carolCalls.length).toBeGreaterThan(0);
    for (const who of ['carol', 'alice']) expect((rpc.get(who) ?? []).filter((c) => c.method === 'eth_getLogs')).toEqual([]);
    for (const calls of rpc.values()) expect(calls.filter((c) => c.refused)).toEqual([]);
    const orgLogs = (rpc.get('organizer') ?? []).filter((c) => c.method === 'eth_getLogs');
    expect(orgLogs.every((c) => c.range !== undefined && c.range[1] - c.range[0] < 10_000n)).toBe(true);
  });
});
