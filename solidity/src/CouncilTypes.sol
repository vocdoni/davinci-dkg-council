// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

/// @notice Ceremony lifecycle (protocol §8). `None` is the zero-initialised storage value: a
///         ceremony exists iff its phase is not `None`.
enum Phase {
    None,
    Registration,
    Dealing,
    Live,
    Aborted
}

// ─── EIP-712 action structs (protocol §7.2; field names, types and order are normative) ───────

struct CreateCeremony {
    address organizer;
    uint64 nonce;
    uint8 threshold;
    uint64 registrationDeadline;
    uint64 dealingDuration;
    address[] inviteKeys;
    uint64 validUntil;
}

struct AddInvites {
    bytes12 ceremonyId;
    uint32 firstInviteId;
    address[] inviteKeys;
    uint64 validUntil;
}

struct CloseRegistration {
    bytes12 ceremonyId;
    uint8 participantCount;
    uint64 validUntil;
}

struct AllowAdapter {
    bytes12 ceremonyId;
    address adapter;
    uint64 validUntil;
}

struct AuthorizeCreator {
    bytes12 ceremonyId;
    address creator;
    uint64 validUntil;
}

struct Invite {
    bytes12 ceremonyId;
    uint32 inviteId;
    address participant;
    uint256 pkX;
    uint256 pkY;
    uint64 validUntil;
}

struct Join {
    bytes12 ceremonyId;
    address participant;
    uint32 inviteId;
    uint256 pkX;
    uint256 pkY;
    uint256 popAx;
    uint256 popAy;
    uint256 popZ;
    uint64 validUntil;
}

struct Deal {
    bytes12 ceremonyId;
    uint8 dealerIndex;
    bytes32 payloadHash;
    uint64 validUntil;
}

struct Partial {
    bytes12 ceremonyId;
    bytes32 requestId;
    uint8 participantIndex;
    bytes32 payloadHash;
    uint64 validUntil;
}

/// @notice `getCeremony` result (architecture §1.2). Points are circomlib twisted Edwards (TE).
struct CeremonyView {
    uint8 phase; // Phase
    address organizer;
    uint8 threshold;
    uint8 n; // 0 until close
    uint64 registrationDeadline;
    uint64 dealingDeadline; // 0 until close
    uint8 joinedCount;
    uint8 dealtCount;
    bytes32 rosterHash; // 0 until close
    bytes32 ctx; // 0 until close
    uint32 inviteCount;
    uint64 consumedInvites; // bit i = invite i consumed
    uint16 qualBitmap; // bit j-1 = dealer j dealt (== QUAL)
    uint256 pkX; // P in TE; meaningful only when phase == Live
    uint256 pkY;
}

// ─── Custom errors (architecture §1.4) ────────────────────────────────────────────────────────

error WrongPhase();
error Expired();
error BadSignature();
error ZeroAddress();
error CeremonyExists();
error UnknownCeremony();
error InviteConsumed();
error UnknownInvite();
error TooManyInvites();
error DuplicateInvite();
error BadInviteIndex();
error DuplicateParticipant();
error DuplicateKey();
error InvalidPoint();
error NotInSubgroup();
error BadPoP();
error RosterMismatch();
error BelowThreshold();
error AlreadyDealt();
error BadPadding();
error NonCanonical();
error PayloadMismatch();
error ProofInvalid();
error NotQualified();
error NotAllowedAdapter();
error NotAuthorizedCreator();
error AlreadyBound();
error UnknownBinding();
error AlreadyRequested();
error BadFieldCount();
error UnknownRequest();
error AlreadyPartial();
error BadMemberSet();
error MissingPartial();
error FieldCompleted();
error BadFieldIndexes();
error PlaintextTooLarge();
error CombineCheckFailed();
error AbortConditionNotMet();
error FinalizeConditionNotMet();

// Not in the architecture §1.4 list: conditions the protocol requires but names no error for.
error BadThreshold(); // createCeremony: threshold outside 1..16
error BadDuration(); // createCeremony: dealingDuration < 600 s, or the dealing deadline overflows uint64
error NoInvites(); // createCeremony / addInvites: empty inviteKeys
error RosterFull(); // join: 16 members already joined
error AlreadyListed(); // allowAdapter / authorizeCreator: address already in the set
