import { execFile } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { expect, type Browser, type BrowserContext, type Page, type TestInfo } from '@playwright/test';

const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(APP_DIR, '..');
export const SCREENSHOTS_DIR = path.join(APP_DIR, 'e2e', 'screenshots');
/** Where the screenshots are copied for review, with an index. */
export const SCREENS_COPY_DIR = process.env.COUNCIL_SCREENS_DIR ?? '/tmp/council-screens';

/** What `make dev` wrote to .dev/stack.json (tests/src/dev.ts DevStack). */
export interface DevStack {
  chainId: number;
  rpcUrl: string;
  appUrl: string;
  relayerUrl: string;
  manager: string;
  davinci: null | { registry: string; adapter: string; creator: string; cliConfig: string };
}

export function readStack(): DevStack | null {
  const file = path.join(REPO_ROOT, '.dev', 'stack.json');
  return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as DevStack) : null;
}

const run = promisify(execFile);

/** Run a command from the repository root and parse the JSON object on its last stdout line. */
async function runJson<T>(cmd: string, args: string[]): Promise<T> {
  const { stdout } = await run(cmd, args, { cwd: REPO_ROOT, maxBuffer: 16 << 20, timeout: 180_000 });
  const line = stdout.trim().split('\n').pop() ?? '';
  return JSON.parse(line) as T;
}

/** davinci-test (davinci-sdk) on the dev stack's registry, as the creator account. */
export function davinciCli<T>(stack: DevStack, args: string[]): Promise<T> {
  if (!stack.davinci) throw new Error('the dev stack runs without DAVINCI');
  return runJson<T>(process.execPath, ['tools/davinci-test/dist/cli.js', ...args, '--config', stack.davinci.cliConfig, '--json']);
}

/** `make dev-settle`: end the process, settle `tally` as its final state, request the decryption. */
export function settleTally(processId: string, tally: number[]): Promise<{ requestId: string; ceremonyId: string }> {
  return runJson('bash', ['scripts/dev-stack.sh', 'settle', '--process', processId, '--tally', tally.join(','), '--json']);
}

/** A fresh browser profile (a person's own device) with this project's viewport. */
export function newDevice(browser: Browser, testInfo: TestInfo): Promise<BrowserContext> {
  const { viewport, isMobile, hasTouch, deviceScaleFactor, baseURL } = testInfo.project.use;
  return browser.newContext({ viewport, isMobile, hasTouch, deviceScaleFactor, baseURL, acceptDownloads: true });
}

/** Full-page screenshots, numbered in journey order, with a one-line description each. */
export class Shots {
  private n = 0;
  private readonly entries: string[] = [];
  readonly dir: string;

  constructor(readonly project: string) {
    this.dir = path.join(SCREENSHOTS_DIR, project);
    rmSync(this.dir, { recursive: true, force: true });
    mkdirSync(this.dir, { recursive: true });
  }

  async take(page: Page, name: string, what: string): Promise<void> {
    const file = `${String(++this.n).padStart(2, '0')}-${name}.png`;
    // Transitions fast-forwarded: a just-enabled button must not be captured mid-fade.
    await page.screenshot({ path: path.join(this.dir, file), fullPage: true, animations: 'disabled' });
    this.entries.push(`- \`${this.project}/${file}\`: ${what}`);
  }

  /** Write this project's index and copy everything to SCREENS_COPY_DIR (whose INDEX.md lists every project). */
  publish(extra: string[] = []): void {
    const body = [`## ${this.project}`, '', ...this.entries, ...(extra.length ? ['', ...extra] : []), ''].join('\n');
    writeFileSync(path.join(this.dir, 'INDEX.md'), body);
    const target = path.join(SCREENS_COPY_DIR, this.project);
    rmSync(target, { recursive: true, force: true });
    mkdirSync(target, { recursive: true });
    cpSync(this.dir, target, { recursive: true });
    const sections = ['desktop', 'phone']
      .map((p) => path.join(SCREENS_COPY_DIR, p, 'INDEX.md'))
      .filter((f) => existsSync(f))
      .map((f) => readFileSync(f, 'utf8'));
    writeFileSync(
      path.join(SCREENS_COPY_DIR, 'INDEX.md'),
      [
        '# Council browser journey screenshots',
        '',
        'Full-page captures from `ui/e2e/journey.spec.ts` (Playwright, Chromium) against `make dev`:',
        'desktop is 1280×800, phone is 390×844 (mobile emulation). Files are numbered in journey order.',
        '',
        ...sections,
      ].join('\n'),
    );
  }
}

/**
 * Walk the mandatory recovery-kit step: download the kit file, then rehearse
 * by typing all twelve words back. Returns the words and the saved kit file.
 */
export async function passKitStep(
  page: Page,
  opts: { saveAs?: string; shot?: (name: string, what: string) => Promise<void> } = {},
): Promise<string[]> {
  const card = page.locator('section', { hasText: 'Save your recovery kit' });
  await expect(card).toBeVisible();
  const items = await card.locator('ol li').allTextContents();
  const words = items.map((t) => t.replace(/^\d+\.\s*/, '').trim());
  expect(words).toHaveLength(12);
  await opts.shot?.('kit', 'the recovery kit: twelve words, download or print, no way to skip');
  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download the kit file' }).click();
  const file = await download;
  if (opts.saveAs) await file.saveAs(opts.saveAs);
  await page.getByRole('button', { name: /I saved it/ }).click();
  await expect(page.getByText('Quick check')).toBeVisible();
  await page.getByLabel('Your twelve recovery words').fill(words.join(' '));
  await opts.shot?.('kit-rehearsal', 'the rehearsal: all twelve words typed back before anything is sent');
  await page.getByRole('button', { name: 'Check the words' }).click();
  return words;
}

/** Create a committee via the wizard; resolves on the dashboard. */
export async function createCommittee(page: Page, opts: { members: number; threshold: number }): Promise<string> {
  await page.goto('/');
  await page.getByRole('button', { name: 'Start a new committee' }).click();
  await page.getByLabel('How many people are in the committee?').fill(String(opts.members));
  await page.getByLabel('How many of them are needed to open the results?').fill(String(opts.threshold));
  await page.getByRole('button', { name: 'Continue' }).click();
  await passKitStep(page);
  await page.getByRole('button', { name: 'Create the committee' }).click();
  await expect(page.getByRole('heading', { name: 'People' })).toBeVisible({ timeout: 120_000 });
  return page.url();
}

/** The invite link of one invitation row on the organizer dashboard (opens the row). */
export async function inviteLink(page: Page, inviteId: number): Promise<string> {
  const row = page.locator('li', { has: page.getByLabel(`Name for invitation ${inviteId + 1} (stays on this device)`) });
  await row.getByRole('button', { name: /^(Invite|Nudge)$/ }).click();
  return row.locator('p.font-mono').innerText();
}
