# Deployments

| Network | Circuit release | CouncilManager | Deployment block | Status |
|---|---|---|---:|---|
| Sepolia (11155111) | `circuits-v1` (development setup) | [`0x77e4d62f60568d5a315052063115391aac828e6b`](https://sepolia.etherscan.io/address/0x77e4d62f60568d5a315052063115391aac828e6b) | 11,857,219 | **current**; rehearsals only |
| Sepolia (11155111) | `circuits-v1` (development setup) | [`0x57ef5e2bc28fa120f1e5cb6dfe1b096ea06c3070`](https://sepolia.etherscan.io/address/0x57ef5e2bc28fa120f1e5cb6dfe1b096ea06c3070) | 11,856,029 | superseded on 2026-10-06: its affine finalize needs 17.24M gas at `n = t = 16` under Glamsterdam ([below](#superseded-first-deployment)) |
| Gnosis (100) | `circuits-v1` (development setup) | [`0x2f5b110864cbad4017fe8ac59111812278f5f71f`](https://gnosisscan.io/address/0x2f5b110864cbad4017fe8ac59111812278f5f71f) | 48,627,018 | **TEST** deployment on a production chain (`ALLOW_DEV_SETUP=true`); rehearsals and integration tests only ([below](#gnosis-chain-test-deployment)) |

There is no production deployment: `circuits-v1` is a development phase 2 (see
[Circuit release](#circuit-release)), on Sepolia and on Gnosis alike. `scripts/sepolia/deployment.json`
is the machine-readable record of the current Sepolia deployment, which `scripts/sepolia/run.sh`
and the Railway scripts read; `scripts/gnosis/deployment.json` is the record of the Gnosis TEST
deployment, which `scripts/gnosis/run.sh` reads.

The Sepolia deployment has a public app and relayer on Railway
([Hosting on Railway](#hosting-on-railway)):

| Service | URL |
|---|---|
| App | https://council-ui-production.up.railway.app |
| Relayer | https://council-relayer-production.up.railway.app (`/v1/health`) |

## Gnosis Chain (TEST deployment)

> **TEST deployment, development setup.** This manager is bound to `circuits-v1`, whose phase 2
> had one contributor, and was deployed to a production chain with `ALLOW_DEV_SETUP=true`:
> whoever holds that setup's toxic waste can forge dealings and partial decryptions. It is for
> rehearsals and integration tests (the DAVINCI deployment on Gnosis uses it), never for a real
> election. The app shows its "Test setup" banner on every page for it. A production Gnosis
> deployment needs the multi-party ceremony release and a new manager.

Deployed on 2026-10-07 at 01:22 UTC from `0x42fc20654efd78c6887ff0bd1cc50c9ec1dab589` with
`ALLOW_DEV_SETUP=true scripts/gnosis/deploy.sh`, in blocks 48,627,016 to 48,627,018. Gnosis runs
Osaka: no state gas, a 2^24 gas cap per transaction and a 17M block gas limit. The test adapter
followed in block 48,627,036, from a key of its own.

| Contract | Address | EXTCODEHASH | Creation tx | Gas |
|---|---|---|---|---:|
| DealVerifier | [`0xa3484ed88b225f1c613fc7216cbcb822d87414ef`](https://gnosisscan.io/address/0xa3484ed88b225f1c613fc7216cbcb822d87414ef) | `0x11846f7e14acc5efe8e7c97ebc1af97a6fab6350e631aba333715e7cb0cc9c1f` | `0xb663da2f97b1b4095dd5ba23c665cd8be7d73dee5b8d0230ceaa2d1335ff7f1f` | 3,384,996 |
| PartialVerifier | [`0x2bd8729675f9a44b4be79c8d2a4f7128ff3b1e54`](https://gnosisscan.io/address/0x2bd8729675f9a44b4be79c8d2a4f7128ff3b1e54) | `0x8599caa2240444a17eea76d829f019a7e5844a183f469f05effeea41d867a177` | `0x8e884f0e90ab2b2e25d14ea22e5b239423df564506c63162fc9e0959377f4def` | 2,667,240 |
| CouncilManager | [`0x2f5b110864cbad4017fe8ac59111812278f5f71f`](https://gnosisscan.io/address/0x2f5b110864cbad4017fe8ac59111812278f5f71f) | `0x897349a78514ec9e88093c5cd8ae176a406c21007fd6b63b46d0ae663c3d1918` | `0xcb1cdaefe876ec8b53806bdfcf773aa64815284a33d17ffb155858440c957ebc` | 7,625,161 |
| CouncilViews | [`0xb6011a651bb8495a837dd9723e6e1f8fea797fcc`](https://gnosisscan.io/address/0xb6011a651bb8495a837dd9723e6e1f8fea797fcc) | `0xbed9e9837a36be1170260fb963887f1b5dc9344e87c7f9afa4f60a61ed345b86` | created by the manager's constructor (CREATE nonce 1) | – |
| CouncilOps | [`0x0d5bab4c31bf49da98a386588085e354bd644b47`](https://gnosisscan.io/address/0x0d5bab4c31bf49da98a386588085e354bd644b47) | `0x09d25cd5b5eb40f0cf4f7b60b4129bbbd375c218f6c92b459f4c12b13c1f6c80` | created by the manager's constructor (CREATE nonce 2) | – |
| MockCouncilAdapter (**test only**) | [`0x8f39901009c525495f3e69dc250af5dbb0b97fe7`](https://gnosisscan.io/address/0x8f39901009c525495f3e69dc250af5dbb0b97fe7) | `0xe943d2227634721c51604480017c57e86285a7498633bb9b7229fb2c49516d86` | `0x32058001c2c2b9c78b8cf776180bfc20757cc7ccb075e941175ac14e8887c3e3` | 495,808 |

- **Release pins.** `circuitReleaseId()` is
  `0x071a01deb1e9b5e5e1da302df14be234c5ee5b91603d7f0437852dbf1c665301` (`circuits-v1`) and
  `protocolVersion()` is 2. `Deploy.s.sol` checked both verifiers' code hashes against the
  `CouncilRelease.sol` pins before it deployed the manager; `deploy.sh` read them back, with the
  release id and the code of CouncilViews and CouncilOps against the local build. A second check
  read the code hashes, the release id, the protocol version and both verifier addresses at
  finalized block 48,627,909 from publicnode, `rpc.gnosischain.com` and dRPC: all three agreed.
- **Source verification.** All six contracts are verified on Gnosisscan (submitted through the
  Etherscan v2 API, chain 100; gnosisscan.io is now a Blockscout instance, and
  gnosis.blockscout.com redirects to it, so Blockscout reports all six as fully verified too) and
  on Sourcify (exact match: creation and runtime code, runtime only for the two contracts the
  manager's constructor creates).
- **Cost.** 13,677,397 gas for the verifiers and the manager at 15 to 16 wei per gas
  (0.000000000215 xDAI: Gnosis's base fee was 10 to 13 wei), and 495,808 gas for the adapter at
  13 wei. The deployer also funded the relayer's hot key (0.3 xDAI) and the tester key (0.05
  xDAI), 21,000 gas each at 17 wei; it sent nothing else for Council.
- **Test adapter.** `MockCouncilAdapter`, recorded with `"testOnly": true`, is the e2e stand-in
  for DAVINCI's `CouncilAdapter` that lets the rehearsals submit requests on their own. Its
  `registry` is the tester key `0xc6e55867aa3b9128e6dece707324107fc04810de`, the only account that
  can bind processes and submit requests through it. On Gnosis the real requester is the DAVINCI
  ProcessRegistry's `CouncilAdapter`; nothing but the rehearsals uses this one.
- **RPC providers.** The authenticated reads use publicnode (`gnosis-rpc.publicnode.com`, a
  Nethermind node) and `rpc.gnosischain.com`, which answers as Tenderly
  (`web3_clientVersion` is `Tenderly/1.0`), so it is the same provider as
  `gnosis.gateway.tenderly.co` and not a third independent one. dRPC (`gnosis.drpc.org`) is the
  third sending fallback. The three agreed on the finalized block every time they were sampled;
  1rpc.io answered HTTP 503, Ankr needs an API key and Blast is discontinued.

### Rehearsal runs (2026-10-07)

`scripts/gnosis/run.sh` ran every scenario against this deployment with real proofs (snarkjs in
Node) and a relayer it started locally from `main` (with the relayer fixes of 2026-10-07): a
fresh hot key, [`0x23cd4d3c229a142176642329e875d85bb033e0fb`](https://gnosisscan.io/address/0x23cd4d3c229a142176642329e875d85bb033e0fb),
funded with 0.3 xDAI from the deployer and used by nothing else, open admission, scheduler and
combine worker on, a 0.2 xDAI rolling 24 h budget, `COUNCIL_STATE_GAS` unset. Authenticated
reads went to publicnode and `rpc.gnosischain.com`, pinned to the finalized block both agreed on;
every result below was read that way, through the manager and through the adapter, from both
providers. The plaintexts include 0 and the largest value a field can hold, 2^40 − 1.

| Run | Scenario | Ceremony | Result |
|---|---|---|---|
| 1 | A: `n = 3, t = 2`, manual close, manual opening by the organizer | `0x9145f7bea498e7edcab69a62` | passed |
| 1 | B + C: `n = 5, t = 3`, scheduled close and opening, member 5 never deals and decrypts | `0x50c86f2874a8c9ef9c71de34` | passed |
| 1 | E: `n = 3, t = 2`, one dealer by the deadline, aborted by the scheduler | `0x429b5624fb890369fbffeeb1` | passed |
| 1 | D on run 1's A ceremony | `0x9145f7bea498e7edcab69a62` | stopped by a bug in the run script (below), after its first combine had gone through |
| 2 | A again | `0xcb4aa2c05f1471881c435a19` | passed |
| 2 | D: relayer cache dropped (single-block logs), then logs gone (re-publication) | `0xcb4aa2c05f1471881c435a19` | passed |

Run 1 (02:09 to 02:38 UTC) ran A, B and E concurrently, then D. Run 2 (02:40 to 03:18 UTC) ran A
again, then D. Each run is one `scripts/gnosis/run.sh` invocation; its JSON record and Markdown
summary (every transaction, wait and step) stay in `~/.davinci-dkg-council/gnosis/`.

**A: manual phases** (`n = 3, t = 2`). The organizer created the committee (Manual registration
with a 24 h expiry, Manual decryption, no fallback date), three members joined from their invite
links, the organizer closed the list, all three dealt, and the organizer sent finalize ("Finish
the key"). After the adapter and the creator were allowed, the tester bound a process and
submitted four ciphertexts; while the gate was closed, a member's client refused to build a
partial (`the decryption gate is closed`). The organizer's `openDecryption` opened it (a second
one was refused, `AlreadyOpen()`), members 1 and 3 sent their partials through the relayer, and
its worker combined all four fields in one transaction. Plaintexts `[0, 7, 123456789,
1099511627775]` (2^40 − 1) in both runs; also refused as expected: `openDecryption` during
registration (`WrongPhase()`).

| Step | Action | Sent via | Gas used | Run 1 tx | Run 2 tx |
|---|---|---|---:|---|---|
| create | createCeremony (invites=3) | relayer | 160,288 / 160,316 | `0x73ba7665d6fe79f6bbbcd9e0bf4d412a88702732fb065f815dba7c132ba8e8ad` | `0x78a8de37e10d887d4f7ee9814a7d3e0e9dada7ff1e5c30076ec25fb40372f119` |
| join | join (3 members) | relayer | 518,012 to 523,768 | `0xef21694f…`, `0x19f2cc07…`, `0x7b323bf6…` | `0xf61c18d3…`, `0x83f328d6…`, `0xad4dcd22…` |
| close | closeRegistration (n=3) | relayer | 112,581 / 112,555 | `0x57541362b325c0f41710f9c57772fa36ae0c535a49735bd96a68fccbb231217a` | `0x613d4da99bf7bd08d4c65738473b1dc6ac68bcfe4a9a4cf3ac2483d8898f6fcd` |
| deal | deal (n=3, t=2), 3 dealers | relayer | 1,000,674 to 1,059,187 | `0xab92c93d…`, `0x5cdc0814…`, `0xe6f3c56d…` | `0xc3bf62c1…`, `0x9b5baa5e…`, `0xa656847f…` |
| finalize | finalize (\|QUAL\|=3) | relayer | 33,923 | `0x1bb6989b088713e8001457660e63967c23ab50d8f376a49a16df7b51d53b1737` | `0xbc3677f6b6003673e70534f1a949bd819611ebddb8ef6c8e46fa82960453740a` |
| authorize | allowAdapter / authorizeCreator | relayer | 58,629 to 58,804 | `0x5840cfb9…` / `0xd29115d1…` | `0xb28dbf1a…` / `0x0829cd95…` |
| bind | bindProcess | adapter | 196,019 | `0x836818bb9e6fadc1fb51771067ce4a0c267f3855f9886625fc5c644e4a330f09` | `0x7c05e0c73f605e03fc6c60363f72d069226b6fe50c7def5643ce952de9e94685` |
| request | submitRequest (fields=4) | adapter | 1,586,209 | `0x44c8b6090911c595402cda7cf6a3531ac57f890b30c226d95feec88e987b6ac5` | `0x75663a1b0d133236eee6a6de63aaec678e06c7bd8433a6492d212f1da02a9451` |
| open | openDecryption | relayer | 58,201 / 58,189 | `0x8893ee1e95ea2b1fe575f121244eef962377445cb992376ab5f2742dab2b17a5` | `0x7c44acc99e7e1880476bd01a43022e6de6cc69dd50a44afad40facd3a1a1ff95` |
| partials | submitPartial (members 1, 3; fields=4) | relayer | 807,811 to 823,766 | `0x9b05b136…`, `0x6f8d364c…` | `0x38f11763…`, `0x0659f732…` |
| combine | combine (t=2, fields=4) | relayer (worker) | 1,659,634 | `0x8714db218f436e63399cfc38496c70a137edde962c278b73a5880d5599cdfb6f` | `0x464482eee49724c7024959f88948d549052966a6600e9fa49467e8137be0daf6` |
| **total** | | | **10.18M** | ceremony `0x9145f7bea498e7edcab69a62`, request `0xef0ebf02ea6afa26bc81206eac2b774cf6d74d17dab6bf5dc63d1c53d42194d0` | ceremony `0xcb4aa2c05f1471881c435a19`, request `0x284386794f8a36c7dfca79dcece41334368cd54c11973288ce6033cace4faa27` |

**B + C: scheduled phases, a member who never dealt decrypts** (`n = 5, t = 3`, ceremony
`0x50c86f2874a8c9ef9c71de34`). Created with Scheduled registration (closing at 02:14:30, five
minutes out), a 600 s dealing phase and Scheduled decryption opening at 02:27:30, three minutes
past the earliest possible end of dealing. Before the deadline the organizer's close was refused
(`WrongMode()`) and so was the time-based close (`RegistrationNotDue()`). Nobody called anything
after that: the relayer's scheduler sent `closeRegistrationScheduled` 15 s after the deadline
(it judges the close at the head), members 1 to 4 dealt, an early finalize was refused
(`FinalizeConditionNotMet()`, `|QUAL| = 4 < n`), and the scheduler finalized 15 s after the
dealing deadline (QUAL `0b01111`). The request was submitted before the opening date, and
`openDecryption` was refused (`WrongMode()`). The gate then opened by predicate alone, with no
transaction and no `DecryptionOpened` event: the finalized block of 02:26:20 still showed it
closed, and the first finalized block past the opening date (10 s past it) showed it open, 171 s
after the date. Member 5, which never dealt, recovered its share from chain state and sent its
partial through the relayer, member 2 through the relayer, member 4 directly from the tester key;
the worker combined with member set `[2, 4, 5]` (member 4's vector from a single-block log read,
the other two from its cache). Plaintexts `[0, 1000000007, 1099511627774]`, request
`0xdb6b45cba17a671a11d9242764bb4f4f327144d3417476ddff4bb7e9ce5c2532`.

| Step | Action | Sent via | Gas used | Tx |
|---|---|---|---:|---|
| create | createCeremony (invites=5, scheduled) | relayer | 228,347 | `0xc55aba51cdb1d81c01d7d991a2d68698a7e38a2c7648ff247af75743cc55dd08` |
| join | join (5 members) | relayer | 516,740 to 521,820 | `0x6dbe3e31…`, `0x01aa047e…`, `0x26a9930a…`, `0x3644823c…`, `0x6c46e8e0…` |
| close | closeRegistrationScheduled (n=5) | relayer (scheduler) | 118,636 | `0x34983b015c9a4ae598069cb7a5735d5b58dce8975bea585ddcc4668b753d324d` |
| deal | deal (n=5, t=3), members 1 to 4 | relayer | 1,067,771 to 1,158,186 | `0x490cd0f5…`, `0x9862cf4b…`, `0x74513fd6…`, `0x3327fa58…` |
| finalize | finalize (\|QUAL\|=4) | relayer (scheduler) | 36,243 | `0x4fb4a3b6bfe8595140cbc62b7883299e9e3fe7317f7a72e6d80096d969e15aa5` |
| authorize | allowAdapter / authorizeCreator | relayer | 58,629 / 58,804 | `0x28052a0a…` / `0x261f3b0f…` |
| bind | bindProcess | adapter | 196,007 | `0x6cb40492a25039fb4c2464510e1787168f78ca7238673cae0bafb59daed1e72a` |
| request | submitRequest (fields=3) | adapter | 1,200,362 | `0x03d918c37f087fffedd8060b8f6d6afdb9a98b09fee6e7665446c915ff417b88` |
| partials | submitPartial (member 5, never dealt) | relayer | 828,438 | `0x2534c0f556bb065d3ea048e5ac98eabc7b4b80c14f1d1b7f955cef329ed06c25` |
| partials | submitPartial (member 2) | relayer | 826,436 | `0xd2e762930c511f939358ffb8c870ab823015500dbcbf34cea294b9a32b233186` |
| partials | submitPartial (member 4) | direct | 810,258 | `0x4d5cc666e2d0bb2071ff4272af45369425e0c1ca8325a663392ee57c315787c9` |
| combine | combine (t=3, fields=3) | relayer (worker) | 1,794,495 | `0x45e70fc577e60f920a72ef13cb93d2f46f7f9e1e82404be35c95012973943ee2` |
| **total** | | | **13.12M** | |

**D: partial-data sourcing** (on run 2's A ceremony, `0xcb4aa2c05f1471881c435a19`). Two requests,
each with the relayer restarted with its combine worker off while two members sent their partials
through it, then stopped, its cache file for the request deleted, and restarted with the worker
on:

- D1 (request `0xd5a89da2eeb03217a2c3222164eff594b42fb347d87c003bfa2a1560b19a3dc4`, members 2
  and 3): with no cached vector, the worker made exactly two `PartialDataPublished` log reads,
  each over the one block stored as that member's publication block (48,628,241 and 48,628,248),
  none over a range, and combined 16 s after the restart. Plaintexts `[0, 1099511627775, 42]`.
- D2 (request `0xdcebb21e0b5281e994313775c66161dc47f0ce22939735130c549d9eb08c1b84`, members 1
  and 2): the relayer's RPC proxy also answered those single-block reads with no logs, as a
  provider that pruned them would. The worker reported both members missing and waited
  (`combine waiting for partial data re-publication`). Both members recomputed `D` from their
  recovered shares and re-published through the relayer, which sponsored it because it could not
  source the data itself; their publication blocks moved from 48,628,336 / 48,628,338 to
  48,628,344 / 48,628,346. A third re-publication was refused (`NOT_SPONSORED: this relayer
  holds member 1's partial data`). The worker combined from the re-published vectors. Plaintexts
  `[9, 0, 549755813893]`.

| Step | Action | Sent via | Gas used | Tx |
|---|---|---|---:|---|
| D1 bind / request | bindProcess / submitRequest (fields=3) | adapter | 178,919 / 1,200,338 | `0x16c57563…` / `0x94d4f465…` |
| D1 partials | submitPartial (members 2, 3) | relayer (worker off) | 819,790 / 803,236 | `0x58def999…`, `0x3eda966c…` |
| D1 combine | combine (t=2, fields=3), vectors from single-block logs | relayer (worker) | 806,376 | `0x610fc13bdc392c8d3446aef5c6d8054ad9289dc17618cf32377e01528505159f` |
| D2 bind / request | bindProcess / submitRequest (fields=3) | adapter | 178,919 / 1,200,326 | `0x213b24e5…` / `0xdfaeb51f…` |
| D2 partials | submitPartial (members 1, 2) | relayer (worker off) | 819,127 / 802,686 | `0x981dbc15…`, `0x6951657b…` |
| D2 republish | publishPartialData (member 1) | relayer | 63,990 | `0x357da627280db71a35b19cdb6bc6c8f15a600d2a76d043a706b1b53c5670e08e` |
| D2 republish | publishPartialData (member 2) | relayer | 63,990 | `0x559c2521d91585aa0322f81c088dba3f878d5fe638230fd11267a5ac09083294` |
| D2 combine | combine (t=2, fields=3), re-published vectors | relayer (worker) | 790,230 | `0x915ae9e2a575213c01e55486135d63dae45310996712cb3fb1208100a11b1c59` |
| **total** | | | **7.73M** | |

Run 1's D had stopped at its first check: it read the members' publication blocks at the
finalized block while their partials were two blocks old, found none, and failed, after the worker
had made the same two single-block reads (at 48,627,894 and 48,627,896) and combined
(`0xa7279603767312734a746a3b06d27daf7612b61c7aaec8f354124b4a0bc0bb8e`). The script now reads those
blocks at the head.

**E: fewer than `t` dealers by the deadline** (`n = 3, t = 2`, ceremony
`0x429b5624fb890369fbffeeb1`, a 600 s dealing phase). Three members joined, the organizer
closed, and only member 1 dealt. Before the dealing deadline finalize (`FinalizeConditionNotMet()`)
and abort (`AbortConditionNotMet()`) were refused. The scheduler aborted 190 s after the deadline:
it judges an abort at the finalized block's timestamp, so it trails the deadline by the finality
lag. A dealing sent after that was refused (`WrongPhase()`), and the finalized state shows phase
`Aborted` with QUAL `0b001` (the accepted dealing stays).

| Step | Action | Sent via | Gas used | Tx |
|---|---|---|---:|---|
| create | createCeremony (invites=3) | relayer | 160,316 | `0x97bab0cbc7ce0e620d5280b92b0c33b4328b8ccc897edefb23459ca80bf2493d` |
| join | join (3 members) | relayer | 518,036 to 521,713 | `0xa01430ca…`, `0x03726010…`, `0xbf2fb94a…` |
| close | closeRegistration (n=3) | relayer | 112,567 | `0x753944ceaa52727a7a8b8160b1b349f901f59e47b1cec008ffc003ba598bbb82` |
| deal | deal (n=3, t=2), member 1 only | relayer | 1,059,251 | `0xa91703d6c95b98c6faeb0b0702a1058cfedf829e86a0b35a2b5206d22f79b72e` |
| abort | abort (in Dealing, \|QUAL\| < t) | relayer (scheduler) | 34,061 | `0x09a3e040117b53db6dfc4887da1f0fc74bc7585d85520ec91d47b8c0a137a025` |
| **total** | | | **2.93M** | |

**Cost.** The two runs sent 78 transactions, 47.94M gas, for 0.0000079 xDAI. Gnosis's base fee
was 10 to 13 wei at the deployment, rose to about 370,000 wei around block 48,627,560 (a burst of
full blocks) and fell back to a few hundred wei; the runs paid 28 wei to 2.27M wei per gas (at
most 0.0000023 gwei). The relayer's key spent 0.0000083 xDAI of its 0.3 (its 0.2 xDAI budget was
never close), the tester key 0.00000036 xDAI with the adapter's deployment, and the deployer
0.00000000022 xDAI on gas plus the 0.35 xDAI it moved to the two keys, which still hold it. At
these prices the 0.2 xDAI daily budget is not a constraint; a base fee back at 1 gwei would make
the same two runs about 0.048 xDAI.

| Action | Count | Gas used |
|---|---:|---:|
| createCeremony (invites=3 / 5, scheduled) | 3 / 1 | 160,288 to 160,316 / 228,347 |
| join | 14 | 516,740 to 523,768 |
| closeRegistration (n=3) / closeRegistrationScheduled (n=5) | 3 / 1 | 112,555 to 112,581 / 118,636 |
| deal (n=3, t=2) / (n=5, t=3) | 7 / 4 | 1,000,674 to 1,059,251 / 1,067,771 to 1,158,186 |
| finalize (\|QUAL\|=3 / 4) | 2 / 1 | 33,923 / 36,243 |
| abort (in Dealing) | 1 | 34,061 |
| allowAdapter / authorizeCreator | 3 / 3 | 58,629 to 58,655 / 58,778 to 58,804 |
| openDecryption | 2 | 58,189 to 58,201 |
| bindProcess (adapter) | 6 | 178,919 to 196,019 |
| submitRequest (adapter, fields=3 / 4) | 4 / 2 | 1,200,326 to 1,200,362 / 1,586,209 |
| submitPartial (fields=3 / 4) | 9 / 4 | 802,686 to 828,438 / 807,811 to 823,766 |
| publishPartialData (fields=3) | 2 | 63,990 |
| combine (t=2, fields=3 / 4) | 3 / 2 | 790,230 to 806,412 / 1,659,634 |
| combine (t=3, fields=3) | 1 | 1,794,495 |

Gas is within 0.5% of the same script's runs on a local Anvil (Osaka).

**Timings.** Gnosis's finalized head moves in 16-block (80 s) steps, 32 to 47 blocks behind the
head: from a transaction's block to the moment both providers reported it finalized took 2.8 to
4.0 min (median 3.4 min over 21 waits), against 11 to 18 min on Sepolia. Every authenticated step
waits for that once. A relayed action took 4.4 to 50 s from the request to its receipt (median
13.5 s over 56; 24 within 10 s, 21 over 20 s). Inclusion took one or two 5 s blocks; the slow
ones spent 20 to 30 s inside the relayer before it broadcast (simulation, estimate and its one-key
send queue, which the scheduler, the combine worker and the transaction monitor share), in run 2
as well, where only one ceremony was active; the cause was not isolated. Proving on this host: a dealing 1.9 to 2.6 s, a partial
(share recovery from finalized state included) 1.7 to 2.0 s. A runs in about 22 min, of which 17
are five finality waits (the organizer's close waits for the joins to be finalized, since its
action carries the roster keys read from finalized state); B in 25 min, bounded by its schedule
(5 min registration, 10 min dealing, the opening 3 min later); E in 22 min; D in 16 min.

**Observations.**

- A DAVINCI request on this manager (`0x3cc882790761798d53c385aeb5498487d3e277e895c529e41aa2b112e72ce75f`,
  submitted through the DAVINCI `ProcessRegistry` at `0x847a16cc56e0ef57fec28735105941a0299cdc62`)
  was also picked up by this open relayer's worker, which lost the race to another combiner in
  block 48,627,686: its combine reverted after 69,290 gas
  (`0x5b452ecaad12bb1e64c8eb749ceefb520a3bcbd7cdc34689cb0101967974afce`). Simulation cannot see a
  competing combine in the same block; the cost is one early revert. An open relayer combines
  every request on its manager.
- The relayer logged `fee bump rejected, rebroadcasting` and `rebroadcast failed` (`nonce too
  low`) once per run: it bumped a transaction that had been mined before its receipt was visible.
  Harmless.
- `rpc.gnosischain.com` refuses `eth_getProof` beyond a recent window (`distance to target block
  exceeds maximum proof window`), so `cast codehash --block` fails there; `eth_getCode` works.

## Sepolia

Deployed on 2026-10-06 from `0x951163cefc22ce67f6d8b95b00a0074c4656df42` with
`scripts/sepolia/deploy.sh`, in blocks 11,857,219 and 11,857,220, under Glamsterdam. The manager
carries the finalize that works in extended coordinates with one inversion (`n = t = 16`: 9.05M
gas instead of 17.24M); the two verifiers of the [first deployment](#superseded-first-deployment)
are reused (`DEAL_VERIFIER`, `PARTIAL_VERIFIER`), since their code hashes are still the
`CouncilRelease.sol` pins.

| Contract | Address | EXTCODEHASH | Creation tx | Gas |
|---|---|---|---|---:|
| DealVerifier (reused) | [`0x79577ec86de4ee262867ca3297a0a7c0b58792c8`](https://sepolia.etherscan.io/address/0x79577ec86de4ee262867ca3297a0a7c0b58792c8) | `0x11846f7e14acc5efe8e7c97ebc1af97a6fab6350e631aba333715e7cb0cc9c1f` | `0x5f8ecad2d1d43f945f5a88962c2ad7e40702bab0c0fe858065abc5ce50c52fe3` | 3,384,996 |
| PartialVerifier (reused) | [`0x50501fc7275742f3a52d84adcf8d0097ef0a4b40`](https://sepolia.etherscan.io/address/0x50501fc7275742f3a52d84adcf8d0097ef0a4b40) | `0x8599caa2240444a17eea76d829f019a7e5844a183f469f05effeea41d867a177` | `0x08bb6f3456ae710582a29a0edabedcb58fdd628bb16b714575be1f255bf2b576` | 2,667,240 |
| CouncilManager | [`0x77e4d62f60568d5a315052063115391aac828e6b`](https://sepolia.etherscan.io/address/0x77e4d62f60568d5a315052063115391aac828e6b) | `0xb7d2d76b91253c3b3aac75c2e103898a13d2386220cea8aa9ccc4d3abd694699` | `0xc1cd17c1d23fd874eae9450a0d9eac22e163b028fe26d35fa0349663b47501c8` | 41,116,466 |
| CouncilViews | [`0xb6d71f96717b5122d84c579db9ca504e4581854e`](https://sepolia.etherscan.io/address/0xb6d71f96717b5122d84c579db9ca504e4581854e) | `0xd34e405b901a9d02e66da91a5485ef0fd47f6f5c336a24225e68f645bd6d55e5` | created by the manager's constructor (same tx) | – |
| MockCouncilAdapter | [`0x09762039a3650fa5f5d48d7043ad93562dbd92a5`](https://sepolia.etherscan.io/address/0x09762039a3650fa5f5d48d7043ad93562dbd92a5) | `0xe0d2bea14a96153080b20c485f902fed152876227b5adbb65b831f21799850d3` | `0xc4114d788ef851b2c5af4d19ab29c1df8e09f64177ed7dbc885f0a12b53e1895` | 3,341,067 |

- **Release pins.** The manager's `circuitReleaseId()` is
  `0x071a01deb1e9b5e5e1da302df14be234c5ee5b91603d7f0437852dbf1c665301`. `Deploy.s.sol` checked
  both reused verifiers' code hashes against the `CouncilRelease.sol` pins before it deployed the
  manager, and `deploy.sh` read them back from the chain afterwards.
- **Source verification.** The manager is verified on Etherscan; the views and the test adapter
  show there as similar matches of the same contracts of the first deployment. Sourcify has
  an exact match (creation and runtime code) of all three; the verifiers were verified with the
  first deployment.
- **Cost.** 44,457,533 gas, 0.047487 ETH at 1.06 to 1.13 gwei. Glamsterdam charges deployed code
  as state gas (EIP-8037, 1,530 gas per byte): the manager's and the views' 26,324 bytes alone are
  40.3M of the manager's 41.1M. Deploying the two verifiers as well would add about 48M, which is
  why they were reused. Forge's local simulation does not price state gas, so `deploy.sh` takes
  its gas limits from the RPC's `eth_estimateGas` (`--skip-simulation`); this run also capped the
  fee at 1.7 gwei with a 10% gas margin (`FORGE_SCRIPT_ARGS="--with-gas-price 1.7gwei -g 110"`) so
  the deployer's 0.084 ETH covered the worst case.
- **Test adapter.** `MockCouncilAdapter` is the e2e stand-in for DAVINCI's `CouncilAdapter`. Its
  `registry` is the deployer, the only account that can bind processes and submit decryption
  requests through it. It is a rehearsal requester, not a DAVINCI integration.

### Rehearsal ceremony on the current manager (2026-10-06)

The ceremony script (`scripts/sepolia/ceremony.sepolia.ts`, as `run.sh` launches it) passed all
12 checks against this deployment: `n = 3, t = 2`, real proofs (snarkjs in Node), every signed
action except one partial sent through the **public Railway relayer** (open mode, its combine
worker on), so its hot key paid them; the deployer was the adapter's registry (bind, request)
and funded the throwaway key of the direct partial. Authenticated reads went to publicnode and
Tenderly, pinned to the finalized block both agreed on.

| | |
|---|---|
| Ceremony | `0x93a546f5aa4caf723a4f5d67` |
| Process (test adapter) | `0x9b806c874c718199d9e2179a4eda2b93df6058edeec2054b01513879326208` |
| Request | `0xed305e3f1d3d7c573d2367f7dbad513f4a0458fc12ae07bb9260bd67bb7ddc20` |
| Ceremony key | `(11025900677309699712186952944891124199856606496303082980562743788913815237165, 18051147959958640529905911198816814632186782067004490707174814899722007429429)` |
| Plaintexts | `[0, 1, 123456789, 1099511627773]`, read from finalized state through both the manager and the adapter |
| Member set | `[1, 3]`: member 1 sent its partial directly from a throwaway key, member 3 through the relayer, and the relayer's worker combined all four fields in one transaction |

| Step | Action | Sent via | Gas used | Gas price (gwei) | Tx |
|---|---|---|---:|---:|---|
| create | createCeremony (invites=3) | relayer | 587,556 | 1.038 | `0x5f2d4624f768673748e4047cba42a19a6c59089e2ee13da62e556b0c50313b13` |
| join | join (3 members) | relayer | 989,099 to 992,872 | 1.002 to 1.081 | `0x9964bc3d…`, `0x434692c4…`, `0x51bd906e…` |
| close | closeRegistration (n=3) | relayer | 294,999 | 1.066 | `0xb7c9a315cd1c292170790b4b75780dea309385277b527424f38688d648fa86a7` |
| deal | deal (n=3, t=2), 3 dealers | relayer | 1,874,334 to 1,874,386 | 1.024 to 1.086 | `0x858ff7f2…`, `0x55b067c6…`, `0x991d306f…` |
| finalize | finalize (\|QUAL\|=3) | relayer | 1,184,369 | 1.069 | `0x0b51c04e8ff20ec7405137dce62cf0a379ebec0a2f4d921e5aba58cda1ad75cb` |
| authorize | allowAdapter / authorizeCreator | relayer | 137,990 / 138,228 | 0.985 / 1.015 | `0x9dc4d1b5…`, `0x08130dcc…` |
| bind | bindProcess | adapter | 806,336 | 1.073 | `0x46a86dce05c520ae14b6a66f52fcfd3c3d9f3c54328d8efc0d22b270b82e70fa` |
| request | submitRequest (fields=4) | adapter | 3,170,653 | 1.023 | `0x12897de06c95af407830136842f880712e993331707119082d0a7b9760eedff3` |
| partials | fund the throwaway key (0.004 ETH) | transfer | 204,600 | 1.056 | `0x72b66b7980d12c7868c9501d7ac22fe77b689529a11516d0fe1eb6eba4a8563c` |
| partials | submitPartial (member 1, fields=4) | direct | 1,629,203 | 1.111 | `0x0bdd9aa9dea41d50225ebe26ecf8073e3140df4babeec8f2e8fc1298aa72f533` |
| partials | submitPartial (member 3, fields=4) | relayer | 1,629,207 | 1.030 | `0x25b02ec8bf0db123f57b38f0a950cb6e4061e393de00736799892f02196cab54` |
| combine | combine (t=2, fields=4) | relayer (worker) | 1,746,569 | 1.049 | `0xc77b4fcce195605b896ecad171cc06e81cfc6c4f44ad76c51fe249649b443ca0` |
| cleanup | sweep the throwaway key back | transfer | 21,000 | 1.097 | `0x6c4ac01d065604fb24eed285e92266bfc0e26038973bb644563b5faa8c1fcdb5` |
| **total** | | | **20,146,790** | | 0.021204 ETH |

Under Glamsterdam the same ceremony costs 1.8 times the [first rehearsal](#rehearsal-ceremony-2026-10-06)'s
gas (11.14M), almost all of it state gas for new storage slots; finalize, whose state gas is
`2t + 2n` = 10 slots here, is 1.18M (395,138 before the fork, on the affine manager). The relayer
paid 14.31M gas, 0.015047 ETH; without the adapter's two calls and the two transfers, the ceremony
and its decryption took 15.94M gas. The deployer spent 0.006161 ETH (bind, request and the
throwaway's funding net of its sweep). The run took 69.0 min, 63.4 of them four finality waits
(11.1 to 18.1 min each); each action took 6.5 to 37.4 s from request to receipt. The throwaway
key's first partial attempt saw no balance for about 30 s after its funding landed (one provider
behind the other) and went through on the third try.

## Superseded: first deployment

The first Sepolia deployment, superseded on 2026-10-06 by the one above. Its contracts stay on
chain and keep working, but the app, the relayer and `scripts/sepolia/deployment.json` no longer
point at them: under Glamsterdam its affine finalize needs 17.24M gas at `n = t = 16` (10.97M
execution + 6.27M state), and a relayer that clamps gas limits at 2^24 cannot send it.

Deployed on 2026-10-06 from `0x951163cefc22ce67f6d8b95b00a0074c4656df42` with
`scripts/sepolia/deploy.sh`, in blocks 11,856,027 to 11,856,030 (Osaka).

| Contract | Address | EXTCODEHASH | Creation tx | Gas |
|---|---|---|---|---:|
| DealVerifier | [`0x79577ec86de4ee262867ca3297a0a7c0b58792c8`](https://sepolia.etherscan.io/address/0x79577ec86de4ee262867ca3297a0a7c0b58792c8) | `0x11846f7e14acc5efe8e7c97ebc1af97a6fab6350e631aba333715e7cb0cc9c1f` | `0x5f8ecad2d1d43f945f5a88962c2ad7e40702bab0c0fe858065abc5ce50c52fe3` | 3,384,996 |
| PartialVerifier | [`0x50501fc7275742f3a52d84adcf8d0097ef0a4b40`](https://sepolia.etherscan.io/address/0x50501fc7275742f3a52d84adcf8d0097ef0a4b40) | `0x8599caa2240444a17eea76d829f019a7e5844a183f469f05effeea41d867a177` | `0x08bb6f3456ae710582a29a0edabedcb58fdd628bb16b714575be1f255bf2b576` | 2,667,240 |
| CouncilManager | [`0x57ef5e2bc28fa120f1e5cb6dfe1b096ea06c3070`](https://sepolia.etherscan.io/address/0x57ef5e2bc28fa120f1e5cb6dfe1b096ea06c3070) | `0x4da37b74b2b734457cd9f44138e8bff3f0f5d5df85179acebee5c6c94b81e63e` | `0x07f6c19143910276dd7f7f976ecd056f1b27ea10a205cd08183c32d010cb6675` | 5,572,333 |
| CouncilViews | [`0x83e192139d96c2dbf9fd4c174088aab26c6a2497`](https://sepolia.etherscan.io/address/0x83e192139d96c2dbf9fd4c174088aab26c6a2497) | `0xd34e405b901a9d02e66da91a5485ef0fd47f6f5c336a24225e68f645bd6d55e5` | created by the manager's constructor (same tx) | – |
| MockCouncilAdapter | [`0x7d439940a257fe415e4e488b49428c2e457fe34f`](https://sepolia.etherscan.io/address/0x7d439940a257fe415e4e488b49428c2e457fe34f) | `0xd862822c66c29d5d9babde9d61899f4bf6619426d34490386092e29dc4083fce` | `0x6846723894023ac306ba58b64a1e4cc2b198412608754818e93300d3fe659b9d` | 491,503 |

- **Release pins.** The manager's `circuitReleaseId()` is
  `0x071a01deb1e9b5e5e1da302df14be234c5ee5b91603d7f0437852dbf1c665301`, and both verifier code
  hashes equal the `CouncilRelease.sol` pins: `Deploy.s.sol` checked them before it deployed the
  manager, `deploy.sh` re-read them from publicnode after the deployment, and a second read from
  Tenderly agreed.
- **Source verification.** All five contracts are verified on Etherscan and on Sourcify (exact
  match, creation and runtime code); `forge verify-contract` submits to both.
- **Cost.** 12,116,072 gas, 0.012715 ETH at 0.96 to 1.10 gwei. The script took 2.1 min,
  verifications included.
- **Test adapter.** Same contract as above, bound to this manager.

### Rehearsal ceremony (2026-10-06)

The first `scripts/sepolia/run.sh` run passed all 12 checks. It used `n = 3, t = 2` and real
proofs (snarkjs in Node). The relayer ran locally in restricted mode, with a fresh API token
admitting `createCeremony`, a 0.03 ETH daily budget and its combine worker on. Authenticated reads
went to publicnode and Tenderly, pinned to the finalized block both agreed on.

| | |
|---|---|
| Ceremony | `0xe153bd9c9ac5ce6c95002a5f` |
| Process (test adapter) | `0xaaad7d84a8c0dbe73b13957d3d462374e85e2189f2957d9edf89290841b13f` |
| Request | `0xde4fd2f19f515650b18f7af0533a6d9a4c480b244168803c67409c7b46f9320a` |
| Ceremony key | `(6568588267388220366580367503688589822999969568404003529377959184714020094361, 4425131503111865310986011517196740002656603924599369180808332437202263545280)` |
| Plaintexts | `[0, 1, 123456789, 1099511627773]` (the last one is 2^40 − 3): the encrypted values, read from finalized state through both the manager and the adapter |
| Member set | `[1, 3]`. Member 1 sent its partial directly from a funded throwaway key, member 3 through the relayer, and the relayer's worker combined all four fields in one transaction |

| Step | Action | Sent via | Gas used | Gas price (gwei) | Tx |
|---|---|---|---:|---:|---|
| create | createCeremony (invites=3) | relayer | 153,444 | 1.017 | `0x8d825d49e9ed25dd66ee51c05d64bc7c7e138d4061f3d39cd90e4a3c43fdce88` |
| join | join (member 1) | relayer | 542,705 | 1.107 | `0x7a3034a1995562996aad4928ce77832ea58743dc4a4290c7813b5b6b308529e6` |
| join | join (member 2) | relayer | 541,958 | 1.045 | `0xa5fc8dba6a9229ad875c8fb23fba24297843c7f3c60f8a993601c6f8a38bbcd0` |
| join | join (member 3) | relayer | 542,665 | 1.005 | `0xbe0ca0fcbc45ab6fc3139e3e893cd6de25acd9b61751965988013735b8f5ca98` |
| close | closeRegistration (n=3) | relayer | 110,747 | 1.080 | `0x9cdfbb500bf55e7a81d54fb46d1c44041e954ea0588fa3051cdfe2a6e9eecb77` |
| deal | deal (n=3, t=2) | relayer | 1,080,566 | 1.124 | `0x8fba4d6d55119c66983cdc6be87face3511a0a2e19c2c91f35a82898b5ef3aa7` |
| deal | deal (n=3, t=2) | relayer | 1,080,606 | 1.105 | `0xe38fac50aa9ee8a7e814127960d2404a17e38c2e89f3bb36123a809c99489218` |
| deal | deal (n=3, t=2) | relayer | 1,080,570 | 1.007 | `0x9c7bdccedc05be095278fe8f18d1454f4c4582693e99f27fba6858425c94b0a1` |
| finalize | finalize (\|QUAL\|=3) | relayer | 395,138 | 1.052 | `0xd216e745d8693f4567d0671152eacab1b2e268edbc6731c4d3e54e477ab0eca7` |
| authorize | allowAdapter | relayer | 55,986 | 1.009 | `0x5c6b5d158d4c9b620d7835612b13356e1a7d932ab09f8a5783f7484f37bfa87c` |
| authorize | authorizeCreator | relayer | 56,220 | 1.069 | `0xb925252ad3b9a20ab5c4c94e4e362ef9473f4c251be3e6b82309d94eca5a8e75` |
| bind | bindProcess | adapter | 195,984 | 1.019 | `0xdf8e1b7bc2f8a9780debbec7996558e70b8138ebe76f58f8934e0e01e310a712` |
| request | submitRequest (fields=4) | adapter | 1,762,077 | 1.057 | `0x8dc66e541f8d7584d93019a6e1976be2b7b1a08dd05b0472b17ec8674f2e4189` |
| partials | fund the throwaway key (0.003 ETH) | transfer | 21,000 | 0.942 | `0xc97fd704f56d31bff0c492b1707e19bef93b6a5132b6f1cb30a9dcaaec3cb002` |
| partials | submitPartial (member 1, fields=4) | direct | 923,483 | 1.060 | `0x6169d67c82c38ca86f74e928640e699ac1e8b9039303500ee5d8dc24a9e5737e` |
| partials | submitPartial (member 3, fields=4) | relayer | 923,419 | 1.113 | `0x8da77964e1637aa96e4412ca4e9dfdc706d3596c88900cecc73589261b18a4b0` |
| combine | combine (t=2, fields=4) | relayer (worker) | 1,656,305 | 1.087 | `0xcdf21ddad5dd3bd8b592977555af017a1fef2bd9dd339bfc58d08d7dcc86c8bc` |
| cleanup | sweep the throwaway key back | transfer | 21,000 | 1.113 | `0x1bf7007741597fc89bcaa325fc771bbf101141526d8cbd608547abacf2d7cf16` |
| **total** | | | **11,143,873** | | |

Gas is within 1% of the Anvil measurements in `tests/GAS.md`. Without the adapter's two calls
and the two transfers, the ceremony and its decryption took 9.14M gas, the figure
[relayer.md](relayer.md#sizing-the-budget) budgets for. The key spent 0.011934 ETH. That figure
includes the throwaway's funding net of its sweep; 0.0000043 ETH of dust stayed on the throwaway
key.

| Step | Duration | Of which finality wait |
|---|---:|---:|
| preflight (deployment block finalized, release pin, relayer health) | 14.6 min | 14.6 min |
| create | 12.6 s | |
| join (3 members) | 49.7 s | |
| close | 18.5 s | |
| roster approval | 17.6 min | 17.6 min |
| deal (3 proofs, 1.8 to 2.8 s each) | 38.0 s | |
| finalize | 24.7 s | |
| authorize (adapter + creator) | 37.0 s | |
| bind + request | 37.4 s | |
| partials (2 proofs, 2.2 to 2.5 s each) | 18.0 min | 17.1 min |
| combine (relayer worker) | 36.5 s | |
| result | 17.6 min | 17.6 min |
| **total** | **72.4 min** | **66.9 min** |

A relayed action took 6.5 to 24.8 s from request to receipt (one or two slots). Every
authenticated read waits for the last write to be finalized, which took 14.6 to 17.6 min each
time. Sepolia finalizes in 32-slot steps about two epochs behind the head. The relayer logged two
warnings, both harmless:

- `hot key used outside the relayer`. The run's key is also the adapter's registry and the
  throwaway's funder, so the bind, request and funding moved its nonce three times. The relayer
  resynced and sent the next action on the first attempt.
- One `combiner tick failed` (`Invalid parameters`), a transient `eth_getLogs` refusal 37 s after
  the request landed: a backend behind the head (see [the smoke test](#smoke-test-2026-10-06)).
  The scan cursor only advances after a complete pass, so the next tick found the request.

## Circuit release

Every deployment is bound to one circuit release (protocol §4.4): the manager's immutable
`circuitReleaseId` and the code of its two verifiers. The current pins, from
`solidity/script/CouncilRelease.sol`:

> **Development setup.** `circuits-v1` is a development phase 2 (one local snarkjs contribution
> plus a beacon, `DEVELOPMENT_SETUP = true`): anyone holding its toxic waste could forge dealings
> and partials. Deploy it for rehearsals only, never for a real election. A production deployment
> needs a multi-party phase 2, which is a new release and a new manager; the ceremony tooling is
> being added under `circuits/scripts/ceremony/`.

| Pin | Value |
|---|---|
| circuit release | `circuits-v1` (development setup) |
| `circuitReleaseId` | `0x071a01deb1e9b5e5e1da302df14be234c5ee5b91603d7f0437852dbf1c665301` |
| sha256(`deal_vkey.json`) | `0x329f3456ac194bf8f7e07974b7f782a8bcc797e2ce37e46dc357dd3dbd442444` |
| sha256(`partial_vkey.json`) | `0xae15a6c0ab9dfe26756aef8af8d7766c8d462bbeefae0847f513a2d317ad1991` |
| DealVerifier EXTCODEHASH | `0x11846f7e14acc5efe8e7c97ebc1af97a6fab6350e631aba333715e7cb0cc9c1f` |
| PartialVerifier EXTCODEHASH | `0x8599caa2240444a17eea76d829f019a7e5844a183f469f05effeea41d867a177` |

The verifier code hashes hold for the committed `solidity/foundry.toml` (solc 0.8.28, via_ir,
`optimizer_runs = 1`, `evm_version = "cancun"`); another compiler setting is another hash, and
the deploy script refuses it. The circuit files themselves (`deal.wasm`, `partial.wasm`, both
`*_final.zkey`, both vkeys) are the `circuits-v1` GitHub release; the SDK pins their sha256 in
`sdk/src/artifacts.ts`.

## Deploying

`scripts/sepolia/deploy.sh` (`make sepolia-deploy`) deploys the two generated verifiers and the
`CouncilManager` through `solidity/script/Deploy.s.sol`, then the e2e test adapter
(`MockCouncilAdapter`, a stand-in for a DAVINCI process registry in rehearsals, whose `registry`
is the deployer), re-checks the deployment from chain state and writes
`scripts/sepolia/deployment.json`. It needs the host Foundry (`~/.foundry/bin`), `jq`, Node 22,
the workspace installed (`make install`) and the release files in
`~/.davinci-dkg-council/artifacts/`.

```bash
COUNCIL_KEY_FILE=path/to/key ETHERSCAN_API_KEY_FILE=path/to/etherscan-key make sepolia-deploy
```

| Variable | Default | Description |
|---|---|---|
| `COUNCIL_KEY_FILE` | required | File holding the funded deployer key; read at runtime, passed to forge through the environment only, never printed |
| `RPC_URL` | `https://ethereum-sepolia-rpc.publicnode.com` | Sending endpoint |
| `EXPECTED_CHAIN_ID` | `11155111` | The script refuses an endpoint serving another chain |
| `COUNCIL_ARTIFACTS_DIR` | `~/.davinci-dkg-council/artifacts` | The released files; their vkeys must equal `circuits/release/` byte for byte |
| `DEAL_VERIFIER`, `PARTIAL_VERIFIER` | | Reuse deployed verifiers (their code hashes must be the pins); the record keeps their original creation receipts, marked `reused` |
| `MANAGER` | | Skip the manager and only (re)deploy the test adapter |
| `FORGE_SCRIPT_ARGS` | | Extra `forge script` arguments, such as a fee cap: `--with-gas-price 1.7gwei -g 110` |
| `DEPLOYMENT_OUT` | `scripts/sepolia/deployment.json` | The deployment record |
| `COUNCIL_SEPOLIA_STATE` | `~/.davinci-dkg-council/sepolia` | Local state: forge broadcast copies, relayer state, run records |
| `ETHERSCAN_API_KEY_FILE` | | Verify every contract on Etherscan and Sourcify (failures only warn) |

How each pin is checked:

- `Deploy.s.sol` refuses to broadcast unless both vkey files hash to the `CouncilRelease.sol` pins
  and give the pinned `circuitReleaseId`, and it checks the EXTCODEHASH of both verifiers, freshly
  deployed or reused (`DEAL_VERIFIER`, `PARTIAL_VERIFIER`), against the pins before it deploys the
  manager. Accept-all mock verifiers (`MOCK_VERIFIERS=true`) are refused off chain 31337.
- `deploy.sh` first checks that the vkeys in the artifacts cache, the files the provers use, are
  byte-identical to `circuits/release/`. After the deployment it reads `circuitReleaseId()`,
  `dealVerifier()` and `partialVerifier()` back from the manager and both verifiers' code hashes
  from the chain and compares them with the pins again, and checks that the adapter points at
  the manager.
- Clients re-read `circuitReleaseId()` through the SDK's authenticated reads (two providers, one
  agreed finalized block) before they prove anything.

Gas limits come from the RPC's `eth_estimateGas` (`forge script --skip-simulation`): forge's local
simulation does not price Glamsterdam's state gas and would send a CREATE with about a fifth of
the gas it needs. Under Osaka the whole deployment (two verifiers, manager plus views, test
adapter) costs about 12.1M gas, 0.012 ETH at 1 gwei. Under Glamsterdam deployed code costs 1,530
gas per byte of state gas: the manager with its views is 41.1M, the adapter 3.3M, and the two
verifiers would add about 48M, so reuse them whenever the pins allow (about 0.047 ETH at 1 gwei
instead of about 0.095). The deployer must also hold gas limit × max fee for the largest
transaction; `FORGE_SCRIPT_ARGS` can cap the fee and the estimate margin. Commit the record with
the addresses and update this page, `ui/public/config.sepolia.json` and
`ui/.do/davinci-dkg-council-ui.yaml` together.

`scripts/gnosis/deploy.sh` (`make gnosis-deploy`) is the same script for Gnosis Chain, defaulting
to the first of `rpc.gnosischain.com`, publicnode and dRPC that serves chain 100, writing
`scripts/gnosis/deployment.json` and deploying no test adapter. Chain 100 is not a test chain:
a `DEVELOPMENT_SETUP` release is refused there unless `ALLOW_DEV_SETUP=true` is passed
explicitly, which only a TEST deployment may do. Gnosis runs Osaka (no state gas), so leave
`COUNCIL_STATE_GAS` unset everywhere. For a TEST deployment's rehearsals, deploy the test adapter
afterwards from a key of its own, which becomes its registry (the deployer key stays free for the
DAVINCI deployment); the record marks it `"testOnly": true`:

```bash
COUNCIL_KEY_FILE=path/to/key ALLOW_DEV_SETUP=true ETHERSCAN_API_KEY_FILE=path/to/etherscan-key make gnosis-deploy
MANAGER=0x… TEST_ADAPTER=true ALLOW_DEV_SETUP=true COUNCIL_KEY_FILE=path/to/tester-key make gnosis-deploy
```

## Rehearsal ceremony

`scripts/sepolia/run.sh` (`make sepolia-run`) drives one `n = 3, t = 2` ceremony against the
recorded deployment with real proofs: it builds the SDK, the relayer and the contracts, starts a
relayer locally in restricted mode (a fresh API token, a modest daily budget, its combine worker
on), and runs `scripts/sepolia/ceremony.sepolia.ts` through it with authenticated reads from two
providers. Every run writes a JSON record and a Markdown summary to `COUNCIL_SEPOLIA_STATE`. A
run costs about 20.1M gas on Sepolia since Glamsterdam (0.021 ETH at 1 gwei; 11.1M before it) and
takes about 70 min, of which about 65 min are four finality waits
([the run on the current manager](#rehearsal-ceremony-on-the-current-manager-2026-10-06)). To
send through an already running relayer instead of a local one, run
`scripts/sepolia/ceremony.sepolia.ts` with the environment `run.sh` sets, pointing
`COUNCIL_RELAYER_URL` at it. Every variable is documented at the top of the script.

Both scripts also run against a local Anvil (`EXPECTED_CHAIN_ID=31337`,
`anvil --hardfork osaka --block-time 1 --slots-in-an-epoch 4`, two RPC URLs such as
`http://127.0.0.1:PORT,http://localhost:PORT`), where a whole run takes under a minute.

`scripts/gnosis/run.sh` (`make gnosis-run`) runs the scenarios of the
[Gnosis rehearsals](#rehearsal-runs-2026-10-07) against `scripts/gnosis/deployment.json`: manual
phases (A), scheduled phases with a non-dealer decrypting (B, C), partial-data sourcing from
single-block logs and from a member's re-publication (D) and an abort below `t` (E), A then D
concurrently with B and E. `scripts/gnosis/ceremonies.gnosis.ts` starts the relayer itself (open
mode, scheduler and combine worker on) behind a local JSON-RPC proxy that records its
`eth_getLogs` and, for D, answers a request's single-block log reads with nothing; D restarts it
and deletes its cache file. The keys come from files (`COUNCIL_RELAYER_KEY_FILE`,
`COUNCIL_TESTER_KEY_FILE`, the test adapter's registry); `COUNCIL_SCENARIOS` picks a subset. A
full run takes about 30 min on Gnosis, most of it finality waits and B's schedule, and about 13
min on a local Anvil (B's dealing phase is at least 600 s).

## App and relayer

The app reads its deployment from `/config.json` (architecture §6). The committed Sepolia
configurations point at the deployment above, but two URLs are still placeholders (the Railway
app below renders its own):

| File | Deployment | Placeholders |
|---|---|---|
| `ui/public/config.sepolia.json` | `manager` and `deploymentBlock` of the Sepolia deployment, three `rpcUrls` | `relayerUrl` and `artifactsBaseUrl`, on the reserved `.invalid` TLD |
| `ui/.do/davinci-dkg-council-ui.yaml` | the same values as build-time variables | `RELAYER_URL`, `ARTIFACTS_BASE_URL` |
| `ui/public/config.gnosis.json` | the Gnosis TEST deployment: its `manager` and `deploymentBlock`, publicnode and `rpc.gnosischain.com` as `rpcUrls` | `relayerUrl` and `artifactsBaseUrl`, on the reserved `.invalid` TLD |

`make ui-gnosis RELAYER_URL=https://… [ARTIFACTS_URL=https://…]` serves the app against the
Gnosis TEST deployment. Its circuit release is a development setup, so the app shows the "Test
setup — do not use for real elections" banner on every page (checked on 2026-10-07 in headless
Chromium against `config.gnosis.json`: the banner names `circuits-v1`, read from the manager
through both RPCs, and the committee of run A loads as live).

A hosted app needs a public relayer and a public mirror of the circuit files. While this
repository is private, browsers cannot fetch the `circuits-v1` release assets: a mirror is
required, not optional. Serve the app against the Sepolia deployment with
`make ui-sepolia RELAYER_URL=https://… [ARTIFACTS_URL=https://…]`, or build an image for it:

```bash
docker build -f ui/Dockerfile --build-arg UI_CONFIG=ui/public/config.sepolia.json \
  --build-arg MANAGER_ADDRESS=0x77e4d62f60568d5a315052063115391aac828e6b --build-arg DEPLOYMENT_BLOCK=11857219 \
  --build-arg RELAYER_URL=https://… --build-arg ARTIFACTS_BASE_URL=https://… \
  -t davinci-dkg-council-ui .
```

`ARTIFACTS_BASE_URL` should point at a public mirror of the six release files that allows
cross-origin reads; with `null` the SDK fetches the GitHub release itself, which a browser can only
do while the repository is public. The pins stay in the SDK either way. The two Sepolia
`rpcUrls`, publicnode and Tenderly, are independent providers for the authenticated reads, which
refuse to read unless every listed provider reports the same finalized block. 1rpc.io was the
third until its Sepolia endpoint stopped at block 11,856,336, the last block before the hard fork
of 2026-10-06 13:53 UTC (blocks from 11,856,337 carry `blockAccessListHash` and `slotNumber`); a
provider stuck like that stops the app with "RPC providers disagree on the finalized block", so
add a third one only if it is well maintained.

Running the relayer for a deployment is covered in [relayer.md](relayer.md).

## Hosting on Railway

The Sepolia app and a public relayer run on [Railway](https://railway.com), in the project
`davinci-dkg-council-sepolia` (one `production` environment), since 2026-10-06. Note that this
puts the app, the only artifact mirror **and** the only relayer on one hobby-tier project —
acceptable for a rehearsal deployment, and exactly what [hosting.md](hosting.md) forbids for a
real election (independent mirrors, a second app copy, a relayer standby, one origin per
deployment).

| Service | URL | Configuration |
|---|---|---|
| `council-ui` | https://council-ui-production.up.railway.app | `config.sepolia.json` with the relayer below; publicnode and Tenderly for the authenticated reads; the six `circuits-v1` files served by the same origin under `/circuits-v1/` |
| `council-relayer` | https://council-relayer-production.up.railway.app | open admission, combine worker from block 11,857,219, a 0.06 ETH rolling 24 h budget, state gas on (`COUNCIL_STATE_GAS=true`), CORS for the app's origin only, state on a volume at `/data` |

The relayer's hot key is
[`0x998bCda6fbb3dd0C0764F9030F7a66FA77C2d13c`](https://sepolia.etherscan.io/address/0x998bCda6fbb3dd0C0764F9030F7a66FA77C2d13c),
funded from the deployer (0.03 ETH, then 0.01 ETH on 2026-10-06 for the rehearsal on the current
manager) and used by nothing else. Reads and sends go to
publicnode, then Tenderly. In open mode anyone's ceremony is sponsored within the quotas
and the budget, and the relayer answers `BUDGET_EXHAUSTED` once the window is spent, or when
the key cannot cover an action's worst case ("… the operator must top it up", logged as `hot key
balance too low`). Watch `balanceWei` in `/v1/health` and top the key up before it runs dry.

Since Sepolia's hard fork of 2026-10-06 13:53 UTC (block 11,856,337) the Council actions cost two
to three times the gas of the [rehearsal](#rehearsal-ceremony-2026-10-06) and of `tests/GAS.md`: a
plain transfer to a new account went from 21,000 to 204,600 gas. Through the hosted app, on the
first manager, an `n = 2, t = 2` committee took 7.27M gas to go live, 0.0079 ETH at 1.0 to 1.4
gwei:

| Action | Gas after the fork | Rehearsal, before it (`n = 3`) |
|---|---:|---:|
| createCeremony | 475,777 | 153,444 |
| join | 987,722 to 995,497 | 541,958 to 542,705 |
| closeRegistration | 287,948 | 110,747 |
| deal | 1,759,442 | 1,080,566 to 1,080,606 |
| finalize | 1,005,715 | 395,138 |

The fork is Glamsterdam, whose separate state gas (EIP-8037, about 97,920 gas per new storage
slot) comes on top of the EIP-7825 2^24 execution cap: on the first manager a 16-member finalize
needed 17.24M gas (10.97M execution + 6.27M state), on the current one it needs 9.05M. The
relayer runs with `COUNCIL_STATE_GAS=true`, so it caps gas limits at the block gas limit instead
of 2^24 ([relayer.md](relayer.md#sizing-the-budget)). At
1 gwei the 0.06 ETH budget sponsors about six small committees a day, fewer with decryptions;
`DAILY_BUDGET_WEI` changes it, and the key must hold what the budget allows.

### Deploying

`scripts/railway-deploy-relayer.sh` and `scripts/railway-deploy-ui.sh` create or update one
service each through Railway's GraphQL API, then build its image on Railway from the committed
tree with `railway up`. Nothing is pulled from a registry, so the private repository and its
private GHCR images need no credentials on Railway. `scripts/railway-status.sh` shows each
service's latest deployment, its log tail and the relayer's health. The scripts need `curl`,
`python3`, `git` and Node 22 (`npx` fetches the Railway CLI).

1. Create a Railway token and store it in a file outside the repository (`/railway-api-key` is
   git-ignored). A workspace token works; the scripts never print it.
2. Create a project in the dashboard, or with the `projectCreate` mutation, and note its id and
   the id of its `production` environment.
3. Generate a hot key for the relayer, store it as `0x` plus 64 hex digits in a file with mode
   `0600`, and fund it.
4. Deploy the relayer, then the app:

```bash
export RAILWAY_TOKEN_FILE=railway-api-key
export RAILWAY_PROJECT_ID=<project id> RAILWAY_ENVIRONMENT_ID=<environment id>
COUNCIL_KEY_FILE=~/.davinci-dkg-council/sepolia-relayer.key scripts/railway-deploy-relayer.sh
scripts/railway-deploy-ui.sh
scripts/railway-status.sh
```

The first relayer run also creates the app's service and domain, so that `COUNCIL_CORS_ORIGINS`
can name it; the app's build reads the relayer's domain into `relayerUrl`. Both scripts take the
manager and the deployment block from `scripts/sepolia/deployment.json`. Running either again
deploys the current `HEAD` (`GIT_REF` picks another commit; uncommitted changes are not deployed)
with the variables it sets. Each script documents its overrides at the top: `RPC_URLS`,
`DAILY_BUDGET_WEI`, `STATE_GAS`, `CORS_ORIGINS` and `EXTRA_VARS` (any other `COUNCIL_*` setting) for the
relayer; `UI_CONFIG`, `RPC_URLS`, `RELAYER_URL` and `COUNCIL_ARTIFACTS_DIR` for the app. The key
reaches Railway only inside a request body, as the `COUNCIL_PRIVATE_KEY` service variable; `railway
up` runs with a project token created for the upload and deleted afterwards.

### What the scripts adapt

- **Build context.** Each upload is a `git archive` of the packages its image needs, with the
  Dockerfile at its root. Railway refuses the `VOLUME` instruction and cache mounts outside its own
  id scheme, so the relayer's `VOLUME /data` and the app's pnpm cache mount are dropped from those
  copies; the relayer gets a Railway volume at `/data` instead.
- **Port and health check.** Railway's edge and health check connect to `$PORT`: 8080 for the
  relayer, whose health check is `/v1/health` (it reads the chain, so a deployment whose RPCs do
  not answer never takes traffic), and 80 for nginx.
- **Volume ownership.** Railway mounts volumes as root, so the relayer runs with
  `RAILWAY_RUN_UID=0`.
- **One replica.** The relayer allocates its key's nonces locally; never scale it out.
- **Client addresses.** Railway's edge drops any `X-Forwarded-For` a client sends and forwards
  `<client>, <edge>` from `100.64.0.0/10`. `COUNCIL_TRUSTED_PROXIES=0.0.0.0/0,::/0` makes the
  relayer charge the left-most hop, the real client; with `100.64.0.0/10` alone it would charge
  every client to the edge's address and share one rate limit among them.
- **Circuit files.** `railway-deploy-ui.sh` copies the six files from `COUNCIL_ARTIFACTS_DIR`
  into the image after checking each against its pin in `sdk/src/artifacts.ts`, and sets
  `artifactsBaseUrl` to `/circuits-v1`. The browser downloads them from the app's own origin, so
  the CSP needs no new origin and no CORS mirror is involved; the SDK still checks every byte
  against the same pins. `ui/nginx.conf` answers a missing circuit file with 404 instead of the
  app's index page.

### Smoke test (2026-10-06)

Headless Chromium against the public URLs:

- The app loads with no console errors and no CSP violations, and its `/config.json` passes the
  app's validation. A client-side route loaded directly (`/new`) gets the single-page-app
  fallback.
- From the app's origin, all six circuit files download (HTTP 200) and hash to their pins, and
  the relayer's `/v1/health` answers with the CORS header for that origin; another origin gets
  `FORBIDDEN_ORIGIN`.
- An organizer created committee `0xb37b266ebe380bb17f0ac73c` (`n = 2, t = 2`), two members
  joined from their invite links in separate browser profiles, the organizer locked the list,
  both members approved it and contributed (2 s to fetch and check the circuit files, 1 to 2 s of
  in-browser proving each), and the organizer finished the key: live after 92 minutes, every
  action paid by the relayer. Each step waited 15 to 19 minutes for finality.

Until the block of a relayed action was finalized, the app showed the state before it: right
after creating a committee, the organizer page showed "We could not reach the public record: …
UnknownCeremony()" for about 15 minutes, and after locking the list it still offered the lock
button. The browsers also logged a few HTTP 429 responses (three profiles polling from one
address), which the app retried. Since the redeploy of 2026-10-06 16:50 UTC the app keeps every
action it sent as pending until the finalized block shows it (`ui/src/lib/pending.ts`): after
creating committee `0x28cb9a52e1585c4153ee1415` through the hosted app, the organizer page said
"Your committee was created. Waiting for the network to confirm — about 15–20 minutes on
Sepolia, 1–2 minutes on Gnosis. You can close this page and come back." for 17 minutes, then
showed the dashboard, with no error and no console error on the way.

The relayer also logged `combiner tick failed` (`Invalid parameters`) every two to three minutes:
publicnode and Tenderly answer from several backends, and `eth_getLogs` up to the head one of
them reported was refused by a backend a block behind (`-32602 block range extends beyond
current head block`). The combine worker now ends that pass where it is and picks the rest up on
the next ([relayer.md](relayer.md#combine-worker)); its logs stayed clean for the 20 minutes
after the redeploy.

### Redeploy for the current manager (2026-10-06)

Both services were redeployed with `scripts/railway-deploy-relayer.sh` and
`scripts/railway-deploy-ui.sh` from the commit that records the current deployment, so they took
the new manager and start block 11,857,219 from `scripts/sepolia/deployment.json`; the relayer
starts a fresh state file for the new manager (budget window and quotas included). Headless
Chromium against the public URLs afterwards: the app loads with no console errors, its
`/config.json` names manager `0x77e4…8e6b` and block 11,857,219, the home page and `/new` render,
the six circuit files hash to their pins, and the relayer's `/v1/health` answers from the app's
origin with its CORS header and the new manager. The [rehearsal on the current
manager](#rehearsal-ceremony-on-the-current-manager-2026-10-06) then ran through this relayer
and its combine worker.

### Cost

On 2026-10-06 the relayer used about 160 MB of memory and 0.003 vCPU at rest, the app about 40 MB
and no measurable CPU. At Railway's usage prices that is about $2 a month for both, within the
Hobby plan's included usage, plus egress: a new browser downloads about 78 MB of circuit files
once (then they come from its cache), about $0.004 per participant. The relayer's state file is a
few hundred KB on its volume.
