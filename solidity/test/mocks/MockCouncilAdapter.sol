// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {ICouncilManager} from "../../src/interfaces/ICouncilManager.sol";

/// @notice Test double of the DAVINCI CouncilAdapter (architecture §3.1), driven by the test
///         contract acting as the ProcessRegistry. Same semantics as the real adapter: the
///         registry passes the creator through, the adapter keeps `requestId => processId`,
///         submits the whole field array in one call and proxies `plaintexts` only for the full
///         range `first == 0, count == fieldCount`.
contract MockCouncilAdapter {
    error OnlyRegistry();
    error BadRange();
    error UnknownRequestId();

    ICouncilManager public immutable manager;
    address public immutable registry;
    mapping(bytes32 => bytes31) public processOf;

    constructor(address manager_) {
        manager = ICouncilManager(manager_);
        registry = msg.sender;
    }

    modifier onlyRegistry() {
        if (msg.sender != registry) revert OnlyRegistry();
        _;
    }

    function register(bytes31 pid, address creator, bytes12 cid)
        external
        onlyRegistry
        returns (bytes12, bytes32 requestId, uint256 pkX, uint256 pkY)
    {
        (requestId, pkX, pkY) = manager.bindProcess(cid, pid, creator);
        processOf[requestId] = pid;
        return (cid, requestId, pkX, pkY);
    }

    function submit(bytes12 cid, bytes32 requestId, uint256[4][] calldata cts)
        external
        onlyRegistry
        returns (uint16 firstIndex)
    {
        bytes31 pid = processOf[requestId];
        if (pid == bytes31(0)) revert UnknownRequestId();
        manager.submitRequest(cid, pid, cts);
        return 0;
    }

    function plaintexts(bytes12 cid, bytes32 requestId, uint16 first, uint16 count)
        external
        view
        returns (bool ready, uint256[] memory values)
    {
        (bytes12 rcid, uint8 fieldCount,,,) = manager.getRequest(requestId);
        if (rcid != cid || first != 0 || count != fieldCount) revert BadRange();
        return manager.getPlaintexts(requestId);
    }
}
