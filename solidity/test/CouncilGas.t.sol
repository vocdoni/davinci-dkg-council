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
///         since Glamsterdam) into `snapshots/council-amsterdam.json`. `n*_t*` entries run on mock
///         verifiers (the test contract plays the allowed adapter so bind/request are measured
///         directly); `real_*` entries replay the vector scenarios with the generated verifiers
///         and the canned proofs, so their deal / submitPartial numbers include the real Groth16
///         verification (scenario A: Manual policies, B: Scheduled ones). `*_sparse_*` entries
///         combine with the member set whose Lagrange coefficients are all full width: the
///         scalar multiplication skips leading zero windows, so a consecutive set (whose
///         coefficients are ±binomials, half of them a few bits wide) understates the worst case.
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

    function _joinAll(uint8 n, string memory tag) internal {
        for (uint256 i = 1; i <= n; ++i) {
            uint256 auth = _memberAuth(i);
            uint256 x = _memberShareKey(i);
            JoinCall memory j = _joinMsg(i, uint32(i - 1), auth, x);
            _sendJoin(j);
            if (bytes(tag).length != 0 && i == 1) _snap(tag, "join_first");
            if (bytes(tag).length != 0 && i == n) _snap(tag, "join_last");
            authSecrets.push(auth);
            shareSecrets.push(x);
            memberX.push([j.a.pkX, j.a.pkY]);
        }
    }

    /// @dev Manual registration closed by the organizer, Manual decryption opened by the organizer.
    function _run(uint8 n, uint8 t, uint256 fields, string memory tag) internal {
        customPolicy = false;
        (CreateCeremony memory ca, bytes memory csig) = _createMsg(t, n, ++nonceCounter);
        cid = manager.createCeremony(ca, csig);
        _snap(tag, "createCeremony");
        T = t;
        delete authSecrets;
        delete shareSecrets;
        delete memberX;
        qualBits = 0;

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

        _joinAll(n, tag);
        (CloseRegistration memory cl, bytes memory clsig) = _closeMsg(n);
        manager.closeRegistration(cl, clsig, _roster());
        _snap(tag, "closeRegistration");

        for (uint256 j = 1; j <= n; ++j) {
            DealCall memory d = _dealMsg(j);
            _sendDeal(d);
            qualBits |= 1 << (j - 1);
            if (j == 1) _snap(tag, "deal_first");
            if (j == 2) _snap(tag, "deal_second");
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

        _open();
        _snap(tag, "openDecryption");

        for (uint256 i = 1; i <= t; ++i) {
            PartialCall memory p = _partialMsg(i);
            _sendPartial(p);
            if (i == 1) _snap(tag, string.concat("submitPartial_", vm.toString(fields), "fields"));
        }
        manager.publishPartialData(requestId, 1, dOf[requestId][1]);
        _snap(tag, "publishPartialData");

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

    /// @dev The permissionless time-based close (Scheduled registration) and both aborts.
    function _runSchedule(uint8 n, uint8 t, string memory tag) internal {
        uint64 deadline = uint64(vm.getBlockTimestamp()) + REG_PERIOD;
        _usePolicy(SCHEDULED, deadline, DEAL_DURATION, SCHEDULED, deadline + DEAL_DURATION + 1, 0);
        _create(t, n);
        _joinAll(n, "");
        vm.warp(deadline);
        _closeScheduled();
        _snap(tag, "closeRegistrationScheduled");
        // a Dealing ceremony below t at its deadline: abort
        vm.warp(deadline + DEAL_DURATION + 1);
        manager.abort(cid);
        _snap(tag, "abort_dealing");

        // a Registration below t at the deadline: abort
        uint64 deadline2 = uint64(vm.getBlockTimestamp()) + REG_PERIOD;
        _usePolicy(SCHEDULED, deadline2, DEAL_DURATION, SCHEDULED, deadline2 + DEAL_DURATION + 1, 0);
        _create(t, n);
        _joinAll(t - 1, "");
        vm.warp(deadline2);
        manager.abort(cid);
        _snap(tag, "abort_registration");
        customPolicy = false;
    }

    function test_Gas_n16_t16() public {
        _run(16, 16, 16, "n16_t16");
        _runSchedule(16, 16, "n16_t16");
    }

    function test_Gas_n5_t3() public {
        _run(5, 3, 16, "n5_t3");
        _runSchedule(5, 3, "n5_t3");
    }

    function test_Gas_n5_t3_oneField() public {
        _run(5, 3, 1, "n5_t3_f1");
    }

    /// @dev Worst-case combine: n members deal, only `set` posts partials for a 16-field request,
    ///      and the combine runs in chunks of 1, 2 and 4 fields over that set.
    function _runSparse(uint8 n, uint8[] memory set, string memory tag) internal {
        customPolicy = false;
        _toLive(n, uint8(set.length));
        _allow(address(this));
        _authorize(creator);
        pid = bytes31(keccak256(bytes(tag)));
        (requestId,,) = manager.bindProcess(cid, pid, creator);
        uint64[] memory plain = new uint64[](16);
        for (uint256 k; k < 16; ++k) {
            plain[k] = uint64(1000 * k + 7);
        }
        _encrypt(plain);
        uint256[4][] memory c = new uint256[4][](16);
        for (uint256 k; k < 16; ++k) {
            c[k] = cts[k];
        }
        manager.submitRequest(cid, pid, c);
        for (uint256 i; i < set.length; ++i) {
            _partial(set[i]);
        }
        uint256 start;
        for (uint256 size = 1; size <= 4; size *= 2) {
            _combine(set, _range(start, size));
            _snap(tag, string.concat("combine_", vm.toString(size), "fields"));
            start += size;
        }
        (bool ready,) = manager.getPlaintexts(requestId);
        assertFalse(ready);
    }

    /// @dev n = 16, t = 15 without member 9: all fifteen λ_i are 246..251 bits (the widest
    ///      t-subset of 1..16; the consecutive 1..16 at t = 16 has eight of a few bits).
    function test_Gas_n16_t15_sparse() public {
        uint8[] memory set = new uint8[](15);
        uint256 j;
        for (uint8 m = 1; m <= 16; ++m) {
            if (m != 9) set[j++] = m;
        }
        _runSparse(16, set, "n16_t15_sparse");
    }

    /// @dev n = 5, t = 3 with members 1, 2, 4: three full-width λ_i (1, 2, 3 has one).
    function test_Gas_n5_t3_sparse() public {
        uint8[] memory set = new uint8[](3);
        (set[0], set[1], set[2]) = (1, 2, 4);
        _runSparse(5, set, "n5_t3_sparse");
    }
}
