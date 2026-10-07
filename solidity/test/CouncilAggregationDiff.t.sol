// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {Vm} from "forge-std/Vm.sol";
import "../src/CouncilTypes.sol";
import {CouncilCurve} from "../src/libraries/CouncilCurve.sol";
import {ICouncil, ICouncilCore} from "../src/interfaces/ICouncil.sol";
import {MockDealVerifier, MockPartialVerifier} from "./mocks/MockVerifiers.sol";
import {FoldHarness, AffineAggregationOracle} from "./utils/FoldHarness.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";
import {Bjj} from "./utils/Bjj.sol";

/// @notice Differential tests of the protocol §8.3 incremental aggregation (each accepted dealing
///         folds `A_k <- A_k + C_{j,k}` into biased storage, extended coordinates, one batch
///         inversion) against v1's batch aggregation over stored per-dealer commitments
///         (`AffineAggregationOracle`: affine sums and affine Horner member keys, test-only).
///         FoldHarness runs the production `_fold` on a ceremony written straight into storage,
///         so the commitments can be any on-curve points, including ones no valid proof produces
///         (the identity as an active commitment, opposite and duplicate points, order-2
///         torsion). After every fold the raw biased slots are compared with the running affine
///         sum plus one; after the last one, finalize (phase and event), getAggregates,
///         getPublicKey and every getMemberKey are compared with the oracle.
contract CouncilAggregationDiffTest is Test {
    uint256 internal constant P = Bjj.P;
    uint256 internal constant R = Bjj.R;

    FoldHarness internal h;
    ICouncil internal hv; // the harness through its views fallback
    AffineAggregationOracle internal o;
    uint96 internal cidNonce = 0xC0FFEE;
    uint256[2][16] internal pool; // TE subgroup points

    // fuzz `mode` bits (TORSION and ZERO_SECRET need both of their bits)
    uint256 internal constant SPARSE = 1; // about half of the commitments are the identity
    uint256 internal constant ZERO_HIGHER = 2; // some final A_k = O for k >= 1
    uint256 internal constant HORNER_CANCEL = 4; // Horner's accumulator hits O for some member
    uint256 internal constant ZERO_MEMBER_KEY = 8; // some PK_m = O with A_0 != O
    uint256 internal constant TORSION = 16 | 32; // order-2 components (never in a valid dealing)
    uint256 internal constant ZERO_SECRET = 64 | 128; // A_0 = O: the abort path
    uint256 internal constant INTERMEDIATE = 256; // a prefix of the folds sums some A_k to O

    struct Outcome {
        Phase phase;
        uint256[2][16] agg; // oracle aggregates, identity padding for k >= t
        uint256[2][16] keys; // getMemberKey(m) at slot m-1 when Live, else zero
        uint256[2][16] raw; // raw biased slots after the last fold
    }

    function setUp() public {
        h = new FoldHarness(address(new MockDealVerifier()), address(new MockPartialVerifier()), bytes32(uint256(1)));
        hv = ICouncil(address(h));
        o = new AffineAggregationOracle();
        for (uint256 i; i < 12; ++i) {
            (pool[i][0], pool[i][1]) = Bjj.mulG(uint256(keccak256(abi.encode("pool", i))) % R);
        }
        (pool[12][0], pool[12][1]) = (Bjj.GX, Bjj.GY);
        (pool[13][0], pool[13][1]) = Bjj.mulG(2);
        (pool[14][0], pool[14][1]) = Bjj.neg(Bjj.GX, Bjj.GY);
        (pool[15][0], pool[15][1]) = Bjj.mulG(R - 2);
    }

    // ─── Fuzz and sweep ──────────────────────────────────────────────────────────────────────

    function testFuzz_FoldMatchesAffine(uint256 seed, uint8 nIn, uint8 tIn, uint16 qualIn, uint16 mode) public {
        uint256 n = bound(nIn, 1, 16);
        uint256 t = bound(tIn, 1, n);
        _run(seed, n, t, _qual(seed, n, t, qualIn), mode);
    }

    /// @dev Every (t, n) with 1 <= t <= n <= 16, once each, with the forcing modes rotating.
    function test_FoldMatchesAffine_AllDimensions() public {
        uint256 i;
        for (uint256 n = 1; n <= 16; ++n) {
            for (uint256 t = 1; t <= n; ++t) {
                uint256 seed = uint256(keccak256(abi.encode("dims", n, t)));
                _run(seed, n, t, _qual(seed, n, t, uint16(seed >> 128)), uint16((29 * i++) & 0x1FF));
            }
        }
    }

    /// @dev Folding the same QUAL in another order gives the same raw slots and member keys.
    /// forge-config: default.fuzz.runs = 256
    function testFuzz_FoldOrderIndependent(uint256 seed, uint8 nIn, uint8 tIn, uint16 qualIn) public {
        uint256 n = bound(nIn, 2, 16);
        uint256 t = bound(tIn, 1, n);
        uint16 qual = _qual(seed, n, t, qualIn);
        uint256[2][16][16] memory C;
        uint256[2][2] memory fresh = _fresh(seed);
        for (uint256 j; j < n; ++j) {
            for (uint256 k; k < t; ++k) {
                C[j][k] = _pick(C, seed, j, k, 0, fresh);
            }
        }
        uint8[] memory asc = _order(qual, n);
        uint8[] memory perm = _shuffle(asc, seed);
        bytes12 c1 = _fold(C, n, t, asc);
        bytes12 c2 = _fold(C, n, t, perm);
        uint256[2][16] memory r1 = h.rawAggregates(c1);
        uint256[2][16] memory r2 = h.rawAggregates(c2);
        for (uint256 k; k < 16; ++k) {
            _assertPoint(r1[k], r2[k]);
        }
        h.finalize(c1);
        h.finalize(c2);
        assertEq(uint8(h.phaseOf(c1)), uint8(h.phaseOf(c2)), "phase");
        if (h.phaseOf(c1) == Phase.Live) {
            for (uint8 m = 1; m <= n; ++m) {
                (uint256 x1, uint256 y1) = hv.getMemberKey(c1, m);
                (uint256 x2, uint256 y2) = hv.getMemberKey(c2, m);
                assertEq(x1, x2, "PK_m.x");
                assertEq(y1, y2, "PK_m.y");
            }
        }
    }

    // ─── Named edge cases ────────────────────────────────────────────────────────────────────

    /// @dev Active (k < t) commitments equal to the identity, including C_{j,0} of most dealers;
    ///      a slot holding the identity stores (1, 2), never the unset (0, 0).
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
        _assertPoint(r.raw[1], [uint256(1), 2]);
        _assertPoint(r.raw[3], [uint256(0), 0]);
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

    /// @dev A_1 after two folds is the identity, then moves away; A_0 cancels on the final fold
    ///      of a two-member ceremony whose other aggregate does not (abort with a nonzero A_1).
    function test_IntermediateCancellationThenAway() public {
        uint256[2][16][16] memory C;
        uint256 n = 4;
        uint256 t = 2;
        C[0][0] = pool[0];
        C[1][0] = pool[1];
        C[2][0] = pool[2];
        C[3][0] = pool[3];
        C[0][1] = pool[5];
        C[1][1] = _neg(pool[5]); // prefix of two folds: A_1 = O, stored (1, 2)
        C[2][1] = pool[6]; // away again
        C[3][1] = _id();
        bytes12 cid = _seed(n, t);
        h.fold(cid, 1, C[0]);
        h.fold(cid, 2, C[1]);
        _assertPoint(h.rawAggregates(cid)[1], [uint256(1), 2]);
        h.fold(cid, 3, C[2]);
        _assertPoint(h.rawAggregates(cid)[1], _plusOne(pool[6]));
        h.fold(cid, 4, C[3]);
        _assertPoint(h.rawAggregates(cid)[1], _plusOne(pool[6]));
        // and the full differential on the same data
        Outcome memory r = _compare(C, n, t, 0xF);
        _assertPoint(r.agg[1], pool[6]);
    }

    /// @dev The final fold lands A_0 on the identity: abort, nothing else written.
    function test_FinalFoldLandsOnIdentity() public {
        uint256[2][16][16] memory C;
        C[0][0] = pool[7];
        C[1][0] = pool[8];
        C[2][0] = _neg(_add(pool[7], pool[8]));
        C[0][1] = pool[9];
        C[1][1] = pool[10];
        C[2][1] = pool[11];
        Outcome memory r = _compare(C, 3, 2, 0x7);
        assertEq(uint8(r.phase), uint8(Phase.Aborted));
        _assertPoint(r.raw[0], [uint256(1), 2]);
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

    /// @dev Σ C_{j,0} = O: abort with CeremonyAborted(cid, Dealing); the views stay closed.
    function test_ZeroSecretAborts() public {
        uint256[2][16][16] memory C;
        C[0][0] = pool[2];
        C[1][0] = _neg(pool[2]);
        C[0][1] = pool[3];
        C[1][1] = pool[4];
        Outcome memory r = _compare(C, 2, 2, 0x3);
        assertEq(uint8(r.phase), uint8(Phase.Aborted));
        _assertPoint(r.raw[0], [uint256(1), 2]);
        _assertPoint(r.raw[1], _plusOne(_add(pool[3], pool[4])));
        for (uint256 k; k < 16; ++k) {
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
        _assertPoint(r.raw[1], [uint256(1), P]); // y = p - 1 stored as p: the bias never wraps
    }

    /// @dev A non-QUAL dealer's commitments never reach the aggregates.
    function test_OnlyQualIsFolded() public {
        uint256[2][16][16] memory C;
        uint256 n = 5;
        uint256 t = 2;
        for (uint256 j; j < n; ++j) {
            C[j][0] = pool[j];
            C[j][1] = pool[j + 5];
        }
        Outcome memory r = _compare(C, n, t, 0x15); // dealers 1, 3, 5
        _assertPoint(r.agg[0], _add(pool[0], _add(pool[2], pool[4])));
        _assertPoint(r.agg[1], _add(pool[5], _add(pool[7], pool[9])));
    }

    /// @dev An off-curve commitment (unreachable: the dealing proof fixes C_{j,k} = a_k·G) can
    ///      make an extended Z vanish in the fold; it must revert instead of inverting 0 (which
    ///      would store (1, 1) for every aggregate), leaving the slots, QUAL and count untouched.
    ///      With A_0 = (ax, ay) and C_0 = (1, y) in the reduced chart, the mixed addition gives
    ///      Z = (2 - c)(2 + c), c = ax·ay·2d·y: y = 2/(ax·ay·2d).
    function test_OffCurveZeroZFailsClosed() public {
        bytes12 cid = _seed(2, 2);
        uint256[2][16] memory c1;
        c1[0] = [Bjj.GX, Bjj.GY];
        c1[1] = pool[3];
        h.fold(cid, 1, c1);
        uint256[2][16] memory before = h.rawAggregates(cid);
        uint256[2][16] memory c2;
        c2[0] = _zeroZPartner(c1[0]);
        c2[1] = pool[4];
        vm.expectRevert(InvalidPoint.selector);
        h.fold(cid, 2, c2);
        uint256[2][16] memory afterRaw = h.rawAggregates(cid);
        for (uint256 k; k < 16; ++k) {
            _assertPoint(afterRaw[k], before[k]);
        }
        CeremonyView memory v = hv.getCeremony(cid);
        assertEq(v.qualBitmap, 1);
        assertEq(v.dealtCount, 1);
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

    function _fresh(uint256 seed) internal view returns (uint256[2][2] memory fresh) {
        (fresh[0][0], fresh[0][1]) = Bjj.mulG(uint256(keccak256(abi.encode(seed, "f0"))) % R);
        (fresh[1][0], fresh[1][1]) = Bjj.mulG(uint256(keccak256(abi.encode(seed, "f1"))) % R);
    }

    function _run(uint256 seed, uint256 n, uint256 t, uint16 qual, uint16 mode) internal {
        uint256[2][16][16] memory C;
        uint256[2][2] memory fresh = _fresh(seed);
        for (uint256 j; j < n; ++j) {
            for (uint256 k; k < t; ++k) {
                C[j][k] = _pick(C, seed, j, k, mode, fresh);
            }
        }
        uint256 rnd = uint256(keccak256(abi.encode(seed, "force")));
        uint256 m = 1 + rnd % n;
        if (mode & INTERMEDIATE != 0) _forceIntermediate(C, n, t, qual, rnd >> 32);
        if (mode & ZERO_HIGHER != 0 && t >= 2) {
            _force(C, n, qual, 1 + (rnd >> 8) % (t - 1), _id());
        }
        if (mode & HORNER_CANCEL != 0 && t >= 2) {
            // acc_{k+1} = Σ_{i > k} m^{i-k-1}·A_i; A_k := -m·acc_{k+1} makes acc_k = O
            uint256 k = (rnd >> 16) % (t - 1);
            uint256[2][16] memory b;
            for (uint256 i = k + 1; i < t; ++i) {
                b[i - k - 1] = _aggregate(C, n, qual, i);
            }
            (uint256 ax, uint256 ay) = o.memberKey(b, t - k - 1, m);
            (ax, ay) = Bjj.mul(m, ax, ay);
            _force(C, n, qual, k, _neg([ax, ay]));
        }
        if (mode & ZERO_MEMBER_KEY != 0 && t >= 2) {
            // A_0 := -Σ_{k >= 1} m^k·A_k makes PK_m = O
            uint256[2][16] memory b;
            b[0] = _id();
            for (uint256 k = 1; k < t; ++k) {
                b[k] = _aggregate(C, n, qual, k);
            }
            (uint256 sx, uint256 sy) = o.memberKey(b, t, m);
            _force(C, n, qual, 0, _neg([sx, sy]));
        }
        if (mode & ZERO_SECRET == ZERO_SECRET) {
            _force(C, n, qual, 0, _id());
        }
        _compare(C, n, t, qual);
    }

    /// @dev Some prefix of the QUAL folds (never the last one) sums A_k to the identity: the
    ///      prefix's last dealer's C_k is rewritten; the later folds move it away again.
    function _forceIntermediate(uint256[2][16][16] memory C, uint256 n, uint256 t, uint16 qual, uint256 rnd)
        internal
        view
    {
        uint8[] memory q = _order(qual, n);
        if (q.length < 2) return;
        uint256 p = 1 + rnd % (q.length - 1); // prefix length 1 .. |QUAL| - 1
        uint256 k = (rnd >> 8) % t;
        uint256[2] memory rest = _id();
        for (uint256 i; i + 1 < p; ++i) {
            rest = _add(rest, C[q[i] - 1][k]);
        }
        C[q[p - 1] - 1][k] = _neg(rest);
    }

    function _pick(
        uint256[2][16][16] memory C,
        uint256 seed,
        uint256 j,
        uint256 k,
        uint256 mode,
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

    /// @dev QUAL dealer indexes (1-based), ascending.
    function _order(uint256 qual, uint256 n) internal pure returns (uint8[] memory q) {
        uint256 c;
        for (uint256 j; j < n; ++j) {
            if ((qual >> j) & 1 == 1) ++c;
        }
        q = new uint8[](c);
        c = 0;
        for (uint256 j; j < n; ++j) {
            if ((qual >> j) & 1 == 1) q[c++] = uint8(j + 1);
        }
    }

    function _shuffle(uint8[] memory a, uint256 seed) internal pure returns (uint8[] memory b) {
        b = new uint8[](a.length);
        for (uint256 i; i < a.length; ++i) {
            b[i] = a[i];
        }
        for (uint256 i = b.length; i > 1; --i) {
            uint256 j = uint256(keccak256(abi.encode(seed, "shuffle", i))) % i;
            (b[i - 1], b[j]) = (b[j], b[i - 1]);
        }
        if (b.length > 1 && keccak256(abi.encode(a)) == keccak256(abi.encode(b))) {
            (b[0], b[b.length - 1]) = (b[b.length - 1], b[0]);
        }
    }

    function _seed(uint256 n, uint256 t) internal returns (bytes12 cid) {
        cid = bytes12(++cidNonce); // a fresh ceremony: nothing left over from a previous run
        h.seed(cid, uint8(n), uint8(t));
    }

    /// @dev Folds dealers `order` into a fresh ceremony, no checks.
    function _fold(uint256[2][16][16] memory C, uint256 n, uint256 t, uint8[] memory order)
        internal
        returns (bytes12 cid)
    {
        cid = _seed(n, t);
        for (uint256 i; i < order.length; ++i) {
            h.fold(cid, order[i], C[order[i] - 1]);
        }
    }

    /// @dev Folds the QUAL dealers in ascending order, checking the raw biased slots against the
    ///      running affine sum after every fold, then finalizes and compares with the oracle.
    function _compare(uint256[2][16][16] memory C, uint256 n, uint256 t, uint256 qual)
        internal
        returns (Outcome memory r)
    {
        bytes12 cid = _seed(n, t);
        uint256[2][16] memory run;
        for (uint256 k; k < 16; ++k) {
            run[k] = _id();
        }
        uint8[] memory q = _order(qual, n);
        for (uint256 i; i < q.length; ++i) {
            uint256 j = q[i] - 1;
            h.fold(cid, q[i], C[j]);
            r.raw = h.rawAggregates(cid);
            for (uint256 k; k < 16; ++k) {
                if (k < t) {
                    run[k] = _add(run[k], C[j][k]);
                    _assertPoint(r.raw[k], _plusOne(run[k]));
                } else {
                    _assertPoint(r.raw[k], [uint256(0), 0]); // never written
                }
            }
        }
        CeremonyView memory v = hv.getCeremony(cid);
        assertEq(v.qualBitmap, qual, "QUAL");
        assertEq(v.dealtCount, q.length, "dealt");

        // the oracle's batch aggregation over the "stored" per-dealer commitments
        r.agg = o.aggregate(C, n, t, qual);
        for (uint256 k; k < 16; ++k) {
            _assertPoint(r.agg[k], k < t ? run[k] : _id());
        }

        vm.recordLogs();
        h.finalize(cid);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        assertEq(logs.length, 1, "one event");
        assertEq(logs[0].emitter, address(h));
        assertEq(logs[0].topics.length, 2);
        assertEq(logs[0].topics[1], bytes32(cid), "cid topic");
        r.phase = h.phaseOf(cid);
        if (r.agg[0][0] == 0 && r.agg[0][1] == 1) {
            assertEq(uint8(r.phase), uint8(Phase.Aborted), "A_0 = O aborts");
            assertEq(logs[0].topics[0], ICouncilCore.CeremonyAborted.selector);
            assertEq(logs[0].data, abi.encode(uint8(Phase.Dealing)));
            vm.expectRevert(WrongPhase.selector);
            hv.getAggregates(cid);
            vm.expectRevert(WrongPhase.selector);
            hv.getMemberKey(cid, 1);
            vm.expectRevert(WrongPhase.selector);
            hv.getPublicKey(cid);
        } else {
            assertEq(uint8(r.phase), uint8(Phase.Live), "Live");
            assertEq(logs[0].topics[0], ICouncilCore.CeremonyFinalized.selector);
            assertEq(logs[0].data, abi.encode(uint16(qual), r.agg[0][0], r.agg[0][1]));
            uint256[2][16] memory padded = hv.getAggregates(cid);
            for (uint256 k; k < 16; ++k) {
                _assertPoint(padded[k], r.agg[k]);
            }
            (uint256 px, uint256 py) = hv.getPublicKey(cid);
            _assertPoint([px, py], r.agg[0]);
            v = hv.getCeremony(cid);
            _assertPoint([v.pkX, v.pkY], r.agg[0]);
            for (uint256 m = 1; m <= n; ++m) {
                (r.keys[m - 1][0], r.keys[m - 1][1]) = hv.getMemberKey(cid, uint8(m));
                (uint256 ex, uint256 ey) = o.memberKey(r.agg, t, m);
                _assertPoint(r.keys[m - 1], [ex, ey]);
                assertTrue(Bjj.onCurveTE(ex, ey), "PK_m on curve");
            }
            vm.expectRevert(NotQualified.selector);
            hv.getMemberKey(cid, uint8(n + 1));
        }
        // finalize wrote nothing but the phase: the slots are still the biased sums
        uint256[2][16] memory after_ = h.rawAggregates(cid);
        for (uint256 k; k < 16; ++k) {
            _assertPoint(after_[k], r.raw[k]);
        }
    }

    /// @dev The TE point whose fold onto A_0 = `a` (TE) zeroes the extended Z (off curve).
    function _zeroZPartner(uint256[2] memory a) internal view returns (uint256[2] memory) {
        uint256 axy = mulmod(CouncilCurve.toReduced(a[0]), a[1], P);
        uint256 y = mulmod(2, _invP(mulmod(axy, CouncilCurve.TWO_D, P)), P);
        return [CouncilCurve.toTE(1), y];
    }

    function _plusOne(uint256[2] memory a) internal pure returns (uint256[2] memory) {
        return [a[0] + 1, a[1] + 1];
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

    function _invP(uint256 a) internal view returns (uint256 inv) {
        (bool ok, bytes memory out) = address(5).staticcall(abi.encode(32, 32, 32, a, P - 2, P));
        require(ok);
        inv = abi.decode(out, (uint256));
    }
}

/// @notice The same aggregation through the real `deal()` (mock verifiers, real signatures and
///         commitments): atomic rollback of a rejected or unfoldable dealing, two dealings racing
///         in one block, finalize as a pure phase flip, and a partial QUAL.
contract CouncilAggregationDealTest is CouncilTestBase {
    /// @dev n = 3, t = 2, registration closed at T0 (dealing deadline T0 + DEAL_DURATION).
    function _dealing(uint8 n, uint8 t) internal {
        _create(t, n);
        for (uint256 i = 1; i <= n; ++i) {
            _join(i);
        }
        _close();
    }

    /// @dev A_k = (Σ_{j in QUAL} a_{j,k})·G from the fixture's coefficients.
    function _expectedAggregates() internal view returns (uint256[2][16] memory A) {
        for (uint256 k; k < 16; ++k) {
            if (k >= T) {
                A[k][1] = 1;
                continue;
            }
            uint256 s;
            for (uint256 j = 1; j <= 16; ++j) {
                if ((qualBits >> (j - 1)) & 1 != 0) s = addmod(s, coef[j][k], R);
            }
            (A[k][0], A[k][1]) = Bjj.mulG(s);
        }
    }

    function _assertLiveKeys(uint256 n) internal view {
        uint256[2][16] memory want = _expectedAggregates();
        uint256[2][16] memory got = manager.getAggregates(cid);
        for (uint256 k; k < 16; ++k) {
            assertEq(got[k][0], want[k][0], "A_k.x");
            assertEq(got[k][1], want[k][1], "A_k.y");
        }
        for (uint8 m = 1; m <= n; ++m) {
            (uint256 ex, uint256 ey) = Bjj.mulG(_share(m));
            (uint256 kx, uint256 ky) = manager.getMemberKey(cid, m);
            assertEq(kx, ex, "PK_m.x");
            assertEq(ky, ey, "PK_m.y");
        }
    }

    function _assertNotDealt(uint8 j) internal {
        vm.expectRevert(NotQualified.selector);
        manager.getRecoveryDealing(cid, j);
        (uint16 qual, uint256[16] memory es, uint256[16] memory ms) = manager.getRecoverySlice(cid, 1);
        assertEq((qual >> (j - 1)) & 1, 0, "QUAL bit");
        assertEq(es[j - 1], 0, "E");
        assertEq(ms[j - 1], 0, "masked");
        (,, bool dealt) = manager.getParticipantCompressed(cid, j);
        assertFalse(dealt);
    }

    /// @dev A rejected proof and an unfoldable (off-curve) commitment both roll back everything.
    function test_Deal_AtomicRollback() public {
        _dealing(3, 2);
        _deal(1);

        // the verifier rejects dealer 2: nothing changes
        DealCall memory d = _dealMsg(2);
        dealV.setAccept(false);
        vm.expectRevert(ProofInvalid.selector);
        _sendDeal(d);
        dealV.setAccept(true);
        assertEq(manager.getCeremony(cid).dealtCount, 1);
        assertEq(manager.getQual(cid), 1);
        _assertNotDealt(2);

        // dealer 2's C_0 chosen so the fold onto A_0 = C_{1,0} zeroes Z; the mock verifier
        // accepts it, the fold reverts InvalidPoint after the proof, and the deal rolls back
        d = _dealMsg(2);
        uint256 axy = mulmod(Bjj.toRed(_c10()[0]), _c10()[1], P);
        uint256 y = mulmod(2, _invP(mulmod(axy, CouncilCurve.TWO_D, P)), P);
        d.C[0] = [Bjj.toTE(1), y];
        assertFalse(Bjj.onCurveTE(d.C[0][0], d.C[0][1]), "off curve");
        _signDeal(d, 2);
        vm.expectRevert(InvalidPoint.selector);
        _sendDeal(d);
        assertEq(manager.getCeremony(cid).dealtCount, 1);
        assertEq(manager.getQual(cid), 1);
        _assertNotDealt(2);

        // the honest dealings land on aggregates as if the failures never happened
        _deal(2);
        _deal(3);
        manager.finalize(cid);
        _assertLiveKeys(3);
    }

    /// @dev C_{1,0} as dealer 1 committed it (TE).
    function _c10() internal view returns (uint256[2] memory c) {
        (c[0], c[1]) = Bjj.mulG(coef[1][0]);
    }

    /// @dev Two dealings in the same block, in both orders: identical aggregates and member keys.
    function test_Deal_TwoDealersRacingInOneBlock() public {
        _dealing(4, 3);
        _deal(1);
        _deal(4);
        DealCall memory d2 = _dealMsg(2);
        DealCall memory d3 = _dealMsg(3);
        qualBits = 0xF;
        uint256 snap = vm.snapshotState();
        _sendDeal(d2);
        _sendDeal(d3);
        manager.finalize(cid);
        uint256[2][16] memory a1 = manager.getAggregates(cid);
        uint256[2][4] memory k1;
        for (uint8 m = 1; m <= 4; ++m) {
            (k1[m - 1][0], k1[m - 1][1]) = manager.getMemberKey(cid, m);
        }
        vm.revertToState(snap);
        _sendDeal(d3);
        _sendDeal(d2);
        manager.finalize(cid);
        uint256[2][16] memory a2 = manager.getAggregates(cid);
        for (uint256 k; k < 16; ++k) {
            assertEq(a1[k][0], a2[k][0]);
            assertEq(a1[k][1], a2[k][1]);
        }
        for (uint8 m = 1; m <= 4; ++m) {
            (uint256 x, uint256 y) = manager.getMemberKey(cid, m);
            assertEq(x, k1[m - 1][0]);
            assertEq(y, k1[m - 1][1]);
        }
        _assertLiveKeys(4);
    }

    /// @dev finalize is a phase flip: exactly one storage write, the ceremony header slot.
    function test_Finalize_WritesOnlyThePhase() public {
        _dealing(3, 2);
        _deal(1);
        _deal(2);
        _deal(3);
        bytes32 header = keccak256(abi.encode(cid, uint256(0))); // _ceremonies is slot 0
        uint256 before = uint256(vm.load(address(manager), header));
        assertEq(before & 0xff, uint8(Phase.Dealing));
        vm.record();
        manager.finalize(cid);
        (, bytes32[] memory writes) = vm.accesses(address(manager));
        assertEq(writes.length, 1, "one SSTORE");
        assertEq(writes[0], header, "the header slot");
        uint256 afterWord = uint256(vm.load(address(manager), header));
        assertEq(afterWord & 0xff, uint8(Phase.Live), "phase");
        assertEq(afterWord >> 8, before >> 8, "nothing else in the header");
        _assertLiveKeys(3);
    }

    /// @dev Only some members deal: A is Σ C over QUAL only; a non-dealer still holds a share.
    function test_PartialQual_AggregatesOverQualOnly() public {
        _dealing(4, 2);
        _deal(1);
        _deal(3);
        vm.warp(T0 + DEAL_DURATION + 1);
        manager.finalize(cid);
        assertEq(manager.getQual(cid), 0x5);
        _assertLiveKeys(4);
        // member 2 never dealt: PK_2 = (f_1(2) + f_3(2))·G
        (uint256 ex, uint256 ey) = Bjj.mulG(addmod(Bjj.evalPoly(coef[1], 2, 2), Bjj.evalPoly(coef[3], 2, 2), R));
        (uint256 kx, uint256 ky) = manager.getMemberKey(cid, 2);
        assertEq(kx, ex);
        assertEq(ky, ey);
    }

    function _invP(uint256 a) internal view returns (uint256 inv) {
        (bool ok, bytes memory out) = address(5).staticcall(abi.encode(32, 32, 32, a, P - 2, P));
        require(ok);
        inv = abi.decode(out, (uint256));
    }
}
