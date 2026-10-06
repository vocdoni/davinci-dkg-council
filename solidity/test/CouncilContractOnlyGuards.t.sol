// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";
import {Bjj} from "./utils/Bjj.sol";

/// @notice Regressions for the inputs the circuits do not guard and only the contract does
///         (adversarial circuit review): a member key with x = 0 would make its mask computable
///         from public data; a request base C1 = (0, p-1) admits D = O; a C1 carrying a torsion
///         component makes D leak s mod 8. The manager refuses all of them (and the same for C2).
contract CouncilContractOnlyGuardsTest is CouncilTestBase {
    /// @dev A point of order exactly 8 on circomlib BabyJubJub (TE): r·Q for a curve point Q
    ///      outside the prime subgroup.
    uint256 internal constant T8X = 17545522957889784193459637215142187266023652151580582754000402781682644312291;
    uint256 internal constant T8Y = 17061719626832259898845741003733890968968767993363194771977168648564009544074;

    function test_TorsionPointFixture() public view {
        assertTrue(Bjj.onCurveTE(T8X, T8Y));
        (uint256 x4, uint256 y4) = Bjj.mul(4, T8X, T8Y);
        assertFalse(x4 == 0 && y4 == 1, "order divides 4");
        assertEq(x4, 0, "4*T8 is the order-2 point (0, -1)");
        assertEq(y4, P - 1);
        (uint256 x8, uint256 y8) = Bjj.mul(8, T8X, T8Y);
        assertEq(x8, 0);
        assertEq(y8, 1);
    }

    function _joinWithKey(uint256 x, uint256 y, bytes4 err) internal {
        uint256 auth = _memberAuth(1);
        JoinCall memory j = _joinMsg(1, 0, auth, _memberShareKey(1));
        j.a.pkX = x;
        j.a.pkY = y;
        j.inv.pkX = x;
        j.inv.pkY = y;
        j.psig = _sign(auth, _hJoin(j.a));
        j.isig = _sign(inviteSecrets[0], _hInvite(j.inv));
        vm.expectRevert(err);
        _sendJoin(j);
    }

    /// @dev (1) member keys with x = 0 and torsion-shifted keys are refused at join.
    function test_Join_RefusesXZeroAndTorsionKeys() public {
        _create(2, 3);
        _joinWithKey(0, 1, InvalidPoint.selector); // identity O
        _joinWithKey(0, P - 1, NotInSubgroup.selector); // order 2
        _joinWithKey(T8X, T8Y, NotInSubgroup.selector); // order 8
        (uint256 X0, uint256 X1) = Bjj.mulG(_memberShareKey(1));
        (uint256 sx, uint256 sy) = Bjj.add(X0, X1, T8X, T8Y);
        _joinWithKey(sx, sy, NotInSubgroup.selector); // X + T8
        _join(1); // the honest key is accepted
    }

    function _requestWith(uint256 field, uint256 word, uint256 x, uint256 y, bytes4 err) internal {
        uint256[4][] memory c = new uint256[4][](cts.length);
        for (uint256 k; k < cts.length; ++k) {
            c[k] = cts[k];
        }
        c[field][word] = x;
        c[field][word + 1] = y;
        vm.expectRevert(err);
        manager.submitRequest(cid, pid, c);
    }

    /// @dev (2) C1 / C2 = (0, p-1) and (3) C1 / C2 shifted by an order-8 point are refused at
    ///      request admission; identity C1 / C2 too.
    function test_Request_RefusesLowOrderAndTorsionCiphertexts() public {
        _toLive(3, 2);
        _allow(address(this));
        _authorize(creator);
        pid = bytes31(uint248(3));
        (requestId,,) = manager.bindProcess(cid, pid, creator);
        _encrypt(_u64s(1, 2, 3));
        for (uint256 word; word <= 2; word += 2) {
            _requestWith(0, word, 0, P - 1, NotInSubgroup.selector);
            _requestWith(2, word, 0, 1, InvalidPoint.selector);
            _requestWith(1, word, T8X, T8Y, NotInSubgroup.selector);
            (uint256 sx, uint256 sy) = Bjj.add(cts[1][word], cts[1][word + 1], T8X, T8Y);
            _requestWith(1, word, sx, sy, NotInSubgroup.selector);
            (uint256 x4, uint256 y4) = Bjj.mul(2, T8X, T8Y); // order 4
            _requestWith(0, word, x4, y4, NotInSubgroup.selector);
        }
        uint256[4][] memory ok = new uint256[4][](cts.length);
        for (uint256 k; k < cts.length; ++k) {
            ok[k] = cts[k];
        }
        manager.submitRequest(cid, pid, ok);
    }
}
