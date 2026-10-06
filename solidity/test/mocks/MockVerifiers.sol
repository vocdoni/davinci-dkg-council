// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import {IDealVerifier, IPartialVerifier} from "../../src/interfaces/ICouncilVerifiers.sol";

/// @notice Configurable stand-in for the snarkjs verifiers until the circuits release lands:
///         accepts or rejects every proof. Tests pin the exact public-input vector the manager
///         builds with `vm.expectCall` on `verifyProof`. Never deploy outside tests / local e2e.
contract MockVerifierBase {
    bool public accept = true;

    function setAccept(bool accept_) external {
        accept = accept_;
    }
}

contract MockDealVerifier is MockVerifierBase, IDealVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[87] calldata)
        external
        view
        returns (bool)
    {
        return accept;
    }
}

contract MockPartialVerifier is MockVerifierBase, IPartialVerifier {
    function verifyProof(uint256[2] calldata, uint256[2][2] calldata, uint256[2] calldata, uint256[67] calldata)
        external
        view
        returns (bool)
    {
        return accept;
    }
}
