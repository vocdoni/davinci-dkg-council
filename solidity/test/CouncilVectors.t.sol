// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {CouncilManager} from "../src/CouncilManager.sol";
import {CouncilCurve} from "../src/libraries/CouncilCurve.sol";
import {CouncilEIP712} from "../src/libraries/CouncilEIP712.sol";
import {BabyJubJub} from "../src/libraries/BabyJubJub.sol";
import {VectorReplay} from "./utils/VectorReplay.sol";
import {EIP712Harness, CurveHarness, CouncilManagerHarness} from "./utils/Harnesses.sol";
import {Bjj} from "./utils/Bjj.sol";

/// @notice Asserts the contract against the cross-implementation vectors of protocol §12
///         (`tests/vectors/*.json`, produced by the standalone TypeScript generator)
///         and the canned real proofs of `circuits/fixtures/`. Each test is skipped when
///         its file is absent. The replays deploy the real manager at the vectors' address and
///         chain id and run every recorded value through it: ids, roster hash, ctx, the 87/67-word
///         public input vectors, aggregates, PK_i, request id, Lagrange and combine; the real-proof
///         replays do so through the generated verifiers with the fixtures' proofs and signatures.
contract CouncilVectorsTest is VectorReplay {
    // ─── constants.json ───────────────────────────────────────────────────────────────────

    function test_Vectors_Constants() public {
        string memory c = _load(string.concat(VECTORS, "constants.json"));
        if (bytes(c).length == 0) return;
        assertEq(vm.parseJsonUint(c, ".curve.p"), CouncilCurve.P, "p");
        assertEq(vm.parseJsonUint(c, ".curve.p"), BabyJubJub.Q, "p == BabyJubJub.Q");
        assertEq(vm.parseJsonUint(c, ".curve.r"), CouncilCurve.R, "r");
        assertEq(vm.parseJsonUint(c, ".curve.r"), BabyJubJub.SUBGROUP_ORDER, "r == BabyJubJub order");
        assertEq(vm.parseJsonUint(c, ".curve.a"), Bjj.A_TE, "a");
        assertEq(vm.parseJsonUint(c, ".curve.d"), Bjj.D_TE, "d");
        (uint256 gx, uint256 gy) = _pt(c, ".curve.G");
        assertEq(gx, CouncilCurve.GX_TE, "G.x");
        assertEq(gy, CouncilCurve.GY, "G.y");
        assertEq(vm.parseJsonUint(c, ".teToReduced.K"), CouncilCurve.K, "K");
        assertEq(vm.parseJsonUint(c, ".teToReduced.K_INV"), CouncilCurve.K_INV, "K_INV");
        assertEq(
            vm.parseJsonUint(c, ".teToReduced.KSquaredEqualsMinusA"),
            mulmod(CouncilCurve.K, CouncilCurve.K, CouncilCurve.P),
            "K^2"
        );
        (uint256 rgx, uint256 rgy) = _pt(c, ".teToReduced.reducedG");
        assertEq(rgx, CouncilCurve.GX_RED, "reduced G.x");
        assertEq(rgx, BabyJubJub.GENERATOR_X, "reduced G.x == BabyJubJub generator");
        assertEq(rgy, BabyJubJub.GENERATOR_Y, "reduced G.y");
        assertEq(CouncilCurve.toReduced(gx), rgx, "toReduced(G)");
        assertEq(vm.parseJsonUint(c, ".LIMIT_R"), LIMIT_R, "LIMIT_R");
        assertEq(vm.parseJsonUint(c, ".secp256k1n"), CouncilEIP712.SECP256K1_N, "secp256k1n");
        assertEq(CouncilEIP712.SECP256K1_HALF_N, CouncilEIP712.SECP256K1_N / 2, "half n");
        assertEq(vm.parseJsonUint(c, ".sizes.MAX_N"), 16);
        assertEq(vm.parseJsonUint(c, ".sizes.MAX_T"), 16);
        assertEq(vm.parseJsonUint(c, ".sizes.MAX_FIELDS"), 16);
        assertEq(vm.parseJsonUint(c, ".sizes.MAX_COMBINE_FIELDS"), 4);
        assertEq(vm.parseJsonUint(c, ".sizes.MAX_INVITES"), 64);
        assertEq(vm.parseJsonUint(c, ".sizes.MIN_DEALING_DURATION"), 600);
        assertEq(vm.parseJsonUint(c, ".sizes.RESULT_BOUND"), 1 << 40);

        // TE products from the generator's own (zk-kit cross-checked) arithmetic vs the vendored
        // reduced-chart library behind the TE map.
        (uint256 x, uint256 y) = _pt(c, ".curve.G246");
        (uint256 ex, uint256 ey) = Bjj.mulG(1 << 246);
        assertEq(ex, x, "G246.x");
        assertEq(ey, y, "G246.y");
        (x, y) = _pt(c, ".curve.rMinus1G");
        (ex, ey) = Bjj.mulG(R - 1);
        assertEq(ex, x, "(r-1)G.x");
        assertEq(ey, y, "(r-1)G.y");
        for (uint256 i; i < 3; ++i) {
            uint256 s = vm.parseJsonUint(c, _k(".fixedBaseExceptional.scalars", i, ""));
            (x, y) = _pt(c, _k(".fixedBaseExceptional.products", i, ""));
            (ex, ey) = Bjj.mulG(s);
            assertEq(ex, x, "exceptional.x");
            assertEq(ey, y, "exceptional.y");
        }

        // tag hashes: generator vs protocol §2.4 table vs the constants the contract hashes
        bytes32[9] memory pinned = [
            bytes32(0xecb738c07e6a59197a7fd9e2f5e6116948f75ddf4ac1167be6d353868161465f),
            0x2c9d4948616c1a88c354348793d30f18ea38d1f04ad5854da9e32746a3b11ac9,
            0xdbb35e5b108ffc795df6963925b9215f480adc307c37d7301c3e91d8e2b7bb7c,
            0x1326b87fc239e1401c315964035b32e39ac95374aecd1472e03710d68890394e,
            0xf82c8d4d3410e2766e553a29e47765d8dca7d7bb5d3c8d1226c3736cb39bbb19,
            0x2044a532478c345d057d687f1827a3c194b5c92d1c7471f6aa59fe10fe010ba7,
            0x790ea2a939d8ccdf25ac8c84f7bffca5476a976d584b89ca4a7f365b8e85c589,
            0x9e489062d0e615d54b9cf250918652a1541571f981e4892e70d382d1536fdf5c,
            0xd8262d0eb7248e9458410cb71d8ace07c8eabd235f11ed9fb71812260a9dc8f2
        ];
        bytes32[7] memory used = [
            TAG_CEREMONY, TAG_ROSTER, TAG_DEAL_CONTEXT, TAG_DEAL_PAYLOAD, TAG_JOIN_POP, TAG_REQUEST, TAG_PARTIAL_PAYLOAD
        ];
        uint256 tags = _count(c, ".tags");
        assertEq(tags, 9, "tag count");
        for (uint256 i; i < tags; ++i) {
            string memory tag = vm.parseJsonString(c, _k(".tags", i, ".tag"));
            bytes32 h = vm.parseJsonBytes32(c, _k(".tags", i, ".keccak256"));
            assertEq(keccak256(bytes(tag)), h, tag);
            assertEq(h, pinned[i], tag);
            if (i < 7) assertEq(used[i], h, tag);
        }
        assertEq(
            vm.parseJsonUint(c, ".MASK_CONST"), uint256(keccak256("davinci-dkg-council/v1/share-mask-poseidon")) % P, "MASK_CONST"
        );

        // EIP-712 type strings and hashes vs the library constants
        assertEq(vm.parseJsonBytes32(c, ".eip712.domainTypeHash"), CouncilEIP712.DOMAIN_TYPEHASH, "domain typehash");
        assertEq(CouncilEIP712.DOMAIN_TYPEHASH, 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f);
        bytes32[9] memory typeHashes = [
            CouncilEIP712.CREATE_CEREMONY_TYPEHASH,
            CouncilEIP712.ADD_INVITES_TYPEHASH,
            CouncilEIP712.CLOSE_REGISTRATION_TYPEHASH,
            CouncilEIP712.ALLOW_ADAPTER_TYPEHASH,
            CouncilEIP712.AUTHORIZE_CREATOR_TYPEHASH,
            CouncilEIP712.INVITE_TYPEHASH,
            CouncilEIP712.JOIN_TYPEHASH,
            CouncilEIP712.DEAL_TYPEHASH,
            CouncilEIP712.PARTIAL_TYPEHASH
        ];
        string[9] memory names = [
            "CreateCeremony",
            "AddInvites",
            "CloseRegistration",
            "AllowAdapter",
            "AuthorizeCreator",
            "Invite",
            "Join",
            "Deal",
            "Partial"
        ];
        assertEq(_count(c, ".eip712.encodeTypes"), 9);
        for (uint256 i; i < 9; ++i) {
            assertEq(vm.parseJsonString(c, _k(".eip712.encodeTypes", i, ".name")), names[i]);
            string memory s = vm.parseJsonString(c, _k(".eip712.encodeTypes", i, ".encodeType"));
            assertEq(keccak256(bytes(s)), typeHashes[i], names[i]);
            assertEq(vm.parseJsonBytes32(c, _k(".eip712.encodeTypes", i, ".typeHash")), typeHashes[i], names[i]);
        }
    }

    // ─── derivation.json: HashToScalar (the contract's join-PoP challenge) ────────────────

    function test_Vectors_HashToScalar() public {
        string memory d = _load(string.concat(VECTORS, "derivation.json"));
        if (bytes(d).length == 0) return;
        CouncilManagerHarness h = new CouncilManagerHarness(address(1), address(2), bytes32(0));
        uint256 examples = _count(d, ".hashToScalar.examples");
        assertGt(examples, 0);
        for (uint256 i; i <= examples; ++i) {
            string memory e = i < examples ? _k(".hashToScalar.examples", i, "") : ".hashToScalar.rejection";
            assertEq(vm.parseJsonString(d, string.concat(e, ".fields[0].type")), "uint256");
            bytes memory prefix = abi.encode(
                keccak256(bytes(vm.parseJsonString(d, string.concat(e, ".tag")))),
                vm.parseJsonUint(d, string.concat(e, ".fields[0].value"))
            );
            uint256 want = vm.parseJsonUint(d, string.concat(e, ".value"));
            assertEq(h.hashToScalar(prefix), want, "HashToScalar");
            assertEq(_hashToScalar(prefix), want, "test-side HashToScalar");
        }
        // the rejection vector really exercises counter > 0
        assertGt(vm.parseJsonUint(d, ".hashToScalar.rejection.counter"), 0);
    }

    // ─── identifiers.json ─────────────────────────────────────────────────────────────────

    function test_Vectors_Identifiers() public {
        ids = _load(string.concat(VECTORS, "identifiers.json"));
        if (bytes(ids).length == 0) return;
        bytes32 dealSha = vm.parseJsonBytes32(ids, ".circuitRelease.dealVkeySha256");
        bytes32 partialSha = vm.parseJsonBytes32(ids, ".circuitRelease.partialVkeySha256");
        assertEq(
            keccak256(abi.encode(keccak256("davinci-dkg-council/v1/circuit-release"), dealSha, partialSha)),
            vm.parseJsonBytes32(ids, ".circuitRelease.circuitReleaseId"),
            "circuitReleaseId"
        );
        uint256 examples = _count(ids, ".ceremonyIdExamples");
        assertGt(examples, 0);
        for (uint256 i; i < examples; ++i) {
            string memory e = _k(".ceremonyIdExamples", i, "");
            uint256 chainId = vm.parseJsonUint(ids, string.concat(e, ".chainId"));
            address mgr = vm.parseJsonAddress(ids, string.concat(e, ".manager"));
            address org = vm.parseJsonAddress(ids, string.concat(e, ".organizer"));
            uint64 nonce = uint64(vm.parseJsonUint(ids, string.concat(e, ".nonce")));
            bytes12 want = bytes12(vm.parseJsonBytes(ids, string.concat(e, ".ceremonyId")));
            // the manager derives the id from its own chain id and address
            vm.chainId(chainId);
            deployCodeTo("CouncilManager.sol:CouncilManager", abi.encode(address(1), address(2), bytes32(0)), mgr);
            assertEq(CouncilManager(mgr).ceremonyIdFor(org, nonce), want, "ceremonyId");
        }
    }

    // ─── eip712.json ──────────────────────────────────────────────────────────────────────

    function test_Vectors_EIP712() public {
        string memory e = _load(string.concat(VECTORS, "eip712.json"));
        if (bytes(e).length == 0) return;
        vm.chainId(vm.parseJsonUint(e, ".domain.chainId"));
        address mgr = vm.parseJsonAddress(e, ".domain.verifyingContract");
        deployCodeTo("Harnesses.sol:EIP712Harness", mgr);
        EIP712Harness h = EIP712Harness(mgr);
        assertEq(h.domainSeparator(), vm.parseJsonBytes32(e, ".domain.domainSeparator"), "domain separator");

        uint256 count = _count(e, ".actions");
        assertEq(count, 9);
        for (uint256 i; i < count; ++i) {
            string memory a = _k(".actions", i, "");
            string memory name = vm.parseJsonString(e, string.concat(a, ".struct"));
            bytes32 structHash = _vectorStructHash(h, e, name, string.concat(a, ".message"));
            assertEq(structHash, vm.parseJsonBytes32(e, string.concat(a, ".structHash")), name);
            assertEq(h.digest(structHash), vm.parseJsonBytes32(e, string.concat(a, ".digest")), name);
            bytes memory sig = vm.parseJsonBytes(e, string.concat(a, ".signature"));
            address signer = vm.parseJsonAddress(e, string.concat(a, ".signer"));
            assertEq(h.recover(structHash, sig), signer, name);
            h.verify(structHash, sig, signer);
        }
    }

    function _vectorStructHash(EIP712Harness h, string memory e, string memory name, string memory m)
        internal
        pure
        returns (bytes32)
    {
        bytes32 n_ = keccak256(bytes(name));
        if (n_ == keccak256("CreateCeremony")) {
            return h.hashCreateCeremony(
                CreateCeremony({
                    organizer: vm.parseJsonAddress(e, string.concat(m, ".organizer")),
                    nonce: uint64(vm.parseJsonUint(e, string.concat(m, ".nonce"))),
                    threshold: uint8(vm.parseJsonUint(e, string.concat(m, ".threshold"))),
                    registrationDeadline: uint64(vm.parseJsonUint(e, string.concat(m, ".registrationDeadline"))),
                    dealingDuration: uint64(vm.parseJsonUint(e, string.concat(m, ".dealingDuration"))),
                    inviteKeys: vm.parseJsonAddressArray(e, string.concat(m, ".inviteKeys")),
                    validUntil: uint64(vm.parseJsonUint(e, string.concat(m, ".validUntil")))
                })
            );
        }
        bytes12 c = bytes12(vm.parseJsonBytes(e, string.concat(m, ".ceremonyId")));
        uint64 vu = uint64(vm.parseJsonUint(e, string.concat(m, ".validUntil")));
        if (n_ == keccak256("AddInvites")) {
            return h.hashAddInvites(
                AddInvites({
                    ceremonyId: c,
                    firstInviteId: uint32(vm.parseJsonUint(e, string.concat(m, ".firstInviteId"))),
                    inviteKeys: vm.parseJsonAddressArray(e, string.concat(m, ".inviteKeys")),
                    validUntil: vu
                })
            );
        }
        if (n_ == keccak256("CloseRegistration")) {
            return h.hashCloseRegistration(
                CloseRegistration(c, uint8(vm.parseJsonUint(e, string.concat(m, ".participantCount"))), vu)
            );
        }
        if (n_ == keccak256("AllowAdapter")) {
            return h.hashAllowAdapter(AllowAdapter(c, vm.parseJsonAddress(e, string.concat(m, ".adapter")), vu));
        }
        if (n_ == keccak256("AuthorizeCreator")) {
            return h.hashAuthorizeCreator(AuthorizeCreator(c, vm.parseJsonAddress(e, string.concat(m, ".creator")), vu));
        }
        if (n_ == keccak256("Invite")) {
            return h.hashInvite(
                Invite({
                    ceremonyId: c,
                    inviteId: uint32(vm.parseJsonUint(e, string.concat(m, ".inviteId"))),
                    participant: vm.parseJsonAddress(e, string.concat(m, ".participant")),
                    pkX: vm.parseJsonUint(e, string.concat(m, ".pkX")),
                    pkY: vm.parseJsonUint(e, string.concat(m, ".pkY")),
                    validUntil: vu
                })
            );
        }
        if (n_ == keccak256("Join")) {
            return h.hashJoin(
                Join({
                    ceremonyId: c,
                    participant: vm.parseJsonAddress(e, string.concat(m, ".participant")),
                    inviteId: uint32(vm.parseJsonUint(e, string.concat(m, ".inviteId"))),
                    pkX: vm.parseJsonUint(e, string.concat(m, ".pkX")),
                    pkY: vm.parseJsonUint(e, string.concat(m, ".pkY")),
                    popAx: vm.parseJsonUint(e, string.concat(m, ".popAx")),
                    popAy: vm.parseJsonUint(e, string.concat(m, ".popAy")),
                    popZ: vm.parseJsonUint(e, string.concat(m, ".popZ")),
                    validUntil: vu
                })
            );
        }
        if (n_ == keccak256("Deal")) {
            return h.hashDeal(
                Deal(
                    c,
                    uint8(vm.parseJsonUint(e, string.concat(m, ".dealerIndex"))),
                    vm.parseJsonBytes32(e, string.concat(m, ".payloadHash")),
                    vu
                )
            );
        }
        if (n_ == keccak256("Partial")) {
            return h.hashPartial(
                Partial(
                    c,
                    vm.parseJsonBytes32(e, string.concat(m, ".requestId")),
                    uint8(vm.parseJsonUint(e, string.concat(m, ".participantIndex"))),
                    vm.parseJsonBytes32(e, string.concat(m, ".payloadHash")),
                    vu
                )
            );
        }
        revert(string.concat("unknown struct ", name));
    }

    // ─── combine.json Lagrange ────────────────────────────────────────────────────────────

    function test_Vectors_Lagrange() public {
        combineJson = _load(string.concat(VECTORS, "combine.json"));
        if (bytes(combineJson).length == 0) return;
        CurveHarness h = new CurveHarness();
        uint256 scs = _count(combineJson, ".scenarios");
        for (uint256 s; s < scs; ++s) {
            string memory cs = _k(".scenarios", s, ".combines");
            uint256 combines = _count(combineJson, cs);
            for (uint256 c; c < combines; ++c) {
                uint8[] memory set = _uint8s(vm.parseJsonUintArray(combineJson, _k(cs, c, ".memberSet")));
                uint256[] memory want = vm.parseJsonUintArray(combineJson, _k(cs, c, ".lambdas"));
                uint256[] memory got = h.lagrange(set);
                assertEq(got.length, want.length);
                for (uint256 i; i < got.length; ++i) {
                    assertEq(got[i], want[i], "lambda");
                }
            }
        }
    }

    // ─── Scenario replays ─────────────────────────────────────────────────────────────────

    /// @dev Mock verifiers: pins the manager-built public-input vectors with vm.expectCall.
    function test_Vectors_ReplayScenarioA() public {
        _replay(0, false);
    }

    function test_Vectors_ReplayScenarioB() public {
        _replay(1, false);
    }

    /// @dev Generated verifiers + canned proofs: the full happy path with real Groth16 proofs.
    function test_RealProofs_ReplayScenarioA() public {
        _replay(0, true);
    }

    function test_RealProofs_ReplayScenarioB() public {
        _replay(1, true);
    }
}
