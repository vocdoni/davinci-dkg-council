// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {CouncilManager} from "../src/CouncilManager.sol";
import {MockDealVerifier, MockPartialVerifier} from "../test/mocks/MockVerifiers.sol";
import {CouncilRelease} from "./CouncilRelease.sol";

/// @title Deploy
/// @notice Deploys (or reuses) the two generated Groth16 verifiers and deploys the CouncilManager,
///         bound to the pinned circuit release of `CouncilRelease`:
///           1. the vkey files hash to the pinned sha256s and give the pinned circuitReleaseId;
///           2. both verifier addresses carry exactly the pinned runtime code (EXTCODEHASH),
///              whether deployed here or reused, checked before the manager is deployed.
///         Mock (accept-all) verifiers exist only in an explicit local mode on chain 31337.
///         A release pinned with `CouncilRelease.DEVELOPMENT_SETUP` (a single-party phase 2 whose
///         operator could forge every proof) is refused on any chain but the explicit test chains
///         31337 (Anvil), 11155111 (Sepolia) and 10200 (Chiado) unless ALLOW_DEV_SETUP=true, a
///         rehearsal-only override that logs a loud warning. Every refusal happens before the
///         first broadcast (`preflight` is a view).
///
///   forge script script/Deploy.s.sol --rpc-url $RPC_URL --broadcast
///
/// Environment:
///   PRIVATE_KEY            deployer key (required)
///   DEAL_VKEY              deal vkey JSON, default ../circuits/release/deal_vkey.json
///   PARTIAL_VKEY           partial vkey JSON, default ../circuits/release/partial_vkey.json
///   CIRCUIT_RELEASE_ID     optional extra assertion on the derived id
///   DEAL_VERIFIER          reuse a deployed deal verifier (must match the pinned code hash)
///   PARTIAL_VERIFIER       reuse a deployed partial verifier (must match the pinned code hash)
///   MOCK_VERIFIERS=true    local development only, refused unless chain id is 31337: accept-all
///                          mock verifiers, release id CIRCUIT_RELEASE_ID (default a fixed dev id)
///   ALLOW_DEV_SETUP=true   deploy a DEVELOPMENT_SETUP release on a chain that is not a test chain
///                          (a rehearsal network only: whoever ran that setup can forge proofs)
contract Deploy is Script {
    uint256 internal constant LOCAL_CHAIN_ID = 31337;
    uint256 internal constant SEPOLIA_CHAIN_ID = 11155111;
    uint256 internal constant CHIADO_CHAIN_ID = 10200;
    bytes32 internal constant TAG_CIRCUIT_RELEASE = keccak256("davinci-dkg-council/v1/circuit-release");
    bytes32 internal constant DEV_MOCK_RELEASE_ID = keccak256("davinci-dkg-council/dev/mock-circuit-release");

    struct Config {
        uint256 deployerKey;
        bool mock;
        address dealVerifier; // zero: deploy from the compiled artifact
        address partialVerifier; // zero: deploy from the compiled artifact
        string dealVkey;
        string partialVkey;
        bytes32 expectedReleaseId; // zero: no extra assertion (mock mode: the release id to use)
        bool allowDevSetup; // a DEVELOPMENT_SETUP release on a non-test chain (rehearsals only)
    }

    function run() external returns (CouncilManager) {
        return deploy(configFromEnv());
    }

    function configFromEnv() public view returns (Config memory c) {
        c.deployerKey = vm.envUint("PRIVATE_KEY");
        c.mock = vm.envOr("MOCK_VERIFIERS", false);
        c.dealVerifier = vm.envOr("DEAL_VERIFIER", address(0));
        c.partialVerifier = vm.envOr("PARTIAL_VERIFIER", address(0));
        c.dealVkey = vm.envOr("DEAL_VKEY", string("../circuits/release/deal_vkey.json"));
        c.partialVkey = vm.envOr("PARTIAL_VKEY", string("../circuits/release/partial_vkey.json"));
        c.expectedReleaseId = vm.envOr("CIRCUIT_RELEASE_ID", bytes32(0));
        c.allowDevSetup = vm.envOr("ALLOW_DEV_SETUP", false);
    }

    /// @notice Env-free core of `run`, so every policy below is testable.
    function deploy(Config memory cfg) public returns (CouncilManager manager) {
        bytes32 releaseId = preflight(cfg);

        vm.startBroadcast(cfg.deployerKey);
        address dealVerifier = cfg.dealVerifier;
        address partialVerifier = cfg.partialVerifier;
        if (dealVerifier == address(0)) {
            dealVerifier = cfg.mock ? address(new MockDealVerifier()) : deployCode("DealVerifier.sol:DealVerifier");
        }
        if (partialVerifier == address(0)) {
            partialVerifier =
                cfg.mock ? address(new MockPartialVerifier()) : deployCode("PartialVerifier.sol:PartialVerifier");
        }
        require(dealVerifier.code.length != 0 && partialVerifier.code.length != 0, "Deploy: verifier has no code");
        if (!cfg.mock) {
            // also covers verifiers deployed above from the local artifacts
            checkDealVerifier(dealVerifier);
            checkPartialVerifier(partialVerifier);
        }
        manager = new CouncilManager(dealVerifier, partialVerifier, releaseId);
        vm.stopBroadcast();

        require(manager.circuitReleaseId() == releaseId, "Deploy: release id");
        require(manager.dealVerifier() == dealVerifier && manager.partialVerifier() == partialVerifier, "Deploy");
        console2.log("DealVerifier     ", dealVerifier);
        console2.log("PartialVerifier  ", partialVerifier);
        console2.log("CouncilManager  ", address(manager));
        console2.log("CouncilViews    ", manager.views());
        // the manager's second CREATE (architecture §1.7): no getter, the address is derivable
        console2.log("CouncilOps      ", vm.computeCreateAddress(address(manager), 2));
        console2.log("circuitReleaseId ");
        console2.logBytes32(releaseId);
    }

    /// @notice Every check that can refuse a deployment, run before anything is broadcast (a
    ///         view: it cannot deploy or send). Returns the release id the manager is bound to.
    function preflight(Config memory cfg) public view returns (bytes32 releaseId) {
        if (cfg.mock) {
            require(block.chainid == LOCAL_CHAIN_ID, "Deploy: mock verifiers only on the local chain 31337");
            return cfg.expectedReleaseId == bytes32(0) ? DEV_MOCK_RELEASE_ID : cfg.expectedReleaseId;
        }
        checkSetupPolicy(CouncilRelease.DEVELOPMENT_SETUP, block.chainid, cfg.allowDevSetup);
        releaseId = checkVkeys(cfg.dealVkey, cfg.partialVkey);
        require(
            cfg.expectedReleaseId == bytes32(0) || cfg.expectedReleaseId == releaseId,
            "Deploy: CIRCUIT_RELEASE_ID differs from the pinned release"
        );
        // reused verifiers are refused before anything is broadcast
        if (cfg.dealVerifier != address(0)) checkDealVerifier(cfg.dealVerifier);
        if (cfg.partialVerifier != address(0)) checkPartialVerifier(cfg.partialVerifier);
    }

    /// @notice The chains a DEVELOPMENT_SETUP release may go to without the override: Anvil,
    ///         Sepolia and Gnosis Chiado. Every other chain is treated as production.
    function isTestChain(uint256 chainId) public pure returns (bool) {
        return chainId == LOCAL_CHAIN_ID || chainId == SEPOLIA_CHAIN_ID || chainId == CHIADO_CHAIN_ID;
    }

    /// @notice Audit H-01: a DEVELOPMENT_SETUP release had a single-party phase 2, so whoever ran
    ///         it can forge deal and partial proofs. Refused off the test chains unless
    ///         `allowDevSetup`, which only adds a loud warning to the log.
    function checkSetupPolicy(bool developmentSetup, uint256 chainId, bool allowDevSetup) public pure {
        if (!developmentSetup) return;
        if (isTestChain(chainId)) {
            console2.log("Deploy: note: DEVELOPMENT_SETUP circuit release (test chain)");
            return;
        }
        require(allowDevSetup, "Deploy: DEVELOPMENT_SETUP release refused on a production chain (ALLOW_DEV_SETUP)");
        console2.log("##########################################################################");
        console2.log("WARNING: ALLOW_DEV_SETUP=true: deploying a DEVELOPMENT_SETUP circuit release");
        console2.log("WARNING: on chain", chainId, "which is not a test chain.");
        console2.log("WARNING: its phase 2 had ONE contributor, who can forge every deal and");
        console2.log("WARNING: partial proof. Rehearsals only; never protect real elections.");
        console2.log("##########################################################################");
    }

    /// @notice The vkey files must be the pinned release, byte for byte; returns its
    ///         circuitReleaseId (protocol §4.4).
    function checkVkeys(string memory dealVkey, string memory partialVkey) public view returns (bytes32 id) {
        bytes32 dealSha = sha256(vm.readFileBinary(dealVkey));
        bytes32 partialSha = sha256(vm.readFileBinary(partialVkey));
        require(dealSha == CouncilRelease.DEAL_VKEY_SHA256, "Deploy: deal vkey is not the pinned release");
        require(partialSha == CouncilRelease.PARTIAL_VKEY_SHA256, "Deploy: partial vkey is not the pinned release");
        id = releaseIdOf(dealSha, partialSha);
        require(id == CouncilRelease.CIRCUIT_RELEASE_ID, "Deploy: pinned release id is inconsistent");
    }

    /// @notice The deal verifier address must run exactly the pinned generated code.
    function checkDealVerifier(address dealVerifier) public view {
        require(
            dealVerifier.codehash == CouncilRelease.DEAL_VERIFIER_CODEHASH,
            "Deploy: deal verifier code is not the pinned release"
        );
    }

    /// @notice The partial verifier address must run exactly the pinned generated code.
    function checkPartialVerifier(address partialVerifier) public view {
        require(
            partialVerifier.codehash == CouncilRelease.PARTIAL_VERIFIER_CODEHASH,
            "Deploy: partial verifier code is not the pinned release"
        );
    }

    /// @notice protocol §4.4: K("davinci-dkg-council/v1/circuit-release", sha256(deal vkey), sha256(partial vkey)).
    function releaseIdOf(bytes32 dealVkeySha256, bytes32 partialVkeySha256) public pure returns (bytes32) {
        return keccak256(abi.encode(TAG_CIRCUIT_RELEASE, dealVkeySha256, partialVkeySha256));
    }
}
