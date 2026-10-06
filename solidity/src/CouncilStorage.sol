// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Phase, UnknownCeremony, WrongPhase, UnknownRequest} from "./CouncilTypes.sol";

/// @title CouncilStorage
/// @notice The single storage layout of a Council deployment (architecture §1.5), shared by
///         CouncilManager (every state transition) and CouncilViews (the read surface, reached
///         through the manager's delegatecall fallback). Neither contract declares any other state
///         variable: this base is the whole layout, so both see the same slots.
abstract contract CouncilStorage {
    uint256 internal constant MAX_N = 16;
    uint256 internal constant MAX_T = 16;
    uint256 internal constant MAX_FIELDS = 16;

    struct Participant {
        address auth;
        uint256 pkX;
        uint256 pkY;
    }

    /// @dev Only the active entries are written (C_k for k < t, masked_i for i < n); the views
    ///      return the identity / zero padding the protocol fixes for the rest.
    struct Dealing {
        uint256[2][16] C;
        uint256[2] E;
        uint256[16] masked;
    }

    struct Ceremony {
        // slot 0
        Phase phase;
        address organizer;
        uint8 t;
        uint8 n;
        uint8 joinedCount;
        uint8 dealtCount;
        uint16 qualBitmap;
        uint32 inviteCount;
        // slot 1
        uint64 registrationDeadline;
        uint64 dealingDeadline;
        uint64 dealingDuration;
        uint64 consumedInvites;
        bytes32 rosterHash;
        bytes32 ctx;
        Participant[16] participants; // slot i = member i+1
        Dealing[16] dealings; // slot j = dealer j+1
        uint256[2][16] aggregates; // A_k in TE, k < t; A_0 = P
        uint256[2][16] memberKeys; // PK_m in TE, slot m-1
        bytes32[] requestIds;
        mapping(uint256 => address) invites; // inviteId => capability address
        mapping(address => uint8) authIndex; // auth address => member index (0 = none)
        mapping(bytes32 => bool) keyUsed; // keccak(X.x, X.y) => registered
        mapping(address => bool) allowedAdapters;
        mapping(address => bool) authorizedCreators;
    }

    /// @dev Created at bindProcess (cid, adapter, processId, creator); filled at submitRequest.
    struct Request {
        // slot 0
        bytes12 cid;
        address adapter;
        // slot 1
        bytes31 processId;
        uint8 fieldCount; // 0 until submitted
        // slot 2
        address creator;
        uint16 partialBitmap; // bit i-1 = member i has an accepted partial
        uint16 completedBitmap; // bit k = field k combined
        uint256[4][16] cts; // [C1.x, C1.y, C2.x, C2.y] TE, k < fieldCount
        uint64[16] plaintexts;
        mapping(uint256 => uint256[2][16]) partials; // member index => D (TE), k < fieldCount
    }

    mapping(bytes12 => Ceremony) internal _ceremonies;
    mapping(bytes32 => bytes32) internal _bindings; // keccak(adapter, processId) => requestId
    mapping(bytes32 => Request) internal _requests;

    /// @dev The existence check every state-changing call runs first (protocol §8).
    function _existing(bytes12 cid) internal view returns (Ceremony storage c) {
        c = _ceremonies[cid];
        if (c.phase == Phase.None) revert UnknownCeremony();
    }

    function _live(bytes12 cid) internal view returns (Ceremony storage c) {
        c = _existing(cid);
        if (c.phase != Phase.Live) revert WrongPhase();
    }

    function _bound(bytes32 requestId) internal view returns (Request storage r) {
        r = _requests[requestId];
        if (r.cid == bytes12(0)) revert UnknownRequest();
    }

    function _bindingKey(address adapter, bytes31 processId) internal pure returns (bytes32) {
        return keccak256(abi.encode(adapter, processId));
    }
}
