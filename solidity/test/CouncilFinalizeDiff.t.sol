// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import "../src/CouncilTypes.sol";
import {CouncilCurve} from "../src/libraries/CouncilCurve.sol";
import {MockDealVerifier, MockPartialVerifier} from "./mocks/MockVerifiers.sol";
import {FinalizeHarness, AffineFinalizeOracle} from "./utils/FinalizeHarness.sol";
import {Bjj} from "./utils/Bjj.sol";

/// @notice Differential tests of `finalize` (extended coordinates, one batch inversion) against
///         the previous affine implementation (`AffineFinalizeOracle`, a verbatim test-only copy).
///         Both contracts get the same ceremony written straight into storage, so the dealt
///         commitments can be any on-curve points, including ones no valid proof produces (the
///         identity as an active commitment, opposite and duplicate points, order-2 torsion).
///         Every run compares the call result, the phase, all 16 aggregate and 16 member-key
///         slots (padding included) and the emitted logs.
contract CouncilFinalizeDiffTest is Test {
    uint256 internal constant P = Bjj.P;
    uint256 internal constant R = Bjj.R;
    bytes12 internal constant CID = bytes12(uint96(0xC0FFEE));

    FinalizeHarness internal h;
    AffineFinalizeOracle internal o;
    uint96 internal cidNonce = 0xC0FFEE;
    uint256[2][16] internal pool; // TE subgroup points

    // fuzz `mode` bits (TORSION and ZERO_SECRET need both of their bits)
    uint256 internal constant SPARSE = 1; // about half of the commitments are the identity
    uint256 internal constant ZERO_HIGHER = 2; // some A_k = O for k >= 1
    uint256 internal constant HORNER_CANCEL = 4; // Horner's accumulator hits O for some member
    uint256 internal constant ZERO_MEMBER_KEY = 8; // some PK_m = O with A_0 != O
    uint256 internal constant TORSION = 16 | 32; // order-2 components (never in a valid dealing)
    uint256 internal constant ZERO_SECRET = 64 | 128; // A_0 = O: the abort path

    struct Outcome {
        Phase phase;
        uint256[2][16] agg;
        uint256[2][16] keys;
    }

    function setUp() public {
        h = new FinalizeHarness(
            address(new MockDealVerifier()), address(new MockPartialVerifier()), bytes32(uint256(1))
        );
        o = new AffineFinalizeOracle();
        for (uint256 i; i < 12; ++i) {
            (pool[i][0], pool[i][1]) = Bjj.mulG(uint256(keccak256(abi.encode("pool", i))) % R);
        }
        (pool[12][0], pool[12][1]) = (Bjj.GX, Bjj.GY);
        (pool[13][0], pool[13][1]) = Bjj.mulG(2);
        (pool[14][0], pool[14][1]) = Bjj.neg(Bjj.GX, Bjj.GY);
        (pool[15][0], pool[15][1]) = Bjj.mulG(R - 2);
    }

    // ─── Fuzz ────────────────────────────────────────────────────────────────────────────────

    function testFuzz_FinalizeMatchesAffine(uint256 seed, uint8 nIn, uint8 tIn, uint16 qualIn, uint8 mode) public {
        uint256 n = bound(nIn, 1, 16);
        uint256 t = bound(tIn, 1, n);
        _run(seed, n, t, _qual(seed, n, t, qualIn), mode);
    }

    /// @dev Every (t, n) with 1 <= t <= n <= 16, once each, with the forcing modes rotating.
    function test_FinalizeMatchesAffine_AllDimensions() public {
        uint256 i;
        for (uint256 n = 1; n <= 16; ++n) {
            for (uint256 t = 1; t <= n; ++t) {
                uint256 seed = uint256(keccak256(abi.encode("dims", n, t)));
                _run(seed, n, t, _qual(seed, n, t, uint16(seed >> 128)), uint8(29 * i++));
            }
        }
    }

    // ─── Named edge cases ────────────────────────────────────────────────────────────────────

    /// @dev Active (k < t) commitments equal to the identity, including C_{j,0} of most dealers.
    function test_ActiveIdentityCommitments() public {
        uint256[2][16][16] memory C;
        uint256 n = 4;
        uint256 t = 3;
        for (uint256 j; j < n; ++j) {
            for (uint256 k; k < t; ++k) {
                C[j][k] = _id();
            }
        }
        C[2][0] = pool[0];
        C[3][2] = pool[1];
        Outcome memory r = _compare(C, n, t, 0xF);
        assertEq(uint8(r.phase), uint8(Phase.Live));
        _assertPoint(r.agg[0], pool[0]);
        _assertPoint(r.agg[1], _id());
        _assertPoint(r.agg[2], pool[1]);
    }

    /// @dev Duplicates (the unified addition doubles), opposites and a cancellation in the middle
    ///      of the QUAL sum that later dealers move away from O again.
    function test_DuplicateAndOppositePoints() public {
        uint256[2][16][16] memory C;
        uint256 n = 5;
        uint256 t = 2;
        uint256[2] memory x = pool[3];
        uint256[2] memory negX = _neg(x);
        // k = 0: X + X + X - X + Y = 2X + Y
        C[0][0] = x;
        C[1][0] = x;
        C[2][0] = x;
        C[3][0] = negX;
        C[4][0] = pool[4];
        // k = 1: X - X (running sum O) + X + X - X = X
        C[0][1] = x;
        C[1][1] = negX;
        C[2][1] = x;
        C[3][1] = x;
        C[4][1] = negX;
        Outcome memory r = _compare(C, n, t, 0x1F);
        uint256[2] memory twoX;
        (twoX[0], twoX[1]) = Bjj.mul(2, x[0], x[1]);
        uint256[2] memory a0;
        (a0[0], a0[1]) = Bjj.add(twoX[0], twoX[1], pool[4][0], pool[4][1]);
        _assertPoint(r.agg[0], a0);
        _assertPoint(r.agg[1], x);
    }

    /// @dev A_1 = A_2 = O with A_0 != O: every member key equals A_0.
    function test_HigherAggregatesIdentity() public {
        uint256[2][16][16] memory C;
        uint256 n = 3;
        uint256 t = 3;
        C[0][0] = pool[5];
        C[1][0] = pool[6];
        C[2][0] = pool[7];
        for (uint256 k = 1; k < t; ++k) {
            C[0][k] = pool[8];
            C[1][k] = pool[9];
            C[2][k] = _neg(_add(pool[8], pool[9]));
        }
        Outcome memory r = _compare(C, n, t, 0x7);
        assertEq(uint8(r.phase), uint8(Phase.Live));
        _assertPoint(r.agg[1], _id());
        _assertPoint(r.agg[2], _id());
        for (uint256 m; m < n; ++m) {
            _assertPoint(r.keys[m], r.agg[0]);
        }
    }

    /// @dev PK_3 = A_0 + 3·A_1 = O in a ceremony that goes Live.
    function test_IdentityMemberKeyInLiveCeremony() public {
        uint256[2][16][16] memory C;
        uint256 n = 4;
        uint256 t = 2;
        uint256[2] memory x = pool[10];
        uint256[2] memory threeX;
        (threeX[0], threeX[1]) = Bjj.mul(3, x[0], x[1]);
        C[0][1] = x; // A_1 = X (dealers 2..4 add O)
        for (uint256 j = 1; j < n; ++j) {
            C[j][1] = _id();
            C[j][0] = pool[j];
        }
        // A_0 = -3X: dealer 1 cancels the other dealers' constant terms
        C[0][0] = _neg(_add(threeX, _add(pool[1], _add(pool[2], pool[3]))));
        Outcome memory r = _compare(C, n, t, 0xF);
        assertEq(uint8(r.phase), uint8(Phase.Live));
        _assertPoint(r.agg[0], _neg(threeX));
        _assertPoint(r.keys[2], _id());
        assertFalse(r.keys[1][0] == 0 && r.keys[1][1] == 1, "PK_2 != O");
    }

    /// @dev Horner's accumulator for member 2 hits O halfway: A_1 = -2·A_2.
    function test_HornerIntermediateCancellation() public {
        uint256[2][16][16] memory C;
        uint256 n = 3;
        uint256 t = 3;
        uint256[2] memory twoA2;
        (twoA2[0], twoA2[1]) = Bjj.mul(2, pool[11][0], pool[11][1]);
        C[0][0] = pool[0];
        C[0][1] = _neg(twoA2);
        C[0][2] = pool[11];
        for (uint256 j = 1; j < n; ++j) {
            for (uint256 k; k < t; ++k) {
                C[j][k] = _id();
            }
        }
        Outcome memory r = _compare(C, n, t, 0x7);
        // PK_2 = A_0 + 2·A_1 + 4·A_2 = A_0
        _assertPoint(r.keys[1], pool[0]);
    }

    /// @dev Σ C_{j,0} = O: both abort with the same event and write nothing else.
    function test_ZeroSecretAborts() public {
        uint256[2][16][16] memory C;
        C[0][0] = pool[2];
        C[1][0] = _neg(pool[2]);
        C[0][1] = pool[3];
        C[1][1] = pool[4];
        Outcome memory r = _compare(C, 2, 2, 0x3);
        assertEq(uint8(r.phase), uint8(Phase.Aborted));
        for (uint256 k; k < 16; ++k) {
            _assertPoint(r.agg[k], [uint256(0), 0]);
            _assertPoint(r.keys[k], [uint256(0), 0]);
        }
    }

    /// @dev Order-2 components: T2 + T2 = O at k = 0 among subgroup points, T2 itself at k = 1.
    function test_TorsionPoints() public {
        uint256[2][16][16] memory C;
        uint256[2] memory t2 = [uint256(0), P - 1];
        C[0][0] = t2;
        C[1][0] = t2;
        C[2][0] = pool[0];
        C[0][1] = t2;
        C[1][1] = _id();
        C[2][1] = _id();
        C[0][2] = _add(pool[1], t2);
        C[1][2] = pool[2];
        C[2][2] = t2;
        Outcome memory r = _compare(C, 3, 3, 0x7);
        _assertPoint(r.agg[0], pool[0]);
        _assertPoint(r.agg[1], t2);
    }

    /// @dev An off-curve commitment (unreachable: the dealing proof fixes C_{j,k} = a_k·G) can
    ///      make an extended Z vanish; finalize must revert instead of inverting 0 and storing
    ///      (0, 0) for every key. With A_0 = G + (x, y) in the reduced chart, the unified
    ///      addition gives Z = (8 - c)(8 + c), c = 4·gx·gy·2d·x·y: x = 1, y = 2/(gx·gy·2d).
    function test_OffCurveZeroZFailsClosed() public {
        uint256 y = mulmod(2, _invP(mulmod(mulmod(CouncilCurve.GX_RED, Bjj.GY, P), CouncilCurve.TWO_D, P)), P);
        uint256[2][16][16] memory C;
        C[0][0] = [Bjj.GX, Bjj.GY];
        C[1][0] = [CouncilCurve.toTE(1), y];
        h.seed(CID, 2, 1, 0x3, C);
        vm.expectRevert(InvalidPoint.selector);
        h.finalize(CID);
        (Phase phase,,) = h.raw(CID);
        assertEq(uint8(phase), uint8(Phase.Dealing));
    }

    // ─── Machinery ───────────────────────────────────────────────────────────────────────────

    /// @dev QUAL ⊆ [n] with |QUAL| >= t: `qualIn` masked to n bits, topped up from the seed.
    function _qual(uint256 seed, uint256 n, uint256 t, uint16 qualIn) internal pure returns (uint16 qual) {
        qual = uint16(uint256(qualIn) & ((1 << n) - 1));
        uint256 count;
        for (uint256 j; j < n; ++j) {
            if ((qual >> j) & 1 == 1) ++count;
        }
        uint256 start = seed % n;
        for (uint256 i; i < n && count < t; ++i) {
            uint256 j = (start + i) % n;
            if ((qual >> j) & 1 == 0) {
                qual |= uint16(1 << j);
                ++count;
            }
        }
    }

    function _run(uint256 seed, uint256 n, uint256 t, uint16 qual, uint8 mode) internal {
        uint256[2][16][16] memory C;
        uint256[2][2] memory fresh;
        (fresh[0][0], fresh[0][1]) = Bjj.mulG(uint256(keccak256(abi.encode(seed, "f0"))) % R);
        (fresh[1][0], fresh[1][1]) = Bjj.mulG(uint256(keccak256(abi.encode(seed, "f1"))) % R);
        for (uint256 j; j < n; ++j) {
            for (uint256 k; k < t; ++k) {
                C[j][k] = _pick(C, seed, j, k, mode, fresh);
            }
        }
        uint256 rnd = uint256(keccak256(abi.encode(seed, "force")));
        uint256 m = 1 + rnd % n;
        if (mode & ZERO_HIGHER != 0 && t >= 2) {
            _force(C, n, qual, 1 + (rnd >> 8) % (t - 1), _id());
        }
        if (mode & HORNER_CANCEL != 0 && t >= 2) {
            // acc_{k+1} = Σ_{i > k} m^{i-k-1}·A_i; A_k := -m·acc_{k+1} makes acc_k = O
            uint256 k = (rnd >> 16) % (t - 1);
            uint256[2][16] memory b;
            for (uint256 i = k + 1; i < t; ++i) {
                b[i - k - 1] = _red(_aggregate(C, n, qual, i));
            }
            (uint256 ax, uint256 ay) = o.horner(b, t - k - 1, m);
            (ax, ay) = Bjj.mul(m, CouncilCurve.toTE(ax), ay);
            _force(C, n, qual, k, _neg([ax, ay]));
        }
        if (mode & ZERO_MEMBER_KEY != 0 && t >= 2) {
            // A_0 := -Σ_{k >= 1} m^k·A_k makes PK_m = O
            uint256[2][16] memory b;
            b[0] = [uint256(0), 1];
            for (uint256 k = 1; k < t; ++k) {
                b[k] = _red(_aggregate(C, n, qual, k));
            }
            (uint256 sx, uint256 sy) = o.horner(b, t, m);
            _force(C, n, qual, 0, _neg([CouncilCurve.toTE(sx), sy]));
        }
        if (mode & ZERO_SECRET == ZERO_SECRET) {
            _force(C, n, qual, 0, _id());
        }
        _compare(C, n, t, qual);
    }

    function _pick(
        uint256[2][16][16] memory C,
        uint256 seed,
        uint256 j,
        uint256 k,
        uint8 mode,
        uint256[2][2] memory fresh
    ) internal view returns (uint256[2] memory pt) {
        uint256 r = uint256(keccak256(abi.encode(seed, j, k)));
        if (mode & SPARSE != 0 && (r >> 200) & 1 == 1) return _id();
        if (mode & TORSION == TORSION && (r >> 201) % 4 == 0) {
            pt = (r >> 203) & 1 == 1 ? [uint256(0), P - 1] : _add(pool[(r >> 8) % 16], [uint256(0), P - 1]);
            return pt;
        }
        uint256 kind = r % 8;
        uint256 other = j == 0 ? 0 : (r >> 64) % j;
        if (kind <= 2) return pool[(r >> 8) % 16];
        if (kind == 3) return fresh[(r >> 8) % 2];
        if (kind == 4) return _id();
        if (kind == 5) return j == 0 ? pool[(r >> 8) % 16] : C[other][k];
        if (kind == 6) return j == 0 ? _neg(fresh[0]) : _neg(C[other][k]);
        return _neg(pool[(r >> 8) % 16]);
    }

    /// @dev Rewrites the last QUAL dealer's C_{.,k} so that A_k = target.
    function _force(uint256[2][16][16] memory C, uint256 n, uint16 qual, uint256 k, uint256[2] memory target)
        internal
        view
    {
        uint256 d = n;
        while ((qual >> (d - 1)) & 1 == 0) {
            --d;
        }
        --d;
        uint256[2] memory rest = _id();
        for (uint256 j; j < n; ++j) {
            if (j != d && (qual >> j) & 1 == 1) rest = _add(rest, C[j][k]);
        }
        C[d][k] = _add(target, _neg(rest));
    }

    function _aggregate(uint256[2][16][16] memory C, uint256 n, uint16 qual, uint256 k)
        internal
        view
        returns (uint256[2] memory acc)
    {
        acc = _id();
        for (uint256 j; j < n; ++j) {
            if ((qual >> j) & 1 == 1) acc = _add(acc, C[j][k]);
        }
    }

    /// @dev Seeds both contracts, finalizes both and asserts identical results.
    function _compare(uint256[2][16][16] memory C, uint256 n, uint256 t, uint256 qual)
        internal
        returns (Outcome memory r)
    {
        bytes12 cid = bytes12(++cidNonce); // a fresh ceremony: nothing left over from a previous run
        h.seed(cid, uint8(n), uint8(t), uint16(qual), C);
        o.seed(cid, uint8(n), uint8(t), uint16(qual), C);

        vm.recordLogs();
        (bool okH, bytes memory retH) = address(h).call(abi.encodeCall(h.finalize, (cid)));
        Vm.Log[] memory logsH = vm.getRecordedLogs();
        (bool okO, bytes memory retO) = address(o).call(abi.encodeCall(o.finalize, (cid)));
        Vm.Log[] memory logsO = vm.getRecordedLogs();
        assertTrue(okO, "oracle finalize");
        assertEq(okH, okO, "success");
        assertEq(retH, retO, "returndata");

        assertEq(logsH.length, 1, "one event");
        assertEq(logsH.length, logsO.length, "log count");
        for (uint256 i; i < logsH.length; ++i) {
            assertEq(logsH[i].topics, logsO[i].topics, "topics");
            assertEq(logsH[i].data, logsO[i].data, "data");
        }

        Outcome memory e;
        (r.phase, r.agg, r.keys) = h.raw(cid);
        (e.phase, e.agg, e.keys) = o.raw(cid);
        assertEq(uint8(r.phase), uint8(e.phase), "phase");
        for (uint256 k; k < 16; ++k) {
            assertEq(r.agg[k][0], e.agg[k][0], "A_k.x");
            assertEq(r.agg[k][1], e.agg[k][1], "A_k.y");
            assertEq(r.keys[k][0], e.keys[k][0], "PK_m.x");
            assertEq(r.keys[k][1], e.keys[k][1], "PK_m.y");
        }
        // padding: nothing is written past t aggregates and n member keys (none at all on abort)
        uint256 aggWritten = r.phase == Phase.Live ? t : 0;
        uint256 keysWritten = r.phase == Phase.Live ? n : 0;
        for (uint256 k = aggWritten; k < 16; ++k) {
            _assertPoint(r.agg[k], [uint256(0), 0]);
        }
        for (uint256 m = keysWritten; m < 16; ++m) {
            _assertPoint(r.keys[m], [uint256(0), 0]);
        }
        // the written points are on the TE curve; the view pads with the identity
        for (uint256 k; k < aggWritten; ++k) {
            assertTrue(Bjj.onCurveTE(r.agg[k][0], r.agg[k][1]), "A_k on curve");
        }
        for (uint256 m; m < keysWritten; ++m) {
            assertTrue(Bjj.onCurveTE(r.keys[m][0], r.keys[m][1]), "PK_m on curve");
        }
        if (r.phase == Phase.Live) {
            uint256[2][16] memory padded = ICouncilAggregates(address(h)).getAggregates(cid);
            for (uint256 k; k < 16; ++k) {
                _assertPoint(padded[k], k < t ? r.agg[k] : _id());
            }
        }
    }

    function _assertPoint(uint256[2] memory got, uint256[2] memory want) internal pure {
        assertEq(got[0], want[0], "x");
        assertEq(got[1], want[1], "y");
    }

    function _id() internal pure returns (uint256[2] memory) {
        return [uint256(0), 1];
    }

    function _neg(uint256[2] memory a) internal pure returns (uint256[2] memory r) {
        (r[0], r[1]) = Bjj.neg(a[0], a[1]);
    }

    function _add(uint256[2] memory a, uint256[2] memory b) internal view returns (uint256[2] memory r) {
        (r[0], r[1]) = Bjj.add(a[0], a[1], b[0], b[1]);
    }

    function _red(uint256[2] memory a) internal pure returns (uint256[2] memory) {
        return [CouncilCurve.toReduced(a[0]), a[1]];
    }

    function _invP(uint256 a) internal view returns (uint256 inv) {
        (bool ok, bytes memory out) = address(5).staticcall(abi.encode(32, 32, 32, a, P - 2, P));
        require(ok);
        inv = abi.decode(out, (uint256));
    }
}

interface ICouncilAggregates {
    function getAggregates(bytes12 cid) external view returns (uint256[2][16] memory);
}
