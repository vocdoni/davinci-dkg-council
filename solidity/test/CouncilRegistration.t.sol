// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {ICouncilCore} from "../src/interfaces/ICouncil.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";
import {Bjj} from "./utils/Bjj.sol";

/// @notice createCeremony / addInvites / join / closeRegistration rejection paths (protocol
///         §§6, 7, 8.1–8.3).
contract CouncilRegistrationTest is CouncilTestBase {
    // ─── createCeremony ───────────────────────────────────────────────────────────────────

    function _signCreate(CreateCeremony memory a) internal view returns (bytes memory) {
        return _sign(orgKey, _hCreate(a));
    }

    function test_Create_StoresState() public {
        (CreateCeremony memory a, bytes memory sig) = _createMsg(3, 4, 77);
        bytes12 expected = manager.ceremonyIdFor(organizer, 77);
        vm.expectEmit(address(manager));
        emit ICouncilCore.CeremonyCreated(
            expected, organizer, 3, MANUAL, a.registrationDeadline, DEAL_DURATION, MANUAL, 0, 0
        );
        cid = manager.createCeremony(a, sig);
        assertEq(cid, expected);
        CeremonyView memory v = manager.getCeremony(cid);
        assertEq(v.phase, uint8(Phase.Registration));
        assertEq(v.threshold, 3);
        assertEq(v.n, 0);
        assertEq(v.inviteCount, 4);
        assertEq(v.registrationDeadline, a.registrationDeadline);
        assertEq(v.dealingDeadline, 0);
        assertEq(v.rosterHash, bytes32(0));
        for (uint8 i; i < 4; ++i) {
            (address key, bool consumed) = manager.getInvite(cid, i);
            assertEq(key, a.inviteKeys[i]);
            assertFalse(consumed);
        }
        vm.expectRevert(WrongPhase.selector);
        manager.getPublicKey(cid);
        PhasePolicyView memory pv = manager.getPolicy(cid);
        assertEq(pv.registrationMode, MANUAL);
        assertEq(pv.decryptionMode, MANUAL);
        assertEq(pv.dealingDuration, DEAL_DURATION);
        assertEq(pv.decryptionOpenAt, 0);
        assertEq(pv.manualDecryptionFallbackAt, 0);
        assertEq(pv.manualOpenedAt, 0);
        assertFalse(pv.decryptionOpen);
        assertFalse(pv.scheduledRegistrationCloseDue);
        assertFalse(manager.isDecryptionOpen(cid));
    }

    function test_Create_ReplayRejected() public {
        (CreateCeremony memory a, bytes memory sig) = _createMsg(2, 3, 1);
        manager.createCeremony(a, sig);
        vm.expectRevert(CeremonyExists.selector);
        manager.createCeremony(a, sig);
    }

    function test_Create_Expired() public {
        (CreateCeremony memory a,) = _createMsg(2, 3, 1);
        a.validUntil = uint64(block.timestamp) - 1;
        bytes memory sig = _signCreate(a);
        vm.expectRevert(Expired.selector);
        manager.createCeremony(a, sig);
    }

    function test_Create_ValidUntilIsInclusive() public {
        (CreateCeremony memory a,) = _createMsg(2, 3, 1);
        a.validUntil = uint64(block.timestamp);
        manager.createCeremony(a, _signCreate(a));
    }

    function test_Create_ZeroOrganizer() public {
        (CreateCeremony memory a, bytes memory sig) = _createMsg(2, 3, 1);
        a.organizer = address(0);
        vm.expectRevert(ZeroAddress.selector);
        manager.createCeremony(a, sig);
    }

    function test_Create_WrongSigner() public {
        (CreateCeremony memory a,) = _createMsg(2, 3, 1);
        bytes memory sig = _sign(0xBAD, _hCreate(a));
        vm.expectRevert(BadSignature.selector);
        manager.createCeremony(a, sig);
    }

    function test_Create_TamperedField() public {
        (CreateCeremony memory a, bytes memory sig) = _createMsg(2, 3, 1);
        a.threshold = 3;
        vm.expectRevert(BadSignature.selector);
        manager.createCeremony(a, sig);
    }

    function test_Create_BadThreshold() public {
        (CreateCeremony memory a,) = _createMsg(0, 3, 1);
        bytes memory sig = _signCreate(a);
        vm.expectRevert(BadThreshold.selector);
        manager.createCeremony(a, sig);
        a.threshold = 17;
        sig = _signCreate(a);
        vm.expectRevert(BadThreshold.selector);
        manager.createCeremony(a, sig);
        a.threshold = 16;
        manager.createCeremony(a, _signCreate(a));
    }

    function test_Create_RegistrationDeadlineInPast() public {
        (CreateCeremony memory a,) = _createMsg(2, 3, 1);
        a.registrationDeadline = uint64(block.timestamp);
        bytes memory sig = _signCreate(a);
        vm.expectRevert(BadSchedule.selector);
        manager.createCeremony(a, sig);
        // a Manual registration may also have no expiry at all
        a.registrationDeadline = 0;
        manager.createCeremony(a, _signCreate(a));
    }

    function test_Create_DealingDuration() public {
        (CreateCeremony memory a,) = _createMsg(2, 3, 1);
        a.dealingDuration = 599;
        bytes memory sig = _signCreate(a);
        vm.expectRevert(BadDuration.selector);
        manager.createCeremony(a, sig);
        // above the 365-day bound, whatever the schedule
        a.dealingDuration = 365 days + 1;
        sig = _signCreate(a);
        vm.expectRevert(BadDuration.selector);
        manager.createCeremony(a, sig);
        // a dealing deadline that would not fit in uint64
        a.dealingDuration = 600;
        a.registrationDeadline = type(uint64).max - 600 + 1;
        sig = _signCreate(a);
        vm.expectRevert(BadSchedule.selector);
        manager.createCeremony(a, sig);
        a.registrationDeadline = type(uint64).max - 600;
        sig = _signCreate(a);
        uint256 snap = vm.snapshotState();
        manager.createCeremony(a, sig);
        vm.revertToState(snap);
        a.dealingDuration = 365 days;
        a.registrationDeadline = uint64(vm.getBlockTimestamp()) + REG_PERIOD;
        manager.createCeremony(a, _signCreate(a));
    }

    function test_Create_InviteListBounds() public {
        (CreateCeremony memory a,) = _createMsg(2, 0, 1);
        bytes memory sig = _signCreate(a);
        vm.expectRevert(NoInvites.selector);
        manager.createCeremony(a, sig);

        (a,) = _createMsg(2, 65, 2);
        sig = _signCreate(a);
        vm.expectRevert(TooManyInvites.selector);
        manager.createCeremony(a, sig);

        (a, sig) = _createMsg(2, 64, 3);
        cid = manager.createCeremony(a, sig);
        assertEq(manager.getCeremony(cid).inviteCount, 64);
    }

    function test_Create_ZeroOrDuplicateInvite() public {
        (CreateCeremony memory a,) = _createMsg(2, 3, 1);
        a.inviteKeys[1] = address(0);
        bytes memory sig = _signCreate(a);
        vm.expectRevert(ZeroAddress.selector);
        manager.createCeremony(a, sig);

        (a,) = _createMsg(2, 3, 1);
        a.inviteKeys[2] = a.inviteKeys[0];
        sig = _signCreate(a);
        vm.expectRevert(DuplicateInvite.selector);
        manager.createCeremony(a, sig);
    }

    // ─── addInvites ───────────────────────────────────────────────────────────────────────

    function _addMsg(uint32 first, uint256 count, uint256 salt)
        internal
        returns (AddInvites memory a, bytes memory sig)
    {
        address[] memory keys = new address[](count);
        for (uint256 i; i < count; ++i) {
            uint256 s = _secp(abi.encode("more", salt, i));
            inviteSecrets.push(s);
            keys[i] = vm.addr(s);
        }
        a = AddInvites({ceremonyId: cid, firstInviteId: first, inviteKeys: keys, validUntil: validUntil});
        sig = _sign(orgKey, _hAddInvites(a));
    }

    function test_AddInvites_AppendsWithIds() public {
        _create(2, 3);
        (AddInvites memory a, bytes memory sig) = _addMsg(3, 2, 1);
        vm.expectEmit(address(manager));
        emit ICouncilCore.InvitesAdded(cid, 3, 2);
        manager.addInvites(a, sig);
        assertEq(manager.getCeremony(cid).inviteCount, 5);
        (address key,) = manager.getInvite(cid, 4);
        assertEq(key, a.inviteKeys[1]);
        // an added invite redeems like an initial one
        _join(1);
        _sendJoin(_joinMsg(2, 4, _memberAuth(2), _memberShareKey(2)));
    }

    /// @dev Mandatory regression: replayed or out-of-order AddInvites batches fail the
    ///      firstInviteId check.
    function test_AddInvites_ReplayAndReorderRejected() public {
        _create(2, 3);
        (AddInvites memory first, bytes memory s1) = _addMsg(3, 2, 1);
        (AddInvites memory second, bytes memory s2) = _addMsg(5, 1, 2);
        vm.expectRevert(BadInviteIndex.selector);
        manager.addInvites(second, s2); // out of order
        manager.addInvites(first, s1);
        vm.expectRevert(BadInviteIndex.selector);
        manager.addInvites(first, s1); // replay
        manager.addInvites(second, s2);
        vm.expectRevert(BadInviteIndex.selector);
        manager.addInvites(second, s2);
        assertEq(manager.getCeremony(cid).inviteCount, 6);
    }

    function test_AddInvites_DuplicateAcrossUnion() public {
        _create(2, 3);
        (AddInvites memory a,) = _addMsg(3, 2, 1);
        a.inviteKeys[1] = vm.addr(inviteSecrets[0]);
        bytes memory sig = _sign(orgKey, _hAddInvites(a));
        vm.expectRevert(DuplicateInvite.selector);
        manager.addInvites(a, sig);

        a.inviteKeys[1] = a.inviteKeys[0];
        sig = _sign(orgKey, _hAddInvites(a));
        vm.expectRevert(DuplicateInvite.selector);
        manager.addInvites(a, sig);

        a.inviteKeys[1] = address(0);
        sig = _sign(orgKey, _hAddInvites(a));
        vm.expectRevert(ZeroAddress.selector);
        manager.addInvites(a, sig);
    }

    function test_AddInvites_Bounds() public {
        _create(2, 60);
        (AddInvites memory a, bytes memory sig) = _addMsg(60, 5, 1);
        vm.expectRevert(TooManyInvites.selector);
        manager.addInvites(a, sig);
        (a, sig) = _addMsg(60, 0, 2);
        vm.expectRevert(NoInvites.selector);
        manager.addInvites(a, sig);
        (a, sig) = _addMsg(60, 4, 3);
        manager.addInvites(a, sig);
        assertEq(manager.getCeremony(cid).inviteCount, 64);
    }

    function test_AddInvites_AuthAndPhase() public {
        _create(2, 3);
        (AddInvites memory a,) = _addMsg(3, 1, 1);
        bytes memory bad = _sign(0xBAD, _hAddInvites(a));
        vm.expectRevert(BadSignature.selector);
        manager.addInvites(a, bad);

        a.validUntil = uint64(block.timestamp) - 1;
        bytes memory sig = _sign(orgKey, _hAddInvites(a));
        vm.expectRevert(Expired.selector);
        manager.addInvites(a, sig);

        a.validUntil = validUntil;
        sig = _sign(orgKey, _hAddInvites(a));
        // an invite nobody could redeem is not registrable: same half-open cutoff as join
        vm.warp(T0 + REG_PERIOD);
        vm.expectRevert(RegistrationEnded.selector);
        manager.addInvites(a, sig);
        vm.warp(T0 + REG_PERIOD + 1);
        vm.expectRevert(RegistrationEnded.selector);
        manager.addInvites(a, sig);

        vm.warp(T0);
        _join(1);
        _join(2);
        _close();
        vm.expectRevert(WrongPhase.selector);
        manager.addInvites(a, sig);
    }

    // ─── join ─────────────────────────────────────────────────────────────────────────────

    function test_Join_StoresMember() public {
        _create(2, 3);
        JoinCall memory j = _joinMsg(1, 1, _memberAuth(1), _memberShareKey(1));
        vm.expectEmit(address(manager));
        emit ICouncilCore.ParticipantJoined(cid, 1, j.a.participant, 1);
        _sendJoin(j);
        (address auth, uint256 word, bool dealt) = manager.getParticipantCompressed(cid, 1);
        assertEq(auth, j.a.participant);
        assertEq(word, _compress(j.a.pkX, j.a.pkY), "stored compressed, never in full");
        assertFalse(dealt);
        vm.expectRevert(NotQualified.selector);
        manager.getParticipantCompressed(cid, 2);
        assertEq(manager.participantIndexOf(cid, auth), 1);
        CeremonyView memory v = manager.getCeremony(cid);
        assertEq(v.joinedCount, 1);
        assertEq(v.consumedInvites, 2);
    }

    function test_Join_ReplayAndConsumedInvite() public {
        _create(2, 3);
        JoinCall memory j = _joinMsg(1, 0, _memberAuth(1), _memberShareKey(1));
        _sendJoin(j);
        vm.expectRevert(InviteConsumed.selector);
        _sendJoin(j);
        // a second person with the same (consumed) invite
        JoinCall memory k = _joinMsg(2, 0, _memberAuth(2), _memberShareKey(2));
        vm.expectRevert(InviteConsumed.selector);
        _sendJoin(k);
    }

    function test_Join_UnknownInvite() public {
        _create(2, 3);
        inviteSecrets.push(_secp("unregistered"));
        JoinCall memory j = _joinMsg(1, 3, _memberAuth(1), _memberShareKey(1));
        vm.expectRevert(UnknownInvite.selector);
        _sendJoin(j);
    }

    function test_Join_InviteSignedByWrongKey() public {
        _create(2, 3);
        JoinCall memory j = _joinMsg(1, 0, _memberAuth(1), _memberShareKey(1));
        j.isig = _sign(inviteSecrets[1], _hInvite(j.inv)); // capability of invite 1, used for invite 0
        vm.expectRevert(BadSignature.selector);
        _sendJoin(j);
    }

    function test_Join_ParticipantSignedByWrongKey() public {
        _create(2, 3);
        JoinCall memory j = _joinMsg(1, 0, _memberAuth(1), _memberShareKey(1));
        j.psig = _sign(_memberAuth(2), _hJoin(j.a));
        vm.expectRevert(BadSignature.selector);
        _sendJoin(j);
    }

    /// @dev A mempool observer cannot redirect a join: the invite signature binds participant
    ///      and key, and the structs must agree.
    function test_Join_StructCrossChecks() public {
        _create(2, 3);
        JoinCall memory j = _joinMsg(1, 0, _memberAuth(1), _memberShareKey(1));
        JoinCall memory other = _joinMsg(2, 0, _memberAuth(2), _memberShareKey(2));

        // attacker keeps the victim's invite signature but swaps in its own Join
        JoinCall memory swap = _joinMsg(1, 0, _memberAuth(1), _memberShareKey(1));
        swap.a = other.a;
        swap.psig = other.psig;
        vm.expectRevert(PayloadMismatch.selector);
        _sendJoin(swap);

        // invite struct re-pointed at the attacker: the capability signature no longer matches
        JoinCall memory redirect = _joinMsg(2, 0, _memberAuth(2), _memberShareKey(2));
        redirect.isig = j.isig;
        vm.expectRevert(BadSignature.selector);
        _sendJoin(redirect);

        JoinCall memory m = _joinMsg(1, 0, _memberAuth(1), _memberShareKey(1));
        m.inv.pkY = m.inv.pkY + 1;
        vm.expectRevert(PayloadMismatch.selector);
        _sendJoin(m);
        m = _joinMsg(1, 0, _memberAuth(1), _memberShareKey(1));
        m.inv.inviteId = 1;
        vm.expectRevert(PayloadMismatch.selector);
        _sendJoin(m);
        m = _joinMsg(1, 0, _memberAuth(1), _memberShareKey(1));
        m.inv.ceremonyId = bytes12(uint96(1));
        vm.expectRevert(PayloadMismatch.selector);
        _sendJoin(m);
        _sendJoin(j);
    }

    function test_Join_ZeroParticipant() public {
        _create(2, 3);
        JoinCall memory j = _joinMsg(1, 0, _memberAuth(1), _memberShareKey(1));
        j.a.participant = address(0);
        j.inv.participant = address(0);
        j.isig = _sign(inviteSecrets[0], _hInvite(j.inv));
        vm.expectRevert(ZeroAddress.selector);
        _sendJoin(j);
    }

    function test_Join_DuplicateParticipantAndKey() public {
        _create(2, 4);
        uint256 auth = _memberAuth(1);
        uint256 x = _memberShareKey(1);
        _sendJoin(_joinMsg(1, 0, auth, x));
        JoinCall memory sameAuth = _joinMsg(2, 1, auth, _memberShareKey(2));
        vm.expectRevert(DuplicateParticipant.selector);
        _sendJoin(sameAuth);
        JoinCall memory sameKey = _joinMsg(3, 2, _memberAuth(3), x);
        vm.expectRevert(DuplicateKey.selector);
        _sendJoin(sameKey);
    }

    /// @dev Re-sign a join whose key/PoP fields were edited.
    function _resign(JoinCall memory j, uint256 auth) internal view {
        j.inv.pkX = j.a.pkX;
        j.inv.pkY = j.a.pkY;
        j.psig = _sign(auth, _hJoin(j.a));
        j.isig = _sign(inviteSecrets[j.a.inviteId], _hInvite(j.inv));
    }

    function _expectJoinRevert(uint256 pkX, uint256 pkY, bytes4 err) internal {
        uint256 auth = _memberAuth(1);
        JoinCall memory j = _joinMsg(1, 0, auth, _memberShareKey(1));
        j.a.pkX = pkX;
        j.a.pkY = pkY;
        _resign(j, auth);
        vm.expectRevert(err);
        _sendJoin(j);
    }

    function test_Join_KeyValidation() public {
        _create(2, 3);
        (uint256 X0, uint256 X1) = Bjj.mulG(_memberShareKey(1));
        _expectJoinRevert(X0 + P, X1, NonCanonical.selector);
        _expectJoinRevert(X0, X1 + P, NonCanonical.selector);
        _expectJoinRevert(X0, X1 + 1, InvalidPoint.selector); // off curve
        _expectJoinRevert(0, 1, InvalidPoint.selector); // identity
        _expectJoinRevert(0, P - 1, NotInSubgroup.selector); // order-2 point
        assertTrue(Bjj.onCurveTE(P - X0, P - X1));
        _expectJoinRevert(P - X0, P - X1, NotInSubgroup.selector); // X + (0,-1): on curve, torsion component
    }

    function test_Join_PoPValidation() public {
        _create(2, 3);
        uint256 auth = _memberAuth(1);
        uint256 x = _memberShareKey(1);

        JoinCall memory j = _joinMsg(1, 0, auth, x);
        j.a.popZ = addmod(j.a.popZ, 1, R);
        _resign(j, auth);
        vm.expectRevert(BadPoP.selector);
        _sendJoin(j);

        j = _joinMsg(1, 0, auth, x);
        j.a.popZ += R; // same residue, non-canonical
        _resign(j, auth);
        vm.expectRevert(BadPoP.selector);
        _sendJoin(j);

        j = _joinMsg(1, 0, auth, x);
        j.a.popAy = addmod(j.a.popAy, 1, P);
        _resign(j, auth);
        vm.expectRevert(InvalidPoint.selector);
        _sendJoin(j);

        j = _joinMsg(1, 0, auth, x);
        j.a.popAx += P;
        _resign(j, auth);
        vm.expectRevert(NonCanonical.selector);
        _sendJoin(j);

        // a PoP made for another participant address does not transfer: c binds it
        JoinCall memory theirs = _joinMsg(1, 0, _memberAuth(2), x);
        j = _joinMsg(1, 0, auth, x);
        (j.a.popAx, j.a.popAy, j.a.popZ) = (theirs.a.popAx, theirs.a.popAy, theirs.a.popZ);
        _resign(j, auth);
        vm.expectRevert(BadPoP.selector);
        _sendJoin(j);

        _sendJoin(_joinMsg(1, 0, auth, x));
    }

    function test_Join_Expiry() public {
        _create(2, 3);
        uint256 auth = _memberAuth(1);
        JoinCall memory j = _joinMsg(1, 0, auth, _memberShareKey(1));
        j.a.validUntil = uint64(block.timestamp) - 1;
        j.psig = _sign(auth, _hJoin(j.a));
        vm.expectRevert(Expired.selector);
        _sendJoin(j);

        j = _joinMsg(1, 0, auth, _memberShareKey(1));
        j.inv.validUntil = uint64(block.timestamp) - 1;
        j.isig = _sign(inviteSecrets[0], _hInvite(j.inv));
        vm.expectRevert(Expired.selector);
        _sendJoin(j);

        // the joining interval is half-open in v2: closed at the deadline itself
        j = _joinMsg(1, 0, auth, _memberShareKey(1));
        vm.warp(T0 + REG_PERIOD + 1);
        vm.expectRevert(RegistrationEnded.selector);
        _sendJoin(j);
        vm.warp(T0 + REG_PERIOD);
        vm.expectRevert(RegistrationEnded.selector);
        _sendJoin(j);
        vm.warp(T0 + REG_PERIOD - 1);
        _sendJoin(j);
    }

    /// @dev A Manual ceremony without expiry accepts joins at any time until the organizer closes.
    function test_Join_ManualWithoutExpiryNeverEnds() public {
        _usePolicy(MANUAL, 0, DEAL_DURATION, MANUAL, 0, 0);
        validUntil = T0 + 400 days;
        _create(1, 3);
        vm.warp(T0 + 365 days);
        _join(1);
        assertEq(manager.getCeremony(cid).registrationDeadline, 0);
        vm.expectRevert(AbortConditionNotMet.selector);
        manager.abort(cid);
        _close();
        assertEq(manager.getCeremony(cid).dealingDeadline, T0 + 365 days + DEAL_DURATION);
    }

    function test_Join_RosterFull() public {
        _create(2, 17);
        for (uint256 i = 1; i <= 16; ++i) {
            _join(i);
        }
        JoinCall memory j = _joinMsg(17, 16, _memberAuth(17), _memberShareKey(17));
        vm.expectRevert(RosterFull.selector);
        _sendJoin(j);
    }

    function test_Join_AfterClose() public {
        _create(1, 3);
        _join(1);
        _close();
        JoinCall memory j = _joinMsg(2, 1, _memberAuth(2), _memberShareKey(2));
        vm.expectRevert(WrongPhase.selector);
        _sendJoin(j);
    }

    // ─── closeRegistration ────────────────────────────────────────────────────────────────

    function test_Close_FreezesRoster() public {
        _create(2, 4);
        _join(1);
        _join(2);
        _join(3);
        (CloseRegistration memory a, bytes memory sig) = _closeMsg(3);
        vm.expectEmit(address(manager));
        emit ICouncilCore.RegistrationClosed(cid, 3, _expectedRosterHash(), uint64(block.timestamp) + DEAL_DURATION);
        manager.closeRegistration(a, sig, _roster());
        CeremonyView memory v = manager.getCeremony(cid);
        assertEq(v.phase, uint8(Phase.Dealing));
        assertEq(v.n, 3);
        assertEq(v.dealingDeadline, block.timestamp + DEAL_DURATION);
        assertEq(v.rosterHash, _expectedRosterHash());
        vm.expectRevert(WrongPhase.selector);
        manager.closeRegistration(a, sig, _roster());
    }

    /// @dev The organizer's count pins the roster it saw: a late join invalidates the signature's
    ///      participantCount.
    function test_Close_LateJoinRejected() public {
        _create(2, 4);
        _join(1);
        _join(2);
        (CloseRegistration memory a, bytes memory sig) = _closeMsg(2);
        uint256[2][] memory seen = _roster();
        _join(3);
        vm.expectRevert(RosterMismatch.selector);
        manager.closeRegistration(a, sig, seen);
        vm.expectRevert(RosterMismatch.selector);
        manager.closeRegistration(a, sig, _roster());
    }

    function test_Close_BelowThreshold() public {
        _create(3, 4);
        _join(1);
        _join(2);
        (CloseRegistration memory a, bytes memory sig) = _closeMsg(2);
        vm.expectRevert(BelowThreshold.selector);
        manager.closeRegistration(a, sig, _roster());
    }

    function test_Close_AuthAndDeadlines() public {
        _create(1, 2);
        _join(1);
        (CloseRegistration memory a,) = _closeMsg(1);
        bytes memory bad = _sign(_memberAuth(1), _hClose(a));
        vm.expectRevert(BadSignature.selector);
        manager.closeRegistration(a, bad, _roster());

        a.validUntil = uint64(block.timestamp) - 1;
        bytes memory sig = _sign(orgKey, _hClose(a));
        vm.expectRevert(Expired.selector);
        manager.closeRegistration(a, sig, _roster());

        // from the expiry on, the time-based close and abort own the transition (protocol §8.3)
        (a, sig) = _closeMsg(1);
        vm.warp(T0 + REG_PERIOD);
        vm.expectRevert(RegistrationEnded.selector);
        manager.closeRegistration(a, sig, _roster());
        vm.warp(T0 + REG_PERIOD - 1);
        manager.closeRegistration(a, sig, _roster());
    }

    /// @dev The organizer cannot cut a Scheduled registration short (invitees were promised
    ///      time until the published date).
    function test_Close_ScheduledModeRefusesTheOrganizer() public {
        _usePolicy(SCHEDULED, T0 + REG_PERIOD, DEAL_DURATION, MANUAL, 0, 0);
        _create(1, 3);
        _join(1);
        (CloseRegistration memory a, bytes memory sig) = _closeMsg(1);
        vm.expectRevert(WrongMode.selector);
        manager.closeRegistration(a, sig, _roster());
        vm.warp(T0 + REG_PERIOD);
        vm.expectRevert(WrongMode.selector);
        manager.closeRegistration(a, sig, _roster());
        _closeScheduled();
        assertEq(manager.getCeremony(cid).phase, uint8(Phase.Dealing));
    }

    function _expectedRosterHash() internal view returns (bytes32) {
        uint256 n = memberX.length;
        address[] memory auths = new address[](n);
        uint256[] memory xs = new uint256[](n);
        uint256[] memory ys = new uint256[](n);
        for (uint256 i; i < n; ++i) {
            auths[i] = vm.addr(authSecrets[i]);
            (xs[i], ys[i]) = (memberX[i][0], memberX[i][1]);
        }
        return keccak256(abi.encode(TAG_ROSTER, block.chainid, address(manager), cid, T, uint8(n), auths, xs, ys));
    }
}
