// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import "../../src/CouncilTypes.sol";
import {CouncilManager} from "../../src/CouncilManager.sol";
import {ICouncil} from "../../src/interfaces/ICouncil.sol";
import {MockDealVerifier, MockPartialVerifier} from "../mocks/MockVerifiers.sol";
import {MockCouncilAdapter} from "../mocks/MockCouncilAdapter.sol";
import {Bjj} from "./Bjj.sol";

/// @notice Shared fixture: deploys the manager on mock verifiers and drives one ceremony with
///         real BabyJubJub keys, Schnorr PoPs, Feldman commitments, ElGamal ciphertexts and
///         partial points. EIP-712 hashing here is written from the protocol §7.2 strings,
///         independently of CouncilEIP712.
abstract contract CouncilTestBase is Test {
    // ─── Protocol constants, written out independently of src/ ────────────────────────────

    bytes32 internal constant DOMAIN_T =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant CREATE_T = keccak256(
        "CreateCeremony(address organizer,uint64 nonce,uint8 threshold,uint64 registrationDeadline,uint64 dealingDuration,address[] inviteKeys,uint64 validUntil)"
    );
    bytes32 internal constant ADD_INVITES_T =
        keccak256("AddInvites(bytes12 ceremonyId,uint32 firstInviteId,address[] inviteKeys,uint64 validUntil)");
    bytes32 internal constant CLOSE_T =
        keccak256("CloseRegistration(bytes12 ceremonyId,uint8 participantCount,uint64 validUntil)");
    bytes32 internal constant ALLOW_T = keccak256("AllowAdapter(bytes12 ceremonyId,address adapter,uint64 validUntil)");
    bytes32 internal constant AUTHORIZE_T =
        keccak256("AuthorizeCreator(bytes12 ceremonyId,address creator,uint64 validUntil)");
    bytes32 internal constant INVITE_T = keccak256(
        "Invite(bytes12 ceremonyId,uint32 inviteId,address participant,uint256 pkX,uint256 pkY,uint64 validUntil)"
    );
    bytes32 internal constant JOIN_T = keccak256(
        "Join(bytes12 ceremonyId,address participant,uint32 inviteId,uint256 pkX,uint256 pkY,uint256 popAx,uint256 popAy,uint256 popZ,uint64 validUntil)"
    );
    bytes32 internal constant DEAL_T =
        keccak256("Deal(bytes12 ceremonyId,uint8 dealerIndex,bytes32 payloadHash,uint64 validUntil)");
    bytes32 internal constant PARTIAL_T = keccak256(
        "Partial(bytes12 ceremonyId,bytes32 requestId,uint8 participantIndex,bytes32 payloadHash,uint64 validUntil)"
    );

    bytes32 internal constant TAG_CEREMONY = keccak256("davinci-dkg-council/v1/ceremony");
    bytes32 internal constant TAG_ROSTER = keccak256("davinci-dkg-council/v1/roster");
    bytes32 internal constant TAG_DEAL_CONTEXT = keccak256("davinci-dkg-council/v1/deal-context");
    bytes32 internal constant TAG_DEAL_PAYLOAD = keccak256("davinci-dkg-council/v1/deal-payload");
    bytes32 internal constant TAG_JOIN_POP = keccak256("davinci-dkg-council/v1/join-pop");
    bytes32 internal constant TAG_REQUEST = keccak256("davinci-dkg-council/v1/request");
    bytes32 internal constant TAG_PARTIAL_PAYLOAD = keccak256("davinci-dkg-council/v1/partial-payload");

    uint256 internal constant SECP_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant LIMIT_R = 114913275077156194916793630162600694215226186830659824886409057759834789667722;
    uint256 internal constant P = Bjj.P;
    uint256 internal constant R = Bjj.R;
    /// @dev BN254 base field (Groth16 proof coordinates).
    uint256 internal constant Q_BN = 21888242871839275222246405745257275088696311157297823662689037894645226208583;

    bytes32 internal constant RELEASE_ID = keccak256("davinci-dkg-council/test/circuit-release");
    uint64 internal constant T0 = 1_800_000_000;
    uint64 internal constant REG_PERIOD = 1 days;
    uint64 internal constant DEAL_DURATION = 1 days;

    // ─── Deployment ───────────────────────────────────────────────────────────────────────

    ICouncil internal manager;
    MockDealVerifier internal dealV;
    MockPartialVerifier internal partialV;
    MockCouncilAdapter internal adapter;
    uint256 internal orgKey = 0xA11CE;
    address internal organizer;
    address internal creator = address(0xC0EA7012);
    uint64 internal validUntil;

    // ─── Current ceremony fixture ─────────────────────────────────────────────────────────

    bytes12 internal cid;
    uint8 internal T;
    uint64 internal nonceCounter;
    uint256[] internal inviteSecrets;
    uint256[] internal authSecrets; // member i at slot i-1
    uint256[] internal shareSecrets;
    mapping(uint256 => uint256[16]) internal coef; // dealer index => coefficients
    uint256 internal qualBits;
    bytes31 internal pid;
    bytes32 internal requestId;
    uint256[4][] internal cts;
    uint64[] internal msgs;

    struct JoinCall {
        Join a;
        bytes psig;
        Invite inv;
        bytes isig;
    }

    struct DealCall {
        Deal a;
        bytes sig;
        uint256[2][16] C;
        uint256[2] E;
        uint256[16] masked;
    }

    struct PartialCall {
        Partial a;
        bytes sig;
        uint256[2][16] D;
    }

    function setUp() public virtual {
        vm.warp(T0);
        organizer = vm.addr(orgKey);
        validUntil = T0 + 30 days;
        dealV = new MockDealVerifier();
        partialV = new MockPartialVerifier();
        manager = ICouncil(address(new CouncilManager(address(dealV), address(partialV), RELEASE_ID)));
        adapter = new MockCouncilAdapter(address(manager));
    }

    // ─── Proof placeholders (accepted by the mocks) ───────────────────────────────────────

    function _pA() internal pure returns (uint256[2] memory) {
        return [uint256(1), 2];
    }

    function _pB() internal pure returns (uint256[2][2] memory) {
        return [[uint256(3), 4], [uint256(5), 6]];
    }

    function _pC() internal pure returns (uint256[2] memory) {
        return [uint256(7), 8];
    }

    /// @dev Placeholder proof with word `w` (0..7 in pA, pB, pC order) set to `v`.
    function _proofWith(uint256 w, uint256 v)
        internal
        pure
        returns (uint256[2] memory a, uint256[2][2] memory b, uint256[2] memory c)
    {
        (a, b, c) = (_pA(), _pB(), _pC());
        if (w < 2) a[w] = v;
        else if (w < 6) b[(w - 2) / 2][(w - 2) % 2] = v;
        else c[w - 6] = v;
    }

    // ─── EIP-712 (independent of CouncilEIP712) ──────────────────────────────────────────

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_T, keccak256("DAVINCI DKG Council"), keccak256("1"), block.chainid, address(manager)));
    }

    function _digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    /// @dev 65-byte low-s signature r || s || v.
    function _sign(uint256 key, bytes32 structHash) internal view returns (bytes memory) {
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(key, _digest(structHash));
        if (uint256(s) > SECP_N / 2) {
            s = bytes32(SECP_N - uint256(s));
            v = v == 27 ? 28 : 27;
        }
        return abi.encodePacked(r, s, v);
    }

    function _hCreate(CreateCeremony memory a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CREATE_T,
                a.organizer,
                a.nonce,
                a.threshold,
                a.registrationDeadline,
                a.dealingDuration,
                keccak256(abi.encodePacked(a.inviteKeys)),
                a.validUntil
            )
        );
    }

    function _hAddInvites(AddInvites memory a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ADD_INVITES_T, a.ceremonyId, a.firstInviteId, keccak256(abi.encodePacked(a.inviteKeys)), a.validUntil
            )
        );
    }

    function _hClose(CloseRegistration memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(CLOSE_T, a.ceremonyId, a.participantCount, a.validUntil));
    }

    function _hAllow(AllowAdapter memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(ALLOW_T, a.ceremonyId, a.adapter, a.validUntil));
    }

    function _hAuthorize(AuthorizeCreator memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(AUTHORIZE_T, a.ceremonyId, a.creator, a.validUntil));
    }

    function _hInvite(Invite memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(INVITE_T, a.ceremonyId, a.inviteId, a.participant, a.pkX, a.pkY, a.validUntil));
    }

    function _hJoin(Join memory a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                JOIN_T, a.ceremonyId, a.participant, a.inviteId, a.pkX, a.pkY, a.popAx, a.popAy, a.popZ, a.validUntil
            )
        );
    }

    function _hDeal(Deal memory a) internal pure returns (bytes32) {
        return keccak256(abi.encode(DEAL_T, a.ceremonyId, a.dealerIndex, a.payloadHash, a.validUntil));
    }

    function _hPartial(Partial memory a) internal pure returns (bytes32) {
        return
            keccak256(abi.encode(PARTIAL_T, a.ceremonyId, a.requestId, a.participantIndex, a.payloadHash, a.validUntil));
    }

    /// @dev protocol §3.1 HashToScalar over a pre-encoded abi.encode(tagHash, fields..).
    function _hashToScalar(bytes memory prefix) internal pure returns (uint256) {
        for (uint32 counter; counter < 256; ++counter) {
            uint256 u = uint256(keccak256(bytes.concat(prefix, abi.encode(counter))));
            if (u < LIMIT_R) return u % R;
        }
        revert("exhausted");
    }

    // ─── Deterministic secrets ────────────────────────────────────────────────────────────

    function _secp(bytes memory seed) internal pure returns (uint256) {
        return uint256(keccak256(seed)) % (SECP_N - 1) + 1;
    }

    function _scalar(bytes memory seed) internal pure returns (uint256) {
        return uint256(keccak256(seed)) % (R - 1) + 1;
    }

    // ─── Lifecycle drivers ────────────────────────────────────────────────────────────────

    function _createMsg(uint8 t, uint256 invites, uint64 nonce)
        internal
        returns (CreateCeremony memory a, bytes memory sig)
    {
        delete inviteSecrets;
        address[] memory keys = new address[](invites);
        for (uint256 i; i < invites; ++i) {
            uint256 s = _secp(abi.encode("invite", nonce, i));
            inviteSecrets.push(s);
            keys[i] = vm.addr(s);
        }
        a = CreateCeremony({
            organizer: organizer,
            nonce: nonce,
            threshold: t,
            registrationDeadline: uint64(block.timestamp) + REG_PERIOD,
            dealingDuration: DEAL_DURATION,
            inviteKeys: keys,
            validUntil: validUntil
        });
        sig = _sign(orgKey, _hCreate(a));
    }

    function _create(uint8 t, uint256 invites) internal returns (bytes12) {
        (CreateCeremony memory a, bytes memory sig) = _createMsg(t, invites, ++nonceCounter);
        cid = manager.createCeremony(a, sig);
        T = t;
        delete authSecrets;
        delete shareSecrets;
        qualBits = 0;
        return cid;
    }

    function _memberAuth(uint256 i) internal view returns (uint256) {
        return _secp(abi.encode("auth", cid, i));
    }

    function _memberShareKey(uint256 i) internal view returns (uint256) {
        return _scalar(abi.encode("share-key", cid, i));
    }

    /// @dev Join + Invite actions for member `i` (1-based label) redeeming `inviteId`.
    function _joinMsg(uint256 i, uint32 inviteId, uint256 authSecret, uint256 x)
        internal
        view
        returns (JoinCall memory j)
    {
        j.a.ceremonyId = cid;
        j.a.participant = vm.addr(authSecret);
        j.a.inviteId = inviteId;
        j.a.validUntil = validUntil;
        (j.a.pkX, j.a.pkY) = Bjj.mulG(x);
        _fillPoP(j.a, x, _scalar(abi.encode("pop-nonce", cid, i, x)));
        j.inv = Invite(cid, inviteId, j.a.participant, j.a.pkX, j.a.pkY, validUntil);
        j.psig = _sign(authSecret, _hJoin(j.a));
        j.isig = _sign(inviteSecrets[inviteId], _hInvite(j.inv));
    }

    /// @dev Schnorr PoP (protocol §8.2): A = k·G, c = HashToScalar(join-pop, ..), z = k + c·x.
    function _fillPoP(Join memory a, uint256 x, uint256 k) internal view {
        (a.popAx, a.popAy) = Bjj.mulG(k);
        uint256 c = _hashToScalar(
            abi.encode(
                TAG_JOIN_POP,
                block.chainid,
                address(manager),
                a.ceremonyId,
                a.participant,
                a.pkX,
                a.pkY,
                a.popAx,
                a.popAy
            )
        );
        a.popZ = addmod(k, mulmod(c, x, R), R);
    }

    function _sendJoin(JoinCall memory j) internal {
        manager.join(j.a, j.psig, j.inv, j.isig);
    }

    /// @dev Member `i` joins with invite `i - 1`.
    function _join(uint256 i) internal {
        uint256 auth = _memberAuth(i);
        uint256 x = _memberShareKey(i);
        _sendJoin(_joinMsg(i, uint32(i - 1), auth, x));
        authSecrets.push(auth);
        shareSecrets.push(x);
    }

    function _closeMsg(uint8 count) internal view returns (CloseRegistration memory a, bytes memory sig) {
        a = CloseRegistration({ceremonyId: cid, participantCount: count, validUntil: validUntil});
        sig = _sign(orgKey, _hClose(a));
    }

    function _close() internal {
        (CloseRegistration memory a, bytes memory sig) = _closeMsg(uint8(authSecrets.length));
        manager.closeRegistration(a, sig);
    }

    function _ctx() internal view returns (bytes32) {
        return manager.getCeremony(cid).ctx;
    }

    function _dealPayloadHash(bytes32 ctx, DealCall memory d) internal pure returns (bytes32) {
        return keccak256(abi.encode(TAG_DEAL_PAYLOAD, ctx, d.C, d.E, d.masked, _pA(), _pB(), _pC()));
    }

    /// @dev Honest dealing of dealer `j` (commitments and ephemeral are real; the masked shares
    ///      are stand-ins because the mock verifier does not check the mask equations).
    function _dealMsg(uint256 j) internal returns (DealCall memory d) {
        uint256 t = T;
        uint256 n = authSecrets.length;
        uint256[16] memory a;
        for (uint256 k; k < t; ++k) {
            a[k] = uint256(keccak256(abi.encode("coef", cid, j, k))) % R;
        }
        coef[j] = a;
        for (uint256 k; k < 16; ++k) {
            if (k < t) (d.C[k][0], d.C[k][1]) = Bjj.mulG(a[k]);
            else d.C[k][1] = 1;
        }
        (d.E[0], d.E[1]) = Bjj.mulG(_scalar(abi.encode("ephemeral", cid, j)));
        for (uint256 i; i < n; ++i) {
            d.masked[i] = Bjj.evalPoly(a, t, i + 1);
        }
        _signDeal(d, j);
    }

    function _signDeal(DealCall memory d, uint256 j) internal view {
        d.a = Deal({
            ceremonyId: cid, dealerIndex: uint8(j), payloadHash: _dealPayloadHash(_ctx(), d), validUntil: validUntil
        });
        d.sig = _sign(authSecrets[j - 1], _hDeal(d.a));
    }

    function _sendDeal(DealCall memory d) internal {
        manager.deal(d.a, d.sig, d.C, d.E, d.masked, _pA(), _pB(), _pC());
    }

    function _deal(uint256 j) internal {
        _sendDeal(_dealMsg(j));
        qualBits |= 1 << (j - 1);
    }

    /// @dev create(t, n invites) -> n joins -> close -> every member deals -> finalize.
    function _toLive(uint8 n, uint8 t) internal {
        _create(t, n);
        for (uint256 i = 1; i <= n; ++i) {
            _join(i);
        }
        _close();
        for (uint256 j = 1; j <= n; ++j) {
            _deal(j);
        }
        manager.finalize(cid);
    }

    /// @dev Final share s_m = Σ_{j in QUAL} f_j(m) mod r.
    function _share(uint256 m) internal view returns (uint256 s) {
        for (uint256 j = 1; j <= 16; ++j) {
            if ((qualBits >> (j - 1)) & 1 == 0) continue;
            s = addmod(s, Bjj.evalPoly(coef[j], T, m), R);
        }
    }

    function _allowMsg(address ad) internal view returns (AllowAdapter memory a, bytes memory sig) {
        a = AllowAdapter({ceremonyId: cid, adapter: ad, validUntil: validUntil});
        sig = _sign(orgKey, _hAllow(a));
    }

    function _authorizeMsg(address cr) internal view returns (AuthorizeCreator memory a, bytes memory sig) {
        a = AuthorizeCreator({ceremonyId: cid, creator: cr, validUntil: validUntil});
        sig = _sign(orgKey, _hAuthorize(a));
    }

    function _allow(address ad) internal {
        (AllowAdapter memory a, bytes memory sig) = _allowMsg(ad);
        manager.allowAdapter(a, sig);
    }

    function _authorize(address cr) internal {
        (AuthorizeCreator memory a, bytes memory sig) = _authorizeMsg(cr);
        manager.authorizeCreator(a, sig);
    }

    /// @dev Fresh ElGamal encryptions of `plain` under the ceremony key into `cts`.
    function _encrypt(uint64[] memory plain) internal {
        delete cts;
        delete msgs;
        (uint256 px, uint256 py) = manager.getPublicKey(cid);
        for (uint256 k; k < plain.length; ++k) {
            uint256 rho = _scalar(abi.encode("rho", cid, pid, k));
            (uint256 c1x, uint256 c1y) = Bjj.mulG(rho);
            (uint256 mx, uint256 my) = Bjj.mulG(plain[k]);
            (uint256 rx, uint256 ry) = Bjj.mul(rho, px, py);
            (uint256 c2x, uint256 c2y) = Bjj.add(mx, my, rx, ry);
            cts.push([c1x, c1y, c2x, c2y]);
            msgs.push(plain[k]);
        }
    }

    /// @dev allow + authorize the mock adapter and creator, bind `p`, encrypt and submit.
    function _bindAndRequest(bytes31 p, uint64[] memory plain) internal {
        if (!manager.isAdapterAllowed(cid, address(adapter))) _allow(address(adapter));
        if (!manager.isCreatorAuthorized(cid, creator)) _authorize(creator);
        pid = p;
        (, requestId,,) = adapter.register(p, creator, cid);
        _encrypt(plain);
        adapter.submit(cid, requestId, cts);
    }

    function _partialPayloadHash(bytes32 rid, uint256[2][16] memory D) internal pure returns (bytes32) {
        return keccak256(abi.encode(TAG_PARTIAL_PAYLOAD, rid, D, _pA(), _pB(), _pC()));
    }

    /// @dev Honest partial of member `i`: D_k = s_i·C1_k, identity padding.
    function _partialMsg(uint256 i) internal view returns (PartialCall memory p) {
        uint256 s = _share(i);
        uint256 f = cts.length;
        for (uint256 k; k < 16; ++k) {
            if (k < f) (p.D[k][0], p.D[k][1]) = Bjj.mul(s, cts[k][0], cts[k][1]);
            else p.D[k][1] = 1;
        }
        _signPartial(p, i);
    }

    function _signPartial(PartialCall memory p, uint256 i) internal view {
        p.a = Partial({
            ceremonyId: cid,
            requestId: requestId,
            participantIndex: uint8(i),
            payloadHash: _partialPayloadHash(requestId, p.D),
            validUntil: validUntil
        });
        p.sig = _sign(authSecrets[i - 1], _hPartial(p.a));
    }

    function _sendPartial(PartialCall memory p) internal {
        manager.submitPartial(p.a, p.sig, p.D, _pA(), _pB(), _pC());
    }

    function _partial(uint256 i) internal {
        _sendPartial(_partialMsg(i));
    }

    function _range(uint256 from, uint256 count) internal pure returns (uint8[] memory out) {
        out = new uint8[](count);
        for (uint256 i; i < count; ++i) {
            out[i] = uint8(from + i);
        }
    }

    function _plain(uint8[] memory fields) internal view returns (uint64[] memory out) {
        out = new uint64[](fields.length);
        for (uint256 i; i < fields.length; ++i) {
            out[i] = msgs[fields[i]];
        }
    }

    function _combine(uint8[] memory set, uint8[] memory fields) internal {
        manager.combine(requestId, set, fields, _plain(fields));
    }

    function _u64s(uint64 a, uint64 b, uint64 c) internal pure returns (uint64[] memory out) {
        out = new uint64[](3);
        out[0] = a;
        out[1] = b;
        out[2] = c;
    }
}
