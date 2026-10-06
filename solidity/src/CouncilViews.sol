// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Phase, CeremonyView, UnknownInvite, NotQualified, UnknownBinding, MissingPartial} from "./CouncilTypes.sol";
import {CouncilStorage} from "./CouncilStorage.sol";
import {ICouncilViews} from "./interfaces/ICouncil.sol";

/// @title CouncilViews
/// @notice The read surface of a CouncilManager (architecture §1.2), split out for EIP-170. It is
///         created by the manager's constructor and only ever executed through the manager's
///         delegatecall fallback, on the manager's storage, so every view below is served at the
///         manager's address with the selectors the SDK and the adapter already use. Read-only by
///         construction: every function is `view`, and the contract has no fallback. Called
///         directly, it reads its own empty storage (every ceremony is unknown).
contract CouncilViews is CouncilStorage, ICouncilViews {
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
        if (c.phase == Phase.Live) {
            v.pkX = c.aggregates[0][0];
            v.pkY = c.aggregates[0][1];
        }
    }

    function getInvite(bytes12 cid, uint32 inviteId) external view returns (address key, bool consumed) {
        Ceremony storage c = _existing(cid);
        if (inviteId >= c.inviteCount) revert UnknownInvite();
        key = c.invites[inviteId];
        consumed = (c.consumedInvites >> inviteId) & 1 != 0;
    }

    function getParticipant(bytes12 cid, uint8 index)
        external
        view
        returns (address auth, uint256 pkX, uint256 pkY, bool dealt)
    {
        Ceremony storage c = _existing(cid);
        if (index == 0 || index > c.joinedCount) revert NotQualified();
        Participant storage p = c.participants[index - 1];
        return (p.auth, p.pkX, p.pkY, (c.qualBitmap >> (index - 1)) & 1 != 0);
    }

    function participantIndexOf(bytes12 cid, address auth) external view returns (uint8) {
        return _existing(cid).authIndex[auth];
    }

    /// @notice The stored dealing of `dealerIndex`, with the protocol padding (identity
    ///         commitments for k >= t, zero masked shares for i >= n). Reverts unless it dealt.
    function getDealing(bytes12 cid, uint8 dealerIndex)
        external
        view
        returns (uint256[2][16] memory C, uint256[2] memory E, uint256[16] memory maskedShares)
    {
        Ceremony storage c = _existing(cid);
        if (dealerIndex == 0 || dealerIndex > MAX_N || (c.qualBitmap >> (dealerIndex - 1)) & 1 == 0) {
            revert NotQualified();
        }
        Dealing storage d = c.dealings[dealerIndex - 1];
        C = _padded(d.C, c.t);
        uint256 n = c.n;
        for (uint256 i; i < n; ++i) {
            maskedShares[i] = d.masked[i];
        }
        E[0] = d.E[0];
        E[1] = d.E[1];
    }

    function getQual(bytes12 cid) external view returns (uint16 bitmap) {
        return _existing(cid).qualBitmap;
    }

    /// @notice Ceremony public key P in TE; reverts unless the ceremony is Live.
    function getPublicKey(bytes12 cid) external view returns (uint256 x, uint256 y) {
        Ceremony storage c = _live(cid);
        return (c.aggregates[0][0], c.aggregates[0][1]);
    }

    /// @notice PK_index = s_index·G as computed at finalization (TE).
    function getMemberKey(bytes12 cid, uint8 index) external view returns (uint256 x, uint256 y) {
        Ceremony storage c = _live(cid);
        if (index == 0 || index > c.n) revert NotQualified();
        return (c.memberKeys[index - 1][0], c.memberKeys[index - 1][1]);
    }

    /// @notice A_0..A_{t-1} in TE; identity for k >= t.
    function getAggregates(bytes12 cid) external view returns (uint256[2][16] memory) {
        Ceremony storage c = _live(cid);
        return _padded(c.aggregates, c.t);
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
    function getRequest(bytes32 requestId)
        external
        view
        returns (bytes12 cid, uint8 fieldCount, uint16 completedBitmap, uint16 partialBitmap, uint256[4][] memory cts)
    {
        Request storage r = _bound(requestId);
        fieldCount = r.fieldCount;
        cts = new uint256[4][](fieldCount);
        for (uint256 k; k < fieldCount; ++k) {
            cts[k] = r.cts[k];
        }
        return (r.cid, fieldCount, r.completedBitmap, r.partialBitmap, cts);
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

    /// @notice Every request id bound to the ceremony, in binding order (decryption dashboard).
    ///         Unbounded: read a long-lived ceremony with `getRequestCount` + `getRequestIdsPage`.
    function getRequestIds(bytes12 cid) external view returns (bytes32[] memory) {
        return getRequestIdsPage(cid, 0, type(uint256).max);
    }

    /// @notice Number of request ids bound to the ceremony.
    function getRequestCount(bytes12 cid) external view returns (uint256) {
        return _existing(cid).requestIds.length;
    }

    /// @notice Request ids `offset .. offset + limit - 1` in binding order, truncated at the end
    ///         (empty when `offset >= getRequestCount(cid)`).
    function getRequestIdsPage(bytes12 cid, uint256 offset, uint256 limit) public view returns (bytes32[] memory page) {
        bytes32[] storage all = _existing(cid).requestIds;
        uint256 len = all.length;
        uint256 count = offset >= len ? 0 : len - offset;
        if (limit < count) count = limit;
        page = new bytes32[](count);
        for (uint256 i; i < count; ++i) {
            page[i] = all[offset + i];
        }
    }

    /// @notice Accepted partial of member `index`, identity-padded for k >= fieldCount.
    function getPartial(bytes32 requestId, uint8 index) external view returns (uint256[2][16] memory) {
        Request storage r = _bound(requestId);
        if (index == 0 || index > MAX_N || (r.partialBitmap >> (index - 1)) & 1 == 0) revert MissingPartial();
        return _padded(r.partials[index], r.fieldCount);
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

    /// @dev The first `active` stored points, identity (0, 1) for the rest of the 16 slots.
    function _padded(uint256[2][16] storage src, uint256 active) internal view returns (uint256[2][16] memory out) {
        for (uint256 k; k < 16; ++k) {
            if (k < active) {
                out[k][0] = src[k][0];
                out[k][1] = src[k][1];
            } else {
                out[k][1] = 1;
            }
        }
    }
}
