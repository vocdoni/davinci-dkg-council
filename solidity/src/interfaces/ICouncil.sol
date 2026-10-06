// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {
    CreateCeremony,
    AddInvites,
    CloseRegistration,
    AllowAdapter,
    AuthorizeCreator,
    Invite,
    Join,
    Deal,
    Partial,
    CeremonyView
} from "../CouncilTypes.sol";

/// @notice State-changing surface, immutables and events, implemented by CouncilManager itself
///         (architecture §1.1, §1.3).
interface ICouncilCore {
    event CeremonyCreated(
        bytes12 indexed cid,
        address indexed organizer,
        uint8 threshold,
        uint64 registrationDeadline,
        uint64 dealingDuration
    );
    event InvitesAdded(bytes12 indexed cid, uint32 firstInviteId, uint32 count);
    event ParticipantJoined(bytes12 indexed cid, uint8 index, address auth, uint32 inviteId);
    event RegistrationClosed(bytes12 indexed cid, uint8 n, bytes32 rosterHash, uint64 dealingDeadline);
    event DealingAccepted(bytes12 indexed cid, uint8 dealerIndex);
    event CeremonyFinalized(bytes12 indexed cid, uint16 qualBitmap, uint256 pkX, uint256 pkY);
    event CeremonyAborted(bytes12 indexed cid, uint8 phaseAtAbort);
    event AdapterAllowed(bytes12 indexed cid, address adapter);
    event CreatorAuthorized(bytes12 indexed cid, address creator);
    event ProcessBound(
        bytes12 indexed cid, address indexed adapter, bytes31 processId, bytes32 requestId, address creator
    );
    event RequestSubmitted(bytes32 indexed requestId, bytes12 indexed cid, uint8 fieldCount);
    event PartialAccepted(bytes32 indexed requestId, uint8 index);
    event FieldsCombined(bytes32 indexed requestId, uint8[] fieldIndexes, uint64[] plaintexts);
    event RequestCompleted(bytes32 indexed requestId);

    function createCeremony(CreateCeremony calldata a, bytes calldata orgSig) external returns (bytes12 cid);
    function addInvites(AddInvites calldata a, bytes calldata orgSig) external;
    function closeRegistration(CloseRegistration calldata a, bytes calldata orgSig) external;
    function join(Join calldata a, bytes calldata participantSig, Invite calldata inv, bytes calldata inviteSig)
        external;
    function deal(
        Deal calldata a,
        bytes calldata sig,
        uint256[2][16] calldata C,
        uint256[2] calldata E,
        uint256[16] calldata maskedShares,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC
    ) external;
    function finalize(bytes12 cid) external;
    function abort(bytes12 cid) external;
    function allowAdapter(AllowAdapter calldata a, bytes calldata orgSig) external;
    function authorizeCreator(AuthorizeCreator calldata a, bytes calldata orgSig) external;
    function bindProcess(bytes12 cid, bytes31 processId, address creator)
        external
        returns (bytes32 requestId, uint256 pkX, uint256 pkY);
    function submitRequest(bytes12 cid, bytes31 processId, uint256[4][] calldata cts)
        external
        returns (bytes32 requestId);
    function submitPartial(
        Partial calldata a,
        bytes calldata sig,
        uint256[2][16] calldata D,
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC
    ) external;
    function combine(
        bytes32 requestId,
        uint8[] calldata memberSet,
        uint8[] calldata fieldIndexes,
        uint64[] calldata plaintexts
    ) external;

    function ceremonyIdFor(address organizer, uint64 nonce) external view returns (bytes12);
    function circuitReleaseId() external view returns (bytes32);
    function dealVerifier() external view returns (address);
    function partialVerifier() external view returns (address);
    /// @notice The CouncilViews code the manager delegates its read surface to.
    function views() external view returns (address);
}

/// @notice Read surface (architecture §1.2 plus request pagination and origin), implemented by
///         CouncilViews and served at the manager's address through its delegatecall fallback.
interface ICouncilViews {
    function getCeremony(bytes12 cid) external view returns (CeremonyView memory);
    function getInvite(bytes12 cid, uint32 inviteId) external view returns (address key, bool consumed);
    function getParticipant(bytes12 cid, uint8 index)
        external
        view
        returns (address auth, uint256 pkX, uint256 pkY, bool dealt);
    function participantIndexOf(bytes12 cid, address auth) external view returns (uint8);
    function getDealing(bytes12 cid, uint8 dealerIndex)
        external
        view
        returns (uint256[2][16] memory C, uint256[2] memory E, uint256[16] memory maskedShares);
    function getQual(bytes12 cid) external view returns (uint16 bitmap);
    function getPublicKey(bytes12 cid) external view returns (uint256 x, uint256 y);
    function getMemberKey(bytes12 cid, uint8 index) external view returns (uint256 x, uint256 y);
    function getAggregates(bytes12 cid) external view returns (uint256[2][16] memory A);
    function isAdapterAllowed(bytes12 cid, address adapter) external view returns (bool);
    function isCreatorAuthorized(bytes12 cid, address creator) external view returns (bool);
    function getBinding(address adapter, bytes31 processId)
        external
        view
        returns (bytes12 cid, bytes32 requestId, bool requested);
    function getRequest(bytes32 requestId)
        external
        view
        returns (bytes12 cid, uint8 fieldCount, uint16 completedBitmap, uint16 partialBitmap, uint256[4][] memory cts);
    function getRequestOrigin(bytes32 requestId)
        external
        view
        returns (address adapter, bytes31 processId, address creator);
    function getRequestIds(bytes12 cid) external view returns (bytes32[] memory);
    function getRequestCount(bytes12 cid) external view returns (uint256);
    function getRequestIdsPage(bytes12 cid, uint256 offset, uint256 limit) external view returns (bytes32[] memory);
    function getPartial(bytes32 requestId, uint8 index) external view returns (uint256[2][16] memory D);
    function getPlaintexts(bytes32 requestId) external view returns (bool ready, uint256[] memory values);
}

/// @title ICouncil
/// @notice The complete external surface of a CouncilManager deployment: one address, every
///         function of ICouncilCore and ICouncilViews. Its compiled ABI (plus the custom errors of
///         CouncilManager's ABI) is what SDK `abi-equals` checks should compare against.
interface ICouncil is ICouncilCore, ICouncilViews {}
