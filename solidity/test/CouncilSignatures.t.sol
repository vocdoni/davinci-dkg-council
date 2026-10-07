// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {CouncilManager} from "../src/CouncilManager.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";
import {EIP712Harness} from "./utils/Harnesses.sol";

/// @notice protocol §7.1 signature rules: 65 bytes, v ∈ {27, 28}, 1 <= r < n, 1 <= s <= n/2,
///         non-zero ecrecover, non-zero expected signer; domain separation across chains and
///         managers.
contract CouncilSignaturesTest is CouncilTestBase {
    EIP712Harness internal h;
    uint256 internal constant KEY = 0xB0B;
    bytes32 internal constant SH = keccak256("some struct hash");

    function setUp() public override {
        super.setUp();
        h = new EIP712Harness();
    }

    function _raw(uint256 key) internal view returns (uint8 v, bytes32 r, bytes32 s) {
        (v, r, s) = vm.sign(key, h.digest(SH));
        if (uint256(s) > SECP_N / 2) {
            s = bytes32(SECP_N - uint256(s));
            v = v == 27 ? 28 : 27;
        }
    }

    function _expectBad(bytes memory sig, address expected) internal {
        vm.expectRevert(BadSignature.selector);
        h.verify(SH, sig, expected);
    }

    function test_Sig_ValidLowS() public view {
        (uint8 v, bytes32 r, bytes32 s) = _raw(KEY);
        bytes memory sig = abi.encodePacked(r, s, v);
        assertEq(h.recover(SH, sig), vm.addr(KEY));
        h.verify(SH, sig, vm.addr(KEY));
    }

    function test_Sig_Length() public {
        (uint8 v, bytes32 r, bytes32 s) = _raw(KEY);
        _expectBad(abi.encodePacked(r, s), vm.addr(KEY));
        _expectBad(abi.encodePacked(r, s, v, uint8(0)), vm.addr(KEY));
        _expectBad(abi.encode(r, s, v), vm.addr(KEY)); // 96 bytes
        _expectBad("", vm.addr(KEY));
    }

    function test_Sig_V() public {
        (uint8 v, bytes32 r, bytes32 s) = _raw(KEY);
        _expectBad(abi.encodePacked(r, s, v - 27), vm.addr(KEY)); // 0/1 form
        _expectBad(abi.encodePacked(r, s, uint8(26)), vm.addr(KEY));
        _expectBad(abi.encodePacked(r, s, uint8(29)), vm.addr(KEY));
    }

    function test_Sig_RRange() public {
        (uint8 v,, bytes32 s) = _raw(KEY);
        _expectBad(abi.encodePacked(bytes32(0), s, v), vm.addr(KEY));
        _expectBad(abi.encodePacked(bytes32(SECP_N), s, v), vm.addr(KEY));
        _expectBad(abi.encodePacked(bytes32(type(uint256).max), s, v), vm.addr(KEY));
    }

    /// @dev The high-s twin recovers the same address through raw ecrecover; the contract
    ///      rejects it anyway (malleability).
    function test_Sig_HighSRejected() public {
        (uint8 v, bytes32 r, bytes32 s) = _raw(KEY);
        bytes32 highS = bytes32(SECP_N - uint256(s));
        uint8 highV = v == 27 ? 28 : 27;
        assertEq(ecrecover(h.digest(SH), highV, r, highS), vm.addr(KEY), "twin is a valid ECDSA signature");
        _expectBad(abi.encodePacked(r, highS, highV), vm.addr(KEY));
        _expectBad(abi.encodePacked(r, bytes32(0), v), vm.addr(KEY));
        _expectBad(abi.encodePacked(r, bytes32(SECP_N / 2 + 1), v), vm.addr(KEY));
    }

    /// @dev Mandatory regression: a signature whose ecrecover yields the zero address never
    ///      matches any expected signer, including a zero one.
    function test_Sig_ZeroRecoveryNeverMatches() public {
        bytes32 digest = h.digest(SH);
        uint256 r = 1;
        while (ecrecover(digest, 27, bytes32(r), bytes32(uint256(1))) != address(0)) {
            ++r;
        }
        bytes memory sig = abi.encodePacked(bytes32(r), bytes32(uint256(1)), uint8(27));
        vm.expectRevert(BadSignature.selector);
        h.recover(SH, sig);
        _expectBad(sig, address(0));
        _expectBad(sig, vm.addr(KEY));
        // and a valid signature never matches a zero expected signer
        (uint8 v, bytes32 rr, bytes32 s) = _raw(KEY);
        _expectBad(abi.encodePacked(rr, s, v), address(0));
    }

    function test_Sig_ManagerRejectsHighS() public {
        (CreateCeremony memory a,) = _createMsg(2, 3, 1);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(orgKey, _digest(_hCreate(a)));
        if (uint256(s) <= SECP_N / 2) {
            s = bytes32(SECP_N - uint256(s));
            v = v == 27 ? 28 : 27;
        }
        vm.expectRevert(BadSignature.selector);
        manager.createCeremony(a, abi.encodePacked(r, s, v));
    }

    function test_Sig_CrossChainReplay() public {
        (CreateCeremony memory a, bytes memory sig) = _createMsg(2, 3, 1);
        uint256 snap = vm.snapshotState();
        vm.chainId(100);
        vm.expectRevert(BadSignature.selector);
        manager.createCeremony(a, sig);
        vm.revertToState(snap);
        manager.createCeremony(a, sig);
    }

    /// @dev A v1 signature (domain version "1") never validates on a v2 manager (protocol §7.1).
    function test_Sig_V1DomainRejected() public {
        (CreateCeremony memory a,) = _createMsg(2, 3, 1);
        bytes32 v1Domain = keccak256(
            abi.encode(DOMAIN_T, keccak256("DAVINCI DKG Council"), keccak256("1"), block.chainid, address(manager))
        );
        bytes memory v1Sig = _signDigest(orgKey, keccak256(abi.encodePacked("\x19\x01", v1Domain, _hCreate(a))));
        vm.expectRevert(BadSignature.selector);
        manager.createCeremony(a, v1Sig);
        manager.createCeremony(a, _sign(orgKey, _hCreate(a)));
    }

    function test_Sig_CrossManagerReplay() public {
        (CreateCeremony memory a, bytes memory sig) = _createMsg(2, 3, 1);
        CouncilManager other = new CouncilManager(address(dealV), address(partialV), RELEASE_ID);
        vm.expectRevert(BadSignature.selector);
        other.createCeremony(a, sig);
        manager.createCeremony(a, sig);
    }

    /// @dev An organizer action for one ceremony cannot be replayed on another.
    function test_Sig_CrossCeremonyReplay() public {
        _create(1, 2);
        bytes12 first = cid;
        (AllowAdapter memory a, bytes memory sig) = _allowMsg(address(adapter));
        _create(1, 2);
        a.ceremonyId = cid;
        vm.expectRevert(BadSignature.selector);
        manager.allowAdapter(a, sig);
        a.ceremonyId = first;
        manager.allowAdapter(a, sig);
    }
}
