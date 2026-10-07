// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {CouncilManager} from "../src/CouncilManager.sol";
import {CouncilViews} from "../src/CouncilViews.sol";
import {CouncilOps} from "../src/CouncilOps.sol";
import {ICouncilViews, ICouncilCore, ICouncilOps} from "../src/interfaces/ICouncil.sol";
import {ICouncilManager} from "../src/interfaces/ICouncilManager.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";

/// @notice The EIP-170 split (architecture §1.7): CouncilViews (read-only) and CouncilOps (the
///         rarely-used transitions) run on the manager's storage through the manager's
///         delegatecall fallback, so one address serves the whole ICouncil surface, including
///         every adapter-facing ICouncilManager function. The fallback whitelists the ICouncilOps
///         selectors to CouncilOps and sends everything else to CouncilViews.
contract CouncilViewsSplitTest is CouncilTestBase {
    function _ops() internal view returns (address) {
        return vm.computeCreateAddress(address(manager), 2);
    }

    function test_Split_LogicContractsCreatedByTheManager() public view {
        address v = manager.views();
        assertTrue(v != address(0) && v != address(manager));
        assertEq(keccak256(v.code), keccak256(type(CouncilViews).runtimeCode));
        assertEq(v, vm.computeCreateAddress(address(manager), 1));
        // CouncilOps carries the release id as an immutable: compare its code modulo that word
        address o = _ops();
        assertGt(o.code.length, 0);
        assertTrue(o != v);
    }

    /// @dev Every ICouncilViews selector answers at the manager address with manager state.
    function test_Split_EveryViewServedAtTheManager() public {
        _toLive(3, 2);
        _bindAndRequest(bytes31(uint248(1)), _u64s(1, 2, 3));
        _partial(1);
        address m = address(manager);
        bytes[25] memory calls = [
            abi.encodeCall(ICouncilViews.getCeremony, (cid)),
            abi.encodeCall(ICouncilViews.getPolicy, (cid)),
            abi.encodeCall(ICouncilViews.isDecryptionOpen, (cid)),
            abi.encodeCall(ICouncilViews.getInvite, (cid, 0)),
            abi.encodeCall(ICouncilViews.getParticipantCompressed, (cid, 1)),
            abi.encodeCall(ICouncilViews.participantIndexOf, (cid, vm.addr(authSecrets[0]))),
            abi.encodeCall(ICouncilViews.getQual, (cid)),
            abi.encodeCall(ICouncilViews.getPublicKey, (cid)),
            abi.encodeCall(ICouncilViews.getMemberKey, (cid, 2)),
            abi.encodeCall(ICouncilViews.getAggregates, (cid)),
            abi.encodeCall(ICouncilViews.getRecoveryDealing, (cid, 1)),
            abi.encodeCall(ICouncilViews.getRecoverySlice, (cid, 2)),
            abi.encodeCall(ICouncilViews.isAdapterAllowed, (cid, address(adapter))),
            abi.encodeCall(ICouncilViews.isCreatorAuthorized, (cid, creator)),
            abi.encodeCall(ICouncilViews.getBinding, (address(adapter), pid)),
            abi.encodeCall(ICouncilViews.getRequestMeta, (requestId)),
            abi.encodeCall(ICouncilViews.getRequestCompressed, (requestId)),
            abi.encodeCall(ICouncilViews.getRequestOrigin, (requestId)),
            abi.encodeCall(ICouncilViews.getRequestCount, (cid)),
            abi.encodeCall(ICouncilViews.getRequestIdsPage, (cid, 0, 1)),
            abi.encodeCall(ICouncilViews.getPartialCommitment, (requestId, 1)),
            abi.encodeCall(ICouncilViews.getPlaintexts, (requestId)),
            abi.encodeCall(ICouncilViews.protocolVersion, ()),
            abi.encodeCall(ICouncilCore.ceremonyIdFor, (organizer, 1)),
            abi.encodeCall(ICouncilCore.circuitReleaseId, ())
        ];
        for (uint256 i; i < calls.length; ++i) {
            (bool ok, bytes memory out) = m.staticcall(calls[i]);
            assertTrue(ok, "view reverted through the manager");
            assertGt(out.length, 0);
            // the same call on the bare views contract sees no ceremony at all
            if (i < 22) {
                (ok,) = manager.views().staticcall(calls[i]);
                assertFalse(ok, "bare views contract has state");
            }
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
        (, uint8 fieldCount,,) = m.getRequestMeta(requestId);
        assertEq(fieldCount, 3);
        (bool ready, uint256[] memory values) = m.getPlaintexts(requestId);
        assertFalse(ready);
        assertEq(values.length, 3);
        assertTrue(m.isDecryptionOpen(cid));
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
        (ok,) = address(manager).call{value: 1}(abi.encodeCall(ICouncilOps.abort, (cid)));
        assertFalse(ok, "accepted ether on an ops call");
    }

    /// @dev Reverts from the logic contracts keep their custom errors through the fallback.
    function test_Split_ErrorsBubble() public {
        vm.expectRevert(UnknownCeremony.selector);
        manager.getCeremony(bytes12(uint96(7)));
        vm.expectRevert(UnknownCeremony.selector);
        manager.abort(bytes12(uint96(7)));
        _create(2, 3);
        vm.expectRevert(WrongPhase.selector);
        manager.getPublicKey(cid);
        vm.expectRevert(UnknownInvite.selector);
        manager.getInvite(cid, 3);
        vm.expectRevert(AbortConditionNotMet.selector);
        manager.abort(cid);
    }

    /// @dev The routing table is exact: each ICouncilOps selector is dispatched by CouncilOps and
    ///      appears in neither the views nor the manager dispatcher as a function; each view
    ///      selector only in CouncilViews; each core selector only in the manager.
    function test_Split_SelectorsLiveInExactlyOneContract() public view {
        bytes memory viewsCode = manager.views().code;
        bytes memory opsCode = _ops().code;
        bytes4[9] memory opsSel = [
            ICouncilOps.addInvites.selector,
            ICouncilOps.closeRegistration.selector,
            ICouncilOps.closeRegistrationScheduled.selector,
            ICouncilOps.abort.selector,
            ICouncilOps.openDecryption.selector,
            ICouncilOps.allowAdapter.selector,
            ICouncilOps.authorizeCreator.selector,
            ICouncilOps.publishPartialData.selector,
            bytes4(0)
        ];
        for (uint256 i; i < 8; ++i) {
            assertTrue(_hasPush4(opsCode, opsSel[i]), "ops selector missing from CouncilOps");
            assertFalse(_hasPush4(viewsCode, opsSel[i]), "ops selector in views");
        }
        bytes4[9] memory core = [
            ICouncilCore.createCeremony.selector,
            ICouncilCore.join.selector,
            ICouncilCore.deal.selector,
            ICouncilCore.finalize.selector,
            ICouncilCore.bindProcess.selector,
            ICouncilCore.submitRequest.selector,
            ICouncilCore.submitPartial.selector,
            ICouncilCore.combine.selector,
            ICouncilCore.views.selector
        ];
        for (uint256 i; i < core.length; ++i) {
            // a 4-byte selector of a core function never appears as a PUSH4 in either dispatcher
            assertFalse(_hasPush4(viewsCode, core[i]), "core selector in views");
            assertFalse(_hasPush4(opsCode, core[i]), "core selector in ops");
        }
        bytes4[3] memory someViews = [
            ICouncilViews.getCeremony.selector,
            ICouncilViews.getPolicy.selector,
            ICouncilViews.getRecoverySlice.selector
        ];
        for (uint256 i; i < someViews.length; ++i) {
            assertTrue(_hasPush4(viewsCode, someViews[i]), "view selector missing");
            assertFalse(_hasPush4(opsCode, someViews[i]), "view selector in ops");
        }
    }

    /// @dev The ops code called directly (not through the manager) acts on its own empty
    ///      storage: every ceremony and request is unknown, so it can change nothing.
    function test_Split_OpsCalledDirectlyHasNoState() public {
        _toLive(2, 2);
        _bindAndRequest(bytes31(uint248(3)), _u64s(1, 2, 3));
        _partial(1);
        CouncilOps o = CouncilOps(_ops());
        vm.expectRevert(UnknownCeremony.selector);
        o.abort(cid);
        (AllowAdapter memory a, bytes memory sig) = _allowMsg(address(0xADA2));
        vm.expectRevert(UnknownCeremony.selector);
        o.allowAdapter(a, sig);
        uint256[2][16] memory D = dOf[requestId][1];
        vm.expectRevert(UnknownRequest.selector);
        o.publishPartialData(requestId, 1, D);
        vm.expectRevert(UnknownCeremony.selector);
        o.closeRegistrationScheduled(cid, _roster());
    }

    function test_Split_CoreImmutables() public view {
        assertEq(CouncilManager(address(manager)).circuitReleaseId(), RELEASE_ID);
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
