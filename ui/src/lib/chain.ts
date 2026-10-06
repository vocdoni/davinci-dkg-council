/**
 * The chain-read surface the app uses, plus typed wrappers over the generic
 * authenticated batch read for views the SDK client does not wrap.
 *
 * Everything security-relevant goes through `authenticatedRead` (protocol
 * §9.3 item 1: at least two independent providers agreeing at one finalized
 * block — enforced inside the SDK client). Events are discovery only; the
 * app acts on authenticated state, never on logs.
 */

import type {
  CeremonyView,
  Dealing,
  FinalizedAnchor,
  Hex,
  PartialRequestSnapshot,
  Point,
  RequestView,
  Roster,
} from '@vocdoni/davinci-dkg-council-sdk';

interface ViewCall {
  functionName: string;
  args?: readonly unknown[];
}

/** Structural subset of the SDK's CouncilClient used by the app (mockable in tests). */
export interface ChainReader {
  readonly chainId: bigint;
  readonly manager: Hex;
  finalizedAnchor(): Promise<FinalizedAnchor>;
  authenticatedRead(
    calls: ViewCall[],
    anchor?: FinalizedAnchor,
  ): Promise<{ results: unknown[]; anchor: FinalizedAnchor }>;
  getCeremony(cid: Hex, anchor?: FinalizedAnchor): Promise<CeremonyView>;
  getInvite(cid: Hex, inviteId: number, anchor?: FinalizedAnchor): Promise<{ key: Hex; consumed: boolean }>;
  getRoster(
    cid: Hex,
    anchor?: FinalizedAnchor,
  ): Promise<{ roster: Roster; view: CeremonyView; anchor: FinalizedAnchor }>;
  getQualDealings(cid: Hex, qual: number[], anchor?: FinalizedAnchor): Promise<Map<number, Dealing>>;
  getPublicKey(cid: Hex, anchor?: FinalizedAnchor): Promise<Point>;
  getMemberKey(cid: Hex, index: number, anchor?: FinalizedAnchor): Promise<Point>;
  getRequest(requestId: Hex, anchor?: FinalizedAnchor): Promise<RequestView>;
  getPlaintexts(requestId: Hex, anchor?: FinalizedAnchor): Promise<{ ready: boolean; values: bigint[] }>;
  getCircuitReleaseId(anchor?: FinalizedAnchor): Promise<Hex>;
  /** Authenticated §9.3 snapshot for one partial decryption (SDK client). */
  getPartialRequestSnapshot(
    requestId: Hex,
    participantIndex: number,
    opts?: { expectedCeremonyId?: Hex },
  ): Promise<PartialRequestSnapshot>;
  /** Authenticate a restored identity against chain registration state (§5.3). */
  verifyRestoredIdentity(
    identity: { role: 'participant' | 'organizer'; ceremonyId: Hex; authAddress: Hex; sharePublicKey?: Point },
    anchor?: FinalizedAnchor,
  ): Promise<{ ok: boolean; mismatches: string[]; phase: number; rosterHash: Hex; participantIndex?: number }>;
}

/** A decoded manager event (discovery only). */
export interface ManagerEvent {
  eventName: string;
  args: Record<string, unknown>;
  blockNumber?: bigint | null;
}

export async function getRequestIds(client: ChainReader, cid: Hex, anchor?: FinalizedAnchor): Promise<Hex[]> {
  const { results } = await client.authenticatedRead([{ functionName: 'getRequestIds', args: [cid] }], anchor);
  return (results[0] as readonly Hex[]).slice();
}

export interface JoinedParticipant {
  auth: Hex;
  key: Point;
  /** From the ABI's fourth output (`bool dealt`). */
  dealt: boolean;
}

/** Joined participants (authenticated). ABI: getParticipant → (auth, pkX, pkY, bool dealt). */
export async function getJoinedParticipants(
  client: ChainReader,
  cid: Hex,
  count: number,
  anchor?: FinalizedAnchor,
): Promise<JoinedParticipant[]> {
  if (count === 0) return [];
  const calls: ViewCall[] = [];
  for (let i = 1; i <= count; i++) calls.push({ functionName: 'getParticipant', args: [cid, i] });
  const { results } = await client.authenticatedRead(calls, anchor);
  return results.map((r) => {
    const [auth, pkX, pkY, dealt] = r as [Hex, bigint, bigint, boolean];
    return { auth, key: { x: pkX, y: pkY }, dealt: dealt === true };
  });
}

/**
 * Which invite each member joined with — a *label-only* linkage. The chain
 * does not store it, so it comes from ParticipantJoined events (one
 * provider), cross-checked against authenticated state: the event's auth
 * address must equal the authenticated participant at that index, the invite
 * must be consumed in the authenticated view, and each index/invite may be
 * claimed once. Anything a lying provider could still do is swap labels
 * between two genuinely joined members; identity codes shown next to the
 * labels always come from authenticated data.
 */
export function inviteLinkage(
  events: ManagerEvent[],
  cid: Hex,
  participants: JoinedParticipant[],
  view: { consumedInvites: bigint; inviteCount: number },
): Map<number, number> {
  const byIndex = new Map<number, number>(); // member index (1-based) → inviteId
  const usedInvites = new Set<number>();
  for (const ev of events) {
    if (ev.eventName !== 'ParticipantJoined') continue;
    const args = ev.args as { cid?: string; index?: number | bigint; auth?: string; inviteId?: number | bigint };
    if (String(args.cid).toLowerCase() !== cid.toLowerCase()) continue;
    const index = Number(args.index);
    const inviteId = Number(args.inviteId);
    if (!Number.isInteger(index) || index < 1 || index > participants.length) continue;
    if (!Number.isInteger(inviteId) || inviteId < 0 || inviteId >= view.inviteCount) continue;
    const p = participants[index - 1];
    if (!p || p.auth.toLowerCase() !== String(args.auth).toLowerCase()) continue;
    if (((view.consumedInvites >> BigInt(inviteId)) & 1n) !== 1n) continue;
    if (byIndex.has(index) || usedInvites.has(inviteId)) continue;
    byIndex.set(index, inviteId);
    usedInvites.add(inviteId);
  }
  return byIndex;
}

export async function getBinding(
  client: ChainReader,
  adapter: Hex,
  processId: Hex,
  anchor?: FinalizedAnchor,
): Promise<{ cid: Hex; requestId: Hex; requested: boolean }> {
  const { results } = await client.authenticatedRead(
    [{ functionName: 'getBinding', args: [adapter, processId] }],
    anchor,
  );
  const [cid, requestId, requested] = results[0] as [Hex, Hex, boolean];
  return { cid, requestId, requested };
}

export async function isAdapterAllowed(
  client: ChainReader,
  cid: Hex,
  adapter: Hex,
  anchor?: FinalizedAnchor,
): Promise<boolean> {
  const { results } = await client.authenticatedRead(
    [{ functionName: 'isAdapterAllowed', args: [cid, adapter] }],
    anchor,
  );
  return results[0] as boolean;
}
