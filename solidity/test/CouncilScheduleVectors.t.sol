// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {ScheduleFixture} from "./CouncilSchedule.t.sol";

/// @notice Replays `tests/vectors/schedule.json` (protocol §12; produced by the standalone
///         generator's reference predicates) through the contract: every §8.1 create case, every
///         §8.2/§8.3/§8.4 registration and dealing boundary and every §8.7 decryption case, with
///         the exact expected outcome of each action. Skipped when the file is absent.
contract CouncilScheduleVectorsTest is ScheduleFixture {
    string internal constant FILE = "../tests/vectors/schedule.json";
    /// @dev Creation time of the registration cases: before every deadline in the file.
    uint64 internal constant CREATED_AT = 1_850_000_000;

    string internal json;

    function setUp() public override {
        super.setUp();
        if (!vm.exists(FILE)) {
            vm.skip(true);
            return;
        }
        json = vm.readFile(FILE);
    }

    function _key(string memory section, uint256 i, string memory field) internal pure returns (string memory) {
        return string.concat(".", section, "[", vm.toString(i), "].", field);
    }

    function _count(string memory section) internal view returns (uint256 c) {
        while (vm.keyExistsJson(json, string.concat(".", section, "[", vm.toString(c), "]"))) {
            ++c;
        }
    }

    function _u(string memory section, uint256 i, string memory field) internal view returns (uint256) {
        return vm.parseJsonUint(json, _key(section, i, field));
    }

    function _name(string memory section, uint256 i) internal view returns (string memory) {
        return string.concat(section, "/", vm.parseJsonString(json, _key(section, i, "name")));
    }

    /// @dev Expected outcome string of the vectors -> custom error selector (`OK` for "ok").
    function _sel(string memory e) internal pure returns (bytes4) {
        bytes32 h = keccak256(bytes(e));
        if (h == keccak256("ok")) return OK;
        if (h == keccak256("BadSchedule")) return BadSchedule.selector;
        if (h == keccak256("BadDuration")) return BadDuration.selector;
        if (h == keccak256("RegistrationEnded")) return RegistrationEnded.selector;
        if (h == keccak256("WrongMode")) return WrongMode.selector;
        if (h == keccak256("BelowThreshold")) return BelowThreshold.selector;
        if (h == keccak256("RegistrationNotDue")) return RegistrationNotDue.selector;
        if (h == keccak256("Expired")) return Expired.selector;
        if (h == keccak256("AbortConditionNotMet")) return AbortConditionNotMet.selector;
        if (h == keccak256("FinalizeConditionNotMet")) return FinalizeConditionNotMet.selector;
        if (h == keccak256("AlreadyOpen")) return AlreadyOpen.selector;
        revert(string.concat("unknown expectation ", e));
    }

    function _expect(string memory section, uint256 i, string memory action) internal view returns (bytes4) {
        return _sel(vm.parseJsonString(json, _key(section, i, string.concat("expect.", action))));
    }

    // ─── §8.1 create ─────────────────────────────────────────────────────────────────────

    function test_ScheduleVectors_Create() public {
        uint256 cases = _count("create");
        assertGt(cases, 0);
        uint256 ran;
        for (uint256 i; i < cases; ++i) {
            string memory what = _name("create", i);
            uint256 snap = vm.snapshotState();
            vm.warp(_u("create", i, "now"));
            (CreateCeremony memory a,) = _createMsg(uint8(_u("create", i, "threshold")), 3, uint64(1000 + i));
            a.registrationMode = uint8(_u("create", i, "registrationMode"));
            a.registrationDeadline = uint64(_u("create", i, "registrationDeadline"));
            a.dealingDuration = uint64(_u("create", i, "dealingDuration"));
            a.decryptionMode = uint8(_u("create", i, "decryptionMode"));
            a.decryptionOpenAt = uint64(_u("create", i, "decryptionOpenAt"));
            a.manualDecryptionFallbackAt = uint64(_u("create", i, "manualDecryptionFallbackAt"));
            bytes memory sig = _sign(orgKey, _hCreate(a));
            bytes4 want = _sel(vm.parseJsonString(json, _key("create", i, "expect")));
            _outcome(abi.encodeCall(manager.createCeremony, (a, sig)), want, what);
            if (want == OK) {
                bytes12 c = manager.ceremonyIdFor(organizer, a.nonce);
                PhasePolicyView memory v = manager.getPolicy(c);
                assertEq(v.registrationMode, a.registrationMode, what);
                assertEq(v.decryptionMode, a.decryptionMode, what);
                assertEq(v.dealingDuration, a.dealingDuration, what);
                assertEq(v.decryptionOpenAt, a.decryptionOpenAt, what);
                assertEq(v.manualDecryptionFallbackAt, a.manualDecryptionFallbackAt, what);
                assertEq(manager.getCeremony(c).registrationDeadline, a.registrationDeadline, what);
            }
            vm.revertToState(snap);
            ++ran;
        }
        assertEq(ran, cases);
    }

    // ─── §8.2–§8.4 registration ──────────────────────────────────────────────────────────

    function _closeOutcome(bytes memory data, bytes4 want, string memory action, uint256 i, string memory what)
        internal
    {
        uint64 at = _now();
        uint256 snap = vm.snapshotState();
        if (keccak256(bytes(action)) == keccak256("closeRegistrationScheduled")) vm.prank(STRANGER);
        _outcome(data, want, string.concat(what, " ", action));
        if (want == OK) {
            uint256 deadline = _u("registration", i, string.concat("expect.dealingDeadline.", action));
            CeremonyView memory v = manager.getCeremony(cid);
            assertEq(v.dealingDeadline, deadline, string.concat(what, " dealingDeadline"));
            assertEq(v.phase, uint8(Phase.Dealing));
        }
        vm.revertToState(snap);
        vm.warp(at);
    }

    function test_ScheduleVectors_Registration() public {
        uint256 cases = _count("registration");
        assertGt(cases, 0);
        uint256 ran;
        for (uint256 i; i < cases; ++i) {
            string memory what = _name("registration", i);
            uint256 snap = vm.snapshotState();
            vm.warp(CREATED_AT);
            uint256 joined = _u("registration", i, "joined");
            _usePolicy(
                uint8(_u("registration", i, "registrationMode")),
                uint64(_u("registration", i, "registrationDeadline")),
                uint64(_u("registration", i, "dealingDuration")),
                MANUAL,
                0,
                0
            );
            _create(uint8(_u("registration", i, "threshold")), joined + 1);
            _joinAll(joined);
            vm.warp(_u("registration", i, "now"));

            assertEq(
                _policy().scheduledRegistrationCloseDue,
                vm.parseJsonBool(json, _key("registration", i, "expect.scheduledRegistrationCloseDue")),
                string.concat(what, " scheduledRegistrationCloseDue")
            );
            _probe(_joinCall(joined + 1), _expect("registration", i, "join"), string.concat(what, " join"));
            _closeOutcome(_closeCall(), _expect("registration", i, "closeRegistration"), "closeRegistration", i, what);
            _closeOutcome(
                _closeScheduledCall(),
                _expect("registration", i, "closeRegistrationScheduled"),
                "closeRegistrationScheduled",
                i,
                what
            );
            _probe(_abortCall(), _expect("registration", i, "abort"), string.concat(what, " abort"));
            vm.revertToState(snap);
            ++ran;
        }
        assertEq(ran, cases);
    }

    // ─── §8.3/§8.4 dealing ───────────────────────────────────────────────────────────────

    function test_ScheduleVectors_Dealing() public {
        uint256 cases = _count("dealing");
        assertGt(cases, 0);
        uint256 ran;
        for (uint256 i; i < cases; ++i) {
            string memory what = _name("dealing", i);
            uint256 snap = vm.snapshotState();
            uint64 deadline = uint64(_u("dealing", i, "dealingDeadline"));
            uint256 n = _u("dealing", i, "n");
            uint256 dealt = _u("dealing", i, "dealt");
            // Manual registration without expiry, closed by the organizer at deadline - D
            vm.warp(deadline - DEAL_DURATION - 100);
            _usePolicy(MANUAL, 0, DEAL_DURATION, MANUAL, 0, 0);
            _create(uint8(_u("dealing", i, "threshold")), n);
            _joinAll(n);
            vm.warp(deadline - DEAL_DURATION);
            _close();
            assertEq(manager.getCeremony(cid).dealingDeadline, deadline, what);
            _dealAll(dealt);
            vm.warp(_u("dealing", i, "now"));

            // a dealing by a member that has not dealt (meaningless once everyone dealt)
            if (dealt < n) _probe(_dealCall(dealt + 1), _expect("dealing", i, "deal"), string.concat(what, " deal"));
            _probe(_finalizeCall(), _expect("dealing", i, "finalize"), string.concat(what, " finalize"));
            _probe(_abortCall(), _expect("dealing", i, "abort"), string.concat(what, " abort"));
            vm.revertToState(snap);
            ++ran;
        }
        assertEq(ran, cases);
    }

    // ─── §8.7 decryption ─────────────────────────────────────────────────────────────────

    function test_ScheduleVectors_Decryption() public {
        uint256 cases = _count("decryption");
        assertGt(cases, 0);
        uint256 ran;
        for (uint256 i; i < cases; ++i) {
            string memory what = _name("decryption", i);
            uint256 snap = vm.snapshotState();
            vm.warp(CREATED_AT);
            _liveWithDecryption(
                uint8(_u("decryption", i, "decryptionMode")),
                uint64(_u("decryption", i, "decryptionOpenAt")),
                uint64(_u("decryption", i, "manualDecryptionFallbackAt")),
                1,
                1
            );
            uint256 openedAt = _u("decryption", i, "manualOpenedAt");
            if (openedAt != 0) {
                vm.warp(openedAt);
                _open();
                assertEq(_policy().manualOpenedAt, openedAt, what);
            }
            vm.warp(_u("decryption", i, "now"));
            _assertGate(vm.parseJsonBool(json, _key("decryption", i, "expect.isDecryptionOpen")), what);
            _probe(_openCall(), _expect("decryption", i, "openDecryption"), string.concat(what, " openDecryption"));
            vm.revertToState(snap);
            ++ran;
        }
        assertEq(ran, cases);
    }
}
