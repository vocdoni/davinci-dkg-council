import { expect, test } from '@playwright/test';
import { alignClock, createCommittee, inviteLink } from './helpers';

// The journey moves the chain months ahead: this device follows the chain's clock.
test.beforeEach(({ context }) => alignClock(context));

test('organizer creates a committee and gets working invite links', async ({ page }) => {
  await createCommittee(page, { members: 3, threshold: 2 });

  // Dashboard shows the three invitations, none joined yet.
  await expect(page.getByText('0 of 3 invited people have joined')).toBeVisible();

  // Reveal the first invite link.
  const link = await inviteLink(page, 0);
  expect(link).toMatch(/\/c\/0x[0-9a-f]{24}#v1\.0\.[0-9a-f]{64}$/);
});
