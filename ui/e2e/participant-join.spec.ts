import { expect, test } from '@playwright/test';
import { alignClock, createCommittee, inviteLink, newDevice, passKitStep } from './helpers';

// The journey moves the chain months ahead: this device follows the chain's clock.
test.beforeEach(({ context }) => alignClock(context));

test('a participant joins through an invite link on a fresh device', async ({ browser, page }, testInfo) => {
  await createCommittee(page, { members: 2, threshold: 2 });
  const link = await inviteLink(page, 0);

  // Fresh context = the invitee's own device.
  const device = await newDevice(browser, testInfo);
  const invitee = await device.newPage();
  await invitee.goto(link);
  await expect(invitee.getByText('You are invited to hold a key')).toBeVisible();
  // The capability secret must be wiped from the address bar.
  expect(new URL(invitee.url()).hash).toBe('');

  await invitee.getByRole('button', { name: 'Create my key' }).click();
  await passKitStep(invitee);
  await expect(invitee.getByText('You are on the list')).toBeVisible({ timeout: 120_000 });

  // The organizer sees them arrive.
  await expect(page.getByText('1 of 2 invited people have joined')).toBeVisible({ timeout: 60_000 });
  await device.close();
});
