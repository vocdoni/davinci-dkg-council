// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Phase, CeremonyView, PhasePolicyView, UnknownInvite, NotQualified, UnknownBinding} from "./CouncilTypes.sol";
import {CouncilStorage} from "./CouncilStorage.sol";
import {ICouncilViews} from "./interfaces/ICouncil.sol";

/// @title CouncilViews
/// @notice The read surface of a CouncilManager (architecture §1.2), split out for EIP-170. It is
///         created by the manager's constructor and only ever executed through the manager's
///         delegatecall fallback, on the manager's storage, so every view below is served at the
///         manager's address. Read-only by construction: every function is `view` or `pure`, and
///         the contract has no fallback. Called directly, it reads its own empty storage (every
///         ceremony is unknown).
///
///         Views decompress nothing: roster keys, ephemerals and ciphertexts come out as the
///         stored compressed words (protocol §2.5), aggregates and member keys as full TE points.
contract CouncilViews is CouncilStorage, ICouncilViews {
    /// @notice The protocol version this manager implements (docs/protocol.md).
    function protocolVersion() external pure returns (uint8) {
        return 2;
    }

    function getCeremony(bytes12 cid) external view returns (CeremonyView memory v) {
        Ceremony storage c = _existing(cid);
        v.phase = uint8(c.phase);
        v.organizer = c.organizer;
        v.threshold = c.t;
        v.n = c.n;
        v.registrationDeadline = c.registrationDeadline;
        v.dealingDeadline = c.dealingDeadline;
        v.joinedCount = c.joinedCount;
        v.dealtCount = c.dealtCount;
        v.rosterHash = c.rosterHash;
        v.ctx = c.ctx;
        v.inviteCount = c.inviteCount;
        v.consumedInvites = c.consumedInvites;
        v.qualBitmap = c.qualBitmap;
        if (c.phase == Phase.Live) (v.pkX, v.pkY) = _aggregate(c, 0);
    }

    /// @notice The immutable phase policy, `manualOpenedAt`, and the two predicates at
    ///         `block.timestamp` (protocol §8.1, §8.3, §8.7).
    function getPolicy(bytes12 cid) external view returns (PhasePolicyView memory v) {
        Ceremony storage c = _existing(cid);
        v.registrationMode = c.registrationMode;
        v.decryptionMode = c.decryptionMode;
        v.dealingDuration = c.dealingDuration;
        v.decryptionOpenAt = c.decryptionOpenAt;
        v.manualDecryptionFallbackAt = c.manualDecryptionFallbackAt;
        v.manualOpenedAt = c.manualOpenedAt;
        v.decryptionOpen = _decryptionOpen(c);
        uint256 deadline = c.registrationDeadline;
        v.scheduledRegistrationCloseDue = c.phase == Phase.Registration && deadline != 0 && block.timestamp >= deadline
            && block.timestamp <= deadline + c.dealingDuration && c.joinedCount >= c.t;
    }

    /// @notice protocol §8.7 gate: Live and (Scheduled past `decryptionOpenAt`, or Manual opened
    ///         or past its nonzero fallback). The adapter and the SDK read this, never the clock.
    function isDecryptionOpen(bytes12 cid) external view returns (bool) {
        return _decryptionOpen(_existing(cid));
    }

    function getInvite(bytes12 cid, uint8 inviteId) external view returns (address key, bool consumed) {
        Ceremony storage c = _existing(cid);
        if (inviteId >= c.inviteCount) revert UnknownInvite();
        key = c.invites[inviteId];
        consumed = (c.consumedInvites >> inviteId) & 1 != 0;
    }

    /// @notice Member `index`: authorization address, compressed(X_i) (protocol §2.5; the SDK
    ///         decompresses and revalidates it) and whether it dealt.
    function getParticipantCompressed(bytes12 cid, uint8 index)
        external
        view
        returns (address auth, uint256 compressedKey, bool dealt)
    {
        Ceremony storage c = _existing(cid);
        if (index == 0 || index > c.joinedCount) revert NotQualified();
        Participant storage p = c.participants[index - 1];
        return (p.auth, p.compressedX, (c.qualBitmap >> (index - 1)) & 1 != 0);
    }

    function participantIndexOf(bytes12 cid, address auth) external view returns (uint8) {
        return _existing(cid).authIndex[auth];
    }

    function getQual(bytes12 cid) external view returns (uint16 bitmap) {
        return _existing(cid).qualBitmap;
    }

    /// @notice Ceremony public key P = A_0 in TE; reverts unless the ceremony is Live.
    function getPublicKey(bytes12 cid) external view returns (uint256 x, uint256 y) {
        return _aggregate(_live(cid), 0);
    }

    /// @notice PK_index = Horner(A, index) = s_index·G (TE), computed on demand.
    function getMemberKey(bytes12 cid, uint8 index) external view returns (uint256 x, uint256 y) {
        Ceremony storage c = _live(cid);
        if (index == 0 || index > c.n) revert NotQualified();
        return _memberKey(c, index);
    }

    /// @notice A_0..A_{t-1} in TE (bias removed); the identity for k >= t. Live only.
    function getAggregates(bytes12 cid) external view returns (uint256[2][16] memory A) {
        Ceremony storage c = _live(cid);
        uint256 t = c.t;
        for (uint256 k; k < 16; ++k) {
            if (k < t) (A[k][0], A[k][1]) = _aggregate(c, k);
            else A[k][1] = 1;
        }
    }

    /// @notice What share recovery reads from dealer `dealerIndex` (protocol §8.6):
    ///         compressed(E_j) and its masked shares (zero for i >= n). Reverts unless it dealt.
    function getRecoveryDealing(bytes12 cid, uint8 dealerIndex)
        external
        view
        returns (uint256 compressedE, uint256[16] memory maskedShares)
    {
        Ceremony storage c = _existing(cid);
        if (dealerIndex == 0 || dealerIndex > MAX_N || (c.qualBitmap >> (dealerIndex - 1)) & 1 == 0) {
            revert NotQualified();
        }
        RecoveryRecord storage rec = c.recovery[dealerIndex - 1];
        uint256 n = c.n;
        for (uint256 i; i < n; ++i) {
            maskedShares[i] = rec.masked[i];
        }
        compressedE = rec.compressedE;
    }

    /// @notice One-call recovery input of member `memberIndex` (protocol §8.6): QUAL and, for every
    ///         dealer j (slot j-1), compressed(E_j) and masked_{j,memberIndex}; zero if j is not in
    ///         QUAL (presence is the bitmap, never a nonzero word).
    function getRecoverySlice(bytes12 cid, uint8 memberIndex)
        external
        view
        returns (uint16 qualBitmap, uint256[16] memory compressedE, uint256[16] memory maskedShares)
    {
        Ceremony storage c = _existing(cid);
        if (memberIndex == 0 || memberIndex > c.n) revert NotQualified();
        qualBitmap = c.qualBitmap;
        for (uint256 j; j < MAX_N; ++j) {
            if ((qualBitmap >> j) & 1 == 0) continue;
            RecoveryRecord storage rec = c.recovery[j];
            compressedE[j] = rec.compressedE;
            maskedShares[j] = rec.masked[memberIndex - 1];
        }
    }

    function isAdapterAllowed(bytes12 cid, address adapter) external view returns (bool) {
        return _existing(cid).allowedAdapters[adapter];
    }

    function isCreatorAuthorized(bytes12 cid, address creator) external view returns (bool) {
        return _existing(cid).authorizedCreators[creator];
    }

    function getBinding(address adapter, bytes31 processId)
        external
        view
        returns (bytes12 cid, bytes32 requestId, bool requested)
    {
        requestId = _bindings[_bindingKey(adapter, processId)];
        if (requestId == bytes32(0)) revert UnknownBinding();
        Request storage r = _requests[requestId];
        return (r.cid, requestId, r.fieldCount != 0);
    }

    /// @notice Request record; `fieldCount == 0` means bound but not yet submitted.
    function getRequestMeta(bytes32 requestId)
        external
        view
        returns (bytes12 cid, uint8 fieldCount, uint16 completedBitmap, uint16 partialBitmap)
    {
        Request storage r = _bound(requestId);
        return (r.cid, r.fieldCount, r.completedBitmap, r.partialBitmap);
    }

    /// @notice `[compressed(C1_k), compressed(C2_k)]` per field (protocol §9.2); the SDK
    ///         decompresses and revalidates them (§9.3).
    function getRequestCompressed(bytes32 requestId) external view returns (uint256[2][] memory compressedCts) {
        Request storage r = _bound(requestId);
        uint256 count = r.fieldCount;
        compressedCts = new uint256[2][](count);
        for (uint256 k; k < count; ++k) {
            compressedCts[k][0] = r.compressedCts[2 * k];
            compressedCts[k][1] = r.compressedCts[2 * k + 1];
        }
    }

    /// @notice Who bound the request: adapter, DAVINCI process id and authorized creator (§9.3 item 3).
    function getRequestOrigin(bytes32 requestId)
        external
        view
        returns (address adapter, bytes31 processId, address creator)
    {
        Request storage r = _bound(requestId);
        return (r.adapter, r.processId, r.creator);
    }

    /// @notice Number of request ids bound to the ceremony.
    function getRequestCount(bytes12 cid) external view returns (uint256) {
        return _existing(cid).requestIds.length;
    }

    /// @notice Request ids `offset .. offset + limit - 1` in binding order, truncated at the end
    ///         (empty when `offset >= getRequestCount(cid)`).
    function getRequestIdsPage(bytes12 cid, uint256 offset, uint256 limit)
        external
        view
        returns (bytes32[] memory page)
    {
        bytes32[] storage all = _existing(cid).requestIds;
        uint256 len = all.length;
        uint256 count = offset >= len ? 0 : len - offset;
        if (limit < count) count = limit;
        page = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            page[i] = all[offset + i];
        }
    }

    /// @notice Member `index`'s partial commitment (protocol §10.2): whether a partial was
    ///         accepted, its partialDataHash and the block of its latest D publication (the full
    ///         vector travels in `PartialDataPublished`, protocol §10.4).
    function getPartialCommitment(bytes32 requestId, uint8 index)
        external
        view
        returns (bool accepted, bytes32 dataHash, uint64 publishedBlock)
    {
        Request storage r = _bound(requestId);
        if (index == 0 || index > MAX_N || (r.partialBitmap >> (index - 1)) & 1 == 0) return (false, 0, 0);
        return (true, r.partialDataHashes[index - 1], r.partialPublishedBlocks[index - 1]);
    }

    /// @notice Combined plaintexts; `values.length == fieldCount`, `ready` only once every field
    ///         is combined (uncombined fields read 0).
    function getPlaintexts(bytes32 requestId) external view returns (bool ready, uint256[] memory values) {
        Request storage r = _bound(requestId);
        uint256 count = r.fieldCount;
        values = new uint256[](count);
        for (uint256 k; k < count; ++k) {
            values[k] = r.plaintexts[k];
        }
        ready = count != 0 && r.completedBitmap == (1 << count) - 1;
    }
}
