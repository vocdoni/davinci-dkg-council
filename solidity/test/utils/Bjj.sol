// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {BabyJubJub} from "../../src/libraries/BabyJubJub.sol";

/// @notice Test-side BabyJubJub helpers in the circomlib TE chart. The arithmetic itself runs in
///         the vendored reduced-chart library; `onCurveTE` is an independent check of the TE
///         equation used to cross-check the chart map.
library Bjj {
    uint256 internal constant P = 21888242871839275222246405745257275088548364400416034343698204186575808495617;
    uint256 internal constant R = 2736030358979909402780800718157159386076813972158567259200215660948447373041;
    uint256 internal constant K = 15527681003928902128179717624703512672403908117992798440346960750464748824729;
    uint256 internal constant K_INV = 1911982854305225074381251344103329931637610209014896889891168275855466657090;
    uint256 internal constant GX = 5299619240641551281634865583518297030282874472190772894086521144482721001553;
    uint256 internal constant GY = 16950150798460657717958625567821834550301663161624707787222815936182638968203;
    uint256 internal constant A_TE = 168700;
    uint256 internal constant D_TE = 168696;

    function toRed(uint256 x) internal pure returns (uint256) {
        return mulmod(x, K, P);
    }

    function toTE(uint256 x) internal pure returns (uint256) {
        return mulmod(x, K_INV, P);
    }

    function mulG(uint256 s) internal view returns (uint256 x, uint256 y) {
        return mul(s, GX, GY);
    }

    function mul(uint256 s, uint256 x, uint256 y) internal view returns (uint256, uint256) {
        (uint256 xr, uint256 yr) = BabyJubJub.scalarMul(s, toRed(x), y);
        return (toTE(xr), yr);
    }

    function add(uint256 x1, uint256 y1, uint256 x2, uint256 y2) internal view returns (uint256, uint256) {
        (uint256 xr, uint256 yr) = BabyJubJub.pointAdd(toRed(x1), y1, toRed(x2), y2);
        return (toTE(xr), yr);
    }

    function neg(uint256 x, uint256 y) internal pure returns (uint256, uint256) {
        return (x == 0 ? 0 : P - x, y);
    }

    /// @dev a·x² + y² == 1 + d·x²·y² in the circomlib chart, computed directly.
    function onCurveTE(uint256 x, uint256 y) internal pure returns (bool) {
        if (x >= P || y >= P) return false;
        uint256 x2 = mulmod(x, x, P);
        uint256 y2 = mulmod(y, y, P);
        uint256 lhs = addmod(mulmod(A_TE, x2, P), y2, P);
        uint256 rhs = addmod(1, mulmod(D_TE, mulmod(x2, y2, P), P), P);
        return lhs == rhs;
    }

    /// @dev Polynomial with coefficients `a[0..t-1]` evaluated at `z` over F_r.
    function evalPoly(uint256[16] memory a, uint256 t, uint256 z) internal pure returns (uint256 acc) {
        for (uint256 k = t; k > 0; --k) {
            acc = addmod(mulmod(acc, z, R), a[k - 1], R);
        }
    }
}
