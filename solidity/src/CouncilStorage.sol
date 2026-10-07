// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {
    Phase,
    MODE_SCHEDULED,
    UnknownCeremony,
    WrongPhase,
    UnknownRequest,
    BlockNumberOverflow,
    RegistrationEnded,
    NoInvites,
    TooManyInvites,
    ZeroAddress,
    DuplicateInvite
} from "./CouncilTypes.sol";
import {CouncilCurve} from "./libraries/CouncilCurve.sol";

/// @title CouncilStorage
/// @notice The single storage layout of a Council deployment (architecture §1.5), shared by
///         CouncilManager (every state transition), CouncilOps (its rarely-used state transitions)
///         and CouncilViews (the read surface), the last two reached through the manager's
///         delegatecall fallback. None of them declares any other state variable: this base is the
///         whole layout, so all three see the same slots.
///
///         v2 storage diet (protocol §2.5, §8.3, §10.2): roster keys, dealer ephemerals and request
///         ciphertexts are stored as compressed words; per-dealer commitments are folded into the
///         biased aggregates at deal time; member keys are computed on demand; partial D vectors
///         are committed by hash plus a publication block.
abstract contract CouncilStorage {
    uint256 internal constant MAX_N = 16;
    uint256 internal constant MAX_T = 16;
    uint256 internal constant MAX_FIELDS = 16;
    uint256 internal constant MAX_INVITES = 64;
    bytes32 internal constant TAG_PARTIAL_DATA = keccak256("davinci-dkg-council/v2/partial-data");

    struct Participant {
        address auth;
        uint256 compressedX; // compressed(X_i), protocol §2.5
    }

    /// @dev What share recovery reads (protocol §8.6): compressed(E_j) and the n active masked
    ///      shares (zero for i >= n, never written). The commitments C_j are not stored.
    struct RecoveryRecord {
        uint256 compressedE;
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
        uint8 inviteCount;
        uint8 registrationMode;
        uint8 decryptionMode;
        // slot 1
        uint64 registrationDeadline;
        uint64 dealingDeadline;
        uint64 dealingDuration;
        uint64 consumedInvites;
        // slot 2
        uint64 decryptionOpenAt;
        uint64 manualDecryptionFallbackAt;
        uint64 manualOpenedAt;
        bytes32 rosterHash;
        bytes32 ctx;
        Participant[16] participants; // slot i = member i+1
        RecoveryRecord[16] recovery; // slot j = dealer j+1
        /// @dev (A_k.x + 1, A_k.y + 1) in TE for k < t (protocol §8.3): every initialized slot is
        ///      nonzero, so later dealings pay warm updates and "unset" differs from the identity.
        uint256[2][16] aggregatesBiased;
        bytes32[] requestIds;
        mapping(uint256 => address) invites; // inviteId => capability address
        mapping(address => uint8) authIndex; // auth address => member index (0 = none)
        mapping(uint256 => bool) keyUsed; // compressed(X) => registered
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
        uint256[32] compressedCts; // [compressed(C1_k), compressed(C2_k)] at [2k, 2k+1], k < fieldCount
        uint40[16] plaintexts; // < RESULT_BOUND = 2^40, protocol §10.3 (the ABI stays uint64)
        bytes32[16] partialDataHashes; // slot i-1 = member i's partialDataHash (protocol §10.2)
        uint64[16] partialPublishedBlocks; // slot i-1 = block of member i's latest D publication
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

    /// @dev protocol §8.7: the decryption gate of an existing ceremony at `block.timestamp`.
    function _decryptionOpen(Ceremony storage c) internal view returns (bool) {
        if (c.phase != Phase.Live) return false;
        if (c.decryptionMode == MODE_SCHEDULED) return block.timestamp >= c.decryptionOpenAt;
        uint256 fallbackAt = c.manualDecryptionFallbackAt;
        return c.manualOpenedAt != 0 || (fallbackAt != 0 && block.timestamp >= fallbackAt);
    }

    /// @dev A_k in TE (bias removed). Only meaningful for k < t once a dealing was accepted.
    function _aggregate(Ceremony storage c, uint256 k) internal view returns (uint256 x, uint256 y) {
        uint256[2] storage a = c.aggregatesBiased[k];
        unchecked {
            return (a[0] - 1, a[1] - 1);
        }
    }

    /// @dev PK_m = Horner(A, m) = Σ_{k<t} m^k·A_k in TE, computed on demand from the aggregates
    ///      (protocol §8.4, §10.2); nothing is stored. Requires at least one accepted dealing.
    function _memberKey(Ceremony storage c, uint256 m) internal view returns (uint256 x, uint256 y) {
        uint256 t = c.t;
        uint256[2][16] memory a;
        for (uint256 k; k < t; ++k) {
            (uint256 ax, uint256 ay) = _aggregate(c, k);
            a[k][0] = CouncilCurve.toReduced(ax);
            a[k][1] = ay;
        }
        (x, y) = CouncilCurve.horner(a, t, m);
        x = CouncilCurve.toTE(x);
    }

    /// @dev protocol §10.2 durable partial-data commitment over the full padded D vector (excludes
    ///      the proof, so a returning member can recompute it from its share and the stored
    ///      ciphertexts, protocol §10.4).
    function _partialDataHash(bytes12 cid, bytes32 requestId, uint256 index, uint256 count, uint256[2][16] calldata D)
        internal
        view
        returns (bytes32)
    {
        return keccak256(
            abi.encode(TAG_PARTIAL_DATA, block.chainid, address(this), cid, requestId, uint8(index), uint8(count), D)
        );
    }

    /// @dev Records the block of member `index`'s latest D publication (protocol §10.2/§10.4).
    function _published(Request storage r, uint256 index) internal {
        if (block.number > type(uint64).max) revert BlockNumberOverflow();
        r.partialPublishedBlocks[index - 1] = uint64(block.number);
    }

    /// @dev Joining (and AddInvites, and the organizer's close) is open in Registration until a
    ///      nonzero deadline, exclusive (protocol §8.2: the interval is half-open).
    function _requireJoining(Ceremony storage c) internal view {
        if (c.phase != Phase.Registration) revert WrongPhase();
        uint256 deadline = c.registrationDeadline;
        if (deadline != 0 && block.timestamp >= deadline) revert RegistrationEnded();
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
        c.inviteCount = uint8(have + len);
    }
}
