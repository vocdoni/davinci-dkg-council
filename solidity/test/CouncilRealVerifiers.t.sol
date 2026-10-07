// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {CouncilManager} from "../src/CouncilManager.sol";
import {DealVerifier} from "../src/verifiers/DealVerifier.sol";
import {PartialVerifier} from "../src/verifiers/PartialVerifier.sol";
import {VectorReplay} from "./utils/VectorReplay.sol";

/// @notice The generated snarkjs verifiers (architecture §1.6) with the canned proofs of
///         `circuits/fixtures/`: bytecode and release-id pins, every fixture proof
///         verifies, every single public-signal and proof-word perturbation fails (87 + 67), the
///         manager turns a verifier rejection into `ProofInvalid()` for tampered dealings and
///         partials that are otherwise correctly signed, and it refuses the second encoding of a
///         valid proof that the verifier itself accepts (proof words must be < qBN). Release and
///         bytecode pins live in CouncilDeploy.t.sol.
contract CouncilRealVerifiersTest is VectorReplay {
    DealVerifier internal dv;
    PartialVerifier internal pv;

    function setUp() public override {
        super.setUp();
        dv = new DealVerifier();
        pv = new PartialVerifier();
    }

    function _dealPub(string memory fx, uint256 i) internal returns (uint256[87] memory pub) {
        _proof(fx, _k(".dealings", i, ".proof"));
        uint256[] memory a = vm.parseJsonUintArray(fx, _k(".dealings", i, ".pubSignals"));
        assertEq(a.length, 87);
        for (uint256 j; j < 87; ++j) {
            pub[j] = a[j];
        }
    }

    function _partialPub(string memory fx, uint256 i) internal returns (uint256[67] memory pub) {
        _proof(fx, _k(".partials", i, ".proof"));
        uint256[] memory a = vm.parseJsonUintArray(fx, _k(".partials", i, ".pubSignals"));
        assertEq(a.length, 67);
        for (uint256 j; j < 67; ++j) {
            pub[j] = a[j];
        }
    }

    // ─── Verifiers against the fixtures ───────────────────────────────────────────────────

    function test_Real_EveryFixtureProofVerifies() public {
        string[2] memory names = ["A", "B"];
        for (uint256 s; s < 2; ++s) {
            string memory dfx = _load(string.concat(FIXTURES, "deal_", names[s], ".json"));
            string memory pfx = _load(string.concat(FIXTURES, "partial_", names[s], ".json"));
            if (bytes(dfx).length == 0 || bytes(pfx).length == 0) return;
            uint256 deals = _count(dfx, ".dealings");
            assertGt(deals, 0);
            for (uint256 i; i < deals; ++i) {
                uint256[87] memory pub = _dealPub(dfx, i);
                assertTrue(dv.verifyProof(pA, pB, pC, pub), "deal proof");
            }
            uint256 partials = _count(pfx, ".partials");
            assertGt(partials, 0);
            for (uint256 i; i < partials; ++i) {
                uint256[67] memory pub = _partialPub(pfx, i);
                assertTrue(pv.verifyProof(pA, pB, pC, pub), "partial proof");
            }
        }
    }

    /// @dev Every one of the 87 signals, perturbed alone (+1 mod p, and + p which is the same
    ///      residue but not canonical), makes the proof fail.
    function test_Real_DealPublicSignalMutations() public {
        string memory fx = _load(string.concat(FIXTURES, "deal_A.json"));
        if (bytes(fx).length == 0) return;
        uint256[87] memory pub = _dealPub(fx, 0);
        assertTrue(dv.verifyProof(pA, pB, pC, pub));
        for (uint256 i; i < 87; ++i) {
            uint256 w = pub[i];
            pub[i] = addmod(w, 1, P);
            assertFalse(dv.verifyProof(pA, pB, pC, pub), "perturbed deal signal verified");
            pub[i] = w + P;
            assertFalse(dv.verifyProof(pA, pB, pC, pub), "non-canonical deal signal verified");
            pub[i] = w;
        }
        assertTrue(dv.verifyProof(pA, pB, pC, pub));
    }

    function test_Real_PartialPublicSignalMutations() public {
        string memory fx = _load(string.concat(FIXTURES, "partial_A.json"));
        if (bytes(fx).length == 0) return;
        uint256[67] memory pub = _partialPub(fx, 0);
        assertTrue(pv.verifyProof(pA, pB, pC, pub));
        for (uint256 i; i < 67; ++i) {
            uint256 w = pub[i];
            pub[i] = addmod(w, 1, P);
            assertFalse(pv.verifyProof(pA, pB, pC, pub), "perturbed partial signal verified");
            pub[i] = w + P;
            assertFalse(pv.verifyProof(pA, pB, pC, pub), "non-canonical partial signal verified");
            pub[i] = w;
        }
        assertTrue(pv.verifyProof(pA, pB, pC, pub));
    }

    function test_Real_ProofWordMutations() public {
        string memory fx = _load(string.concat(FIXTURES, "deal_A.json"));
        if (bytes(fx).length == 0) return;
        uint256[87] memory pub = _dealPub(fx, 0);
        uint256[2] memory a = pA;
        uint256[2][2] memory b = pB;
        uint256[2] memory c = pC;
        assertTrue(dv.verifyProof(a, b, c, pub));
        assertFalse(dv.verifyProof([a[0] + 1, a[1]], b, c, pub), "pA");
        assertFalse(dv.verifyProof(a, b, [c[0], c[1] + 1], pub), "pC");
        // the proof JSON's G2 limb order instead of exportSolidityCallData's (protocol §7.2)
        assertFalse(dv.verifyProof(a, [[b[0][1], b[0][0]], [b[1][1], b[1][0]]], c, pub), "pB limb order");
        assertFalse(dv.verifyProof(c, b, a, pub), "pA/pC swapped");
        // another dealing's proof with these signals
        uint256[87] memory other = _dealPub(fx, 1);
        assertFalse(dv.verifyProof(pA, pB, pC, pub), "dealing 1 proof on dealing 0 signals");
        assertTrue(dv.verifyProof(pA, pB, pC, other));
    }

    // ─── The manager with the real verifiers ──────────────────────────────────────────────

    /// @dev A correctly signed dealing whose payload differs from the proven statement is
    ///      rejected by the verifier, never stored.
    function test_Real_ManagerRejectsTamperedDealing() public {
        if (!_setupScenario(0, true)) return; // scenario A: n = 3, t = 2, fixtures deal 1 and 3
        DealCall memory d;
        d.C = _points16(dealFx, ".dealings[0].C");
        (d.E[0], d.E[1]) = _pt(dealFx, ".dealings[0].E");
        uint256[] memory masked = vm.parseJsonUintArray(dealFx, ".dealings[0].masked");
        for (uint256 i; i < 16; ++i) {
            d.masked[i] = masked[i];
        }
        _proof(dealFx, ".dealings[0].proof");
        bytes32 ctx = _ctx();

        // dealer 1's masked share for member 2, shifted by one
        d.masked[1] = addmod(d.masked[1], 1, P);
        _signRealDeal(d, 1, ctx);
        vm.expectRevert(ProofInvalid.selector);
        manager.deal(d.a, d.sig, d.C, d.E, d.masked, pA, pB, pC, _roster());

        // dealer 1's honest dealing re-labelled as member 2's (dealerIndex is a public input)
        d.masked[1] = masked[1];
        _signRealDeal(d, 2, ctx);
        vm.expectRevert(ProofInvalid.selector);
        manager.deal(d.a, d.sig, d.C, d.E, d.masked, pA, pB, pC, _roster());

        // the honest submission still goes through
        _signRealDeal(d, 1, ctx);
        manager.deal(d.a, d.sig, d.C, d.E, d.masked, pA, pB, pC, _roster());
        assertEq(manager.getQual(cid), 1);
    }

    function _signRealDeal(DealCall memory d, uint256 j, bytes32 ctx) internal view {
        d.a = Deal(
            cid, uint8(j), keccak256(abi.encode(TAG_DEAL_PAYLOAD, ctx, d.C, d.E, d.masked, pA, pB, pC)), validUntil
        );
        d.sig = _sign(authSecrets[j - 1], _hDeal(d.a));
    }

    function test_Real_ManagerRejectsTamperedPartial() public {
        if (!_setupScenario(0, true)) return;
        _replayDealing();
        _replayFinalize();
        _replayRequest();
        _replayOpening();
        PartialCall memory p;
        p.D = _points16(partialFx, ".partials[1].D"); // member 2
        _proof(partialFx, ".partials[1].proof");

        // swap two valid D points: canonical, on curve, wrong
        (p.D[0], p.D[1]) = (p.D[1], p.D[0]);
        _signRealPartial(p, 2);
        vm.expectRevert(ProofInvalid.selector);
        manager.submitPartial(p.a, p.sig, p.D, pA, pB, pC, _c1());

        // member 2's honest partial re-labelled as member 3's (PK_3 is the public key input)
        (p.D[0], p.D[1]) = (p.D[1], p.D[0]);
        _signRealPartial(p, 3);
        vm.expectRevert(ProofInvalid.selector);
        manager.submitPartial(p.a, p.sig, p.D, pA, pB, pC, _c1());

        _signRealPartial(p, 2);
        manager.submitPartial(p.a, p.sig, p.D, pA, pB, pC, _c1());
        (,,, uint16 partials) = manager.getRequestMeta(requestId);
        assertEq(partials, 2);
    }

    function _signRealPartial(PartialCall memory p, uint256 i) internal view {
        p.a = Partial(
            cid, requestId, uint8(i), keccak256(abi.encode(TAG_PARTIAL_PAYLOAD, requestId, p.D, pA, pB, pC)), validUntil
        );
        p.sig = _sign(authSecrets[i - 1], _hPartial(p.a));
    }

    // ─── Proof words must be < qBN (second encodings of a valid proof) ──────────────────

    /// @dev pA.y enters the generated verifier as `mod(sub(q, y), q)`: y + 2^256 - 4·qBN
    ///      negates to the same value, so the verifier accepts it as the same proof.
    function _alias(uint256 y) internal pure returns (uint256) {
        unchecked {
            return y + (type(uint256).max - 4 * Q_BN + 1);
        }
    }

    function test_Real_AliasedProofWordRejectedOnDeal() public {
        if (!_setupScenario(0, true)) return;
        DealCall memory d;
        d.C = _points16(dealFx, ".dealings[0].C");
        (d.E[0], d.E[1]) = _pt(dealFx, ".dealings[0].E");
        uint256[] memory masked = vm.parseJsonUintArray(dealFx, ".dealings[0].masked");
        for (uint256 i; i < 16; ++i) {
            d.masked[i] = masked[i];
        }
        uint256[87] memory pub;
        uint256[] memory sig = vm.parseJsonUintArray(dealFx, ".dealings[0].pubSignals");
        for (uint256 i; i < 87; ++i) {
            pub[i] = sig[i];
        }
        _proof(dealFx, ".dealings[0].proof");
        bytes32 ctx = _ctx();
        uint256 y = pA[1];

        // the generated verifier alone accepts the aliased encoding
        pA[1] = _alias(y);
        assertGt(pA[1], Q_BN);
        assertTrue(dv.verifyProof(pA, pB, pC, pub), "alias verifies at the raw verifier");
        // the manager refuses it even when the payload hash signs the aliased words
        _signRealDeal(d, 1, ctx);
        vm.expectRevert(NonCanonical.selector);
        manager.deal(d.a, d.sig, d.C, d.E, d.masked, pA, pB, pC, _roster());
        assertEq(manager.getQual(cid), 0);

        pA[1] = y;
        _signRealDeal(d, 1, ctx);
        manager.deal(d.a, d.sig, d.C, d.E, d.masked, pA, pB, pC, _roster());
        assertEq(manager.getQual(cid), 1);
    }

    function test_Real_AliasedProofWordRejectedOnPartial() public {
        if (!_setupScenario(0, true)) return;
        _replayDealing();
        _replayFinalize();
        _replayRequest();
        _replayOpening();
        PartialCall memory p;
        p.D = _points16(partialFx, ".partials[0].D");
        uint256[67] memory pub;
        uint256[] memory sig = vm.parseJsonUintArray(partialFx, ".partials[0].pubSignals");
        for (uint256 i; i < 67; ++i) {
            pub[i] = sig[i];
        }
        _proof(partialFx, ".partials[0].proof");
        uint256 y = pA[1];

        pA[1] = _alias(y);
        assertTrue(pv.verifyProof(pA, pB, pC, pub), "alias verifies at the raw verifier");
        _signRealPartial(p, 1);
        vm.expectRevert(NonCanonical.selector);
        manager.submitPartial(p.a, p.sig, p.D, pA, pB, pC, _c1());
        (,,, uint16 partials) = manager.getRequestMeta(requestId);
        assertEq(partials, 0);

        pA[1] = y;
        _signRealPartial(p, 1);
        manager.submitPartial(p.a, p.sig, p.D, pA, pB, pC, _c1());
        (,,, partials) = manager.getRequestMeta(requestId);
        assertEq(partials, 1);
    }
}
