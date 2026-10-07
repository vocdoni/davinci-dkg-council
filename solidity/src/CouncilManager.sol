// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {BabyJubJub} from "./libraries/BabyJubJub.sol";
import "./CouncilTypes.sol";
import {CouncilCurve} from "./libraries/CouncilCurve.sol";
import {CouncilEIP712} from "./libraries/CouncilEIP712.sol";
import {CouncilStorage} from "./CouncilStorage.sol";
import {CouncilViews} from "./CouncilViews.sol";
import {CouncilOps} from "./CouncilOps.sol";
import {ICouncilCore, ICouncilOps} from "./interfaces/ICouncil.sol";
import {IDealVerifier, IPartialVerifier} from "./interfaces/ICouncilVerifiers.sol";

/// @title CouncilManager
/// @notice Invite-only threshold DKG for DAVINCI (docs/protocol.md v2, normative). No owner,
///         no upgradability, no pausability: each ceremony's organizer acts on its own ceremony
///         through EIP-712 signed actions; the scheduled close, finalize, abort, combine and partial
///         re-publication are permissionless; process binding and decryption requests come from
///         organizer-allowed adapters.
///
///         Points are circomlib twisted Edwards (TE) everywhere outside the curve arithmetic,
///         which runs in BabyJubJub.sol's reduced chart (protocol §2.2). Immutable points are
///         stored compressed (protocol §2.5): whenever one is needed in full, the caller supplies
///         it and `CouncilCurve.authenticate` admits exactly the stored point.
///
///         EIP-170 split (architecture §1.7): the read surface lives in CouncilViews and the
///         rarely-used transitions (addInvites, both closes, openDecryption, the grant pair, abort,
///         partial re-publication) in CouncilOps, both created by this constructor and reached through the delegatecall fallback below on this
///         contract's storage (all three inherit the one CouncilStorage layout). Every function of
///         ICouncil, and so of the adapter-facing ICouncilManager, is served at this address.
contract CouncilManager is CouncilStorage, ICouncilCore {
    // ─── Protocol constants (protocol §2) ─────────────────────────────────────────────────────

    uint256 internal constant MAX_COMBINE_FIELDS = 4;
    uint256 internal constant MIN_DEALING_DURATION = 600;
    /// @dev 365 days. Bounds every dealing window, so the organizer's close
    ///      (`now + dealingDuration`) cannot overflow uint64 and every Dealing phase times out.
    uint256 internal constant MAX_DEALING_DURATION = 31_536_000;
    uint256 internal constant RESULT_BOUND = 1 << 40;
    /// @dev floor(2^256 / r)·r = 42·r: HashToScalar rejection limit (protocol §3.1).
    uint256 internal constant LIMIT_R = 114913275077156194916793630162600694215226186830659824886409057759834789667722;

    bytes32 internal constant TAG_CEREMONY = keccak256("davinci-dkg-council/v1/ceremony");
    bytes32 internal constant TAG_DEAL_PAYLOAD = keccak256("davinci-dkg-council/v1/deal-payload");
    bytes32 internal constant TAG_JOIN_POP = keccak256("davinci-dkg-council/v1/join-pop");
    bytes32 internal constant TAG_REQUEST = keccak256("davinci-dkg-council/v1/request");
    bytes32 internal constant TAG_PARTIAL_PAYLOAD = keccak256("davinci-dkg-council/v1/partial-payload");

    uint256 internal constant P = CouncilCurve.P;
    uint256 internal constant R = CouncilCurve.R;
    /// @dev BN254 base field: the range of every Groth16 proof coordinate (protocol §7.2).
    uint256 internal constant Q_BN = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    /// @notice Generated Groth16 verifier of the dealing circuit (87 public signals).
    address public immutable dealVerifier;
    /// @notice Generated Groth16 verifier of the partial-decryption circuit (67 public signals).
    address public immutable partialVerifier;
    /// @notice protocol §4.4 circuit release id; bound into every dealing context.
    bytes32 public immutable circuitReleaseId;
    /// @notice CouncilViews instance created here; the fallback delegatecalls it.
    address public immutable views;
    /// @dev CouncilOps instance created here (the manager's second CREATE, nonce 2); the fallback
    ///      delegatecalls it for exactly the ICouncilOps selectors.
    address internal immutable ops;

    constructor(address dealVerifier_, address partialVerifier_, bytes32 circuitReleaseId_) {
        if (dealVerifier_ == address(0) || partialVerifier_ == address(0)) revert ZeroAddress();
        dealVerifier = dealVerifier_;
        partialVerifier = partialVerifier_;
        circuitReleaseId = circuitReleaseId_;
        views = address(new CouncilViews());
        ops = address(new CouncilOps(circuitReleaseId_));
    }

    /// @notice Serves the ICouncilOps and ICouncilViews selectors through a delegatecall on this
    ///         contract's storage, into one of the two immutable, constructor-created logic
    ///         contracts. The eight ICouncilOps selectors are whitelisted to CouncilOps; every
    ///         other selector goes to CouncilViews, which is view-only code and reverts on unknown
    ///         selectors. Plain value transfers revert here (non-payable).
    fallback() external {
        bytes4 sel = msg.sig;
        address target = sel == ICouncilOps.abort.selector || sel == ICouncilOps.allowAdapter.selector
            || sel == ICouncilOps.authorizeCreator.selector || sel == ICouncilOps.publishPartialData.selector
            || sel == ICouncilOps.openDecryption.selector || sel == ICouncilOps.addInvites.selector
            || sel == ICouncilOps.closeRegistration.selector || sel == ICouncilOps.closeRegistrationScheduled.selector
            ? ops
            : views;
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            calldatacopy(ptr, 0, calldatasize())
            let ok := delegatecall(gas(), target, ptr, calldatasize(), 0, 0)
            returndatacopy(ptr, 0, returndatasize())
            if iszero(ok) { revert(ptr, returndatasize()) }
            return(ptr, returndatasize())
        }
    }

    // ─── Lifecycle ────────────────────────────────────────────────────────────────────────────

    /// @notice protocol §8.1. Claims `ceremonyIdFor(organizer, nonce)` and fixes the immutable
    ///         registration and decryption policies.
    function createCeremony(CreateCeremony calldata a, bytes calldata orgSig) external returns (bytes12 cid) {
        if (block.timestamp > a.validUntil) revert Expired();
        if (a.organizer == address(0)) revert ZeroAddress();
        CouncilEIP712.verify(CouncilEIP712.hashCreateCeremony(a), orgSig, a.organizer);
        cid = ceremonyIdFor(a.organizer, a.nonce);
        Ceremony storage c = _ceremonies[cid];
        if (cid == bytes12(0) || c.phase != Phase.None) revert CeremonyExists();
        if (a.threshold == 0 || a.threshold > MAX_T) revert BadThreshold();
        if (a.dealingDuration < MIN_DEALING_DURATION || a.dealingDuration > MAX_DEALING_DURATION) revert BadDuration();
        _requireSchedule(a);

        c.phase = Phase.Registration;
        c.organizer = a.organizer;
        c.t = a.threshold;
        c.registrationMode = a.registrationMode;
        c.decryptionMode = a.decryptionMode;
        c.registrationDeadline = a.registrationDeadline;
        c.dealingDuration = a.dealingDuration;
        c.decryptionOpenAt = a.decryptionOpenAt;
        c.manualDecryptionFallbackAt = a.manualDecryptionFallbackAt;
        _appendInvites(c, a.inviteKeys);
        emit CeremonyCreated(
            cid,
            a.organizer,
            a.threshold,
            a.registrationMode,
            a.registrationDeadline,
            a.dealingDuration,
            a.decryptionMode,
            a.decryptionOpenAt,
            a.manualDecryptionFallbackAt
        );
    }

    /// @notice protocol §8.2. `participantSig` signs `a` (Join) with the participant's
    ///         authorization key, `inviteSig` signs `inv` (Invite) with the capability key.
    function join(Join calldata a, bytes calldata participantSig, Invite calldata inv, bytes calldata inviteSig)
        external
    {
        Ceremony storage c = _existing(a.ceremonyId);
        _requireJoining(c);
        if (block.timestamp > a.validUntil || block.timestamp > inv.validUntil) revert Expired();
        uint256 index = uint256(c.joinedCount) + 1;
        if (index > MAX_N) revert RosterFull();
        if (
            inv.ceremonyId != a.ceremonyId || inv.inviteId != a.inviteId || inv.participant != a.participant
                || inv.pkX != a.pkX || inv.pkY != a.pkY
        ) revert PayloadMismatch();
        uint256 inviteId = a.inviteId;
        if (inviteId >= c.inviteCount) revert UnknownInvite();
        if ((c.consumedInvites >> inviteId) & 1 != 0) revert InviteConsumed();
        if (a.participant == address(0)) revert ZeroAddress();
        CouncilEIP712.verify(CouncilEIP712.hashJoin(a), participantSig, a.participant);
        CouncilEIP712.verify(CouncilEIP712.hashInvite(inv), inviteSig, c.invites[inviteId]);
        if (c.authIndex[a.participant] != 0) revert DuplicateParticipant();

        uint256 pkxRed = CouncilCurve.requireSubgroupTE(a.pkX, a.pkY);
        // injective on canonical on-curve points: equal words <=> equal keys (protocol §8.2)
        uint256 word = CouncilCurve.compress(a.pkX, a.pkY);
        if (c.keyUsed[word]) revert DuplicateKey();
        _verifyPoP(a, pkxRed);

        c.joinedCount = uint8(index);
        c.consumedInvites |= uint64(1 << inviteId);
        Participant storage p = c.participants[index - 1];
        p.auth = a.participant;
        p.compressedX = word;
        c.authIndex[a.participant] = uint8(index);
        c.keyUsed[word] = true;
        emit ParticipantJoined(a.ceremonyId, uint8(index), a.participant, uint8(inviteId));
    }

    /// @notice protocol §8.3: one proven Feldman dealing per member. The contract authenticates
    ///         the re-supplied roster, builds the 87 public inputs itself (protocol §8.5) and, on
    ///         success, folds the commitments into the aggregates and stores compressed(E) and the
    ///         masked shares. Atomic: any failure changes nothing.
    function deal(
        Deal calldata a,
        bytes calldata sig,
        uint256[2][16] calldata C,
        uint256[2] calldata E,
        uint256[16] calldata maskedShares,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[2][] calldata rosterKeys
    ) external {
        Ceremony storage c = _existing(a.ceremonyId);
        if (c.phase != Phase.Dealing) revert WrongPhase();
        if (block.timestamp > c.dealingDeadline || block.timestamp > a.validUntil) revert Expired();
        uint256 j = a.dealerIndex;
        uint256 n = c.n;
        uint256 t = c.t;
        if (j == 0 || j > n) revert NotQualified();
        uint16 bit = uint16(1 << (j - 1));
        if (c.qualBitmap & bit != 0) revert AlreadyDealt();
        CouncilEIP712.verify(CouncilEIP712.hashDeal(a), sig, c.participants[j - 1].auth);

        _requireProofWords(pA, pB, pC);
        if (E[0] >= P || E[1] >= P) revert NonCanonical();
        for (uint256 k; k < MAX_T; ++k) {
            if (C[k][0] >= P || C[k][1] >= P || maskedShares[k] >= P) revert NonCanonical();
            if (k >= t && (C[k][0] != 0 || C[k][1] != 1)) revert BadPadding();
            if (k >= n && maskedShares[k] != 0) revert BadPadding();
        }
        bytes32 ctx = c.ctx;
        if (keccak256(abi.encode(TAG_DEAL_PAYLOAD, ctx, C, E, maskedShares, pA, pB, pC)) != a.payloadHash) {
            revert PayloadMismatch();
        }

        if (rosterKeys.length != n) revert RosterMismatch();
        uint256[87] memory pub;
        pub[0] = uint256(ctx) >> 128;
        pub[1] = uint256(ctx) & type(uint128).max;
        pub[2] = j;
        pub[3] = n;
        pub[4] = t;
        for (uint256 k; k < MAX_T; ++k) {
            pub[5 + 2 * k] = C[k][0];
            pub[6 + 2 * k] = C[k][1];
        }
        pub[37] = E[0];
        pub[38] = E[1];
        for (uint256 i; i < MAX_N; ++i) {
            if (i < n) {
                uint256 x = rosterKeys[i][0];
                uint256 y = rosterKeys[i][1];
                CouncilCurve.authenticate(x, y, c.participants[i].compressedX);
                pub[39 + 2 * i] = x;
                pub[40 + 2 * i] = y;
            } else {
                pub[39 + 2 * i] = CouncilCurve.GX_TE;
                pub[40 + 2 * i] = CouncilCurve.GY;
            }
            pub[71 + i] = maskedShares[i];
        }
        if (!IDealVerifier(dealVerifier).verifyProof(pA, pB, pC, pub)) revert ProofInvalid();

        _fold(c, C, t);
        RecoveryRecord storage rec = c.recovery[j - 1];
        rec.compressedE = CouncilCurve.compress(E[0], E[1]);
        for (uint256 i; i < n; ++i) {
            rec.masked[i] = maskedShares[i];
        }
        c.qualBitmap |= bit;
        ++c.dealtCount;
        emit DealingAccepted(a.ceremonyId, uint8(j));
    }

    /// @notice protocol §8.4 (permissionless): the aggregates are already maintained at deal time,
    ///         so finalize only checks `P = A_0 != O` and flips the phase; nothing is written but it.
    function finalize(bytes12 cid) external {
        Ceremony storage c = _existing(cid);
        if (c.phase != Phase.Dealing) revert WrongPhase();
        uint256 dealt = c.dealtCount;
        if (dealt != c.n && (block.timestamp <= c.dealingDeadline || dealt < c.t)) revert FinalizeConditionNotMet();
        (uint256 px, uint256 py) = _aggregate(c, 0);
        if (px == 0 && py == 1) {
            // P = O: defense in depth (protocol §8.4).
            c.phase = Phase.Aborted;
            emit CeremonyAborted(cid, uint8(Phase.Dealing));
            return;
        }
        c.phase = Phase.Live;
        emit CeremonyFinalized(cid, c.qualBitmap, px, py);
    }

    // ─── Decryption (protocol §§9–10) ─────────────────────────────────────────────────────────

    function bindProcess(bytes12 cid, bytes31 processId, address creator)
        external
        returns (bytes32 requestId, uint256 pkX, uint256 pkY)
    {
        Ceremony storage c = _existing(cid);
        if (c.phase != Phase.Live) revert WrongPhase();
        if (!c.allowedAdapters[msg.sender]) revert NotAllowedAdapter();
        if (!c.authorizedCreators[creator]) revert NotAuthorizedCreator();
        bytes32 key = _bindingKey(msg.sender, processId);
        if (_bindings[key] != bytes32(0)) revert AlreadyBound();
        requestId = keccak256(abi.encode(TAG_REQUEST, block.chainid, address(this), cid, msg.sender, processId));
        _bindings[key] = requestId;
        Request storage r = _requests[requestId];
        r.cid = cid;
        r.adapter = msg.sender;
        r.processId = processId;
        r.creator = creator;
        c.requestIds.push(requestId);
        (pkX, pkY) = _aggregate(c, 0);
        emit ProcessBound(cid, msg.sender, processId, requestId, creator);
    }

    /// @notice protocol §9.2: admitted independently of the decryption gate; every C1/C2 is
    ///         subgroup-checked here, once, and stored compressed.
    function submitRequest(bytes12 cid, bytes31 processId, uint256[4][] calldata cts)
        external
        returns (bytes32 requestId)
    {
        Ceremony storage c = _existing(cid);
        requestId = _bindings[_bindingKey(msg.sender, processId)];
        if (requestId == bytes32(0)) revert UnknownBinding();
        Request storage r = _requests[requestId];
        if (r.cid != cid) revert UnknownBinding();
        if (c.phase != Phase.Live) revert WrongPhase();
        if (r.fieldCount != 0) revert AlreadyRequested();
        uint256 count = cts.length;
        if (count == 0 || count > MAX_FIELDS) revert BadFieldCount();
        for (uint256 k; k < count; ++k) {
            uint256[4] calldata ct = cts[k];
            CouncilCurve.requireSubgroupTE(ct[0], ct[1]);
            CouncilCurve.requireSubgroupTE(ct[2], ct[3]);
            r.compressedCts[2 * k] = CouncilCurve.compress(ct[0], ct[1]);
            r.compressedCts[2 * k + 1] = CouncilCurve.compress(ct[2], ct[3]);
        }
        r.fieldCount = uint8(count);
        emit RequestSubmitted(requestId, cid, uint8(count));
    }

    /// @notice protocol §10.2. `C1` re-supplies the request's active ciphertext bases in full TE
    ///         (authenticated against the stored words); `PK_i` is derived from the aggregates.
    ///         The contract builds the 67 public inputs itself and commits to `D` by hash.
    function submitPartial(
        Partial calldata a,
        bytes calldata sig,
        uint256[2][16] calldata D,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[2][] calldata C1
    ) external {
        Ceremony storage c = _existing(a.ceremonyId);
        Request storage r = _requests[a.requestId];
        uint256 count = r.fieldCount;
        // A request id from another ceremony is unknown here: the partial is rejected before it
        // can touch the victim request's state.
        if (count == 0 || r.cid != a.ceremonyId) revert UnknownRequest();
        if (!_decryptionOpen(c)) revert DecryptionNotOpen();
        if (block.timestamp > a.validUntil) revert Expired();
        uint256 i = a.participantIndex;
        if (i == 0 || i > c.n) revert NotQualified();
        CouncilEIP712.verify(CouncilEIP712.hashPartial(a), sig, c.participants[i - 1].auth);
        uint16 bit = uint16(1 << (i - 1));
        if (r.partialBitmap & bit != 0) revert AlreadyPartial();
        _requireProofWords(pA, pB, pC);
        for (uint256 k; k < MAX_FIELDS; ++k) {
            if (D[k][0] >= P || D[k][1] >= P) revert NonCanonical();
            if (k >= count && (D[k][0] != 0 || D[k][1] != 1)) revert BadPadding();
        }
        if (keccak256(abi.encode(TAG_PARTIAL_PAYLOAD, a.requestId, D, pA, pB, pC)) != a.payloadHash) {
            revert PayloadMismatch();
        }
        if (C1.length != count) revert BadFieldCount();

        uint256[67] memory pub;
        (pub[0], pub[1]) = _memberKey(c, i);
        pub[2] = count;
        for (uint256 k; k < MAX_FIELDS; ++k) {
            if (k < count) {
                uint256 x = C1[k][0];
                uint256 y = C1[k][1];
                CouncilCurve.authenticate(x, y, r.compressedCts[2 * k]);
                pub[3 + 2 * k] = x;
                pub[4 + 2 * k] = y;
            } else {
                pub[3 + 2 * k] = CouncilCurve.GX_TE;
                pub[4 + 2 * k] = CouncilCurve.GY;
            }
            pub[35 + 2 * k] = D[k][0];
            pub[36 + 2 * k] = D[k][1];
        }
        if (!IPartialVerifier(partialVerifier).verifyProof(pA, pB, pC, pub)) revert ProofInvalid();

        bytes32 dataHash = _partialDataHash(a.ceremonyId, a.requestId, i, count, D);
        r.partialDataHashes[i - 1] = dataHash;
        r.partialBitmap |= bit;
        _published(r, i);
        emit PartialAccepted(a.requestId, uint8(i));
        emit PartialDataPublished(a.requestId, uint8(i), dataHash, D);
    }

    /// @notice protocol §10.3 (permissionless): `partialVectors` re-supplies the `t` padded D
    ///         vectors of `memberSet` (hash-checked against the stored commitments) and `C2` one
    ///         full point per field index (authenticated); then `m_k·G + Σ λ_i·D_{i,k} == C2_k`
    ///         is checked exactly for 1..4 fields with on-chain Lagrange coefficients.
    function combine(
        bytes32 requestId,
        uint8[] calldata memberSet,
        uint8[] calldata fieldIndexes,
        uint64[] calldata plaintexts,
        uint256[2][16][] calldata partialVectors,
        uint256[2][] calldata C2
    ) external {
        // Steps, so that no frame holds every calldata array at once (stack depth). The field
        // indexes and plaintexts are copied first: they are tiny once checked, and their memory
        // copies are what the event logs.
        uint8[] memory fields = fieldIndexes;
        uint64[] memory values = plaintexts;
        Request storage r = _combineMembers(requestId, memberSet);
        uint256 done = _combineFieldChecks(r, fields, values);
        _combineVectors(r, requestId, memberSet, partialVectors);
        uint256[2][] memory c2 = _combineC2(r, fields, C2);
        // validation complete; curve arithmetic from here on
        uint256[] memory lam = CouncilCurve.lagrange(memberSet);
        uint256[2][] memory sums = _lagrangeSums(lam, partialVectors, fields);
        done = _combineStore(r, fields, values, sums, c2, done);
        r.completedBitmap = uint16(done);
        emit FieldsCombined(requestId, fields, values);
        if (done == (1 << r.fieldCount) - 1) emit RequestCompleted(requestId);
    }

    /// @dev combine step 1 (protocol §10.3 items 1–2): the request exists, its gate is open, and
    ///      `memberSet` is exactly `t` strictly increasing indexes in 1..n with accepted partials.
    function _combineMembers(bytes32 requestId, uint8[] calldata memberSet) internal view returns (Request storage r) {
        r = _requests[requestId];
        if (r.fieldCount == 0) revert UnknownRequest();
        Ceremony storage c = _ceremonies[r.cid];
        if (!_decryptionOpen(c)) revert DecryptionNotOpen();
        uint256 t = c.t;
        if (memberSet.length != t) revert BadMemberSet();
        uint256 n = c.n;
        uint256 partials = r.partialBitmap;
        uint256 prev;
        for (uint256 i; i < t; ++i) {
            uint256 m = memberSet[i];
            if (m <= prev || m > n) revert BadMemberSet();
            if ((partials >> (m - 1)) & 1 == 0) revert MissingPartial();
            prev = m;
        }
    }

    /// @dev combine step 2 (item 2): 1..4 strictly increasing, uncompleted field indexes below
    ///      fieldCount, one plaintext each, every plaintext below 2^40. Returns the completion bitmap.
    function _combineFieldChecks(Request storage r, uint8[] memory fieldIndexes, uint64[] memory plaintexts)
        internal
        view
        returns (uint256 done)
    {
        uint256 nf = fieldIndexes.length;
        if (nf == 0 || nf > MAX_COMBINE_FIELDS || plaintexts.length != nf) revert BadFieldIndexes();
        uint256 count = r.fieldCount;
        done = r.completedBitmap;
        for (uint256 f; f < nf; ++f) {
            uint256 k = fieldIndexes[f];
            if ((f > 0 && k <= fieldIndexes[f - 1]) || k >= count) revert BadFieldIndexes();
            if ((done >> k) & 1 != 0) revert FieldCompleted();
            if (plaintexts[f] >= RESULT_BOUND) revert PlaintextTooLarge();
        }
    }

    /// @dev combine step 3 (item 3): one full padded D vector per selected member, each hashing to
    ///      that member's stored partialDataHash (never a field slice).
    function _combineVectors(
        Request storage r,
        bytes32 requestId,
        uint8[] calldata memberSet,
        uint256[2][16][] calldata partialVectors
    ) internal view {
        uint256 t = memberSet.length;
        if (partialVectors.length != t) revert BadMemberSet();
        bytes12 cid = r.cid;
        uint256 count = r.fieldCount;
        for (uint256 i; i < t; ++i) {
            uint256 m = memberSet[i];
            if (_partialDataHash(cid, requestId, m, count, partialVectors[i]) != r.partialDataHashes[m - 1]) {
                revert PartialDataMismatch();
            }
        }
    }

    /// @dev combine step 4 (item 4): one full C2 point per field index, authenticated against the
    ///      stored compressed word. Returns them with reduced-chart x.
    function _combineC2(Request storage r, uint8[] memory fieldIndexes, uint256[2][] calldata C2)
        internal
        view
        returns (uint256[2][] memory c2)
    {
        uint256 nf = fieldIndexes.length;
        if (C2.length != nf) revert BadFieldIndexes();
        c2 = new uint256[2][](nf);
        for (uint256 f; f < nf; ++f) {
            uint256 y = C2[f][1];
            c2[f][0] = CouncilCurve.authenticate(C2[f][0], y, r.compressedCts[2 * fieldIndexes[f] + 1]);
            c2[f][1] = y;
        }
    }

    /// @dev Σ_{i in S} λ_i·D_{i,k} (reduced chart) for every field index of the chunk.
    function _lagrangeSums(uint256[] memory lam, uint256[2][16][] calldata partialVectors, uint8[] memory fieldIndexes)
        internal
        view
        returns (uint256[2][] memory sums)
    {
        uint256 nf = fieldIndexes.length;
        sums = new uint256[2][](nf);
        for (uint256 f; f < nf; ++f) {
            uint256 k = fieldIndexes[f];
            uint256 x = 0;
            uint256 y = 1;
            for (uint256 i; i < lam.length; ++i) {
                uint256[2] calldata d = partialVectors[i][k];
                (uint256 dx, uint256 dy) = CouncilCurve.mul(lam[i], CouncilCurve.toReduced(d[0]), d[1]);
                (x, y) = CouncilCurve.add(x, y, dx, dy);
            }
            sums[f] = [x, y];
        }
    }

    /// @dev The exact per-field check `m_k·G + Σ λ_i·D_{i,k} == C2_k`; stores each plaintext in
    ///      its uint40 lane and returns the updated completion bitmap.
    function _combineStore(
        Request storage r,
        uint8[] memory fieldIndexes,
        uint64[] memory plaintexts,
        uint256[2][] memory sums,
        uint256[2][] memory c2,
        uint256 done
    ) internal returns (uint256) {
        for (uint256 f; f < fieldIndexes.length; ++f) {
            (uint256 x, uint256 y) = CouncilCurve.mul(plaintexts[f], CouncilCurve.GX_RED, CouncilCurve.GY);
            (x, y) = CouncilCurve.add(x, y, sums[f][0], sums[f][1]);
            if (x != c2[f][0] || y != c2[f][1]) revert CombineCheckFailed();
            uint256 k = fieldIndexes[f];
            r.plaintexts[k] = uint40(plaintexts[f]);
            done |= 1 << k;
        }
        return done;
    }

    // ─── Identifiers ──────────────────────────────────────────────────────────────────────────

    /// @notice protocol §4.1 ceremony id for this chain and manager.
    function ceremonyIdFor(address organizer, uint64 nonce) public view returns (bytes12) {
        return bytes12(keccak256(abi.encode(TAG_CEREMONY, block.chainid, address(this), organizer, nonce)));
    }

    // ─── Internals ────────────────────────────────────────────────────────────────────────────

    /// @dev protocol §8.1 phase-policy validation; every failure is `BadSchedule()`. The sum
    ///      `registrationDeadline + dealingDuration` must fit uint64 whenever a deadline exists.
    function _requireSchedule(CreateCeremony calldata a) internal view {
        uint256 regMode = a.registrationMode;
        uint256 decMode = a.decryptionMode;
        if (regMode > MODE_SCHEDULED || decMode > MODE_SCHEDULED) revert BadSchedule();
        uint256 deadline = a.registrationDeadline;
        uint256 windowEnd = deadline + a.dealingDuration;
        if (regMode == MODE_SCHEDULED || deadline != 0) {
            if (deadline <= block.timestamp || windowEnd > type(uint64).max) revert BadSchedule();
        }
        uint256 openAt = a.decryptionOpenAt;
        uint256 fallbackAt = a.manualDecryptionFallbackAt;
        if (decMode == MODE_SCHEDULED) {
            if (openAt <= block.timestamp || fallbackAt != 0) revert BadSchedule();
        } else if (openAt != 0 || (fallbackAt != 0 && fallbackAt <= block.timestamp)) {
            revert BadSchedule();
        }
        // a Scheduled registration's decryption date (open date or nonzero fallback) lies past
        // the scheduled dealing window
        uint256 date = decMode == MODE_SCHEDULED ? openAt : fallbackAt;
        if (regMode == MODE_SCHEDULED && date != 0 && date <= windowEnd) revert BadSchedule();
    }

    /// @dev protocol §8.3 incremental aggregation `A_k <- A_k + C_{j,k}` for k < t, stored biased
    ///      `(x + 1, y + 1)`. The first accepted dealing copies its verified commitments; later
    ///      ones add in extended coordinates (complete formulas) with one batch inversion.
    function _fold(Ceremony storage c, uint256[2][16] calldata C, uint256 t) internal {
        if (c.dealtCount == 0) {
            for (uint256 k; k < t; ++k) {
                c.aggregatesBiased[k] = [C[k][0] + 1, C[k][1] + 1];
            }
            return;
        }
        uint256 pts = CouncilCurve.alloc(t);
        for (uint256 k; k < t; ++k) {
            (uint256 ax, uint256 ay) = _aggregate(c, k);
            uint256 q = CouncilCurve.at(pts, k);
            CouncilCurve.setAffine(q, CouncilCurve.toReduced(ax), ay);
            CouncilCurve.addAffine(q, CouncilCurve.toReduced(C[k][0]), C[k][1]);
        }
        CouncilCurve.normalize(pts, t, t, pts);
        for (uint256 k; k < t; ++k) {
            (uint256 x, uint256 y) = CouncilCurve.affineAt(pts, k);
            c.aggregatesBiased[k] = [CouncilCurve.toTE(x) + 1, y + 1];
        }
    }

    /// @dev Every Groth16 proof word must be a canonical BN254 base-field element (< qBN). The
    ///      generated verifiers range-check only the public signals; pA.y goes through
    ///      `mod(sub(q, y), q)`, so `y + 2^256 - 4·qBN` would verify as a second encoding of the
    ///      same proof. Words in [p, qBN) are legitimate and never rejected (protocol §7.2).
    function _requireProofWords(uint256[2] calldata pA, uint256[2][2] calldata pB, uint256[2] calldata pC)
        internal
        pure
    {
        if (
            pA[0] >= Q_BN || pA[1] >= Q_BN || pB[0][0] >= Q_BN || pB[0][1] >= Q_BN || pB[1][0] >= Q_BN
                || pB[1][1] >= Q_BN || pC[0] >= Q_BN || pC[1] >= Q_BN
        ) revert NonCanonical();
    }

    /// @dev Join PoP (protocol §8.2 item 4): popZ·G - c·X == A with c = HashToScalar("join-pop", ..).
    function _verifyPoP(Join calldata a, uint256 pkxRed) internal view {
        if (a.popZ >= R) revert BadPoP();
        uint256 axRed = CouncilCurve.requireOnCurveTE(a.popAx, a.popAy);
        uint256 ch = _hashToScalar(
            abi.encode(
                TAG_JOIN_POP, block.chainid, address(this), a.ceremonyId, a.participant, a.pkX, a.pkY, a.popAx, a.popAy
            )
        );
        if (!BabyJubJub.verifySchnorrEquation(a.popZ, ch, axRed, a.popAy, pkxRed, a.pkY)) revert BadPoP();
    }

    /// @dev protocol §3.1: `prefix` is abi.encode(tagHash, fields..); the uint32 counter is
    ///      appended as one more ABI word.
    function _hashToScalar(bytes memory prefix) internal pure returns (uint256) {
        for (uint256 counter; counter < 256; ++counter) {
            uint256 u = uint256(keccak256(abi.encodePacked(prefix, counter)));
            if (u < LIMIT_R) return u % R;
        }
        revert BadPoP();
    }
}
