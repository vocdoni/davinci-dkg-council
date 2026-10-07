// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../../src/CouncilTypes.sol";
import {ICouncil} from "../../src/interfaces/ICouncil.sol";
import {CouncilCurve} from "../../src/libraries/CouncilCurve.sol";
import {IDealVerifier, IPartialVerifier} from "../../src/interfaces/ICouncilVerifiers.sol";
import {DealVerifier} from "../../src/verifiers/DealVerifier.sol";
import {PartialVerifier} from "../../src/verifiers/PartialVerifier.sol";
import {MockDealVerifier, MockPartialVerifier} from "../mocks/MockVerifiers.sol";
import {CouncilTestBase} from "./CouncilTestBase.sol";
import {Bjj} from "./Bjj.sol";

/// @notice Replays the cross-implementation scenarios of `tests/vectors/*.json`
///         (protocol §12) against a manager deployed at the vectors' address and chain id.
///         Mock mode: placeholder proof words, the manager's public-input vectors pinned with
///         `vm.expectCall`. Real mode: the generated verifiers and the canned proofs and
///         viem-signed actions of `circuits/fixtures/{deal,partial}_{A,B}.json`.
///         Scenario A runs the Manual policies (organizer close before the expiry, organizer
///         opening), scenario B the Scheduled ones (permissionless close at the deadline, the
///         decryption date reached by the clock). Tests skip when the files are absent.
abstract contract VectorReplay is CouncilTestBase {
    string internal constant VECTORS = "../tests/vectors/";
    string internal constant FIXTURES = "../circuits/fixtures/";
    uint64 internal constant V_VALID_UNTIL = 2_000_000_000;

    string internal ids;
    string internal dealingJson;
    string internal recoveryJson;
    string internal combineJson;
    string internal dealFx; // real mode only
    string internal partialFx; // real mode only
    string internal sk; // ".scenarios[i]"
    uint256 internal si; // scenario index
    bool internal real;
    string internal gasTag; // non-empty: snapshot the first deal / partial / combine
    uint256 internal n;
    uint256 internal dealCount;
    uint256[2] internal pA;
    uint256[2][2] internal pB;
    uint256[2] internal pC;
    uint8 internal regMode;
    uint8 internal decMode;
    uint64 internal regDeadline;
    uint64 internal openAt;

    function setUp() public virtual override {
        vm.warp(1_850_000_000);
    }

    function _load(string memory path) internal returns (string memory json) {
        if (!vm.exists(path)) {
            vm.skip(true);
            return "";
        }
        return vm.readFile(path);
    }

    function _k(string memory a, uint256 i, string memory b) internal pure returns (string memory) {
        return string.concat(a, "[", vm.toString(i), "]", b);
    }

    function _count(string memory json, string memory arrayKey) internal view returns (uint256 c) {
        while (vm.keyExistsJson(json, _k(arrayKey, c, ""))) {
            ++c;
        }
    }

    function _pt(string memory json, string memory key) internal pure returns (uint256, uint256) {
        uint256[] memory a = vm.parseJsonUintArray(json, key);
        assertEq(a.length, 2, key);
        return (a[0], a[1]);
    }

    function _points16(string memory json, string memory key) internal pure returns (uint256[2][16] memory out) {
        for (uint256 i; i < 16; ++i) {
            (out[i][0], out[i][1]) = _pt(json, _k(key, i, ""));
        }
    }

    function _uint8s(uint256[] memory a) internal pure returns (uint8[] memory out) {
        out = new uint8[](a.length);
        for (uint256 i; i < a.length; ++i) {
            out[i] = uint8(a[i]);
        }
    }

    function _proof(string memory json, string memory key) internal {
        (pA[0], pA[1]) = _pt(json, string.concat(key, ".pA"));
        (pB[0][0], pB[0][1]) = _pt(json, string.concat(key, ".pB[0]"));
        (pB[1][0], pB[1][1]) = _pt(json, string.concat(key, ".pB[1]"));
        (pC[0], pC[1]) = _pt(json, string.concat(key, ".pC"));
    }

    function _snapIf(string memory action) internal {
        if (bytes(gasTag).length != 0) {
            vm.snapshotGasLastCall(vm.envOr("COUNCIL_GAS_GROUP", string("council")), string.concat(gasTag, "_", action));
        }
    }

    /// @dev Replay scenario `s` (0 = A: n=3, t=2, QUAL {1,3}; 1 = B: n=t=16). Returns false
    ///      when a required file is missing (the test is then skipped).
    function _replay(uint256 s, bool real_) internal returns (bool) {
        if (!_setupScenario(s, real_)) return false;
        _replayDealing();
        _replayFinalize();
        _replayRequest();
        _replayOpening();
        _replayPartialsAndCombines();
        return true;
    }

    /// @dev Load the files, deploy the manager at the vectors' address and run registration up
    ///      to and including close.
    function _setupScenario(uint256 s, bool real_) internal returns (bool) {
        real = real_;
        ids = _load(string.concat(VECTORS, "identifiers.json"));
        dealingJson = _load(string.concat(VECTORS, "dealing.json"));
        recoveryJson = _load(string.concat(VECTORS, "recovery.json"));
        combineJson = _load(string.concat(VECTORS, "combine.json"));
        string memory name = s == 0 ? "A" : "B";
        if (real) {
            dealFx = _load(string.concat(FIXTURES, "deal_", name, ".json"));
            partialFx = _load(string.concat(FIXTURES, "partial_", name, ".json"));
            if (bytes(dealFx).length == 0 || bytes(partialFx).length == 0) return false;
        }
        if (bytes(ids).length == 0 || bytes(dealingJson).length == 0) return false;
        if (bytes(recoveryJson).length == 0 || bytes(combineJson).length == 0) return false;
        si = s;
        sk = _k(".scenarios", s, "");

        _deploy();
        _replayRegistration();
        return true;
    }

    function _deploy() internal {
        vm.chainId(vm.parseJsonUint(ids, string.concat(sk, ".chainId")));
        bytes32 releaseId = vm.parseJsonBytes32(ids, string.concat(sk, ".circuitReleaseId"));
        address d;
        address p;
        if (real) {
            assertEq(vm.parseJsonBytes32(dealFx, ".circuitReleaseIdInCtx"), releaseId, "fixture release id");
            assertEq(vm.parseJsonBytes32(partialFx, ".circuitReleaseIdInCtx"), releaseId, "fixture release id");
            d = address(new DealVerifier());
            p = address(new PartialVerifier());
        } else {
            dealV = new MockDealVerifier();
            partialV = new MockPartialVerifier();
            (d, p) = (address(dealV), address(partialV));
            (pA[0], pA[1]) = _pt(dealingJson, ".placeholderProof.pA");
            (pB[0][0], pB[0][1]) = _pt(dealingJson, ".placeholderProof.pB[0]");
            (pB[1][0], pB[1][1]) = _pt(dealingJson, ".placeholderProof.pB[1]");
            (pC[0], pC[1]) = _pt(dealingJson, ".placeholderProof.pC");
        }
        address mgr = vm.parseJsonAddress(ids, string.concat(sk, ".manager"));
        deployCodeTo("CouncilManager.sol:CouncilManager", abi.encode(d, p, releaseId), mgr);
        manager = ICouncil(mgr);
        validUntil = V_VALID_UNTIL;
    }

    function _replayRegistration() internal {
        orgKey = vm.parseJsonUint(ids, string.concat(sk, ".organizer.secret"));
        organizer = vm.parseJsonAddress(ids, string.concat(sk, ".organizer.address"));
        assertEq(vm.addr(orgKey), organizer, "organizer address");
        uint64 nonce = uint64(vm.parseJsonUint(ids, string.concat(sk, ".nonce")));
        cid = bytes12(vm.parseJsonBytes(ids, string.concat(sk, ".ceremonyId")));
        assertEq(manager.ceremonyIdFor(organizer, nonce), cid, "ceremonyId");
        T = uint8(vm.parseJsonUint(ids, string.concat(sk, ".t")));
        n = vm.parseJsonUint(ids, string.concat(sk, ".n"));

        // invites: the initial ones at creation, the rest through AddInvites
        string memory inv = string.concat(sk, ".invites");
        uint256 total = _count(ids, inv);
        uint256 initial;
        delete inviteSecrets;
        for (uint256 i; i < total; ++i) {
            assertEq(vm.parseJsonUint(ids, _k(inv, i, ".inviteId")), i);
            inviteSecrets.push(vm.parseJsonUint(ids, _k(inv, i, ".secret")));
            assertEq(vm.addr(inviteSecrets[i]), vm.parseJsonAddress(ids, _k(inv, i, ".address")));
            if (vm.parseJsonBool(ids, _k(inv, i, ".initial"))) ++initial;
        }
        address[] memory keys = new address[](initial);
        for (uint256 i; i < initial; ++i) {
            keys[i] = vm.addr(inviteSecrets[i]);
        }
        CreateCeremony memory ca = CreateCeremony({
            organizer: organizer,
            nonce: nonce,
            threshold: T,
            registrationMode: uint8(vm.parseJsonUint(ids, string.concat(sk, ".registrationMode"))),
            registrationDeadline: uint64(vm.parseJsonUint(ids, string.concat(sk, ".registrationDeadline"))),
            dealingDuration: uint64(vm.parseJsonUint(ids, string.concat(sk, ".dealingDuration"))),
            decryptionMode: uint8(vm.parseJsonUint(ids, string.concat(sk, ".decryptionMode"))),
            decryptionOpenAt: uint64(vm.parseJsonUint(ids, string.concat(sk, ".decryptionOpenAt"))),
            manualDecryptionFallbackAt: uint64(vm.parseJsonUint(ids, string.concat(sk, ".manualDecryptionFallbackAt"))),
            inviteKeys: keys,
            validUntil: validUntil
        });
        regMode = ca.registrationMode;
        decMode = ca.decryptionMode;
        regDeadline = ca.registrationDeadline;
        openAt = ca.decryptionOpenAt;
        assertEq(manager.createCeremony(ca, _sign(orgKey, _hCreate(ca))), cid);
        if (total > initial) {
            address[] memory more = new address[](total - initial);
            for (uint256 i; i < more.length; ++i) {
                more[i] = vm.addr(inviteSecrets[initial + i]);
            }
            AddInvites memory aa = AddInvites(cid, uint32(initial), more, validUntil);
            manager.addInvites(aa, _sign(orgKey, _hAddInvites(aa)));
        }
        assertEq(manager.getCeremony(cid).inviteCount, total);

        delete authSecrets;
        delete memberX;
        for (uint256 i; i < n; ++i) {
            _replayJoin(_k(string.concat(sk, ".members"), i, ""), i + 1);
        }

        if (regMode == MANUAL) {
            (CloseRegistration memory cl, bytes memory clSig) = _closeMsg(uint8(n));
            manager.closeRegistration(cl, clSig, _roster());
            _snapIf("closeRegistration");
        } else {
            // permissionless, at the scheduled deadline: the dealing window is the scheduled one
            vm.expectRevert(RegistrationNotDue.selector);
            manager.closeRegistrationScheduled(cid, _roster());
            vm.warp(regDeadline);
            vm.prank(address(0xC1053));
            manager.closeRegistrationScheduled(cid, _roster());
            _snapIf("closeRegistrationScheduled");
            assertEq(manager.getCeremony(cid).dealingDeadline, regDeadline + manager.getPolicy(cid).dealingDuration);
        }
        CeremonyView memory v = manager.getCeremony(cid);
        assertEq(v.rosterHash, vm.parseJsonBytes32(ids, string.concat(sk, ".rosterHash")), "rosterHash");
        assertEq(v.ctx, vm.parseJsonBytes32(ids, string.concat(sk, ".ctx")), "ctx");
        assertEq(uint256(v.ctx) >> 128, vm.parseJsonUint(ids, string.concat(sk, ".ctxHi")), "ctxHi");
        assertEq(uint256(v.ctx) & type(uint128).max, vm.parseJsonUint(ids, string.concat(sk, ".ctxLo")), "ctxLo");
        if (real) {
            assertEq(v.rosterHash, vm.parseJsonBytes32(dealFx, ".rosterHash"), "fixture rosterHash");
            assertEq(v.ctx, vm.parseJsonBytes32(dealFx, ".ctx"), "fixture ctx");
        }
    }

    function _replayJoin(string memory mk, uint256 index) internal {
        assertEq(vm.parseJsonUint(ids, string.concat(mk, ".index")), index);
        uint256 authSecret = vm.parseJsonUint(ids, string.concat(mk, ".authSecret"));
        authSecrets.push(authSecret);
        address auth = vm.parseJsonAddress(ids, string.concat(mk, ".authAddress"));
        assertEq(vm.addr(authSecret), auth);
        uint32 inviteId = uint32(vm.parseJsonUint(ids, string.concat(mk, ".inviteId")));
        (uint256 X0, uint256 X1) = _pt(ids, string.concat(mk, ".X"));
        (uint256 A0, uint256 A1) = _pt(ids, string.concat(mk, ".pop.A"));
        uint256 z = vm.parseJsonUint(ids, string.concat(mk, ".pop.z"));
        // the recorded challenge equals HashToScalar over the TE transcript
        assertEq(
            _hashToScalar(abi.encode(TAG_JOIN_POP, block.chainid, address(manager), cid, auth, X0, X1, A0, A1)),
            vm.parseJsonUint(ids, string.concat(mk, ".pop.c")),
            "pop challenge"
        );
        assertEq(CouncilCurve.toReduced(X0), vm.parseJsonUint(ids, string.concat(mk, ".XReducedX")), "X reduced");
        JoinCall memory j;
        j.a = Join(cid, auth, inviteId, X0, X1, A0, A1, z, validUntil);
        j.inv = Invite(cid, inviteId, auth, X0, X1, validUntil);
        j.psig = _sign(authSecret, _hJoin(j.a));
        j.isig = _sign(inviteSecrets[inviteId], _hInvite(j.inv));
        _sendJoin(j);
        memberX.push([X0, X1]);
        (address gotAuth, uint256 word,) = manager.getParticipantCompressed(cid, uint8(index));
        assertEq(gotAuth, auth);
        assertEq(word, vm.parseJsonUint(ids, string.concat(mk, ".XCompressed")), "compressed X");
        assertEq(word, _compress(X0, X1), "compressed X (test side)");
    }

    function _replayDealing() internal {
        string memory ds = string.concat(_k(".scenarios", si, ""), ".dealings");
        dealCount = _count(dealingJson, ds);
        if (real) assertEq(_count(dealFx, ".dealings"), dealCount, "fixture dealing count");
        for (uint256 d; d < dealCount; ++d) {
            _replayDeal(_k(ds, d, ""), _k(".dealings", d, ""), d == 0, d > 0 && d == dealCount - 1);
        }
        assertEq(manager.getCeremony(cid).dealtCount, dealCount);
    }

    function _replayDeal(string memory dk, string memory fk, bool first, bool last) internal {
        DealCall memory d;
        uint256 j = vm.parseJsonUint(dealingJson, string.concat(dk, ".dealerIndex"));
        d.C = _points16(dealingJson, string.concat(dk, ".C"));
        (d.E[0], d.E[1]) = _pt(dealingJson, string.concat(dk, ".E"));
        uint256[] memory masked = vm.parseJsonUintArray(dealingJson, string.concat(dk, ".masked"));
        assertEq(masked.length, 16);
        for (uint256 i; i < 16; ++i) {
            d.masked[i] = masked[i];
        }
        uint256[] memory pubs = vm.parseJsonUintArray(dealingJson, string.concat(dk, ".publicInputs"));
        assertEq(pubs.length, 87);
        bytes32 payloadHash;
        if (real) {
            _crossCheckDealFixture(fk, j, d, pubs);
            _proof(dealFx, string.concat(fk, ".proof"));
            payloadHash = vm.parseJsonBytes32(dealFx, string.concat(fk, ".payloadHash"));
        } else {
            payloadHash = vm.parseJsonBytes32(dealingJson, string.concat(dk, ".payloadHash"));
        }
        assertEq(
            keccak256(abi.encode(TAG_DEAL_PAYLOAD, _ctx(), d.C, d.E, d.masked, pA, pB, pC)), payloadHash, "deal payload"
        );
        d.a = Deal(cid, uint8(j), payloadHash, validUntil);
        d.sig = _sign(authSecrets[j - 1], _hDeal(d.a));
        if (real) {
            // viem's RFC 6979 signature and ours are the same bytes
            assertEq(d.sig, vm.parseJsonBytes(dealFx, string.concat(fk, ".deal.signature")), "deal signature");
            assertEq(_digest(_hDeal(d.a)), vm.parseJsonBytes32(dealFx, string.concat(fk, ".deal.digest")), "digest");
        }

        uint256[87] memory pub;
        for (uint256 i; i < 87; ++i) {
            pub[i] = pubs[i];
        }
        vm.expectCall(manager.dealVerifier(), abi.encodeCall(IDealVerifier.verifyProof, (pA, pB, pC, pub)));
        manager.deal(d.a, d.sig, d.C, d.E, d.masked, pA, pB, pC, _roster());
        if (first) _snapIf("deal_first");
        if (last) _snapIf("deal_last");

        (uint256 wordE, uint256[16] memory m) = manager.getRecoveryDealing(cid, uint8(j));
        for (uint256 k; k < 16; ++k) {
            assertEq(m[k], d.masked[k]);
        }
        assertEq(wordE, _compress(d.E[0], d.E[1]), "compressed E");
    }

    /// @dev The fixture's dealing is the vectors' dealing, and its public signals are the
    ///      vectors' 87-word vector.
    function _crossCheckDealFixture(string memory fk, uint256 j, DealCall memory d, uint256[] memory pubs)
        internal
        view
    {
        assertEq(vm.parseJsonUint(dealFx, string.concat(fk, ".dealerIndex")), j, "fixture dealer");
        uint256[2][16] memory C = _points16(dealFx, string.concat(fk, ".C"));
        for (uint256 k; k < 16; ++k) {
            assertEq(C[k][0], d.C[k][0], "fixture C");
            assertEq(C[k][1], d.C[k][1], "fixture C");
        }
        uint256[] memory fpub = vm.parseJsonUintArray(dealFx, string.concat(fk, ".pubSignals"));
        assertEq(fpub.length, 87);
        for (uint256 i; i < 87; ++i) {
            assertEq(fpub[i], pubs[i], "fixture pubSignals");
        }
    }

    function _replayFinalize() internal {
        string memory rs = _k(".scenarios", si, "");
        if (dealCount < n) {
            vm.expectRevert(FinalizeConditionNotMet.selector);
            manager.finalize(cid);
            vm.warp(manager.getCeremony(cid).dealingDeadline + 1);
        }
        manager.finalize(cid);
        _snapIf("finalize");
        CeremonyView memory v = manager.getCeremony(cid);
        assertEq(v.phase, uint8(Phase.Live));
        assertEq(v.qualBitmap, vm.parseJsonUint(recoveryJson, string.concat(rs, ".qualBitmap")), "qualBitmap");
        (uint256 px, uint256 py) = _pt(recoveryJson, string.concat(rs, ".publicKey"));
        assertEq(v.pkX, px, "P.x");
        assertEq(v.pkY, py, "P.y");
        uint256[2][16] memory A = manager.getAggregates(cid);
        for (uint256 k; k < T; ++k) {
            (uint256 ax, uint256 ay) = _pt(recoveryJson, _k(string.concat(rs, ".aggregates"), k, ""));
            assertEq(A[k][0], ax, "A_k.x");
            assertEq(A[k][1], ay, "A_k.y");
        }
        for (uint256 i; i < n; ++i) {
            string memory mk = _k(string.concat(rs, ".members"), i, "");
            uint8 index = uint8(vm.parseJsonUint(recoveryJson, string.concat(mk, ".index")));
            (uint256 kx, uint256 ky) = _pt(recoveryJson, string.concat(mk, ".PK"));
            (uint256 gx, uint256 gy) = manager.getMemberKey(cid, index);
            assertEq(gx, kx, "PK_i.x");
            assertEq(gy, ky, "PK_i.y");
            (uint256 sx, uint256 sy) = Bjj.mulG(vm.parseJsonUint(recoveryJson, string.concat(mk, ".share")));
            assertEq(sx, kx, "s_i G");
            assertEq(sy, ky, "s_i G");
            _checkRecoverySlice(rs, mk, index);
        }
        // the biased storage words of protocol §8.3 (the generator's x + 1, y + 1)
        for (uint256 k; k < T; ++k) {
            (uint256 bx, uint256 by) = _pt(recoveryJson, _k(string.concat(rs, ".aggregatesBiased"), k, ""));
            assertEq(A[k][0] + 1, bx, "biased A_k.x");
            assertEq(A[k][1] + 1, by, "biased A_k.y");
        }
    }

    /// @dev getRecoverySlice serves exactly the recovery.json inputs: QUAL, compressed(E_j) and
    ///      masked_{j,index} for every dealer, zero outside QUAL (protocol §8.6).
    function _checkRecoverySlice(string memory rs, string memory mk, uint8 index) internal view {
        (uint16 qual, uint256[16] memory words, uint256[16] memory masked) = manager.getRecoverySlice(cid, index);
        assertEq(qual, vm.parseJsonUint(recoveryJson, string.concat(rs, ".qualBitmap")), "slice QUAL");
        assertEq(vm.parseJsonUint(recoveryJson, string.concat(mk, ".compressedX")), memberXWord(index), "compressedX");
        uint256 dealers = _count(recoveryJson, string.concat(rs, ".dealers"));
        uint256 seen;
        for (uint256 d; d < dealers; ++d) {
            string memory dk = _k(string.concat(rs, ".dealers"), d, "");
            uint256 j = vm.parseJsonUint(recoveryJson, string.concat(dk, ".dealerIndex"));
            assertEq(words[j - 1], vm.parseJsonUint(recoveryJson, string.concat(dk, ".compressedE")), "slice E");
            string memory pd = _k(string.concat(mk, ".perDealer"), d, "");
            assertEq(vm.parseJsonUint(recoveryJson, string.concat(pd, ".dealerIndex")), j);
            assertEq(masked[j - 1], vm.parseJsonUint(recoveryJson, string.concat(pd, ".masked")), "slice masked");
            seen |= 1 << (j - 1);
        }
        for (uint256 j; j < 16; ++j) {
            if ((seen >> j) & 1 == 0) {
                assertEq(words[j], 0, "E outside QUAL");
                assertEq(masked[j], 0, "masked outside QUAL");
            }
        }
    }

    function memberXWord(uint8 index) internal view returns (uint256 word) {
        (, word,) = manager.getParticipantCompressed(cid, index);
    }

    function _replayRequest() internal {
        string memory cs = _k(".scenarios", si, "");
        address ad = vm.parseJsonAddress(ids, string.concat(sk, ".request.adapter"));
        address cr = vm.parseJsonAddress(ids, string.concat(sk, ".request.creator"));
        bytes31 processId = bytes31(vm.parseJsonBytes(ids, string.concat(sk, ".request.processId")));
        requestId = vm.parseJsonBytes32(ids, string.concat(sk, ".request.requestId"));
        _allow(ad);
        _authorize(cr);
        vm.prank(ad);
        (bytes32 rid, uint256 px, uint256 py) = manager.bindProcess(cid, processId, cr);
        assertEq(rid, requestId, "requestId");
        (uint256 wx, uint256 wy) = _pt(combineJson, string.concat(cs, ".publicKey"));
        assertEq(px, wx);
        assertEq(py, wy);

        uint256 fieldCount = vm.parseJsonUint(combineJson, string.concat(cs, ".request.fieldCount"));
        uint256[4][] memory c = new uint256[4][](fieldCount);
        for (uint256 k; k < fieldCount; ++k) {
            uint256[] memory w = vm.parseJsonUintArray(combineJson, _k(string.concat(cs, ".request.cts"), k, ""));
            c[k] = [w[0], w[1], w[2], w[3]];
            if (real) {
                uint256[] memory f = vm.parseJsonUintArray(partialFx, _k(".request.cts", k, ""));
                for (uint256 i; i < 4; ++i) {
                    assertEq(f[i], w[i], "fixture cts");
                }
            }
        }
        vm.prank(ad);
        assertEq(manager.submitRequest(cid, processId, c), requestId);
        _snapIf("submitRequest");
        delete cts;
        for (uint256 k; k < fieldCount; ++k) {
            cts.push(c[k]);
        }
        uint256[2][] memory words = manager.getRequestCompressed(requestId);
        assertEq(words.length, fieldCount);
        for (uint256 k; k < fieldCount; ++k) {
            uint256[] memory w =
                vm.parseJsonUintArray(combineJson, _k(string.concat(cs, ".request.compressedCts"), k, ""));
            assertEq(words[k][0], w[0], "compressed C1");
            assertEq(words[k][1], w[1], "compressed C2");
        }
    }

    /// @dev Scenario A: the organizer opens (Manual); B: the clock reaches decryptionOpenAt. Either
    ///      way partials are refused until then.
    function _replayOpening() internal {
        assertFalse(manager.isDecryptionOpen(cid), "gate closed after request");
        if (decMode == MANUAL) {
            (OpenDecryption memory a, bytes memory sig) = _openMsg();
            manager.openDecryption(a, sig);
            _snapIf("openDecryption");
        } else {
            vm.warp(openAt - 1);
            assertFalse(manager.isDecryptionOpen(cid));
            vm.warp(openAt);
        }
        assertTrue(manager.isDecryptionOpen(cid), "gate open");
    }

    function _replayPartialsAndCombines() internal {
        string memory cs = _k(".scenarios", si, "");
        uint256 fieldCount = cts.length;
        string memory ps = string.concat(cs, ".partials");
        uint256 partials = _count(combineJson, ps);
        if (real) assertEq(_count(partialFx, ".partials"), partials, "fixture partial count");
        for (uint256 i; i < partials; ++i) {
            _replayPartial(_k(ps, i, ""), _k(".partials", i, ""), i == 0);
        }
        // permissionless re-publication of member 1's vector moves only its publication block
        vm.roll(block.number + 7);
        vm.prank(address(0xBEEF));
        manager.publishPartialData(requestId, 1, dOf[requestId][1]);
        _snapIf("publishPartialData");
        (, bytes32 h,) = manager.getPartialCommitment(requestId, 1);
        assertEq(h, vm.parseJsonBytes32(combineJson, string.concat(_k(ps, 0, ""), ".partialDataHash")));
        _replayCombines(cs, fieldCount);
    }

    function _replayPartial(string memory pk, string memory fk, bool first) internal {
        PartialCall memory p;
        uint256 index = vm.parseJsonUint(combineJson, string.concat(pk, ".index"));
        p.D = _points16(combineJson, string.concat(pk, ".D"));
        uint256[] memory pubs = vm.parseJsonUintArray(combineJson, string.concat(pk, ".publicInputs"));
        assertEq(pubs.length, 67);
        bytes32 payloadHash;
        if (real) {
            assertEq(vm.parseJsonUint(partialFx, string.concat(fk, ".participantIndex")), index, "fixture index");
            uint256[] memory fpub = vm.parseJsonUintArray(partialFx, string.concat(fk, ".pubSignals"));
            assertEq(fpub.length, 67);
            for (uint256 i; i < 67; ++i) {
                assertEq(fpub[i], pubs[i], "fixture pubSignals");
            }
            _proof(partialFx, string.concat(fk, ".proof"));
            payloadHash = vm.parseJsonBytes32(partialFx, string.concat(fk, ".payloadHash"));
        } else {
            payloadHash = vm.parseJsonBytes32(combineJson, string.concat(pk, ".payloadHash"));
        }
        assertEq(keccak256(abi.encode(TAG_PARTIAL_PAYLOAD, requestId, p.D, pA, pB, pC)), payloadHash, "partial payload");
        p.a = Partial(cid, requestId, uint8(index), payloadHash, validUntil);
        p.sig = _sign(authSecrets[index - 1], _hPartial(p.a));
        if (real) {
            assertEq(p.sig, vm.parseJsonBytes(partialFx, string.concat(fk, ".partial.signature")), "partial signature");
        }
        uint256[67] memory pub;
        for (uint256 i; i < 67; ++i) {
            pub[i] = pubs[i];
        }
        vm.expectCall(manager.partialVerifier(), abi.encodeCall(IPartialVerifier.verifyProof, (pA, pB, pC, pub)));
        manager.submitPartial(p.a, p.sig, p.D, pA, pB, pC, _c1());
        if (first) _snapIf("submitPartial_first");
        dOf[requestId][index] = p.D;
        (bool accepted, bytes32 dataHash, uint64 block_) = manager.getPartialCommitment(requestId, uint8(index));
        assertTrue(accepted);
        assertEq(dataHash, vm.parseJsonBytes32(combineJson, string.concat(pk, ".partialDataHash")), "partialDataHash");
        assertEq(dataHash, _partialDataHash(requestId, index, cts.length, p.D), "partialDataHash (test side)");
        assertEq(block_, block.number, "published block");
    }

    function _replayCombines(string memory cs, uint256 fieldCount) internal {
        uint256[] memory plain = vm.parseJsonUintArray(combineJson, string.concat(cs, ".request.plaintexts"));
        string memory cmb = string.concat(cs, ".combines");
        uint256 count = _count(combineJson, cmb);
        assertGt(count, 0);
        for (uint256 c; c < count; ++c) {
            uint8[] memory set = _uint8s(vm.parseJsonUintArray(combineJson, _k(cmb, c, ".memberSet")));
            uint256 snap = vm.snapshotState();
            // one wrong plaintext never verifies
            uint8[] memory f0 = new uint8[](1);
            uint64[] memory bad = new uint64[](1);
            bad[0] = uint64(plain[0] == 0 ? 1 : plain[0] - 1);
            vm.expectRevert(CombineCheckFailed.selector);
            manager.combine(requestId, set, f0, bad, _vectors(set), _c2(f0));
            for (uint256 start; start < fieldCount; start += 4) {
                uint256 len = fieldCount - start < 4 ? fieldCount - start : 4;
                uint8[] memory fields = _range(start, len);
                uint64[] memory pts = new uint64[](len);
                for (uint256 i; i < len; ++i) {
                    pts[i] = uint64(plain[start + i]);
                }
                manager.combine(requestId, set, fields, pts, _vectors(set), _c2(fields));
                if (c == 0 && start == 0) _snapIf(string.concat("combine_", vm.toString(len), "fields"));
            }
            (bool ready, uint256[] memory values) = manager.getPlaintexts(requestId);
            assertTrue(ready, "ready");
            assertEq(values.length, fieldCount);
            for (uint256 k; k < fieldCount; ++k) {
                assertEq(values[k], plain[k], "plaintext");
            }
            vm.revertToState(snap);
        }
    }
}
