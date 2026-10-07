// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {ICouncilCore} from "../src/interfaces/ICouncil.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";
import {Bjj} from "./utils/Bjj.sol";

/// @notice Full happy paths: create -> invites -> joins -> close -> deals -> finalize -> allow
///         adapter/creator -> bind via the adapter -> request -> partials -> combine -> plaintexts.
contract CouncilLifecycleTest is CouncilTestBase {
    function _assertKeys(uint8 n) internal view {
        // P = (Σ_{j in QUAL} a_{j,0})·G and PK_m = s_m·G for every member.
        uint256 s0;
        for (uint256 j = 1; j <= 16; ++j) {
            if ((qualBits >> (j - 1)) & 1 != 0) s0 = addmod(s0, coef[j][0], R);
        }
        (uint256 gx, uint256 gy) = Bjj.mulG(s0);
        (uint256 px, uint256 py) = manager.getPublicKey(cid);
        assertEq(px, gx, "P.x");
        assertEq(py, gy, "P.y");
        assertTrue(Bjj.onCurveTE(px, py), "P on TE curve");
        uint256[2][16] memory A = manager.getAggregates(cid);
        assertEq(A[0][0], px);
        assertEq(A[0][1], py);
        for (uint256 k = T; k < 16; ++k) {
            assertEq(A[k][0], 0);
            assertEq(A[k][1], 1);
        }
        for (uint8 m = 1; m <= n; ++m) {
            (uint256 ex, uint256 ey) = Bjj.mulG(_share(m));
            (uint256 kx, uint256 ky) = manager.getMemberKey(cid, m);
            assertEq(kx, ex, "PK_m.x");
            assertEq(ky, ey, "PK_m.y");
        }
    }

    function test_HappyPath_n5_t3() public {
        _toLive(5, 3);
        CeremonyView memory v = manager.getCeremony(cid);
        assertEq(v.phase, uint8(Phase.Live));
        assertEq(v.n, 5);
        assertEq(v.threshold, 3);
        assertEq(v.joinedCount, 5);
        assertEq(v.dealtCount, 5);
        assertEq(v.qualBitmap, 0x1f);
        assertEq(manager.getQual(cid), 0x1f);
        assertEq(v.inviteCount, 5);
        assertEq(v.consumedInvites, 0x1f);
        assertEq(v.organizer, organizer);
        assertEq(v.dealingDeadline, T0 + DEAL_DURATION);
        _assertKeys(5);

        bytes31 p = bytes31(keccak256("process-1"));
        _bindAndRequest(p, _u64s(7, 0, uint64(1 << 40) - 1));
        (bytes12 bcid, bytes32 brid, bool requested) = manager.getBinding(address(adapter), p);
        assertEq(bcid, cid);
        assertEq(brid, requestId);
        assertTrue(requested);
        assertEq(
            requestId,
            keccak256(abi.encode(TAG_REQUEST, block.chainid, address(manager), cid, address(adapter), p)),
            "requestId"
        );
        assertEq(manager.getRequestCount(cid), 1);
        bytes32[] memory ids = manager.getRequestIdsPage(cid, 0, 10);
        assertEq(ids.length, 1);
        assertEq(ids[0], requestId);
        (address oAdapter, bytes31 oPid, address oCreator) = manager.getRequestOrigin(requestId);
        assertEq(oAdapter, address(adapter));
        assertEq(oPid, p);
        assertEq(oCreator, creator);

        _partial(1);
        _partial(3);
        _partial(5);
        (,, uint16 completed, uint16 partials) = manager.getRequestMeta(requestId);
        assertEq(completed, 0);
        assertEq(partials, 0x15);
        uint256[2][] memory stored = manager.getRequestCompressed(requestId);
        assertEq(stored.length, 3);
        assertEq(stored[2][0], _compress(cts[2][0], cts[2][1]));
        assertEq(stored[2][1], _compress(cts[2][2], cts[2][3]));

        (bool ready,) = adapter.plaintexts(cid, requestId, 0, 3);
        assertFalse(ready);

        uint8[] memory set = new uint8[](3);
        set[0] = 1;
        set[1] = 3;
        set[2] = 5;
        vm.expectEmit(address(manager));
        emit ICouncilCore.RequestCompleted(requestId);
        _combine(set, _range(0, 3));

        uint256[] memory values;
        (ready, values) = adapter.plaintexts(cid, requestId, 0, 3);
        assertTrue(ready);
        assertEq(values.length, 3);
        assertEq(values[0], 7);
        assertEq(values[1], 0);
        assertEq(values[2], (1 << 40) - 1);
    }

    function test_HappyPath_n16_t16_16fields() public {
        _toLive(16, 16);
        assertEq(manager.getQual(cid), 0xffff);
        _assertKeys(16);
        uint64[] memory plain = new uint64[](16);
        for (uint256 k; k < 16; ++k) {
            plain[k] = uint64(k * 1001 + 3);
        }
        _bindAndRequest(bytes31(keccak256("process-16")), plain);
        for (uint256 i = 1; i <= 16; ++i) {
            _partial(i);
        }
        uint8[] memory set = _range(1, 16);
        for (uint256 chunk; chunk < 4; ++chunk) {
            (bool r0,) = manager.getPlaintexts(requestId);
            assertFalse(r0);
            _combine(set, _range(chunk * 4, 4));
        }
        (bool ready, uint256[] memory values) = adapter.plaintexts(cid, requestId, 0, 16);
        assertTrue(ready);
        for (uint256 k; k < 16; ++k) {
            assertEq(values[k], plain[k]);
        }
    }

    /// @dev QUAL ⊂ members: finalize waits for the deadline, a non-dealer still decrypts.
    function test_PartialQual_NonDealerDecrypts() public {
        _create(2, 4);
        for (uint256 i = 1; i <= 4; ++i) {
            _join(i);
        }
        _close();
        _deal(1);
        _deal(3);
        vm.expectRevert(FinalizeConditionNotMet.selector);
        manager.finalize(cid);
        vm.warp(T0 + DEAL_DURATION + 1);
        manager.finalize(cid);
        assertEq(manager.getQual(cid), 0x5);
        _assertKeys(4);
        _open();

        // a member that never dealt still holds a share of every accepted dealing
        _bindAndRequest(bytes31(uint248(42)), _u64s(11, 22, 33));
        _partial(2);
        _partial(4);
        uint8[] memory set = new uint8[](2);
        set[0] = 2;
        set[1] = 4;
        _combine(set, _range(0, 3));
        (bool ready, uint256[] memory values) = manager.getPlaintexts(requestId);
        assertTrue(ready);
        assertEq(values[0], 11);
        assertEq(values[1], 22);
        assertEq(values[2], 33);
    }

    /// @dev Chunks may use different member sets; completion only once every field is combined.
    function test_CombineChunksWithDifferentMemberSets() public {
        _toLive(5, 3);
        uint64[] memory plain = new uint64[](6);
        for (uint256 k; k < 6; ++k) {
            plain[k] = uint64(100 + k);
        }
        _bindAndRequest(bytes31(uint248(7)), plain);
        for (uint256 i = 1; i <= 5; ++i) {
            _partial(i);
        }
        uint8[] memory setA = new uint8[](3);
        (setA[0], setA[1], setA[2]) = (1, 2, 3);
        uint8[] memory setB = new uint8[](3);
        (setB[0], setB[1], setB[2]) = (2, 4, 5);

        uint8[] memory first = new uint8[](2);
        (first[0], first[1]) = (1, 4);
        _combine(setA, first);
        (,, uint16 completed,) = manager.getRequestMeta(requestId);
        assertEq(completed, 0x12);
        (bool ready,) = manager.getPlaintexts(requestId);
        assertFalse(ready);

        uint8[] memory rest = new uint8[](4);
        (rest[0], rest[1], rest[2], rest[3]) = (0, 2, 3, 5);
        _combine(setB, rest);
        uint256[] memory values;
        (ready, values) = manager.getPlaintexts(requestId);
        assertTrue(ready);
        for (uint256 k; k < 6; ++k) {
            assertEq(values[k], 100 + k);
        }
    }

    /// @dev Several processes bound to one ceremony through one adapter, each with its own request.
    function test_TwoProcessesOneCeremony() public {
        _toLive(3, 2);
        _bindAndRequest(bytes31(uint248(1)), _u64s(1, 2, 3));
        bytes32 first = requestId;
        _partial(1);
        _partial(2);
        _bindAndRequest(bytes31(uint248(2)), _u64s(4, 5, 6));
        assertTrue(first != requestId);
        _partial(2);
        _partial(3);
        uint8[] memory set = new uint8[](2);
        (set[0], set[1]) = (2, 3);
        _combine(set, _range(0, 3));
        (bool ready, uint256[] memory values) = manager.getPlaintexts(requestId);
        assertTrue(ready);
        assertEq(values[0], 4);
        (ready,) = manager.getPlaintexts(first);
        assertFalse(ready);
        assertEq(manager.getRequestCount(cid), 2);
        assertEq(manager.getRequestIdsPage(cid, 0, 2)[0], first);
    }

    /// @dev Months-later recovery reads every byte back from current storage (protocol §8.6):
    ///      compressed roster and ephemerals, masked shares, QUAL; never the commitments.
    function test_RecoveryViews() public {
        _create(2, 4);
        for (uint256 i = 1; i <= 3; ++i) {
            _join(i);
        }
        _close();
        DealCall memory d = _dealMsg(2);
        _sendDeal(d);
        qualBits |= 2;
        (uint256 wordE, uint256[16] memory masked) = manager.getRecoveryDealing(cid, 2);
        assertEq(wordE, _compress(d.E[0], d.E[1]));
        for (uint256 k; k < 16; ++k) {
            assertEq(masked[k], d.masked[k]);
        }
        vm.expectRevert(NotQualified.selector);
        manager.getRecoveryDealing(cid, 1);

        // one call per member: every dealer's E and that member's masked share, zero off QUAL
        (uint16 qual, uint256[16] memory es, uint256[16] memory ms) = manager.getRecoverySlice(cid, 3);
        assertEq(qual, 2);
        for (uint256 j; j < 16; ++j) {
            assertEq(es[j], j == 1 ? wordE : 0);
            assertEq(ms[j], j == 1 ? d.masked[2] : 0);
        }
        vm.expectRevert(NotQualified.selector);
        manager.getRecoverySlice(cid, 4); // n = 3
        vm.expectRevert(NotQualified.selector);
        manager.getRecoverySlice(cid, 0);

        (address auth, uint256 word, bool dealt) = manager.getParticipantCompressed(cid, 2);
        assertEq(auth, vm.addr(authSecrets[1]));
        (uint256 ex, uint256 ey) = Bjj.mulG(shareSecrets[1]);
        assertEq(word, _compress(ex, ey));
        assertTrue(dealt);
        (,, dealt) = manager.getParticipantCompressed(cid, 1);
        assertFalse(dealt);
        assertEq(manager.participantIndexOf(cid, auth), 2);
        assertEq(manager.participantIndexOf(cid, address(0xdead)), 0);

        (address key, bool consumed) = manager.getInvite(cid, 3);
        assertEq(key, vm.addr(inviteSecrets[3]));
        assertFalse(consumed);
        (, consumed) = manager.getInvite(cid, 0);
        assertTrue(consumed);
        vm.expectRevert(UnknownInvite.selector);
        manager.getInvite(cid, 4);

        // roster hash and ctx exactly as protocol §4.3, over the full TE keys
        CeremonyView memory v = manager.getCeremony(cid);
        address[] memory auths = new address[](3);
        uint256[] memory xs = new uint256[](3);
        uint256[] memory ys = new uint256[](3);
        for (uint256 i; i < 3; ++i) {
            (auths[i],,) = manager.getParticipantCompressed(cid, uint8(i + 1));
            (xs[i], ys[i]) = (memberX[i][0], memberX[i][1]);
        }
        bytes32 roster =
            keccak256(abi.encode(TAG_ROSTER, block.chainid, address(manager), cid, uint8(2), uint8(3), auths, xs, ys));
        assertEq(v.rosterHash, roster);
        assertEq(
            v.ctx, keccak256(abi.encode(TAG_DEAL_CONTEXT, block.chainid, address(manager), cid, roster, RELEASE_ID))
        );
    }

    function test_Immutables() public view {
        assertEq(manager.protocolVersion(), 2);
        assertEq(manager.dealVerifier(), address(dealV));
        assertEq(manager.partialVerifier(), address(partialV));
        assertEq(manager.circuitReleaseId(), RELEASE_ID);
        assertEq(
            manager.ceremonyIdFor(organizer, 5),
            bytes12(keccak256(abi.encode(TAG_CEREMONY, block.chainid, address(manager), organizer, uint64(5))))
        );
    }
}
