// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "./CouncilTypes.sol";
import {CouncilCurve} from "./libraries/CouncilCurve.sol";
import {CouncilEIP712} from "./libraries/CouncilEIP712.sol";
import {CouncilStorage} from "./CouncilStorage.sol";
import {ICouncilCore, ICouncilOps} from "./interfaces/ICouncil.sol";

/// @title CouncilOps
/// @notice The rarely-used state transitions of a CouncilManager (architecture §1.7, the pinned
///         EIP-170 lever): once-per-ceremony administration (addInvites, both registration
///         closes, openDecryption, the organizer's grant pair, abort) and the permissionless
///         partial-data re-publication. Created by the manager's constructor and only meaningful
///         through the manager's delegatecall fallback, which routes exactly the ICouncilOps
///         selectors here (every other unknown selector goes to the read-only CouncilViews).
///         On the manager's storage and at the manager's address: events are logged by the
///         manager and EIP-712 digests use the manager's domain. Called directly, it acts on its
///         own empty storage, where every ceremony and request is unknown.
contract CouncilOps is CouncilStorage, ICouncilOps {
    bytes32 internal constant TAG_ROSTER = keccak256("davinci-dkg-council/v1/roster");
    bytes32 internal constant TAG_DEAL_CONTEXT = keccak256("davinci-dkg-council/v1/deal-context");

    /// @dev The manager's circuit release id (protocol §4.4), bound into every dealing context;
    ///      passed by the creating manager, whose own immutable this code cannot read.
    bytes32 internal immutable releaseId;

    constructor(bytes32 circuitReleaseId_) {
        releaseId = circuitReleaseId_;
    }

    /// @notice protocol §8.4 (permissionless): abort a ceremony that can no longer go Live.
    function abort(bytes12 cid) external {
        Ceremony storage c = _existing(cid);
        Phase phase = c.phase;
        if (phase == Phase.Registration) {
            uint256 deadline = c.registrationDeadline;
            // Manual without expiry: no timeout abort. Otherwise valid once the roster missed t at
            // the deadline, or once nobody closed within the scheduled window (protocol §8.4).
            if (
                deadline == 0
                    || ((block.timestamp < deadline || c.joinedCount >= c.t)
                        && block.timestamp <= deadline + c.dealingDuration)
            ) revert AbortConditionNotMet();
        } else if (phase == Phase.Dealing) {
            if (block.timestamp <= c.dealingDeadline || c.dealtCount >= c.t) revert AbortConditionNotMet();
        } else {
            revert WrongPhase();
        }
        c.phase = Phase.Aborted;
        emit ICouncilCore.CeremonyAborted(cid, uint8(phase));
    }

    // ─── Registration (protocol §6) ──────────────────────────────────────────────────────────

    /// @notice Append invite capability addresses while joining is open.
    function addInvites(AddInvites calldata a, bytes calldata orgSig) external {
        Ceremony storage c = _existing(a.ceremonyId);
        if (block.timestamp > a.validUntil) revert Expired();
        CouncilEIP712.verify(CouncilEIP712.hashAddInvites(a), orgSig, c.organizer);
        _requireJoining(c);
        if (a.firstInviteId != c.inviteCount) revert BadInviteIndex();
        _appendInvites(c, a.inviteKeys);
        emit ICouncilCore.InvitesAdded(a.ceremonyId, uint8(a.firstInviteId), uint8(a.inviteKeys.length));
    }

    /// @notice protocol §8.3 manual close (Manual registration only, strictly before a nonzero
    ///         expiry): freeze the roster, compute rosterHash and ctx, open dealing for
    ///         `dealingDuration` from now. `rosterKeys` is the joined roster in full TE.
    function closeRegistration(CloseRegistration calldata a, bytes calldata orgSig, uint256[2][] calldata rosterKeys)
        external
    {
        Ceremony storage c = _existing(a.ceremonyId);
        if (block.timestamp > a.validUntil) revert Expired();
        CouncilEIP712.verify(CouncilEIP712.hashCloseRegistration(a), orgSig, c.organizer);
        if (c.phase != Phase.Registration) revert WrongPhase();
        if (c.registrationMode != MODE_MANUAL) revert WrongMode();
        _requireJoining(c);
        if (a.participantCount != c.joinedCount) revert RosterMismatch();
        if (c.joinedCount < c.t) revert BelowThreshold();
        uint256 dealingDeadline = block.timestamp + c.dealingDuration;
        if (dealingDeadline > type(uint64).max) revert BadSchedule();
        _freeze(c, a.ceremonyId, rosterKeys, dealingDeadline);
    }

    /// @notice protocol §8.3 time-based close (permissionless): a Scheduled registration, or a
    ///         Manual one past its nonzero expiry, within `[deadline, deadline + dealingDuration]`
    ///         and with at least `t` members. The dealing deadline is the scheduled one, never
    ///         `now + dealingDuration`: a late caller cannot stretch the schedule.
    function closeRegistrationScheduled(bytes12 cid, uint256[2][] calldata rosterKeys) external {
        Ceremony storage c = _existing(cid);
        if (c.phase != Phase.Registration) revert WrongPhase();
        uint256 deadline = c.registrationDeadline;
        if (deadline == 0) revert WrongMode();
        if (block.timestamp < deadline) revert RegistrationNotDue();
        uint256 dealingDeadline = deadline + c.dealingDuration; // < 2^64, checked at creation
        if (block.timestamp > dealingDeadline) revert Expired();
        if (c.joinedCount < c.t) revert BelowThreshold();
        _freeze(c, cid, rosterKeys, dealingDeadline);
    }

    /// @dev protocol §8.3 roster freeze shared by both close paths: authenticate every re-supplied
    ///      roster key against its stored compressed word, then compute rosterHash and ctx.
    function _freeze(Ceremony storage c, bytes12 cid, uint256[2][] calldata rosterKeys, uint256 dealingDeadline)
        internal
    {
        uint256 n = c.joinedCount;
        if (rosterKeys.length != n) revert RosterMismatch();
        address[] memory auths = new address[](n);
        uint256[] memory pkxs = new uint256[](n);
        uint256[] memory pkys = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            Participant storage p = c.participants[i];
            uint256 x = rosterKeys[i][0];
            uint256 y = rosterKeys[i][1];
            CouncilCurve.authenticate(x, y, p.compressedX);
            auths[i] = p.auth;
            pkxs[i] = x;
            pkys[i] = y;
        }
        bytes32 rosterHash =
            keccak256(abi.encode(TAG_ROSTER, block.chainid, address(this), cid, c.t, uint8(n), auths, pkxs, pkys));
        bytes32 ctx = keccak256(abi.encode(TAG_DEAL_CONTEXT, block.chainid, address(this), cid, rosterHash, releaseId));
        c.n = uint8(n);
        c.rosterHash = rosterHash;
        c.ctx = ctx;
        c.dealingDeadline = uint64(dealingDeadline);
        c.phase = Phase.Dealing;
        emit ICouncilCore.RegistrationClosed(cid, uint8(n), rosterHash, uint64(dealingDeadline));
    }

    // ─── Scheduling (protocol §8.7) ──────────────────────────────────────────────────────────

    /// @notice Manual decryption opening by the organizer: irreversible and ceremony-wide.
    function openDecryption(OpenDecryption calldata a, bytes calldata orgSig) external {
        Ceremony storage c = _existing(a.ceremonyId);
        if (block.timestamp > a.validUntil) revert Expired();
        CouncilEIP712.verify(CouncilEIP712.hashOpenDecryption(a), orgSig, c.organizer);
        if (c.phase != Phase.Live) revert WrongPhase();
        if (c.decryptionMode != MODE_MANUAL) revert WrongMode();
        if (_decryptionOpen(c)) revert AlreadyOpen();
        c.manualOpenedAt = uint64(block.timestamp);
        emit ICouncilCore.DecryptionOpened(a.ceremonyId, uint64(block.timestamp));
    }

    // ─── Authorization (protocol §9.1) ────────────────────────────────────────────────────────

    function allowAdapter(AllowAdapter calldata a, bytes calldata orgSig) external {
        _addToList(a.ceremonyId, a.validUntil, CouncilEIP712.hashAllowAdapter(a), orgSig, a.adapter, false);
        emit ICouncilCore.AdapterAllowed(a.ceremonyId, a.adapter);
    }

    function authorizeCreator(AuthorizeCreator calldata a, bytes calldata orgSig) external {
        _addToList(a.ceremonyId, a.validUntil, CouncilEIP712.hashAuthorizeCreator(a), orgSig, a.creator, true);
        emit ICouncilCore.CreatorAuthorized(a.ceremonyId, a.creator);
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

    // ─── Partial-data availability (protocol §10.4) ──────────────────────────────────────────

    /// @notice Permissionless re-publication of an accepted member's D vector: it must hash to
    ///         the stored commitment; only the publication block changes (never the hash, the
    ///         bitmap, a proof or a plaintext). The gate check is uniformity, not protection: no
    ///         partial exists before opening.
    function publishPartialData(bytes32 requestId, uint8 participantIndex, uint256[2][16] calldata D) external {
        Request storage r = _requests[requestId];
        uint256 count = r.fieldCount;
        if (count == 0) revert UnknownRequest();
        bytes12 cid = r.cid;
        if (!_decryptionOpen(_ceremonies[cid])) revert DecryptionNotOpen();
        uint256 i = participantIndex;
        if (i == 0 || i > MAX_N || (r.partialBitmap >> (i - 1)) & 1 == 0) revert MissingPartial();
        bytes32 dataHash = _partialDataHash(cid, requestId, i, count, D);
        if (dataHash != r.partialDataHashes[i - 1]) revert PartialDataMismatch();
        _published(r, i);
        emit ICouncilCore.PartialDataPublished(requestId, participantIndex, dataHash, D);
    }
}
