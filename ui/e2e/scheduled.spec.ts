/**
 * The scheduled variant of the journey (§8.1/§8.7): the organizer picks a
 * joining-closes date and a results-open date in the wizard and is then never
 * needed again. The chain is mined past the joining date and the list locks
 * itself (the relayer's scheduler, or any member through the app — the close
 * is permissionless); both members contribute with real in-browser proofs
 * and the key goes live. A DAVINCI tally arrives while the
 * results are still locked — the app names the date and offers no key to
 * turn — and once the chain passes the opening date the two members unlock it
 * without any organizer step. The gate is the contract's view, never the
 * device clock: the devices only follow the chain's time.
 */

import { expect, test, type BrowserContext, type Locator, type Page } from '@playwright/test';
import {
  alignClock,
  chainTimeMs,
  davinciCli,
  inviteLink,
  mineGap,
  newDevice,
  passKitStep,
  readStack,
  settleTally,
  Shots,
  type DevStack,
} from './helpers';

const N = 2;
const T = 2;
const TALLY = [3, 9];
/** Joining closes this long after creation; results open this long after creation. */
const JOIN_MINUTES = 35;
const OPEN_HOURS = 4;
const BLOCK_TIME = 22;

/** datetime-local value for a timestamp; Node and the browser share the host timezone. */
const localInput = (ms: number) => {
  const d = new Date(ms);
  const p = (v: number) => String(v).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
};

/** How the app labels an unnamed vote: ordinal + lib/format.ts shortId of the process id. */
const voteLabel = (ordinal: number, processId: string) =>
  `Vote #${ordinal} (${processId.slice(0, 8)}…${processId.slice(-4)})`;

/** Click `button`, wait for the in-browser proof to finish and `done` to confirm. */
async function prove(page: Page, button: string, done: Locator) {
  const math = page.getByText('Doing the math');
  await page.getByRole('button', { name: button }).click();
  await math.waitFor({ state: 'visible', timeout: 180_000 });
  await math.waitFor({ state: 'hidden', timeout: 600_000 });
  await expect(done).toBeVisible({ timeout: 90_000 });
}

test.describe.serial('Scheduled joining and scheduled results (n=2, t=2)', () => {
  test.setTimeout(30 * 60_000);

  let stack: DevStack;
  let shots: Shots;
  let organizer: BrowserContext;
  let org: Page;
  const members: { device: BrowserContext; page: Page }[] = [];
  let cid = '';

  const everyone = () => [organizer, ...members.map((m) => m.device)];

  test.beforeAll(async ({ browser }, testInfo) => {
    const s = readStack();
    test.skip(!s?.davinci, 'needs `make dev` with the DAVINCI registry (.dev/stack.json)');
    stack = s as DevStack;
    shots = new Shots(`${testInfo.project.name}-scheduled`);
    organizer = await newDevice(browser, testInfo);
    org = await organizer.newPage();
  });

  test.afterAll(async () => {
    if (!shots) return;
    shots.publish();
    for (const m of members) await m.device.close();
    await organizer?.close();
  });

  test('both dates picked in the wizard; joining closes itself; the key goes live', async ({ browser }, testInfo) => {
    const t0 = await chainTimeMs(stack);
    const joinCloses = t0 + JOIN_MINUTES * 60_000;
    const resultsOpen = t0 + OPEN_HOURS * 3600_000;

    // --- the wizard: scheduled joining (default) and scheduled results ---
    await org.goto('/');
    await org.getByRole('button', { name: 'Start a new committee' }).click();
    await org.getByLabel('Name (only you see this)').fill('Scheduled board 2026');
    await org.getByLabel('How many people are in the committee?').fill(String(N));
    await org.getByLabel('How many of them are needed to open the results?').fill(String(T));
    // exact: the "Joining closes on a date I pick" radio shares the prefix.
    await org.getByLabel('Joining closes on', { exact: true }).fill(localInput(joinCloses));
    await org.getByLabel('After the list is locked, how long do members get to contribute?').selectOption('1');
    await org.getByLabel('From a date I pick — nobody needs me on the day').check();
    await org.getByLabel('Results can be opened from').fill(localInput(resultsOpen));
    await shots.take(org, 'wizard', 'organizer: joining closes on a date, results open from a date — no organizer needed later');
    await org.getByRole('button', { name: 'Continue' }).click();
    await passKitStep(org, { saveAs: testInfo.outputPath('organizer-kit.json') });
    await expect(org.getByText('Ready to create')).toBeVisible();
    await expect(org.getByText(/Joining closes on /)).toBeVisible();
    await expect(org.getByText(/Results can be opened from /)).toBeVisible();
    await org.getByRole('button', { name: 'Create the committee' }).click();
    await expect(org.getByText(`0 of ${N} invited people have joined`)).toBeVisible({ timeout: 60_000 });
    cid = /\/c\/(0x[0-9a-f]{24})/.exec(org.url())?.[1] ?? '';
    expect(cid).toMatch(/^0x[0-9a-f]{24}$/);

    // No organizer step for closing: the dashboard says so and offers no lock button.
    await expect(org.getByText(/Joining closes by itself on/)).toBeVisible();
    await expect(org.getByRole('button', { name: 'Everyone is in — lock the member list' })).toHaveCount(0);
    await shots.take(org, 'org-scheduled-joining', 'organizer: joining closes by itself on the picked date, no lock button');

    // --- two members join; the invitation names the deadline ---
    for (let i = 0; i < N; i++) {
      const link = await inviteLink(org, i);
      const device = await newDevice(browser, testInfo);
      const page = await device.newPage();
      await page.goto(link);
      await expect(page.getByText('You are invited to hold a key')).toBeVisible();
      await expect(page.getByText(/Join before /)).toBeVisible();
      await page.getByRole('button', { name: 'Create my key' }).click();
      await passKitStep(page, { saveAs: testInfo.outputPath(`member${i + 1}-kit.json`) });
      await expect(page.getByText('You are on the list')).toBeVisible({ timeout: 60_000 });
      members.push({ device, page });
    }
    await expect(org.getByText(`${N} of ${N} invited people have joined`)).toBeVisible({ timeout: 45_000 });

    // --- the joining date passes on the chain; the relayer's scheduler usually locks the
    // list by itself, but the close is permissionless and the app offers it to anyone ---
    await mineGap(stack, Math.ceil(((JOIN_MINUTES + 15) * 60) / BLOCK_TIME), BLOCK_TIME);
    for (const context of everyone()) await alignClock(context, stack);
    const m1 = members[0]?.page as Page;
    const lock = m1.getByRole('button', { name: 'Lock the member list' });
    const approveFirst = m1.getByRole('button', { name: 'These are the right people — I approve this list' });
    await expect(lock.or(approveFirst)).toBeVisible({ timeout: 180_000 });
    if (await lock.isVisible().catch(() => false)) {
      await shots.take(m1, 'm1-close-offer', 'a member: the joining date passed, anyone can lock the list');
      await lock.click({ timeout: 5_000 }).catch(() => {}); // the scheduler may win the race mid-click
    }

    // --- both members approve the frozen list and contribute (real in-browser proofs) ---
    for (let i = 0; i < N; i++) {
      const page = members[i]?.page as Page;
      const approve = page.getByRole('button', { name: 'These are the right people — I approve this list' });
      await expect(approve).toBeVisible({ timeout: 180_000 });
      await approve.click();
      // At QUAL = n the relayer's scheduler finalizes within a second: the last member's
      // page may jump straight to the Live dashboard, skipping the "contribution is in" card.
      await prove(
        page,
        'Add my contribution now',
        page
          .getByRole('heading', { name: 'Your contribution is in' })
          .or(page.getByText('The shared key is ready and in use.')),
      );
    }
    // The scheduler usually finalizes by itself; if the button still shows, press it.
    const ready = org.getByText(`The key is ready: any ${T} of ${N} together can open the results`);
    const finish = org.getByRole('button', { name: 'Finish the key' });
    await expect(ready.or(finish)).toBeVisible({ timeout: 45_000 });
    if (await finish.isVisible().catch(() => false)) {
      await finish.click({ timeout: 5_000 }).catch(() => {}); // the scheduler may win the race mid-click
    }
    await expect(ready).toBeVisible({ timeout: 60_000 });

    // Live, scheduled results: the opening date is stated and there is no open-now button.
    await expect(org.getByText(/Results can be opened from /)).toBeVisible();
    await expect(org.getByRole('button', { name: 'Open the results now' })).toHaveCount(0);
    await shots.take(org, 'org-live', 'organizer: key ready; results can be opened from the picked date, no button to press');
  });

  test('a tally arrives while the results are locked; after the opening date, members unlock it alone', async () => {
    const davinci = stack.davinci as NonNullable<DevStack['davinci']>;

    // The organizer approves the DAVINCI adapter and the process creator (typed confirmation).
    const grant = async (field: string, button: string, address: string) => {
      await org.getByLabel(field).fill(address);
      await org.getByRole('button', { name: button }).click();
      await expect(org.getByText('This approval is permanent')).toBeVisible();
      await org.getByLabel(/To confirm, type its last 6 characters/).fill(address.slice(-6));
      await org.getByRole('button', { name: 'I checked the address — approve it forever' }).click();
      await expect(org.getByText(/^Done — /)).toBeVisible({ timeout: 60_000 });
    };
    await grant('Voting system connection', 'Approve…', davinci.adapter);
    await grant('Election organizer', 'Allow…', davinci.creator);

    // A DAVINCI process keyed by the ceremony; its tally settles while the results are locked.
    const created = await davinciCli<{ processId: string; ceremonyId: string; requestId: string }>(stack, [
      'create',
      '--ceremony',
      cid,
      '--fields',
      String(TALLY.length),
      '--title',
      'Scheduled board 2026: process A',
    ]);
    expect(created.ceremonyId.toLowerCase()).toBe(cid);
    await settleTally(created.processId, TALLY);

    // §8.7 on every device: the vote is listed, the date is named, no key can be turned,
    // and the copy is honest that the date is a rule members' devices check, not a time lock.
    const m1 = members[0]?.page as Page;
    await expect(m1.getByText(voteLabel(1, created.processId))).toBeVisible({ timeout: 45_000 });
    await expect(m1.getByText(/Waiting — the results are locked until /)).toBeVisible();
    await expect(m1.getByText(/relies on them honoring it/)).toBeVisible();
    await expect(m1.getByRole('button', { name: 'Check and turn my key' })).toHaveCount(0);
    await shots.take(m1, 'm1-locked-until-date', 'a member: the vote arrived, locked until the picked date, no key to turn');
    await expect(org.getByText(/Locked until /)).toBeVisible({ timeout: 45_000 });

    // --- the opening date passes on the chain; the members unlock with nobody else involved ---
    await mineGap(stack, Math.ceil((OPEN_HOURS * 3600) / BLOCK_TIME) + 60, BLOCK_TIME);
    for (const context of everyone()) await alignClock(context, stack);
    const opened = `Open — results: ${TALLY.join(', ')}`;
    for (let i = 0; i < T; i++) {
      const page = members[i]?.page as Page;
      const unlock = page.getByRole('button', { name: 'Check and turn my key' });
      await expect(unlock).toBeVisible({ timeout: 120_000 });
      await prove(page, 'Check and turn my key', page.getByText('You have done your part.').or(page.getByText(opened)));
    }
    await expect(m1.getByText(opened)).toBeVisible({ timeout: 90_000 });
    await shots.take(m1, 'm1-opened', 'a member: the vote opened after the date, the organizer never pressed anything');
    await expect(org.getByText(opened)).toBeVisible({ timeout: 45_000 });
  });
});
