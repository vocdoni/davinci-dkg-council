// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {CouncilManager} from "../src/CouncilManager.sol";
import {CouncilViews} from "../src/CouncilViews.sol";
import {ICouncilViews, ICouncilCore} from "../src/interfaces/ICouncil.sol";
import {ICouncilManager} from "../src/interfaces/ICouncilManager.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";

/// @notice The EIP-170 split (architecture §1.7): CouncilViews runs on the manager's storage
///         through the manager's delegatecall fallback, so one address serves the whole ICouncil
///         surface, including every adapter-facing ICouncilManager function.
contract CouncilViewsSplitTest is CouncilTestBase {
    function test_Split_ViewsCreatedByTheManager() public view {
        address v = manager.views();
        assertTrue(v != address(0) && v != address(manager));
        assertEq(keccak256(v.code), keccak256(type(CouncilViews).runtimeCode));
    }

    /// @dev Every ICouncilViews selector answers at the manager address with manager state.
    function test_Split_EveryViewServedAtTheManager() public {
        _toLive(3, 2);
        _bindAndRequest(bytes31(uint248(1)), _u64s(1, 2, 3));
        _partial(1);
        address m = address(manager);
        bytes[19] memory calls = [
            abi.encodeCall(ICouncilViews.getCeremony, (cid)),
            abi.encodeCall(ICouncilViews.getInvite, (cid, 0)),
            abi.encodeCall(ICouncilViews.getParticipant, (cid, 1)),
            abi.encodeCall(ICouncilViews.participantIndexOf, (cid, vm.addr(authSecrets[0]))),
            abi.encodeCall(ICouncilViews.getDealing, (cid, 1)),
            abi.encodeCall(ICouncilViews.getQual, (cid)),
            abi.encodeCall(ICouncilViews.getPublicKey, (cid)),
            abi.encodeCall(ICouncilViews.getMemberKey, (cid, 2)),
            abi.encodeCall(ICouncilViews.getAggregates, (cid)),
            abi.encodeCall(ICouncilViews.isAdapterAllowed, (cid, address(adapter))),
            abi.encodeCall(ICouncilViews.isCreatorAuthorized, (cid, creator)),
            abi.encodeCall(ICouncilViews.getBinding, (address(adapter), pid)),
            abi.encodeCall(ICouncilViews.getRequest, (requestId)),
            abi.encodeCall(ICouncilViews.getRequestOrigin, (requestId)),
            abi.encodeCall(ICouncilViews.getRequestIds, (cid)),
            abi.encodeCall(ICouncilViews.getRequestCount, (cid)),
            abi.encodeCall(ICouncilViews.getRequestIdsPage, (cid, 0, 1)),
            abi.encodeCall(ICouncilViews.getPartial, (requestId, 1)),
            abi.encodeCall(ICouncilViews.getPlaintexts, (requestId))
        ];
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory out) = m.staticcall(calls[i]);
            assertTrue(ok, "view reverted through the manager");
            assertGt(out.length, 0);
            // the same call on the bare views contract sees no ceremony at all
            (ok,) = manager.views().staticcall(calls[i]);
            assertFalse(ok, "bare views contract has state");
        }
        assertEq(manager.getRequestCount(cid), 1);
    }

    /// @dev The adapter-facing interface needs nothing beyond the manager address.
    function test_Split_AdapterInterfaceAtTheManager() public {
        _toLive(2, 2);
        _bindAndRequest(bytes31(uint248(5)), _u64s(4, 5, 6));
        ICouncilManager m = ICouncilManager(address(manager));
        (uint256 x, uint256 y) = m.getPublicKey(cid);
        assertTrue(x != 0 || y != 1);
        (bytes12 c,,) = m.getBinding(address(adapter), pid);
        assertEq(c, cid);
        (, uint8 fieldCount,,,) = m.getRequest(requestId);
        assertEq(fieldCount, 3);
        (bool ready, uint256[] memory values) = m.getPlaintexts(requestId);
        assertFalse(ready);
        assertEq(values.length, 3);
    }

    function test_Split_UnknownSelectorAndValueRevert() public {
        (bool ok,) = address(manager).call(abi.encodeWithSignature("doesNotExist()"));
        assertFalse(ok);
        (ok,) = address(manager).call("");
        assertFalse(ok);
        vm.deal(address(this), 1 ether);
        (ok,) = address(manager).call{value: 1}("");
        assertFalse(ok, "accepted ether");
        (ok,) = address(manager).call{value: 1}(abi.encodeCall(ICouncilViews.getQual, (cid)));
        assertFalse(ok, "accepted ether on a view");
    }

    /// @dev Reverts from the views keep their custom errors through the fallback.
    function test_Split_ErrorsBubble() public {
        vm.expectRevert(UnknownCeremony.selector);
        manager.getCeremony(bytes12(uint96(7)));
        _create(2, 3);
        vm.expectRevert(WrongPhase.selector);
        manager.getPublicKey(cid);
        vm.expectRevert(UnknownInvite.selector);
        manager.getInvite(cid, 3);
    }

    /// @dev Core selectors are real functions of the manager, never routed to the views.
    function test_Split_CoreSelectorsAreManagerFunctions() public view {
        assertEq(CouncilManager(address(manager)).circuitReleaseId(), RELEASE_ID);
        bytes4[5] memory core = [
            ICouncilCore.bindProcess.selector,
            ICouncilCore.submitRequest.selector,
            ICouncilCore.finalize.selector,
            ICouncilCore.combine.selector,
            ICouncilCore.views.selector
        ];
        bytes memory viewsCode = manager.views().code;
        for (uint256 i; i < core.length; ++i) {
            // a 4-byte selector of a core function never appears as a PUSH4 in the views dispatcher
            assertFalse(_hasPush4(viewsCode, core[i]), "core selector in views");
        }
    }

    function _hasPush4(bytes memory code, bytes4 sel) internal pure returns (bool) {
        for (uint256 i; i + 4 < code.length; ++i) {
            if (code[i] == 0x63 && bytes4(bytes.concat(code[i + 1], code[i + 2], code[i + 3], code[i + 4])) == sel) {
                return true;
            }
        }
        return false;
    }
}
