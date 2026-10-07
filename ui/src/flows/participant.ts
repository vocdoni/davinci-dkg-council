/**
 * Participant flows: join, contribute (deal) and unlock (partial decryption).
 *
 * Everything cryptographic comes from the SDK; this module sequences the
 * protocol checks (§8.2, §8.3, §9.3) and turns failures into plain-language
 * refusals the screens show verbatim. All chain state used here comes from
 * authenticated snapshots (two agreeing providers at one finalized block,
 * enforced inside the SDK client). Nothing here reads event logs: public
 * providers refuse long log ranges, and a member may come back to unlock
 * months after the ceremony.
 */

import {
  abortDue,
  accountFromSecret,
  buildDealing,
  buildPartialDecryption,
  dealContext,
  dealerCoefficients,
  dealerEphemeral,
  dealPayloadHash,
  finalizeDue,
  partialDataHash,
  partialPayloadHash,
  participantAuthKey,
  Phase,
  provePossession,
  readRequestBinding,
  readRequestOrigin,
  recoverShare,
  recoveryDealingsFromSlice,
  rootFromMnemonic,
  rosterHash,
  scheduledCloseDue,
  shareEncryptionKey,
  signAction,
  signInvite,
  type Action,
  type CeremonyView,
  type FinalizedAnchor,
  type Hex,
  type PhasePolicyView,
  type RequestBindingRefusal,
  type Roster,
  type ScheduleState,
  type SecpKey,
  type ShareKey,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { AppConfig } from '../config';
import { getRequestIds, type ChainReader } from '../lib/chain';
import { bitCount } from '../lib/format';
import { actionValidUntil } from './organizer';
import type { Services } from '../services';
import type { OnProveProgress } from '../lib/proving';

/** A refusal the user must see: the checks that failed, in plain words. */
export class FlowRefusal extends Error {
  readonly reasons: string[];

  constructor(reasons: string[]) {
    super(reasons.join('; '));
    this.name = 'FlowRefusal';
    this.reasons = reasons;
  }
}

export interface ParticipantKeys {
  auth: SecpKey;
  share: ShareKey;
}

/** This member's keys for one committee; `accountIndex` comes from the record (kit), default 0. */
export function participantKeys(mnemonic: string, config: AppConfig, cid: Hex, accountIndex = 0): ParticipantKeys {
  const root = rootFromMnemonic(mnemonic);
  const ctx = { chainId: BigInt(config.chainId), manager: config.manager, ceremonyId: cid, accountIndex };
  return { auth: participantAuthKey(root, ctx), share: shareEncryptionKey(root, ctx) };
}

// --- join (§8.2) ---

export async function prepareJoin(
  mnemonic: string,
  config: AppConfig,
  cid: Hex,
  invite: { inviteId: number; secret: bigint },
): Promise<Action> {
  const chainId = BigInt(config.chainId);
  const manager = config.manager;
  const { auth, share } = participantKeys(mnemonic, config, cid);
  const pop = provePossession(
    { chainId, manager, ceremonyId: cid, participant: auth.address },
    share.secret,
  );
  const validUntil = actionValidUntil();
  const message = {
    ceremonyId: cid,
    participant: auth.address,
    inviteId: invite.inviteId,
    pkX: share.publicKey.x,
    pkY: share.publicKey.y,
    popAx: pop.A.x,
    popAy: pop.A.y,
    popZ: pop.z,
    validUntil,
  };
  const inviteMessage = {
    ceremonyId: cid,
    inviteId: invite.inviteId,
    participant: auth.address,
    pkX: share.publicKey.x,
    pkY: share.publicKey.y,
    validUntil,
  };
  const signature = await signAction(accountFromSecret(auth.secret), chainId, manager, 'Join', message);
  const inviteSignature = await signInvite(invite.secret, chainId, manager, inviteMessage);
  return { kind: 'join', message, signature, invite: inviteMessage, inviteSignature };
}

// --- authenticated roster snapshot (§8.3 / §9.3 items 2–3) ---

export interface CeremonySnapshot {
  view: CeremonyView;
  roster: Roster;
  anchor: FinalizedAnchor;
  /** Locally recomputed and verified equal to the stored value. */
  rosterHash: Hex;
  circuitReleaseId: Hex;
}

/**
 * Read the frozen roster at one finalized anchor and recompute rosterHash and
 * ctx locally; a mismatch with the stored values is a hard refusal.
 */
export async function fetchSnapshot(client: ChainReader, cid: Hex): Promise<CeremonySnapshot> {
  const { roster, view, anchor } = await client.getRoster(cid);
  const releaseId = await client.getCircuitReleaseId(anchor);
  const rh = rosterHash(client.chainId, client.manager, cid, roster);
  const reasons: string[] = [];
  if (rh.toLowerCase() !== view.rosterHash.toLowerCase()) {
    reasons.push('the member list stored for this committee does not match what this device recomputed');
  }
  const ctx = dealContext(client.chainId, client.manager, cid, rh, releaseId);
  if (ctx.toLowerCase() !== view.ctx.toLowerCase()) {
    reasons.push('the committee context stored on the record does not match what this device recomputed');
  }
  if (reasons.length > 0) throw new FlowRefusal(reasons);
  return { view, roster, anchor, rosterHash: rh, circuitReleaseId: releaseId };
}

/** This device's 1-based member index in the frozen roster, with key checks. */
export function myMemberIndex(keys: ParticipantKeys, snapshot: CeremonySnapshot): number {
  const idx = snapshot.roster.authAddresses.findIndex(
    (a) => a.toLowerCase() === keys.auth.address.toLowerCase(),
  );
  if (idx < 0) throw new FlowRefusal(['this device’s key is not part of this committee']);
  const stored = snapshot.roster.memberKeys[idx];
  if (!stored || stored.x !== keys.share.publicKey.x || stored.y !== keys.share.publicKey.y) {
    throw new FlowRefusal(['the lock-key recorded for you does not match the one on this device']);
  }
  return idx + 1;
}

// --- contribute / deal (§8.3) ---

export interface PreparedDeal {
  action: Action;
  dealerIndex: number;
}

/**
 * Build, prove and sign this member's dealing. `approvedRosterHash` must be
 * the exact hash the user approved on this device (§8.3: no dealing without
 * explicit approval of the frozen member list).
 */
export async function prepareDealing(
  mnemonic: string,
  services: Services,
  cid: Hex,
  approvedRosterHash: Hex,
  onProgress?: OnProveProgress,
  accountIndex = 0,
): Promise<PreparedDeal> {
  const snapshot = await fetchSnapshot(services.client, cid);
  if (snapshot.view.phase !== (Phase.Dealing as number)) {
    throw new FlowRefusal(['this committee is not collecting contributions right now']);
  }
  if (snapshot.rosterHash.toLowerCase() !== approvedRosterHash.toLowerCase()) {
    throw new FlowRefusal(['the member list changed since you approved it — please review it again']);
  }
  const keys = participantKeys(mnemonic, services.config, cid, accountIndex);
  const dealerIndex = myMemberIndex(keys, snapshot);
  if (((snapshot.view.qualBitmap >> (dealerIndex - 1)) & 1) === 1) {
    throw new FlowRefusal(['your contribution is already in — nothing more to do']);
  }
  const root = rootFromMnemonic(mnemonic);
  const dctx = {
    chainId: services.client.chainId,
    manager: services.client.manager,
    ceremonyId: cid,
    accountIndex,
    rosterHash: snapshot.rosterHash,
    dealerIndex,
    t: snapshot.roster.t,
    circuitReleaseId: snapshot.circuitReleaseId,
  };
  const built = buildDealing({
    ctx: snapshot.view.ctx,
    dealerIndex,
    t: snapshot.roster.t,
    n: snapshot.roster.n,
    memberKeys: snapshot.roster.memberKeys,
    coefficients: dealerCoefficients(root, dctx),
    ephemeral: dealerEphemeral(root, dctx),
  });
  const result = await services.prove('deal', built.witnessInput, onProgress);
  assertSignalsMatch(result.publicSignals, built.publicSignals);
  const payload = { C: built.C, E: built.E, masked: built.masked, proof: result.proof };
  const message = {
    ceremonyId: cid,
    dealerIndex,
    payloadHash: dealPayloadHash(snapshot.view.ctx, payload),
    validUntil: actionValidUntil(),
  };
  const signature = await signAction(
    accountFromSecret(keys.auth.secret),
    services.client.chainId,
    services.client.manager,
    'Deal',
    message,
  );
  return { action: { kind: 'deal', message, signature, payload }, dealerIndex };
}

function assertSignalsMatch(got: bigint[], expected: bigint[]): void {
  if (got.length !== expected.length || got.some((v, i) => v !== expected[i])) {
    throw new Error('the proof does not match what this device computed — stopping');
  }
}

// --- schedule predicates (§8.1/§8.3/§8.4, permissionless steps) ---

/** Assemble the SDK's ScheduleState from the ceremony view + phase policy. */
export function toScheduleState(view: CeremonyView, policy: PhasePolicyView): ScheduleState {
  return {
    registrationMode: policy.registrationMode,
    decryptionMode: policy.decryptionMode,
    registrationDeadline: view.registrationDeadline,
    dealingDuration: policy.dealingDuration,
    decryptionOpenAt: policy.decryptionOpenAt,
    manualDecryptionFallbackAt: policy.manualDecryptionFallbackAt,
    phase: view.phase,
    manualOpenedAt: policy.manualOpenedAt,
    dealingDeadline: view.dealingDeadline,
    joinedCount: view.joinedCount,
    threshold: view.threshold,
    n: view.n,
    qualCount: bitCount(view.qualBitmap),
  };
}

export const finalizeEligible = (state: ScheduleState, nowSeconds: number): boolean =>
  finalizeDue(state, BigInt(nowSeconds));

export const abortEligible = (state: ScheduleState, nowSeconds: number): boolean =>
  abortDue(state, BigInt(nowSeconds));

/** §8.3: the permissionless scheduled close would succeed now (anyone may send it). */
export const scheduledCloseEligible = (state: ScheduleState, nowSeconds: number): boolean =>
  scheduledCloseDue(state, BigInt(nowSeconds));

// --- unlock / partial decryption (§9.3) ---

export interface RequestSummary {
  requestId: Hex;
  /**
   * The vote this request belongs to — read from the request record itself
   * (`getRequestOrigin`) and authenticated at one finalized anchor with
   * getBinding/isAdapterAllowed/isCreatorAuthorized; never taken from logs.
   * Undefined when the binding could not be verified.
   */
  processId?: Hex;
  adapter?: Hex;
  fieldCount: number;
  partialCount: number;
  threshold: number;
  myPartialDone: boolean;
  ready: boolean;
  values?: bigint[];
  /**
   * The vote is bound to this committee but its results were never submitted
   * for opening: there is nothing to unlock yet (§9.3 'not-submitted').
   */
  notSubmitted: boolean;
}

interface Binding {
  adapter: Hex;
  processId: Hex;
}

const BINDING_REFUSALS: Record<RequestBindingRefusal, string> = {
  'other-ceremony': 'this unlock request belongs to another committee',
  'binding-mismatch': 'the vote record does not match this unlock request',
  'adapter-not-allowed': 'the connection that asked for this unlock is not approved by this committee',
  'creator-not-authorized': 'the vote was set up by someone this committee did not allow',
  'not-submitted': 'this vote has not asked to be opened yet',
};

/**
 * Authenticate one request's vote binding from contract state at `anchor`
 * (protocol §9.3 item 3; SDK `readRequestBinding`): the stored origin
 * recomputes to this request id, getBinding maps back to exactly this
 * (requestId, ceremonyId) and says it was submitted, the adapter is allowed
 * and the creator authorized by this committee. No event logs are read, so
 * this works the same months after the ceremony. Returns the plain-language
 * refusal instead of a binding when any check or read fails.
 */
async function verifiedBinding(
  client: ChainReader,
  cid: Hex,
  requestId: Hex,
  anchor: FinalizedAnchor,
): Promise<{ binding: Binding | null; refusal: string; notSubmitted: boolean }> {
  let checked;
  try {
    checked = await readRequestBinding(client, cid, requestId, anchor);
  } catch {
    return {
      binding: null,
      refusal: 'we could not confirm which vote this unlock request belongs to',
      notSubmitted: false,
    };
  }
  if (!checked.ok) {
    const refusal = BINDING_REFUSALS[checked.reason] ?? 'the vote record does not match this unlock request';
    if (checked.reason === 'not-submitted') {
      // Every other check already passed in order (origin recomputes to this
      // request id, adapter allowed, creator authorized): the origin is safe
      // to show as a label even though there is nothing to unlock yet.
      try {
        const origin = await readRequestOrigin(client, requestId, anchor);
        return {
          binding: { adapter: origin.adapter, processId: origin.processId },
          refusal,
          notSubmitted: true,
        };
      } catch {
        return { binding: null, refusal, notSubmitted: true };
      }
    }
    return { binding: null, refusal, notSubmitted: false };
  }
  return { binding: { adapter: checked.adapter, processId: checked.processId }, refusal: '', notSubmitted: false };
}

/** List this ceremony's decryption requests with progress, for the screens. */
export async function listRequests(services: Services, cid: Hex, myIndex?: number): Promise<RequestSummary[]> {
  const client = services.client;
  const { view, anchor } = await client.getRoster(cid);
  const ids = await getRequestIds(client, cid, anchor);
  const out: RequestSummary[] = [];
  for (const id of ids) {
    const meta = await client.getRequestMeta(id, anchor);
    const plain = await client.getPlaintexts(id, anchor);
    const verified = await verifiedBinding(client, cid, id, anchor);
    out.push({
      requestId: id,
      processId: verified.binding?.processId,
      adapter: verified.binding?.adapter,
      fieldCount: meta.fieldCount,
      partialCount: bitCount(meta.partialBitmap),
      threshold: view.threshold,
      myPartialDone: myIndex !== undefined && ((meta.partialBitmap >> (myIndex - 1)) & 1) === 1,
      ready: plain.ready,
      values: plain.ready ? plain.values : undefined,
      notSubmitted: verified.notSubmitted,
    });
  }
  return out;
}

export interface PreparedPartial {
  action: Action;
  participantIndex: number;
  /** Shown to the user before submitting. */
  processId?: Hex;
}

/**
 * §8.6: recover this member's final share from the stored recovery slice and
 * aggregates at the snapshot's anchor — state views only, no event logs, so it
 * works the same months after the ceremony. Every hard check (E_j subgroup,
 * aggregate validity, Horner(A, m) == PK_m, s·G == PK_m) runs inside the SDK.
 */
async function recoverMyShare(
  client: ChainReader,
  cid: Hex,
  snapshot: CeremonySnapshot,
  keys: ParticipantKeys,
  memberIndex: number,
  expectedMemberKey: { x: bigint; y: bigint },
): Promise<bigint> {
  try {
    const slice = await client.getRecoverySlice(cid, memberIndex, snapshot.anchor);
    const aggregates = await client.getAggregates(cid, snapshot.anchor);
    const { qual, dealings } = recoveryDealingsFromSlice(slice);
    return recoverShare({
      ctx: snapshot.view.ctx,
      memberIndex,
      shareSecret: keys.share.secret,
      qual,
      dealings,
      aggregates,
      expectedMemberKey,
    }).share;
  } catch (err) {
    throw new FlowRefusal([
      'your share of the committee key could not be checked against the public record — refusing to continue',
      err instanceof Error ? err.message : String(err),
    ]);
  }
}

/**
 * Run every §9.3 check and build the signed partial-decryption action.
 * Any failed check throws a FlowRefusal whose reasons the screen shows.
 *
 * `approved`, when given, pins the user's consent: the vote they saw and
 * approved on screen. The authenticated binding must name exactly that vote
 * or we refuse before touching the share.
 */
export async function preparePartial(
  mnemonic: string,
  services: Services,
  cid: Hex,
  requestId: Hex,
  onProgress?: OnProveProgress,
  approved?: { processId?: Hex },
  accountIndex = 0,
): Promise<PreparedPartial> {
  const client = services.client;
  // Items 1–2: authenticated snapshot, recomputed rosterHash and ctx.
  const snapshot = await fetchSnapshot(client, cid);
  if (snapshot.view.phase !== (Phase.Live as number)) {
    throw new FlowRefusal(['this committee key is not ready yet']);
  }
  // Item 3: own index, authorization address and lock key as frozen.
  const keys = participantKeys(mnemonic, services.config, cid, accountIndex);
  const memberIndex = myMemberIndex(keys, snapshot);

  // The authenticated request snapshot (§9.3 items 1, 4): request existence,
  // ceremony binding, Live phase, PK_i and the ciphertexts, frozen at one
  // finalized anchor by the SDK client.
  let partialSnap;
  try {
    partialSnap = await client.getPartialRequestSnapshot(requestId, memberIndex, { expectedCeremonyId: cid });
  } catch (err) {
    throw new FlowRefusal([
      'this request could not be verified, nothing was revealed',
      err instanceof Error ? err.message : String(err),
    ]);
  }

  // The request must have come through an approved connection bound to a
  // vote we can show the user — read from state and authenticated, never
  // taken from event logs.
  const { binding, refusal } = await verifiedBinding(client, cid, requestId, snapshot.anchor);
  if (!binding) throw new FlowRefusal([refusal]);

  // Pin the user's approval to the exact vote they saw.
  if (approved) {
    if (!approved.processId) {
      throw new FlowRefusal([
        'this request is not yet matched to a vote on this device — wait a moment and try again',
      ]);
    }
    if (approved.processId.toLowerCase() !== binding.processId.toLowerCase()) {
      throw new FlowRefusal([
        'this request no longer belongs to the vote you approved — check the list again before turning your key',
      ]);
    }
  }

  // Item 6: recover the share from the stored recovery slice (§8.6) and check
  // it against the member key the authenticated snapshot carries.
  const share = await recoverMyShare(client, cid, snapshot, keys, memberIndex, partialSnap.memberKey);

  // All remaining §9.3 checks run inside the SDK before any multiplication.
  let built;
  try {
    built = buildPartialDecryption(partialSnap, share, { chainId: client.chainId, manager: client.manager });
  } catch (err) {
    throw new FlowRefusal([
      'this request could not be verified, nothing was revealed',
      err instanceof Error ? err.message : String(err),
    ]);
  }
  const result = await services.prove('partial', built.witnessInput, onProgress);
  assertSignalsMatch(result.publicSignals, built.publicSignals);
  const payload = { D: built.D, proof: result.proof };
  const message = {
    ceremonyId: cid,
    requestId,
    participantIndex: memberIndex,
    payloadHash: partialPayloadHash(requestId, payload),
    validUntil: actionValidUntil(),
  };
  const signature = await signAction(
    accountFromSecret(keys.auth.secret),
    client.chainId,
    client.manager,
    'Partial',
    message,
  );
  return {
    action: { kind: 'submitPartial', message, signature, payload },
    participantIndex: memberIndex,
    processId: binding.processId,
  };
}

// --- republish partial data (§10.4) ---

export interface PreparedRepublish {
  action: Action;
  participantIndex: number;
  /** The commitment's stored publication block before this republication (authenticated). */
  publishedBlock: bigint;
}

/**
 * Rebuild this member's already-admitted D vector and offer it for
 * republication (§10.4, permissionless). D is deterministic (s_i·C1), and the
 * rebuilt data must hash to exactly the commitment stored on chain — anything
 * else is a hard refusal, so this can never publish something different from
 * what was originally admitted. The authenticated snapshot enforces the §8.7
 * gate, so nothing is ever recomputed while the results are still locked.
 * Authenticated current state only: no event log is read, so this works with
 * providers that no longer serve the original publication block.
 */
export async function prepareRepublish(
  mnemonic: string,
  services: Services,
  cid: Hex,
  requestId: Hex,
  accountIndex = 0,
): Promise<PreparedRepublish> {
  const client = services.client;
  const snapshot = await fetchSnapshot(client, cid);
  if (snapshot.view.phase !== (Phase.Live as number)) {
    throw new FlowRefusal(['this committee key is not ready yet']);
  }
  const keys = participantKeys(mnemonic, services.config, cid, accountIndex);
  const memberIndex = myMemberIndex(keys, snapshot);
  const commitment = await client.getPartialCommitment(requestId, memberIndex, snapshot.anchor);
  if (!commitment.accepted) {
    throw new FlowRefusal(['you have not turned your key for this vote yet — nothing to republish']);
  }
  let partialSnap;
  try {
    partialSnap = await client.getPartialRequestSnapshot(requestId, memberIndex, { expectedCeremonyId: cid });
  } catch (err) {
    throw new FlowRefusal([
      'this request could not be verified, nothing was revealed',
      err instanceof Error ? err.message : String(err),
    ]);
  }
  const share = await recoverMyShare(client, cid, snapshot, keys, memberIndex, partialSnap.memberKey);
  let built;
  try {
    built = buildPartialDecryption(partialSnap, share, { chainId: client.chainId, manager: client.manager });
  } catch (err) {
    throw new FlowRefusal([
      'this request could not be verified, nothing was revealed',
      err instanceof Error ? err.message : String(err),
    ]);
  }
  const rebuilt = partialDataHash({
    chainId: client.chainId,
    manager: client.manager,
    ceremonyId: cid,
    requestId,
    participantIndex: memberIndex,
    fieldCount: partialSnap.fieldCount,
    D: built.D,
  });
  if (rebuilt.toLowerCase() !== commitment.dataHash.toLowerCase()) {
    throw new FlowRefusal([
      'the data this device rebuilt does not match what you originally published — refusing to continue',
    ]);
  }
  return {
    action: { kind: 'publishPartialData', requestId, participantIndex: memberIndex, D: built.D },
    participantIndex: memberIndex,
    publishedBlock: commitment.publishedBlock,
  };
}
