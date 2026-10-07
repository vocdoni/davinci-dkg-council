/**
 * Organizer and member actors, built only from SDK calls — the same steps the app performs:
 * derived keys, invite links, the recovery-kit rehearsal before join, roster approval before
 * dealing, share recovery and the §9.3 checks before a partial.
 */

import {
  accountFromSecret,
  buildDealing,
  buildInviteLink,
  buildKit,
  buildPartialDecryption,
  ceremonyId as computeCeremonyId,
  checkRecoveredShare,
  dealContext,
  decompressPoint,
  dealerCoefficients,
  dealerEphemeral,
  dealPayloadHash,
  deriveInviteCapability,
  generateMnemonic,
  organizerAuthKey,
  parseInviteLink,
  parseKit,
  participantAuthKey,
  partialPayloadHash,
  PhaseMode,
  provePossession,
  recoverShare,
  recoveryDealingsFromSlice,
  rehearseEntry,
  restoreFromKit,
  rootFromMnemonic,
  rosterHash as computeRosterHash,
  serializeKit,
  shareEncryptionKey,
  signAction,
  signInvite,
  toDecimal,
  type Action,
  type ActionStructName,
  type CouncilRoot,
  type Hex,
  type Point,
  type SecpKey,
  type ShareKey,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { Harness } from './harness.js';

/**
 * What the actors need from their environment: the deployment, the authenticated reader, the
 * prover and chain time. The Anvil `Harness` provides it; so can a host for a live network.
 */
export type ActorHost = Pick<Harness, 'chainId' | 'manager' | 'reader' | 'prover' | 'now' | 'validUntil'>;

const APP_URL = 'https://council.test';

function randomUint64(): bigint {
  const b = new Uint8Array(8);
  globalThis.crypto.getRandomValues(b);
  return BigInt(`0x${Buffer.from(b).toString('hex')}`);
}

const sameAddress = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/** The joined share keys 1..count, decompressed from chain state (what both closes take as rosterKeys). */
async function joinedKeys(h: ActorHost, cid: Hex, count: number): Promise<Point[]> {
  const keys: Point[] = [];
  for (let i = 1; i <= count; i++) {
    keys.push(decompressPoint((await h.reader.getParticipantCompressed(cid, i)).compressedKey));
  }
  return keys;
}

export class Organizer {
  readonly mnemonic: string;
  readonly root: CouncilRoot;
  readonly key: SecpKey;

  /** A fresh recovery phrase, or `mnemonic` to resume a saved organizer (live runs). */
  constructor(
    private readonly h: ActorHost,
    mnemonic?: string,
  ) {
    this.mnemonic = mnemonic ?? generateMnemonic();
    this.root = rootFromMnemonic(this.mnemonic);
    this.key = organizerAuthKey(this.root, { chainId: h.chainId, manager: h.manager });
  }

  private sign<N extends ActionStructName>(type: N, message: unknown): Promise<Hex> {
    return signAction(accountFromSecret(this.key.secret), this.h.chainId, this.h.manager, type, message as never);
  }

  private capabilityAddresses(cid: Hex, first: number, count: number): Hex[] {
    return Array.from({ length: count }, (_, i) =>
      deriveInviteCapability(this.root, { chainId: this.h.chainId, manager: this.h.manager, ceremonyId: cid, inviteId: first + i })
        .address,
    );
  }

  /**
   * CreateCeremony with `invites` derived capability keys; returns the (pre-computed) ceremony
   * id. Defaults to the v1-equivalent policy: Manual registration with an expiry, Manual
   * decryption with no fallback (§8.1).
   */
  async create(opts: {
    threshold: number;
    invites: number;
    registrationWindow?: bigint;
    dealingDuration?: bigint;
    registrationMode?: PhaseMode;
    decryptionMode?: PhaseMode;
    decryptionOpenAt?: bigint;
    manualDecryptionFallbackAt?: bigint;
  }) {
    const nonce = randomUint64();
    const cid = computeCeremonyId(this.h.chainId, this.h.manager, this.key.address, nonce);
    const now = await this.h.now();
    const message = {
      organizer: this.key.address,
      nonce,
      threshold: opts.threshold,
      registrationMode: opts.registrationMode ?? PhaseMode.Manual,
      registrationDeadline: now + (opts.registrationWindow ?? 86_400n),
      dealingDuration: opts.dealingDuration ?? 3600n,
      decryptionMode: opts.decryptionMode ?? PhaseMode.Manual,
      decryptionOpenAt: opts.decryptionOpenAt ?? 0n,
      manualDecryptionFallbackAt: opts.manualDecryptionFallbackAt ?? 0n,
      inviteKeys: this.capabilityAddresses(cid, 0, opts.invites),
      validUntil: now + 3600n,
    };
    const action: Action = { kind: 'createCeremony', message, signature: await this.sign('CreateCeremony', message) };
    return { cid, action };
  }

  async addInvites(cid: Hex, firstInviteId: number, count: number): Promise<Action> {
    const message = {
      ceremonyId: cid,
      firstInviteId,
      inviteKeys: this.capabilityAddresses(cid, firstInviteId, count),
      validUntil: await this.h.validUntil(),
    };
    return { kind: 'addInvites', message, signature: await this.sign('AddInvites', message) };
  }

  /** The invite link carries the capability secret in its fragment (protocol §6). */
  inviteLink(cid: Hex, inviteId: number): string {
    const cap = deriveInviteCapability(this.root, { chainId: this.h.chainId, manager: this.h.manager, ceremonyId: cid, inviteId });
    return buildInviteLink(APP_URL, { ceremonyId: cid, inviteId, secret: cap.secret });
  }

  async close(cid: Hex, participantCount: number): Promise<Action> {
    const message = { ceremonyId: cid, participantCount, validUntil: await this.h.validUntil() };
    return {
      kind: 'closeRegistration',
      message,
      signature: await this.sign('CloseRegistration', message),
      // The joined roster in index order, for direct submission (the relayer rebuilds it itself).
      rosterKeys: await joinedKeys(this.h, cid, participantCount),
    };
  }

  /** The §8.7 manual decryption opening — organizer-signed, Manual mode only. */
  async openDecryption(cid: Hex): Promise<Action> {
    const message = { ceremonyId: cid, validUntil: await this.h.validUntil() };
    return { kind: 'openDecryption', message, signature: await this.sign('OpenDecryption', message) };
  }

  async allowAdapter(cid: Hex, adapter: Hex): Promise<Action> {
    const message = { ceremonyId: cid, adapter, validUntil: await this.h.validUntil() };
    return { kind: 'allowAdapter', message, signature: await this.sign('AllowAdapter', message) };
  }

  async authorizeCreator(cid: Hex, creator: Hex): Promise<Action> {
    const message = { ceremonyId: cid, creator, validUntil: await this.h.validUntil() };
    return { kind: 'authorizeCreator', message, signature: await this.sign('AuthorizeCreator', message) };
  }
}

export class Member {
  private root: CouncilRoot;
  readonly mnemonic: string;
  readonly auth: SecpKey;
  readonly share: ShareKey;
  /** 1-based member index, known after the roster is read. */
  index = 0;

  /** A fresh recovery phrase, or `mnemonic` to resume a saved member (live runs). */
  constructor(
    private readonly h: ActorHost,
    readonly cid: Hex,
    mnemonic?: string,
  ) {
    this.mnemonic = mnemonic ?? generateMnemonic();
    this.root = rootFromMnemonic(this.mnemonic);
    const ctx = { chainId: h.chainId, manager: h.manager, ceremonyId: cid };
    this.auth = participantAuthKey(this.root, ctx);
    this.share = shareEncryptionKey(this.root, ctx);
  }

  private sign<N extends ActionStructName>(type: N, message: unknown): Promise<Hex> {
    return signAction(accountFromSecret(this.auth.secret), this.h.chainId, this.h.manager, type, message as never);
  }

  /**
   * Open the invite link, save and re-import the recovery kit (the rehearsal of protocol §5.3),
   * then sign Join (participant key) and Invite (capability key).
   */
  async join(link: string): Promise<Action> {
    const { ceremonyId, inviteId, secret } = parseInviteLink(link);
    if (ceremonyId !== this.cid) throw new Error('invite link is for another ceremony');

    const entry = {
      role: 'participant' as const,
      chainId: toDecimal(this.h.chainId),
      manager: this.h.manager.toLowerCase() as Hex,
      ceremonyId: this.cid,
      accountIndex: 0,
      authAddress: this.auth.address.toLowerCase() as Hex,
      sharePublicKey: { x: toDecimal(this.share.publicKey.x), y: toDecimal(this.share.publicKey.y) },
      appUrl: APP_URL,
    };
    // The re-imported kit must re-derive exactly the join keys prepared before it was saved.
    const restored = restoreFromKit(parseKit(serializeKit(buildKit(this.mnemonic, [entry]))));
    const rehearsal = rehearseEntry(restored.root, entry, {
      authAddress: this.auth.address,
      sharePublicKey: this.share.publicKey,
    });
    if (!rehearsal.ok) throw new Error(`kit rehearsal failed: ${rehearsal.mismatches.join('; ')}`);
    this.root = restored.root;

    const pop = provePossession(
      { chainId: this.h.chainId, manager: this.h.manager, ceremonyId: this.cid, participant: this.auth.address },
      this.share.secret,
    );
    const validUntil = await this.h.validUntil();
    const message = {
      ceremonyId: this.cid,
      participant: this.auth.address,
      inviteId,
      pkX: this.share.publicKey.x,
      pkY: this.share.publicKey.y,
      popAx: pop.A.x,
      popAy: pop.A.y,
      popZ: pop.z,
      validUntil,
    };
    const invite = {
      ceremonyId: this.cid,
      inviteId,
      participant: this.auth.address,
      pkX: this.share.publicKey.x,
      pkY: this.share.publicKey.y,
      validUntil,
    };
    return {
      kind: 'join',
      message,
      signature: await this.sign('Join', message),
      invite,
      inviteSignature: await signInvite(secret, this.h.chainId, this.h.manager, invite),
    };
  }

  /**
   * Roster approval (protocol §8.3): read the frozen roster through the authenticated client,
   * recompute rosterHash and ctx locally and find this member in it.
   */
  async approveRoster() {
    const { roster, view, anchor } = await this.h.reader.getRoster(this.cid);
    const releaseId = await this.h.reader.getCircuitReleaseId(anchor);
    const rosterHash = computeRosterHash(this.h.chainId, this.h.manager, this.cid, roster);
    if (rosterHash !== view.rosterHash) throw new Error('roster hash does not match the frozen roster');
    const ctx = dealContext(this.h.chainId, this.h.manager, this.cid, rosterHash, releaseId);
    if (ctx !== view.ctx) throw new Error('dealing context does not match');
    const index = roster.authAddresses.findIndex((a) => sameAddress(a, this.auth.address)) + 1;
    if (index === 0) throw new Error('not in the roster');
    const X = roster.memberKeys[index - 1];
    if (X?.x !== this.share.publicKey.x || X.y !== this.share.publicKey.y) throw new Error('roster key mismatch');
    this.index = index;
    return { roster, view, rosterHash, ctx, releaseId };
  }

  /** A complete, proven dealing for the approved roster. */
  async deal(): Promise<Action> {
    const { roster, rosterHash, ctx, releaseId } = await this.approveRoster();
    const dctx = {
      chainId: this.h.chainId,
      manager: this.h.manager,
      ceremonyId: this.cid,
      rosterHash,
      dealerIndex: this.index,
      t: roster.t,
      circuitReleaseId: releaseId,
    };
    const built = buildDealing({
      ctx,
      dealerIndex: this.index,
      t: roster.t,
      n: roster.n,
      memberKeys: roster.memberKeys,
      coefficients: dealerCoefficients(this.root, dctx),
      ephemeral: dealerEphemeral(this.root, dctx),
    });
    const { proof, publicSignals } = await this.h.prover.prove('deal', built.witnessInput);
    if (publicSignals.join() !== built.publicSignals.join()) throw new Error('deal public signals differ from the SDK vector');
    const payload = { C: built.C, E: built.E, masked: built.masked, proof };
    const message = {
      ceremonyId: this.cid,
      dealerIndex: this.index,
      payloadHash: dealPayloadHash(ctx, payload),
      validUntil: await this.h.validUntil(),
    };
    // rosterKeys ride along for direct submission; the relayer rebuilds them from chain state.
    return { kind: 'deal', message, signature: await this.sign('Deal', message), payload, rosterKeys: roster.memberKeys };
  }

  /** Recover the final share from chain state (all §8.6 checks); returns s_i. */
  async recoverShare(): Promise<bigint> {
    const { view } = await this.approveRoster();
    const anchor = await this.h.reader.finalizedAnchor();
    const slice = await this.h.reader.getRecoverySlice(this.cid, this.index, anchor);
    const { qual, dealings } = recoveryDealingsFromSlice(slice);
    const aggregates = await this.h.reader.getAggregates(this.cid, anchor);
    const expectedMemberKey = await this.h.reader.getMemberKey(this.cid, this.index, anchor);
    const { share } = recoverShare({
      ctx: view.ctx,
      memberIndex: this.index,
      shareSecret: this.share.secret,
      qual,
      dealings,
      aggregates,
      expectedMemberKey,
    });
    checkRecoveredShare(share, expectedMemberKey);
    return share;
  }

  /**
   * A proven partial decryption for a request: the §9.3 checks run against an authenticated
   * snapshot (`getPartialRequestSnapshot`) inside `buildPartialDecryption`.
   */
  async partial(requestId: Hex): Promise<Action> {
    const share = await this.recoverShare();
    const snapshot = await this.h.reader.getPartialRequestSnapshot(requestId, this.index, { expectedCeremonyId: this.cid });
    const built = buildPartialDecryption(snapshot, share, { chainId: this.h.chainId, manager: this.h.manager });
    const { proof, publicSignals } = await this.h.prover.prove('partial', built.witnessInput);
    if (publicSignals.join() !== built.publicSignals.join()) throw new Error('partial public signals differ');
    const payload = { D: built.D, proof };
    const message = {
      ceremonyId: this.cid,
      requestId,
      participantIndex: this.index,
      payloadHash: partialPayloadHash(requestId, payload),
      validUntil: await this.h.validUntil(),
    };
    return {
      kind: 'submitPartial',
      message,
      signature: await this.sign('Partial', message),
      payload,
      C1: snapshot.cts.map((f) => f.c1),
    };
  }

  /**
   * Recompute this member's padded D vector deterministically (D_k = s_i·C1_k) and build the
   * permissionless §10.4 republish action — the fallback for a combiner whose provider lost the
   * original submission's log.
   */
  async republish(requestId: Hex): Promise<Action> {
    const share = await this.recoverShare();
    const snapshot = await this.h.reader.getPartialRequestSnapshot(requestId, this.index, { expectedCeremonyId: this.cid });
    const built = buildPartialDecryption(snapshot, share, { chainId: this.h.chainId, manager: this.h.manager });
    return { kind: 'publishPartialData', requestId, participantIndex: this.index, D: built.D };
  }
}
