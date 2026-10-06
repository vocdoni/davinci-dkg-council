// SPDX-License-Identifier: AGPL-3.0-or-later
pragma solidity 0.8.28;

import "../src/CouncilTypes.sol";
import {CouncilTestBase} from "./utils/CouncilTestBase.sol";
import {VectorReplay} from "./utils/VectorReplay.sol";

/// @notice Per-action gas (architecture §1.8). Run with `FOUNDRY_PROFILE=gas forge snapshot
///         --match-contract Gas`: the profile isolates every manager call in its own transaction
///         (cold storage, intrinsic cost) and executes under Osaka; results go to
///         `snapshots/council.json`. `make solidity-gas` also runs it with `--evm-version
///         amsterdam` and `COUNCIL_GAS_GROUP=council-amsterdam` (EIP-8037 state gas, Sepolia
///         since Glamsterdam) into `snapshots/council-amsterdam.json`. `n*_t*` entries run on mock verifiers (the test contract
///         plays the allowed adapter so bind/request are measured directly); `real_*` entries
///         replay the vector scenarios with the generated verifiers and the canned proofs, so
///         their deal / submitPartial numbers include the real Groth16 verification.
contract CouncilGasTest is VectorReplay {
    function setUp() public override {
        CouncilTestBase.setUp();
    }

    function test_Gas_RealProofs_n16_t16() public {
        gasTag = "real_n16_t16";
        _replay(1, true);
    }

    function test_Gas_RealProofs_n3_t2() public {
        gasTag = "real_n3_t2";
        _replay(0, true);
    }

    function _snap(string memory tag, string memory action) internal {
        vm.snapshotGasLastCall(vm.envOr("COUNCIL_GAS_GROUP", string("council")), string.concat(tag, "_", action));
    }

    function _run(uint8 n, uint8 t, uint256 fields, string memory tag) internal {
        (CreateCeremony memory ca, bytes memory csig) = _createMsg(t, n, ++nonceCounter);
        cid = manager.createCeremony(ca, csig);
        _snap(tag, "createCeremony");
        T = t;

        // AddInvites with 4 more capability addresses
        address[] memory more = new address[](4);
        for (uint256 i; i < 4; ++i) {
            uint256 s = _secp(abi.encode("more", tag, i));
            inviteSecrets.push(s);
            more[i] = vm.addr(s);
        }
        AddInvites memory aa = AddInvites(cid, n, more, validUntil);
        bytes memory asig = _sign(orgKey, _hAddInvites(aa));
        manager.addInvites(aa, asig);
        _snap(tag, "addInvites4");

        for (uint256 i = 1; i <= n; ++i) {
            uint256 auth = _memberAuth(i);
            uint256 x = _memberShareKey(i);
            JoinCall memory j = _joinMsg(i, uint32(i - 1), auth, x);
            _sendJoin(j);
            if (i == 1) _snap(tag, "join_first");
            if (i == n) _snap(tag, "join_last");
            authSecrets.push(auth);
            shareSecrets.push(x);
        }
        (CloseRegistration memory cl, bytes memory clsig) = _closeMsg(n);
        manager.closeRegistration(cl, clsig);
        _snap(tag, "closeRegistration");

        for (uint256 j = 1; j <= n; ++j) {
            DealCall memory d = _dealMsg(j);
            _sendDeal(d);
            qualBits |= 1 << (j - 1);
            if (j == 1) _snap(tag, "deal_first");
            if (j == n) _snap(tag, "deal_last");
        }
        manager.finalize(cid);
        _snap(tag, "finalize");

        (AllowAdapter memory al, bytes memory alsig) = _allowMsg(address(this));
        manager.allowAdapter(al, alsig);
        _snap(tag, "allowAdapter");
        (AuthorizeCreator memory au, bytes memory ausig) = _authorizeMsg(creator);
        manager.authorizeCreator(au, ausig);
        _snap(tag, "authorizeCreator");

        pid = bytes31(keccak256(bytes(tag)));
        (requestId,,) = manager.bindProcess(cid, pid, creator);
        _snap(tag, "bindProcess");

        uint64[] memory plain = new uint64[](fields);
        for (uint256 k; k < fields; ++k) {
            plain[k] = uint64(1000 * k + 7);
        }
        _encrypt(plain);
        uint256[4][] memory c = new uint256[4][](fields);
        for (uint256 k; k < fields; ++k) {
            c[k] = cts[k];
        }
        manager.submitRequest(cid, pid, c);
        _snap(tag, string.concat("submitRequest_", vm.toString(fields), "fields"));

        for (uint256 i = 1; i <= t; ++i) {
            PartialCall memory p = _partialMsg(i);
            _sendPartial(p);
            if (i == 1) _snap(tag, string.concat("submitPartial_", vm.toString(fields), "fields"));
        }

        uint8[] memory set = _range(1, t);
        // chunks of 1, 2 and 4 fields, then the rest in chunks of 4
        uint256 start;
        for (uint256 size = 1; size <= 4 && start < fields; size *= 2) {
            uint256 len = start + size <= fields ? size : fields - start;
            _combine(set, _range(start, len));
            _snap(tag, string.concat("combine_", vm.toString(len), "fields"));
            start += len;
        }
        while (start < fields) {
            uint256 len = fields - start < 4 ? fields - start : 4;
            _combine(set, _range(start, len));
            start += len;
        }
        (bool ready,) = manager.getPlaintexts(requestId);
        assertTrue(ready);
    }

    function test_Gas_n16_t16() public {
        _run(16, 16, 16, "n16_t16");
    }

    function test_Gas_n5_t3() public {
        _run(5, 3, 16, "n5_t3");
    }

    function test_Gas_n5_t3_oneField() public {
        _run(5, 3, 1, "n5_t3_f1");
    }
}
