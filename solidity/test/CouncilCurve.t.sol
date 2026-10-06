// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {BabyJubJub} from "../src/libraries/BabyJubJub.sol";
import "../src/CouncilTypes.sol";
import {CouncilCurve} from "../src/libraries/CouncilCurve.sol";
import {CurveHarness} from "./utils/Harnesses.sol";
import {Bjj} from "./utils/Bjj.sol";

/// @notice CouncilCurve: the TE <-> reduced map (protocol §2.2), point validation, Horner,
///         inverses and Lagrange coefficients mod r.
contract CouncilCurveTest is Test {
    CurveHarness internal h;
    uint256 internal constant P = Bjj.P;
    uint256 internal constant R = Bjj.R;

    function setUp() public {
        h = new CurveHarness();
    }

    function test_MapConstants() public pure {
        assertEq(mulmod(CouncilCurve.K, CouncilCurve.K_INV, P), 1, "K * K_INV");
        assertEq(mulmod(CouncilCurve.K, CouncilCurve.K, P), P - 168700, "K^2 = -a");
        assertEq(CouncilCurve.toReduced(CouncilCurve.GX_TE), BabyJubJub.GENERATOR_X, "G -> reduced generator");
        assertEq(CouncilCurve.toTE(BabyJubJub.GENERATOR_X), CouncilCurve.GX_TE, "reduced generator -> G");
        assertEq(CouncilCurve.GX_RED, BabyJubJub.GENERATOR_X);
        assertEq(CouncilCurve.GY, BabyJubJub.GENERATOR_Y);
        assertEq(CouncilCurve.P, BabyJubJub.Q);
        assertEq(CouncilCurve.R, BabyJubJub.SUBGROUP_ORDER);
        assertEq(CouncilCurve.R_MINUS_2, R - 2);
        assertTrue(Bjj.onCurveTE(CouncilCurve.GX_TE, CouncilCurve.GY), "G on the TE curve");
    }

    /// @dev The map sends reduced-chart products onto the independently checked TE curve.
    function testFuzz_MapPreservesCurve(uint256 s) public view {
        (uint256 xr, uint256 y) = BabyJubJub.scalarMulBase(s);
        uint256 x = CouncilCurve.toTE(xr);
        assertTrue(Bjj.onCurveTE(x, y), "TE curve");
        assertEq(CouncilCurve.toReduced(x), xr, "round trip");
        assertTrue(BabyJubJub.isOnCurve(xr, y));
    }

    function testFuzz_GroupLawThroughMap(uint256 a, uint256 b) public view {
        a = bound(a, 1, R - 1);
        b = bound(b, 1, R - 1);
        (uint256 ax, uint256 ay) = Bjj.mulG(a);
        (uint256 bx, uint256 by) = Bjj.mulG(b);
        (uint256 sx, uint256 sy) = Bjj.add(ax, ay, bx, by);
        (uint256 ex, uint256 ey) = Bjj.mulG(addmod(a, b, R));
        assertEq(sx, ex);
        assertEq(sy, ey);
    }

    function test_RequireSubgroupTE() public {
        (uint256 x, uint256 y) = Bjj.mulG(123456789);
        assertEq(h.requireSubgroupTE(x, y), CouncilCurve.toReduced(x));
        vm.expectRevert(NonCanonical.selector);
        h.requireSubgroupTE(x + P, y);
        vm.expectRevert(NonCanonical.selector);
        h.requireSubgroupTE(x, P);
        vm.expectRevert(InvalidPoint.selector);
        h.requireSubgroupTE(x, y ^ 1);
        vm.expectRevert(InvalidPoint.selector);
        h.requireSubgroupTE(0, 1);
        vm.expectRevert(NotInSubgroup.selector);
        h.requireSubgroupTE(0, P - 1); // order 2
        vm.expectRevert(NotInSubgroup.selector);
        h.requireSubgroupTE(P - x, P - y); // X + (0, -1)
        // the on-curve-only variant accepts torsion and the identity
        h.requireOnCurveTE(0, 1);
        h.requireOnCurveTE(P - x, P - y);
        vm.expectRevert(InvalidPoint.selector);
        h.requireOnCurveTE(1, 1);
    }

    function testFuzz_InvModR(uint256 a) public view {
        a = bound(a, 1, R - 1);
        assertEq(mulmod(a, h.invModR(a), R), 1);
    }

    /// @dev Σ λ_i·f(i) = f(0) for a random polynomial of degree |S|-1 and a random member set.
    function testFuzz_LagrangeInterpolatesAtZero(uint256 seed, uint8 t) public view {
        t = uint8(bound(t, 1, 16));
        uint8[] memory set = new uint8[](t);
        uint256 pool = uint256(keccak256(abi.encode(seed, "set")));
        uint256 picked;
        for (uint256 m = 1; m <= 16 && picked < t; ++m) {
            // keep m if enough remain, or by the seed's bit
            if (16 - m < t - picked || (pool >> m) & 1 == 1) set[picked++] = uint8(m);
        }
        uint256[16] memory a;
        for (uint256 k; k < t; ++k) {
            a[k] = uint256(keccak256(abi.encode(seed, k))) % R;
        }
        uint256[] memory lam = h.lagrange(set);
        uint256 acc;
        uint256 sum;
        for (uint256 i; i < t; ++i) {
            acc = addmod(acc, mulmod(lam[i], Bjj.evalPoly(a, t, set[i]), R), R);
            sum = addmod(sum, lam[i], R);
        }
        assertEq(acc, a[0], "f(0)");
        assertEq(sum, 1, "sum of lambdas");
    }

    /// @dev The batch inversion maps (X, Y, Z, T) to (X/Z, Y/Z) and fails closed on any Z = 0
    ///      instead of inverting 0 (which would return (0, 0) for the whole batch).
    function testFuzz_NormalizeBatch(uint256 s, uint256 z, uint8 zeroAt) public {
        uint256[4][] memory ext = new uint256[4][](3);
        uint256[2][] memory want = new uint256[2][](3);
        for (uint256 i; i < 3; ++i) {
            (want[i][0], want[i][1]) = BabyJubJub.scalarMulBase(uint256(keccak256(abi.encode(s, i))));
            uint256 zi = bound(uint256(keccak256(abi.encode(z, i))), 1, P - 1);
            ext[i] = [
                mulmod(want[i][0], zi, P),
                mulmod(want[i][1], zi, P),
                zi,
                mulmod(mulmod(want[i][0], want[i][1], P), zi, P)
            ];
        }
        uint256[2][] memory got = h.normalize(ext);
        for (uint256 i; i < 3; ++i) {
            assertEq(got[i][0], want[i][0]);
            assertEq(got[i][1], want[i][1]);
        }
        ext[zeroAt % 3][2] = 0;
        vm.expectRevert(InvalidPoint.selector);
        h.normalize(ext);
    }

    /// @dev Horner over A_k = a_k·G equals f(m)·G.
    function testFuzz_Horner(uint256 seed, uint8 t, uint8 m) public view {
        t = uint8(bound(t, 1, 16));
        m = uint8(bound(m, 1, 16));
        uint256[16] memory a;
        uint256[2][16] memory A;
        for (uint256 k; k < t; ++k) {
            a[k] = uint256(keccak256(abi.encode(seed, k))) % R;
            (A[k][0], A[k][1]) = BabyJubJub.scalarMulBase(a[k]);
        }
        (uint256 x, uint256 y) = h.horner(A, t, m);
        (uint256 ex, uint256 ey) = BabyJubJub.scalarMulBase(Bjj.evalPoly(a, t, m));
        assertEq(x, ex);
        assertEq(y, ey);
    }
}
