// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {ICouncilCore} from "../src/interfaces/ICouncil.sol";
import {IDealVerifier} from "../src/interfaces/ICouncilVerifiers.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";
import {Bjj} from "./utils/Bjj.sol";

/// @notice deal / finalize / abort (protocol §§8.3–8.5).
contract CouncilDealingTest is CouncilTestBase {
    /// @dev n = 3 members, threshold 2, registration closed.
    function _dealingPhase() internal {
        _create(2, 4);
        _join(1);
        _join(2);
        _join(3);
        _close();
    }

    /// @dev protocol §8.5 public input table, built here from the fixture.
    function _expectedDealPub(DealCall memory d, uint256 j) internal view returns (uint256[87] memory pub) {
        bytes32 ctx = _ctx();
        uint256 n = authSecrets.length;
        pub[0] = uint256(ctx) >> 128;
        pub[1] = uint256(uint128(uint256(ctx)));
        pub[2] = j;
        pub[3] = n;
        pub[4] = T;
        for (uint256 k; k < 16; ++k) {
            pub[5 + 2 * k] = d.C[k][0];
            pub[6 + 2 * k] = d.C[k][1];
        }
        pub[37] = d.E[0];
        pub[38] = d.E[1];
        for (uint256 i; i < 16; ++i) {
            if (i < n) {
                (pub[39 + 2 * i], pub[40 + 2 * i]) = Bjj.mulG(shareSecrets[i]);
            } else {
                (pub[39 + 2 * i], pub[40 + 2 * i]) = (Bjj.GX, Bjj.GY);
            }
            pub[71 + i] = d.masked[i];
        }
    }

    function test_Deal_PublicInputLayout() public {
        _dealingPhase();
        DealCall memory d = _dealMsg(2);
        uint256[87] memory pub = _expectedDealPub(d, 2);
        vm.expectCall(address(dealV), abi.encodeCall(IDealVerifier.verifyProof, (_pA(), _pB(), _pC(), pub)));
        vm.expectEmit(address(manager));
        emit ICouncilCore.DealingAccepted(cid, 2);
        _sendDeal(d);
        CeremonyView memory v = manager.getCeremony(cid);
        assertEq(v.dealtCount, 1);
        assertEq(v.qualBitmap, 2);
        (,, bool dealt) = manager.getParticipantCompressed(cid, 2);
        assertTrue(dealt);
    }

    function test_Deal_Replay() public {
        _dealingPhase();
        DealCall memory d = _dealMsg(1);
        _sendDeal(d);
        vm.expectRevert(AlreadyDealt.selector);
        _sendDeal(d);
        // a second, different dealing by the same dealer is rejected as well
        DealCall memory e = _dealMsg(1);
        e.masked[0] = 12345;
        _signDeal(e, 1);
        vm.expectRevert(AlreadyDealt.selector);
        _sendDeal(e);
    }

    function test_Deal_WrongSigner() public {
        _dealingPhase();
        DealCall memory d = _dealMsg(1);
        d.sig = _sign(authSecrets[1], _hDeal(d.a)); // member 2 signs dealer 1's action
        vm.expectRevert(BadSignature.selector);
        _sendDeal(d);
        d.sig = _sign(orgKey, _hDeal(d.a));
        vm.expectRevert(BadSignature.selector);
        _sendDeal(d);
    }

    function test_Deal_IndexOutOfRange() public {
        _dealingPhase();
        DealCall memory d = _dealMsg(1);
        d.a.dealerIndex = 0;
        d.sig = _sign(authSecrets[0], _hDeal(d.a));
        vm.expectRevert(NotQualified.selector);
        _sendDeal(d);
        d.a.dealerIndex = 4; // n = 3
        d.sig = _sign(authSecrets[0], _hDeal(d.a));
        vm.expectRevert(NotQualified.selector);
        _sendDeal(d);
        d.a.dealerIndex = 17;
        d.sig = _sign(authSecrets[0], _hDeal(d.a));
        vm.expectRevert(NotQualified.selector);
        _sendDeal(d);
    }

    function test_Deal_NonCanonicalWords() public {
        _dealingPhase();
        DealCall memory d = _dealMsg(1);
        d.C[0][0] += P;
        _signDeal(d, 1);
        vm.expectRevert(NonCanonical.selector);
        _sendDeal(d);

        d = _dealMsg(1);
        d.E[1] = P;
        _signDeal(d, 1);
        vm.expectRevert(NonCanonical.selector);
        _sendDeal(d);

        d = _dealMsg(1);
        d.masked[2] = P + d.masked[2];
        _signDeal(d, 1);
        vm.expectRevert(NonCanonical.selector);
        _sendDeal(d);

        // padding slots are range-checked too
        d = _dealMsg(1);
        d.C[15][1] = P + 1;
        _signDeal(d, 1);
        vm.expectRevert(NonCanonical.selector);
        _sendDeal(d);
    }

    function test_Deal_Padding() public {
        _dealingPhase(); // t = 2, n = 3
        DealCall memory d = _dealMsg(1);
        d.C[2][1] = 0; // k = t must be (0, 1)
        _signDeal(d, 1);
        vm.expectRevert(BadPadding.selector);
        _sendDeal(d);

        d = _dealMsg(1);
        d.C[15][0] = 1;
        _signDeal(d, 1);
        vm.expectRevert(BadPadding.selector);
        _sendDeal(d);

        d = _dealMsg(1);
        d.masked[3] = 1; // i = n must be 0
        _signDeal(d, 1);
        vm.expectRevert(BadPadding.selector);
        _sendDeal(d);

        d = _dealMsg(1);
        d.masked[15] = 7;
        _signDeal(d, 1);
        vm.expectRevert(BadPadding.selector);
        _sendDeal(d);
    }

    /// @dev A relayer cannot substitute any component of a signed dealing.
    function test_Deal_PayloadMismatch() public {
        _dealingPhase();
        DealCall memory d = _dealMsg(1);
        d.masked[0] = addmod(d.masked[0], 1, P);
        vm.expectRevert(PayloadMismatch.selector);
        _sendDeal(d);

        d = _dealMsg(1);
        (d.C[1][0], d.C[1][1]) = Bjj.mulG(5);
        vm.expectRevert(PayloadMismatch.selector);
        _sendDeal(d);

        d = _dealMsg(1);
        (d.E[0], d.E[1]) = Bjj.mulG(5);
        vm.expectRevert(PayloadMismatch.selector);
        _sendDeal(d);

        d = _dealMsg(1);
        uint256[2] memory otherA = [uint256(1), 3];
        vm.expectRevert(PayloadMismatch.selector);
        manager.deal(d.a, d.sig, d.C, d.E, d.masked, otherA, _pB(), _pC(), _roster());

        uint256[2][2] memory otherB = [[uint256(4), 3], [uint256(5), 6]]; // G2 limbs swapped
        vm.expectRevert(PayloadMismatch.selector);
        manager.deal(d.a, d.sig, d.C, d.E, d.masked, _pA(), otherB, _pC(), _roster());

        // payload hash signed under another context does not verify here
        d = _dealMsg(1);
        d.a.payloadHash =
            keccak256(abi.encode(TAG_DEAL_PAYLOAD, bytes32(uint256(1)), d.C, d.E, d.masked, _pA(), _pB(), _pC()));
        d.sig = _sign(authSecrets[0], _hDeal(d.a));
        vm.expectRevert(PayloadMismatch.selector);
        _sendDeal(d);
    }

    /// @dev Proof words live in the BN254 base field (> p): never reduced or rejected against p.
    function test_Deal_ProofWordsNotRangeCheckedAgainstP() public {
        _dealingPhase();
        DealCall memory d = _dealMsg(1);
        uint256[2] memory a = [P + 1, Q_BN - 1];
        uint256[2][2] memory b = [[Q_BN - 2, P], [P + 7, Q_BN - 3]];
        uint256[2] memory c = [Q_BN - 4, P + 2];
        d.a.payloadHash = keccak256(abi.encode(TAG_DEAL_PAYLOAD, _ctx(), d.C, d.E, d.masked, a, b, c));
        d.sig = _sign(authSecrets[0], _hDeal(d.a));
        vm.expectCall(address(dealV), abi.encodeCall(IDealVerifier.verifyProof, (a, b, c, _expectedDealPub(d, 1))));
        manager.deal(d.a, d.sig, d.C, d.E, d.masked, a, b, c, _roster());
        assertEq(manager.getQual(cid), 1);
    }

    /// @dev Every proof word must be < qBN (a word >= qBN is either rejected by the pairing
    ///      precompile or, for pA.y, an alias of a valid word); checked before the verifier call.
    function test_Deal_ProofWordsMustBeBelowQBN() public {
        _dealingPhase();
        DealCall memory d = _dealMsg(1);
        bytes32 ctx = _ctx();
        for (uint256 w; w < 8; ++w) {
            (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proofWith(w, Q_BN);
            d.a.payloadHash = keccak256(abi.encode(TAG_DEAL_PAYLOAD, ctx, d.C, d.E, d.masked, a, b, c));
            d.sig = _sign(authSecrets[0], _hDeal(d.a));
            vm.expectRevert(NonCanonical.selector);
            manager.deal(d.a, d.sig, d.C, d.E, d.masked, a, b, c, _roster());
        }
        // qBN - 1 in every position is in range
        (uint256[2] memory a2, uint256[2][2] memory b2, uint256[2] memory c2) = _proofWith(0, Q_BN - 1);
        a2[1] = Q_BN - 1;
        b2 = [[Q_BN - 1, Q_BN - 1], [Q_BN - 1, Q_BN - 1]];
        c2 = [Q_BN - 1, Q_BN - 1];
        d.a.payloadHash = keccak256(abi.encode(TAG_DEAL_PAYLOAD, ctx, d.C, d.E, d.masked, a2, b2, c2));
        d.sig = _sign(authSecrets[0], _hDeal(d.a));
        manager.deal(d.a, d.sig, d.C, d.E, d.masked, a2, b2, c2, _roster());
    }

    function test_Deal_ProofRejectedChangesNothing() public {
        _dealingPhase();
        DealCall memory d = _dealMsg(1);
        dealV.setAccept(false);
        vm.expectRevert(ProofInvalid.selector);
        _sendDeal(d);
        assertEq(manager.getCeremony(cid).dealtCount, 0);
        vm.expectRevert(NotQualified.selector);
        manager.getRecoveryDealing(cid, 1);
        dealV.setAccept(true);
        _sendDeal(d);
        assertEq(manager.getCeremony(cid).dealtCount, 1);
    }

    function test_Deal_PhaseAndExpiry() public {
        _create(2, 3);
        _join(1);
        _join(2);
        // registration still open: no ctx, no dealing
        DealCall memory early;
        early.a = Deal(cid, 1, bytes32(0), validUntil);
        early.sig = _sign(authSecrets[0], _hDeal(early.a));
        vm.expectRevert(WrongPhase.selector);
        _sendDeal(early);

        _close();
        DealCall memory d = _dealMsg(1);
        d.a.validUntil = uint64(block.timestamp) - 1;
        d.sig = _sign(authSecrets[0], _hDeal(d.a));
        vm.expectRevert(Expired.selector);
        _sendDeal(d);

        d = _dealMsg(1);
        vm.warp(T0 + DEAL_DURATION + 1);
        vm.expectRevert(Expired.selector);
        _sendDeal(d);
        vm.warp(T0 + DEAL_DURATION);
        _sendDeal(d); // the deadline itself is open
        _deal(2);
        manager.finalize(cid);
        DealCall memory late = _dealMsg(2);
        vm.expectRevert(WrongPhase.selector);
        _sendDeal(late);
    }

    // ─── finalize ─────────────────────────────────────────────────────────────────────────

    function test_Finalize_Conditions() public {
        _create(2, 4);
        vm.expectRevert(WrongPhase.selector);
        manager.finalize(cid);
        for (uint256 i = 1; i <= 4; ++i) {
            _join(i);
        }
        _close();
        vm.expectRevert(FinalizeConditionNotMet.selector);
        manager.finalize(cid);
        _deal(1);
        _deal(4);
        // |QUAL| >= t but the deadline has not passed and QUAL can still grow
        vm.expectRevert(FinalizeConditionNotMet.selector);
        manager.finalize(cid);
        vm.warp(T0 + DEAL_DURATION);
        vm.expectRevert(FinalizeConditionNotMet.selector);
        manager.finalize(cid);
        vm.warp(T0 + DEAL_DURATION + 1);
        (uint256 px, uint256 py) = Bjj.mulG(addmod(coef[1][0], coef[4][0], R));
        vm.expectEmit(address(manager));
        emit ICouncilCore.CeremonyFinalized(cid, 9, px, py);
        manager.finalize(cid);
        vm.expectRevert(WrongPhase.selector);
        manager.finalize(cid);
    }

    function test_Finalize_BelowThresholdAfterDeadline() public {
        _create(3, 4);
        for (uint256 i = 1; i <= 4; ++i) {
            _join(i);
        }
        _close();
        _deal(1);
        _deal(2);
        vm.warp(T0 + DEAL_DURATION + 1);
        vm.expectRevert(FinalizeConditionNotMet.selector);
        manager.finalize(cid);
        manager.abort(cid);
        assertEq(manager.getCeremony(cid).phase, uint8(Phase.Aborted));
    }

    function test_Finalize_EarlyWhenEveryoneDealt() public {
        _dealingPhase();
        _deal(1);
        _deal(2);
        _deal(3);
        manager.finalize(cid);
        assertEq(manager.getCeremony(cid).phase, uint8(Phase.Live));
    }

    /// @dev t = 1 makes every PK_m = P: Horner's single-coefficient case.
    function test_Finalize_ThresholdOne() public {
        _create(1, 2);
        _join(1);
        _join(2);
        _close();
        _deal(1);
        _deal(2);
        manager.finalize(cid);
        (uint256 px, uint256 py) = manager.getPublicKey(cid);
        (uint256 k1x, uint256 k1y) = manager.getMemberKey(cid, 1);
        (uint256 k2x, uint256 k2y) = manager.getMemberKey(cid, 2);
        assertEq(k1x, px);
        assertEq(k1y, py);
        assertEq(k2x, px);
        assertEq(k2y, py);
    }

    /// @dev P = O is aborted, never stored as a key (protocol §8.4 defense in depth).
    function test_Finalize_IdentityKeyAborts() public {
        _create(1, 2);
        _join(1);
        _join(2);
        _close();
        DealCall memory d1 = _dealMsg(1);
        _sendDeal(d1);
        DealCall memory d2 = _dealMsg(2);
        (d2.C[0][0], d2.C[0][1]) = Bjj.neg(d1.C[0][0], d1.C[0][1]);
        _signDeal(d2, 2);
        _sendDeal(d2);
        vm.expectEmit(address(manager));
        emit ICouncilCore.CeremonyAborted(cid, uint8(Phase.Dealing));
        manager.finalize(cid);
        assertEq(manager.getCeremony(cid).phase, uint8(Phase.Aborted));
        vm.expectRevert(WrongPhase.selector);
        manager.getPublicKey(cid);
    }

    // ─── abort ────────────────────────────────────────────────────────────────────────────

    /// @dev Below t at the expiry: abortable from the expiry itself (closing is impossible).
    function test_Abort_Registration() public {
        _create(2, 3);
        _join(1);
        vm.expectRevert(AbortConditionNotMet.selector);
        manager.abort(cid);
        vm.warp(T0 + REG_PERIOD - 1);
        vm.expectRevert(AbortConditionNotMet.selector);
        manager.abort(cid);
        vm.warp(T0 + REG_PERIOD);
        vm.expectRevert(BelowThreshold.selector);
        _closeScheduled();
        vm.expectEmit(address(manager));
        emit ICouncilCore.CeremonyAborted(cid, uint8(Phase.Registration));
        manager.abort(cid);
        vm.expectRevert(WrongPhase.selector);
        manager.abort(cid);
        (CloseRegistration memory a, bytes memory sig) = _closeMsg(1);
        vm.expectRevert(WrongPhase.selector);
        manager.closeRegistration(a, sig, _roster());

        // restart: a new ceremony id with a fresh nonce
        bytes12 old = cid;
        _create(2, 3);
        assertTrue(cid != old);
        _join(1);
    }

    function test_Abort_Dealing() public {
        _create(2, 3);
        _join(1);
        _join(2);
        _join(3);
        _close();
        _deal(3);
        vm.expectRevert(AbortConditionNotMet.selector);
        manager.abort(cid);
        vm.warp(T0 + DEAL_DURATION + 1);
        vm.expectEmit(address(manager));
        emit ICouncilCore.CeremonyAborted(cid, uint8(Phase.Dealing));
        manager.abort(cid);
        DealCall memory d = _dealMsg(1);
        vm.expectRevert(WrongPhase.selector);
        _sendDeal(d);
        vm.expectRevert(WrongPhase.selector);
        manager.finalize(cid);
        // accepted contributions stay readable under the old id
        manager.getRecoveryDealing(cid, 3);
    }

    function test_Abort_QualifiedDealingCannotAbort() public {
        _dealingPhase();
        _deal(1);
        _deal(2);
        vm.warp(T0 + DEAL_DURATION + 1);
        vm.expectRevert(AbortConditionNotMet.selector);
        manager.abort(cid);
        manager.finalize(cid);
        vm.expectRevert(WrongPhase.selector);
        manager.abort(cid);
    }
}
