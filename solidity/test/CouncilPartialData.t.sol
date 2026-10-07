// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Vm} from "forge-std/Vm.sol";
import "../src/CouncilTypes.sol";
import {ICouncilCore} from "../src/interfaces/ICouncil.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";
import {CouncilManagerHarness, CurveHarness} from "./utils/Harnesses.sol";
import {Bjj} from "./utils/Bjj.sol";

/// @notice protocol §10.2–§10.4: the durable partial-data commitment that replaces stored D
///         vectors (architecture §7 "Partial-data hash adversaries"). The partialdata.json vectors
///         through the contract's own hash; every substitution of a re-supplied vector at combine
///         or publishPartialData (permutation, another request, another chain, truncated or padded
///         slices, another member's vector) is `PartialDataMismatch()` with nothing changed;
///         re-publication moves only the publication block; and the two combiner fallbacks of
///         §10.4 (one single-block log read, member re-publication from current state) complete a
///         request with nothing else.
contract CouncilPartialDataTest is CouncilTestBase {
    string internal constant VECTORS = "../tests/vectors/partialdata.json";
    address internal constant STRANGER = address(0x5778A6E7);

    // ─── partialdata.json ─────────────────────────────────────────────────────────────────

    function _k(string memory a, uint256 i, string memory b) internal pure returns (string memory) {
        return string.concat(a, "[", vm.toString(i), "]", b);
    }

    function _count(string memory json, string memory key) internal view returns (uint256 c) {
        while (vm.keyExistsJson(json, _k(key, c, ""))) {
            ++c;
        }
    }

    function _points16(string memory json, string memory key) internal pure returns (uint256[2][16] memory out) {
        for (uint256 i; i < 16; ++i) {
            uint256[] memory a = vm.parseJsonUintArray(json, _k(key, i, ""));
            assertEq(a.length, 2);
            (out[i][0], out[i][1]) = (a[0], a[1]);
        }
    }

    /// @dev The harness (the real manager with `_partialDataHash` exposed) at `mgr`.
    function _harnessAt(address mgr) internal returns (CouncilManagerHarness) {
        if (mgr.code.length == 0) {
            deployCodeTo("Harnesses.sol:CouncilManagerHarness", abi.encode(address(1), address(2), bytes32(0)), mgr);
        }
        return CouncilManagerHarness(mgr);
    }

    /// @dev One preimage under `k` (chainId, manager, ceremonyId, requestId, participantIndex,
    ///      fieldCount, D): the test-side tagged hash and the contract's, both equal to the vector.
    function _checkEntry(string memory json, string memory k, bytes32 tagHash) internal returns (bytes32 want) {
        uint256 chainId = vm.parseJsonUint(json, string.concat(k, ".chainId"));
        address mgr = vm.parseJsonAddress(json, string.concat(k, ".manager"));
        bytes12 c = bytes12(vm.parseJsonBytes(json, string.concat(k, ".ceremonyId")));
        bytes32 rid = vm.parseJsonBytes32(json, string.concat(k, ".requestId"));
        uint8 index = uint8(vm.parseJsonUint(json, string.concat(k, ".participantIndex")));
        uint8 fc = uint8(vm.parseJsonUint(json, string.concat(k, ".fieldCount")));
        uint256[2][16] memory D = _points16(json, string.concat(k, ".D"));
        want = vm.parseJsonBytes32(json, string.concat(k, ".partialDataHash"));
        assertEq(keccak256(abi.encode(tagHash, chainId, mgr, c, rid, index, fc, D)), want, k);
        vm.chainId(chainId);
        assertEq(_harnessAt(mgr).partialDataHash(c, rid, index, fc, D), want, k);
    }

    function test_Vectors_PartialDataHash() public {
        if (!vm.exists(VECTORS)) {
            vm.skip(true);
            return;
        }
        string memory j = vm.readFile(VECTORS);
        assertEq(vm.parseJsonString(j, ".tag"), "davinci-dkg-council/v2/partial-data");
        bytes32 tagHash = vm.parseJsonBytes32(j, ".tagHash");
        assertEq(tagHash, TAG_PARTIAL_DATA);
        assertEq(tagHash, 0xe9c88d2345099d5c36ae9c5ef6fb2d2396dc1633fee75cfb7680fca2214182af);
        assertEq(vm.parseJsonStringArray(j, ".preimageTypes").length, 8);

        bytes32 base = _checkEntry(j, ".base", tagHash);
        uint256 mutations = _count(j, ".mutations");
        assertGe(mutations, 11);
        for (uint256 i; i < mutations; ++i) {
            bytes32 m = _checkEntry(j, _k(".mutations", i, ""), tagHash);
            assertTrue(m != base, vm.parseJsonString(j, _k(".mutations", i, ".name")));
        }

        uint256 scenarios = _count(j, ".scenarios");
        assertEq(scenarios, 2);
        for (uint256 s; s < scenarios; ++s) {
            string memory sk = _k(".scenarios", s, "");
            uint256 chainId = vm.parseJsonUint(j, string.concat(sk, ".chainId"));
            CouncilManagerHarness hm = _harnessAt(vm.parseJsonAddress(j, string.concat(sk, ".manager")));
            bytes12 c = bytes12(vm.parseJsonBytes(j, string.concat(sk, ".ceremonyId")));
            bytes32 rid = vm.parseJsonBytes32(j, string.concat(sk, ".requestId"));
            uint8 fc = uint8(vm.parseJsonUint(j, string.concat(sk, ".fieldCount")));
            vm.chainId(chainId);
            uint256 partials = _count(j, string.concat(sk, ".partials"));
            assertGt(partials, 0);
            for (uint256 i; i < partials; ++i) {
                string memory pk = _k(string.concat(sk, ".partials"), i, "");
                uint8 index = uint8(vm.parseJsonUint(j, string.concat(pk, ".index")));
                uint256[2][16] memory D = _points16(j, string.concat(pk, ".D"));
                assertEq(
                    hm.partialDataHash(c, rid, index, fc, D),
                    vm.parseJsonBytes32(j, string.concat(pk, ".partialDataHash")),
                    "scenario partial"
                );
            }
        }
    }

    // ─── Fixture ──────────────────────────────────────────────────────────────────────────

    /// @dev n = 3, t = 2, Live and open; one 3-field request with the partials of `members` (bit
    ///      i-1 = member i), each in its own block.
    function _requested(uint256 members) internal {
        _toLive(3, 2);
        _bindAndRequest(bytes31(uint248(5)), _u64s(10, 20, 30));
        for (uint256 i = 1; i <= 3; ++i) {
            if ((members >> (i - 1)) & 1 == 0) continue;
            vm.roll(vm.getBlockNumber() + 10);
            _partial(i);
        }
    }

    function _digest() internal view returns (bytes32) {
        (bytes12 rc, uint8 fc, uint16 completed, uint16 partials) = manager.getRequestMeta(requestId);
        bytes memory commitments;
        for (uint8 i = 1; i <= 3; ++i) {
            (bool accepted, bytes32 dh, uint64 blk) = manager.getPartialCommitment(requestId, i);
            commitments = bytes.concat(commitments, abi.encode(accepted, dh, blk));
        }
        (bool ready, uint256[] memory values) = manager.getPlaintexts(requestId);
        return keccak256(abi.encode(rc, fc, completed, partials, commitments, ready, values));
    }

    function _two(uint256[2][16] memory a, uint256[2][16] memory b) internal pure returns (uint256[2][16][] memory v) {
        v = new uint256[2][16][](2);
        v[0] = a;
        v[1] = b;
    }

    function _set(uint8 a, uint8 b) internal pure returns (uint8[] memory s) {
        s = new uint8[](2);
        (s[0], s[1]) = (a, b);
    }

    function _expectMismatch(uint8[] memory set, uint256[2][16][] memory vectors) internal {
        uint8[] memory f = _range(0, 3);
        vm.expectRevert(PartialDataMismatch.selector);
        manager.combine(requestId, set, f, _plain(f), vectors, _c2(f));
    }

    /// @dev Mutations of member `i`'s honest vector that change the committed preimage.
    function _mutations(uint256 i) internal view returns (uint256[2][16][6] memory m) {
        uint256[2][16] memory D = dOf[requestId][i];
        for (uint256 v; v < 6; ++v) {
            m[v] = D;
        }
        (m[0][2][0], m[0][2][1]) = (0, 1); // last active field truncated to the identity
        (m[1][3][0], m[1][3][1]) = (Bjj.GX, Bjj.GY); // first inactive slot padded with G
        (m[2][0], m[2][1]) = (D[1], D[0]); // two fields permuted
        (m[3][1][0], m[3][1][1]) = Bjj.mulG(4242); // one point replaced by another curve point
        m[4][0][1] = D[0][1] + P; // a coordinate alias of the same residue
        (m[5][0][0], m[5][0][1]) = Bjj.neg(D[0][0], D[0][1]); // -D_0
    }

    // ─── combine adversaries ──────────────────────────────────────────────────────────────

    function test_Combine_PermutedVectorsRejected() public {
        _requested(7);
        bytes32 before = _digest();
        _expectMismatch(_set(1, 2), _two(dOf[requestId][2], dOf[requestId][1]));
        _expectMismatch(_set(1, 3), _two(dOf[requestId][3], dOf[requestId][1]));
        assertEq(_digest(), before);
        _combine(_set(1, 2), _range(0, 3));
        (bool ready,) = manager.getPlaintexts(requestId);
        assertTrue(ready);
    }

    /// @dev The same members' vectors from another request of the same ceremony.
    function test_Combine_VectorFromAnotherRequestRejected() public {
        _requested(3);
        bytes32 first = requestId;
        _bindAndRequest(bytes31(uint248(6)), _u64s(40, 50, 60));
        _partial(1);
        _partial(2);
        bytes32 before = _digest();
        _expectMismatch(_set(1, 2), _two(dOf[first][1], dOf[requestId][2]));
        _expectMismatch(_set(1, 2), _two(dOf[requestId][1], dOf[first][2]));
        _expectMismatch(_set(1, 2), _two(dOf[first][1], dOf[first][2]));
        assertEq(_digest(), before);
        _combine(_set(1, 2), _range(0, 3));
        (, uint256[] memory values) = manager.getPlaintexts(requestId);
        assertEq(values[1], 50);
    }

    /// @dev The commitment binds the chain id: the honest vectors fail on another chain.
    function test_Combine_CrossChainDomainRejected() public {
        _requested(3);
        uint256[2][16][] memory honest = _vectors(_set(1, 2));
        bytes32 before = _digest();
        vm.chainId(100);
        _expectMismatch(_set(1, 2), honest);
        vm.expectRevert(PartialDataMismatch.selector);
        manager.publishPartialData(requestId, 1, honest[0]);
        vm.chainId(31337);
        assertEq(_digest(), before);
        _combine(_set(1, 2), _range(0, 3));
    }

    /// @dev Truncated / padded slices, a permutation, a substituted point, a coordinate alias and
    ///      a negated point in either selected position: all mismatch at combine.
    function test_Combine_MutatedVectorsRejected() public {
        _requested(3);
        bytes32 before = _digest();
        uint256[2][16][6] memory m1 = _mutations(1);
        uint256[2][16][6] memory m2 = _mutations(2);
        for (uint256 v; v < 6; ++v) {
            _expectMismatch(_set(1, 2), _two(m1[v], dOf[requestId][2]));
            _expectMismatch(_set(1, 2), _two(dOf[requestId][1], m2[v]));
        }
        assertEq(_digest(), before);
    }

    /// @dev Another member's vector under the right index, a duplicated vector.
    function test_Combine_WrongMembersVectorRejected() public {
        _requested(7);
        bytes32 before = _digest();
        _expectMismatch(_set(1, 2), _two(dOf[requestId][1], dOf[requestId][3]));
        _expectMismatch(_set(1, 2), _two(dOf[requestId][3], dOf[requestId][2]));
        _expectMismatch(_set(2, 3), _two(dOf[requestId][2], dOf[requestId][2]));
        assertEq(_digest(), before);
        _combine(_set(2, 3), _range(0, 3));
    }

    /// @dev Exactly one vector per selected member.
    function test_Combine_VectorCountMustBeT() public {
        _requested(7);
        uint8[] memory f = _range(0, 3);
        uint256[2][16][] memory one = new uint256[2][16][](1);
        one[0] = dOf[requestId][1];
        vm.expectRevert(BadMemberSet.selector);
        manager.combine(requestId, _set(1, 2), f, _plain(f), one, _c2(f));
        uint8[] memory three = _range(1, 3);
        vm.expectRevert(BadMemberSet.selector);
        manager.combine(requestId, _set(1, 2), f, _plain(f), _vectors(three), _c2(f));
        vm.expectRevert(BadMemberSet.selector);
        manager.combine(requestId, _set(1, 2), f, _plain(f), new uint256[2][16][](0), _c2(f));
    }

    // ─── publishPartialData ───────────────────────────────────────────────────────────────

    function test_Publish_Rejections() public {
        _requested(3);
        bytes32 before = _digest();
        uint256[2][16][6] memory m = _mutations(1);
        for (uint256 v; v < 6; ++v) {
            vm.expectRevert(PartialDataMismatch.selector);
            manager.publishPartialData(requestId, 1, m[v]);
        }
        // member 2's honest vector under index 1, and member 1's under index 2
        vm.expectRevert(PartialDataMismatch.selector);
        manager.publishPartialData(requestId, 1, dOf[requestId][2]);
        vm.expectRevert(PartialDataMismatch.selector);
        manager.publishPartialData(requestId, 2, dOf[requestId][1]);
        // no accepted partial: member 3, indexes 0 and 17
        uint256[2][16] memory D3 = _partialMsg(3).D;
        vm.expectRevert(MissingPartial.selector);
        manager.publishPartialData(requestId, 3, D3);
        vm.expectRevert(MissingPartial.selector);
        manager.publishPartialData(requestId, 0, dOf[requestId][1]);
        vm.expectRevert(MissingPartial.selector);
        manager.publishPartialData(requestId, 17, dOf[requestId][1]);
        // unknown request, and a bound process whose request was never submitted
        vm.expectRevert(UnknownRequest.selector);
        manager.publishPartialData(keccak256("nope"), 1, dOf[requestId][1]);
        (, bytes32 bound,,) = adapter.register(bytes31(uint248(99)), creator, cid);
        vm.expectRevert(UnknownRequest.selector);
        manager.publishPartialData(bound, 1, dOf[requestId][1]);
        assertEq(_digest(), before);
    }

    /// @dev A correct re-publication by anyone moves the publication block and nothing else, can
    ///      be repeated, and still works (changing nothing) once the request is complete.
    function test_Publish_UpdatesOnlyTheBlock() public {
        _requested(3);
        (bool acc0, bytes32 h0, uint64 b0) = manager.getPartialCommitment(requestId, 1);
        assertTrue(acc0);
        (,, uint16 completed0, uint16 partials0) = manager.getRequestMeta(requestId);
        (, bytes32 h2, uint64 b2) = manager.getPartialCommitment(requestId, 2);

        uint256 later = vm.getBlockNumber() + 1000;
        vm.roll(later);
        vm.expectEmit(address(manager));
        emit ICouncilCore.PartialDataPublished(requestId, 1, h0, dOf[requestId][1]);
        vm.prank(STRANGER);
        manager.publishPartialData(requestId, 1, dOf[requestId][1]);
        (bool acc1, bytes32 h1, uint64 b1) = manager.getPartialCommitment(requestId, 1);
        assertTrue(acc1);
        assertEq(h1, h0, "hash unchanged");
        assertEq(b1, later, "block moved");
        assertTrue(b1 != b0);
        (,, uint16 completed1, uint16 partials1) = manager.getRequestMeta(requestId);
        assertEq(completed1, completed0);
        assertEq(partials1, partials0);
        (, bytes32 h2b, uint64 b2b) = manager.getPartialCommitment(requestId, 2);
        assertEq(h2b, h2, "other member untouched");
        assertEq(b2b, b2);

        vm.roll(later + 5);
        manager.publishPartialData(requestId, 1, dOf[requestId][1]);
        (,, b1) = manager.getPartialCommitment(requestId, 1);
        assertEq(b1, later + 5, "repeatable");

        _combine(_set(1, 2), _range(0, 3));
        (bool ready, uint256[] memory values) = manager.getPlaintexts(requestId);
        assertTrue(ready);
        bytes32 done = _digest();
        vm.roll(later + 9);
        vm.prank(STRANGER);
        manager.publishPartialData(requestId, 2, dOf[requestId][2]);
        (bool ready2, uint256[] memory values2) = manager.getPlaintexts(requestId);
        assertTrue(ready2);
        assertEq(keccak256(abi.encode(values2)), keccak256(abi.encode(values)));
        (,, uint16 completed2, uint16 partials2) = manager.getRequestMeta(requestId);
        assertEq(completed2, 7);
        assertEq(partials2, 3);
        (, bytes32 h2c, uint64 b2c) = manager.getPartialCommitment(requestId, 2);
        assertEq(h2c, h2);
        assertEq(b2c, later + 9);
        assertTrue(_digest() != done); // only through member 2's block
    }

    // ─── §10.4 combiner paths 2 and 3 ─────────────────────────────────────────────────────

    struct Published {
        uint256 blockNumber;
        Vm.Log log;
    }

    Published[] internal published;

    function _recordPartial(uint256 i, uint256 blockNumber) internal {
        vm.roll(blockNumber);
        vm.recordLogs();
        _partial(i);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 k; k < logs.length; ++k) {
            published.push(Published(blockNumber, logs[k]));
        }
    }

    /// @dev The single-block read: a PartialDataPublished log of the manager at exactly the
    ///      stored publishedBlock, for this request and member, authenticated by the stored hash.
    function _vectorFromLogs(uint8 m) internal view returns (uint256[2][16] memory D) {
        (bool accepted, bytes32 h, uint64 blk) = manager.getPartialCommitment(requestId, m);
        assertTrue(accepted);
        for (uint256 k; k < published.length; ++k) {
            Published storage e = published[k];
            if (e.blockNumber != blk || e.log.emitter != address(manager)) continue;
            if (e.log.topics.length != 2 || e.log.topics[0] != ICouncilCore.PartialDataPublished.selector) continue;
            if (e.log.topics[1] != requestId) continue;
            (uint8 index, bytes32 dh, uint256[2][16] memory got) =
                abi.decode(e.log.data, (uint8, bytes32, uint256[2][16]));
            if (index != m || dh != h) continue;
            assertEq(_partialDataHash(requestId, m, cts.length, got), h, "log vector authenticated by the hash");
            return got;
        }
        revert("no log at the stored block");
    }

    /// @dev Path 2: the combiner holds no cache; it reads each selected member's vector from the
    ///      log at its stored publishedBlock (after a re-publication, at the new block) and
    ///      completes the request with those decoded vectors only.
    function test_CombinerPath2_SingleBlockLogRead() public {
        _toLive(3, 2);
        _bindAndRequest(bytes31(uint248(5)), _u64s(10, 20, 30));
        _recordPartial(1, 100);
        _recordPartial(3, 200);
        // member 1's vector is re-published later: the stored block moves there
        vm.roll(300);
        vm.recordLogs();
        manager.publishPartialData(requestId, 1, dOf[requestId][1]);
        Vm.Log[] memory logs = vm.getRecordedLogs();
        for (uint256 k; k < logs.length; ++k) {
            published.push(Published(300, logs[k]));
        }
        (,, uint64 b1) = manager.getPartialCommitment(requestId, 1);
        assertEq(b1, 300);

        uint8[] memory set = _set(1, 3);
        uint256[2][16][] memory vectors = new uint256[2][16][](2);
        vectors[0] = _vectorFromLogs(1);
        vectors[1] = _vectorFromLogs(3);
        delete dOf[requestId][1];
        delete dOf[requestId][3];
        uint8[] memory f = _range(0, 3);
        manager.combine(requestId, set, f, _plain(f), vectors, _c2(f));
        (bool ready, uint256[] memory values) = manager.getPlaintexts(requestId);
        assertTrue(ready);
        assertEq(values[0], 10);
        assertEq(values[2], 30);
    }

    /// @dev Path 3: every vector copy is lost; returning members recompute D = s_i·C1 from their
    ///      share and the stored ciphertexts (authenticated against the compressed words), the old
    ///      commitments match without the old proofs, they re-publish, and combine completes.
    function test_CombinerPath3_RepublishFromShares() public {
        _requested(5); // members 1 and 3
        delete dOf[requestId][1];
        delete dOf[requestId][3];
        CurveHarness ch = new CurveHarness();
        uint256[2][] memory words = manager.getRequestCompressed(requestId);
        for (uint256 k; k < 3; ++k) {
            ch.authenticate(cts[k][0], cts[k][1], words[k][0]); // the member's own C1 copy is the stored one
        }
        uint8[] memory set = _set(1, 3);
        uint256[2][16][] memory vectors = new uint256[2][16][](2);
        for (uint256 i; i < 2; ++i) {
            uint256 s = _share(set[i]);
            for (uint256 k; k < 16; ++k) {
                if (k < 3) (vectors[i][k][0], vectors[i][k][1]) = Bjj.mul(s, cts[k][0], cts[k][1]);
                else vectors[i][k][1] = 1;
            }
            (, bytes32 h,) = manager.getPartialCommitment(requestId, set[i]);
            assertEq(_partialDataHash(requestId, set[i], 3, vectors[i]), h, "deterministic D");
            vm.roll(vm.getBlockNumber() + 50);
            vm.prank(vm.addr(authSecrets[set[i] - 1]));
            manager.publishPartialData(requestId, set[i], vectors[i]);
        }
        uint8[] memory f = _range(0, 3);
        vm.prank(STRANGER);
        manager.combine(requestId, set, f, _plain(f), vectors, _c2(f));
        (bool ready,) = manager.getPlaintexts(requestId);
        assertTrue(ready);
    }

    // ─── The commitment is not the signed payload hash ────────────────────────────────────

    /// @dev Two proofs of the same D: different signed payload hashes, the same stored
    ///      partialDataHash (it excludes the proof, protocol §10.2).
    function test_DataHashExcludesTheProof() public {
        _requested(0);
        PartialCall memory p = _partialMsg(1);
        bytes32 payloadA = p.a.payloadHash;
        uint256 snap = vm.snapshotState();
        manager.submitPartial(p.a, p.sig, p.D, _pA(), _pB(), _pC(), _c1());
        (, bytes32 hA,) = manager.getPartialCommitment(requestId, 1);
        vm.revertToState(snap);

        (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proofWith(5, 99);
        p.a.payloadHash = keccak256(abi.encode(TAG_PARTIAL_PAYLOAD, requestId, p.D, a, b, c));
        p.sig = _sign(authSecrets[0], _hPartial(p.a));
        manager.submitPartial(p.a, p.sig, p.D, a, b, c, _c1());
        (, bytes32 hB,) = manager.getPartialCommitment(requestId, 1);

        assertTrue(p.a.payloadHash != payloadA, "payload hashes differ");
        assertEq(hA, hB, "same commitment");
        assertEq(hA, _partialDataHash(requestId, 1, 3, p.D));
        assertTrue(hA != payloadA && hA != p.a.payloadHash);
    }
}
