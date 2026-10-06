/** Shared types for the Council SDK. */

export type Hex = `0x${string}`;

/** An affine point on BabyJubJub in circomlib twisted Edwards coordinates. */
export interface Point {
  x: bigint;
  y: bigint;
}

/** A Groth16 proof in the pinned snarkjs `exportSolidityCallData` word order (protocol §7.2). */
export interface Groth16Proof {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
}

/** The frozen roster of a ceremony (protocol §4.3). */
export interface Roster {
  t: number;
  n: number;
  /** Authorization addresses in index order (slot i = member i+1), length n. */
  authAddresses: Hex[];
  /** Share-encryption public keys X_i in TE, index order, length n. */
  memberKeys: Point[];
}

/** A stored dealing as read back from the contract. */
export interface Dealing {
  /** Commitment points C_0..C_15, identity padded for k >= t. */
  C: Point[];
  /** Ephemeral point E. */
  E: Point;
  /** Masked shares, slot i = member i+1, zero padded for i >= n. */
  masked: bigint[];
}

/** Mirror of the contract's CeremonyView (architecture §1.2). */
export interface CeremonyView {
  phase: number;
  organizer: Hex;
  threshold: number;
  n: number;
  registrationDeadline: bigint;
  dealingDeadline: bigint;
  joinedCount: number;
  dealtCount: number;
  rosterHash: Hex;
  ctx: Hex;
  inviteCount: number;
  consumedInvites: bigint;
  qualBitmap: number;
  pkX: bigint;
  pkY: bigint;
}

/** Mirror of getRequest (architecture §1.2). */
export interface RequestView {
  ceremonyId: Hex;
  fieldCount: number;
  completedBitmap: number;
  partialBitmap: number;
  /** cts[k] = [C1.x, C1.y, C2.x, C2.y] in TE. */
  cts: [bigint, bigint, bigint, bigint][];
}

/** One ElGamal ciphertext field. */
export interface CiphertextField {
  c1: Point;
  c2: Point;
}

/**
 * An authenticated, frozen snapshot of everything §9.3 needs before a partial
 * decryption. Produced only by `CouncilClient.getPartialRequestSnapshot`
 * (authenticated multi-provider reads at one finalized anchor); consumed by
 * `buildPartialDecryption`, which re-checks every locally checkable item
 * before any scalar multiplication.
 */
export interface PartialRequestSnapshot {
  /** The client's pinned chain id. */
  readonly chainId: bigint;
  /** The client's pinned manager address. */
  readonly manager: Hex;
  readonly ceremonyId: Hex;
  readonly requestId: Hex;
  /** Ceremony phase at the anchor (must be Live). */
  readonly phase: number;
  /** Roster size at the anchor. */
  readonly n: number;
  readonly participantIndex: number;
  /** PK_i as stored on chain for `participantIndex`. */
  readonly memberKey: Point;
  readonly fieldCount: number;
  /** The request's ciphertext fields, exactly `fieldCount` of them. */
  readonly cts: readonly CiphertextField[];
  /** The finalized anchor the snapshot was read at. */
  readonly anchor: { blockNumber: bigint; blockHash: Hex };
}

// --- EIP-712 action messages (protocol §7.2) ---

export interface CreateCeremonyMessage {
  organizer: Hex;
  nonce: bigint;
  threshold: number;
  registrationDeadline: bigint;
  dealingDuration: bigint;
  inviteKeys: Hex[];
  validUntil: bigint;
}

export interface AddInvitesMessage {
  ceremonyId: Hex;
  firstInviteId: number;
  inviteKeys: Hex[];
  validUntil: bigint;
}

export interface CloseRegistrationMessage {
  ceremonyId: Hex;
  participantCount: number;
  validUntil: bigint;
}

export interface AllowAdapterMessage {
  ceremonyId: Hex;
  adapter: Hex;
  validUntil: bigint;
}

export interface AuthorizeCreatorMessage {
  ceremonyId: Hex;
  creator: Hex;
  validUntil: bigint;
}

export interface InviteMessage {
  ceremonyId: Hex;
  inviteId: number;
  participant: Hex;
  pkX: bigint;
  pkY: bigint;
  validUntil: bigint;
}

export interface JoinMessage {
  ceremonyId: Hex;
  participant: Hex;
  inviteId: number;
  pkX: bigint;
  pkY: bigint;
  popAx: bigint;
  popAy: bigint;
  popZ: bigint;
  validUntil: bigint;
}

export interface DealMessage {
  ceremonyId: Hex;
  dealerIndex: number;
  payloadHash: Hex;
  validUntil: bigint;
}

export interface PartialMessage {
  ceremonyId: Hex;
  requestId: Hex;
  participantIndex: number;
  payloadHash: Hex;
  validUntil: bigint;
}

/** The heavy calldata of a `deal` call (padded to capacity, protocol §8.3). */
export interface DealPayload {
  /** 16 commitment points in TE, identity padding for k >= t. */
  C: Point[];
  E: Point;
  /** 16 masked shares, zero padding for i >= n. */
  masked: bigint[];
  proof: Groth16Proof;
}

/** The heavy calldata of a `submitPartial` call. */
export interface PartialPayload {
  /** 16 partial points in TE, identity padding for k >= fieldCount. */
  D: Point[];
  proof: Groth16Proof;
}

/** Everything needed to submit one action, directly or through the relayer. */
export type Action =
  | { kind: 'createCeremony'; message: CreateCeremonyMessage; signature: Hex }
  | { kind: 'addInvites'; message: AddInvitesMessage; signature: Hex }
  | { kind: 'closeRegistration'; message: CloseRegistrationMessage; signature: Hex }
  | { kind: 'allowAdapter'; message: AllowAdapterMessage; signature: Hex }
  | { kind: 'authorizeCreator'; message: AuthorizeCreatorMessage; signature: Hex }
  | {
      kind: 'join';
      message: JoinMessage;
      signature: Hex;
      invite: InviteMessage;
      inviteSignature: Hex;
    }
  | { kind: 'deal'; message: DealMessage; signature: Hex; payload: DealPayload }
  | { kind: 'submitPartial'; message: PartialMessage; signature: Hex; payload: PartialPayload }
  | { kind: 'finalize'; ceremonyId: Hex }
  | { kind: 'abort'; ceremonyId: Hex }
  | {
      kind: 'combine';
      requestId: Hex;
      memberSet: number[];
      fieldIndexes: number[];
      plaintexts: bigint[];
    };
