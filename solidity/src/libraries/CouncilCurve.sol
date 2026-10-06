// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {BabyJubJub} from "./BabyJubJub.sol";
import {NonCanonical, InvalidPoint, NotInSubgroup} from "../CouncilTypes.sol";

/// @title CouncilCurve
/// @notice Thin wrapper over the vendored (read-only) `BabyJubJub.sol`, which works in the reduced
///         chart (a = -1). Council's wire format is the circomlib twisted Edwards chart (TE,
///         a = 168700, d = 168696); the two charts differ only by `x_reduced = x_te·K mod p`
///         (protocol §2.2). Every function here takes and returns reduced-form x coordinates
///         unless its name says TE; callers convert exactly at the protocol §2.2 boundaries.
library CouncilCurve {
    /// @dev BN254 scalar field prime: BabyJubJub's coordinate field.
    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    /// @dev Prime subgroup order r.
    uint256 internal constant R = 2736030358979909402780800718157159386076813972158567259200215660948447373041;
    /// @dev r - 2: Fermat exponent for inverses mod r.
    uint256 internal constant R_MINUS_2 = 2736030358979909402780800718157159386076813972158567259200215660948447373039;
    /// @dev TE -> reduced scaling, K² = -168700 mod p.
    uint256 internal constant K = 15527681003928902128179717624703512672403908117992798440346960750464748824729;
    /// @dev K^-1 mod p.
    uint256 internal constant K_INV = 1911982854305225074381251344103329931637610209014896889891168275855466657090;
    /// @dev Generator G = circomlib Base8, TE coordinates.
    uint256 internal constant GX_TE = 5299619240641551281634865583518297030282874472190772894086521144482721001553;
    uint256 internal constant GY = 16950150798460657717958625567821834550301663161624707787222815936182638968203;
    /// @dev G in the reduced chart (== BabyJubJub.GENERATOR_X).
    uint256 internal constant GX_RED = 9671717474070082183213120605117400219616337014328744928644933853176787189663;

    /// @notice TE x -> reduced x (one mulmod).
    function toReduced(uint256 xTe) internal pure returns (uint256) {
        return mulmod(xTe, K, P);
    }

    /// @notice Reduced x -> TE x (one mulmod).
    function toTE(uint256 xRed) internal pure returns (uint256) {
        return mulmod(xRed, K_INV, P);
    }

    /// @notice Require a canonical, on-curve TE point; returns its reduced x.
    function requireOnCurveTE(uint256 x, uint256 y) internal pure returns (uint256 xr) {
        if (x >= P || y >= P) revert NonCanonical();
        xr = toReduced(x);
        if (!BabyJubJub.isOnCurve(xr, y)) revert InvalidPoint();
    }

    /// @notice Require a canonical, on-curve, non-identity TE point of the prime subgroup;
    ///         returns its reduced x. The subgroup check runs after the TE -> reduced conversion.
    function requireSubgroupTE(uint256 x, uint256 y) internal pure returns (uint256 xr) {
        xr = requireOnCurveTE(x, y);
        if (x == 0 && y == 1) revert InvalidPoint();
        if (!BabyJubJub.isInPrimeSubgroup(xr, y)) revert NotInSubgroup();
    }

    /// @notice Affine addition in the reduced chart.
    function add(uint256 x1, uint256 y1, uint256 x2, uint256 y2) internal view returns (uint256, uint256) {
        return BabyJubJub.pointAdd(x1, y1, x2, y2);
    }

    /// @notice `[s]·(x, y)` in the reduced chart; `s` is reduced mod r (sound for subgroup bases).
    function mul(uint256 s, uint256 x, uint256 y) internal view returns (uint256, uint256) {
        return BabyJubJub.scalarMul(s, x, y);
    }

    /// @notice Horner evaluation `Σ_{k<t} m^k·A_k` of reduced-chart points `A` at a small `m`:
    ///         `acc = A_{t-1}`, then `acc = m·acc + A_k` for k = t-2..0. `scalarMul` skips leading
    ///         zero windows, so each step costs a handful of doublings for m <= 16.
    function horner(uint256[2][16] memory a, uint256 t, uint256 m) internal view returns (uint256 x, uint256 y) {
        x = a[t - 1][0];
        y = a[t - 1][1];
        for (uint256 k = t - 1; k > 0;) {
            unchecked {
                --k;
            }
            (x, y) = BabyJubJub.scalarMul(m, x, y);
            (x, y) = BabyJubJub.pointAdd(x, y, a[k][0], a[k][1]);
        }
    }

    /// @notice Inverse mod r via the modexp precompile (exponent r - 2). `a` must be non-zero mod r.
    function invModR(uint256 a) internal view returns (uint256 o) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0x20)
            mstore(add(ptr, 0x20), 0x20)
            mstore(add(ptr, 0x40), 0x20)
            mstore(add(ptr, 0x60), a)
            mstore(add(ptr, 0x80), R_MINUS_2)
            mstore(add(ptr, 0xa0), R)
            if iszero(staticcall(gas(), 0x05, ptr, 0xc0, ptr, 0x20)) { revert(0, 0) }
            o := mload(ptr)
        }
    }

    /// @notice Lagrange coefficients at zero over F_r for the distinct one-based indexes `set`:
    ///         `λ_i = Π_{h in S, h != i} h·(h - i)^-1 mod r` (protocol §10.3).
    function lagrange(uint8[] calldata set) internal view returns (uint256[] memory lam) {
        uint256 len = set.length;
        lam = new uint256[](len);
        for (uint256 i; i < len; ++i) {
            uint256 xi = set[i];
            uint256 num = 1;
            uint256 den = 1;
            for (uint256 j; j < len; ++j) {
                if (j == i) continue;
                uint256 xj = set[j];
                num = mulmod(num, xj, R);
                den = mulmod(den, addmod(xj, R - xi, R), R);
            }
            lam[i] = mulmod(num, invModR(den), R);
        }
    }
}
