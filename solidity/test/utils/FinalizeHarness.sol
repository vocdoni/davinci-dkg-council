// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {BabyJubJub} from "../../src/libraries/BabyJubJub.sol";
import "../../src/CouncilTypes.sol";
import {CouncilManager} from "../../src/CouncilManager.sol";
import {CouncilStorage} from "../../src/CouncilStorage.sol";
import {CouncilCurve} from "../../src/libraries/CouncilCurve.sol";
import {ICouncilCore} from "../../src/interfaces/ICouncil.sol";

/// @notice Writes a ceremony in Dealing straight into the CouncilStorage layout (no join, no
///         proofs) and reads back the raw finalize outputs, padding included.
abstract contract FinalizeSeeder is CouncilStorage {
    /// @dev `C[j][k]` (TE) is stored as dealer j+1's commitment k for every j < n, k < t, in QUAL
    ///      or not, like `deal` stores it; the dealing deadline is in the past and dealtCount =
    ///      |QUAL|, so `finalize` runs whenever |QUAL| >= t.
    function seed(bytes12 cid, uint8 n, uint8 t, uint16 qual, uint256[2][16][16] calldata C) external {
        Ceremony storage c = _ceremonies[cid];
        c.phase = Phase.Dealing;
        c.n = n;
        c.t = t;
        c.qualBitmap = qual;
        uint8 dealt;
        for (uint256 j; j < n; ++j) {
            if ((qual >> j) & 1 == 1) ++dealt;
            for (uint256 k; k < t; ++k) {
                c.dealings[j].C[k][0] = C[j][k][0];
                c.dealings[j].C[k][1] = C[j][k][1];
            }
        }
        c.dealtCount = dealt;
        c.dealingDeadline = 0;
    }

    function raw(bytes12 cid)
        external
        view
        returns (Phase phase, uint256[2][16] memory aggregates, uint256[2][16] memory memberKeys)
    {
        Ceremony storage c = _ceremonies[cid];
        return (c.phase, c.aggregates, c.memberKeys);
    }
}

/// @notice The current CouncilManager, seedable.
contract FinalizeHarness is CouncilManager, FinalizeSeeder {
    constructor(address d, address p, bytes32 id) CouncilManager(d, p, id) {}
}

/// @notice Differential oracle: CouncilManager.finalize and CouncilCurve.horner as they were
///         before finalize moved to extended coordinates (affine, one modexp inversion per
///         BabyJubJub.pointAdd / scalarMul), copied verbatim. Test-only.
contract AffineFinalizeOracle is FinalizeSeeder {
    function finalize(bytes12 cid) external {
        Ceremony storage c = _existing(cid);
        if (c.phase != Phase.Dealing) revert WrongPhase();
        uint256 n = c.n;
        uint256 t = c.t;
        uint256 dealt = c.dealtCount;
        if (dealt != n && (block.timestamp <= c.dealingDeadline || dealt < t)) revert FinalizeConditionNotMet();
        uint256 qual = c.qualBitmap;

        // A_k = Σ_{j in QUAL} C_{j,k}, reduced chart.
        uint256[2][16] memory agg;
        for (uint256 k; k < t; ++k) {
            uint256 x = 0;
            uint256 y = 1;
            for (uint256 j; j < n; ++j) {
                if ((qual >> j) & 1 == 0) continue;
                uint256[2] storage ck = c.dealings[j].C[k];
                (x, y) = CouncilCurve.add(x, y, CouncilCurve.toReduced(ck[0]), ck[1]);
            }
            agg[k][0] = x;
            agg[k][1] = y;
        }
        if (agg[0][0] == 0 && agg[0][1] == 1) {
            // P = O: defense in depth (protocol §8.4).
            c.phase = Phase.Aborted;
            emit ICouncilCore.CeremonyAborted(cid, uint8(Phase.Dealing));
            return;
        }
        for (uint256 k; k < t; ++k) {
            c.aggregates[k][0] = CouncilCurve.toTE(agg[k][0]);
            c.aggregates[k][1] = agg[k][1];
        }
        for (uint256 m = 1; m <= n; ++m) {
            (uint256 x, uint256 y) = horner(agg, t, m);
            c.memberKeys[m - 1][0] = CouncilCurve.toTE(x);
            c.memberKeys[m - 1][1] = y;
        }
        c.phase = Phase.Live;
        emit ICouncilCore.CeremonyFinalized(cid, uint16(qual), c.aggregates[0][0], agg[0][1]);
    }

    /// @dev `acc = A_{t-1}`, then `acc = m·acc + A_k` for k = t-2..0, affine.
    function horner(uint256[2][16] memory a, uint256 t, uint256 m) public view returns (uint256 x, uint256 y) {
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
}
