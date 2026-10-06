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

    /// @notice Horner evaluation `Σ_{k<t} m^k·A_k` of reduced-chart points `A` at a small `m`, in
    ///         extended coordinates with a single inversion (same result as the affine
    ///         `acc = m·acc + A_k` recurrence).
    function horner(uint256[2][16] memory a, uint256 t, uint256 m) internal view returns (uint256 x, uint256 y) {
        uint256 pts = alloc(t + 1);
        for (uint256 k; k < t; ++k) {
            setAffine(at(pts, k), a[k][0], a[k][1]);
        }
        hornerExt(pts, t, m, at(pts, t), t + 1);
        normalize(pts + t * 0x80, 1, t + 1, pts);
        return affineAt(pts, t);
    }

    // ─── Extended coordinates (reduced chart, a = -1) ────────────────────────────────────────
    //
    // A point (X : Y : Z : T), x = X/Z, y = Y/Z, T = X·Y/Z, is four consecutive memory words at
    // a pointer. `alloc(count)` lays out `count` points (initialised to the identity), one
    // scratch point after them and `count` scratch words for the batch inversion. The formulas
    // are the unified HWCD ones the vendored library uses (complete on this curve), without its
    // per-operation allocation and inversion: finalize inverts once in total.

    /// @dev 2·d of the reduced chart (== BabyJubJub.TWO_D).
    uint256 internal constant TWO_D = 2475045175004185027501911298141836274980133961483913877536377848625489762075;
    /// @dev p - 2: Fermat exponent for inverses mod p.
    uint256 internal constant P_MINUS_2 = 21888242871839275222246405745257275088548364400416034343698204186575808495615;

    /// @notice Allocate `count` identity points plus scratch; returns the first point's pointer.
    function alloc(uint256 count) internal pure returns (uint256 pts) {
        uint256[] memory buf = new uint256[](4 * count + 4 + count);
        assembly ("memory-safe") {
            pts := add(buf, 0x20)
        }
        for (uint256 i; i < count; ++i) {
            uint256 q = pts + i * 0x80;
            assembly ("memory-safe") {
                mstore(add(q, 0x20), 1)
                mstore(add(q, 0x40), 1)
            }
        }
    }

    function at(uint256 pts, uint256 i) internal pure returns (uint256) {
        return pts + i * 0x80;
    }

    function setAffine(uint256 r, uint256 x, uint256 y) internal pure {
        assembly ("memory-safe") {
            mstore(r, x)
            mstore(add(r, 0x20), y)
            mstore(add(r, 0x40), 1)
            mstore(add(r, 0x60), mulmod(x, y, P))
        }
    }

    /// @notice X == 0 and Y == Z: the identity (the order-2 point has Y == -Z).
    function isIdentity(uint256 r) internal pure returns (bool id) {
        assembly ("memory-safe") {
            let z := mload(add(r, 0x40))
            id := and(iszero(mload(r)), and(eq(mload(add(r, 0x20)), z), iszero(iszero(z))))
        }
    }

    /// @notice r = r + (x, y) for an affine point (x, y), x, y < p.
    function addAffine(uint256 r, uint256 x, uint256 y) internal pure {
        assembly ("memory-safe") {
            let q := P
            let x1 := mload(r)
            let y1 := mload(add(r, 0x20))
            let a := mulmod(addmod(y1, sub(q, x1), q), addmod(y, sub(q, x), q), q)
            let b := mulmod(addmod(y1, x1, q), addmod(y, x, q), q)
            let c := mulmod(mulmod(mload(add(r, 0x60)), TWO_D, q), mulmod(x, y, q), q)
            let d := mload(add(r, 0x40))
            d := addmod(d, d, q)
            let e := addmod(b, sub(q, a), q)
            let h := addmod(b, a, q)
            let f := addmod(d, sub(q, c), q)
            let g := addmod(d, c, q)
            mstore(r, mulmod(e, f, q))
            mstore(add(r, 0x20), mulmod(g, h, q))
            mstore(add(r, 0x40), mulmod(f, g, q))
            mstore(add(r, 0x60), mulmod(e, h, q))
        }
    }

    /// @notice r = r + s (both extended; r != s).
    function addExt(uint256 r, uint256 s) internal pure {
        assembly ("memory-safe") {
            let q := P
            let x1 := mload(r)
            let y1 := mload(add(r, 0x20))
            let x2 := mload(s)
            let y2 := mload(add(s, 0x20))
            let a := mulmod(addmod(y1, sub(q, x1), q), addmod(y2, sub(q, x2), q), q)
            let b := mulmod(addmod(y1, x1, q), addmod(y2, x2, q), q)
            let c := mulmod(mulmod(mload(add(r, 0x60)), TWO_D, q), mload(add(s, 0x60)), q)
            let d := mulmod(mload(add(r, 0x40)), mload(add(s, 0x40)), q)
            d := addmod(d, d, q)
            let e := addmod(b, sub(q, a), q)
            let h := addmod(b, a, q)
            let f := addmod(d, sub(q, c), q)
            let g := addmod(d, c, q)
            mstore(r, mulmod(e, f, q))
            mstore(add(r, 0x20), mulmod(g, h, q))
            mstore(add(r, 0x40), mulmod(f, g, q))
            mstore(add(r, 0x60), mulmod(e, h, q))
        }
    }

    /// @notice r = 2·r (dbl-2008-hwcd, valid for every curve point).
    function dblExt(uint256 r) internal pure {
        assembly ("memory-safe") {
            let q := P
            let x := mload(r)
            let y := mload(add(r, 0x20))
            let e := addmod(x, y, q)
            let a := mulmod(x, x, q)
            let b := mulmod(y, y, q)
            let ab := addmod(a, b, q)
            let g := addmod(b, sub(q, a), q)
            e := addmod(mulmod(e, e, q), sub(q, ab), q)
            let h := sub(q, ab)
            let c := mload(add(r, 0x40))
            c := mulmod(c, c, q)
            c := addmod(c, c, q)
            let f := addmod(g, sub(q, c), q)
            mstore(r, mulmod(e, f, q))
            mstore(add(r, 0x20), mulmod(g, h, q))
            mstore(add(r, 0x40), mulmod(f, g, q))
            mstore(add(r, 0x60), mulmod(e, h, q))
        }
    }

    function _copy(uint256 dst, uint256 src) private pure {
        assembly ("memory-safe") {
            mstore(dst, mload(src))
            mstore(add(dst, 0x20), mload(add(src, 0x20)))
            mstore(add(dst, 0x40), mload(add(src, 0x40)))
            mstore(add(dst, 0x60), mload(add(src, 0x60)))
        }
    }

    /// @notice out = Σ_{k<t} m^k·A_k for the extended points A_k at `pts` (Horner, MSB-first
    ///         double-and-add on the small m >= 1). `count` is the alloc() size (scratch point).
    function hornerExt(uint256 pts, uint256 t, uint256 m, uint256 out, uint256 count) internal pure {
        uint256 base = pts + count * 0x80;
        uint256 top;
        for (uint256 v = m; v > 1; v >>= 1) {
            ++top;
        }
        _copy(out, pts + (t - 1) * 0x80);
        for (uint256 k = t - 1; k > 0;) {
            unchecked {
                --k;
            }
            if (m > 1) {
                _copy(base, out);
                for (uint256 b = top; b > 0;) {
                    unchecked {
                        --b;
                    }
                    dblExt(out);
                    if ((m >> b) & 1 == 1) addExt(out, base);
                }
            }
            addExt(out, pts + k * 0x80);
        }
    }

    /// @notice In-place batch conversion of `len` points from `first` to affine (X, Y := x, y) with
    ///         one modexp inversion (Montgomery's trick). `count`/`pts` locate the alloc() scratch.
    ///         Fails closed with `InvalidPoint()` if any Z is 0: the formulas are complete on the
    ///         curve, so that is unreachable from on-curve inputs, and inverting 0 would otherwise
    ///         silently turn every point of the batch into (0, 0).
    function normalize(uint256 first, uint256 len, uint256 count, uint256 pts) internal view {
        uint256 pre = pts + (count + 1) * 0x80;
        uint256 acc = 1;
        for (uint256 i; i < len; ++i) {
            uint256 r = first + i * 0x80;
            assembly ("memory-safe") {
                acc := mulmod(acc, mload(add(r, 0x40)), P)
                mstore(add(pre, mul(i, 0x20)), acc)
            }
        }
        if (acc == 0) revert InvalidPoint();
        uint256 inv = _invModP(acc);
        for (uint256 i = len; i > 0;) {
            unchecked {
                --i;
            }
            uint256 r = first + i * 0x80;
            assembly ("memory-safe") {
                let zi := inv
                if i { zi := mulmod(inv, mload(add(pre, mul(sub(i, 1), 0x20))), P) }
                inv := mulmod(inv, mload(add(r, 0x40)), P)
                mstore(r, mulmod(mload(r), zi, P))
                mstore(add(r, 0x20), mulmod(mload(add(r, 0x20)), zi, P))
                mstore(add(r, 0x40), 1)
            }
        }
    }

    function affineAt(uint256 pts, uint256 i) internal pure returns (uint256 x, uint256 y) {
        uint256 r = pts + i * 0x80;
        assembly ("memory-safe") {
            x := mload(r)
            y := mload(add(r, 0x20))
        }
    }

    function _invModP(uint256 a) private view returns (uint256 o) {
        assembly ("memory-safe") {
            let ptr := mload(0x40)
            mstore(ptr, 0x20)
            mstore(add(ptr, 0x20), 0x20)
            mstore(add(ptr, 0x40), 0x20)
            mstore(add(ptr, 0x60), a)
            mstore(add(ptr, 0x80), P_MINUS_2)
            mstore(add(ptr, 0xa0), P)
            if iszero(staticcall(gas(), 0x05, ptr, 0xc0, ptr, 0x20)) { revert(0, 0) }
            o := mload(ptr)
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
