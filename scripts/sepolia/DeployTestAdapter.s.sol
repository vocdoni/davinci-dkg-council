// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CouncilManager} from "src/CouncilManager.sol";
import {MockCouncilAdapter} from "test/mocks/MockCouncilAdapter.sol";
import {CouncilRelease} from "script/CouncilRelease.sol";

/// @title DeployTestAdapter
/// @notice Deploys the e2e test double of the DAVINCI CouncilAdapter (`MockCouncilAdapter`)
///         against an existing CouncilManager. The deployer becomes the adapter's `registry`:
///         only that key can bind processes and submit decryption requests through it. A test
///         requester for testnet rehearsals, never a production integration.
///
///   MANAGER=0x… PRIVATE_KEY=… forge script ../scripts/sepolia/DeployTestAdapter.s.sol \
///     --rpc-url … --broadcast        (from solidity)
contract DeployTestAdapter is Script {
    function run() external returns (MockCouncilAdapter adapter) {
        uint256 key = vm.envUint("PRIVATE_KEY");
        address manager = vm.envAddress("MANAGER");
        require(manager.code.length != 0, "DeployTestAdapter: no code at MANAGER");
        require(
            CouncilManager(manager).circuitReleaseId() == CouncilRelease.CIRCUIT_RELEASE_ID,
            "DeployTestAdapter: MANAGER is not bound to the pinned circuit release"
        );
        vm.startBroadcast(key);
        adapter = new MockCouncilAdapter(manager);
        vm.stopBroadcast();
        require(adapter.registry() == vm.addr(key), "DeployTestAdapter: registry");
        console2.log("MockCouncilAdapter", address(adapter));
    }
}
