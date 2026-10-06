// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import "../src/CouncilTypes.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";

/// @notice Mandatory regression (architecture §7 item 3): every state-changing call on a
///         nonexistent ceremony id reverts `UnknownCeremony()` before any authorization check or
///         storage effect. Every call below carries an invalid signature and expired actions, so
///         a later check would surface as a different error; the access recorder shows the
///         ceremony header is the only slot touched and nothing is written.
contract CouncilUnknownCeremonyTest is CouncilTestBase {
    bytes12 internal constant NOPE = bytes12(uint96(0xdeadbeef));
    bytes internal garbage = new bytes(65);

    function setUp() public override {
        super.setUp();
        // a real ceremony with a live request exists alongside, so lookups are not trivially empty
        _toLive(2, 2);
        _bindAndRequest(bytes31(uint248(1)), _u64s(1, 2, 3));
        validUntil = uint64(block.timestamp) - 1;
    }

    function _assertUnknown(bool ok, bytes memory err) internal {
        assertFalse(ok, "call succeeded");
        assertEq(bytes4(err), UnknownCeremony.selector, "not UnknownCeremony");
        (bytes32[] memory reads, bytes32[] memory writes) = vm.accesses(address(manager));
        assertEq(writes.length, 0, "storage written");
        assertEq(reads.length, 1, "more than the existence read");
        vm.record();
    }

    function _call(bytes memory data) internal {
        (bool ok, bytes memory err) = address(manager).call(data);
        _assertUnknown(ok, err);
    }

    function test_Unknown_AllStateChangingCalls() public {
        vm.record();
        for (uint256 i; i < 2; ++i) {
            bytes12 c = i == 0 ? NOPE : bytes12(0);
            address[] memory keys = new address[](1);
            keys[0] = address(1);
            _call(abi.encodeCall(manager.addInvites, (AddInvites(c, 0, keys, validUntil), garbage)));
            _call(abi.encodeCall(manager.closeRegistration, (CloseRegistration(c, 1, validUntil), garbage)));
            _call(
                abi.encodeCall(
                    manager.join,
                    (
                        Join(c, address(1), 0, 1, 2, 3, 4, 5, validUntil),
                        garbage,
                        Invite(c, 0, address(1), 1, 2, validUntil),
                        garbage
                    )
                )
            );
            uint256[2][16] memory C;
            uint256[2] memory E;
            uint256[16] memory masked;
            _call(
                abi.encodeCall(
                    manager.deal, (Deal(c, 1, bytes32(0), validUntil), garbage, C, E, masked, _pA(), _pB(), _pC())
                )
            );
            _call(abi.encodeCall(manager.finalize, (c)));
            _call(abi.encodeCall(manager.abort, (c)));
            _call(abi.encodeCall(manager.allowAdapter, (AllowAdapter(c, address(1), validUntil), garbage)));
            _call(abi.encodeCall(manager.authorizeCreator, (AuthorizeCreator(c, address(1), validUntil), garbage)));
            // as an adapter allowed elsewhere, and as a stranger
            vm.prank(address(adapter));
            _call(abi.encodeCall(manager.bindProcess, (c, pid, creator)));
            _call(abi.encodeCall(manager.bindProcess, (c, pid, creator)));
            uint256[4][] memory reqCts = new uint256[4][](1);
            vm.prank(address(adapter));
            _call(abi.encodeCall(manager.submitRequest, (c, pid, reqCts)));
            // a partial naming an unknown ceremony with a real request id
            _call(
                abi.encodeCall(
                    manager.submitPartial,
                    (Partial(c, requestId, 1, bytes32(0), validUntil), garbage, C, _pA(), _pB(), _pC())
                )
            );
        }
    }

    function test_Unknown_Views() public {
        vm.expectRevert(UnknownCeremony.selector);
        manager.getCeremony(NOPE);
        vm.expectRevert(UnknownCeremony.selector);
        manager.getInvite(NOPE, 0);
        vm.expectRevert(UnknownCeremony.selector);
        manager.getParticipant(NOPE, 1);
        vm.expectRevert(UnknownCeremony.selector);
        manager.participantIndexOf(NOPE, address(1));
        vm.expectRevert(UnknownCeremony.selector);
        manager.getDealing(NOPE, 1);
        vm.expectRevert(UnknownCeremony.selector);
        manager.getQual(NOPE);
        vm.expectRevert(UnknownCeremony.selector);
        manager.getPublicKey(NOPE);
        vm.expectRevert(UnknownCeremony.selector);
        manager.getMemberKey(NOPE, 1);
        vm.expectRevert(UnknownCeremony.selector);
        manager.getAggregates(NOPE);
        vm.expectRevert(UnknownCeremony.selector);
        manager.isAdapterAllowed(NOPE, address(adapter));
        vm.expectRevert(UnknownCeremony.selector);
        manager.isCreatorAuthorized(NOPE, creator);
        vm.expectRevert(UnknownCeremony.selector);
        manager.getRequestIds(NOPE);
    }

    function test_Unknown_RequestIds() public {
        bytes32 nope = keccak256("nope");
        uint8[] memory set = _range(1, 2);
        vm.expectRevert(UnknownRequest.selector);
        manager.combine(nope, set, _range(0, 1), new uint64[](1));
        vm.expectRevert(UnknownRequest.selector);
        manager.getRequest(nope);
        vm.expectRevert(UnknownRequest.selector);
        manager.getRequestOrigin(nope);
        vm.expectRevert(UnknownRequest.selector);
        manager.getPartial(nope, 1);
        vm.expectRevert(UnknownRequest.selector);
        manager.getPlaintexts(nope);
    }
}
