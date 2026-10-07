// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {ICouncilCore} from "../src/interfaces/ICouncil.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";

/// @notice Helpers shared by the scheduling, schedule-vector and DAVINCI-boundary tests: calls
///         sent through a low-level `call` so an outcome (success or the exact custom error) can
///         be asserted without reverting the test, and builders for Live ceremonies under a given
///         phase policy. Signed actions never expire here (`validUntil = 2^64 - 1`).
abstract contract ScheduleFixture is CouncilTestBase {
    address internal constant STRANGER = address(0x5742A6E5);
    bytes4 internal constant OK = bytes4(0);

    function setUp() public virtual override {
        super.setUp();
        validUntil = type(uint64).max;
    }

    /// @dev The block clock (never a cached `block.timestamp` read, see CouncilTestBase).
    function _now() internal view returns (uint64) {
        return uint64(vm.getBlockTimestamp());
    }

    function _try(bytes memory data) internal returns (bool ok, bytes4 err) {
        bytes memory ret;
        (ok, ret) = address(manager).call(data);
        if (!ok) err = bytes4(ret);
    }

    /// @dev `want == OK`: the call succeeds; else it reverts with exactly `want`.
    function _outcome(bytes memory data, bytes4 want, string memory what) internal {
        (bool ok, bytes4 err) = _try(data);
        if (want == OK) {
            assertTrue(ok, string.concat(what, ": reverted"));
        } else {
            assertFalse(ok, string.concat(what, ": succeeded"));
            assertEq(err, want, what);
        }
    }

    /// @dev Like `_outcome` with the state rolled back afterwards (clock included).
    function _probe(bytes memory data, bytes4 want, string memory what) internal {
        uint64 at = _now();
        uint256 snap = vm.snapshotState();
        _outcome(data, want, what);
        vm.revertToState(snap);
        vm.warp(at);
    }

    /// @dev Whether `data` would succeed now; state rolled back.
    function _would(bytes memory data) internal returns (bool ok) {
        uint64 at = _now();
        uint256 snap = vm.snapshotState();
        (ok,) = _try(data);
        vm.revertToState(snap);
        vm.warp(at);
    }

    // ─── Call encoders ───────────────────────────────────────────────────────────────────

    /// @dev Member `i` joining with invite `i - 1`.
    function _joinCall(uint256 i) internal view returns (bytes memory) {
        JoinCall memory j = _joinMsg(i, uint32(i - 1), _memberAuth(i), _memberShareKey(i));
        return abi.encodeCall(manager.join, (j.a, j.psig, j.inv, j.isig));
    }

    function _closeCall() internal view returns (bytes memory) {
        (CloseRegistration memory a, bytes memory sig) = _closeMsg(uint8(memberX.length));
        return abi.encodeCall(manager.closeRegistration, (a, sig, _roster()));
    }

    function _closeScheduledCall() internal view returns (bytes memory) {
        return abi.encodeCall(manager.closeRegistrationScheduled, (cid, _roster()));
    }

    function _abortCall() internal view returns (bytes memory) {
        return abi.encodeCall(manager.abort, (cid));
    }

    function _openCall() internal view returns (bytes memory) {
        (OpenDecryption memory a, bytes memory sig) = _openMsg();
        return abi.encodeCall(manager.openDecryption, (a, sig));
    }

    function _finalizeCall() internal view returns (bytes memory) {
        return abi.encodeCall(manager.finalize, (cid));
    }

    function _dealCall(uint256 j) internal returns (bytes memory) {
        DealCall memory d = _dealMsg(j);
        return abi.encodeCall(manager.deal, (d.a, d.sig, d.C, d.E, d.masked, _pA(), _pB(), _pC(), _roster()));
    }

    function _partialCall(PartialCall memory p) internal view returns (bytes memory) {
        return abi.encodeCall(manager.submitPartial, (p.a, p.sig, p.D, _pA(), _pB(), _pC(), _c1()));
    }

    // ─── Builders ────────────────────────────────────────────────────────────────────────

    function _joinAll(uint256 n) internal {
        for (uint256 i = 1; i <= n; ++i) {
            _join(i);
        }
    }

    function _dealAll(uint256 n) internal {
        for (uint256 j = 1; j <= n; ++j) {
            _deal(j);
        }
    }

    /// @dev A Live ceremony with Manual registration without expiry (so any future decryption
    ///      date is valid at creation) and the given decryption policy; the gate is not touched.
    function _liveWithDecryption(uint8 decMode, uint64 openAt, uint64 fallbackAt, uint8 n, uint8 t) internal {
        _usePolicy(MANUAL, 0, DEAL_DURATION, decMode, openAt, fallbackAt);
        _create(t, n);
        _joinAll(n);
        _close();
        _dealAll(n);
        manager.finalize(cid);
        assertEq(manager.getCeremony(cid).phase, uint8(Phase.Live));
    }

    function _policy() internal view returns (PhasePolicyView memory) {
        return manager.getPolicy(cid);
    }

    function _assertGate(bool want, string memory what) internal view {
        assertEq(manager.isDecryptionOpen(cid), want, what);
        assertEq(_policy().decryptionOpen, want, string.concat(what, " (getPolicy)"));
    }
}

/// @notice The v2 phase policies (protocol §8.1–§8.4, §8.7, architecture §7 "Scheduling matrix"):
///         all four mode combinations end to end, every timestamp boundary at T−1 / T / T+1, the
///         irreversible decryption gate and its enforcement on partials, combine and
///         re-publication, and the create-time policy validation.
contract CouncilScheduleTest is ScheduleFixture {
    uint64 internal constant RD = T0 + REG_PERIOD; // registration deadline
    uint64 internal constant D = DEAL_DURATION;

    // ─── Four mode combinations, end to end ──────────────────────────────────────────────

    function _endToEnd(uint8 regMode, uint8 decMode) internal {
        uint64 openAt = decMode == SCHEDULED ? RD + D + 100 : 0;
        uint64 fallbackAt = decMode == MANUAL ? RD + D + 1000 : 0;
        _usePolicy(regMode, RD, D, decMode, openAt, fallbackAt);
        _create(2, 3);
        _joinAll(3);
        if (regMode == MANUAL) {
            _close(); // the organizer, before the expiry
            assertEq(manager.getCeremony(cid).dealingDeadline, T0 + D, "manual: now + D");
        } else {
            vm.warp(RD);
            vm.prank(STRANGER);
            _closeScheduled(); // anyone, at the scheduled time
            assertEq(manager.getCeremony(cid).dealingDeadline, RD + D, "scheduled: RD + D");
        }
        _dealAll(3);
        manager.finalize(cid);
        _bindAndRequest(bytes31(uint248(1 + 2 * regMode + decMode)), _u64s(11, 0, 33));

        // the request is admitted while the gate is closed; partials are not
        _assertGate(false, "gate before opening");
        PartialCall memory p = _partialMsg(1);
        _outcome(_partialCall(p), DecryptionNotOpen.selector, "partial before opening");
        if (decMode == SCHEDULED) {
            vm.warp(openAt);
        } else {
            _open();
            assertEq(_policy().manualOpenedAt, _now());
        }
        _assertGate(true, "gate after opening");
        _sendPartial(p);
        _partial(3);
        uint8[] memory set = new uint8[](2);
        (set[0], set[1]) = (1, 3);
        _combine(set, _range(0, 3));
        (bool ready, uint256[] memory values) = manager.getPlaintexts(requestId);
        assertTrue(ready);
        assertEq(values[0], 11);
        assertEq(values[1], 0);
        assertEq(values[2], 33);
    }

    function test_EndToEnd_ManualRegistration_ManualDecryption() public {
        _endToEnd(MANUAL, MANUAL);
    }

    function test_EndToEnd_ManualRegistration_ScheduledDecryption() public {
        _endToEnd(MANUAL, SCHEDULED);
    }

    function test_EndToEnd_ScheduledRegistration_ManualDecryption() public {
        _endToEnd(SCHEDULED, MANUAL);
    }

    function test_EndToEnd_ScheduledRegistration_ScheduledDecryption() public {
        _endToEnd(SCHEDULED, SCHEDULED);
    }

    // ─── Registration boundaries ─────────────────────────────────────────────────────────

    /// @dev Joining is half-open in both modes: open at RD − 1, RegistrationEnded at RD and after.
    function test_Join_HalfOpenAtTheDeadline() public {
        for (uint8 mode; mode <= SCHEDULED; ++mode) {
            vm.warp(T0);
            _usePolicy(mode, RD, D, MANUAL, 0, 0);
            _create(2, 4);
            vm.warp(RD - 1);
            _join(1);
            vm.warp(RD);
            _outcome(_joinCall(2), RegistrationEnded.selector, "join at RD");
            vm.warp(RD + 1);
            _outcome(_joinCall(2), RegistrationEnded.selector, "join at RD + 1");
            assertEq(manager.getCeremony(cid).joinedCount, 1);
        }
    }

    /// @dev The organizer closes a Manual registration strictly before its expiry; from the
    ///      expiry on the time-based close owns the transition.
    function test_OrganizerClose_StrictlyBeforeTheManualExpiry() public {
        _usePolicy(MANUAL, RD, D, MANUAL, 0, 0);
        _create(2, 3);
        _joinAll(2);
        vm.warp(RD - 1);
        _probe(_closeCall(), OK, "organizer close at RD - 1");
        _probe(_closeScheduledCall(), RegistrationNotDue.selector, "time-based close at RD - 1");
        vm.warp(RD);
        _probe(_closeCall(), RegistrationEnded.selector, "organizer close at RD");
        _probe(_closeScheduledCall(), OK, "time-based close at RD");
        vm.warp(RD + 1);
        _probe(_closeCall(), RegistrationEnded.selector, "organizer close at RD + 1");
    }

    /// @dev The time-based close is due in [RD, RD + D], by anyone, and always sets the scheduled
    ///      dealing deadline RD + D however late the caller is.
    function test_TimeBasedClose_DueWindowAndFixedDealingDeadline() public {
        uint64[6] memory at = [RD - 1, RD, RD + 1, RD + D - 1, RD + D, RD + D + 1];
        bytes4[6] memory want = [RegistrationNotDue.selector, OK, OK, OK, OK, Expired.selector];
        for (uint8 mode; mode <= SCHEDULED; ++mode) {
            vm.warp(T0);
            _usePolicy(mode, RD, D, MANUAL, 0, 0);
            _create(2, 3);
            _joinAll(3);
            for (uint256 i; i < at.length; ++i) {
                vm.warp(at[i]);
                assertEq(_policy().scheduledRegistrationCloseDue, want[i] == OK, "close due");
                uint256 snap = vm.snapshotState();
                vm.prank(STRANGER);
                (bool ok, bytes4 err) = _try(_closeScheduledCall());
                if (want[i] == OK) {
                    assertTrue(ok, "time-based close");
                    CeremonyView memory v = manager.getCeremony(cid);
                    assertEq(v.phase, uint8(Phase.Dealing));
                    assertEq(v.n, 3);
                    assertEq(v.dealingDeadline, RD + D, "never now + D");
                    assertFalse(_policy().scheduledRegistrationCloseDue, "no longer due");
                } else {
                    assertFalse(ok);
                    assertEq(err, want[i]);
                }
                vm.revertToState(snap);
            }
        }
    }

    /// @dev A close at the last second of the window creates a Dealing phase at its deadline: a
    ///      dealing that same second is accepted, the next second is too late and abort opens.
    function test_TimeBasedClose_AtWindowEnd_DealsOnlyThatSecond() public {
        _usePolicy(SCHEDULED, RD, D, MANUAL, 0, 0);
        _create(2, 3);
        _joinAll(3);
        vm.warp(RD + D);
        bytes32 rosterHash = _rosterHash();
        vm.expectEmit(address(manager));
        emit ICouncilCore.RegistrationClosed(cid, 3, rosterHash, RD + D);
        _closeScheduled();
        assertEq(manager.getCeremony(cid).dealingDeadline, _now());
        _deal(1);
        _probe(_abortCall(), AbortConditionNotMet.selector, "abort at the deadline");
        _probe(_finalizeCall(), FinalizeConditionNotMet.selector, "finalize at the deadline");
        vm.warp(RD + D + 1);
        _outcome(_dealCall(2), Expired.selector, "deal after the deadline");
        _probe(_finalizeCall(), FinalizeConditionNotMet.selector, "finalize below t");
        vm.expectEmit(address(manager));
        emit ICouncilCore.CeremonyAborted(cid, uint8(Phase.Dealing));
        manager.abort(cid);
    }

    function _rosterHash() internal view returns (bytes32) {
        uint256 n = memberX.length;
        address[] memory auths = new address[](n);
        uint256[] memory xs = new uint256[](n);
        uint256[] memory ys = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            auths[i] = vm.addr(authSecrets[i]);
            (xs[i], ys[i]) = (memberX[i][0], memberX[i][1]);
        }
        return keccak256(abi.encode(TAG_ROSTER, block.chainid, address(manager), cid, T, uint8(n), auths, xs, ys));
    }

    /// @dev Manual registration with an expiry: at the expiry it closes (permissionlessly) with
    ///      at least t members and is abortable below t.
    function test_ManualExpiry_ClosesWithQuorum_AbortsBelowIt() public {
        _usePolicy(MANUAL, RD, D, MANUAL, 0, 0);
        _create(2, 3);
        _joinAll(2);
        vm.warp(RD);
        assertTrue(_policy().scheduledRegistrationCloseDue);
        _probe(_abortCall(), AbortConditionNotMet.selector, "abort with quorum");
        vm.prank(STRANGER);
        _closeScheduled();
        assertEq(manager.getCeremony(cid).dealingDeadline, RD + D);

        vm.warp(T0);
        _create(2, 3);
        _join(1);
        vm.warp(RD - 1);
        _probe(_abortCall(), AbortConditionNotMet.selector, "abort before the expiry");
        vm.warp(RD);
        assertFalse(_policy().scheduledRegistrationCloseDue);
        _probe(_closeScheduledCall(), BelowThreshold.selector, "close below t");
        vm.expectEmit(address(manager));
        emit ICouncilCore.CeremonyAborted(cid, uint8(Phase.Registration));
        manager.abort(cid);
    }

    /// @dev Nobody closed within the window: the close is Expired and the ceremony is abortable
    ///      whatever the joined count; the schedule is never stretched.
    function test_MissedWindow_CloseExpiredAbortOnly() public {
        for (uint8 mode; mode <= SCHEDULED; ++mode) {
            vm.warp(T0);
            _usePolicy(mode, RD, D, MANUAL, 0, 0);
            _create(2, 3);
            _joinAll(3);
            vm.warp(RD + D);
            _probe(_abortCall(), AbortConditionNotMet.selector, "abort inside the window");
            vm.warp(RD + D + 1);
            assertFalse(_policy().scheduledRegistrationCloseDue);
            _outcome(_closeScheduledCall(), Expired.selector, "close after the window");
            _outcome(_closeCall(), mode == SCHEDULED ? WrongMode.selector : RegistrationEnded.selector, "organizer");
            manager.abort(cid);
            assertEq(manager.getCeremony(cid).phase, uint8(Phase.Aborted));
            _outcome(_closeScheduledCall(), WrongPhase.selector, "close after abort");
        }
    }

    function test_WrongMode_PerRegistrationPolicy() public {
        // Scheduled: the organizer cannot cut the promised window short, nor close it later
        _usePolicy(SCHEDULED, RD, D, MANUAL, 0, 0);
        _create(1, 2);
        _join(1);
        _outcome(_closeCall(), WrongMode.selector, "organizer close, Scheduled, before RD");
        vm.warp(RD);
        _outcome(_closeCall(), WrongMode.selector, "organizer close, Scheduled, at RD");
        // Manual without expiry: no time-based close, ever
        vm.warp(T0);
        _usePolicy(MANUAL, 0, D, MANUAL, 0, 0);
        _create(1, 2);
        _join(1);
        _outcome(_closeScheduledCall(), WrongMode.selector, "time-based close, no expiry");
        vm.warp(T0 + 3650 days);
        _outcome(_closeScheduledCall(), WrongMode.selector, "time-based close, years later");
        assertFalse(_policy().scheduledRegistrationCloseDue);
    }

    /// @dev A Manual registration without expiry waits for the organizer indefinitely: no abort.
    function test_ManualWithoutExpiry_NeverTimesOut() public {
        _usePolicy(MANUAL, 0, D, MANUAL, 0, 0);
        _create(2, 3);
        _join(1);
        vm.warp(T0 + 3650 days);
        _outcome(_abortCall(), AbortConditionNotMet.selector, "abort below t, years later");
        _join(2);
        _outcome(_abortCall(), AbortConditionNotMet.selector, "abort with quorum, years later");
        _close();
        assertEq(manager.getCeremony(cid).dealingDeadline, T0 + 3650 days + D);
    }

    /// @dev At every boundary instant, for every joined count, close and abort are never both
    ///      valid; from RD on, one of them is (the ceremony can always move); the view predicate
    ///      equals the time-based close's validity.
    function test_CloseAndAbortDisjointAtEveryBoundary() public {
        uint64[7] memory at = [T0, RD - 1, RD, RD + 1, RD + D - 1, RD + D, RD + D + 1];
        for (uint8 mode; mode <= SCHEDULED; ++mode) {
            for (uint256 joined = 1; joined <= 3; ++joined) {
                vm.warp(T0);
                _usePolicy(mode, RD, D, MANUAL, 0, 0);
                _create(2, 3);
                _joinAll(joined);
                for (uint256 i; i < at.length; ++i) {
                    vm.warp(at[i]);
                    bool due = _policy().scheduledRegistrationCloseDue;
                    bool timeClose = _would(_closeScheduledCall());
                    bool close = timeClose || _would(_closeCall());
                    bool abort_ = _would(_abortCall());
                    assertEq(due, timeClose, "due == time-based close");
                    assertFalse(close && abort_, "close and abort both valid");
                    if (at[i] >= RD) assertTrue(close || abort_, "stuck after the deadline");
                    assertEq(abort_, (at[i] >= RD && joined < 2) || at[i] > RD + D, "abort predicate");
                }
            }
        }
    }

    // ─── Decryption gate ─────────────────────────────────────────────────────────────────

    function test_OpenDecryption_Rejections() public {
        _usePolicy(MANUAL, 0, D, MANUAL, 0, 0);
        _create(2, 2);
        _outcome(_openCall(), WrongPhase.selector, "open in Registration");
        _joinAll(2);
        _close();
        _outcome(_openCall(), WrongPhase.selector, "open in Dealing");
        _dealAll(2);
        manager.finalize(cid);

        (OpenDecryption memory a, bytes memory sig) = _openMsg();
        bytes memory bad = _sign(authSecrets[0], _hOpen(a)); // a member, not the organizer
        vm.expectRevert(BadSignature.selector);
        manager.openDecryption(a, bad);
        OpenDecryption memory stale = OpenDecryption(cid, _now() - 1);
        bytes memory staleSig = _sign(orgKey, _hOpen(stale));
        vm.expectRevert(Expired.selector);
        manager.openDecryption(stale, staleSig);
        OpenDecryption memory other = OpenDecryption(bytes12(uint96(0xdead)), validUntil);
        bytes memory otherSig = _sign(orgKey, _hOpen(other));
        vm.expectRevert(UnknownCeremony.selector);
        manager.openDecryption(other, otherSig);
        // the signature binds the ceremony
        other.ceremonyId = cid;
        vm.expectRevert(BadSignature.selector);
        manager.openDecryption(other, otherSig);
        _assertGate(false, "still closed");

        // relayed by anyone; the opening instant is recorded
        vm.warp(T0 + 5 days);
        vm.expectEmit(address(manager));
        emit ICouncilCore.DecryptionOpened(cid, T0 + 5 days);
        vm.prank(STRANGER);
        manager.openDecryption(a, sig);
        assertEq(_policy().manualOpenedAt, T0 + 5 days);
        _assertGate(true, "opened");
        vm.expectRevert(AlreadyOpen.selector);
        manager.openDecryption(a, sig);
    }

    /// @dev A Scheduled date can be neither accelerated nor passed by an organizer action.
    function test_ScheduledGate_BoundaryAndNoAcceleration() public {
        uint64 openAt = T0 + 10 days;
        _liveWithDecryption(SCHEDULED, openAt, 0, 2, 2);
        vm.warp(openAt - 1);
        _assertGate(false, "openAt - 1");
        _outcome(_openCall(), WrongMode.selector, "organizer open, Scheduled");
        vm.warp(openAt);
        _assertGate(true, "openAt");
        _outcome(_openCall(), WrongMode.selector, "organizer open, Scheduled, after the date");
        vm.warp(openAt + 1);
        _assertGate(true, "openAt + 1");
        PhasePolicyView memory v = _policy();
        assertEq(v.decryptionMode, SCHEDULED);
        assertEq(v.decryptionOpenAt, openAt);
        assertEq(v.manualDecryptionFallbackAt, 0);
        assertEq(v.manualOpenedAt, 0, "no transaction opened it");
    }

    function test_ManualFallback_BoundaryNeedsNoTransaction() public {
        uint64 fallbackAt = T0 + 10 days;
        _liveWithDecryption(MANUAL, 0, fallbackAt, 2, 2);
        vm.warp(fallbackAt - 1);
        _assertGate(false, "fallback - 1");
        vm.warp(fallbackAt);
        _assertGate(true, "fallback");
        assertEq(_policy().manualOpenedAt, 0);
        // the fallback already opened it: the organizer action is now refused
        _outcome(_openCall(), AlreadyOpen.selector, "organizer open after the fallback");
        vm.warp(fallbackAt + 1);
        _assertGate(true, "fallback + 1");
    }

    /// @dev Opening is irreversible: once true, the predicate stays true at every later time.
    function test_Gate_Irreversible() public {
        uint64 fallbackAt = T0 + 10 days;
        _liveWithDecryption(MANUAL, 0, fallbackAt, 2, 2);
        vm.warp(T0 + 1 days);
        _open();
        uint64[5] memory later = [T0 + 1 days, T0 + 2 days, fallbackAt - 1, fallbackAt, T0 + 3650 days];
        for (uint256 i; i < later.length; ++i) {
            vm.warp(later[i]);
            _assertGate(true, "manual open stays open");
            assertEq(_policy().manualOpenedAt, T0 + 1 days);
        }
        _outcome(_openCall(), AlreadyOpen.selector, "second open");
    }

    function test_ManualWithoutFallback_NeverOpensByItself() public {
        _liveWithDecryption(MANUAL, 0, 0, 2, 2);
        vm.warp(T0 + 36500 days);
        _assertGate(false, "a century later");
        _open();
        _assertGate(true, "after the organizer");
    }

    /// @dev The gate requires Live: a passed Scheduled date opens nothing for a ceremony that is
    ///      still dealing or was aborted.
    function test_Gate_RequiresLive() public {
        uint64 openAt = T0 + 1 hours;
        _usePolicy(MANUAL, 0, D, SCHEDULED, openAt, 0);
        _create(2, 2);
        vm.warp(openAt);
        _assertGate(false, "Registration");
        _joinAll(2);
        _close();
        _deal(1);
        vm.warp(openAt + 1);
        _assertGate(false, "Dealing");
        vm.warp(_now() + D + 1);
        manager.abort(cid);
        _assertGate(false, "Aborted");
        vm.warp(T0 + 3650 days);
        _assertGate(false, "Aborted, later");
    }

    /// @dev submitPartial, combine and publishPartialData refuse a closed gate before any other
    ///      check; a refused partial consumes nothing and the very same signed submission goes
    ///      through right after the opening. Requests are admitted while closed.
    function test_Gate_EnforcedOnPartialCombinePublish_NoSlotConsumed() public {
        _liveWithDecryption(MANUAL, 0, 0, 3, 2);
        _bindAndRequest(bytes31(uint248(77)), _u64s(4, 5, 6));
        (, uint8 fieldCount,,) = manager.getRequestMeta(requestId);
        assertEq(fieldCount, 3, "request admitted while closed");

        PartialCall memory p = _partialMsg(1);
        _outcome(_partialCall(p), DecryptionNotOpen.selector, "partial");
        uint8[] memory set = _range(1, 2);
        uint8[] memory fields = _range(0, 1);
        _outcome(
            abi.encodeCall(manager.combine, (requestId, set, fields, _plain(fields), _vectors(set), _c2(fields))),
            DecryptionNotOpen.selector,
            "combine"
        );
        // even a malformed combine meets the gate first
        _outcome(
            abi.encodeCall(
                manager.combine, (requestId, _range(1, 1), fields, _plain(fields), _vectors(set), _c2(fields))
            ),
            DecryptionNotOpen.selector,
            "malformed combine"
        );
        _outcome(abi.encodeCall(manager.publishPartialData, (requestId, 1, p.D)), DecryptionNotOpen.selector, "publish");
        (,, uint16 completed, uint16 partials) = manager.getRequestMeta(requestId);
        assertEq(partials, 0, "no slot consumed");
        assertEq(completed, 0);
        (bool accepted,,) = manager.getPartialCommitment(requestId, 1);
        assertFalse(accepted);

        _open();
        _sendPartial(p); // the same signed partial
        manager.publishPartialData(requestId, 1, p.D);
        _partial(2);
        _combine(set, _range(0, 3));
        (bool ready, uint256[] memory values) = manager.getPlaintexts(requestId);
        assertTrue(ready);
        assertEq(values[2], 6);
    }

    function test_Policy_ViewsAtTheBoundaries() public {
        uint64 openAt = RD + D + 50;
        _usePolicy(SCHEDULED, RD, D, SCHEDULED, openAt, 0);
        _create(2, 3);
        PhasePolicyView memory v = _policy();
        assertEq(v.registrationMode, SCHEDULED);
        assertEq(v.decryptionMode, SCHEDULED);
        assertEq(v.dealingDuration, D);
        assertEq(v.decryptionOpenAt, openAt);
        assertEq(v.manualDecryptionFallbackAt, 0);
        assertEq(v.manualOpenedAt, 0);
        assertFalse(v.decryptionOpen);
        assertFalse(v.scheduledRegistrationCloseDue);
        assertEq(manager.getCeremony(cid).registrationDeadline, RD);
        _joinAll(2);
        vm.warp(RD - 1);
        assertFalse(_policy().scheduledRegistrationCloseDue, "RD - 1");
        vm.warp(RD);
        assertTrue(_policy().scheduledRegistrationCloseDue, "RD");
        vm.warp(RD + D);
        assertTrue(_policy().scheduledRegistrationCloseDue, "RD + D");
        _closeScheduled();
        assertFalse(_policy().scheduledRegistrationCloseDue, "closed");
        _dealAll(2);
        manager.finalize(cid);
        vm.warp(openAt - 1);
        _assertGate(false, "openAt - 1");
        vm.warp(openAt);
        _assertGate(true, "openAt");
    }

    // ─── Create-time policy validation (protocol §8.1) ───────────────────────────────────

    function _expectCreate(CreateCeremony memory a, bytes4 want, string memory what) internal {
        bytes memory sig = _sign(orgKey, _hCreate(a));
        _probe(abi.encodeCall(manager.createCeremony, (a, sig)), want, what);
    }

    function _base(uint8 regMode, uint64 regDeadline, uint8 decMode, uint64 openAt, uint64 fallbackAt)
        internal
        returns (CreateCeremony memory a)
    {
        (a,) = _createMsg(2, 3, ++nonceCounter);
        a.registrationMode = regMode;
        a.registrationDeadline = regDeadline;
        a.decryptionMode = decMode;
        a.decryptionOpenAt = openAt;
        a.manualDecryptionFallbackAt = fallbackAt;
    }

    function test_Create_PolicyValidation() public {
        uint64 now_ = _now();
        uint64 max = type(uint64).max;
        // mode bytes
        _expectCreate(_base(2, RD, MANUAL, 0, 0), BadSchedule.selector, "registration mode 2");
        _expectCreate(_base(MANUAL, RD, 2, 0, 0), BadSchedule.selector, "decryption mode 2");
        _expectCreate(_base(255, RD, 255, 0, 0), BadSchedule.selector, "mode 255");
        // registration deadlines
        _expectCreate(_base(SCHEDULED, 0, MANUAL, 0, 0), BadSchedule.selector, "Scheduled without deadline");
        _expectCreate(_base(SCHEDULED, now_, MANUAL, 0, 0), BadSchedule.selector, "Scheduled deadline = now");
        _expectCreate(_base(SCHEDULED, now_ + 1, MANUAL, 0, 0), OK, "Scheduled deadline = now + 1");
        _expectCreate(_base(MANUAL, now_, MANUAL, 0, 0), BadSchedule.selector, "Manual expiry = now");
        _expectCreate(_base(MANUAL, now_ + 1, MANUAL, 0, 0), OK, "Manual expiry = now + 1");
        _expectCreate(_base(MANUAL, 0, MANUAL, 0, 0), OK, "Manual without expiry");
        // deadline + dealingDuration must fit uint64 (D = 1 day here)
        _expectCreate(_base(SCHEDULED, max - D + 1, MANUAL, 0, 0), BadSchedule.selector, "Scheduled overflow");
        _expectCreate(_base(SCHEDULED, max - D, MANUAL, 0, 0), OK, "Scheduled sum = 2^64 - 1");
        _expectCreate(_base(MANUAL, max - D + 1, MANUAL, 0, 0), BadSchedule.selector, "Manual expiry overflow");
        _expectCreate(_base(MANUAL, max - D, MANUAL, 0, 0), OK, "Manual expiry sum = 2^64 - 1");
        // dealing duration first
        CreateCeremony memory a = _base(2, 0, 2, 0, 0);
        a.dealingDuration = 599;
        _expectCreate(a, BadDuration.selector, "duration 599 before any schedule rule");
        a = _base(MANUAL, 0, MANUAL, 0, 0);
        a.dealingDuration = 600;
        _expectCreate(a, OK, "duration 600");
        // Scheduled decryption
        _expectCreate(_base(MANUAL, 0, SCHEDULED, now_, 0), BadSchedule.selector, "openAt = now");
        _expectCreate(_base(MANUAL, 0, SCHEDULED, now_ + 1, 0), OK, "openAt = now + 1");
        _expectCreate(_base(MANUAL, 0, SCHEDULED, RD, RD + 1), BadSchedule.selector, "Scheduled with fallback");
        _expectCreate(_base(MANUAL, 0, SCHEDULED, 0, 0), BadSchedule.selector, "Scheduled without date");
        // Manual decryption
        _expectCreate(_base(MANUAL, 0, MANUAL, RD, 0), BadSchedule.selector, "Manual with openAt");
        _expectCreate(_base(MANUAL, 0, MANUAL, 0, now_), BadSchedule.selector, "fallback = now");
        _expectCreate(_base(MANUAL, 0, MANUAL, 0, now_ + 1), OK, "fallback = now + 1");
        // cross rule: a Scheduled registration's decryption date lies past RD + D
        _expectCreate(_base(SCHEDULED, RD, SCHEDULED, RD + D, 0), BadSchedule.selector, "openAt = RD + D");
        _expectCreate(_base(SCHEDULED, RD, SCHEDULED, RD + D + 1, 0), OK, "openAt = RD + D + 1");
        _expectCreate(_base(SCHEDULED, RD, MANUAL, 0, RD + D), BadSchedule.selector, "fallback = RD + D");
        _expectCreate(_base(SCHEDULED, RD, MANUAL, 0, RD + D + 1), OK, "fallback = RD + D + 1");
        _expectCreate(_base(SCHEDULED, RD, MANUAL, 0, 0), OK, "no fallback");
        // ... and only for a Scheduled registration
        _expectCreate(_base(MANUAL, RD, SCHEDULED, RD - 1, 0), OK, "Manual expiry, openAt before RD");
        _expectCreate(_base(MANUAL, RD, MANUAL, 0, RD), OK, "Manual expiry, fallback = RD");
    }

    /// @dev Every dealing window is bounded to [600 s, 365 days] at creation (`BadDuration()`,
    ///      checked before any schedule rule). Before the upper bound a Manual registration without
    ///      expiry could carry a near-2^64 duration: its organizer close (`now + D`) then reverted
    ///      for ever and, with no timeout abort, the ceremony could neither close nor abort.
    function test_Create_DealingDurationBounds() public {
        uint64 maxD = 365 days;
        CreateCeremony memory a = _base(MANUAL, 0, MANUAL, 0, 0);
        a.dealingDuration = maxD;
        _expectCreate(a, OK, "duration 365 days");
        a.dealingDuration = maxD + 1;
        _expectCreate(a, BadDuration.selector, "duration 365 days + 1");
        a.dealingDuration = type(uint64).max;
        _expectCreate(a, BadDuration.selector, "duration 2^64 - 1 (Manual, no expiry)");
        a = _base(SCHEDULED, RD, SCHEDULED, RD + maxD + 2, 0);
        a.dealingDuration = maxD + 1;
        _expectCreate(a, BadDuration.selector, "duration 365 days + 1 (Scheduled)");
        a = _base(2, 0, 2, 0, 0);
        a.dealingDuration = maxD + 1;
        _expectCreate(a, BadDuration.selector, "duration above the bound before any schedule rule");
    }

    /// @dev At the longest allowed window a Manual ceremony without expiry still closes years
    ///      later (no overflow), and its dealing phase still times out: abort below t, finalize
    ///      at or above it.
    function test_ManualNoExpiry_MaxDuration_ClosesAndTimesOut() public {
        uint64 maxD = 365 days;
        _usePolicy(MANUAL, 0, maxD, MANUAL, 0, 0);
        _create(2, 3);
        _joinAll(3);
        vm.warp(T0 + 3650 days);
        _close();
        uint64 deadline = manager.getCeremony(cid).dealingDeadline;
        assertEq(deadline, T0 + 3650 days + maxD, "now + 365 days");
        _deal(1);
        vm.warp(deadline);
        _outcome(_abortCall(), AbortConditionNotMet.selector, "abort at the dealing deadline");
        vm.warp(deadline + 1);
        _outcome(_finalizeCall(), FinalizeConditionNotMet.selector, "finalize below t");
        _outcome(_abortCall(), OK, "abort after the dealing deadline");
        assertEq(manager.getCeremony(cid).phase, uint8(Phase.Aborted));
    }

    /// @dev A Scheduled registration at the longest window: the missed schedule still aborts.
    function test_Scheduled_MaxDuration_MissedWindowAborts() public {
        uint64 maxD = 365 days;
        _usePolicy(SCHEDULED, RD, maxD, MANUAL, 0, 0);
        _create(2, 3);
        _joinAll(3);
        vm.warp(RD + maxD);
        _probe(_abortCall(), AbortConditionNotMet.selector, "abort at RD + D (close still valid)");
        vm.warp(RD + maxD + 1);
        _outcome(_closeScheduledCall(), Expired.selector, "close after the window");
        _outcome(_abortCall(), OK, "abort after the window");
    }
}
