// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

/// @title CouncilRelease
/// @notice The circuit release a deployment is bound to, pinned as one unit: the byte-exact
///         sha256 of both released vkey files (protocol §4.4), the circuitReleaseId derived from
///         them, and the runtime code hash of the generated verifier contracts compiled from
///         `src/verifiers/` with this project's foundry.toml. `script/Deploy.s.sol` refuses vkey
///         files or verifier contracts that do not match. `test/CouncilDeploy.t.sol` checks these
///         pins against `circuits/release/release.json`, the vkey files and the compiled
///         verifiers, and checks that each verifier's code embeds its vkey's constants; a new
///         circuits release regenerates the verifiers and must update every value here together.
library CouncilRelease {
    /// @dev circuits/release/release.json "tag".
    string internal constant TAG = "circuits-v1";
    /// @dev DEVELOPMENT setup (one local contribution + beacon): not for production.
    bool internal constant DEVELOPMENT_SETUP = true;

    bytes32 internal constant DEAL_VKEY_SHA256 = 0x329f3456ac194bf8f7e07974b7f782a8bcc797e2ce37e46dc357dd3dbd442444;
    bytes32 internal constant PARTIAL_VKEY_SHA256 = 0xae15a6c0ab9dfe26756aef8af8d7766c8d462bbeefae0847f513a2d317ad1991;
    bytes32 internal constant CIRCUIT_RELEASE_ID = 0x071a01deb1e9b5e5e1da302df14be234c5ee5b91603d7f0437852dbf1c665301;

    /// @dev keccak256 of the deployed (runtime) bytecode, i.e. EXTCODEHASH of a deployment.
    bytes32 internal constant DEAL_VERIFIER_CODEHASH =
        0x11846f7e14acc5efe8e7c97ebc1af97a6fab6350e631aba333715e7cb0cc9c1f;
    bytes32 internal constant PARTIAL_VERIFIER_CODEHASH =
        0x8599caa2240444a17eea76d829f019a7e5844a183f469f05effeea41d867a177;
}
