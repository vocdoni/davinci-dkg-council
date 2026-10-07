// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {MockCouncilAdapter} from "./mocks/MockCouncilAdapter.sol";
import {ScheduleFixture} from "./CouncilSchedule.t.sol";

/// @notice The DAVINCI seam at the manager boundary (architecture §3.1 "The decryption gate",
///         protocol §8.7, §9.2). The test contract plays the ProcessRegistry of the
///         MockCouncilAdapter; `registryRequestResults` / `registryFinalize` model the two
///         registry paths for a COUNCIL process: identity accumulator fields are skipped
///         (`zeroSkipped`), half-identity fields are refused, the process is ENDED before the
///         adapter is called, an all-zero accumulator publishes (all-zero) results only once
///         `isDecryptionOpen` holds — never by consulting the manager otherwise — and the nonzero
///         path requires the gate and `ready` plaintexts.
contract CouncilDavinciBoundaryTest is ScheduleFixture {
    error HalfIdentityField();
    error ResultsNotReady();

    enum Status {
        None,
        Ended,
        Results
    }

    struct Proc {
        Status status;
        bytes32 requestId;
        uint256 fields; // accumulator fields
        uint256 skipped; // bit k: field k was identity and skipped (all-zero result)
        uint256[] results;
    }

    mapping(bytes31 => Proc) internal procs;

    // ─── Registry model ──────────────────────────────────────────────────────────────────

    function _isIdentity(uint256 x, uint256 y) internal pure returns (bool) {
        return x == 0 && y == 1;
    }

    /// @dev requestResultsDecryption for a COUNCIL process bound to `cid`: returns whether the
    ///      results were finalized right away (only the all-zero path, and only behind the gate).
    function registryRequestResults(bytes31 p, uint256[4][] memory acc) external returns (bool finalized) {
        Proc storage pr = procs[p];
        uint256[4][] memory sent = new uint256[4][](acc.length);
        uint256 m;
        for (uint256 k; k < acc.length; ++k) {
            bool id1 = _isIdentity(acc[k][0], acc[k][1]);
            bool id2 = _isIdentity(acc[k][2], acc[k][3]);
            if (id1 != id2) revert HalfIdentityField();
            if (id1) pr.skipped |= 1 << k;
            else sent[m++] = acc[k];
        }
        pr.fields = acc.length;
        pr.status = Status.Ended; // ending a vote is always legitimate, gate or not
        if (m == 0) {
            // the all-zero fast path never involves the manager, only its gate
            if (!adapter.isDecryptionOpen(cid)) return false;
            _publish(pr, new uint256[](0));
            return true;
        }
        assembly ("memory-safe") {
            mstore(sent, m)
        }
        adapter.submit(cid, pr.requestId, sent);
    }

    /// @dev finalizeResultsFromDKG for a COUNCIL process: the gate on both paths, then `ready`.
    function registryFinalize(bytes31 p) external returns (uint256[] memory) {
        Proc storage pr = procs[p];
        if (!adapter.isDecryptionOpen(cid)) revert DecryptionNotOpen();
        uint256 sentCount;
        for (uint256 k; k < pr.fields; ++k) {
            if ((pr.skipped >> k) & 1 == 0) ++sentCount;
        }
        uint256[] memory values;
        if (sentCount != 0) {
            bool ready;
            (ready, values) = adapter.plaintexts(cid, pr.requestId, 0, uint16(sentCount));
            if (!ready) revert ResultsNotReady();
        }
        _publish(pr, values);
        return pr.results;
    }

    function _publish(Proc storage pr, uint256[] memory values) internal {
        delete pr.results;
        uint256 next;
        for (uint256 k; k < pr.fields; ++k) {
            pr.results.push((pr.skipped >> k) & 1 == 1 ? 0 : values[next++]);
        }
        pr.status = Status.Results;
    }

    /// @dev Binds process `p` through the adapter (the registry passing the creator through).
    function _bindProcess(bytes31 p) internal {
        if (!manager.isAdapterAllowed(cid, address(adapter))) _allow(address(adapter));
        if (!manager.isCreatorAuthorized(cid, creator)) _authorize(creator);
        pid = p;
        (, requestId,,) = adapter.register(p, creator, cid);
        procs[p].requestId = requestId;
    }

    function _identityAcc(uint256 fields) internal pure returns (uint256[4][] memory acc) {
        acc = new uint256[4][](fields);
        for (uint256 k; k < fields; ++k) {
            acc[k] = [uint256(0), 1, 0, 1];
        }
    }

    function _ctsMem() internal view returns (uint256[4][] memory c) {
        c = new uint256[4][](cts.length);
        for (uint256 k; k < cts.length; ++k) {
            c[k] = cts[k];
        }
    }

    function _assertNoRequest(bytes31 p) internal view {
        (,, bool requested) = manager.getBinding(address(adapter), p);
        assertFalse(requested, "the manager holds a request");
        (, uint8 fieldCount,,) = manager.getRequestMeta(procs[p].requestId);
        assertEq(fieldCount, 0);
    }

    // ─── The adapter's gate is the manager's gate ────────────────────────────────────────

    function _assertProxy(bool want, string memory what) internal view {
        assertEq(adapter.isDecryptionOpen(cid), want, what);
        assertEq(manager.isDecryptionOpen(cid), want, string.concat(what, " (manager)"));
    }

    function test_AdapterGate_ProxiesTheManager_Scheduled() public {
        uint64 openAt = _now() + 10 days;
        _liveWithDecryption(SCHEDULED, openAt, 0, 1, 1);
        _assertProxy(false, "after finalize");
        vm.warp(openAt - 1);
        _assertProxy(false, "openAt - 1");
        vm.warp(openAt);
        _assertProxy(true, "openAt");
        vm.warp(openAt + 1);
        _assertProxy(true, "openAt + 1");
        vm.warp(openAt + 3650 days);
        _assertProxy(true, "years later: never back");
        vm.expectRevert(UnknownCeremony.selector);
        adapter.isDecryptionOpen(bytes12(uint96(0xdead)));
    }

    function test_AdapterGate_ProxiesTheManager_ManualFallback() public {
        uint64 fallbackAt = _now() + 10 days;
        _liveWithDecryption(MANUAL, 0, fallbackAt, 1, 1);
        vm.warp(fallbackAt - 1);
        _assertProxy(false, "fallback - 1");
        vm.warp(fallbackAt);
        _assertProxy(true, "fallback");
        vm.warp(fallbackAt + 3650 days);
        _assertProxy(true, "years later");
    }

    function test_AdapterGate_ProxiesTheManager_ManualOpened() public {
        _liveWithDecryption(MANUAL, 0, 0, 1, 1);
        vm.warp(_now() + 3650 days);
        _assertProxy(false, "no fallback: closed until the organizer acts");
        _open();
        _assertProxy(true, "opened");
        vm.warp(_now() + 1);
        _assertProxy(true, "after the opening");
    }

    // ─── All-zero accumulator: results wait for the gate ─────────────────────────────────

    /// @dev `opening` 0: Scheduled date; 1: Manual fallback date; 2: Manual organizer opening.
    function _zeroAccumulatorWaitsForTheGate(uint8 opening) internal {
        uint64 date = _now() + 10 days;
        if (opening == 0) _liveWithDecryption(SCHEDULED, date, 0, 2, 2);
        else if (opening == 1) _liveWithDecryption(MANUAL, 0, date, 2, 2);
        else _liveWithDecryption(MANUAL, 0, 0, 2, 2);
        bytes31 p = bytes31(uint248(0x2E70 + opening));
        _bindProcess(p);

        // the vote ends with an all-identity accumulator while the gate is closed
        vm.warp(date - 1);
        assertFalse(this.registryRequestResults(p, _identityAcc(4)), "finalized before the gate");
        assertEq(uint8(procs[p].status), uint8(Status.Ended), "recorded ENDED");
        assertEq(procs[p].results.length, 0, "no results");
        _assertNoRequest(p);
        vm.expectRevert(DecryptionNotOpen.selector);
        this.registryFinalize(p);

        if (opening == 2) _open();
        else vm.warp(date);
        uint256[] memory results = this.registryFinalize(p); // a later permissionless call
        assertEq(uint8(procs[p].status), uint8(Status.Results));
        assertEq(results.length, 4);
        for (uint256 k; k < 4; ++k) {
            assertEq(results[k], 0);
        }
        _assertNoRequest(p); // the manager was never asked for anything but its gate
    }

    function test_ZeroAccumulator_WaitsForTheGate_Scheduled() public {
        _zeroAccumulatorWaitsForTheGate(0);
    }

    function test_ZeroAccumulator_WaitsForTheGate_ManualFallback() public {
        _zeroAccumulatorWaitsForTheGate(1);
    }

    function test_ZeroAccumulator_WaitsForTheGate_ManualOpened() public {
        _zeroAccumulatorWaitsForTheGate(2);
    }

    /// @dev Once the gate is open, the all-zero fast path finalizes in the same call.
    function test_ZeroAccumulator_FastPathAfterTheGate() public {
        _liveWithDecryption(MANUAL, 0, 0, 2, 2);
        _open();
        bytes31 p = bytes31(uint248(0x2E7F));
        _bindProcess(p);
        assertTrue(this.registryRequestResults(p, _identityAcc(2)));
        assertEq(uint8(procs[p].status), uint8(Status.Results));
        assertEq(procs[p].results.length, 2);
        _assertNoRequest(p);
    }

    // ─── Identity fields never reach the manager ─────────────────────────────────────────

    function test_IdentityFields_RejectedAtSubmitRequest() public {
        _liveWithDecryption(MANUAL, 0, 0, 2, 2);
        bytes31 p = bytes31(uint248(0x1D));
        _bindProcess(p);
        _encrypt(_u64s(3, 4, 5));
        uint256[4][] memory acc = _ctsMem();

        // a zero (identity) field that a non-DAVINCI adapter failed to skip
        uint256[4][] memory bad = _ctsMem();
        bad[1] = [uint256(0), 1, 0, 1];
        vm.expectRevert(InvalidPoint.selector);
        adapter.submit(cid, requestId, bad);
        // half-identity fields, either half
        bad = _ctsMem();
        (bad[2][0], bad[2][1]) = (0, 1);
        vm.expectRevert(InvalidPoint.selector);
        adapter.submit(cid, requestId, bad);
        bad = _ctsMem();
        (bad[0][2], bad[0][3]) = (0, 1);
        vm.expectRevert(InvalidPoint.selector);
        adapter.submit(cid, requestId, bad);
        _assertNoRequest(p);

        // the registry refuses half-identity accumulator fields before the adapter
        bad = _ctsMem();
        (bad[2][0], bad[2][1]) = (0, 1);
        vm.expectRevert(HalfIdentityField.selector);
        this.registryRequestResults(p, bad);
        _assertNoRequest(p);

        // the well-formed accumulator is still admissible (failed attempts stored nothing)
        assertFalse(this.registryRequestResults(p, acc));
        (, uint8 fieldCount,,) = manager.getRequestMeta(requestId);
        assertEq(fieldCount, 3);
    }

    // ─── Nonzero accumulator: gated partials, legitimate zero plaintexts ─────────────────

    function test_NonzeroAccumulator_GatedThenCompletes_WithZeroPlaintexts() public {
        uint64 openAt = _now() + 10 days;
        _liveWithDecryption(SCHEDULED, openAt, 0, 3, 2);
        bytes31 p = bytes31(uint248(0x5C0));
        _bindProcess(p);
        uint64[] memory plain = new uint64[](4);
        (plain[0], plain[1], plain[2], plain[3]) = (5, 0, 9, 0);
        _encrypt(plain);
        // fields encrypting 0 are proper ciphertexts, not identity: nothing is skipped
        assertFalse(this.registryRequestResults(p, _ctsMem()), "nonzero path never finalizes at once");
        assertEq(uint8(procs[p].status), uint8(Status.Ended));
        (, uint8 fieldCount,,) = manager.getRequestMeta(requestId);
        assertEq(fieldCount, 4, "admitted before the gate");

        // closed gate: not ready, no partial, no combine, no registry finalization
        (bool ready, uint256[] memory values) = adapter.plaintexts(cid, requestId, 0, 4);
        assertFalse(ready);
        assertEq(values.length, 4);
        PartialCall memory p1 = _partialMsg(1);
        _outcome(_partialCall(p1), DecryptionNotOpen.selector, "partial before the gate");
        uint8[] memory set = new uint8[](2);
        (set[0], set[1]) = (1, 3);
        _outcome(
            abi.encodeCall(
                manager.combine, (requestId, set, _range(0, 1), _plain(_range(0, 1)), _vectors(set), _c2(_range(0, 1)))
            ),
            DecryptionNotOpen.selector,
            "combine before the gate"
        );
        vm.expectRevert(DecryptionNotOpen.selector);
        this.registryFinalize(p);

        vm.warp(openAt);
        vm.expectRevert(ResultsNotReady.selector);
        this.registryFinalize(p);
        _sendPartial(p1);
        _partial(3);
        uint8[] memory first = new uint8[](2);
        (first[0], first[1]) = (0, 2);
        _combine(set, first);
        (,, uint16 completed,) = manager.getRequestMeta(requestId);
        assertEq(completed, 0x5);
        (ready, values) = adapter.plaintexts(cid, requestId, 0, 4);
        assertFalse(ready, "a partial result vector is never ready");
        assertEq(values[0], 5);
        assertEq(values[1], 0, "uncompleted reads 0 ...");
        assertEq((completed >> 1) & 1, 0, "... but the bitmap says uncompleted");
        vm.expectRevert(ResultsNotReady.selector);
        this.registryFinalize(p);

        uint8[] memory zeros = new uint8[](2);
        (zeros[0], zeros[1]) = (1, 3);
        _combine(set, zeros); // plaintext 0 is a legitimate combined value
        (,, completed,) = manager.getRequestMeta(requestId);
        assertEq(completed, 0xf);
        (ready, values) = adapter.plaintexts(cid, requestId, 0, 4);
        assertTrue(ready);
        uint256[] memory results = this.registryFinalize(p);
        assertEq(results.length, 4);
        assertEq(results[0], 5);
        assertEq(results[1], 0);
        assertEq(results[2], 9);
        assertEq(results[3], 0);
    }

    /// @dev Identity fields are skipped by the registry and only the others reach the manager;
    ///      the mapping back gives zero for the skipped fields, after the gate only.
    function test_MixedAccumulator_SkipsZeroFields() public {
        uint64 fallbackAt = _now() + 10 days;
        _liveWithDecryption(MANUAL, 0, fallbackAt, 2, 2);
        bytes31 p = bytes31(uint248(0x313));
        _bindProcess(p);
        uint64[] memory plain = new uint64[](1);
        plain[0] = 7;
        _encrypt(plain);
        uint256[4][] memory acc = _identityAcc(3);
        acc[1] = cts[0];
        assertFalse(this.registryRequestResults(p, acc));
        (, uint8 fieldCount,,) = manager.getRequestMeta(requestId);
        assertEq(fieldCount, 1, "only the nonzero field reaches the manager");
        vm.expectRevert(DecryptionNotOpen.selector);
        this.registryFinalize(p);

        vm.warp(fallbackAt);
        _partial(1);
        _partial(2);
        _combine(_range(1, 2), _range(0, 1));
        uint256[] memory results = this.registryFinalize(p);
        assertEq(results.length, 3);
        assertEq(results[0], 0);
        assertEq(results[1], 7);
        assertEq(results[2], 0);
    }

    /// @dev The adapter serves only the full range of the request, before and after the gate.
    function test_AdapterPlaintextsRange_AroundTheGate() public {
        _liveWithDecryption(MANUAL, 0, 0, 2, 2);
        bytes31 p = bytes31(uint248(0xA6));
        _bindProcess(p);
        _encrypt(_u64s(1, 2, 3));
        this.registryRequestResults(p, _ctsMem());
        for (uint256 round; round < 2; ++round) {
            vm.expectRevert(MockCouncilAdapter.BadRange.selector);
            adapter.plaintexts(cid, requestId, 1, 2);
            vm.expectRevert(MockCouncilAdapter.BadRange.selector);
            adapter.plaintexts(cid, requestId, 0, 2);
            vm.expectRevert(MockCouncilAdapter.BadRange.selector);
            adapter.plaintexts(cid, requestId, 0, 4);
            vm.expectRevert(MockCouncilAdapter.BadRange.selector);
            adapter.plaintexts(bytes12(uint96(1)), requestId, 0, 3);
            (bool ready, uint256[] memory values) = adapter.plaintexts(cid, requestId, 0, 3);
            assertFalse(ready);
            assertEq(values.length, 3);
            if (round == 0) _open();
        }
        _partial(1);
        _partial(2);
        _combine(_range(1, 2), _range(0, 3));
        (bool done,) = adapter.plaintexts(cid, requestId, 0, 3);
        assertTrue(done);
    }
}
