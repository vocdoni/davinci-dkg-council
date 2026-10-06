// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {BabyJubJub} from "./libraries/BabyJubJub.sol";
import "./CouncilTypes.sol";
import {CouncilCurve} from "./libraries/CouncilCurve.sol";
import {CouncilEIP712} from "./libraries/CouncilEIP712.sol";
import {CouncilStorage} from "./CouncilStorage.sol";
import {CouncilViews} from "./CouncilViews.sol";
import {ICouncilCore} from "./interfaces/ICouncil.sol";
import {IDealVerifier, IPartialVerifier} from "./interfaces/ICouncilVerifiers.sol";

/// @title CouncilManager
/// @notice Invite-only threshold DKG for DAVINCI (docs/protocol.md, normative). No owner,
///         no upgradability, no pausability: each ceremony's organizer acts on its own ceremony
///         through EIP-712 signed actions; finalize, abort and combine are permissionless; process
///         binding and decryption requests come from organizer-allowed adapters.
///
///         Points are circomlib twisted Edwards (TE) everywhere outside the curve arithmetic,
///         which runs in BabyJubJub.sol's reduced chart (protocol §2.2).
///
///         EIP-170 split (architecture §1.7): the read surface lives in CouncilViews, created by
///         this constructor and reached through the delegatecall fallback below on this
///         contract's storage (both inherit the one CouncilStorage layout). Every function of
///         ICouncil, and so of the adapter-facing ICouncilManager, is served at this address.
contract CouncilManager is CouncilStorage, ICouncilCore {
    // ─── Protocol constants (protocol §2) ─────────────────────────────────────────────────────

    uint256 internal constant MAX_COMBINE_FIELDS = 4;
    uint256 internal constant MAX_INVITES = 64;
    uint256 internal constant MIN_DEALING_DURATION = 600;
    uint256 internal constant RESULT_BOUND = 1 << 40;
    /// @dev floor(2^256 / r)·r = 42·r: HashToScalar rejection limit (protocol §3.1).
    uint256 internal constant LIMIT_R = 114913275077156194916793630162600694215226186830659824886409057759834789667722;

    bytes32 internal constant TAG_CEREMONY = keccak256("davinci-dkg-council/v1/ceremony");
    bytes32 internal constant TAG_ROSTER = keccak256("davinci-dkg-council/v1/roster");
    bytes32 internal constant TAG_DEAL_CONTEXT = keccak256("davinci-dkg-council/v1/deal-context");
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

    constructor(address dealVerifier_, address partialVerifier_, bytes32 circuitReleaseId_) {
        if (dealVerifier_ == address(0) || partialVerifier_ == address(0)) revert ZeroAddress();
        dealVerifier = dealVerifier_;
        partialVerifier = partialVerifier_;
        circuitReleaseId = circuitReleaseId_;
        views = address(new CouncilViews());
    }

    /// @notice Serves the ICouncilViews selectors: delegatecall into the immutable, constructor-
    ///         created CouncilViews (view-only code) on this contract's storage. Unknown selectors
    ///         revert there; plain value transfers revert here (non-payable).
    fallback() external {
        address target = views;
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

    /// @notice protocol §8.1. Claims `ceremonyIdFor(organizer, nonce)`.
    function createCeremony(CreateCeremony calldata a, bytes calldata orgSig) external returns (bytes12 cid) {
        if (block.timestamp > a.validUntil) revert Expired();
        if (a.organizer == address(0)) revert ZeroAddress();
        CouncilEIP712.verify(CouncilEIP712.hashCreateCeremony(a), orgSig, a.organizer);
        cid = ceremonyIdFor(a.organizer, a.nonce);
        Ceremony storage c = _ceremonies[cid];
        if (cid == bytes12(0) || c.phase != Phase.None) revert CeremonyExists();
        if (a.threshold == 0 || a.threshold > MAX_T) revert BadThreshold();
        if (a.registrationDeadline <= block.timestamp) revert Expired();
        // close happens no later than registrationDeadline, so this bounds every dealing deadline.
        if (
            a.dealingDuration < MIN_DEALING_DURATION
                || uint256(a.registrationDeadline) + a.dealingDuration > type(uint64).max
        ) revert BadDuration();

        c.phase = Phase.Registration;
        c.organizer = a.organizer;
        c.t = a.threshold;
        c.registrationDeadline = a.registrationDeadline;
        c.dealingDuration = a.dealingDuration;
        _appendInvites(c, a.inviteKeys);
        emit CeremonyCreated(cid, a.organizer, a.threshold, a.registrationDeadline, a.dealingDuration);
    }

    /// @notice protocol §6: append invite capability addresses (Registration only).
    function addInvites(AddInvites calldata a, bytes calldata orgSig) external {
        Ceremony storage c = _existing(a.ceremonyId);
        if (block.timestamp > a.validUntil) revert Expired();
        CouncilEIP712.verify(CouncilEIP712.hashAddInvites(a), orgSig, c.organizer);
        if (c.phase != Phase.Registration) revert WrongPhase();
        if (block.timestamp > c.registrationDeadline) revert Expired();
        if (a.firstInviteId != c.inviteCount) revert BadInviteIndex();
        _appendInvites(c, a.inviteKeys);
        emit InvitesAdded(a.ceremonyId, a.firstInviteId, uint32(a.inviteKeys.length));
    }

    /// @notice protocol §8.2. `participantSig` signs `a` (Join) with the participant's
    ///         authorization key, `inviteSig` signs `inv` (Invite) with the capability key.
    function join(Join calldata a, bytes calldata participantSig, Invite calldata inv, bytes calldata inviteSig)
        external
    {
        Ceremony storage c = _existing(a.ceremonyId);
        if (c.phase != Phase.Registration) revert WrongPhase();
        if (
            block.timestamp > c.registrationDeadline || block.timestamp > a.validUntil
                || block.timestamp > inv.validUntil
        ) revert Expired();
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
        bytes32 keyId = keccak256(abi.encode(a.pkX, a.pkY));
        if (c.keyUsed[keyId]) revert DuplicateKey();
        _verifyPoP(a, pkxRed);

        c.joinedCount = uint8(index);
        c.consumedInvites |= uint64(1 << inviteId);
        Participant storage p = c.participants[index - 1];
        p.auth = a.participant;
        p.pkX = a.pkX;
        p.pkY = a.pkY;
        c.authIndex[a.participant] = uint8(index);
        c.keyUsed[keyId] = true;
        emit ParticipantJoined(a.ceremonyId, uint8(index), a.participant, a.inviteId);
    }

    /// @notice protocol §8.3: freeze the roster, compute rosterHash and ctx, open dealing.
    function closeRegistration(CloseRegistration calldata a, bytes calldata orgSig) external {
        Ceremony storage c = _existing(a.ceremonyId);
        if (block.timestamp > a.validUntil) revert Expired();
        CouncilEIP712.verify(CouncilEIP712.hashCloseRegistration(a), orgSig, c.organizer);
        if (c.phase != Phase.Registration) revert WrongPhase();
        if (block.timestamp > c.registrationDeadline) revert Expired();
        uint8 n = c.joinedCount;
        if (a.participantCount != n) revert RosterMismatch();
        if (n < c.t) revert BelowThreshold();

        address[] memory auths = new address[](n);
        uint256[] memory pkxs = new uint256[](n);
        uint256[] memory pkys = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            Participant storage p = c.participants[i];
            auths[i] = p.auth;
            pkxs[i] = p.pkX;
            pkys[i] = p.pkY;
        }
        bytes32 rosterHash =
            keccak256(abi.encode(TAG_ROSTER, block.chainid, address(this), a.ceremonyId, c.t, n, auths, pkxs, pkys));
        bytes32 ctx = keccak256(
            abi.encode(TAG_DEAL_CONTEXT, block.chainid, address(this), a.ceremonyId, rosterHash, circuitReleaseId)
        );
        uint64 dealingDeadline = uint64(block.timestamp) + c.dealingDuration;
        c.n = n;
        c.rosterHash = rosterHash;
        c.ctx = ctx;
        c.dealingDeadline = dealingDeadline;
        c.phase = Phase.Dealing;
        emit RegistrationClosed(a.ceremonyId, n, rosterHash, dealingDeadline);
    }

    /// @notice protocol §8.3: one proven Feldman dealing per member. The contract builds the 87
    ///         public inputs itself (protocol §8.5) and stores the full dealing on success.
    function deal(
        Deal calldata a,
        bytes calldata sig,
        uint256[2][16] calldata C,
        uint256[2] calldata E,
        uint256[16] calldata maskedShares,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC
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
                Participant storage p = c.participants[i];
                pub[39 + 2 * i] = p.pkX;
                pub[40 + 2 * i] = p.pkY;
            } else {
                pub[39 + 2 * i] = CouncilCurve.GX_TE;
                pub[40 + 2 * i] = CouncilCurve.GY;
            }
            pub[71 + i] = maskedShares[i];
        }
        if (!IDealVerifier(dealVerifier).verifyProof(pA, pB, pC, pub)) revert ProofInvalid();

        Dealing storage d = c.dealings[j - 1];
        for (uint256 k; k < t; ++k) {
            d.C[k][0] = C[k][0];
            d.C[k][1] = C[k][1];
        }
        d.E[0] = E[0];
        d.E[1] = E[1];
        for (uint256 i; i < n; ++i) {
            d.masked[i] = maskedShares[i];
        }
        c.qualBitmap |= bit;
        ++c.dealtCount;
        emit DealingAccepted(a.ceremonyId, uint8(j));
    }

    /// @notice protocol §8.4 (permissionless): aggregate QUAL's commitments, store P, A_k, PK_m.
    function finalize(bytes12 cid) external {
        Ceremony storage c = _existing(cid);
        if (c.phase != Phase.Dealing) revert WrongPhase();
        uint256 n = c.n;
        uint256 t = c.t;
        uint256 dealt = c.dealtCount;
        if (dealt != n && (block.timestamp <= c.dealingDeadline || dealt < t)) revert FinalizeConditionNotMet();
        uint256 qual = c.qualBitmap;

        // A_k = Σ_{j in QUAL} C_{j,k}, reduced chart.
        uint256[2][16] memory agg;
        for (uint256 k; k < t; ++k) {
            uint256 x = 0;
            uint256 y = 1;
            for (uint256 j; j < n; ++j) {
                if ((qual >> j) & 1 == 0) continue;
                uint256[2] storage ck = c.dealings[j].C[k];
                (x, y) = CouncilCurve.add(x, y, CouncilCurve.toReduced(ck[0]), ck[1]);
            }
            agg[k][0] = x;
            agg[k][1] = y;
        }
        if (agg[0][0] == 0 && agg[0][1] == 1) {
            // P = O: defense in depth (protocol §8.4).
            c.phase = Phase.Aborted;
            emit CeremonyAborted(cid, uint8(Phase.Dealing));
            return;
        }
        for (uint256 k; k < t; ++k) {
            c.aggregates[k][0] = CouncilCurve.toTE(agg[k][0]);
            c.aggregates[k][1] = agg[k][1];
        }
        for (uint256 m = 1; m <= n; ++m) {
            (uint256 x, uint256 y) = CouncilCurve.horner(agg, t, m);
            c.memberKeys[m - 1][0] = CouncilCurve.toTE(x);
            c.memberKeys[m - 1][1] = y;
        }
        c.phase = Phase.Live;
        emit CeremonyFinalized(cid, uint16(qual), c.aggregates[0][0], agg[0][1]);
    }

    /// @notice protocol §8.4 (permissionless): abort a ceremony that can no longer go Live.
    function abort(bytes12 cid) external {
        Ceremony storage c = _existing(cid);
        Phase phase = c.phase;
        if (phase == Phase.Registration) {
            if (block.timestamp <= c.registrationDeadline) revert AbortConditionNotMet();
        } else if (phase == Phase.Dealing) {
            if (block.timestamp <= c.dealingDeadline || c.dealtCount >= c.t) revert AbortConditionNotMet();
        } else {
            revert WrongPhase();
        }
        c.phase = Phase.Aborted;
        emit CeremonyAborted(cid, uint8(phase));
    }

    // ─── Authorization (protocol §9.1) ────────────────────────────────────────────────────────

    function allowAdapter(AllowAdapter calldata a, bytes calldata orgSig) external {
        _addToList(a.ceremonyId, a.validUntil, CouncilEIP712.hashAllowAdapter(a), orgSig, a.adapter, false);
        emit AdapterAllowed(a.ceremonyId, a.adapter);
    }

    function authorizeCreator(AuthorizeCreator calldata a, bytes calldata orgSig) external {
        _addToList(a.ceremonyId, a.validUntil, CouncilEIP712.hashAuthorizeCreator(a), orgSig, a.creator, true);
        emit CreatorAuthorized(a.ceremonyId, a.creator);
    }

    /// @dev Organizer-signed, add-only, one-shot insertion into the adapter or creator set.
    function _addToList(
        bytes12 cid,
        uint64 validUntil,
        bytes32 structHash,
        bytes calldata orgSig,
        address who,
        bool creatorSet
    ) internal {
        Ceremony storage c = _existing(cid);
        if (block.timestamp > validUntil) revert Expired();
        CouncilEIP712.verify(structHash, orgSig, c.organizer);
        if (who == address(0)) revert ZeroAddress();
        mapping(address => bool) storage set = creatorSet ? c.authorizedCreators : c.allowedAdapters;
        if (set[who]) revert AlreadyListed();
        set[who] = true;
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
        pkX = c.aggregates[0][0];
        pkY = c.aggregates[0][1];
        emit ProcessBound(cid, msg.sender, processId, requestId, creator);
    }

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
            r.cts[k] = ct;
        }
        r.fieldCount = uint8(count);
        emit RequestSubmitted(requestId, cid, uint8(count));
    }

    /// @notice protocol §10.2. The contract builds the 67 public inputs itself.
    function submitPartial(
        Partial calldata a,
        bytes calldata sig,
        uint256[2][16] calldata D,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC
    ) external {
        Ceremony storage c = _existing(a.ceremonyId);
        Request storage r = _requests[a.requestId];
        uint256 count = r.fieldCount;
        // A request id from another ceremony is unknown here: the partial is rejected before it
        // can touch the victim request's state.
        if (count == 0 || r.cid != a.ceremonyId) revert UnknownRequest();
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

        uint256[67] memory pub;
        pub[0] = c.memberKeys[i - 1][0];
        pub[1] = c.memberKeys[i - 1][1];
        pub[2] = count;
        for (uint256 k; k < MAX_FIELDS; ++k) {
            if (k < count) {
                pub[3 + 2 * k] = r.cts[k][0];
                pub[4 + 2 * k] = r.cts[k][1];
            } else {
                pub[3 + 2 * k] = CouncilCurve.GX_TE;
                pub[4 + 2 * k] = CouncilCurve.GY;
            }
            pub[35 + 2 * k] = D[k][0];
            pub[36 + 2 * k] = D[k][1];
        }
        if (!IPartialVerifier(partialVerifier).verifyProof(pA, pB, pC, pub)) revert ProofInvalid();

        uint256[2][16] storage stored = r.partials[i];
        for (uint256 k; k < count; ++k) {
            stored[k][0] = D[k][0];
            stored[k][1] = D[k][1];
        }
        r.partialBitmap |= bit;
        emit PartialAccepted(a.requestId, uint8(i));
    }

    /// @notice protocol §10.3 (permissionless): verify `m_k·G + Σ λ_i·D_{i,k} == C2_k` exactly for
    ///         1..4 fields with on-chain Lagrange coefficients, then store the plaintexts.
    function combine(
        bytes32 requestId,
        uint8[] calldata memberSet,
        uint8[] calldata fieldIndexes,
        uint64[] calldata plaintexts
    ) external {
        Request storage r = _requests[requestId];
        uint256 count = r.fieldCount;
        if (count == 0) revert UnknownRequest();
        Ceremony storage c = _ceremonies[r.cid];
        uint256 t = c.t;
        uint256 n = c.n;
        if (memberSet.length != t) revert BadMemberSet();
        uint256 partials = r.partialBitmap;
        uint256 prev;
        for (uint256 i; i < t; ++i) {
            uint256 m = memberSet[i];
            if (m <= prev || m > n) revert BadMemberSet();
            if ((partials >> (m - 1)) & 1 == 0) revert MissingPartial();
            prev = m;
        }
        uint256 nf = fieldIndexes.length;
        if (nf == 0 || nf > MAX_COMBINE_FIELDS || plaintexts.length != nf) revert BadFieldIndexes();
        uint256 done = r.completedBitmap;
        for (uint256 f; f < nf; ++f) {
            uint256 k = fieldIndexes[f];
            if ((f > 0 && k <= fieldIndexes[f - 1]) || k >= count) revert BadFieldIndexes();
            if ((done >> k) & 1 != 0) revert FieldCompleted();
            if (plaintexts[f] >= RESULT_BOUND) revert PlaintextTooLarge();
        }

        uint256[] memory lam = CouncilCurve.lagrange(memberSet);
        for (uint256 f; f < nf; ++f) {
            uint256 k = fieldIndexes[f];
            (uint256 x, uint256 y) = CouncilCurve.mul(plaintexts[f], CouncilCurve.GX_RED, CouncilCurve.GY);
            for (uint256 i; i < t; ++i) {
                uint256[2] storage d = r.partials[memberSet[i]][k];
                (uint256 dx, uint256 dy) = CouncilCurve.mul(lam[i], CouncilCurve.toReduced(d[0]), d[1]);
                (x, y) = CouncilCurve.add(x, y, dx, dy);
            }
            uint256[4] storage ct = r.cts[k];
            if (x != CouncilCurve.toReduced(ct[2]) || y != ct[3]) revert CombineCheckFailed();
            r.plaintexts[k] = plaintexts[f];
            done |= 1 << k;
        }
        r.completedBitmap = uint16(done);
        emit FieldsCombined(requestId, fieldIndexes, plaintexts);
        if (done == (1 << count) - 1) emit RequestCompleted(requestId);
    }

    // ─── Identifiers ──────────────────────────────────────────────────────────────────────────

    /// @notice protocol §4.1 ceremony id for this chain and manager.
    function ceremonyIdFor(address organizer, uint64 nonce) public view returns (bytes12) {
        return bytes12(keccak256(abi.encode(TAG_CEREMONY, block.chainid, address(this), organizer, nonce)));
    }

    // ─── Internals ────────────────────────────────────────────────────────────────────────────

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

    /// @dev Append capability addresses with ids `inviteCount..`; each non-zero and unique across
    ///      every address ever registered for the ceremony (at most 64, so a quadratic scan).
    function _appendInvites(Ceremony storage c, address[] calldata keys) internal {
        uint256 len = keys.length;
        if (len == 0) revert NoInvites();
        uint256 have = c.inviteCount;
        if (have + len > MAX_INVITES) revert TooManyInvites();
        address[] memory all = new address[](have + len);
        for (uint256 i; i < have; ++i) {
            all[i] = c.invites[i];
        }
        for (uint256 i; i < len; ++i) {
            address key = keys[i];
            if (key == address(0)) revert ZeroAddress();
            uint256 id = have + i;
            for (uint256 j; j < id; ++j) {
                if (all[j] == key) revert DuplicateInvite();
            }
            all[id] = key;
            c.invites[id] = key;
        }
        c.inviteCount = uint32(have + len);
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
