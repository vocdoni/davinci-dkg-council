// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {
    CreateCeremony,
    OpenDecryption,
    AddInvites,
    CloseRegistration,
    AllowAdapter,
    AuthorizeCreator,
    Invite,
    Join,
    Deal,
    Partial,
    BadSignature
} from "../CouncilTypes.sol";

/// @title CouncilEIP712
/// @notice EIP-712 domain, struct hashing and signature rules of protocol §7. The type strings
///         are the protocol's `encodeType` strings byte for byte. Domain version "2": no v1
///         signature validates on a v2 manager or vice versa (protocol §7.1).
library CouncilEIP712 {
    bytes32 internal constant DOMAIN_TYPEHASH =
        keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)");
    bytes32 internal constant NAME_HASH = keccak256("DAVINCI DKG Council");
    bytes32 internal constant VERSION_HASH = keccak256("2");

    bytes32 internal constant CREATE_CEREMONY_TYPEHASH = keccak256(
        "CreateCeremony(address organizer,uint64 nonce,uint8 threshold,uint8 registrationMode,uint64 registrationDeadline,uint64 dealingDuration,uint8 decryptionMode,uint64 decryptionOpenAt,uint64 manualDecryptionFallbackAt,address[] inviteKeys,uint64 validUntil)"
    );
    bytes32 internal constant OPEN_DECRYPTION_TYPEHASH =
        keccak256("OpenDecryption(bytes12 ceremonyId,uint64 validUntil)");
    bytes32 internal constant ADD_INVITES_TYPEHASH =
        keccak256("AddInvites(bytes12 ceremonyId,uint32 firstInviteId,address[] inviteKeys,uint64 validUntil)");
    bytes32 internal constant CLOSE_REGISTRATION_TYPEHASH =
        keccak256("CloseRegistration(bytes12 ceremonyId,uint8 participantCount,uint64 validUntil)");
    bytes32 internal constant ALLOW_ADAPTER_TYPEHASH =
        keccak256("AllowAdapter(bytes12 ceremonyId,address adapter,uint64 validUntil)");
    bytes32 internal constant AUTHORIZE_CREATOR_TYPEHASH =
        keccak256("AuthorizeCreator(bytes12 ceremonyId,address creator,uint64 validUntil)");
    bytes32 internal constant INVITE_TYPEHASH = keccak256(
        "Invite(bytes12 ceremonyId,uint32 inviteId,address participant,uint256 pkX,uint256 pkY,uint64 validUntil)"
    );
    bytes32 internal constant JOIN_TYPEHASH = keccak256(
        "Join(bytes12 ceremonyId,address participant,uint32 inviteId,uint256 pkX,uint256 pkY,uint256 popAx,uint256 popAy,uint256 popZ,uint64 validUntil)"
    );
    bytes32 internal constant DEAL_TYPEHASH =
        keccak256("Deal(bytes12 ceremonyId,uint8 dealerIndex,bytes32 payloadHash,uint64 validUntil)");
    bytes32 internal constant PARTIAL_TYPEHASH = keccak256(
        "Partial(bytes12 ceremonyId,bytes32 requestId,uint8 participantIndex,bytes32 payloadHash,uint64 validUntil)"
    );

    /// @dev secp256k1 group order and its half (low-s bound).
    uint256 internal constant SECP256K1_N = 0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 internal constant SECP256K1_HALF_N = 0x7FFFFFFFFFFFFFFFFFFFFFFFFFFFFFFF5D576E7357A4501DDFE92F46681B20A0;

    function domainSeparator() internal view returns (bytes32) {
        return keccak256(abi.encode(DOMAIN_TYPEHASH, NAME_HASH, VERSION_HASH, block.chainid, address(this)));
    }

    function digest(bytes32 structHash) internal view returns (bytes32) {
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator(), structHash));
    }

    /// @notice Recover the signer of `structHash` under the protocol §7.1 rules: 65 bytes
    ///         `r || s || v`, `v ∈ {27, 28}`, `1 <= r < n`, `1 <= s <= n/2`, non-zero `ecrecover`.
    function recover(bytes32 structHash, bytes calldata sig) internal view returns (address signer) {
        if (sig.length != 65) revert BadSignature();
        uint256 r = uint256(bytes32(sig[0:32]));
        uint256 s = uint256(bytes32(sig[32:64]));
        uint8 v = uint8(sig[64]);
        if (v != 27 && v != 28) revert BadSignature();
        if (r == 0 || r >= SECP256K1_N) revert BadSignature();
        if (s == 0 || s > SECP256K1_HALF_N) revert BadSignature();
        signer = ecrecover(digest(structHash), v, bytes32(r), bytes32(s));
        if (signer == address(0)) revert BadSignature();
    }

    /// @notice Require a valid signature by `expected`, which must itself be non-zero.
    function verify(bytes32 structHash, bytes calldata sig, address expected) internal view {
        if (expected == address(0) || recover(structHash, sig) != expected) revert BadSignature();
    }

    function hashCreateCeremony(CreateCeremony calldata a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                CREATE_CEREMONY_TYPEHASH,
                a.organizer,
                a.nonce,
                a.threshold,
                a.registrationMode,
                a.registrationDeadline,
                a.dealingDuration,
                a.decryptionMode,
                a.decryptionOpenAt,
                a.manualDecryptionFallbackAt,
                keccak256(abi.encodePacked(a.inviteKeys)),
                a.validUntil
            )
        );
    }

    function hashOpenDecryption(OpenDecryption calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(OPEN_DECRYPTION_TYPEHASH, a.ceremonyId, a.validUntil));
    }

    function hashAddInvites(AddInvites calldata a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                ADD_INVITES_TYPEHASH,
                a.ceremonyId,
                a.firstInviteId,
                keccak256(abi.encodePacked(a.inviteKeys)),
                a.validUntil
            )
        );
    }

    function hashCloseRegistration(CloseRegistration calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(CLOSE_REGISTRATION_TYPEHASH, a.ceremonyId, a.participantCount, a.validUntil));
    }

    function hashAllowAdapter(AllowAdapter calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(ALLOW_ADAPTER_TYPEHASH, a.ceremonyId, a.adapter, a.validUntil));
    }

    function hashAuthorizeCreator(AuthorizeCreator calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(AUTHORIZE_CREATOR_TYPEHASH, a.ceremonyId, a.creator, a.validUntil));
    }

    function hashInvite(Invite calldata a) internal pure returns (bytes32) {
        return
            keccak256(abi.encode(INVITE_TYPEHASH, a.ceremonyId, a.inviteId, a.participant, a.pkX, a.pkY, a.validUntil));
    }

    function hashJoin(Join calldata a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(
                JOIN_TYPEHASH,
                a.ceremonyId,
                a.participant,
                a.inviteId,
                a.pkX,
                a.pkY,
                a.popAx,
                a.popAy,
                a.popZ,
                a.validUntil
            )
        );
    }

    function hashDeal(Deal calldata a) internal pure returns (bytes32) {
        return keccak256(abi.encode(DEAL_TYPEHASH, a.ceremonyId, a.dealerIndex, a.payloadHash, a.validUntil));
    }

    function hashPartial(Partial calldata a) internal pure returns (bytes32) {
        return keccak256(
            abi.encode(PARTIAL_TYPEHASH, a.ceremonyId, a.requestId, a.participantIndex, a.payloadHash, a.validUntil)
        );
    }
}
