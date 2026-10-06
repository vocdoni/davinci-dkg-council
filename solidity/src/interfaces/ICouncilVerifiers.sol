// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

/// @notice snarkjs-generated Groth16 verifier for the dealing circuit (protocol §8.5, 87 public
///         signals). Proof words follow `groth16.exportSolidityCallData` (protocol §7.2).
interface IDealVerifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[87] calldata pubSignals
    ) external view returns (bool);
}

/// @notice snarkjs-generated Groth16 verifier for the partial-decryption circuit (protocol §10.1,
///         67 public signals).
interface IPartialVerifier {
    function verifyProof(
        uint256[2] calldata pA,
        uint256[2][2] calldata pB,
        uint256[2] calldata pC,
        uint256[67] calldata pubSignals
    ) external view returns (bool);
}
