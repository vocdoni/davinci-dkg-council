// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CouncilManager} from "../src/CouncilManager.sol";
import {CouncilViews} from "../src/CouncilViews.sol";
import {DealVerifier} from "../src/verifiers/DealVerifier.sol";
import {PartialVerifier} from "../src/verifiers/PartialVerifier.sol";
import {MockDealVerifier, MockPartialVerifier} from "./mocks/MockVerifiers.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {CouncilRelease} from "../script/CouncilRelease.sol";

/// @notice The deployment is bound to one circuit release: the pins of CouncilRelease against
///         the released files and the compiled verifiers, each verifier's code against its own
///         vkey, and every refusal of script/Deploy.s.sol (stale or swapped verifiers,
///         accept-all overrides, mock mode off the local chain, mismatched vkey files).
contract CouncilDeployTest is Test {
    string internal constant RELEASE = "../circuits/release/";
    string internal constant DEAL_VKEY = "../circuits/release/deal_vkey.json";
    string internal constant PARTIAL_VKEY = "../circuits/release/partial_vkey.json";
    /// @dev Anvil's first default account: a public test key.
    uint256 internal constant KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;

    Deploy internal script;

    function setUp() public {
        vm.chainId(31337);
        script = new Deploy();
    }

    function _release() internal returns (bool) {
        if (!vm.exists(string.concat(RELEASE, "release.json"))) {
            vm.skip(true);
            return false;
        }
        return true;
    }

    function _cfg() internal pure returns (Deploy.Config memory c) {
        c.deployerKey = KEY;
        c.dealVkey = DEAL_VKEY;
        c.partialVkey = PARTIAL_VKEY;
    }

    // ─── Release pins ─────────────────────────────────────────────────────────────────────

    function test_Release_PinsMatchArtifacts() public {
        if (!_release()) return;
        string memory rel = vm.readFile(string.concat(RELEASE, "release.json"));
        assertEq(vm.parseJsonString(rel, ".tag"), CouncilRelease.TAG, "tag");
        assertEq(vm.parseJsonBytes32(rel, ".deal.vkey.sha256"), CouncilRelease.DEAL_VKEY_SHA256, "deal vkey pin");
        assertEq(
            vm.parseJsonBytes32(rel, ".partial.vkey.sha256"), CouncilRelease.PARTIAL_VKEY_SHA256, "partial vkey pin"
        );
        assertEq(vm.parseJsonBytes32(rel, ".circuitReleaseId"), CouncilRelease.CIRCUIT_RELEASE_ID, "release id pin");
        assertEq(sha256(vm.readFileBinary(DEAL_VKEY)), CouncilRelease.DEAL_VKEY_SHA256, "deal vkey file");
        assertEq(sha256(vm.readFileBinary(PARTIAL_VKEY)), CouncilRelease.PARTIAL_VKEY_SHA256, "partial vkey file");
        assertEq(
            script.releaseIdOf(CouncilRelease.DEAL_VKEY_SHA256, CouncilRelease.PARTIAL_VKEY_SHA256),
            CouncilRelease.CIRCUIT_RELEASE_ID,
            "protocol 4.4 derivation"
        );
        assertEq(address(new DealVerifier()).codehash, CouncilRelease.DEAL_VERIFIER_CODEHASH, "deal verifier code");
        assertEq(
            address(new PartialVerifier()).codehash, CouncilRelease.PARTIAL_VERIFIER_CODEHASH, "partial verifier code"
        );
    }

    /// @dev Ties the pinned verifier code to the pinned vkey: every vkey constant (alpha, beta,
    ///      gamma, delta, every IC point) appears in the verifier's runtime code, and the other
    ///      circuit's IC points do not.
    function test_Release_VerifierCodeEmbedsItsVkey() public {
        if (!_release()) return;
        bytes memory dealCode = address(new DealVerifier()).code;
        bytes memory partialCode = address(new PartialVerifier()).code;
        string memory dv = vm.readFile(DEAL_VKEY);
        string memory pv = vm.readFile(PARTIAL_VKEY);
        assertEq(vm.parseJsonUint(dv, ".nPublic"), 87);
        assertEq(vm.parseJsonUint(pv, ".nPublic"), 67);
        _assertEmbeds(dealCode, dv, 88);
        _assertEmbeds(partialCode, pv, 68);
        uint256[] memory ic0 = vm.parseJsonUintArray(dv, ".IC[0]");
        assertFalse(_contains(partialCode, ic0[0]), "partial verifier embeds the deal vkey");
        ic0 = vm.parseJsonUintArray(pv, ".IC[0]");
        assertFalse(_contains(dealCode, ic0[0]), "deal verifier embeds the partial vkey");
    }

    function _assertEmbeds(bytes memory code, string memory vk, uint256 ics) internal view {
        uint256[] memory a = vm.parseJsonUintArray(vk, ".vk_alpha_1");
        assertTrue(_contains(code, a[0]) && _contains(code, a[1]), "alpha");
        string[3] memory g2 = [".vk_beta_2", ".vk_gamma_2", ".vk_delta_2"];
        for (uint256 i; i < 3; ++i) {
            for (uint256 j; j < 2; ++j) {
                a = vm.parseJsonUintArray(vk, string.concat(g2[i], "[", vm.toString(j), "]"));
                assertTrue(_contains(code, a[0]) && _contains(code, a[1]), g2[i]);
            }
        }
        for (uint256 i; i < ics; ++i) {
            a = vm.parseJsonUintArray(vk, string.concat(".IC[", vm.toString(i), "]"));
            assertTrue(_contains(code, a[0]) && _contains(code, a[1]), "IC");
        }
        assertFalse(vm.keyExistsJson(vk, string.concat(".IC[", vm.toString(ics), "]")), "IC count");
    }

    /// @dev Whether `word` occurs in `code` as the immediate of a PUSH of its minimal big-endian
    ///      length (a constant with leading zero bytes compiles to a shorter PUSH).
    function _contains(bytes memory code, uint256 word) internal pure returns (bool found) {
        uint256 len = 32;
        while (len > 1 && word >> (8 * (len - 1)) == 0) {
            --len;
        }
        uint256 shift = 8 * (32 - len);
        uint256 push = 0x5f + len;
        assembly ("memory-safe") {
            let base := add(code, 32)
            let end := sub(add(base, mload(code)), len)
            for { let p := add(base, 1) } lt(p, end) { p := add(p, 1) } {
                if and(eq(shr(shift, mload(p)), word), eq(byte(0, mload(sub(p, 1))), push)) {
                    found := 1
                    break
                }
            }
        }
    }

    // ─── The deploy script ────────────────────────────────────────────────────────────────

    function _assertDeployed(CouncilManager m) internal view {
        assertEq(m.circuitReleaseId(), CouncilRelease.CIRCUIT_RELEASE_ID);
        assertEq(m.dealVerifier().codehash, CouncilRelease.DEAL_VERIFIER_CODEHASH);
        assertEq(m.partialVerifier().codehash, CouncilRelease.PARTIAL_VERIFIER_CODEHASH);
        assertEq(keccak256(m.views().code), keccak256(type(CouncilViews).runtimeCode));
    }

    function test_Deploy_PinnedReleaseLocal() public {
        if (!_release()) return;
        _assertDeployed(script.deploy(_cfg()));
    }

    function test_Deploy_PinnedReleaseOnAnotherChain() public {
        if (!_release()) return;
        vm.chainId(100);
        _assertDeployed(script.deploy(_cfg()));
    }

    function test_Deploy_RunFromEnvironment() public {
        if (!_release()) return;
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(KEY)));
        _assertDeployed(script.run());
    }

    function test_Deploy_ReusesReleasedVerifiers() public {
        if (!_release()) return;
        Deploy.Config memory c = _cfg();
        c.dealVerifier = address(new DealVerifier());
        c.partialVerifier = address(new PartialVerifier());
        vm.chainId(100);
        CouncilManager m = script.deploy(c);
        assertEq(m.dealVerifier(), c.dealVerifier);
        assertEq(m.partialVerifier(), c.partialVerifier);
    }

    function test_Deploy_RejectsSwappedVerifiers() public {
        if (!_release()) return;
        Deploy.Config memory c = _cfg();
        c.dealVerifier = address(new PartialVerifier());
        c.partialVerifier = address(new DealVerifier());
        vm.expectRevert(bytes("Deploy: deal verifier code is not the pinned release"));
        script.deploy(c);
    }

    function test_Deploy_RejectsSwappedPartialVerifier() public {
        if (!_release()) return;
        Deploy.Config memory c = _cfg();
        c.partialVerifier = address(new DealVerifier());
        vm.expectRevert(bytes("Deploy: partial verifier code is not the pinned release"));
        script.deploy(c);
    }

    /// @dev A verifier compiled from another (stale) release: same contract, different constants.
    function test_Deploy_RejectsStaleVerifier() public {
        if (!_release()) return;
        bytes memory code = address(new DealVerifier()).code;
        string memory dv = vm.readFile(DEAL_VKEY);
        uint256 ic5x = vm.parseJsonUintArray(dv, ".IC[5]")[0];
        assembly ("memory-safe") {
            let base := add(code, 32)
            let end := sub(add(base, mload(code)), 31)
            for { let p := base } lt(p, end) { p := add(p, 1) } {
                if eq(mload(p), ic5x) {
                    mstore(p, add(ic5x, 1))
                    break
                }
            }
        }
        assertTrue(keccak256(code) != CouncilRelease.DEAL_VERIFIER_CODEHASH, "constant not patched");
        address stale = address(0x5741E);
        vm.etch(stale, code);
        Deploy.Config memory c = _cfg();
        c.dealVerifier = stale;
        vm.chainId(100);
        vm.expectRevert(bytes("Deploy: deal verifier code is not the pinned release"));
        script.deploy(c);
    }

    function test_Deploy_RejectsAcceptAllOverrideOnNonLocalChain() public {
        if (!_release()) return;
        vm.chainId(100);
        Deploy.Config memory c = _cfg();
        c.dealVerifier = address(new MockDealVerifier());
        vm.expectRevert(bytes("Deploy: deal verifier code is not the pinned release"));
        script.deploy(c);
    }

    function test_Deploy_RejectsAcceptAllPartialOverride() public {
        if (!_release()) return;
        vm.chainId(100);
        Deploy.Config memory c = _cfg();
        c.partialVerifier = address(new MockPartialVerifier());
        vm.expectRevert(bytes("Deploy: partial verifier code is not the pinned release"));
        script.deploy(c);
    }

    /// @dev Without the explicit local mode, even chain 31337 gets only the released verifiers.
    function test_Deploy_RejectsAcceptAllOverrideOutsideMockMode() public {
        if (!_release()) return;
        Deploy.Config memory c = _cfg();
        c.dealVerifier = address(new MockDealVerifier());
        vm.expectRevert(bytes("Deploy: deal verifier code is not the pinned release"));
        script.deploy(c);
    }

    function test_Deploy_RejectsMockModeOffLocalChain() public {
        vm.chainId(100);
        Deploy.Config memory c = _cfg();
        c.mock = true;
        vm.expectRevert(bytes("Deploy: mock verifiers only on the local chain 31337"));
        script.deploy(c);
    }

    function test_Deploy_MockModeOnLocalChain() public {
        Deploy.Config memory c = _cfg();
        c.mock = true;
        c.dealVkey = "nonexistent"; // mock mode never reads the release
        CouncilManager m = script.deploy(c);
        assertEq(keccak256(m.dealVerifier().code), keccak256(type(MockDealVerifier).runtimeCode));
        assertEq(keccak256(m.partialVerifier().code), keccak256(type(MockPartialVerifier).runtimeCode));
        assertEq(m.circuitReleaseId(), keccak256("davinci-dkg-council/dev/mock-circuit-release"));
    }

    function test_Deploy_RejectsSwappedVkeyFiles() public {
        if (!_release()) return;
        Deploy.Config memory c = _cfg();
        (c.dealVkey, c.partialVkey) = (PARTIAL_VKEY, DEAL_VKEY);
        vm.expectRevert(bytes("Deploy: deal vkey is not the pinned release"));
        script.deploy(c);
    }

    function test_Deploy_RejectsForeignPartialVkey() public {
        if (!_release()) return;
        Deploy.Config memory c = _cfg();
        c.partialVkey = string.concat(RELEASE, "release.json");
        vm.expectRevert(bytes("Deploy: partial vkey is not the pinned release"));
        script.deploy(c);
    }

    function test_Deploy_RejectsReleaseIdMismatch() public {
        if (!_release()) return;
        Deploy.Config memory c = _cfg();
        c.expectedReleaseId = keccak256("davinci-dkg-council/v1/test-vector/other-release");
        vm.expectRevert(bytes("Deploy: CIRCUIT_RELEASE_ID differs from the pinned release"));
        script.deploy(c);
    }
}
