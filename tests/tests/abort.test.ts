/**
 * Abort paths (protocol §8.4), with Anvil time travel: a registration the organizer never
 * closes, and a dealing phase that ends with fewer than t accepted dealings.
 */

import { describe, expect, inject, it } from 'vitest';
import { Member, Organizer } from '../src/actors.js';
import { Harness } from '../src/harness.js';

const PHASE = { Registration: 1, Dealing: 2, Live: 3, Aborted: 4 } as const;

describe('abort paths', () => {
  const h = new Harness(inject('council'));

  it('registration never closed: abort becomes valid only after the registration deadline', async () => {
    const org = new Organizer(h);
    const { cid, action } = await org.create({ threshold: 2, invites: 3, registrationWindow: 900n });
    await h.submit(action, 'relayer', { action: 'createCeremony', params: 'invites=3' });
    await h.submit(await new Member(h, cid).join(org.inviteLink(cid, 0)), 'relayer', { action: 'join' });

    await h.expectRelayRevert({ kind: 'abort', ceremonyId: cid }, 'AbortConditionNotMet');
    const lateJoin = await new Member(h, cid).join(org.inviteLink(cid, 1));
    await h.warp(901n);
    await h.expectRelayRevert(lateJoin, 'Expired');
    await h.expectRelayRevert(await org.close(cid, 1), 'Expired');

    await h.submit({ kind: 'abort', ceremonyId: cid }, 'relayer', { action: 'abort', params: 'in Registration' });
    expect((await h.reader.getCeremony(cid)).phase).toBe(PHASE.Aborted);
    await h.expectRelayRevert({ kind: 'abort', ceremonyId: cid }, 'WrongPhase');
  });

  it('fewer than t dealers by the dealing deadline: finalize is refused, abort succeeds (sent directly)', async () => {
    const org = new Organizer(h);
    const { cid, action } = await org.create({ threshold: 3, invites: 4, dealingDuration: 600n });
    await h.submit(action, 'direct', { action: 'createCeremony', params: 'invites=4' });
    const members = [0, 1, 2, 3].map(() => new Member(h, cid));
    for (const [i, m] of members.entries()) await h.submit(await m.join(org.inviteLink(cid, i)), 'direct', { action: 'join' });
    await h.submit(await org.close(cid, 4), 'direct', { action: 'closeRegistration', params: 'n=4' });

    for (const m of members.slice(0, 2)) await h.submit(await m.deal(), 'direct', { action: 'deal', params: 'n=4, t=3' });
    const late = await members[2]!.deal();
    await h.expectDirectRevert({ kind: 'finalize', ceremonyId: cid }, 'FinalizeConditionNotMet');
    await h.expectDirectRevert({ kind: 'abort', ceremonyId: cid }, 'AbortConditionNotMet');

    const { dealingDeadline } = await h.reader.getCeremony(cid);
    await h.warp(dealingDeadline - (await h.now()) + 1n);
    await h.expectDirectRevert(late, 'Expired');
    await h.expectDirectRevert({ kind: 'finalize', ceremonyId: cid }, 'FinalizeConditionNotMet');

    await h.submit({ kind: 'abort', ceremonyId: cid }, 'direct', { action: 'abort', params: 'in Dealing, |QUAL| < t' });
    const view = await h.reader.getCeremony(cid);
    expect(view.phase).toBe(PHASE.Aborted);
    expect(view.qualBitmap).toBe(0b0011); // accepted contributions are never deleted
    await h.expectDirectRevert({ kind: 'finalize', ceremonyId: cid }, 'WrongPhase');
  });
});
