/**
 * Flow-level protocol checks (§8.3 contribute, §9.3 unlock) against a fake
 * chain whose state is built with the real SDK.
 */

import { P, Phase } from '@vocdoni/davinci-dkg-council-sdk';
import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { describe, expect, it } from 'vitest';
import {
  abortEligible,
  finalizeEligible,
  FlowRefusal,
  listRequests,
  prepareDealing,
  preparePartial,
} from '../src/flows/participant';
import { getJoinedParticipants, inviteLinkage } from '../src/lib/chain';
import { ADAPTER, CREATOR, makeFixture, PROCESS_ID } from './helpers/fake';

const refusalReasons = async (p: Promise<unknown>): Promise<string[]> => {
  try {
    await p;
  } catch (err) {
    if (err instanceof FlowRefusal) return err.reasons;
    throw err;
  }
  throw new Error('expected a FlowRefusal');
};

describe('contribute (§8.3)', () => {
  it('builds, proves and signs a dealing for the approved roster', async () => {
    const f = makeFixture({ phase: Phase.Dealing });
    const prepared = await prepareDealing(f.memberMnemonics[0] as string, f.services, f.cid, f.rosterHash);
    expect(prepared.dealerIndex).toBe(1);
    expect(prepared.action.kind).toBe('deal');
    if (prepared.action.kind === 'deal') {
      expect(prepared.action.message.dealerIndex).toBe(1);
      expect(prepared.action.payload.C).toHaveLength(16);
    }
  });

  it('refuses when the roster changed since the user approved it', async () => {
    const f = makeFixture({ phase: Phase.Dealing });
    const reasons = await refusalReasons(
      prepareDealing(f.memberMnemonics[0] as string, f.services, f.cid, `0x${'99'.repeat(32)}` as Hex),
    );
    expect(reasons[0]).toMatch(/member list changed since you approved it/);
  });

  it('refuses outside the contribution phase and when already dealt', async () => {
    const live = makeFixture({ phase: Phase.Live });
    expect((await refusalReasons(prepareDealing(live.memberMnemonics[0] as string, live.services, live.cid, live.rosterHash)))[0]).toMatch(
      /not collecting contributions/,
    );
    const f = makeFixture({ phase: Phase.Dealing });
    f.chain.view.qualBitmap = 0b001;
    expect(
      (await refusalReasons(prepareDealing(f.memberMnemonics[0] as string, f.services, f.cid, f.rosterHash)))[0],
    ).toMatch(/already in/);
  });

  it('finalize/abort eligibility follows qual count and deadlines', () => {
    const f = makeFixture({ phase: Phase.Dealing });
    const now = Math.floor(Date.now() / 1000);
    expect(finalizeEligible(f.chain.view, now)).toBe(false);
    f.chain.view.qualBitmap = 0b111;
    expect(finalizeEligible(f.chain.view, now)).toBe(true);
    f.chain.view.qualBitmap = 0b001; // below threshold after deadline
    expect(abortEligible(f.chain.view, Number(f.chain.view.dealingDeadline) + 1)).toBe(true);
  });
});

describe('unlock (§9.3)', () => {
  it('turns the key for a genuine, bound, approved request', async () => {
    const f = makeFixture();
    const REQ = f.addRequest([5n, 7n]);
    const prepared = await preparePartial(f.memberMnemonics[0] as string, f.services, f.cid, REQ);
    expect(prepared.participantIndex).toBe(1);
    expect(prepared.processId).toBe(PROCESS_ID);
    expect(prepared.action.kind).toBe('submitPartial');
    if (prepared.action.kind === 'submitPartial') {
      expect(prepared.action.payload.D).toHaveLength(16);
    }
  });

  it('reads no event logs: listing and unlocking work while every log scan fails', async () => {
    const f = makeFixture();
    const REQ = f.addRequest([5n]);
    f.services.joinedEvents = () => Promise.reject(new Error('query exceeds max block range 10000'));
    const list = await listRequests(f.services, f.cid, 1);
    expect(list.map((r) => [r.requestId, r.processId, r.adapter])).toEqual([[REQ, PROCESS_ID, ADAPTER]]);
    const prepared = await preparePartial(f.memberMnemonics[0] as string, f.services, f.cid, REQ, undefined, {
      processId: PROCESS_ID,
    });
    expect(prepared.processId).toBe(PROCESS_ID);
  });

  it('refuses when the authenticated snapshot cannot be verified', async () => {
    const f = makeFixture();
    const REQ = f.addRequest([5n]);
    f.chain.snapshotError = 'providers disagree at the anchor';
    const reasons = await refusalReasons(preparePartial(f.memberMnemonics[0] as string, f.services, f.cid, REQ));
    expect(reasons[0]).toBe('this request could not be verified, nothing was revealed');
    expect(reasons[1]).toMatch(/providers disagree/);
  });

  it('refuses an unreadable origin, a non-approved adapter and a non-authorized creator', async () => {
    const refusal = async (opts: { bind?: boolean; allow?: boolean; authorize?: boolean }) => {
      const f = makeFixture();
      const REQ = f.addRequest([5n], opts);
      return (await refusalReasons(preparePartial(f.memberMnemonics[0] as string, f.services, f.cid, REQ)))[0];
    };
    expect(await refusal({ bind: false })).toMatch(/could not confirm which vote/);
    expect(await refusal({ allow: false })).toMatch(/not approved by this committee/);
    expect(await refusal({ authorize: false })).toMatch(/set up by someone this committee did not allow/);
  });

  it('shows a vote only when the request record and its binding agree', async () => {
    const f = makeFixture();
    const REQ = f.addRequest([5n]);
    let list = await listRequests(f.services, f.cid, 1);
    expect(list[0]?.processId).toBe(PROCESS_ID);
    expect(list[0]?.adapter).toBe(ADAPTER);
    // The record names another vote for this request (a corrupted read): the origin no longer
    // hashes to the request id, so the label disappears and the unlock is refused — the request
    // is never shown as a different vote.
    const other = `0x${'99'.repeat(31)}` as Hex;
    f.chain.origins.set(REQ.toLowerCase(), [ADAPTER, other, CREATOR]);
    f.chain.bindings.set(`${ADAPTER.toLowerCase()}:${other}`, { cid: f.cid, requestId: REQ, requested: true });
    list = await listRequests(f.services, f.cid, 1);
    expect(list[0]?.processId).toBeUndefined();
    expect(list[0]?.adapter).toBeUndefined();
    expect((await refusalReasons(preparePartial(f.memberMnemonics[0] as string, f.services, f.cid, REQ)))[0]).toMatch(
      /vote record does not match/,
    );
    // An origin whose binding does not exist at all cannot be confirmed.
    f.chain.origins.set(REQ.toLowerCase(), [ADAPTER, `0x${'98'.repeat(31)}`, CREATOR]);
    expect((await refusalReasons(preparePartial(f.memberMnemonics[0] as string, f.services, f.cid, REQ)))[0]).toMatch(
      /could not confirm which vote/,
    );
    expect(f.actions).toHaveLength(0);
  });

  it('enumerates many requests page by page', async () => {
    const f = makeFixture();
    const ids = Array.from({ length: 70 }, (_, i) =>
      f.addRequest([BigInt(i)], { processId: `0x${(i + 1).toString(16).padStart(62, '0')}` as Hex }),
    );
    const list = await listRequests(f.services, f.cid, 1);
    expect(list.map((r) => r.requestId)).toEqual(ids);
    expect(list.every((r) => r.processId !== undefined)).toBe(true);
  });

  it('pins the unlock to the exact vote the user approved', async () => {
    const f = makeFixture();
    const REQ = f.addRequest([5n]);
    const m = f.memberMnemonics[0] as string;
    // Approval passed but not yet matched to a vote on this device.
    expect((await refusalReasons(preparePartial(m, f.services, f.cid, REQ, undefined, {})))[0]).toMatch(
      /not yet matched to a vote/,
    );
    // Approval of a different vote than the authenticated binding names.
    expect(
      (
        await refusalReasons(
          preparePartial(m, f.services, f.cid, REQ, undefined, { processId: `0x${'77'.repeat(31)}` as Hex }),
        )
      )[0],
    ).toMatch(/no longer belongs to the vote you approved/);
    expect(f.actions).toHaveLength(0);
    // The approved vote matches: the partial goes through.
    const prepared = await preparePartial(m, f.services, f.cid, REQ, undefined, { processId: PROCESS_ID });
    expect(prepared.processId).toBe(PROCESS_ID);
  });

  it('refuses a tampered ciphertext (torsion point) without revealing anything', async () => {
    const f = makeFixture();
    const REQ = f.addRequest([5n]);
    const req = f.chain.requests.get(REQ.toLowerCase());
    if (!req || !req.cts[0]) throw new Error('fixture request missing');
    req.cts[0] = [0n, P - 1n, req.cts[0][2], req.cts[0][3]]; // (0, -1): on curve, outside the prime subgroup
    const reasons = await refusalReasons(preparePartial(f.memberMnemonics[0] as string, f.services, f.cid, REQ));
    expect(reasons[0]).toBe('this request could not be verified, nothing was revealed');
    expect(f.actions).toHaveLength(0); // nothing was submitted
  });
});

describe('authenticated participant reads', () => {
  it('decodes the ABI dealt flag (not an invite id) from getParticipant', async () => {
    const live = makeFixture();
    const people = await getJoinedParticipants(live.chain, live.cid, 3);
    expect(people.map((p) => p.dealt)).toEqual([true, true, true]);
    const dealing = makeFixture({ phase: Phase.Dealing });
    const waiting = await getJoinedParticipants(dealing.chain, dealing.cid, 3);
    expect(waiting.map((p) => p.dealt)).toEqual([false, false, false]);
    expect(waiting[0]?.auth).toBe(dealing.memberKeys[0]?.auth.address);
  });

  it('invite linkage only trusts events matching authenticated participants', () => {
    const f = makeFixture();
    const participants = f.chain.participants.map((p) => ({ auth: p.auth, key: p.key, dealt: true }));
    const view = { consumedInvites: f.chain.view.consumedInvites, inviteCount: f.chain.view.inviteCount };
    let linkage = inviteLinkage(f.events, f.cid, participants, view);
    expect(linkage.size).toBe(3);
    expect(linkage.get(1)).toBe(0);
    // A duplicate claim on an already-used invite is dropped (first wins).
    f.events.push({
      eventName: 'ParticipantJoined',
      args: { cid: f.cid, index: 3, auth: participants[2]?.auth, inviteId: 1 },
    });
    linkage = inviteLinkage(f.events, f.cid, participants, view);
    expect(linkage.get(3)).toBe(2);
    // A lying provider swaps the auth on one event: that claim is dropped
    // because it no longer matches the authenticated participant.
    const ev = f.events.find((e) => e.eventName === 'ParticipantJoined' && e.args.index === 1);
    if (!ev) throw new Error('fixture event missing');
    ev.args.auth = `0x${'44'.repeat(20)}`;
    linkage = inviteLinkage(f.events, f.cid, participants, view);
    expect(linkage.has(1)).toBe(false);
    expect(linkage.get(2)).toBe(1);
  });
});
