// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {CouncilManager} from "../src/CouncilManager.sol";
import {CouncilViews} from "../src/CouncilViews.sol";
import {CouncilOps} from "../src/CouncilOps.sol";
import {DealVerifier} from "../src/verifiers/DealVerifier.sol";
import {PartialVerifier} from "../src/verifiers/PartialVerifier.sol";
import {MockDealVerifier, MockPartialVerifier} from "./mocks/MockVerifiers.sol";
import {Deploy} from "../script/Deploy.s.sol";
import {CouncilRelease} from "../script/CouncilRelease.sol";

/// @notice The deployment is bound to one circuit release: the pins of CouncilRelease against
///         the released files and the compiled verifiers, each verifier's code against its own
///         vkey, and every refusal of script/Deploy.s.sol (stale or swapped verifiers,
///         accept-all overrides, mock mode off the local chain, mismatched vkey files, a
///         DEVELOPMENT_SETUP release off the test chains).
contract CouncilDeployTest is Test {
    string internal constant RELEASE = "../circuits/release/";
    string internal constant DEAL_VKEY = "../circuits/release/deal_vkey.json";
    string internal constant PARTIAL_VKEY = "../circuits/release/partial_vkey.json";
    /// @dev Anvil's first default account: a public test key.
    uint256 internal constant KEY = 0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80;
    uint256 internal constant GNOSIS = 100;
    bytes internal constant DEV_REFUSED =
        "Deploy: DEVELOPMENT_SETUP release refused on a production chain (ALLOW_DEV_SETUP)";

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
        // build.sh (a DEV setup) writes no flag; the multi-party ceremony writes false
        bool dev = vm.keyExistsJson(rel, ".developmentSetup") ? vm.parseJsonBool(rel, ".developmentSetup") : true;
        assertEq(CouncilRelease.DEVELOPMENT_SETUP, dev, "development setup pin");
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

    function _assertDeployed(CouncilManager m) internal {
        assertEq(m.circuitReleaseId(), CouncilRelease.CIRCUIT_RELEASE_ID);
        assertEq(m.dealVerifier().codehash, CouncilRelease.DEAL_VERIFIER_CODEHASH);
        assertEq(m.partialVerifier().codehash, CouncilRelease.PARTIAL_VERIFIER_CODEHASH);
        assertEq(keccak256(m.views().code), keccak256(type(CouncilViews).runtimeCode));
        // CouncilOps is the manager's second CREATE and carries the same release id
        address ops = vm.computeCreateAddress(address(m), 2);
        assertEq(ops.codehash, address(new CouncilOps(CouncilRelease.CIRCUIT_RELEASE_ID)).codehash, "CouncilOps code");
    }

    function test_Deploy_PinnedReleaseLocal() public {
        if (!_release()) return;
        _assertDeployed(script.deploy(_cfg()));
    }

    function test_Deploy_PinnedReleaseOnAnotherChain() public {
        if (!_release()) return;
        vm.chainId(GNOSIS);
        Deploy.Config memory c = _cfg();
        c.allowDevSetup = CouncilRelease.DEVELOPMENT_SETUP; // a no-op for a ceremony release
        _assertDeployed(script.deploy(c));
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
        c.allowDevSetup = true;
        vm.chainId(GNOSIS);
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
        c.allowDevSetup = true; // the override never relaxes the verifier pins
        vm.chainId(GNOSIS);
        vm.expectRevert(bytes("Deploy: deal verifier code is not the pinned release"));
        script.deploy(c);
    }

    function test_Deploy_RejectsAcceptAllOverrideOnNonLocalChain() public {
        if (!_release()) return;
        vm.chainId(GNOSIS);
        Deploy.Config memory c = _cfg();
        c.allowDevSetup = true;
        c.dealVerifier = address(new MockDealVerifier());
        vm.expectRevert(bytes("Deploy: deal verifier code is not the pinned release"));
        script.deploy(c);
    }

    function test_Deploy_RejectsAcceptAllPartialOverride() public {
        if (!_release()) return;
        vm.chainId(GNOSIS);
        Deploy.Config memory c = _cfg();
        c.allowDevSetup = true;
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
        vm.chainId(GNOSIS);
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

    // ─── DEVELOPMENT_SETUP policy (audit H-01) ────────────────────────────────────────────

    /// @dev The regression: the pinned DEV release on Gnosis (chain 100) is refused by
    ///      `preflight`, a view that runs before `vm.startBroadcast`, so nothing is sent; the
    ///      deployer's nonce is untouched. A ceremony release deploys there as is.
    function test_Deploy_DevReleaseOnChain100RejectedBeforeBroadcast() public {
        if (!_release()) return;
        vm.chainId(GNOSIS);
        Deploy.Config memory c = _cfg();
        uint64 nonce = vm.getNonce(vm.addr(KEY));
        if (!CouncilRelease.DEVELOPMENT_SETUP) {
            _assertDeployed(script.deploy(c));
            return;
        }
        vm.expectRevert(DEV_REFUSED);
        script.preflight(c);
        vm.expectRevert(DEV_REFUSED);
        script.deploy(c);
        assertEq(vm.getNonce(vm.addr(KEY)), nonce, "nothing broadcast");
    }

    /// @dev Refused before the vkey files are even read.
    function test_Deploy_DevReleaseRefusedBeforeReadingTheRelease() public {
        vm.chainId(GNOSIS);
        Deploy.Config memory c = _cfg();
        c.dealVkey = "nonexistent";
        if (!CouncilRelease.DEVELOPMENT_SETUP) return;
        vm.expectRevert(DEV_REFUSED);
        script.preflight(c);
    }

    /// @dev The only test that sets ALLOW_DEV_SETUP (the process environment is shared by the
    ///      tests, which run in parallel): unset or false refuses, true deploys.
    function test_Deploy_DevReleaseRunFromEnvironmentOnChain100() public {
        if (!_release() || !CouncilRelease.DEVELOPMENT_SETUP) return;
        vm.setEnv("PRIVATE_KEY", vm.toString(bytes32(KEY)));
        vm.chainId(GNOSIS);
        vm.setEnv("ALLOW_DEV_SETUP", "false");
        assertFalse(script.configFromEnv().allowDevSetup);
        vm.expectRevert(DEV_REFUSED);
        script.run();
        vm.setEnv("ALLOW_DEV_SETUP", "true");
        assertTrue(script.configFromEnv().allowDevSetup);
        _assertDeployed(script.run());
        vm.setEnv("ALLOW_DEV_SETUP", "false");
    }

    function test_Deploy_DevReleaseOnTestChains() public {
        if (!_release()) return;
        uint256[3] memory chains = [uint256(31337), 11155111, 10200];
        for (uint256 i; i < chains.length; ++i) {
            vm.chainId(chains[i]);
            _assertDeployed(script.deploy(_cfg()));
        }
    }

    function test_Deploy_DevReleaseOnChain100WithExplicitOverride() public {
        if (!_release()) return;
        vm.chainId(GNOSIS);
        Deploy.Config memory c = _cfg();
        c.allowDevSetup = true;
        _assertDeployed(script.deploy(c));
    }

    function test_SetupPolicy_TestChains() public view {
        assertTrue(script.isTestChain(31337));
        assertTrue(script.isTestChain(11155111));
        assertTrue(script.isTestChain(10200));
        assertFalse(script.isTestChain(GNOSIS));
        assertFalse(script.isTestChain(1));
        assertFalse(script.isTestChain(1337));
    }

    /// @dev A DEV release: refused off the test chains unless explicitly allowed.
    function testFuzz_SetupPolicy_DevRelease(uint256 chainId) public {
        script.checkSetupPolicy(true, chainId, true);
        if (script.isTestChain(chainId)) {
            script.checkSetupPolicy(true, chainId, false);
        } else {
            vm.expectRevert(DEV_REFUSED);
            script.checkSetupPolicy(true, chainId, false);
        }
    }

    /// @dev A ceremony (non-DEV) release deploys anywhere, override or not.
    function testFuzz_SetupPolicy_CeremonyRelease(uint256 chainId, bool allow) public view {
        script.checkSetupPolicy(false, chainId, allow);
    }
}
