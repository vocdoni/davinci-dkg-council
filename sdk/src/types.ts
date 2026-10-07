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

/** Mirror of the contract's PhasePolicyView (architecture §1.2, protocol §8.1/§8.7). */
export interface PhasePolicyView {
  registrationMode: number;
  decryptionMode: number;
  dealingDuration: bigint;
  decryptionOpenAt: bigint;
  manualDecryptionFallbackAt: bigint;
  manualOpenedAt: bigint;
  /** The §8.7 predicate at the anchor block's timestamp. */
  decryptionOpen: boolean;
  /** closeRegistrationScheduled would succeed now. */
  scheduledRegistrationCloseDue: boolean;
}

/** Mirror of getRequestMeta (architecture §1.2). */
export interface RequestMeta {
  ceremonyId: Hex;
  fieldCount: number;
  completedBitmap: number;
  partialBitmap: number;
}

/** Mirror of getRecoverySlice (architecture §1.2): one member's recovery inputs. */
export interface RecoverySlice {
  qualBitmap: number;
  /** compressed(E_j) per dealer slot j (0-based, slot j = dealer j+1); zero if not in QUAL. */
  compressedE: bigint[];
  /** masked_{j,memberIndex} per dealer slot j; zero if not in QUAL. */
  maskedShares: bigint[];
}

/** Mirror of getPartialCommitment (architecture §1.2, protocol §10.2). */
export interface PartialCommitment {
  accepted: boolean;
  dataHash: Hex;
  publishedBlock: bigint;
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
  /**
   * The §8.7 decryption gate at the anchor, read from `isDecryptionOpen` —
   * never a local reimplementation of the clock. The snapshot builder refuses
   * to produce a snapshot while this is false.
   */
  readonly decryptionOpen: boolean;
  /** Stored roster hash, checked against the locally recomputed value. */
  readonly rosterHash: Hex;
  /** Stored deal context, checked against the locally recomputed value. */
  readonly ctx: Hex;
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
  /** PhaseMode: how registration closes (protocol §8.1). */
  registrationMode: number;
  registrationDeadline: bigint;
  dealingDuration: bigint;
  /** PhaseMode: how decryption opens (protocol §8.1). */
  decryptionMode: number;
  decryptionOpenAt: bigint;
  manualDecryptionFallbackAt: bigint;
  inviteKeys: Hex[];
  validUntil: bigint;
}

/**
 * The manual decryption-opening instruction (protocol §8.7). A signed
 * OpenDecryption is a bearer instruction: do not create or export one before
 * the moment of opening, and keep `validUntil` short.
 */
export interface OpenDecryptionMessage {
  ceremonyId: Hex;
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

/**
 * Everything needed to submit one action, directly or through the relayer.
 *
 * Fields marked optional carry state the relayer rebuilds itself from the
 * contract (§5.1): `rosterKeys` (close/deal), `C1` (submitPartial) and `C2`
 * (combine) never travel on the relayer wire, but `encodeAction` requires
 * them for direct calldata.
 */
export type Action =
  | { kind: 'createCeremony'; message: CreateCeremonyMessage; signature: Hex }
  | { kind: 'addInvites'; message: AddInvitesMessage; signature: Hex }
  | {
      kind: 'closeRegistration';
      message: CloseRegistrationMessage;
      signature: Hex;
      /** Full decompressed roster in index order; rebuilt by the relayer. */
      rosterKeys?: Point[];
    }
  | { kind: 'closeRegistrationScheduled'; ceremonyId: Hex; rosterKeys?: Point[] }
  | { kind: 'openDecryption'; message: OpenDecryptionMessage; signature: Hex }
  | { kind: 'allowAdapter'; message: AllowAdapterMessage; signature: Hex }
  | { kind: 'authorizeCreator'; message: AuthorizeCreatorMessage; signature: Hex }
  | {
      kind: 'join';
      message: JoinMessage;
      signature: Hex;
      invite: InviteMessage;
      inviteSignature: Hex;
    }
  | { kind: 'deal'; message: DealMessage; signature: Hex; payload: DealPayload; rosterKeys?: Point[] }
  | {
      kind: 'submitPartial';
      message: PartialMessage;
      signature: Hex;
      payload: PartialPayload;
      /** The request's active C1 points (fieldCount of them); rebuilt by the relayer. */
      C1?: Point[];
    }
  | { kind: 'finalize'; ceremonyId: Hex }
  | { kind: 'abort'; ceremonyId: Hex }
  | {
      kind: 'combine';
      requestId: Hex;
      memberSet: number[];
      fieldIndexes: number[];
      plaintexts: bigint[];
      /** Exactly t padded D vectors in memberSet order (protocol §10.3). */
      partialVectors: Point[][];
      /** One C2 per field index; rebuilt by the relayer from state. */
      C2?: Point[];
    }
  | {
      kind: 'publishPartialData';
      requestId: Hex;
      participantIndex: number;
      /** The full 16-slot padded D vector (protocol §10.4). */
      D: Point[];
    };
