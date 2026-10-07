// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {ICouncilCore} from "../src/interfaces/ICouncil.sol";
import {IPartialVerifier} from "../src/interfaces/ICouncilVerifiers.sol";
import {MockCouncilAdapter} from "./mocks/MockCouncilAdapter.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";
import {Bjj} from "./utils/Bjj.sol";

/// @notice Authorization, binding, request admission, partials and combine (protocol §§9–10).
contract CouncilDecryptionTest is CouncilTestBase {
    // ─── allowAdapter / authorizeCreator ──────────────────────────────────────────────────

    function test_AllowLists() public {
        _create(2, 3); // any phase, here Registration
        (AllowAdapter memory a, bytes memory sig) = _allowMsg(address(adapter));
        vm.expectEmit(address(manager));
        emit ICouncilCore.AdapterAllowed(cid, address(adapter));
        manager.allowAdapter(a, sig);
        assertTrue(manager.isAdapterAllowed(cid, address(adapter)));
        vm.expectRevert(AlreadyListed.selector);
        manager.allowAdapter(a, sig);

        (AuthorizeCreator memory c, bytes memory csig) = _authorizeMsg(creator);
        vm.expectEmit(address(manager));
        emit ICouncilCore.CreatorAuthorized(cid, creator);
        manager.authorizeCreator(c, csig);
        assertTrue(manager.isCreatorAuthorized(cid, creator));
        assertFalse(manager.isCreatorAuthorized(cid, address(this)));
        vm.expectRevert(AlreadyListed.selector);
        manager.authorizeCreator(c, csig);
    }

    function test_AllowLists_Rejections() public {
        _create(2, 3);
        _join(1);
        (AllowAdapter memory a,) = _allowMsg(address(adapter));
        bytes memory bad = _sign(authSecrets[0], _hAllow(a));
        vm.expectRevert(BadSignature.selector);
        manager.allowAdapter(a, bad);
        (a,) = _allowMsg(address(0));
        bytes memory sig = _sign(orgKey, _hAllow(a));
        vm.expectRevert(ZeroAddress.selector);
        manager.allowAdapter(a, sig);
        (a,) = _allowMsg(address(adapter));
        a.validUntil = uint64(block.timestamp) - 1;
        sig = _sign(orgKey, _hAllow(a));
        vm.expectRevert(Expired.selector);
        manager.allowAdapter(a, sig);

        (AuthorizeCreator memory c,) = _authorizeMsg(creator);
        bad = _sign(authSecrets[0], _hAuthorize(c));
        vm.expectRevert(BadSignature.selector);
        manager.authorizeCreator(c, bad);
        (c,) = _authorizeMsg(address(0));
        sig = _sign(orgKey, _hAuthorize(c));
        vm.expectRevert(ZeroAddress.selector);
        manager.authorizeCreator(c, sig);
        (c,) = _authorizeMsg(creator);
        c.validUntil = uint64(block.timestamp) - 1;
        sig = _sign(orgKey, _hAuthorize(c));
        vm.expectRevert(Expired.selector);
        manager.authorizeCreator(c, sig);
        // an allow-list action for one ceremony does not apply to another
        (c, sig) = _authorizeMsg(creator);
        bytes12 first = cid;
        _create(2, 3);
        c.ceremonyId = cid;
        vm.expectRevert(BadSignature.selector);
        manager.authorizeCreator(c, sig);
        assertFalse(manager.isCreatorAuthorized(first, creator));
    }

    // ─── bindProcess ──────────────────────────────────────────────────────────────────────

    function test_Bind_Rejections() public {
        _create(2, 3);
        _join(1);
        _join(2);
        _allow(address(this));
        _authorize(creator);
        bytes31 p = bytes31(uint248(1));
        vm.expectRevert(WrongPhase.selector); // not Live yet
        manager.bindProcess(cid, p, creator);
        _close();
        _deal(1);
        _deal(2);
        vm.expectRevert(WrongPhase.selector);
        manager.bindProcess(cid, p, creator);
        manager.finalize(cid);

        vm.prank(address(0xBEEF));
        vm.expectRevert(NotAllowedAdapter.selector);
        manager.bindProcess(cid, p, creator);
        vm.expectRevert(NotAuthorizedCreator.selector);
        manager.bindProcess(cid, p, address(0xBEEF));
        vm.expectRevert(NotAuthorizedCreator.selector);
        manager.bindProcess(cid, p, address(0));

        (bytes32 rid, uint256 px, uint256 py) = manager.bindProcess(cid, p, creator);
        (uint256 wx, uint256 wy) = manager.getPublicKey(cid);
        assertEq(px, wx);
        assertEq(py, wy);
        vm.expectRevert(AlreadyBound.selector);
        manager.bindProcess(cid, p, creator);

        // same process id through another adapter is a different binding
        _allow(address(0xADA2));
        vm.prank(address(0xADA2));
        (bytes32 rid2,,) = manager.bindProcess(cid, p, creator);
        assertTrue(rid2 != rid);

        // an adapter allowed for this ceremony is not allowed for another one
        bytes12 first = cid;
        _toLive(2, 2);
        _authorize(creator);
        vm.expectRevert(NotAllowedAdapter.selector);
        manager.bindProcess(cid, bytes31(uint248(2)), creator);
        // and a binding is keyed by (adapter, processId) across ceremonies
        _allow(address(this));
        vm.expectRevert(AlreadyBound.selector);
        manager.bindProcess(cid, p, creator);
        (bytes12 bcid,,) = manager.getBinding(address(this), p);
        assertEq(bcid, first);
    }

    function test_BoundNotRequestedViews() public {
        _toLive(3, 2);
        _allow(address(this));
        _authorize(creator);
        bytes31 p = bytes31(uint248(9));
        (bytes32 rid,,) = manager.bindProcess(cid, p, creator);
        (bytes12 bcid, bytes32 brid, bool requested) = manager.getBinding(address(this), p);
        assertEq(bcid, cid);
        assertEq(brid, rid);
        assertFalse(requested);
        (bytes12 rcid, uint8 fieldCount,,) = manager.getRequestMeta(rid);
        assertEq(rcid, cid);
        assertEq(fieldCount, 0);
        assertEq(manager.getRequestCompressed(rid).length, 0);
        (bool ready, uint256[] memory values) = manager.getPlaintexts(rid);
        assertFalse(ready);
        assertEq(values.length, 0);
        vm.expectRevert(UnknownBinding.selector);
        manager.getBinding(address(this), bytes31(uint248(10)));
        vm.expectRevert(UnknownRequest.selector);
        manager.getRequestMeta(bytes32(uint256(1)));
        vm.expectRevert(UnknownRequest.selector);
        manager.getRequestCompressed(bytes32(uint256(1)));
        vm.expectRevert(UnknownRequest.selector);
        manager.getPlaintexts(bytes32(uint256(1)));

        // no partial or combine before the request exists
        requestId = rid;
        _encrypt(_u64s(1, 2, 3));
        PartialCall memory pc = _partialMsg(1);
        vm.expectRevert(UnknownRequest.selector);
        _sendPartial(pc);
        uint8[] memory set = _range(1, 2);
        vm.expectRevert(UnknownRequest.selector);
        manager.combine(rid, set, _range(0, 1), new uint64[](1), _vectors(set), new uint256[2][](1));
        vm.expectRevert(UnknownRequest.selector);
        manager.publishPartialData(rid, 1, pc.D);
    }

    /// @dev A dashboard reads a small page in O(limit) however long the binding history is.
    function test_RequestIdsPagination_LargeHistory() public {
        _toLive(2, 2);
        assertEq(manager.getRequestCount(cid), 0);
        assertEq(manager.getRequestIdsPage(cid, 0, 10).length, 0);
        _allow(address(this));
        _authorize(creator);
        uint256 total = 300;
        bytes32[] memory ids = new bytes32[](total);
        for (uint256 i; i < total; ++i) {
            (ids[i],,) = manager.bindProcess(cid, bytes31(uint248(i + 1)), creator);
        }
        assertEq(manager.getRequestCount(cid), total);

        uint256 g = gasleft();
        bytes32[] memory page = manager.getRequestIdsPage(cid, total - 3, 5);
        uint256 pageGas = g - gasleft();
        assertEq(page.length, 3, "truncated at the end");
        for (uint256 i; i < 3; ++i) {
            assertEq(page[i], ids[total - 3 + i]);
        }
        g = gasleft();
        bytes32[] memory all = manager.getRequestIdsPage(cid, 0, type(uint256).max);
        uint256 allGas = g - gasleft();
        assertEq(all.length, total);
        for (uint256 i; i < total; ++i) {
            assertEq(all[i], ids[i]);
        }
        assertLt(pageGas * 10, allGas, "page cost independent of the history length");
        assertLt(pageGas, 40_000);

        page = manager.getRequestIdsPage(cid, 100, 5);
        assertEq(page.length, 5);
        for (uint256 i; i < 5; ++i) {
            assertEq(page[i], ids[100 + i]);
        }
        assertEq(manager.getRequestIdsPage(cid, total, 5).length, 0);
        assertEq(manager.getRequestIdsPage(cid, type(uint256).max, 5).length, 0);
        assertEq(manager.getRequestIdsPage(cid, 0, 0).length, 0);
        assertEq(manager.getRequestIdsPage(cid, 0, type(uint256).max).length, total);

        vm.expectRevert(UnknownCeremony.selector);
        manager.getRequestCount(bytes12(uint96(1)));
        vm.expectRevert(UnknownCeremony.selector);
        manager.getRequestIdsPage(bytes12(uint96(1)), 0, 1);
    }

    // ─── submitRequest ────────────────────────────────────────────────────────────────────

    function _liveWithDirectAdapter() internal returns (bytes31 p) {
        _toLive(3, 2);
        _allow(address(this));
        _authorize(creator);
        p = bytes31(uint248(77));
        pid = p;
        (requestId,,) = manager.bindProcess(cid, p, creator);
        _encrypt(_u64s(5, 6, 7));
    }

    function _ctsCopy() internal view returns (uint256[4][] memory c) {
        c = new uint256[4][](cts.length);
        for (uint256 k; k < cts.length; ++k) {
            c[k] = cts[k];
        }
    }

    function test_Request_StoresAndEmits() public {
        bytes31 p = _liveWithDirectAdapter();
        vm.expectEmit(address(manager));
        emit ICouncilCore.RequestSubmitted(requestId, cid, 3);
        assertEq(manager.submitRequest(cid, p, _ctsCopy()), requestId);
        (bytes12 rcid, uint8 fieldCount, uint16 completed, uint16 partials) = manager.getRequestMeta(requestId);
        assertEq(rcid, cid);
        assertEq(fieldCount, 3);
        assertEq(completed, 0);
        assertEq(partials, 0);
        // stored compressed, never hash-only (protocol §9.2): C1 then C2 per field
        uint256[2][] memory stored = manager.getRequestCompressed(requestId);
        assertEq(stored.length, 3);
        for (uint256 k; k < 3; ++k) {
            assertEq(stored[k][0], _compress(cts[k][0], cts[k][1]));
            assertEq(stored[k][1], _compress(cts[k][2], cts[k][3]));
        }
        vm.expectRevert(AlreadyRequested.selector);
        manager.submitRequest(cid, p, _ctsCopy());
    }

    function test_Request_BindingChecks() public {
        bytes31 p = _liveWithDirectAdapter();
        uint256[4][] memory c = _ctsCopy();
        vm.expectRevert(UnknownBinding.selector);
        manager.submitRequest(cid, bytes31(uint248(78)), c);
        // another allowed adapter cannot submit for this binding
        _allow(address(0xADA2));
        vm.prank(address(0xADA2));
        vm.expectRevert(UnknownBinding.selector);
        manager.submitRequest(cid, p, c);
        // the supplied ceremony id is cross-checked against the binding record
        bytes12 bound = cid;
        bytes32 rid = requestId;
        _create(2, 3);
        vm.expectRevert(UnknownBinding.selector);
        manager.submitRequest(cid, p, c);
        cid = bound;
        assertEq(manager.submitRequest(bound, p, c), rid);
    }

    function test_Request_FieldCount() public {
        bytes31 p = _liveWithDirectAdapter();
        vm.expectRevert(BadFieldCount.selector);
        manager.submitRequest(cid, p, new uint256[4][](0));
        uint256[4][] memory c = new uint256[4][](17);
        (uint256 gx, uint256 gy) = Bjj.mulG(3);
        for (uint256 k; k < 17; ++k) {
            c[k] = [gx, gy, gx, gy];
        }
        vm.expectRevert(BadFieldCount.selector);
        manager.submitRequest(cid, p, c);
        uint256[4][] memory full = new uint256[4][](16);
        for (uint256 k; k < 16; ++k) {
            full[k] = c[k];
        }
        manager.submitRequest(cid, p, full);
    }

    function _expectRequestRevert(bytes31 p, uint256 field, uint256 word, uint256 x, uint256 y, bytes4 err) internal {
        uint256[4][] memory c = _ctsCopy();
        c[field][word] = x;
        c[field][word + 1] = y;
        vm.expectRevert(err);
        manager.submitRequest(cid, p, c);
    }

    function test_Request_PointValidation() public {
        bytes31 p = _liveWithDirectAdapter();
        (uint256 x, uint256 y) = (cts[1][0], cts[1][1]);
        for (uint256 word; word <= 2; word += 2) {
            _expectRequestRevert(p, 1, word, x + P, y, NonCanonical.selector);
            _expectRequestRevert(p, 1, word, x, y + P, NonCanonical.selector);
            _expectRequestRevert(p, 1, word, x, addmod(y, 1, P), InvalidPoint.selector);
            _expectRequestRevert(p, 1, word, 0, 1, InvalidPoint.selector);
            _expectRequestRevert(p, 1, word, 0, P - 1, NotInSubgroup.selector);
            _expectRequestRevert(p, 1, word, P - x, P - y, NotInSubgroup.selector);
        }
        manager.submitRequest(cid, p, _ctsCopy());
    }

    // ─── submitPartial ────────────────────────────────────────────────────────────────────

    function _requested() internal {
        _toLive(3, 2);
        _bindAndRequest(bytes31(uint248(5)), _u64s(10, 20, 30));
    }

    function _expectedPartialPub(PartialCall memory p, uint256 i) internal view returns (uint256[67] memory pub) {
        (pub[0], pub[1]) = Bjj.mulG(_share(i));
        uint256 f = cts.length;
        pub[2] = f;
        for (uint256 k; k < 16; ++k) {
            if (k < f) (pub[3 + 2 * k], pub[4 + 2 * k]) = (cts[k][0], cts[k][1]);
            else (pub[3 + 2 * k], pub[4 + 2 * k]) = (Bjj.GX, Bjj.GY);
            pub[35 + 2 * k] = p.D[k][0];
            pub[36 + 2 * k] = p.D[k][1];
        }
    }

    function test_Partial_PublicInputLayout() public {
        _requested();
        PartialCall memory p = _partialMsg(2);
        vm.expectCall(
            address(partialV),
            abi.encodeCall(IPartialVerifier.verifyProof, (_pA(), _pB(), _pC(), _expectedPartialPub(p, 2)))
        );
        bytes32 dataHash = _partialDataHash(requestId, 2, 3, p.D);
        vm.expectEmit(address(manager));
        emit ICouncilCore.PartialAccepted(requestId, 2);
        vm.expectEmit(address(manager));
        emit ICouncilCore.PartialDataPublished(requestId, 2, dataHash, p.D);
        vm.roll(4242);
        _sendPartial(p);
        // D is committed by hash and publication block, never stored (protocol §10.2)
        (bool accepted, bytes32 h, uint64 published) = manager.getPartialCommitment(requestId, 2);
        assertTrue(accepted);
        assertEq(h, dataHash);
        assertEq(published, 4242);
        (,,, uint16 partials) = manager.getRequestMeta(requestId);
        assertEq(partials, 2);
        (accepted, h, published) = manager.getPartialCommitment(requestId, 1);
        assertFalse(accepted);
        assertEq(h, bytes32(0));
        assertEq(published, 0);
        (accepted,,) = manager.getPartialCommitment(requestId, 0);
        assertFalse(accepted);
        (accepted,,) = manager.getPartialCommitment(requestId, 17);
        assertFalse(accepted);
    }

    function test_Partial_Rejections() public {
        _requested();
        PartialCall memory p = _partialMsg(1);
        p.a.validUntil = uint64(block.timestamp) - 1;
        p.sig = _sign(authSecrets[0], _hPartial(p.a));
        vm.expectRevert(Expired.selector);
        _sendPartial(p);

        p = _partialMsg(1);
        p.a.participantIndex = 0;
        p.sig = _sign(authSecrets[0], _hPartial(p.a));
        vm.expectRevert(NotQualified.selector);
        _sendPartial(p);
        p.a.participantIndex = 4;
        p.sig = _sign(authSecrets[0], _hPartial(p.a));
        vm.expectRevert(NotQualified.selector);
        _sendPartial(p);

        p = _partialMsg(1);
        p.sig = _sign(authSecrets[1], _hPartial(p.a));
        vm.expectRevert(BadSignature.selector);
        _sendPartial(p);

        p = _partialMsg(1);
        p.D[0][0] += P;
        _signPartial(p, 1);
        vm.expectRevert(NonCanonical.selector);
        _sendPartial(p);

        p = _partialMsg(1);
        p.D[3][1] = 2; // k = fieldCount must be the identity
        _signPartial(p, 1);
        vm.expectRevert(BadPadding.selector);
        _sendPartial(p);

        p = _partialMsg(1);
        p.D[15][0] = 1;
        _signPartial(p, 1);
        vm.expectRevert(BadPadding.selector);
        _sendPartial(p);

        p = _partialMsg(1);
        (p.D[1][0], p.D[1][1]) = Bjj.mulG(9);
        vm.expectRevert(PayloadMismatch.selector);
        _sendPartial(p);

        p = _partialMsg(1);
        uint256[2] memory otherC = [uint256(7), 9];
        vm.expectRevert(PayloadMismatch.selector);
        manager.submitPartial(p.a, p.sig, p.D, _pA(), _pB(), otherC, _c1());

        // the signed payload binds the request id
        p = _partialMsg(1);
        p.a.payloadHash = _partialPayloadHash(bytes32(uint256(requestId) ^ 1), p.D);
        p.sig = _sign(authSecrets[0], _hPartial(p.a));
        vm.expectRevert(PayloadMismatch.selector);
        _sendPartial(p);

        p = _partialMsg(1);
        partialV.setAccept(false);
        vm.expectRevert(ProofInvalid.selector);
        _sendPartial(p);
        (,,, uint16 partials) = manager.getRequestMeta(requestId);
        assertEq(partials, 0);
        partialV.setAccept(true);
        _sendPartial(p);
        vm.expectRevert(AlreadyPartial.selector);
        _sendPartial(p);
    }

    function test_Partial_ProofWordsMustBeBelowQBN() public {
        _requested();
        PartialCall memory p = _partialMsg(1);
        for (uint256 w; w < 8; ++w) {
            (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c) = _proofWith(w, Q_BN);
            p.a.payloadHash = keccak256(abi.encode(TAG_PARTIAL_PAYLOAD, requestId, p.D, a, b, c));
            p.sig = _sign(authSecrets[0], _hPartial(p.a));
            vm.expectRevert(NonCanonical.selector);
            manager.submitPartial(p.a, p.sig, p.D, a, b, c, _c1());
        }
        // words in [p, qBN) are legitimate proof coordinates
        (uint256[2] memory a2, uint256[2][2] memory b2, uint256[2] memory c2) = _proofWith(7, Q_BN - 1);
        a2[0] = P;
        p.a.payloadHash = keccak256(abi.encode(TAG_PARTIAL_PAYLOAD, requestId, p.D, a2, b2, c2));
        p.sig = _sign(authSecrets[0], _hPartial(p.a));
        manager.submitPartial(p.a, p.sig, p.D, a2, b2, c2, _c1());
    }

    /// @dev Mandatory regression: a partial signed and proven under an attacker-created ceremony
    ///      but carrying a victim's request id is rejected without consuming the victim's slot.
    function test_Partial_CrossCeremonyRequestIdRejected() public {
        // attacker's own ceremony, attacker is member 1 there
        orgKey = 0xA77AC;
        organizer = vm.addr(orgKey);
        _toLive(2, 1);
        bytes12 attackerCid = cid;
        uint256 attackerAuth = authSecrets[0];

        // victim ceremony with a live request
        orgKey = 0xA11CE;
        organizer = vm.addr(orgKey);
        _requested();
        PartialCall memory p = _partialMsg(1);
        p.a.ceremonyId = attackerCid;
        p.sig = _sign(attackerAuth, _hPartial(p.a));
        vm.expectRevert(UnknownRequest.selector);
        _sendPartial(p);
        (,,, uint16 partials) = manager.getRequestMeta(requestId);
        assertEq(partials, 0, "victim slot untouched");

        // signing with the victim ceremony id instead is not the attacker's to do
        p.a.ceremonyId = cid;
        p.sig = _sign(attackerAuth, _hPartial(p.a));
        vm.expectRevert(BadSignature.selector);
        _sendPartial(p);

        // the victim's member 1 still submits normally
        _partial(1);
        (,,, partials) = manager.getRequestMeta(requestId);
        assertEq(partials, 1);
    }

    // ─── combine ──────────────────────────────────────────────────────────────────────────

    function _combineReady() internal {
        _requested(); // n = 3, t = 2, fields [10, 20, 30]
        _partial(1);
        _partial(2);
        _partial(3);
    }

    function _set(uint8 a, uint8 b) internal pure returns (uint8[] memory s) {
        s = new uint8[](2);
        (s[0], s[1]) = (a, b);
    }

    function test_Combine_MemberSetValidation() public {
        _combineReady();
        uint8[] memory f = _range(0, 1);
        uint64[] memory m = _plain(f);
        vm.expectRevert(BadMemberSet.selector);
        _combineWith(_range(1, 1), f, m);
        vm.expectRevert(BadMemberSet.selector);
        _combineWith(_range(1, 3), f, m);
        vm.expectRevert(BadMemberSet.selector);
        _combineWith(_set(2, 2), f, m);
        vm.expectRevert(BadMemberSet.selector);
        _combineWith(_set(3, 1), f, m);
        vm.expectRevert(BadMemberSet.selector);
        _combineWith(_set(0, 1), f, m);
        vm.expectRevert(BadMemberSet.selector);
        _combineWith(_set(1, 4), f, m);
        _combineWith(_set(1, 3), f, m);
    }

    function test_Combine_MissingPartial() public {
        _requested();
        _partial(1);
        _partial(3);
        uint8[] memory f = _range(0, 3);
        uint64[] memory m = _plain(f);
        vm.expectRevert(MissingPartial.selector);
        _combineWith(_set(1, 2), f, m);
        _combineWith(_set(1, 3), f, m);
    }

    function test_Combine_FieldValidation() public {
        _combineReady();
        uint8[] memory s = _set(1, 2);
        vm.expectRevert(BadFieldIndexes.selector);
        _combineWith(s, new uint8[](0), new uint64[](0));
        uint8[] memory dup = new uint8[](2);
        vm.expectRevert(BadFieldIndexes.selector); // [0, 0]
        _combineWith(s, dup, _plain(dup));
        uint8[] memory desc = new uint8[](2);
        (desc[0], desc[1]) = (2, 1);
        vm.expectRevert(BadFieldIndexes.selector);
        _combineWith(s, desc, _plain(desc));
        uint8[] memory outOfRange = new uint8[](1);
        outOfRange[0] = 3;
        vm.expectRevert(BadFieldIndexes.selector);
        _combineWith(s, outOfRange, new uint64[](1));
        vm.expectRevert(BadFieldIndexes.selector);
        _combineWith(s, _range(0, 2), _plain(_range(0, 1)));
        uint64[] memory big = new uint64[](1);
        big[0] = uint64(1 << 40);
        vm.expectRevert(PlaintextTooLarge.selector);
        _combineWith(s, _range(0, 1), big);
    }

    function test_Combine_AtMostFourFields() public {
        _toLive(3, 2);
        uint64[] memory plain = new uint64[](5);
        for (uint256 k; k < 5; ++k) {
            plain[k] = uint64(k + 1);
        }
        _bindAndRequest(bytes31(uint248(6)), plain);
        _partial(1);
        _partial(2);
        vm.expectRevert(BadFieldIndexes.selector);
        _combine(_set(1, 2), _range(0, 5));
        _combine(_set(1, 2), _range(0, 4));
        _combine(_set(1, 2), _range(4, 1));
        (bool ready,) = manager.getPlaintexts(requestId);
        assertTrue(ready);
    }

    function test_Combine_ExactPerField() public {
        _combineReady();
        uint8[] memory s = _set(2, 3);
        uint8[] memory f = _range(0, 3);
        uint64[] memory m = _plain(f);
        m[1] += 1;
        vm.expectRevert(CombineCheckFailed.selector);
        _combineWith(s, f, m);
        m = _plain(f);
        (m[0], m[2]) = (m[2], m[0]);
        vm.expectRevert(CombineCheckFailed.selector);
        _combineWith(s, f, m);

        vm.prank(address(0xC0FFEE)); // permissionless
        vm.expectEmit(address(manager));
        emit ICouncilCore.FieldsCombined(requestId, f, _plain(f));
        _combineWith(s, f, _plain(f));
        vm.expectRevert(FieldCompleted.selector);
        _combineWith(_set(1, 2), _range(1, 1), _plain(_range(1, 1)));
    }

    function test_Combine_CompletedFieldsImmutable() public {
        _combineReady();
        _combine(_set(1, 2), _range(0, 1));
        vm.expectRevert(FieldCompleted.selector);
        _combine(_set(1, 3), _range(0, 2));
        _combine(_set(1, 3), _range(1, 2));
        (bool ready, uint256[] memory values) = manager.getPlaintexts(requestId);
        assertTrue(ready);
        assertEq(values[0], 10);
        assertEq(values[1], 20);
        assertEq(values[2], 30);
    }

    /// @dev With a lenient verifier a wrong D could be admitted; the exact combine check still
    ///      refuses every member set that contains it ("wrong λ·D" cannot steer the result).
    function test_Combine_WrongPartialNeverCombines() public {
        _requested();
        _partial(1);
        PartialCall memory p;
        uint256 wrong = addmod(_share(2), 1, R);
        for (uint256 k; k < 16; ++k) {
            if (k < cts.length) (p.D[k][0], p.D[k][1]) = Bjj.mul(wrong, cts[k][0], cts[k][1]);
            else p.D[k][1] = 1;
        }
        _signPartial(p, 2);
        _sendPartial(p);
        _partial(3);
        uint8[] memory f = _range(0, 3);
        vm.expectRevert(CombineCheckFailed.selector);
        _combineWith(_set(1, 2), f, _plain(f));
        vm.expectRevert(CombineCheckFailed.selector);
        _combineWith(_set(2, 3), f, _plain(f));
        _combineWith(_set(1, 3), f, _plain(f));
    }

    /// @dev Plaintexts live in uint40 lanes, six per slot (6 + 6 + 4): distinct values at the
    ///      bound across every lane boundary, combined sparsely, read back exactly.
    function test_Combine_Uint40LanesAcrossSlotBoundaries() public {
        _toLive(3, 2);
        uint64[] memory plain = new uint64[](16);
        for (uint256 k; k < 16; ++k) {
            plain[k] = uint64((1 << 40) - 1 - k);
        }
        _bindAndRequest(bytes31(uint248(16)), plain);
        _partial(1);
        _partial(3);
        uint8[] memory set = _set(1, 3);
        uint8[] memory sparse = new uint8[](4);
        (sparse[0], sparse[1], sparse[2], sparse[3]) = (5, 6, 11, 15);
        _combine(set, sparse);
        (,, uint16 completed,) = manager.getRequestMeta(requestId);
        assertEq(completed, (1 << 5) | (1 << 6) | (1 << 11) | (1 << 15));
        (bool ready, uint256[] memory values) = manager.getPlaintexts(requestId);
        assertFalse(ready);
        for (uint256 k; k < 16; ++k) {
            bool done = k == 5 || k == 6 || k == 11 || k == 15;
            assertEq(values[k], done ? plain[k] : 0, "lane");
        }
        // the 12 remaining fields, ascending, in chunks of four
        uint8[] memory chunk = new uint8[](4);
        uint256 got;
        for (uint256 k; k < 16; ++k) {
            if (k == 5 || k == 6 || k == 11 || k == 15) continue;
            chunk[got++] = uint8(k);
            if (got == 4) {
                _combine(set, chunk);
                got = 0;
            }
        }
        (ready, values) = manager.getPlaintexts(requestId);
        assertTrue(ready);
        for (uint256 k; k < 16; ++k) {
            assertEq(values[k], plain[k], "lane after completion");
        }
    }

    /// @dev The publication block is a uint64 lane: 2^64 - 1 is stored as is, 2^64 reverts
    ///      BlockNumberOverflow() (never truncated) and leaves the commitment untouched.
    function test_PublishedBlock_Uint64Boundary() public {
        _requested();
        vm.roll(type(uint64).max);
        _partial(1);
        (, bytes32 h, uint64 published) = manager.getPartialCommitment(requestId, 1);
        assertEq(published, type(uint64).max);
        vm.roll(uint256(type(uint64).max) + 1);
        uint256[2][16] memory D = dOf[requestId][1];
        vm.expectRevert(BlockNumberOverflow.selector);
        manager.publishPartialData(requestId, 1, D);
        PartialCall memory p = _partialMsg(2);
        vm.expectRevert(BlockNumberOverflow.selector);
        _sendPartial(p);
        (bool accepted, bytes32 h2, uint64 published2) = manager.getPartialCommitment(requestId, 1);
        assertTrue(accepted);
        assertEq(h2, h);
        assertEq(published2, type(uint64).max);
        (accepted,,) = manager.getPartialCommitment(requestId, 2);
        assertFalse(accepted, "no slot consumed");
    }

    // ─── adapter (architecture §3.1) ──────────────────────────────────────────────────────

    /// @dev Mandatory regression: plaintexts with first != 0 or count != fieldCount reverts.
    function test_Adapter_PlaintextsRange() public {
        _combineReady();
        vm.expectRevert(MockCouncilAdapter.BadRange.selector);
        adapter.plaintexts(cid, requestId, 1, 2);
        vm.expectRevert(MockCouncilAdapter.BadRange.selector);
        adapter.plaintexts(cid, requestId, 0, 2);
        vm.expectRevert(MockCouncilAdapter.BadRange.selector);
        adapter.plaintexts(cid, requestId, 0, 4);
        vm.expectRevert(MockCouncilAdapter.BadRange.selector);
        adapter.plaintexts(bytes12(uint96(1)), requestId, 0, 3);
        (bool ready, uint256[] memory values) = adapter.plaintexts(cid, requestId, 0, 3);
        assertFalse(ready);
        assertEq(values.length, 3);
        _combine(_set(1, 2), _range(0, 3));
        (ready, values) = adapter.plaintexts(cid, requestId, 0, 3);
        assertTrue(ready);
    }

    function test_Adapter_OnlyRegistry() public {
        _toLive(2, 2);
        _allow(address(adapter));
        _authorize(creator);
        vm.prank(address(0xBEEF));
        vm.expectRevert(MockCouncilAdapter.OnlyRegistry.selector);
        adapter.register(bytes31(uint248(1)), creator, cid);
        // the creator is passed through: an unauthorized one cannot bind via the adapter
        vm.expectRevert(NotAuthorizedCreator.selector);
        adapter.register(bytes31(uint248(1)), address(0xBEEF), cid);
    }
}
