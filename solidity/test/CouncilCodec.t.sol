// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {IDealVerifier, IPartialVerifier} from "../src/interfaces/ICouncilVerifiers.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";
import {CurveHarness} from "./utils/Harnesses.sol";
import {Bjj} from "./utils/Bjj.sol";

/// @notice protocol §2.5 compressed points and their square-root-free authentication
///         (architecture §7 "Codec adversarial cases"): the codec.json vectors through
///         CouncilCurve, then the full adversarial battery driven into every on-chain entry point
///         that re-supplies a stored point in full — the rosterKeys of both registration closes and
///         of every dealing, the C1 bases of submitPartial and the C2 points of combine. Each
///         rejection asserts the exact error (canonical range first, then the TE curve equation,
///         then the exact compressed word) and that nothing changed; the honest call then succeeds.
contract CouncilCodecTest is CouncilTestBase {
    /// @dev A point of order exactly 8 on circomlib BabyJubJub (TE).
    uint256 internal constant T8X = 17545522957889784193459637215142187266023652151580582754000402781682644312291;
    uint256 internal constant T8Y = 17061719626832259898845741003733890968968767993363194771977168648564009544074;
    string internal constant CODEC = "../tests/vectors/codec.json";

    CurveHarness internal h;

    /// @dev The entry points that authenticate re-supplied full points.
    enum Entry {
        Close,
        CloseScheduled,
        Deal,
        Partial,
        Combine
    }

    // honest calldata of the entry under test; only the point array varies
    CloseRegistration internal closeA;
    bytes internal closeSig;
    DealCall internal dc;
    PartialCall internal pc;
    uint8[] internal cSet;
    uint8[] internal cFields;
    uint64[] internal cPlain;

    function setUp() public override {
        super.setUp();
        h = new CurveHarness();
    }

    // ─── codec.json ───────────────────────────────────────────────────────────────────────

    function _codec() internal returns (string memory json) {
        if (!vm.exists(CODEC)) {
            vm.skip(true);
            return "";
        }
        return vm.readFile(CODEC);
    }

    function _k(string memory a, uint256 i, string memory b) internal pure returns (string memory) {
        return string.concat(a, "[", vm.toString(i), "]", b);
    }

    function _count(string memory json, string memory key) internal view returns (uint256 c) {
        while (vm.keyExistsJson(json, _k(key, c, ""))) {
            ++c;
        }
    }

    function _pt(string memory json, string memory key) internal pure returns (uint256, uint256) {
        uint256[] memory a = vm.parseJsonUintArray(json, key);
        assertEq(a.length, 2, key);
        return (a[0], a[1]);
    }

    function _errorOf(string memory name) internal pure returns (bytes4) {
        bytes32 n = keccak256(bytes(name));
        if (n == keccak256("NonCanonical")) return NonCanonical.selector;
        if (n == keccak256("InvalidPoint")) return InvalidPoint.selector;
        if (n == keccak256("CompressedPointMismatch")) return CompressedPointMismatch.selector;
        revert(string.concat("unknown expectation ", name));
    }

    /// @dev Every pinned point compresses to its word, lies on the TE curve, and its subgroup and
    ///      identity labels hold (the codec itself checks encodings only).
    function test_Vectors_CodecPoints() public {
        string memory c = _codec();
        if (bytes(c).length == 0) return;
        uint256 count = _count(c, ".points");
        assertGe(count, 12);
        for (uint256 i; i < count; ++i) {
            string memory k = _k(".points", i, "");
            string memory name = vm.parseJsonString(c, string.concat(k, ".name"));
            (uint256 x, uint256 y) = _pt(c, string.concat(k, ".point"));
            uint256 word = vm.parseJsonUint(c, string.concat(k, ".compressed"));
            assertEq(h.compress(x, y), word, name);
            assertEq(_compress(x, y), word, name);
            assertEq((word >> 254) & 1, 0, "bit 254 reserved");
            assertTrue(Bjj.onCurveTE(x, y), name);
            assertEq(vm.parseJsonBool(c, string.concat(k, ".identity")), x == 0 && y == 1, name);
            // r·P as (r - 1)·P + P: the vendored scalarMul reduces its scalar mod r
            (uint256 rx, uint256 ry) = Bjj.mul(R - 1, x, y);
            (rx, ry) = Bjj.add(rx, ry, x, y);
            assertEq(vm.parseJsonBool(c, string.concat(k, ".inPrimeSubgroup")), rx == 0 && ry == 1, name);
            // an encoding is authenticated by exactly the point it encodes
            assertEq(h.authenticate(x, y, word), Bjj.toRed(x), name);
        }
        // the pinned table of protocol §2.5
        assertEq(h.compress(Bjj.GX, Bjj.GY), 0x8bb77a6ad63e739b4eacb2e09d6277c12ab8d8010534e0b62893f3f6bb957051);
        assertEq(h.compress(P - Bjj.GX, Bjj.GY), 0xa4acd4080af32c8e69a392d5e41ee09bfd7b104774848fdb1b4e019d346a8fb0);
        assertEq(h.compress(0, 1), 1 << 255);
        assertEq(h.compress(0, P - 1), 0, "the zero word is the order-two point, never padding");
    }

    /// @dev Every authentication case with its exact outcome, in the pinned check order.
    function test_Vectors_CodecAuthentication() public {
        string memory c = _codec();
        if (bytes(c).length == 0) return;
        uint256 count = _count(c, ".authentication");
        assertGe(count, 11);
        for (uint256 i; i < count; ++i) {
            string memory k = _k(".authentication", i, "");
            string memory name = vm.parseJsonString(c, string.concat(k, ".name"));
            uint256 stored = vm.parseJsonUint(c, string.concat(k, ".stored"));
            (uint256 x, uint256 y) = _pt(c, string.concat(k, ".supplied"));
            string memory expect = vm.parseJsonString(c, string.concat(k, ".expect"));
            if (keccak256(bytes(expect)) == keccak256("ok")) {
                assertEq(h.authenticate(x, y, stored), Bjj.toRed(x), name);
            } else {
                vm.expectRevert(_errorOf(expect));
                h.authenticate(x, y, stored);
            }
        }
    }

    /// @dev A word a strict decoder rejects (bit 254 set, x >= p, non-residue) never
    ///      authenticates any canonical point: G, -G, the word's own x (or its canonical alias)
    ///      with either parity, and the decoded-parity candidates all fail.
    function test_Vectors_CodecDecodeRejectionsNeverAuthenticate() public {
        string memory c = _codec();
        if (bytes(c).length == 0) return;
        uint256 count = _count(c, ".decodeRejections");
        assertGe(count, 4);
        for (uint256 i; i < count; ++i) {
            string memory k = _k(".decodeRejections", i, "");
            uint256 word = vm.parseJsonUint(c, string.concat(k, ".word"));
            uint256 low = word & ((1 << 254) - 1);
            _neverAuthenticates(Bjj.GX, Bjj.GY, word);
            _neverAuthenticates(P - Bjj.GX, Bjj.GY, word);
            _neverAuthenticates(low, 1, word);
            _neverAuthenticates(low, P - 1, word);
            if (low >= P) {
                _neverAuthenticates(low - P, Bjj.GY, word);
                _neverAuthenticates(low - P, P - Bjj.GY, word);
            }
        }
    }

    function _neverAuthenticates(uint256 x, uint256 y, uint256 word) internal view {
        try h.authenticate(x, y, word) returns (uint256) {
            revert("a rejected word authenticated a point");
        } catch (bytes memory err) {
            bytes4 s = bytes4(err);
            assertTrue(
                s == NonCanonical.selector || s == InvalidPoint.selector || s == CompressedPointMismatch.selector,
                "unexpected error"
            );
        }
    }

    /// @dev Injectivity on canonical on-curve points: a subgroup point authenticates its own
    ///      word, its other root (x, p - y) and its negation (p - x, y) never do, and the word of
    ///      a canonical point never has bit 254 set.
    function testFuzz_CodecInjective(uint256 s) public {
        s = bound(s, 1, R - 1);
        (uint256 x, uint256 y) = Bjj.mulG(s);
        uint256 word = h.compress(x, y);
        assertEq((word >> 254) & 1, 0);
        assertEq(word & ((1 << 254) - 1), x);
        assertEq(word >> 255, y & 1);
        assertEq(h.authenticate(x, y, word), Bjj.toRed(x));
        assertTrue(Bjj.onCurveTE(x, P - y), "other root on the curve");
        vm.expectRevert(CompressedPointMismatch.selector);
        h.authenticate(x, P - y, word);
        vm.expectRevert(CompressedPointMismatch.selector);
        h.authenticate(P - x, y, word);
        uint256 yOff = y + 2 < P ? y + 2 : y - 2;
        vm.expectRevert(InvalidPoint.selector);
        h.authenticate(x, yOff, word);
    }

    // ─── The battery over every on-chain entry point ──────────────────────────────────────

    function _calldata(Entry e, uint256[2][] memory pts) internal view returns (bytes memory) {
        if (e == Entry.Close) return abi.encodeCall(manager.closeRegistration, (closeA, closeSig, pts));
        if (e == Entry.CloseScheduled) return abi.encodeCall(manager.closeRegistrationScheduled, (cid, pts));
        if (e == Entry.Deal) {
            return abi.encodeCall(manager.deal, (dc.a, dc.sig, dc.C, dc.E, dc.masked, _pA(), _pB(), _pC(), pts));
        }
        if (e == Entry.Partial) {
            return abi.encodeCall(manager.submitPartial, (pc.a, pc.sig, pc.D, _pA(), _pB(), _pC(), pts));
        }
        return abi.encodeCall(manager.combine, (requestId, cSet, cFields, cPlain, _vectors(cSet), pts));
    }

    /// @dev What each entry's success writes: unchanged by every rejected call.
    function _digestState(Entry e) internal view returns (bytes32) {
        if (e == Entry.Close || e == Entry.CloseScheduled || e == Entry.Deal) {
            return keccak256(abi.encode(manager.getCeremony(cid)));
        }
        (bytes12 rc, uint8 fc, uint16 completed, uint16 partials) = manager.getRequestMeta(requestId);
        (bool accepted, bytes32 dh, uint64 blk) = manager.getPartialCommitment(requestId, 1);
        (bool ready, uint256[] memory values) = manager.getPlaintexts(requestId);
        return keccak256(abi.encode(rc, fc, completed, partials, accepted, dh, blk, ready, values));
    }

    function _expectFail(Entry e, uint256[2][] memory pts, bytes4 err, string memory what) internal {
        (bool ok, bytes memory ret) = address(manager).call(_calldata(e, pts));
        assertFalse(ok, what);
        assertEq(ret.length, 4, what);
        assertEq(bytes4(ret), err, what);
    }

    function _with(uint256[2][] memory src, uint256 i, uint256 x, uint256 y)
        internal
        pure
        returns (uint256[2][] memory out)
    {
        out = new uint256[2][](src.length);
        for (uint256 k; k < src.length; ++k) {
            out[k] = src[k];
        }
        out[i] = [x, y];
    }

    function _resized(uint256[2][] memory src, uint256 len) internal pure returns (uint256[2][] memory out) {
        out = new uint256[2][](len);
        for (uint256 k; k < len; ++k) {
            out[k] = k < src.length ? src[k] : [Bjj.GX, Bjj.GY];
        }
    }

    /// @dev The adversarial battery at position `i` of the honest array, every case rejected for
    ///      its expected reason.
    function _batteryAt(Entry e, uint256[2][] memory honest, uint256 i) internal {
        uint256 x = honest[i][0];
        uint256 y = honest[i][1];
        assertTrue(x != 0, "fixture point has x = 0");
        // same compressed word, not on the curve: refused by the curve check before the word
        uint256 yOff = y + 2 < P ? y + 2 : y - 2;
        assertEq(_compress(x, yOff), _compress(x, y), "same word");
        _expectFail(e, _with(honest, i, x, yOff), InvalidPoint.selector, "(x, y +- 2)");
        // coordinate aliases and bit 254
        _expectFail(e, _with(honest, i, x + P, y), NonCanonical.selector, "x + p");
        _expectFail(e, _with(honest, i, x, y + P), NonCanonical.selector, "y + p");
        _expectFail(e, _with(honest, i, x | (1 << 254), y), NonCanonical.selector, "bit 254");
        _expectFail(e, _with(honest, i, P, y), NonCanonical.selector, "x = p");
        // off the curve with another x
        uint256 x1 = addmod(x, 1, P);
        assertFalse(Bjj.onCurveTE(x1, y));
        _expectFail(e, _with(honest, i, x1, y), InvalidPoint.selector, "off curve");
        _expectFail(e, _with(honest, i, 0, 0), InvalidPoint.selector, "(0, 0)");
        // on the curve, wrong word: the other root (same x, other parity), the negation,
        // a torsion shift, the order-two point (zero word), the identity, another point
        _expectFail(e, _with(honest, i, x, P - y), CompressedPointMismatch.selector, "(x, p - y)");
        _expectFail(e, _with(honest, i, P - x, y), CompressedPointMismatch.selector, "-P");
        (uint256 tx_, uint256 ty) = Bjj.add(x, y, T8X, T8Y);
        _expectFail(e, _with(honest, i, tx_, ty), CompressedPointMismatch.selector, "P + T8");
        _expectFail(e, _with(honest, i, 0, P - 1), CompressedPointMismatch.selector, "(0, p - 1)");
        _expectFail(e, _with(honest, i, 0, 1), CompressedPointMismatch.selector, "identity");
        (uint256 ox, uint256 oy) = Bjj.mulG(777);
        _expectFail(e, _with(honest, i, ox, oy), CompressedPointMismatch.selector, "another point");
    }

    /// @dev Battery at the first and last positions, a swap of two valid entries, both wrong
    ///      lengths, nothing changed; returns after asserting the state digest.
    function _battery(Entry e, uint256[2][] memory honest, bytes4 lengthErr) internal {
        bytes32 before = _digestState(e);
        uint256 last = honest.length - 1;
        _batteryAt(e, honest, last);
        if (last != 0) {
            _batteryAt(e, honest, 0);
            uint256[2][] memory swapped = _with(honest, 0, honest[last][0], honest[last][1]);
            swapped[last] = honest[0];
            _expectFail(e, swapped, CompressedPointMismatch.selector, "valid points swapped");
        }
        _expectFail(e, _resized(honest, honest.length - 1), lengthErr, "one short");
        _expectFail(e, _resized(honest, honest.length + 1), lengthErr, "one extra");
        // the extra entry is the order-two point, which authenticates against an unset (zero)
        // word: the length check, not authentication, keeps it out of the circuit
        uint256[2][] memory extraT2 = _resized(honest, honest.length + 1);
        extraT2[honest.length] = [uint256(0), P - 1];
        assertEq(h.authenticate(0, P - 1, 0), Bjj.toRed(0), "the zero word authenticates (0, p - 1)");
        _expectFail(e, extraT2, lengthErr, "one extra (0, p - 1)");
        _expectFail(e, new uint256[2][](0), lengthErr, "empty");
        assertEq(_digestState(e), before, "a rejected call changed state");
    }

    function _honestCall(Entry e, uint256[2][] memory pts) internal {
        (bool ok, bytes memory ret) = address(manager).call(_calldata(e, pts));
        if (!ok) {
            assembly ("memory-safe") {
                revert(add(ret, 0x20), mload(ret))
            }
        }
    }

    function _expectedRosterHash() internal view returns (bytes32) {
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

    /// @dev Manual close: the roster is authenticated entry by entry, and the authenticated full
    ///      keys are what rosterHash hashes.
    function test_Battery_CloseRegistration() public {
        _create(2, 4);
        for (uint256 i = 1; i <= 3; ++i) {
            _join(i);
        }
        (closeA, closeSig) = _closeMsg(3);
        _battery(Entry.Close, _roster(), RosterMismatch.selector);
        assertEq(manager.getCeremony(cid).phase, uint8(Phase.Registration));
        _honestCall(Entry.Close, _roster());
        CeremonyView memory v = manager.getCeremony(cid);
        assertEq(v.phase, uint8(Phase.Dealing));
        assertEq(v.rosterHash, _expectedRosterHash());
        assertEq(
            v.ctx,
            keccak256(abi.encode(TAG_DEAL_CONTEXT, block.chainid, address(manager), cid, v.rosterHash, RELEASE_ID))
        );
    }

    /// @dev The permissionless time-based close authenticates the same way.
    function test_Battery_CloseRegistrationScheduled() public {
        _usePolicy(SCHEDULED, T0 + REG_PERIOD, DEAL_DURATION, MANUAL, 0, 0);
        _create(2, 4);
        for (uint256 i = 1; i <= 4; ++i) {
            _join(i);
        }
        vm.warp(T0 + REG_PERIOD);
        vm.startPrank(address(0xC10E));
        _battery(Entry.CloseScheduled, _roster(), RosterMismatch.selector);
        _honestCall(Entry.CloseScheduled, _roster());
        vm.stopPrank();
        CeremonyView memory v = manager.getCeremony(cid);
        assertEq(v.phase, uint8(Phase.Dealing));
        assertEq(v.n, 4);
        assertEq(v.rosterHash, _expectedRosterHash());
        assertEq(v.dealingDeadline, T0 + REG_PERIOD + DEAL_DURATION);
    }

    /// @dev Every dealing re-supplies the roster; the verifier sees exactly the authenticated
    ///      keys at public inputs 39..70 (G padding above n).
    function test_Battery_Deal() public {
        _create(2, 4);
        for (uint256 i = 1; i <= 3; ++i) {
            _join(i);
        }
        _close();
        DealCall memory d = _dealMsg(2);
        dc = d;
        _battery(Entry.Deal, _roster(), RosterMismatch.selector);
        vm.expectRevert(NotQualified.selector);
        manager.getRecoveryDealing(cid, 2);

        uint256[87] memory pub;
        bytes32 ctx = _ctx();
        pub[0] = uint256(ctx) >> 128;
        pub[1] = uint256(uint128(uint256(ctx)));
        pub[2] = 2;
        pub[3] = 3;
        pub[4] = 2;
        for (uint256 k; k < 16; ++k) {
            pub[5 + 2 * k] = d.C[k][0];
            pub[6 + 2 * k] = d.C[k][1];
        }
        pub[37] = d.E[0];
        pub[38] = d.E[1];
        for (uint256 i; i < 16; ++i) {
            (pub[39 + 2 * i], pub[40 + 2 * i]) = i < 3 ? (memberX[i][0], memberX[i][1]) : (Bjj.GX, Bjj.GY);
            pub[71 + i] = d.masked[i];
        }
        vm.expectCall(address(dealV), abi.encodeCall(IDealVerifier.verifyProof, (_pA(), _pB(), _pC(), pub)));
        _honestCall(Entry.Deal, _roster());
        assertEq(manager.getQual(cid), 2);
        (uint256 wordE,) = manager.getRecoveryDealing(cid, 2);
        assertEq(wordE, _compress(d.E[0], d.E[1]));
    }

    function _requested() internal {
        _toLive(3, 2);
        _bindAndRequest(bytes31(uint248(5)), _u64s(10, 20, 30));
    }

    /// @dev submitPartial re-supplies the active C1 bases; the verifier sees exactly them.
    function test_Battery_SubmitPartial() public {
        _requested();
        PartialCall memory p = _partialMsg(1);
        pc = p;
        _battery(Entry.Partial, _c1(), BadFieldCount.selector);

        uint256[67] memory pub;
        (pub[0], pub[1]) = Bjj.mulG(_share(1));
        pub[2] = 3;
        for (uint256 k; k < 16; ++k) {
            (pub[3 + 2 * k], pub[4 + 2 * k]) = k < 3 ? (cts[k][0], cts[k][1]) : (Bjj.GX, Bjj.GY);
            pub[35 + 2 * k] = p.D[k][0];
            pub[36 + 2 * k] = p.D[k][1];
        }
        vm.expectCall(address(partialV), abi.encodeCall(IPartialVerifier.verifyProof, (_pA(), _pB(), _pC(), pub)));
        _honestCall(Entry.Partial, _c1());
        (bool accepted,,) = manager.getPartialCommitment(requestId, 1);
        assertTrue(accepted);
    }

    /// @dev combine re-supplies one C2 per field index, authenticated before any curve arithmetic.
    function test_Battery_Combine() public {
        _requested();
        _partial(1);
        _partial(2);
        cSet = _range(1, 2);
        cFields = _range(0, 3);
        cPlain = _plain(cFields);
        _battery(Entry.Combine, _c2(cFields), BadFieldIndexes.selector);
        _honestCall(Entry.Combine, _c2(cFields));
        (bool ready, uint256[] memory values) = manager.getPlaintexts(requestId);
        assertTrue(ready);
        assertEq(values[0], 10);
        assertEq(values[2], 30);
    }

    /// @dev A one-field chunk in the middle of the request: C2 is authenticated against the word
    ///      of that field index, not of the chunk position.
    function test_Battery_CombineFieldOffset() public {
        _requested();
        _partial(2);
        _partial(3);
        cSet = _range(2, 2);
        cFields = _range(1, 1);
        cPlain = _plain(cFields);
        uint256[2][] memory c2 = _c2(cFields);
        _battery(Entry.Combine, c2, BadFieldIndexes.selector);
        // field 0's or field 2's C2 under field index 1
        _expectFail(Entry.Combine, _with(c2, 0, cts[0][2], cts[0][3]), CompressedPointMismatch.selector, "C2_0");
        _expectFail(Entry.Combine, _with(c2, 0, cts[2][2], cts[2][3]), CompressedPointMismatch.selector, "C2_2");
        // C1 of the same field in place of C2
        _expectFail(Entry.Combine, _with(c2, 0, cts[1][0], cts[1][1]), CompressedPointMismatch.selector, "C1_1");
        _honestCall(Entry.Combine, c2);
        (,, uint16 completed,) = manager.getRequestMeta(requestId);
        assertEq(completed, 2);
    }

    // ─── join: compressed storage and duplicate detection ─────────────────────────────────

    /// @dev The key is stored as compressed(X); duplicates are detected on the word. -X (another
    ///      subgroup point, same y) is a different key; (x, p - y) is not in the subgroup.
    function test_Join_CompressedDuplicateDetection() public {
        _create(2, 5);
        uint256 x1 = _memberShareKey(1);
        _sendJoin(_joinMsg(1, 0, _memberAuth(1), x1));
        (uint256 X0, uint256 X1) = Bjj.mulG(x1);
        (, uint256 word,) = manager.getParticipantCompressed(cid, 1);
        assertEq(word, _compress(X0, X1));

        // the same key under another participant
        JoinCall memory again = _joinMsg(2, 1, _memberAuth(2), x1);
        vm.expectRevert(DuplicateKey.selector);
        _sendJoin(again);

        // the other root of the same x: on the curve, outside the prime subgroup
        uint256 auth3 = _memberAuth(3);
        JoinCall memory root = _joinMsg(3, 1, auth3, _memberShareKey(3));
        root.a.pkX = X0;
        root.a.pkY = P - X1;
        root.inv.pkX = X0;
        root.inv.pkY = P - X1;
        root.psig = _sign(auth3, _hJoin(root.a));
        root.isig = _sign(inviteSecrets[1], _hInvite(root.inv));
        assertTrue(Bjj.onCurveTE(X0, P - X1));
        vm.expectRevert(NotInSubgroup.selector);
        _sendJoin(root);

        // -X = (r - x)·G: a valid, distinct subgroup key with the same y
        JoinCall memory negated = _joinMsg(2, 1, _memberAuth(2), R - x1);
        assertEq(negated.a.pkX, P - X0);
        assertEq(negated.a.pkY, X1);
        _sendJoin(negated);
        (, uint256 word2,) = manager.getParticipantCompressed(cid, 2);
        assertEq(word2, _compress(P - X0, X1));
        assertTrue(word2 != word);
        assertEq(manager.getCeremony(cid).joinedCount, 2);
    }
}
