# DAVINCI DKG Council architecture

Status: engineering companion to `docs/protocol.md` (normative). This document fixes the contract
surface, the circuit artifacts, the DAVINCI integration diffs, the SDK and relayer APIs, the app
structure, the testing strategy and the build setup. Gas and constraint numbers are **measured**
against the implemented contracts and the `circuits-v1` artifacts unless explicitly
marked as estimates.

Repository layout:

```
docs/                     # protocol.md (normative), this file, deployments.md, relayer.md
circuits/                 # circom sources, build/restore/pin scripts, tests, release/, fixtures/
solidity/                 # Foundry project: CouncilManager + CouncilViews, verifiers, tests, deploy
sdk/                      # @vocdoni/davinci-dkg-council-sdk (TypeScript)
relayer/                  # @vocdoni/davinci-dkg-council-relayer: Node service on the SDK, Docker image
ui/                       # @vocdoni/davinci-dkg-council-ui: React + Vite + Tailwind v4 app, Playwright journeys
tests/                    # headless Anvil e2e suite, DAVINCI round trip, local dev stack, vectors/
tools/davinci-test/       # small davinci-sdk client that creates a Council-bound process
scripts/                  # dev stack, Sepolia deploy/run, CI helpers, app config renderer
Makefile, package.json, pnpm-workspace.yaml
```

Council shares no state with the permissionless NI-DKG of
[davinci-dkg](https://github.com/vocdoni/davinci-dkg). It reuses one file from it,
`solidity/src/libraries/BabyJubJub.sol`, vendored byte for byte (the header names the origin
commit) and never edited here.

## 1. CouncilManager contract

One address plus two generated verifier contracts. No owner, no upgradability, no pausability:
the only privileged party is each ceremony's organizer, over its own ceremony, via signed actions.
The read surface lives in a separate `CouncilViews` contract that the manager constructor
deploys and serves through its fallback (§1.7), so callers see a single address implementing the
whole `ICouncil` interface.

Constructor: `constructor(address dealVerifier, address partialVerifier, bytes32 circuitReleaseId)`
— all three immutable, plus the immutable `views` address created inside the constructor.
`circuitReleaseId` must equal the §4.4 hash of the released vkeys; the deploy script computes and
asserts it against the pinned release (§1.6).

### 1.1 External functions

Action structs are the EIP-712 structs of protocol §7.2, passed as calldata structs; `sig` is the
65-byte signature.

```solidity
// lifecycle
function createCeremony(CreateCeremony calldata a, bytes calldata orgSig) external returns (bytes12 cid);
function addInvites(AddInvites calldata a, bytes calldata orgSig) external;
function closeRegistration(CloseRegistration calldata a, bytes calldata orgSig) external;
function join(Join calldata a, bytes calldata participantSig, Invite calldata inv, bytes calldata inviteSig) external;
function deal(
    Deal calldata a, bytes calldata sig,
    uint256[2][16] calldata C, uint256[2] calldata E, uint256[16] calldata maskedShares,
    uint256[2] calldata pA, uint256[2][2] calldata pB, uint256[2] calldata pC
) external;
function finalize(bytes12 cid) external;          // permissionless
function abort(bytes12 cid) external;             // permissionless

// authorization
function allowAdapter(AllowAdapter calldata a, bytes calldata orgSig) external;
function authorizeCreator(AuthorizeCreator calldata a, bytes calldata orgSig) external;

// decryption
function bindProcess(bytes12 cid, bytes31 processId, address creator)
    external returns (bytes32 requestId, uint256 pkX, uint256 pkY);   // msg.sender = allowed adapter
function submitRequest(bytes12 cid, bytes31 processId, uint256[4][] calldata cts)
    external returns (bytes32 requestId);                              // msg.sender = same adapter
function submitPartial(
    Partial calldata a, bytes calldata sig,
    uint256[2][16] calldata D,
    uint256[2] calldata pA, uint256[2][2] calldata pB, uint256[2] calldata pC
) external;
function combine(
    bytes32 requestId, uint8[] calldata memberSet,
    uint8[] calldata fieldIndexes, uint64[] calldata plaintexts
) external;                                        // permissionless
```

`cts[k] = [C1.x, C1.y, C2.x, C2.y]` in TE, matching the DAVINCI accumulator field layout.

### 1.2 Views (the SDK/app surface)

```solidity
enum Phase { None, Registration, Dealing, Live, Aborted }   // None = ceremony does not exist;
// getCeremony reverts UnknownCeremony() for a missing id, so None never escapes a view, but it
// keeps zero-initialized storage distinguishable and CeremonyAborted.phaseAtAbort unambiguous.

struct CeremonyView {
    uint8   phase;                 // Phase
    address organizer;
    uint8   threshold;
    uint8   n;                     // 0 until close
    uint64  registrationDeadline;
    uint64  dealingDeadline;       // 0 until close
    uint8   joinedCount;
    uint8   dealtCount;
    bytes32 rosterHash;            // 0 until close
    bytes32 ctx;                   // 0 until close
    uint32  inviteCount;
    uint64  consumedInvites;       // bit i = invite i consumed
    uint16  qualBitmap;            // bit j-1 = dealer j dealt (== QUAL)
    uint256 pkX;                   // P in TE; meaningful only when phase == Live
    uint256 pkY;
}

function getCeremony(bytes12 cid) external view returns (CeremonyView memory);
function getInvite(bytes12 cid, uint32 inviteId) external view returns (address key, bool consumed);
function getParticipant(bytes12 cid, uint8 index) external view
    returns (address auth, uint256 pkX, uint256 pkY, bool dealt);
function participantIndexOf(bytes12 cid, address auth) external view returns (uint8); // 0 = none
function getDealing(bytes12 cid, uint8 dealerIndex) external view
    returns (uint256[2][16] memory C, uint256[2] memory E, uint256[16] memory maskedShares);
function getQual(bytes12 cid) external view returns (uint16 bitmap);   // bit j-1 = dealer j in QUAL
function getPublicKey(bytes12 cid) external view returns (uint256 x, uint256 y);          // P, TE
function getMemberKey(bytes12 cid, uint8 index) external view returns (uint256 x, uint256 y); // PK_i, TE
function getAggregates(bytes12 cid) external view returns (uint256[2][16] memory A);      // A_0..A_{t-1}
function isAdapterAllowed(bytes12 cid, address adapter) external view returns (bool);
function isCreatorAuthorized(bytes12 cid, address creator) external view returns (bool);
function ceremonyIdFor(address organizer, uint64 nonce) external view returns (bytes12);
function getBinding(address adapter, bytes31 processId) external view
    returns (bytes12 cid, bytes32 requestId, bool requested);
function getRequest(bytes32 requestId) external view
    returns (bytes12 cid, uint8 fieldCount, uint16 completedBitmap, uint16 partialBitmap,
             uint256[4][] memory cts);
function getRequestOrigin(bytes32 requestId) external view
    returns (address adapter, bytes31 processId, address creator);  // §9.3 item 3
function getRequestIds(bytes12 cid) external view returns (bytes32[] memory); // decryption dashboard;
    // unbounded (== getRequestIdsPage(cid, 0, max)); long-lived ceremonies paginate instead:
function getRequestCount(bytes12 cid) external view returns (uint256);
function getRequestIdsPage(bytes12 cid, uint256 offset, uint256 limit)
    external view returns (bytes32[] memory);  // binding order, truncated at the end
function getPartial(bytes32 requestId, uint8 index) external view returns (uint256[2][16] memory D);
function getPlaintexts(bytes32 requestId) external view returns (bool ready, uint256[] memory values);
function circuitReleaseId() external view returns (bytes32);   // public immutables: clients
function dealVerifier() external view returns (address);       // cross-check ctx inputs and the
function partialVerifier() external view returns (address);    // deploy script asserts them
function views() external view returns (address);              // the CouncilViews instance (§1.7)
```

Bitmap conventions, pinned: `qualBitmap` bit `j-1` = dealer `j` dealt; `consumedInvites` bit `i` =
invite `i` consumed; `partialBitmap` bit `i-1` = member `i` has an accepted partial;
`completedBitmap` bit `k` = field `k` combined.

Every byte a participant needs months later (roster, dealings, ctx inputs, aggregates, partials)
is reconstructable from these views plus events, from any archive-free RPC: all of it is current
contract storage, not event-only history.

### 1.3 Events

```solidity
event CeremonyCreated(bytes12 indexed cid, address indexed organizer, uint8 threshold,
                      uint64 registrationDeadline, uint64 dealingDuration);
event InvitesAdded(bytes12 indexed cid, uint32 firstInviteId, uint32 count);
event ParticipantJoined(bytes12 indexed cid, uint8 index, address auth, uint32 inviteId);
event RegistrationClosed(bytes12 indexed cid, uint8 n, bytes32 rosterHash, uint64 dealingDeadline);
event DealingAccepted(bytes12 indexed cid, uint8 dealerIndex);
event CeremonyFinalized(bytes12 indexed cid, uint16 qualBitmap, uint256 pkX, uint256 pkY);
event CeremonyAborted(bytes12 indexed cid, uint8 phaseAtAbort);
event AdapterAllowed(bytes12 indexed cid, address adapter);
event CreatorAuthorized(bytes12 indexed cid, address creator);
event ProcessBound(bytes12 indexed cid, address indexed adapter, bytes31 processId,
                   bytes32 requestId, address creator);
event RequestSubmitted(bytes32 indexed requestId, bytes12 indexed cid, uint8 fieldCount);
event PartialAccepted(bytes32 indexed requestId, uint8 index);
event FieldsCombined(bytes32 indexed requestId, uint8[] fieldIndexes, uint64[] plaintexts);
event RequestCompleted(bytes32 indexed requestId);
```

### 1.4 Custom errors

`WrongPhase()`, `Expired()`, `BadSignature()`, `ZeroAddress()`, `CeremonyExists()`,
`UnknownCeremony()`, `InviteConsumed()`, `UnknownInvite()`, `TooManyInvites()`,
`DuplicateInvite()`, `BadInviteIndex()` (AddInvites `firstInviteId` mismatch), `DuplicateParticipant()`,
`DuplicateKey()`, `InvalidPoint()`, `NotInSubgroup()`, `BadPoP()`, `RosterMismatch()`,
`BelowThreshold()`, `AlreadyDealt()`, `BadPadding()`, `NonCanonical()`, `PayloadMismatch()`,
`ProofInvalid()`, `NotQualified()`, `NotAllowedAdapter()`, `NotAuthorizedCreator()`,
`AlreadyBound()`, `UnknownBinding()`, `AlreadyRequested()`, `BadFieldCount()`,
`UnknownRequest()`, `AlreadyPartial()`, `BadMemberSet()`, `MissingPartial()`,
`FieldCompleted()`, `BadFieldIndexes()`, `PlaintextTooLarge()`, `CombineCheckFailed()`,
`AbortConditionNotMet()`, `FinalizeConditionNotMet()`; plus names the protocol implies but does
not spell out: `BadThreshold()` (createCeremony threshold outside `1..16`), `BadDuration()`
(dealing duration below 600 s), `NoInvites()` (empty invite batch), `RosterFull()` (join with 16
members already), `AlreadyListed()` (allowAdapter/authorizeCreator on a listed address).

### 1.5 Storage summary

`CouncilStorage.sol`, shared by manager and views (§1.7):

```
mapping(bytes12 => Ceremony) _ceremonies
  Ceremony: phase u8; organizer; t u8; n u8; joinedCount u8; dealtCount u8; qualBitmap u16;
            inviteCount u32;                                        // slot 0
            registrationDeadline / dealingDeadline / dealingDuration u64;
            consumedInvites u64 (bit i = invite i consumed);        // slot 1
            rosterHash b32; ctx b32;
            participants: Participant[16] {auth, pkX, pkY};         // slot i = member i+1
            dealings: Dealing[16] {C[16][2], E[2], masked[16]};     // slot j = dealer j+1;
                      // only active entries written (C_k for k < t, masked_i for i < n);
                      // the views return the protocol's identity/zero padding
            aggregates: uint256[2][16] (A_k in TE; A_0 = P);  memberKeys: uint256[2][16];
            requestIds: bytes32[];      // appended at bindProcess; getRequestCount/-IdsPage
            invites: mapping(uint256 => address);        // inviteId => capability address
            authIndex: mapping(address => u8);           // 0 = none
            keyUsed: mapping(bytes32 => bool);           // keccak(X.x, X.y)
            allowedAdapters / authorizedCreators: mapping(address => bool)
mapping(bytes32 => bytes32) _bindings       // keccak(adapter, processId) => requestId
mapping(bytes32 => Request) _requests       // key: requestId
  Request: cid; adapter; processId b31; fieldCount u8 (0 until submitted); creator;
           partialBitmap u16; completedBitmap u16; cts uint256[4][16]; plaintexts u64[16];
           partials: mapping(memberIndex => uint256[2][16])
```

The binding record of protocol §4.5 is the `_bindings` entry plus the Request fields written at
`bindProcess` (`cid`, `adapter`, `processId`, `creator` — served by `getRequestOrigin`);
`submitRequest` fills `fieldCount` and `cts`. A stored dealing at full capacity is 50 words
(32 + 2 + 16); this is the deliberate price of months-later recovery from plain RPC state. No
hash-only storage mode in v1.

### 1.6 Verifier contracts

`DealVerifier.sol` (87 public signals) and `PartialVerifier.sol` (67) are generated by
`snarkjs zkey export solidityverifier` from the released zkeys, committed as generated files at
`solidity/src/verifiers/` (regenerate, never hand-edit), their bytecode dominated by
the IC points (one G1 point per public signal).

The deployment is bound to the circuit release as one unit in
`solidity/script/CouncilRelease.sol`: the byte-exact sha256 of both released vkey files, the
`circuitReleaseId` derived from them
(`0x071a01deb1e9b5e5e1da302df14be234c5ee5b91603d7f0437852dbf1c665301` for `circuits-v1`,
a **development** setup — `DEVELOPMENT_SETUP = true`, not for production), and the runtime code
hash (EXTCODEHASH) of each generated verifier. `script/Deploy.s.sol` enforces all of it before
broadcasting: the vkey files must hash to the pins and yield the pinned id, and every verifier
address — freshly deployed or reused via `DEAL_VERIFIER`/`PARTIAL_VERIFIER` — must carry exactly
the pinned runtime code. Accept-all mock verifiers exist only behind `MOCK_VERIFIERS=true`,
which the script refuses unless the chain id is 31337. `test/CouncilDeploy.t.sol` checks the
pins against `circuits/release/release.json`, the vkey files and the compiled
verifiers, and that each verifier's code embeds its vkey's constants; `CouncilRealVerifiers.t.sol`
asserts a known-good proof verifies and that per-public-signal mutations of it fail. A new
circuits release updates every `CouncilRelease` value together: `circuits/scripts/pin.ts`
(`make circuits`) rewrites them, and the SDK pins, from `release.json` and the compiled verifiers.

### 1.7 EIP-170 split: the views contract

Budget per contract is 24,576 bytes of runtime code, and the manager with its read surface
compiled in did not fit. The implemented split: all read-only functions live in
**`CouncilViews.sol`**, a view-only contract the CouncilManager constructor deploys and stores
as the immutable `views`. Both contracts inherit the single `CouncilStorage` layout
(`CouncilTypes.sol` holds the shared structs/errors), and the manager's non-payable `fallback`
**delegatecalls** every unrecognized selector into `views` on the manager's own storage — so the
entire `ICouncil` interface (and therefore the adapter-facing `ICouncilManager`) is served at
the manager's single address; clients and ABIs never see the second contract. The EIP-712
hashing lives in the internal library `CouncilEIP712.sol` (contingency (a) of the original
plan), curve work in `CouncilCurve.sol` (§1.8). Measured runtime sizes: manager **21,745 B**,
views **4,579 B**, both under the limit with via_ir and `optimizer_runs = 1`.
`CouncilViewsSplit.t.sol` pins the mechanism (every view answers at the manager address,
unknown selectors revert, value transfers revert).

### 1.8 Gas, measured (Osaka and Amsterdam; Gnosis block limit 17M, ~1 gwei)

Measured with `CouncilGas.t.sol` and `make solidity-gas`, which runs `FOUNDRY_PROFILE=gas forge
snapshot --match-contract Gas` twice (isolated calls, real verifiers, worst case `n = t = 16`
unless stated): under **Osaka** (the `gas` profile's `evm_version`), the EVM Gnosis runs, into
`snapshots/council.json`, and with `--evm-version amsterdam` into
`snapshots/council-amsterdam.json`. Amsterdam is the execution layer of Glamsterdam, which Sepolia
runs since 2026-10-06 (block 11,856,337); Foundry 1.8.3's Amsterdam reproduces Sepolia receipts
exactly. The headless e2e suite measures the Osaka values from receipts on Anvil `--hardfork
osaka` (`tests/GAS.md`); Anvil does not price Amsterdam's state gas yet. `BENCHMARKS.md`
summarizes both.

| Call | Osaka | Amsterdam | Dominated by |
|---|---|---|---|
| createCeremony (16 invites) | 481k | 2.06M | invite SSTOREs |
| join | 542k | 993k | subgroup check + Schnorr + storage |
| closeRegistration | 202k | 387k | roster hash + ctx |
| deal | 2.06M | 6.47M | verifier (87 publics); 50-word dealing storage; hashing |
| finalize (t=n=16, QUAL=16) | **3.42M** | **9.05M** | 64 new slots (6.27M state gas under Amsterdam) + aggregation and 240 Horner small-scalar steps in extended coordinates + one inversion |
| allowAdapter / authorizeCreator | 56k | 138k | one SSTORE + sig |
| bindProcess | 170k | 692k | binding record |
| submitRequest (16 fields) | 6.91M | 12.54M | 32 subgroup checks + 64-word storage |
| submitPartial (16 fields) | 1.52M | 4.34M | verifier (67 publics); D storage |
| combine (t=16) | 2.03M for 1 field, 3.79M for 2, 7.37M for 4 | 2.11M / 3.80M / 7.47M | t+1 scalarMuls + point adds |

At the small end (`n = 5, t = 3`): finalize 501k under Osaka and 1.91M under Amsterdam, a 4-field
combine 1.21M and 1.30M. The affine finalize this replaced (one modexp inversion per curve
operation, ≈ 720 at `n = t = 16`) measured 11.60M under Osaka (9.66M under Cancun) and 17.24M
under Amsterdam at `n = t = 16`; 821k and 2.23M at `n = 5, t = 3`. Finalize is permissionless,
paid by the relayer, once per ceremony.

**Why Amsterdam costs more.** EIP-8037 charges state growth as separate *state gas*, a fixed
1,530 gas per byte: 97,920 for each storage slot written from zero, 183,600 for a new account,
1,530 per byte of deployed code (a manager deployment with its views is ≈ 41.4M gas). No opcode or
precompile was repriced, so each call grows with the new slots it writes: deal 50, finalize
`2t + 2n` = 64 (6.27M of its 9.05M), submitRequest 4 per field, submitPartial 2 per field, join
and the grants a few each. Combine writes at most one new slot per four fields and moves by
at most ≈ 5%.

**Why Osaka costs more than Cancun.** EIP-7883 reprices the modexp precompile: with a 32-byte base
and modulus and a ~254-bit exponent, one call goes from ~1.35k to ~4.05k gas. The vendored
`BabyJubJub.sol` returns every affine `scalarMul` and `pointAdd` through one modexp inversion
(exponent `p − 2`), and `CouncilCurve.invModR` inverts mod `r` the same way for the Lagrange
coefficients, so each such curve operation costs ≈ 2.7k gas more: combine +7 to 8%. Finalize
inverts once in total and is unaffected; the verifier-bound calls (deal, submitPartial), the
subgroup checks of join and submitRequest (which stay in extended coordinates) and plain storage
are unchanged.

**The per-transaction limit.** Osaka caps one transaction at 2^24 = 16,777,216 gas (EIP-7825),
below Gnosis' 17M block limit, so that cap is the binding limit for one action; the largest
actions are a 4-field combine at t = 16 (7.37M) and submitRequest(16) (6.91M), finalize is 3.42M.
Under Amsterdam the 2^24 cap bounds execution gas only and state gas comes on top of it, from the
same gas limit; every Council action still fits under 2^24 in total (submitRequest(16) 12.54M,
finalize 9.05M of which ≈ 2.78M execution). The relayer adds 20% headroom to its estimates and
caps gas limits at 2^24 on Osaka chains and at the block gas limit on state-gas chains
(`COUNCIL_STATE_GAS`, docs/relayer.md); the affine finalize, 17.24M under Amsterdam, was the one
action that needed the latter.

**Curve arithmetic.** `solidity/src/libraries/BabyJubJub.sol` is the NI-DKG's library, vendored
from davinci-dkg byte for byte and never modified here (re-vendor the whole file to take an
upstream fix). Council adds its own library, `solidity/src/libraries/CouncilCurve.sol`, that
**wraps** it and adds what finalize needs:

- TE ↔ reduced conversions (one `mulmod` with `K`/`K_INV` from protocol §2.2) at the library
  boundary; `BabyJubJub.sol` has no conversion function at all, and davinci-contracts'
  `BjjFormLib` is not importable from this repo, so this part is needed regardless;
- pass-throughs for `isInPrimeSubgroup`, `verifySchnorrEquation`, `pointAdd` and `scalarMul`
  (all `internal` in the vendored library, used read-only);
- extended-coordinate arithmetic for finalize (the vendored library keeps its own `private`):
  unified HWCD addition and doubling (complete on this curve), Horner over a small `m`
  (MSB-first double-and-add) and a Montgomery batch inversion, over a scratch buffer allocated
  once;
- a modular inverse mod `r` via the modexp precompile (exponent `r − 2`) for the Lagrange
  coefficients — `BabyJubJub._inverse` is `private` and works mod `p` anyway.

Two consequences, replacing earlier assumptions:

1. **finalize inverts once.** It sums each `A_k` over QUAL, evaluates every `PK_m` by Horner and
   converts all `t + n` points to affine with one modexp inversion. Storage, events, ABI and
   outputs are those of the affine implementation: `CouncilFinalizeDiff.t.sol` runs both on the
   same stored dealings (a test-only copy of the affine one is the oracle) for every
   `1 <= t <= n <= 16` and random QUAL masks, forcing identity commitments, duplicate and
   opposite points, cancellations, identity aggregates and identity member keys, and compares
   every aggregate, member key, padding slot, the phase and the event. Since the formulas are
   complete, a zero `Z` is unreachable from on-curve points; the batch inversion still reverts
   `InvalidPoint()` on one instead of inverting 0, which would store `(0, 0)` for every key.
2. **No MSM in the MVP.** Combine evaluates `m_k·G + Σ λ_i·D_{i,k}` with independent
   `scalarMul` calls per term (measured 2.03M gas per field at t=16 under Osaka). The contract
   accepts 1 to 4 fields per combine call (`MAX_COMBINE_FIELDS = 4` stays the protocol maximum);
   the combiner keeps

   ```
   fieldsPerTx = min(4, max(1, floor(32 / t)))
   ```

   as its conservative gas guideline. It gives 2 fields per transaction at t = 16 (3.79M); even a
   full 4-field chunk at t = 16 (7.37M under Osaka, 7.47M under Amsterdam) fits comfortably, so
   the formula errs on the safe side for congested blocks. A shared-doubling Strauss MSM in
   extended coordinates would cut combine further; combine barely moved under Amsterdam, so it
   is not a priority.

At ~1 gwei the full lifecycle of a 16-member ceremony plus one 16-field decryption measures
about 108M gas ≈ 0.11 xDAI under Osaka: 16 deals ≈ 33M, eight 2-field combines ≈ 30M and 16
partials ≈ 24M dominate, and the relayer pays all of it except bind and request (≈ 101M). Under
Amsterdam it is about 244M (≈ 231M relayer-paid): the deals (103M) and partials (69M) write most
of the new slots. Cost is not the constraint on Gnosis; per-transaction gas versus the 2^24 cap
is, and no action comes within half of it under Osaka.

## 2. Circuits

Two circom 2.2.3 circuits, Groth16 via snarkjs 0.7.6, BN254. Measured at release
`circuits-v1` (circom `--O2`):

| Circuit | Public signals | Constraints | Artifacts | snarkjs proving (Node) |
|---|---|---|---|---|
| `deal.circom` | 87 (protocol §8.5) | 83,395 | zkey 51.3 MB, wasm 2.98 MB | 1.45 s (32 threads), 7.0 s (1 thread) |
| `partial.circom` | 67 (protocol §10.1) | 37,712 | zkey 20.0 MB, wasm 233 KB | 0.55 s (32 threads), 4.0 s (1 thread) |

Browser Web Worker times land between the two Node columns. Cost structure: dealing = 33
fixed-base muls (16 × `a_k·G` + `e·G` + 16 × `s_i·G` for the Feldman checks) + 16 variable-base
ECDH (`EscalarMulAny`) + 16 Horner ladders + 16 Poseidon7 + range plumbing; partial = 1
fixed-base + 16 variable-base + ranges.

Circuit-level obligations beyond the protocol statements (circomlib pinned at **2.0.5**):

- Pin the generated verifier's `_pubSignals` ordering by test against the protocol tables; never
  assume source declaration order survives the toolchain without checking the artifact.
- Implement every fixed-base multiplication as the protocol §8.5 split construction
  (`EscalarMulFix(246, G)` + `EscalarMulFix(5, [2^246]·G)` + complete `BabyAdd`); direct
  `EscalarMulFix(251, Base8)` is forbidden (incomplete for three canonical scalars — see the
  protocol's gadget rules). The positive-test battery must cover zero coefficients, zero shares,
  identity outputs, `r − 1` and the three exceptional scalars.
- Assert the dedicated-quadratic-row property per public signal on the optimized R1CS
  (`snarkjs r1cs export json` + a checker script), the circom analogue of davinci-dkg's
  `circuits/common/publicrows.go`. The circuits carry explicit `x·x` rows per public input
  (`pubSq`, 87 + 67 constraints); current snarkjs adds an equivalent row per public input on its
  own, so these are redundant today and kept anyway — the property belongs to the circuit
  source, not to an unpinned toolchain behavior (protocol §8.5 item 5).
- Use the protocol-pinned main-component signal names and witness JSON keys verbatim (protocol
  §8.5/§10.1); they are the interface between the circuits and the SDK.

Trusted setup: phase 1 is a `2^18` powers-of-tau file (262,144 ≥ 83,395, headroom for both
circuits); `release.json` records the sha256 of the one each release started from
(`toolchain.ptauSha256`). The default is the Hermez `powersOfTau28_hez_final_18.ptau` at
`~/.davinci-dkg-council/ptau/`: `circuits/build.sh` downloads it when missing and verifies the
blake2b digest snarkjs publishes ("Prepared (phase2) Ptau files" — the same URL and digest as
`scripts/ci-fetch-ptau.sh`, which the CI workflows and `publish-circuits.yml` use); any other
file can be forced through `COUNCIL_PTAU`. `circuits-v1` itself did **not** start from the Hermez
file: its phase 1 was a locally generated ptau (sha256
`0x9693220206afab749e3d88d4ab5fdf5d36120ea102e7e587ccea0e7a5208e711`, recorded as
`toolchain.ptauSha256`) and its phase 2 a single local snarkjs contribution plus a public beacon,
labeled **development setup — do not use in production** in `release.json` and in
`CouncilRelease.DEVELOPMENT_SETUP`. Before any production deployment: the Hermez/PPoT phase-1
file and a real multi-party phase 2 (manual snarkjs ceremony, 5–10 independent contributors,
published transcripts and attestations; the hosted p0tion service is defunct, so the flow is
scripted snarkjs `zkey contribute` round-robin plus a drand beacon). Each setup produces new
vkeys, hence a new `circuitReleaseId`, hence a new manager deployment — by design.

Artifact naming and layout, pinned: build outputs live under `circuits/build/`
(gitignored); the generated verifiers are committed at
`solidity/src/verifiers/DealVerifier.sol` and `PartialVerifier.sol`; the vkey files
and the release manifest are committed at `circuits/release/` (`deal_vkey.json`,
`partial_vkey.json`, `release.json` with toolchain versions, constraint counts and per-file
sha256s); the heavy assets are `deal.wasm`, `deal_final.zkey`, `partial.wasm`,
`partial_final.zkey` on a GitHub release of this repository tagged `circuits-v1`
(`https://github.com/vocdoni/davinci-dkg-council/releases/download/circuits-v1/`), staged as a
draft by the `Publish Circuits` workflow. The `circuitReleaseId` sha256 inputs are the published
vkey JSON files, byte-exact — never re-serialized; for `circuits-v1` the id is
`0x071a01deb1e9b5e5e1da302df14be234c5ee5b91603d7f0437852dbf1c665301` (§1.6). Locally the six
files live in `~/.davinci-dkg-council/artifacts/` (`COUNCIL_ARTIFACTS_DIR`), where
`make circuits-restore`, the SDK's real-prover tests, the e2e suite and `make dev` find them.

Artifact distribution follows davinci-sdk's `src/prover/artifacts.ts` pattern: the SDK exports a
record keyed by vkey hash mapping to `{wasm: {url, sha256}, zkey: {url, sha256}, vkey: {url,
sha256}}`, every file stream-verified against its pinned sha256 before use, cached in the browser
via the Cache API (zkeys are tens of MB; the app shows download progress and keeps them across
sessions). The base URL is overridable for local e2e; the sha256 pins are not.

## 3. DAVINCI integration

Target: davinci-contracts at the deployment lineage of commit `36c0b0a`, davinci-sdk 2.x,
davinci-sequencer current main. The registry redeploy this requires is already planned for the
aid-squatting fix (davinci-dkg issue #14). All file:line references below are at `36c0b0a`.
Working state: the diffs live on the (as yet unpushed) `council` branches of davinci-contracts,
davinci-sdk and davinci-sequencer; davinci-sdk's `source.json` and Anvil defaults point at the
unpushed contracts commit, so local work sets `DAVINCI_CONTRACTS_DIR`. The names are fixed across
the four repositories: key mode `KeyMode.COUNCIL = 3` (davinci-contracts), `'council'`
(davinci-sdk), `KeyMode::Council` (davinci-sequencer), adapter `CouncilAdapter`, registry getter
`councilAdapter()`. davinci-contracts vendors `ICouncilManager.sol` **verbatim** from
`solidity/src/interfaces/` plus an `ICouncilManagerErrors.sol` companion, the same
way the IDKGManager/IDKGAppManager ABIs are vendored; the vendored copy was reconciled against
the real manager (`getPlaintexts` returns one value per field; `submitRequest` returns the
binding's `requestId`), and a real-manager integration test (registry + CouncilAdapter + real
CouncilManager + real proofs) guards the seam. Ship order: the davinci-sdk major release adding
mode 3 lands **before** the first mode-3 process is created on any chain its users index
(§3.2).

### 3.1 davinci-contracts

**`src/libraries/DAVINCITypes.sol`**

- `KeyMode` enum (lines 106–110): append `COUNCIL` as value 3. ABI-neutral (the enum travels as
  uint8).
- `DKGParams` (lines 119–127): unchanged shape. For `mode == COUNCIL`: `epochId` (bytes12)
  carries the ceremony id; `organizerPKx/y` and the PoP fields (`popAx/popAy/popZ`) **must be
  zero** (the adapter reverts otherwise) — Council has no organizer key and no per-process PoP.
  The `createProcess` selector `0x08c0fdd3` is preserved.

**`src/ProcessRegistry.sol`**

- Constructor: new `address _councilManager` argument; `address(0)` disables Council mode.
  Alongside the existing `dkgAdapter` immutable (line 104, created at line 178), create
  `councilAdapter = new CouncilAdapter(_councilManager)` when enabled.
- Key resolution in `newProcess` (lines 255–269): for mode `COUNCIL`, call
  `councilAdapter.register(pid, msg.sender, dkg)`. **The registry must pass `msg.sender`
  through**: today's `DavinciDKGAdapter.register` (its lines 77–79) never learns the creator,
  and Council's authorized-creator check (protocol §9.1) needs it.
- Introduce `function _adapterFor(KeyMode mode) internal view returns (IDkgResultsAdapter)` over
  the two immutables, and a shared minimal interface

  ```solidity
  interface IDkgResultsAdapter {
      function submit(bytes12 id, bytes32 requestId, uint256[4][] calldata cts) external returns (uint16);
      function plaintexts(bytes12 id, bytes32 requestId, uint16 first, uint16 count)
          external view returns (bool, uint256[] memory);
  }
  ```

  (The second parameter is the registry's stored `dkgAid` — for Council the **request id**, for
  the existing adapter the application id; it is never a process id.) Both adapters already match
  these signatures (`DavinciDKGAdapter.submit/plaintexts`), so
  `requestResultsDecryption` (lines 562, 583, 625) and `finalizeResultsFromDKG` (lines 665–667)
  change only from the hardcoded `dkgAdapter` to `_adapterFor(process.keyMode)`.
- `revealProcessKey` (lines 651–655): revert with the **existing `InvalidKeyMode()`** for
  COUNCIL (no organizer secret exists) — no new error name is introduced for this path.
- Everything upstream of the adapter is reused untouched: the SMT accumulator inclusion against
  the settled state root (leaf `0x04 = sha256(abi.encode(accumulator))`), `zeroSkipped` bitmap
  for identity fields, rejection of half-identity fields, the move to ENDED **before**
  `adapter.submit`, and `dkgFirstIndex/dkgCount/dkgZeroSkipped` bookkeeping.

**`src/CouncilAdapter.sol`** (new, modeled on `DavinciDKGAdapter.sol`)

```solidity
constructor(address councilManager)       // registry = msg.sender, both immutable
function register(bytes31 pid, address creator, DKGParams calldata dkg)
    external onlyRegistry
    returns (bytes12 cid, bytes32 requestId, uint256 pkX, uint256 pkY);
function submit(bytes12 cid, bytes32 requestId, uint256[4][] calldata cts)
    external onlyRegistry returns (uint16 firstIndex);   // firstIndex = 0 always
function plaintexts(bytes12 cid, bytes32 requestId, uint16 first, uint16 count)
    external view returns (bool ready, uint256[] memory values);
function reveal(...) external pure { revert InvalidKeyMode(); }
```

The registry destructures a 4-tuple and persists two of the values that drive the whole results
path — `(eid, aid, teX, teY) = adapter.register(processId, msg.sender, dkg); p.dkgEpochId = eid;
p.dkgAid = aid;` — and later calls `adapter.submit(p.dkgEpochId, p.dkgAid, cts)` and
`adapter.plaintexts(p.dkgEpochId, p.dkgAid, …)`. So for Council: `cid → dkgEpochId`,
`requestId → dkgAid`, and the second parameter of `submit`/`plaintexts` is always the **request
id**, never a process id.

`register` requires mode COUNCIL and zero organizer/PoP fields, reads `cid = dkg.epochId`, calls
`manager.bindProcess(cid, pid, creator)`, stores the reverse mapping
`mapping(bytes32 requestId => bytes31 processId)` (the manager's `submitRequest` is keyed by the
original process id — a request hash is never cast into a process id), and returns
`(cid, requestId, P.x, P.y)` with `P` already TE (no BjjFormLib conversion, unlike the existing
adapter). `submit` looks the process id up by `requestId` and forwards the full field array in one
`manager.submitRequest(cid, processId, cts)` call (one call, not per-field like the old adapter:
the manager wants the whole request atomically); it returns `firstIndex = 0` since Council
indexes fields within the request. `plaintexts` requires `first == 0` and
`count == fieldCount`, proxies `manager.getPlaintexts(requestId)` and reports `ready` only when
the request is complete, so the registry can never finalize a partial vector.

### 3.2 davinci-sdk

- `src/contracts/types.ts` (lines 24–31): add `keyMode: 'council'` ↔ numeric 3 to both maps.
- `src/process/params.ts` (lines 23–67): accept `keyMode: 'council'` with a required
  `ceremonyId` (hex bytes12) and forbid organizer-key fields.
- `src/process/ProcessOrchestrationService.ts` (line 147, 539–546): route council mode through
  the DKG-params path with zeroed organizer fields.
- `src/contracts/ProcessRegistryService.ts`:
  - `decodeProcess` (lines 211–212) **throws on unknown key modes** — every deployed consumer
    breaks on the first mode-3 process it reads. The major SDK release adding `'council'` must
    therefore ship **before** the first mode-3 process is created on a chain its users index.
  - lines 915–917: a silent default-to-sequencer branch must not absorb mode 3; make it explicit.
  - `verifyDeployment` (lines 702–737): learn the second adapter back-pointer.
- Vendored ABIs: add CouncilManager + CouncilAdapter ABIs the way IDKGManager/IDKGAppManager
  are vendored today.

### 3.3 davinci-sequencer

- `src/web3/mod.rs` (lines 93–116): add `KeyMode::Council = 3` to the enum, `TryFrom` and the
  serde name (`"council"`).
- `src/actor.rs` (lines 2619–2625): the non-sequencer branch already drives
  `requestResultsDecryption`/`finalizeResultsFromDKG`; include Council in it.
- `src/contracts.rs` (lines 735–744): `dkg_results_ready` must select the adapter by key mode
  instead of assuming the DKG adapter.
- `verify_registry` (deployment verification) checks the Council adapter back-pointer the same
  way the SDK's `verifyDeployment` does, **fail-closed**: a registry that claims Council
  support but whose adapter probe fails is rejected, not skipped.
- `client/src/organizer.rs` (lines 150–172): accept the council mode in process creation params.
- Old sequencers fail safe: an unknown mode byte fails `TryFrom` and the process is ignored, not
  mis-driven.

### 3.4 Process creation frontend

Out of scope for the Council app. `tools/davinci-test/` holds a minimal davinci-sdk script/app
that creates a COUNCIL-mode process bound to a test ceremony, used by the e2e suite and as
integration documentation.

## 4. SDK: `@vocdoni/davinci-dkg-council-sdk`

TypeScript, ESM, browser-first (the relayer consumes it from Node). Dependencies: `viem`
(ABI/EIP-712/transport), `@zk-kit/baby-jubjub` (curve ops; note its exported `r` is the field
modulus, not the subgroup order — the SDK pins its own constants), `poseidon-lite` (pinned 0.3.x,
same parameterization the repo's SDK already uses; the `constants.json` Poseidon7 vector guards
it), `snarkjs` 0.7.6 (proof generation in a Web Worker), `@scure/bip39` + `@noble/hashes`
(mnemonic, HKDF, keccak). The SDK ships a hand-written CouncilManager ABI that must equal the
compiled contract ABI (the §1.2 `CeremonyView`/Phase definitions are the contract between the two
packages; an `abi-equals` assertion in e2e catches drift). Witness builders emit exactly the
protocol-pinned signal keys and decimal-string values (§8.5/§10.1), and proof words follow the
snarkjs `exportSolidityCallData` convention (protocol §7.2).

Modules (public API surface):

| Module | Contents |
|---|---|
| `constants` | every protocol §2 constant, tag hashes, limits; the single source the rest imports |
| `encoding` | tagged hash `K`, HashToScalar, bytes32 limbs, TE point codec, abi helpers |
| `keys` | mnemonic generation/restore, HKDF DeriveScalar, all §5.2 derivations, recovery-kit build/parse/verify |
| `invites` | capability derivation, link build/parse (`#v1.<id>.<hex>`), Invite struct signing |
| `eip712` | typed-data builders + signers for every §7.2 struct, payload hashes |
| `client` | viem-based reads over the §1.2 views, event decoding, multi-RPC verification helpers, `getPartialRequestSnapshot`, `verifyRestoredIdentity` |
| `dealing` | coefficient/ephemeral derivation, shares, masks, witness build, proof via worker |
| `recovery` | §8.6 share recovery with all mandatory checks |
| `partial` | §9.3 pre-checks, D computation, witness, proof (`buildPartialDecryption`) |
| `combine` | BSGS dlog (≤ 2^40, table size/precompute configurable), Lagrange, combine calldata |
| `relayer` | HTTP client for §5 below, with direct-send fallback given any funded account |
| `artifacts` | pinned `{url, sha256}` records per circuit (davinci-sdk `BALLOT_ARTIFACTS` pattern), fetch + stream-verify + cache |
| `vectors` | (dev export) generators for the §12 cross-implementation vectors |

Every secret-handling function takes and returns plain `Uint8Array`/bigint and never performs I/O;
network and storage live only in `client`, `relayer`, `artifacts`. This keeps the
secret-material-stays-local requirement auditable at the module boundary.

Public-surface rules, enforced by the implementation:

- The raw partial arithmetic (`computePartialUnchecked`) is **not exported**. The only public
  entry is `buildPartialDecryption`, which refuses to run without the result of
  `CouncilClient.getPartialRequestSnapshot` — the authenticated, frozen multi-RPC snapshot of
  protocol §9.3 (finalized-block agreement across providers, ceremony/binding/request/membership
  state, local roster-hash and `ctx` recomputation, ciphertext subgroup re-checks).
- `CouncilClient` construction enforces the §9.3 RPC rule: at least two RPC URLs, rejected as
  duplicates after normalization (scheme/host lowercased, trailing slash dropped); a single URL
  is accepted only with an explicit `devMode` flag, and `devMode` itself is refused unless the
  chain id is a local one (31337/1337). Every provider's reported chain id must equal the
  pinned deployment's.
- Recovery verification: `CouncilClient.verifyRestoredIdentity` checks a restored root against
  chain state; `kit` exports `kitEntryIdentity(root, entry)` and
  `rehearseEntry(root, entry, expected?)` for the §5.3 rehearsal flow.
- BSGS at the full `2^40` bound measures ~3.5 s worst case in Node (the relayer's combine
  worker; browsers are not expected to run it).

## 5. Relayer

TypeScript/Node service in `relayer/`, reusing the SDK (no Go port); operating it is covered in
`docs/relayer.md`. We operate it; its
key is funded off chain; there is no refund vault and no fee logic. Anyone can run one, and any
action can bypass it (the SDK falls back to direct sending from any funded account).

### 5.1 HTTP API

```
POST /v1/relay
  { "action": "createCeremony" | "addInvites" | "closeRegistration" | "join" | "deal" |
              "allowAdapter" | "authorizeCreator" | "submitPartial" |
              "finalize" | "abort" | "combine",
    "chainId": "100", "manager": "0x..",       // chainId: decimal string, like every uint
    "message": { ...typed struct fields... },          // absent for permissionless actions
    "signatures": ["0x65-byte", ...],                   // join carries two
    "payload": { ...arrays + proof for deal/partial, args for permissionless... } }
  -> 200 { "txHash": "0x..." }

  Per-action shapes (pinned; field elements are canonical decimal strings, ids/addresses/
  signatures 0x-hex, all other unsigned integers decimal strings):
  join:          message = { "join": {…Join fields…}, "invite": {…Invite fields…} }
                 signatures = [participantSig, inviteSig]      // this order, exactly 2;
                 both validUntil expiries are checked independently
  deal:          message = Deal fields; signatures = [sig];
                 payload = { "C": string[16][2], "E": string[2], "masked": string[16],
                             "proof": { "pA": string[2], "pB": string[2][2], "pC": string[2] } }
  submitPartial: message = Partial fields; signatures = [sig];
                 payload = { "D": string[16][2], "proof": { … } }
  finalize/abort: payload = { "ceremonyId": "0x…24hex" }; message/signatures absent
  combine:       payload = { "requestId": "0x…", "memberSet": number[],
                             "fieldIndexes": number[], "plaintexts": string[] }
  other signed actions: message = the struct fields; signatures = [orgSig]; payload absent
  -> 4xx/5xx { "error": CODE, "detail": "...", "revertData": "0x..?" }

GET /v1/status/:txHash -> { "status": "pending" | "confirmed" | "failed",
                            "blockNumber"?, "revertReason"? }
GET /v1/health         -> { "ok": true, "chainId", "manager", "relayer", "balanceWei" }
```

Error codes: `INVALID_ACTION`, `BAD_SIGNATURE`, `WRONG_CHAIN`, `UNSUPPORTED_MANAGER`,
`SIMULATION_REVERTED` (with decoded custom error when possible), `RATE_LIMITED`, `TX_FAILED`,
`INTERNAL`.

### 5.2 Behavior

- **Simulate before send**, always (`eth_call` with the exact calldata from the relayer's
  address); a reverting action is rejected with the decoded error and costs nothing. The relayer
  performs no semantic validation beyond simulation — the contract is the validator.
- Nonce handling: in-memory allocator over the relayer account, initialized from
  `pending` nonce at boot, serialized sends per account, gap repair by resync on
  `nonce too low/high`. Fee bumping with a capped max fee (`COUNCIL_MAX_FEE_WEI`).
- **Stateless**: no database. Chain state is the only truth; `/v1/status` is a thin
  `eth_getTransactionReceipt`. A restart loses nothing but in-flight tx tracking, which resyncs.
- **Combine worker** (`COUNCIL_COMBINER_ENABLED=true`): polls incomplete requests that have
  ≥ t partials, runs the SDK BSGS natively (≤ 2^40 bound; precomputed baby-step table kept in
  memory), submits combine chunks, backs off on `FieldCompleted` races (another combiner won —
  fine, the operation is permissionless and idempotent in effect).
- Rate limiting per IP and per action type; CORS restricted to the app origins.

Env: `COUNCIL_RPC_URL` (comma-separated fallbacks), `COUNCIL_MANAGER_ADDRESS`,
`COUNCIL_PRIVATE_KEY`, `COUNCIL_PORT`, `COUNCIL_COMBINER_ENABLED`, `COUNCIL_MAX_FEE_WEI`,
`COUNCIL_CORS_ORIGINS`, `COUNCIL_RATE_LIMIT`.

## 6. End-user app

React + Vite + Tailwind v4 in `ui/`. No third-party scripts, no analytics, no wallet connectors:
keys are in-browser only and invisible.

Runtime configuration comes from `ui/public/config.json`, served as `/config.json` (the pattern of
davinci-dkg's explorer); `scripts/render-ui-config.sh` writes it from environment variables for an
image build (`ui/Dockerfile`, `ui/.do/`):

```json
{ "chainId": 100, "manager": "0x…", "rpcUrls": ["https://…", "https://…"],
  "relayerUrl": "https://…", "artifactsBaseUrl": "https://github.com/…/releases/download/…" }
```

`rpcUrls` must list at least two independently administered providers on a production chain —
protocol §9.3's authenticated-read rule depends on it; a single entry is accepted only together
with an explicit local/dev declaration (e.g. Anvil, chainId 31337). Only the artifacts base URL is
configurable; the per-file sha256 pins live in the SDK.

### 6.1 Routes

| Route | Screen |
|---|---|
| `/` | landing: "create a committee" or "I have a link"; restore from recovery kit |
| `/new` | organizer creation wizard |
| `/c/:ceremonyId` | the ceremony page — the bookmark **is** the product; role (organizer / participant / viewer) resolved from local storage, invite fragment, or neither |

The invite fragment (`#v1.<id>.<hex>`) is imported and stripped on load (protocol §6).

### 6.2 Organizer screens

- **Create**: name (local only, never on chain), member count, threshold with a plain-sentence
  default (`⌊n/2⌋+1`: "any 9 of 16 members will be enough to unlock results — this still works if
  a few people are unavailable"), deadlines with sane defaults. Produces the organizer recovery
  kit (same forced-save flow as participants) and the invite links/QR codes with per-invite local
  labels ("Maria", "board seat 3") that never leave the device.
- **Dashboard**: per-invite progress sent → joined → contributed; roster review before closing
  ("do you recognize everyone?"); close button; countdowns; nudge = regenerate the same invite
  link (capability keys are derived, protocol §5.2).
- **Authorize**: add process creator addresses and adapters, with explicit "this cannot be
  undone for this committee" copy.
- **Decryption**: per-bound-process status (waiting for votes to end → members unlocking x of t →
  results ready), with result values once complete.

### 6.3 Participant screens

- **Join**: open link → generate words → forced kit save (print/download) → rehearsal: re-enter
  or re-import before anything is signed (protocol §5.3) → join (one relayed action).
- **Contribute**: when registration closes: the frozen ordered roster is displayed and the member
  must explicitly approve its exact `rosterHash` before the app will authorize a dealing (protocol
  §8.3). Then artifact download with progress and cache, proof in a worker with a progress
  indicator, one relayed action. "Keep this page open" live mode: the app polls, pre-downloads
  artifacts, and submits automatically — but never merely because the phase flipped: auto-submit
  fires only for a roster hash the member already approved on this device.
- **Unlock results**: lists open requests (with bound-process identity shown); runs §9.3 checks;
  computes the partial proof; one relayed action. Live mode again covers "stay on this page and
  we'll do it when it's time".
- **Recovery**: import kit or words; re-derive; verify against chain; show every ceremony in the
  manifest with its status.

### 6.4 Local storage model

Per origin, in `localStorage`/IndexedDB:

```
council.root.v1        root mnemonic, encrypted with a WebCrypto AES-GCM key derived (PBKDF2)
                        from a user PIN/passphrase; or plaintext with an explicit opt-in warning
council.ceremonies.v1  per-ceremony records: role, cid, chainId, manager, inviteId,
                        participantIndex, cached roster, cached artifacts state
council.labels.v1      organizer-only: invite label map (names), never transmitted
```

Local storage is a cache; the recovery kit is the source of truth. Clearing the browser loses
nothing that the kit plus chain state cannot restore.

### 6.5 Copy rules

Plain language throughout; the app never says "wallet", "gas", "sign", "transaction", "key pair",
"on-chain". It says: your recovery words, your contribution, unlock the results, the committee,
free for members (we cover the cost). Every irreversible step states its consequence in one
sentence before the button. Technical detail lives behind a single "details for auditors"
disclosure per screen, nowhere else.

## 7. Testing strategy

1. **Cross-implementation vectors** (protocol §12): committed at `tests/vectors/`
   (file list and pinned test mnemonic in the protocol), generated by a standalone TypeScript
   generator that must not import the SDK, asserted by SDK vitest, by Foundry tests and by the
   circuit witness tests — the same pattern as davinci-dkg's `tests/vectors/*.json`. They are the
   de-facto contract between the circuits, contracts and SDK; `make vectors-check` (CI) fails
   when the generator no longer reproduces them.
2. **Circuit mutation tests**: for each circuit, an honest witness plus a battery of single-field
   mutations that must all fail witness generation or proof verification: wrong share, wrong mask,
   wrong context limb, swapped recipients, `a_k != 0` beyond `t`, nonzero masked at inactive slot,
   scalar in `[r, p)`, **substituting** a zero share / zero coefficient / identity point for the
   honest value, wrong dealerIndex, `t > n`. Each mutation is asserted to fail for the
   **expected** reason. Zero shares, zero coefficients and identity outputs are themselves
   **valid** (protocol §8.5's positive battery covers them); only the substitution of such a
   value where an honest different value is implied may fail.
3. **Foundry adversarial tests** with canned real proofs (the `TestInputs.t.sol` pattern):
   generate honest proofs once per circuit release, commit calldata fixtures, then test every
   contract rejection path — bad signatures, high-s, expired, replayed, consumed invite, subgroup
   violations, padding violations, payload-hash mismatch, verifier mutations, combine with wrong
   λ/memberSet/plaintext, non-adapter bindProcess, unauthorized creator — plus full happy paths,
   the differential finalize tests against the affine oracle (§1.8) and gas snapshots
   (`make solidity-gas`, Osaka and Amsterdam) for the §1.8 table. Mandatory regressions from the
   soundness review: every state-changing call on a nonexistent ceremony id reverts
   `UnknownCeremony()` before any authorization or storage effect (abort, addInvites,
   allowAdapter, authorizeCreator included); an invalid signature whose `ecrecover` yields the
   zero address never matches any expected signer; a partial signed and proven under an
   attacker-created ceremony but carrying a victim's request id is rejected without consuming the
   victim's slot; an AddInvites batch replayed or submitted out of order fails the
   `firstInviteId` check; `plaintexts` with `first != 0` or `count != fieldCount` reverts.
   Three inputs the adversarial review found guarded **only** by the contract (the circuits
   never re-check them) get permanent regressions: a join key with `x = 0`, a request ciphertext
   with non-canonical `C1 = (0, p − 1)`, and a torsion-shifted `C1` — each must revert at
   join/request admission (protocol §8.2/§9.2).
4. **SDK unit tests** (vitest): all of `encoding`, `keys`, `invites`, `recovery`, `combine`
   against the vectors; BSGS against random exponents up to the bound.
5. **Headless e2e** (`tests/`): full lifecycle against Anvil pinned to `--hardfork osaka`
   (host Foundry v1.8.3 at `~/.foundry/bin` with `E2E_FOUNDRY=host`; the
   `ghcr.io/foundry-rs/foundry:stable` image otherwise), driven by the SDK in Node: create, 16
   joins, close, 16 deals with real proofs, finalize, bind via a mock adapter, request, t partials,
   combine, plaintext assertions; plus the abort paths and a DAVINCI round-trip using
   `tools/davinci-test` against locally deployed registry contracts. A full run rewrites
   `tests/GAS.md`.
6. **Browser e2e** (Playwright, `ui/e2e/`): organizer and participant journeys in a real browser
   against the `make dev` stack, including kit save/restore, the live mode, and the
   invite-fragment stripping.
7. **Testnet dress rehearsal**: one full ceremony plus one bound DAVINCI process on Sepolia with
   real humans before any production use. The headless half is scripted:
   `scripts/sepolia/deploy.sh` and `scripts/sepolia/run.sh` deploy the pinned release and drive
   an n = 3, t = 2 ceremony through a local relayer with authenticated reads
   (`docs/deployments.md`; no deployment is live yet).

## 8. Build and development setup

| Tool | Version / location |
|---|---|
| circom | 2.2.3, `~/.local/bin/circom` (`CIRCOM`); `scripts/ci-install-circom.sh` installs the verified binary |
| circomlib | 2.0.5 (pinned pnpm dependency of `circuits/`) |
| snarkjs | 0.7.6 (pnpm dependency, also CLI) |
| ptau | Hermez `2^18` file at `~/.davinci-dkg-council/ptau/` (auto-downloaded and blake2b-verified by `circuits/build.sh` when missing); override via `COUNCIL_PTAU`; `scripts/ci-fetch-ptau.sh` is the CI twin |
| pnpm | 10 (`packageManager` in the root `package.json`; `npx -y pnpm@10` without a global install) |
| Foundry | v1.8.3, the host install (`~/.foundry/bin` or `PATH`), else `ghcr.io/foundry-rs/foundry:stable` |
| Node | 22 |

The root `Makefile` drives everything (`make help`): `circuits` (new DEV phase-2, then
`forge build`, `pin`, fixtures), `circuits-restore`, `circuits-test`, `vectors`, `vectors-check`,
`solidity-build`, `solidity-test`, `solidity-gas`, `sdk`, `sdk-test`, `relayer`, `relayer-test`,
`ui-dev`, `ui-build`, `ui-lint`, `ui-test`, `e2e`, `e2e-browser`, `dev` (+ `dev-process`,
`dev-settle`, `dev-results`), `sepolia-deploy`, `sepolia-run`, `relayer-docker`, `ui-docker`.
`pnpm-workspace.yaml` covers `circuits`, `sdk`, `relayer`, `ui`, `tests` and
`tools/davinci-test`.

CI (`.github/workflows/`): `main.yml` runs the Foundry suite with sizes, the SDK, the vectors
check, the relayer, the app (renderer self-check, lint, tests, build) and, when `circuits/` or the
vectors change, a throwaway DEV phase-2 plus the circuit suites, on GitHub-hosted runners; the
headless e2e suite runs on demand on the organization's self-hosted runners. `publish-circuits.yml`
(label `trigger-upload-circuits`) stages a `circuits-vN` draft release and the re-pinned files;
`docker-build.yml` and `ui-docker-build.yml` build `ghcr.io/vocdoni/davinci-dkg-council-relayer`
and `-ui`; `release.yml` publishes both images and the GitHub release on a `vX.Y.Z` tag.

## 9. Status

Implemented and tested end to end on Anvil: circuits, contracts, SDK, relayer, app, the DAVINCI
round trip against the `council` branches of davinci-contracts and davinci-sdk. Open before any
production use:

- a real multi-party phase 2 (§2), which means a new `circuitReleaseId` and a new manager;
- the Sepolia deployment and dress rehearsal with real people (`docs/deployments.md`);
- the davinci-contracts registry redeploy with the COUNCIL key mode, shipped after the davinci-sdk
  major release that understands mode 3 (§3);
- a public relayer and a CORS-enabled mirror of the circuit files for the app.

Out of scope for v1: notifications (e-mail/push), refund vault or any on-chain gas economics,
external wallets (MetaMask/hardware/ERC-1271/Safe), passkeys, share refresh/resharing, `n > 16`,
a Chaum–Pedersen no-circuit fallback profile, embedded DAVINCI process creation in the app.
