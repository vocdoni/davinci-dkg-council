// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../../src/CouncilTypes.sol";
import {CouncilManager} from "../../src/CouncilManager.sol";
import {CouncilCurve} from "../../src/libraries/CouncilCurve.sol";
import {CouncilEIP712} from "../../src/libraries/CouncilEIP712.sol";

/// @notice Exposes CouncilEIP712 with calldata structs (deploy it at the manager address to
///         reproduce a manager's domain).
contract EIP712Harness {
    function domainSeparator() external view returns (bytes32) {
        return CouncilEIP712.domainSeparator();
    }

    function digest(bytes32 structHash) external view returns (bytes32) {
        return CouncilEIP712.digest(structHash);
    }

    function recover(bytes32 structHash, bytes calldata sig) external view returns (address) {
        return CouncilEIP712.recover(structHash, sig);
    }

    function verify(bytes32 structHash, bytes calldata sig, address expected) external view {
        CouncilEIP712.verify(structHash, sig, expected);
    }

    function hashCreateCeremony(CreateCeremony calldata a) external pure returns (bytes32) {
        return CouncilEIP712.hashCreateCeremony(a);
    }

    function hashAddInvites(AddInvites calldata a) external pure returns (bytes32) {
        return CouncilEIP712.hashAddInvites(a);
    }

    function hashCloseRegistration(CloseRegistration calldata a) external pure returns (bytes32) {
        return CouncilEIP712.hashCloseRegistration(a);
    }

    function hashAllowAdapter(AllowAdapter calldata a) external pure returns (bytes32) {
        return CouncilEIP712.hashAllowAdapter(a);
    }

    function hashAuthorizeCreator(AuthorizeCreator calldata a) external pure returns (bytes32) {
        return CouncilEIP712.hashAuthorizeCreator(a);
    }

    function hashInvite(Invite calldata a) external pure returns (bytes32) {
        return CouncilEIP712.hashInvite(a);
    }

    function hashJoin(Join calldata a) external pure returns (bytes32) {
        return CouncilEIP712.hashJoin(a);
    }

    function hashDeal(Deal calldata a) external pure returns (bytes32) {
        return CouncilEIP712.hashDeal(a);
    }

    function hashPartial(Partial calldata a) external pure returns (bytes32) {
        return CouncilEIP712.hashPartial(a);
    }
}

/// @notice Exposes CouncilCurve.
contract CurveHarness {
    function toReduced(uint256 x) external pure returns (uint256) {
        return CouncilCurve.toReduced(x);
    }

    function toTE(uint256 x) external pure returns (uint256) {
        return CouncilCurve.toTE(x);
    }

    function requireOnCurveTE(uint256 x, uint256 y) external pure returns (uint256) {
        return CouncilCurve.requireOnCurveTE(x, y);
    }

    function requireSubgroupTE(uint256 x, uint256 y) external pure returns (uint256) {
        return CouncilCurve.requireSubgroupTE(x, y);
    }

    function invModR(uint256 a) external view returns (uint256) {
        return CouncilCurve.invModR(a);
    }

    function lagrange(uint8[] calldata set) external view returns (uint256[] memory) {
        return CouncilCurve.lagrange(set);
    }

    function horner(uint256[2][16] memory a, uint256 t, uint256 m) external view returns (uint256, uint256) {
        return CouncilCurve.horner(a, t, m);
    }

    /// @dev Batch-normalizes extended points (X, Y, Z, T) and returns their affine (x, y).
    function normalize(uint256[4][] memory ext) external view returns (uint256[2][] memory out) {
        uint256 len = ext.length;
        uint256 pts = CouncilCurve.alloc(len);
        for (uint256 i; i < len; ++i) {
            uint256 r = CouncilCurve.at(pts, i);
            uint256[4] memory e = ext[i];
            assembly ("memory-safe") {
                mstore(r, mload(e))
                mstore(add(r, 0x20), mload(add(e, 0x20)))
                mstore(add(r, 0x40), mload(add(e, 0x40)))
                mstore(add(r, 0x60), mload(add(e, 0x60)))
            }
        }
        CouncilCurve.normalize(pts, len, len, pts);
        out = new uint256[2][](len);
        for (uint256 i; i < len; ++i) {
            (out[i][0], out[i][1]) = CouncilCurve.affineAt(pts, i);
        }
    }
}

/// @notice CouncilManager with its HashToScalar exposed.
contract CouncilManagerHarness is CouncilManager {
    constructor(address d, address p, bytes32 id) CouncilManager(d, p, id) {}

    function hashToScalar(bytes memory prefix) external pure returns (uint256) {
        return _hashToScalar(prefix);
    }
}
