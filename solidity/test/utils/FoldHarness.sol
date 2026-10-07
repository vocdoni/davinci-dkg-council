// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {BabyJubJub} from "../../src/libraries/BabyJubJub.sol";
import "../../src/CouncilTypes.sol";
import {CouncilManager} from "../../src/CouncilManager.sol";
import {CouncilCurve} from "../../src/libraries/CouncilCurve.sol";

/// @notice The real CouncilManager with the protocol §8.3 incremental aggregation exposed: a
///         ceremony in Dealing is written straight into storage (no join, no proofs) and
///         `fold` runs exactly the `_fold` step `deal` runs after a dealing's proof verified,
///         followed by the same QUAL / dealt-count bookkeeping. `finalize`, `getAggregates`,
///         `getMemberKey` and every other view are the production code paths.
contract FoldHarness is CouncilManager {
    constructor(address d, address p, bytes32 id) CouncilManager(d, p, id) {}

    /// @dev Dealing phase, deadline in the past (finalize runs once |QUAL| >= t).
    function seed(bytes12 cid, uint8 n, uint8 t) external {
        Ceremony storage c = _ceremonies[cid];
        c.phase = Phase.Dealing;
        c.n = n;
        c.t = t;
        c.dealingDeadline = 0;
    }

    /// @dev Folds dealer `j`'s commitments `C` (TE) into the aggregates, as an accepted `deal`.
    function fold(bytes12 cid, uint8 j, uint256[2][16] calldata C) external {
        Ceremony storage c = _ceremonies[cid];
        _fold(c, C, c.t);
        c.qualBitmap |= uint16(1 << (j - 1));
        ++c.dealtCount;
    }

    /// @dev The raw biased aggregate slots (x + 1, y + 1), padding included (zero = unset).
    function rawAggregates(bytes12 cid) external view returns (uint256[2][16] memory biased) {
        Ceremony storage c = _ceremonies[cid];
        for (uint256 k; k < 16; ++k) {
            biased[k][0] = c.aggregatesBiased[k][0];
            biased[k][1] = c.aggregatesBiased[k][1];
        }
    }

    function phaseOf(bytes12 cid) external view returns (Phase) {
        return _ceremonies[cid].phase;
    }
}

/// @notice Differential oracle: v1's batch aggregation over stored per-dealer commitments and
///         its member keys, as the affine v1 finalize computed them (one modexp inversion per
///         BabyJubJub.pointAdd / scalarMul), copied from the v1 test oracle. Test-only.
contract AffineAggregationOracle {
    /// @dev A_k = Σ_{j in QUAL} C_{j,k} (TE in, TE out) for k < t; identity padding above.
    function aggregate(uint256[2][16][16] memory C, uint256 n, uint256 t, uint256 qual)
        public
        view
        returns (uint256[2][16] memory A)
    {
        for (uint256 k; k < 16; ++k) {
            uint256 x = 0;
            uint256 y = 1;
            if (k < t) {
                for (uint256 j; j < n; ++j) {
                    if ((qual >> j) & 1 == 0) continue;
                    (x, y) = CouncilCurve.add(x, y, CouncilCurve.toReduced(C[j][k][0]), C[j][k][1]);
                }
            }
            A[k][0] = CouncilCurve.toTE(x);
            A[k][1] = y;
        }
    }

    /// @dev PK_m = Horner(A, m) (TE in, TE out): `acc = A_{t-1}`, then `acc = m·acc + A_k`, affine.
    function memberKey(uint256[2][16] memory A, uint256 t, uint256 m) public view returns (uint256 x, uint256 y) {
        x = CouncilCurve.toReduced(A[t - 1][0]);
        y = A[t - 1][1];
        for (uint256 k = t - 1; k > 0;) {
            unchecked {
                --k;
            }
            (x, y) = BabyJubJub.scalarMul(m, x, y);
            (x, y) = BabyJubJub.pointAdd(x, y, CouncilCurve.toReduced(A[k][0]), A[k][1]);
        }
        x = CouncilCurve.toTE(x);
    }
}
