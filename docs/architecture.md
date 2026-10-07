# DAVINCI DKG Council architecture

Status: engineering companion to `docs/protocol.md` (normative). This document fixes the contract
surface, the circuit artifacts, the DAVINCI integration diffs, the SDK and relayer APIs, the app
structure, the testing strategy and the build setup. It describes **protocol v2** (approved
2026-10-06: the slots-only storage diet and the scheduled/manual phase policies), whose
implementation is **merged and measured**: every v2 gas figure is a transaction receipt
(`tests/GAS.md`) or a forge snapshot from the implemented contracts, and the §1.7 sizes are
measured on the compiled code. The v1 figures stay as the baseline the v2 diet is judged
against.

Repository layout:

```
docs/                     # protocol.md (normative), this file, deployments.md, relayer.md
circuits/                 # circom sources, build/restore/pin scripts, tests, release/, fixtures/
solidity/                 # Foundry project: CouncilManager + CouncilViews + CouncilOps, verifiers, tests, deploy
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
The read surface lives in a separate `CouncilViews` contract and the rarely-used state
transitions in `CouncilOps`, both deployed by the manager constructor and served through its
fallback (§1.7), so callers see a single address implementing the whole `ICouncil` interface.

Constructor: `constructor(address dealVerifier, address partialVerifier, bytes32 circuitReleaseId)`
— all three immutable, plus the immutable `views` and `ops` addresses created inside the
constructor (CREATE nonces 1 and 2).
`circuitReleaseId` must equal the §4.4 hash of the released vkeys; the deploy script computes and
asserts it against the pinned release (§1.6).

### 1.1 External functions

Action structs are the EIP-712 structs of protocol §7.2, passed as calldata structs; `sig` is the
65-byte signature.

```solidity
// lifecycle
function createCeremony(CreateCeremony calldata a, bytes calldata orgSig) external returns (bytes12 cid);
function addInvites(AddInvites calldata a, bytes calldata orgSig) external;
function closeRegistration(CloseRegistration calldata a, bytes calldata orgSig,
    uint256[2][] calldata rosterKeys) external;                       // Manual mode only
function closeRegistrationScheduled(bytes12 cid, uint256[2][] calldata rosterKeys) external;
    // permissionless; Scheduled mode past the deadline, or Manual mode past a nonzero expiry
function join(Join calldata a, bytes calldata participantSig, Invite calldata inv, bytes calldata inviteSig) external;
function deal(
    Deal calldata a, bytes calldata sig,
    uint256[2][16] calldata C, uint256[2] calldata E, uint256[16] calldata maskedShares,
    uint256[2] calldata pA, uint256[2][2] calldata pB, uint256[2] calldata pC,
    uint256[2][] calldata rosterKeys                                  // full roster, authenticated vs compressed
) external;
function finalize(bytes12 cid) external;          // permissionless; A_0 == O aborts, else Live
function abort(bytes12 cid) external;             // permissionless

// scheduling
function openDecryption(OpenDecryption calldata a, bytes calldata orgSig) external;  // Manual mode only

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
    uint256[2] calldata pA, uint256[2][2] calldata pB, uint256[2] calldata pC,
    uint256[2][] calldata C1                                           // active C1 points, authenticated
) external;
function combine(
    bytes32 requestId, uint8[] calldata memberSet,
    uint8[] calldata fieldIndexes, uint64[] calldata plaintexts,
    uint256[2][16][] calldata partialVectors,                          // t padded D vectors, hash-checked
    uint256[2][] calldata C2                                           // one per field index, authenticated
) external;                                        // permissionless
function publishPartialData(bytes32 requestId, uint8 participantIndex,
    uint256[2][16] calldata D) external;           // permissionless re-publication (protocol §10.4)
```

`cts[k] = [C1.x, C1.y, C2.x, C2.y]` in TE, matching the DAVINCI accumulator field layout. The v2
additions relative to v1: the two close variants take `rosterKeys`, `deal` takes `rosterKeys`,
`submitPartial` takes `C1`, `combine` takes `partialVectors` + `C2` (all re-supplied full points
authenticated against stored compressed words or the partial-data hashes, protocol §2.5/§10.3),
and `closeRegistrationScheduled`, `openDecryption`, `publishPartialData` are new.

Eight of these functions — `addInvites`, both close variants, `abort`, `openDecryption`,
`allowAdapter`, `authorizeCreator`, `publishPartialData` — are implemented in `CouncilOps` and
served through the manager's fallback (§1.7); callers never notice.

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
    uint64  registrationDeadline;  // Scheduled close time, or Manual expiry (0 = none)
    uint64  dealingDeadline;       // 0 until close
    uint8   joinedCount;
    uint8   dealtCount;
    bytes32 rosterHash;            // 0 until close
    bytes32 ctx;                   // 0 until close
    uint8   inviteCount;
    uint64  consumedInvites;       // bit i = invite i consumed
    uint16  qualBitmap;            // bit j-1 = dealer j dealt (== QUAL)
    uint256 pkX;                   // P in TE (= aggregates[0]); meaningful only when phase == Live
    uint256 pkY;
}

struct PhasePolicyView {           // protocol §8.1/§8.7; immutable after create except manualOpenedAt
    uint8   registrationMode;      // PhaseMode
    uint8   decryptionMode;        // PhaseMode
    uint64  dealingDuration;
    uint64  decryptionOpenAt;              // Scheduled decryption only, else 0
    uint64  manualDecryptionFallbackAt;    // Manual decryption only, 0 = no fallback
    uint64  manualOpenedAt;                // 0 until openDecryption
    bool    decryptionOpen;                // the §8.7 predicate at block.timestamp
    bool    scheduledRegistrationCloseDue; // closeRegistrationScheduled would succeed now
}

function protocolVersion() external pure returns (uint8);      // 2
function getCeremony(bytes12 cid) external view returns (CeremonyView memory);
function getPolicy(bytes12 cid) external view returns (PhasePolicyView memory);
function isDecryptionOpen(bytes12 cid) external view returns (bool);  // the §8.7 predicate; the
    // DAVINCI adapter and the SDK snapshot read this one, never reimplement the clock logic
function getInvite(bytes12 cid, uint8 inviteId) external view returns (address key, bool consumed);
function getParticipantCompressed(bytes12 cid, uint8 index) external view
    returns (address auth, uint256 compressedKey, bool dealt);  // SDK decompresses (protocol §2.5)
function participantIndexOf(bytes12 cid, address auth) external view returns (uint8); // 0 = none
function getQual(bytes12 cid) external view returns (uint16 bitmap);   // bit j-1 = dealer j in QUAL
function getPublicKey(bytes12 cid) external view returns (uint256 x, uint256 y);          // P = A_0, TE
function getMemberKey(bytes12 cid, uint8 index) external view returns (uint256 x, uint256 y);
    // PK_i = Horner(A, i), computed on demand from the aggregates — no memberKeys storage in v2
function getAggregates(bytes12 cid) external view returns (uint256[2][16] memory A);      // A_0..A_{t-1},
    // full points (bias removed); the only on-chain key material besides the compressed roster
function getRecoveryDealing(bytes12 cid, uint8 dealerIndex) external view
    returns (uint256 compressedE, uint256[16] memory maskedShares);   // what share recovery reads
function getRecoverySlice(bytes12 cid, uint8 memberIndex) external view
    returns (uint16 qualBitmap, uint256[16] memory compressedE, uint256[16] memory maskedShares);
    // one call per recovery: E_j and masked_{j,memberIndex} for every dealer j (zero if not in QUAL)
function isAdapterAllowed(bytes12 cid, address adapter) external view returns (bool);
function isCreatorAuthorized(bytes12 cid, address creator) external view returns (bool);
function ceremonyIdFor(address organizer, uint64 nonce) external view returns (bytes12);
function getBinding(address adapter, bytes31 processId) external view
    returns (bytes12 cid, bytes32 requestId, bool requested);
function getRequestMeta(bytes32 requestId) external view
    returns (bytes12 cid, uint8 fieldCount, uint16 completedBitmap, uint16 partialBitmap);
function getRequestCompressed(bytes32 requestId) external view
    returns (uint256[2][] memory compressedCts);   // [compressed(C1), compressed(C2)] per field
function getRequestOrigin(bytes32 requestId) external view
    returns (address adapter, bytes31 processId, address creator);  // §9.3 item 3
function getRequestCount(bytes12 cid) external view returns (uint256);
function getRequestIdsPage(bytes12 cid, uint256 offset, uint256 limit)
    external view returns (bytes32[] memory);  // binding order, truncated at the end
function getPartialCommitment(bytes32 requestId, uint8 index) external view
    returns (bool accepted, bytes32 dataHash, uint64 publishedBlock);  // protocol §10.2; the full
    // D vector travels in the PartialAccepted/PartialDataPublished events, not storage
function getPlaintexts(bytes32 requestId) external view returns (bool ready, uint256[] memory values);
function circuitReleaseId() external view returns (bytes32);   // public immutables: clients
function dealVerifier() external view returns (address);       // cross-check ctx inputs and the
function partialVerifier() external view returns (address);    // deploy script asserts them
function views() external view returns (address);              // the CouncilViews instance (§1.7)
```

Removed from the v1 surface: `getDealing` (per-dealer `C` vectors are not stored — replaced by
`getAggregates` + `getRecoveryDealing`/`getRecoverySlice`), `getParticipant` (replaced by
`getParticipantCompressed`), `getRequest` (replaced by `getRequestMeta` + `getRequestCompressed`),
`getPartial` (replaced by `getPartialCommitment`), and the unbounded `getRequestIds`
(`getRequestCount` + `getRequestIdsPage` stay). Views that hand out points decompress nothing:
they return the stored compressed words (roster, E, ciphertexts) or the stored full points
(aggregates); decompression is the SDK codec's job (§4).

Bitmap conventions, pinned: `qualBitmap` bit `j-1` = dealer `j` dealt; `consumedInvites` bit `i` =
invite `i` consumed; `partialBitmap` bit `i-1` = member `i` has an accepted partial;
`completedBitmap` bit `k` = field `k` combined.

Every byte a **member** needs months later — roster, ctx inputs, aggregates (and from them every
`PK_i`), its recovery slice (`E_j`, masked shares), request ids, which vote each request belongs
to, the ciphertexts, the phase policy and whether decryption is open — is current contract
storage, readable through these views alone from any archive-free RPC at the finalized block. No
step a member takes (join, deal, recover share, compute and submit a partial) reads event logs or
historical calldata (§6.6, protocol §10.4): public providers cap `eth_getLogs` ranges, so a log
scan that works the week of the ceremony is refused months later. The log reads that remain are
off the member path and are conveniences, not dependencies. The **combiner's** input: full
partial `D` vectors are committed on chain only by `dataHash` + `publishedBlock`, so combine
needs *recent* publication data — a cache, or one single-block `eth_getLogs` at each stored
`publishedBlock` (bounded, archive-free, authenticated by the hash) — and if even that is gone,
any member republishes its own recomputed `D = s_m·C1` via `publishPartialData`. The **relayer's
request discovery** (§5.2) reads logs only to find ceremonies it has never seen; for a known
ceremony id every request is enumerable from state (`getRequestCount` + `getRequestIdsPage`).

### 1.3 Events

```solidity
event CeremonyCreated(bytes12 indexed cid, address indexed organizer, uint8 threshold,
                      uint8 registrationMode, uint64 registrationDeadline, uint64 dealingDuration,
                      uint8 decryptionMode, uint64 decryptionOpenAt, uint64 manualDecryptionFallbackAt);
event InvitesAdded(bytes12 indexed cid, uint8 firstInviteId, uint8 count);
event ParticipantJoined(bytes12 indexed cid, uint8 index, address auth, uint8 inviteId);
event RegistrationClosed(bytes12 indexed cid, uint8 n, bytes32 rosterHash, uint64 dealingDeadline);
event DealingAccepted(bytes12 indexed cid, uint8 dealerIndex);
event CeremonyFinalized(bytes12 indexed cid, uint16 qualBitmap, uint256 pkX, uint256 pkY);
event CeremonyAborted(bytes12 indexed cid, uint8 phaseAtAbort);
event DecryptionOpened(bytes12 indexed cid, uint64 openedAt);   // openDecryption only (Manual)
event AdapterAllowed(bytes12 indexed cid, address adapter);
event CreatorAuthorized(bytes12 indexed cid, address creator);
event ProcessBound(bytes12 indexed cid, address indexed adapter, bytes31 processId,
                   bytes32 requestId, address creator);
event RequestSubmitted(bytes32 indexed requestId, bytes12 indexed cid, uint8 fieldCount);
event PartialAccepted(bytes32 indexed requestId, uint8 index);
event PartialDataPublished(bytes32 indexed requestId, uint8 index, bytes32 dataHash,
                           uint256[2][16] D);   // submitPartial and publishPartialData
event FieldsCombined(bytes32 indexed requestId, uint8[] fieldIndexes, uint64[] plaintexts);
event RequestCompleted(bytes32 indexed requestId);
```

The phase policy travels in `CeremonyCreated` (it is immutable, protocol §8.1) — no separate
policy event. A **time-driven** opening (Scheduled mode, or a Manual fallback date passing) emits
nothing: no transaction happens, the §8.7 predicate just starts returning true; indexers that want
an "opened" row evaluate `isDecryptionOpen` per block or on the first gated call.

Events are for indexers, the relayer's request discovery (§5.2 — a convenience: for a known
ceremony id the request ids are enumerable from the views) and labels — with one carve-out:
`PartialDataPublished` is the **data-availability channel for combine** (protocol §10.4). The
combiner reads it with a single-block `eth_getLogs` at the stored `publishedBlock` and checks the
vector against the stored `dataHash`; everything else any client acts on comes from the §1.2
views. The app additionally reads `ParticipantJoined` to show the organizer which invitation each
member used (that linkage is not stored).

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
(dealing duration outside [600 s, 365 days]), `NoInvites()` (empty invite batch), `RosterFull()` (join with 16
members already), `AlreadyListed()` (allowAdapter/authorizeCreator on a listed address).

New in v2 (protocol §2.5, §8, §10): `BadSchedule()` (createCeremony policy validation, §8.1),
`WrongMode()` (a Manual-only action in Scheduled mode, or `closeRegistrationScheduled` on a
ceremony without a deadline), `RegistrationNotDue()` (closeRegistrationScheduled before the
deadline), `RegistrationEnded()` (join, addInvites or the organizer's manual close at or after a
nonzero deadline — the half-open window), `DecryptionNotOpen()` (submitPartial / combine /
publishPartialData before the §8.7 predicate), `AlreadyOpen()` (openDecryption while the
predicate already holds — a prior open or a passed fallback date), `CompressedPointMismatch()`
(re-supplied full point does not match the stored compressed word), `PartialDataMismatch()`
(combine or publishPartialData vector does not hash to the stored `dataHash`),
`BlockNumberOverflow()` (`block.number` exceeds uint64 — unreachable in practice, checked
anyway). Reserved for milestone 2 (code-data storage, §1.8): the names `DataStoreFailed()` /
`BadDataStore()`, not declared in the v2 code.

### 1.5 Storage summary

`CouncilStorage.sol`, shared by manager and views (§1.7):

```
mapping(bytes12 => Ceremony) _ceremonies
  Ceremony: phase u8; organizer; t u8; n u8; joinedCount u8; dealtCount u8; qualBitmap u16;
            inviteCount u8; registrationMode u8; decryptionMode u8;      // slot 0
            registrationDeadline / dealingDeadline / dealingDuration u64;
            consumedInvites u64 (bit i = invite i consumed);             // slot 1
            decryptionOpenAt / manualDecryptionFallbackAt / manualOpenedAt u64;  // slot 2
            rosterHash b32; ctx b32;
            participants: Participant[16] {auth; compressedX u256};      // 2 slots per member;
                      // compressed(X_i) per protocol §2.5 — the full key never hits storage
            recovery: RecoveryRecord[16] {compressedE u256; masked u256[16]};   // 17 slots per
                      // dealer: compressed(E_j) + the full masked-share vector; the per-dealer
                      // commitment vectors C_j are NOT stored (folded into aggregates at deal)
            aggregatesBiased: uint256[2][16];   // (A_k.x + 1, A_k.y + 1), protocol §8.3 — stored
                      // full (uncompressed): read by every finalize/view Horner, bias keeps the
                      // slots nonzero so later deals pay warm SSTOREs, not 97,920-gas inserts
            requestIds: bytes32[];      // appended at bindProcess; getRequestCount/-IdsPage
            invites: mapping(uint256 => address);        // inviteId => capability address
            authIndex: mapping(address => u8);           // 0 = none
            keyUsed: mapping(uint256 => bool);           // keyed by the compressed word
            allowedAdapters / authorizedCreators: mapping(address => bool)
mapping(bytes32 => bytes32) _bindings       // keccak(adapter, processId) => requestId
mapping(bytes32 => Request) _requests       // key: requestId
  Request: cid; adapter; processId b31; fieldCount u8 (0 until submitted); creator;
           partialBitmap u16; completedBitmap u16;
           compressedCts uint256[32];          // [compressed(C1_k), compressed(C2_k)] per field —
                                               // stored compressed, never hash-only (§9.2)
           plaintexts: uint40[16] packed into 3 slots (values < 2^40, protocol §10.3 —
                       the ABI stays uint64);
           partialDataHashes: bytes32[16];     // one per member index
           partialPublishedBlocks: uint64[16] packed into 4 slots
           // no partial D vectors in storage: hash + event + republication (protocol §10.4)
```

The binding record of protocol §4.5 is the `_bindings` entry plus the Request fields written at
`bindProcess` (`cid`, `adapter`, `processId`, `creator` — served by `getRequestOrigin`);
`submitRequest` fills `fieldCount` and `compressedCts`. The v1 layout stored every point in full
(a 50-word dealing, 64-word requests, 32-word partials); the v2 slots-only diet replaces that
with compressed words, aggregate folding and hash commitments. New-slot counts at full capacity
(`n = t = 16`, 16 fields), the quantity Amsterdam prices at 97,920 gas each:

| Call | v1 new slots | v2 new slots |
|---|---|---|
| join | 5 (auth + 2-word key + index + keyUsed) | 4 (auth+compressed = 2, index, keyUsed) |
| deal (first dealer) | 51 | `2t + n + 1` = 49 (aggregates 2t, masked n, compressedE) |
| deal (later dealer) | 51 | `n + 1` = 17 (aggregate slots already nonzero via the bias) |
| finalize | 64 (16 memberKeys + aggregates) | **0** (A_0 check + phase flip only) |
| submitRequest (16 fields) | 64+ | `2f` = 32 compressed words + meta |
| submitPartial | 32 (full D) + bitmap | 1–2 (dataHash; packed block word amortized) |
| combine | plaintext slots | 1–2 packed plaintext slots + bitmaps |

No hash-only storage mode for ciphertexts or roster keys (protocol §9.2): hashes commit only the
partial D vectors, which any member can deterministically recompute.

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

### 1.7 EIP-170 split: the views and ops contracts

Budget per contract is 24,576 bytes of runtime code, and the manager with everything compiled in
does not fit. The manager keeps the hot path — createCeremony, join, deal, finalize,
bindProcess, submitRequest, submitPartial, combine, `ceremonyIdFor` and the immutable getters —
and its constructor deploys two logic contracts that run on the manager's storage through its
non-payable `fallback`'s **delegatecall** (all three inherit the single `CouncilStorage` layout;
`CouncilTypes.sol` holds the shared structs/errors):

- **`CouncilViews.sol`** (CREATE nonce 1, exposed by the `views()` getter): the whole §1.2 read
  surface; view-only code that reverts on unknown selectors.
- **`CouncilOps.sol`** (CREATE nonce 2, **no getter** — the deploy script locates it with
  `computeCreateAddress(manager, 2)` and byte-compares it against the local build): the eight
  rarely-used state-changing `ICouncilOps` functions — `addInvites`, both close variants,
  `abort`, `openDecryption`, `allowAdapter`, `authorizeCreator`, `publishPartialData`. It takes
  `circuitReleaseId` as its own constructor immutable (the closes' `ctx` computation needs it,
  and immutables do not cross a delegatecall). Called directly, either logic contract acts on
  its own empty storage, where every ceremony and request is unknown.

The fallback **whitelists exactly the eight `ICouncilOps` selectors** to ops and sends every
other unrecognized selector to views; plain value transfers revert. So the entire `ICouncil`
interface (and therefore the adapter-facing `ICouncilManager`) is served at the manager's
single address; clients and ABIs never see the logic contracts. This replaces the v1 invariant
that *the fallback target is read-only by construction* with the selector whitelist;
`CouncilViewsSplit.t.sol` pins it: every view and every op answers at the manager address with
manager state, the ops selectors are present in CouncilOps' code and absent from CouncilViews'
(and vice versa for the views, and the core selectors from both), direct calls to the bare
logic contracts see empty storage, unknown selectors revert, and ether is refused. The EIP-712
hashing lives in the internal library `CouncilEIP712.sol`, curve work in `CouncilCurve.sol`
(§1.8).

Measured **v2** runtime sizes (via_ir, `optimizer_runs = 1`): manager **21,777 B** (2,799 B of
headroom), views **6,521 B**, ops **6,345 B** — the function-complete size gate of the v2 plan,
passed. (v1 for reference: manager 21,745 B, views 4,579 B.)

### 1.8 Gas: measured, v1 baseline and v2 (Osaka and Amsterdam; Gnosis block limit 17M, ~1 gwei)

Both tables below are **measured**. The method: `CouncilGas.t.sol` and `make solidity-gas` run
`FOUNDRY_PROFILE=gas forge snapshot --match-contract Gas` twice (isolated calls, real verifiers,
worst case `n = t = 16` unless stated): under **Osaka** (the `gas` profile's `evm_version`), the
EVM Gnosis runs, into `snapshots/council.json`, and with `--evm-version amsterdam` into
`snapshots/council-amsterdam.json`. Amsterdam is the execution layer of Glamsterdam, which Sepolia
runs since 2026-10-06 (block 11,856,337); Foundry 1.8.3's Amsterdam reproduces Sepolia receipts
exactly. The headless e2e suite measures the Osaka values from receipts on Anvil `--hardfork
osaka` (`tests/GAS.md`, regenerated on every full run); Anvil does not price Amsterdam's state
gas yet. `BENCHMARKS.md` summarizes both. Provenance: the `real_*` series of both snapshot files
are receipts from full realistic flows, not canned calldata — e.g. the v2
`real_n16_t16_deal_first` = 2,043,831 vs the canned deal's 1,286,634 — and the tables quote the
realistic series where they differ. The committed snapshot files hold the **v2** numbers; the v1
table stays as the baseline the v2 diet is judged against (its snapshots predate the merge).

| Call (v1, measured) | Osaka | Amsterdam | Dominated by |
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
1,530 per byte of deployed code (the v1 manager deployment with its views was ≈ 41.4M gas; the
v2 manager with views and ops carries ≈ 34.6 KB of runtime code, ≈ 55M to deploy). No opcode or
precompile was repriced, so each call grows with the new slots it writes: deal 50, finalize
`2t + 2n` = 64 (6.27M of its 9.05M), submitRequest 4 per field, submitPartial 2 per field, join
and the grants a few each (v1 counts; §1.5 tabulates the v2 counts). Combine writes at most one
new slot per four fields and moves by at most ≈ 5%. This repricing is what motivates the v2
slots-only diet: at 97,920 gas per new slot, every full point kept out of storage saves ~196k.

**Why Osaka costs more than Cancun.** EIP-7883 reprices the modexp precompile: with a 32-byte base
and modulus and a ~254-bit exponent, one call goes from ~1.35k to ~4.05k gas. The vendored
`BabyJubJub.sol` returns every affine `scalarMul` and `pointAdd` through one modexp inversion
(exponent `p − 2`), and `CouncilCurve.invModR` inverts mod `r` the same way for the Lagrange
coefficients, so each such curve operation costs ≈ 2.7k gas more: combine +7 to 8%. Finalize
inverts once in total and is unaffected; the verifier-bound calls (deal, submitPartial), the
subgroup checks of join and submitRequest (which stay in extended coordinates) and plain storage
are unchanged.

**The per-transaction limit.** Osaka caps one transaction at 2^24 = 16,777,216 gas (EIP-7825),
below Gnosis' 17M block limit, so that cap is the binding limit for one action; the largest v2
actions are a 4-field combine at t = 16 (7.45M) and submitRequest(16) (6.21M), finalize is 34k.
Under Amsterdam the 2^24 cap bounds execution gas only and state gas comes on top of it, from the
same gas limit; every Council action fits under 2^24 in total with room to spare
(submitRequest(16) 9.03M, 4-field combine 7.55M). The relayer adds 20% headroom to its estimates
and caps gas limits at 2^24 on Osaka chains and at the block gas limit on state-gas chains
(`COUNCIL_STATE_GAS`, docs/relayer.md); the v1 affine finalize, 17.24M under Amsterdam, was the
one action that ever needed the latter.

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

1. **finalize inverts once** (v1). It sums each `A_k` over QUAL, evaluates every `PK_m` by Horner
   and converts all `t + n` points to affine with one modexp inversion. Storage, events, ABI and
   outputs are those of the affine implementation: `CouncilFinalizeDiff.t.sol` runs both on the
   same stored dealings (a test-only copy of the affine one is the oracle) for every
   `1 <= t <= n <= 16` and random QUAL masks, forcing identity commitments, duplicate and
   opposite points, cancellations, identity aggregates and identity member keys, and compares
   every aggregate, member key, padding slot, the phase and the event. Since the formulas are
   complete, a zero `Z` is unreachable from on-curve points; the batch inversion still reverts
   `InvalidPoint()` on one instead of inverting 0, which would store `(0, 0)` for every key.
   In **v2** the same machinery relocates (protocol §8.3/§8.4): the extended-coordinate fold and
   its one batch inversion run inside each `deal` (over `t` points, not `t + n`), `getMemberKey`
   runs Horner in a view, and finalize keeps only the `A_0` identity check — the §7 aggregation
   differential replaces `CouncilFinalizeDiff` as the oracle test.
2. **No MSM in the MVP.** Combine evaluates `m_k·G + Σ λ_i·D_{i,k}` with independent
   `scalarMul` calls per term (measured 2.30M gas for one field at t=16 under Osaka in v2). The
   contract accepts 1 to 4 fields per combine call (`MAX_COMBINE_FIELDS = 4` stays the protocol
   maximum); the combiner keeps

   ```
   fieldsPerTx = min(4, max(1, floor(32 / t)))
   ```

   as its conservative gas guideline. It gives 2 fields per transaction at t = 16 (4.00M); even a
   full 4-field chunk at t = 16 (7.45M under Osaka, 7.55M under Amsterdam) fits comfortably, so
   the formula errs on the safe side for congested blocks. A shared-doubling Strauss MSM in
   extended coordinates would cut combine further; combine barely moved under Amsterdam, so it
   is not a priority.

At ~1 gwei the full **v1** lifecycle of a 16-member ceremony plus one 16-field decryption
measured about 108M gas ≈ 0.11 xDAI under Osaka: 16 deals ≈ 33M, eight 2-field combines ≈ 30M
and 16 partials ≈ 24M dominate, and the relayer pays all of it except bind and request (≈ 101M).
Under Amsterdam it was about 244M (≈ 231M relayer-paid): the deals (103M) and partials (69M)
write most of the new slots. Cost is not the constraint on Gnosis; per-transaction gas versus
the 2^24 cap is, and no action comes within half of it under Osaka.

**v2 (slots-only diet), measured.** Osaka figures are e2e receipts (`tests/GAS.md`, means over
the suite's samples) cross-checked against `snapshots/council.json`; Amsterdam figures are
`snapshots/council-amsterdam.json`; the realistic `real_*` series is quoted where it differs
from the canned calls. The Amsterdam state-gas portions are exact arithmetic on the §1.5 slot
counts: first deal 49 × 97,920 = 4,798,080; later deal 17 × 97,920 = 1,664,640;
submitRequest(16) 32 × 97,920 = 3,133,440; finalize 0.

| Call (v2, measured) | Osaka | Amsterdam | What changed vs v1 |
|---|---|---|---|
| createCeremony (16 invites) | 488k | 2.07M | unchanged shape (the policy packs into existing slots) |
| join | 521k | 883k | one fewer new slot (compressed key) |
| closeRegistration (n=16) | 200k | 385k | + roster re-supply and authentication |
| closeRegistrationScheduled (n=16) | 193k | 377k | new (permissionless, time-based) |
| deal, first dealer | 2.04M | 6.36M | +2t-point aggregation copy + roster auth; 49 new slots |
| deal, later dealer | 1.54M | 3.27M | folds into warm aggregate slots; 17 new slots |
| finalize | 33,923 | 35,123 | A_0 identity check + phase flip; **zero** new slots (v1: 3.42M / 9.05M) |
| abort | 34k | 36k | unchanged |
| openDecryption | 58k (41k with a fallback date) | 141k | fresh-slot nuance below |
| allowAdapter / authorizeCreator | 59k | 141k | unchanged |
| bindProcess | 170–191k | 692k | unchanged |
| submitRequest (16 fields) | 6.21M | 9.03M | same subgroup checks; 32 compressed words (v1: 6.92M / 12.54M) |
| submitPartial (16 fields) | 978k mean, 1.00M max | 1.14M | hash + packed block instead of 32 D slots; +C1 auth (v1: 1.52M / 4.34M) |
| publishPartialData | 63–74k | 85k | new: hash + event + packed block update |
| combine (t=16, 2 fields) | 4.00M | 4.01M | +t re-supplied D vectors + hash re-checks + C2 auth (v1: 3.81M / 3.80M) |
| combine (t=16, 1 / 4 fields) | 2.30M / 7.45M | 2.39M / 7.55M | |

Two footnotes the table hides. `openDecryption` on a Manual ceremony **without** a fallback date
writes slot 2 (`decryptionOpenAt`/`fallbackAt`/`manualOpenedAt`) from zero — a fresh-slot
SSTORE, 56–58k; with a fallback date the word is already nonzero and the open costs 41k. And
combine's growth over v1 is the storage diet's deliberate price: at t = 16 the re-supplied
`partialVectors` are 16,384 bytes of calldata, ≈ 260k gas per call (protocol §10.3), plus the
hash re-checks and the C2 authentication — in exchange submitPartial stopped writing 32 D slots.
At the small end (`n = 5, t = 3`): first deal 401k / 1.46M, later 311k / 883k, a 4-field combine
1.23M / 1.33M (Osaka / Amsterdam).

Whole v2 lifecycle (16-member ceremony + one 16-field decryption, eight 2-field combines):
**≈ 88M under Osaka** ≈ 0.09 xDAI at 1 gwei — 16 deals ≈ 25M, the combines ≈ 32M, 16 partials
≈ 15.6M, 16 joins ≈ 8.3M, the request 6.2M; the relayer pays all of it except bind and request,
≈ 82M — and **≈ 133M under Amsterdam** (≈ 123M relayer-paid; the deals 55M and combines 32M
dominate). Against the v1 lifecycle (108M / 244M) the Amsterdam total roughly halves, exactly as
budgeted: finalize dropped its 6.27M of state gas, 15 of 16 deals write only warm aggregate
slots, and the partials stopped storing D. Every action stays far under the 2^24 cap on both
forks. The §9 re-measurement release gate is met; `make e2e` keeps `tests/GAS.md` and the
snapshot files current.

**Milestone 2 (deferred): code-data storage.** Writing cold read-mostly vectors (recovery slices,
compressed ciphertexts) as STOP-prefixed CREATE contracts and reading them back with EXTCODECOPY
was evaluated with a dedicated gasbench; it is **not** in milestone 1 because under Osaka it only
wins above ~4 words and under Amsterdam above ~5–6, and it costs a second trust surface
(`DataStoreFailed()` / `BadDataStore()` errors reserved, §1.4). Measured write costs per vector of
W words (Osaka SSTOREs vs code+pointer / Amsterdam SSTOREs vs code+pointer): W=4:
89,462 / 80,141 and 441,142 / 503,361; W=6: 134,186 / 90,747 and 661,694 / 601,309; W=8:
178,910 / 101,399 and 882,246 / 699,399; W=16: 357,734 / 157,037 and 1,764,454 / 1,091,049;
W=32: 715,430 / 259,567 and 3,528,870 / 1,874,635. Reads cost one cold EXTCODECOPY
(~3,300–4,300 gas). Milestone 2 is gated on the measured post-v2 EIP-170 headroom (§1.7:
2,799 B on the manager) and on these savings re-measured against the implemented v2 layout.

## 2. Circuits

**v2 changes neither circuit** (protocol §8.5): public inputs stay full coordinates supplied in
calldata, so the `circuits-v1` artifacts, vkeys and `circuitReleaseId` are reusable by a v2
deployment as-is — provided the pins match — and the production multi-party phase-2 setup below
is still required before any production deployment, v2 or not.

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
draft by the `Publish Circuits` workflow, and copied with the vkeys and `release.json` to the
DAVINCI CDN (`https://davinci-assets.fra1.cdn.digitaloceanspaces.com/council/circuits-v1/`), which
the SDK and the scripts try first. Browsers can read the CDN only through its CORS rule and never
the GitHub release (its downloads redirect without CORS headers), so a hosted app also serves the
files from its own origin and lists that copy first. The `circuitReleaseId` sha256 inputs are the published
vkey JSON files, byte-exact — never re-serialized; for `circuits-v1` the id is
`0x071a01deb1e9b5e5e1da302df14be234c5ee5b91603d7f0437852dbf1c665301` (§1.6). Locally the six
files live in `~/.davinci-dkg-council/artifacts/` (`COUNCIL_ARTIFACTS_DIR`), where
`make circuits-restore`, the SDK's real-prover tests, the e2e suite and `make dev` find them.

Artifact distribution follows davinci-sdk's `src/prover/artifacts.ts` pattern: the SDK exports a
record keyed by vkey hash mapping to `{wasm: {url, sha256, mirrors}, zkey: …, vkey: …}` (`url`
on the CDN, `mirrors` the GitHub release), every file stream-verified against its pinned sha256
before use, cached in the browser via the Cache API (zkeys are tens of MB; the app shows download
progress and keeps them across sessions). The download locations are overridable (app mirrors,
local e2e); the sha256 pins are not.

## 3. DAVINCI integration

Target: davinci-contracts at the deployment lineage of commit `36c0b0a`, davinci-sdk 2.x,
davinci-sequencer current main. The registry redeploy this requires is already planned for the
aid-squatting fix (davinci-dkg issue #14). All file:line references below are at `36c0b0a`.
Working state: implemented on the (as yet unpushed) `council` branches of davinci-contracts,
davinci-sdk and davinci-sequencer — the headless suite's DAVINCI round trip
(`tests/tests/davinci.test.ts`) drives a real registry, CouncilAdapter and manager through the
gate on both the zero and nonzero result paths; davinci-sdk's `source.json` and Anvil defaults
point at the unpushed contracts commit, so local work sets `DAVINCI_CONTRACTS_DIR`. The names are fixed across
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
- **The decryption gate (v2, protocol §8.7).** The adapter exposes
  `isDecryptionOpen(bytes12 cid) external view returns (bool)` (a proxy of the manager view),
  and the registry consults it for COUNCIL processes at the two places results can be produced:
  - `requestResultsDecryption` (line 562): its **all-zero fast path** — every accumulator field
    identity, `n == 0`, results finalized immediately without any DKG round trip — must **not**
    run before the gate opens for a COUNCIL process. The registry records the ENDED state and
    returns without finalizing (no revert: ending a vote is always legitimate); the zero-path
    finalization happens on a later permissionless call once `isDecryptionOpen` is true.
  - `finalizeResultsFromDKG` (lines 665–667): for COUNCIL, requires `isDecryptionOpen` on
    **both** the zero and nonzero paths, reverting with the vendored `DecryptionNotOpen()`
    otherwise. On the nonzero path this is belt-and-braces — the manager refuses partials and
    combines while closed, so `plaintexts` cannot be `ready` — but the zero path produces results
    without the manager ever being consulted, so there the registry's check is the only gate.
  Non-COUNCIL modes are untouched: the gate logic lives behind `keyMode == COUNCIL` only.
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
function isDecryptionOpen(bytes12 cid) external view returns (bool);  // manager proxy (v2 gate)
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
  - Results reporting: a Council process whose vote has ended but whose §8.7 gate is still
    closed is surfaced as the dedicated **`awaiting-opening`** results state — not an error and
    not `decrypting` — until `isDecryptionOpen` flips (`tests/tests/davinci.test.ts` asserts the
    transition through the CLI).
- Vendored ABIs: add CouncilManager + CouncilAdapter ABIs the way IDKGManager/IDKGAppManager
  are vendored today.

### 3.3 davinci-sequencer

- `src/web3/mod.rs` (lines 93–116): add `KeyMode::Council = 3` to the enum, `TryFrom` and the
  serde name (`"council"`).
- `src/actor.rs` (lines 2619–2625): the non-sequencer branch already drives
  `requestResultsDecryption`/`finalizeResultsFromDKG`; include Council in it. The readiness
  poller must treat a closed gate as **pending, not failed**: `finalizeResultsFromDKG` reverting
  `DecryptionNotOpen()` (and `dkg_results_ready` returning false while the gate is closed) means
  "retry later", **indefinitely**, on the same backoff as missing partials — never a terminal
  failure, because a Council vote may open its results weeks after it ends, by policy
  (protocol §8.1).
- `src/contracts.rs` (lines 735–744): `dkg_results_ready` must select the adapter by key mode
  instead of assuming the DKG adapter, and for Council must AND in `isDecryptionOpen`.
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
| `codec` | protocol §2.5 compressed-point codec: compress, decompress via Tonelli–Shanks (`v₂(p−1) = 28`, the `(p+1)/4` shortcut is invalid on this field), strict decode (bit 254, `x ≥ p`, non-residue rejection), the pinned example words as self-test vectors |
| `keys` | mnemonic generation/restore, HKDF DeriveScalar, all §5.2 derivations, recovery-kit build/parse/verify |
| `invites` | capability derivation, link build/parse (`#v1.<id>.<hex>`), Invite struct signing |
| `eip712` | typed-data builders + signers for every §7.2 struct, payload hashes |
| `client` | viem-based reads over the §1.2 views (decompressing through `codec`), multi-RPC verification helpers, `getPolicy` / `isDecryptionOpen`, `getPartialRequestSnapshot`, `verifyRestoredIdentity`, `verifyRequestBinding` (from `requests`), `scanEvents` (from `logs`) |
| `requests` | request enumeration (`getRequestCount` + `getRequestIdsPage`) and the vote a request belongs to (`getRequestOrigin`, confirmed by `getBinding`, `isAdapterAllowed`, `isCreatorAuthorized` and the recomputed request id), all at one authenticated anchor |
| `logs` | paged `eth_getLogs` scanner for cosmetic discovery: bounded ranges (10,000 blocks by default), halved on a provider's range or result-cap refusal, a resumable cursor (`LogScanner`), the next provider on any other failure, an incomplete result instead of an exception |
| `dealing` | coefficient/ephemeral derivation, shares, masks, witness build, proof via worker; fetches + decompresses the roster for the `rosterKeys` calldata |
| `recovery` | §8.6 share recovery with all mandatory checks, fed by `getAggregates` + `getRecoverySlice` (compressed E decompressed and locally revalidated before ECDH; `PK_i` by local Horner cross-checked against `getMemberKey`) |
| `partial` | §9.3 pre-checks (including the §8.7 gate: refuses to compute while `isDecryptionOpen` is false), D computation, witness, proof (`buildPartialDecryption`) |
| `combine` | BSGS dlog (≤ 2^40, table size/precompute configurable), Lagrange, combine calldata; D-vector sourcing per protocol §10.4: local cache keyed `{chainId, manager, requestId, index, dataHash}` → single-block `eth_getLogs` at the stored `publishedBlock` → `publishPartialData` calldata for the caller's own index |
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
  state, the phase policy and the §8.7 gate, local roster-hash and `ctx` recomputation,
  ciphertext decompression + subgroup re-checks). The snapshot **refuses to build while
  decryption is closed**: honest clients never hold a computed partial before the opening
  (protocol §8.7).
- `CouncilClient` construction enforces the §9.3 RPC rule: at least two RPC URLs, rejected as
  duplicates after normalization (scheme/host lowercased, trailing slash dropped); a single URL
  is accepted only with an explicit `devMode` flag, and `devMode` itself is refused unless the
  chain id is a local one (31337/1337). Every provider's reported chain id must equal the
  pinned deployment's.
- Recovery verification: `CouncilClient.verifyRestoredIdentity` checks a restored root against
  chain state; `kit` exports `kitEntryIdentity(root, entry)` and
  `rehearseEntry(root, entry, expected?)` for the §5.3 rehearsal flow.
- No member-path reads logs. Restore, roster, recovery slices, shares, request ids and each
  request's vote binding come from views at the authenticated anchor (`readRequestBinding`
  refuses with a named reason: `other-ceremony`, `binding-mismatch`, `adapter-not-allowed`,
  `creator-not-authorized`, `not-submitted`). The one owner-approved exception is the
  **combiner's** D-vector fetch (protocol §10.4): a single-block `eth_getLogs` at the stored
  `publishedBlock`, authenticated by the stored `dataHash`, never a range scan — and the
  republication fallback makes even that non-essential. `scanEvents` and `LogScanner` exist for
  labels; they read from one provider at a time, unauthenticated, and their result must never
  gate an action. `getEvents` is kept for compatibility, pages the same way and throws when it
  cannot complete.
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
  { "action": "createCeremony" | "addInvites" | "closeRegistration" |
              "closeRegistrationScheduled" | "join" | "deal" |
              "allowAdapter" | "authorizeCreator" | "openDecryption" | "submitPartial" |
              "finalize" | "abort" | "combine" | "publishPartialData",
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
                 // the relayer reads the roster from state and builds rosterKeys itself
  submitPartial: message = Partial fields; signatures = [sig];
                 payload = { "D": string[16][2], "proof": { … } }
                 // C1 likewise built by the relayer from state (decompressed, authenticated
                 // on chain against the stored words)
  finalize/abort/closeRegistrationScheduled:
                 payload = { "ceremonyId": "0x…24hex" }; message/signatures absent
                 // rosterKeys for either close variant built by the relayer from state
  openDecryption: message = OpenDecryption fields; signatures = [orgSig]; payload absent
  combine:       payload = { "requestId": "0x…", "memberSet": number[],
                             "fieldIndexes": number[], "plaintexts": string[],
                             "partialVectors": string[][16][2] }   // C2 built from state
  publishPartialData: payload = { "requestId": "0x…", "participantIndex": number,
                                  "D": string[16][2] }
  other signed actions: message = the struct fields; signatures = [orgSig]; payload absent
  -> 4xx/5xx { "error": CODE, "detail": "...", "revertData": "0x..?" }

GET /v1/status/:txHash -> { "status": "pending" | "confirmed" | "failed",
                            "blockNumber"?, "revertReason"? }
GET /v1/health         -> { "ok": true, "chainId", "manager", "relayer", "balanceWei" }
GET /v1/metrics        -> 200 while no alert fires, 503 otherwise, full body either way
                          (balance, budget, transaction/worker/RPC state; cached 15 s —
                          what to point an uptime check at, docs/relayer.md "Monitoring")
POST /v1/track         -> { "chainId": "100", "manager": "0x…", "ceremonyId": "0x…24hex",
                            "validUntil"?: "<unix seconds>", "signature"?: "0x65-byte" }
                          -> 200 { "ceremonyId": "0x…", "tracked": true }
```

`POST /v1/track` registers a ceremony with the combine worker so its decryption is served from
contract state, independent of log discovery (§5.2). It is authenticated by
`Authorization: Bearer <token>` (a `COUNCIL_API_TOKENS` entry; `validUntil`/`signature` omitted)
or by the ceremony organizer's EIP-712 signature over
`TrackCeremony(bytes12 ceremonyId, uint64 validUntil)` in the **relayer's own domain** (name
`"DAVINCI DKG Council Relayer"`, version `"1"`, chain id, manager as `verifyingContract` — never
the protocol's §3-era domain, so a track signature cannot be replayed as a protocol action). The
SDK exports the domain and types (`trackDomain`, `TRACK_TYPES`) plus `signTrackCeremony` and
`RelayerClient.track` / `RelayerPool.track`; tracking is idempotent, validated at the head
(ceremony exists, not aborted, organizer signed, sponsored in restricted mode), and answers 404
when the combine worker is disabled.

Error codes: `INVALID_ACTION`, `BAD_SIGNATURE`, `WRONG_CHAIN`, `UNSUPPORTED_MANAGER`,
`SIMULATION_REVERTED` (with decoded custom error when possible), `RATE_LIMITED`, `TX_FAILED`,
`INTERNAL`; the full list (including `UNAUTHORIZED`, `NOT_FOUND`, `NOT_SPONSORED`) is in
docs/relayer.md "Error codes".

### 5.2 Behavior

- **One v2 manager per relayer**: at boot the relayer reads `protocolVersion()` from
  `COUNCIL_MANAGER_ADDRESS` and refuses to start unless it is 2 — a v1 manager (no gate view,
  different action surface) is never served.
- **Simulate before send**, always (`eth_call` with the exact calldata from the relayer's
  address); a reverting action is rejected with the decoded error and costs nothing. The relayer
  performs no semantic validation beyond simulation — the contract is the validator.
- Nonce handling: in-memory allocator over the relayer account, initialized from
  `pending` nonce at boot, serialized sends per account, gap repair by resync on
  `nonce too low/high`. Fee bumping with a capped max fee (`COUNCIL_MAX_FEE_WEI`).
- **No database.** Chain state is the only truth; `/v1/status` is a thin
  `eth_getTransactionReceipt`. What persists under `COUNCIL_DATA_DIR` is operational only: a
  state file (budget window, quotas, sponsorship counters and backoffs, the scheduler's watch
  set) and the partial-data cache directory `<chainId>-<manager>-partials/`. Losing both loses
  nothing on chain — the budget window resets and §10.4 re-sources the vectors.
- **Scheduler** (`COUNCIL_SCHEDULER_ENABLED=true`, own cadence `COUNCIL_SCHEDULER_POLL_MS`): the
  relayer services due permissionless transitions — it calls `closeRegistrationScheduled` when
  `scheduledRegistrationCloseDue` turns true (Scheduled mode or a Manual expiry) and `abort` when
  an abort predicate holds, both found by polling the §1.2 views on ceremonies it has relayed
  for. Each due transition is sent at most once: one that failed on chain is not paid for again.
  No keeper is *required* (anyone can call both); the relayer is a convenience. There is no
  transaction to send for decryption opening — the §8.7 predicate flips by itself — so the
  scheduler just logs the gate opening and the combine worker **parks** gated work: a request
  whose ceremony's `isDecryptionOpen` is false costs one view read per poll and nothing else.
- **Combine worker** (`COUNCIL_COMBINER_ENABLED=true`): polls incomplete requests that have
  ≥ t partials **and an open gate**, runs the SDK BSGS natively (≤ 2^40 bound; precomputed
  baby-step table kept in memory), submits combine chunks, backs off on `FieldCompleted` races
  (another combiner won — fine, the operation is permissionless and idempotent in effect). It
  serves **tracked** ceremonies from contract state: their request ids come from
  `getRequestCount` + `getRequestIdsPage`, so neither a restart months later nor a provider that
  pruned history loses a request. A ceremony is tracked once the relayer sponsored a decryption
  action for it, once the scheduler saw its gate open, once one of its requests turned up in a
  log, or when the app or the organizer registered it with `POST /v1/track` (§5.1; the app does
  this right after creating a committee, and the organizer dashboard retries until every
  configured relayer confirmed). The tracked list persists in the state file. Log discovery is a
  **convenience on top, never a dependency**: requests are also found from `RequestSubmitted`
  logs in `COUNCIL_LOG_RANGE`-block ranges from `COUNCIL_START_BLOCK`, halving the range for good
  when the provider refuses one, and a failed or pruned scan must not block work on requests the
  relayer already knows about.
  D vectors are sourced per protocol §10.4, in order: the relayer **caches every vector it
  relays** (submitPartial, publishPartialData, combine) keyed `{requestId, index, dataHash}`,
  one file each in the partials directory, until the request completes; a miss falls back to the
  single-block `eth_getLogs` at the stored `publishedBlock` (and caches the result). Every
  cached vector is re-checked against the on-chain `dataHash` before use.
- **Republication sponsorship is bounded** (protocol §10.4): the relayer relays
  `publishPartialData` only for incomplete requests whose vector it cannot produce from its
  cache or from the stored `publishedBlock` log — otherwise the request is refused as
  `NOT_SPONSORED` ("nothing to re-publish") — with per-(request, member) backoff, so a same-data
  refresh loop cannot drain the relayer. Self-paying callers are unrestricted by design.
- Rate limiting per IP and per action type; CORS restricted to the app origins.

Env (the full reference is `docs/relayer.md`): `COUNCIL_RPC_URL` (comma-separated fallbacks),
`COUNCIL_MANAGER_ADDRESS`, `COUNCIL_PRIVATE_KEY`, `COUNCIL_PORT`, `COUNCIL_DATA_DIR`,
`COUNCIL_COMBINER_ENABLED`, `COUNCIL_SCHEDULER_ENABLED`, `COUNCIL_MAX_FEE_WEI`,
`COUNCIL_CORS_ORIGINS`, `COUNCIL_RATE_LIMIT`.

## 6. End-user app

React + Vite + Tailwind v4 in `ui/`. No third-party scripts, no analytics, no wallet connectors:
keys are in-browser only and invisible.

Runtime configuration comes from `ui/public/config.json`, served as `/config.json` (the pattern of
davinci-dkg's explorer); `scripts/render-ui-config.sh` writes it from environment variables for an
image build (`ui/Dockerfile`, `ui/.do/`):

```json
{ "chainId": 100, "manager": "0x…", "rpcUrls": ["https://…", "https://…"],
  "relayerUrls": ["https://relayer-1.…", "https://relayer-2.…"],
  "artifactsBaseUrls": ["https://mirror-1.…/{release}", "https://mirror-2.…/{release}"],
  "deploymentBlock": 11857219,
  "legacyDeployments": [{ "manager": "0x…", "deploymentBlock": 123,
                          "relayerUrls": ["https://…"], "label": "2026 rehearsal" }] }
```

`deploymentBlock` is where label scans start when the organizer's device did not record its
committee's creation block; `logChunkBlocks` (optional, default 10,000) sets their range.

`rpcUrls` must list at least two independently administered providers on a production chain —
protocol §9.3's authenticated-read rule depends on it; a single entry is accepted only together
with an explicit local/dev declaration (e.g. Anvil, chainId 31337).

`relayerUrls` lists the deployment's relayers, tried in order: the next one is asked when one is
down, busy, out of budget or not sponsoring the action, while a refusal of the action itself
(bad signature, simulation revert) is final — relayers add no trust, so any of them may carry an
action. Empty means no relayer: direct sending, dev mode only.

`artifactsBaseUrls` lists mirrors for the six pinned circuit files, tried in order; every copy is
stream-verified against the SDK's sha256 pins (which are **not** configurable), so any mirror is
as good as the canonical release — a mirror that is down or serves bytes that do not hash to the
pin is skipped. `{release}` in an entry is replaced with the deployment's release tag at download
time, so one mirror layout serves several releases. Empty means the SDK's own locations (the
CDN, then the GitHub release).
[hosting.md](hosting.md) is the policy for how many mirrors and relayers a production deployment
needs.

`legacyDeployments` lists older managers **on the same chain** whose committees this copy still
serves: kits and links made before a redeploy keep working on the same origin. Each entry names
the manager, its deployment block (label scans only) and its own relayers (a relayer serves one
manager; an empty list means nothing can be sent for its committees), plus an optional
display-only label. Reads use the app's `rpcUrls`; new committees are only ever created on the
top-level `manager`.

The optional `davinci` object pins the DAVINCI Elections connection
([davinci-integration.md](davinci-integration.md#davinci-elections-pairing)):
`{ "registry": "0x…", "electionsOrigins": ["https://elections.davinci.vote"] }` — the DAVINCI
ProcessRegistry the app reads `councilAdapter()` from, and the allowlisted Elections servers
(bare `https` origins; `http` only in dev mode). A zero registry validates and leaves the
connection off (for deployments without an Elections server; the committed Gnosis config pins
the production registry). When pinned, the organizer dashboard's
"Connect to DAVINCI Elections" card (`ui/src/components/DavinciConnectCard.tsx`,
`ui/src/lib/davinci.ts`) turns a one-use pairing code into the two grants, failing closed on any
deployment mismatch before anything is signed.

The older single-URL keys `relayerUrl` and `artifactsBaseUrl` (one URL or `null`) are still
accepted and are merged ahead of their list counterparts, so an existing config keeps working
unchanged. `scripts/render-ui-config.sh` renders all of these from environment variables
(`RELAYER_URLS`, `ARTIFACTS_BASE_URLS`, `LEGACY_DEPLOYMENTS`, `DAVINCI_REGISTRY`,
`ELECTIONS_ORIGINS`, and the older singular forms);
`bash scripts/render-ui-config.test.sh` checks both directions.

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
- **Unlock results**: lists open requests from state (`getRequestCount` + `getRequestIdsPage`),
  each with the vote it belongs to read from the request record and authenticated (never from
  logs); runs §9.3 checks; computes the partial proof; one relayed action. Live mode again covers
  "stay on this page and we'll do it when it's time".
- **Recovery**: import kit or words; re-derive; verify against chain; show every ceremony in the
  manifest with its status.
- **This device**: the member's page says whether the browser keeps this site's data
  (`navigator.storage.persisted()`) and offers to ask again; the join kit step, the
  "contribution is in" card and the recovery-kit card all say to keep the twelve words until the
  results are opened.

### 6.4 Local storage model

Per origin, in IndexedDB (database `council`):

```
vault        council.root.v1: the root mnemonic, AES-GCM encrypted under a non-extractable
             WebCrypto key that lives only in this store (council.root.key.v1)
ceremonies   per-ceremony records: role, cid, chainId, manager, inviteId, participantIndex,
             the approved roster hash, live mode, kit-export bookkeeping, pending actions,
             organizer: a block at or before the committee's creation (where label scans start)
labels       organizer-only: invite and vote label maps (names), never transmitted
```

Local storage is a cache; the recovery kit is the source of truth. Clearing the browser loses
nothing that the kit (or the twelve words plus the committee link) and chain state cannot
restore. Browsers do clear it: "best-effort" site data is evicted under storage pressure, and
Safari deletes all script-written storage of a site after about seven days of use without a visit
to it, while a member may next open the app months after contributing. The app therefore calls
`navigator.storage.persist()` whenever it stores a root (not awaited; Chrome decides by engagement,
Firefox asks the person, Safari grants it only to home-screen apps; a refusal or a missing API is
handled and only changes what the member's page says) and tells members, plainly and repeatedly,
to keep the twelve words until the results are opened.

### 6.5 Copy rules

Plain language throughout; the app never says "wallet", "gas", "sign", "transaction", "key pair",
"on-chain". It says: your recovery words, your contribution, unlock the results, the committee,
free for members (we cover the cost). Every irreversible step states its consequence in one
sentence before the button. Technical detail lives behind a single "details for auditors"
disclosure per screen, nowhere else.

### 6.6 Opening results months later

A committee's key is typically used long after the ceremony: a vote runs for weeks and the results
are opened after it ends, so a member may come back three to six months after contributing (three
months is about 650,000 blocks on Sepolia and 1.5 million on Gnosis), on a new device. Everything that
member needs is designed to work from current state through public RPCs:

- **Restore**: twelve words + the committee link → keys re-derived → `verifyRestoredIdentity`
  (views only).
- **Find the vote**: `getRequestCount` + `getRequestIdsPage`, then `getRequestOrigin` for each
  request, confirmed by `getBinding`, `isAdapterAllowed`, `isCreatorAuthorized` and the
  recomputed request id at one finalized anchor agreed by two providers (protocol §9.3 items 1 and
  3; the user approves exactly that process id, as before).
- **Recover the share and unlock**: roster, recovery slices, aggregates (hence `PK_i`), the phase
  policy and gate, and ciphertexts from views, the §9.3 snapshot, a browser proof, one relayed
  action. A Scheduled or fallback opening needs no one's transaction; a Manual one needs the
  organizer's single `openDecryption` (protocol §8.7 — set a fallback date to survive an absent
  organizer).

None of the **member's** path reads event logs, so none of it depends on how far back a provider
serves `eth_getLogs`, and none of it needs an archive node: every read is at the latest finalized
block. The log reads that remain are off the member path. The **combiner's** (protocol §10.4) is
bounded and optional: combine needs recent publication data — in the normal flow partials are
submitted at decryption time, so the combiner's cache or a single-block `eth_getLogs` at the
just-stored `publishedBlock` supplies the D vectors — and if both fail, returning members
republish deterministically via `publishPartialData`. The **relayer's request discovery** uses
logs only as a convenience (§5.2): known or supplied ceremony ids enumerate their requests from
state, and the app registers every committee it creates with the configured relayers via
`POST /v1/track` (retried from the organizer dashboard until each confirmed), so the normal case
never leans on a log scan. Other logs are left to labels (which invitation each member used, on the organizer's page), read through
the SDK's paged scanner from the committee's creation block when the organizer's device recorded
one, else from `deploymentBlock`; a scan that cannot finish leaves names out, nothing else.
`tests/tests/long-delay.test.ts` runs this path after 700,000 mined blocks (about six months)
through two RPC proxies that refuse `eth_getLogs` over 10,000 blocks and cap answers, and asserts
the restored members never asked for a log on their own path; the browser journey does the same
in the app.

What must still exist for results to open, however late:

1. **The chain state**: the CouncilManager, its views contract and both verifiers on a chain that
   keeps running, reachable through at least two independent RPC providers that serve the
   finalized block (no archive access needed).
2. **The app and its circuit files**: a copy of the app pinned to the deployment (or any client
   built from the protocol) and the six pinned circuit files at one of its `artifactsBaseUrls`
   (the CDN, the release, a copy on the app's origin); the app checks every byte against the
   SDK's sha256 pins, so any mirror will do.
3. **Someone to pay for the transactions**: the relayer (and its combine worker), or anyone
   sending the partials and the combine directly from a funded account; the combine needs no
   trust (§10.3 of the protocol), and a relayer restarted months later enumerates known
   ceremonies' requests from state and rescans logs only as discovery convenience.
4. **At least `t` members' twelve words** (or kit files) and the committee link. A member's
   browser storage is a convenience that may be gone; the words are not optional.
5. **The combine data** (v2 nuance, protocol §10.4): `t` matching partial `D` vectors through
   some transport — the submitters' caches, the relayer's, or the single-block log at each
   stored `publishedBlock`. This is a non-issue in the normal flow (the vectors are minutes old
   at combine time), and item 4 already covers the worst case: any `t` returning members
   regenerate theirs via `publishPartialData`. What v2 gives up is *unattended* completion after
   every preimage copy is lost; it never gives up recoverability.

Keeping items 1–3 alive for the life of every ceremony is the deployment operator's duty —
[hosting.md](hosting.md) is the policy (origins, mirrors, relayer standby, RPC rotation); item 4
is the organizer's — [organizer-guide.md](organizer-guide.md) (kit custody and the pre-opening
drill); protocol §11.4 tables the long-term risks behind both.

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

   v2 additions to this battery:
   - **Codec adversarial cases** (protocol §2.5), on every re-supplied-point entry (rosterKeys,
     C1, C2, E decode in the SDK): the same-compressed-word non-point `(G.x, G.y + 2)` (must
     fail on-curve before the word comparison), bit 254 set, `x ≥ p` and `x + p` aliases,
     `y + p`, a non-residue `x` (decode side), a torsion point whose compressed word differs, the
     zero word (must decode to `(0, p − 1)` and then fail subgroup admission — never identity),
     a valid point in the wrong roster position, and `-P` for `P` (same `x`, flipped sign bit —
     must mismatch). Each must revert `CompressedPointMismatch()` / `InvalidPoint()` /
     `NotInSubgroup()` for the **expected** reason.
   - **Aggregation differential**: incremental `A_k` folding at deal time against a v1-style
     batch oracle over stored per-dealer commitments (test-only), for all `1 ≤ t ≤ n ≤ 16`,
     random QUAL subsets, forced cancellations to the identity in intermediate and final
     aggregates, the `(x+1, y+1)` bias round trip, atomic rollback when a later check in the same
     deal reverts, and two dealers racing in one block.
   - **Partial-data hash adversaries** (protocol §10.2/§10.4): combine with a permuted member
     set vs vectors, a vector from another request / another chain-id domain, a truncated or
     padded field slice, a wrong member's vector under the right index, and `publishPartialData`
     with a mutated vector — all `PartialDataMismatch()`; a republication with the correct vector
     must update `publishedBlock` and nothing else.
   - **Scheduling matrix** (protocol §8.1/§8.7): all four mode combinations, each boundary at
     `deadline − 1 / deadline / deadline + 1` (join half-open, scheduled close due,
     `dealingDeadline = registrationDeadline + dealingDuration` never extendable by a late
     caller, decryption open, fallback open), uint64 overflow sums rejected at create
     (`BadSchedule()`), Manual-with-expiry auto-close with `joined ≥ t` vs abort below `t`,
     close-after-dealing-window → abort only, `openDecryption` in Scheduled mode → `WrongMode()`,
     second open → `AlreadyOpen()`, and gate-closed partials/combine/publish →
     `DecryptionNotOpen()`. Close and abort predicates asserted disjoint at every boundary
     instant.
4. **SDK unit tests** (vitest): all of `encoding`, `keys`, `invites`, `recovery`, `combine`
   against the vectors (including `codec.json`, `partialdata.json`, `schedule.json`, protocol
   §12); the Tonelli–Shanks decompressor against random points and every adversarial word above;
   BSGS against random exponents up to the bound.
5. **Headless e2e** (`tests/`): full lifecycle against Anvil pinned to `--hardfork osaka`
   (host Foundry v1.8.3 at `~/.foundry/bin` with `E2E_FOUNDRY=host`; the
   `ghcr.io/foundry-rs/foundry:stable` image otherwise), driven by the SDK in Node: create, 16
   joins, close, 16 deals with real proofs, finalize, bind via a mock adapter, request, t partials,
   combine, plaintext assertions; plus the abort paths, a DAVINCI round-trip using
   `tools/davinci-test` against locally deployed registry contracts, and the long-delay test
   (§6.6: 700,000 blocks later, restore from words and unlock through public-provider RPC limits,
   no member-path log read). A full run rewrites `tests/GAS.md`. v2 additions:
   - **Six-calendar-month delayed reveal, both scheduling modes**: ceremony created at
     `2026-10-06T12:00:00Z` (1791288000), decryption at `2027-04-06T12:00:00Z` (1807012800) —
     once with `decryptionOpenAt = 1807012800` (Scheduled: no transaction opens it) and once
     Manual with the organizer's `openDecryption` sent at that time (plus a fallback-date
     variant with the organizer absent). Both runs mine the ~700,000-block gap, restore every
     member from words only, and run behind RPC proxies that refuse old logs and receipts; the
     member path is asserted to perform **zero** historical reads, and the combiner only the
     single-block §10.4 exception. One variant deletes every cache and completes via
     `publishPartialData` republication alone.
   - **DAVINCI zero-result case** (§3.1): a COUNCIL process whose accumulator is all-identity
     ends before the gate opens; `requestResultsDecryption` records ENDED without finalizing,
     results stay unavailable until the gate, then a permissionless call finalizes the all-zero
     vector. The sequencer poller variant asserts `DecryptionNotOpen()` is treated as retry.
   - **Gas re-measurement**: the full run rewrites `tests/GAS.md` and both snapshot files, which
     back the §1.8 measured v2 table (the analytical budgets it replaced are retired).
6. **Browser e2e** (Playwright, `ui/e2e/`): organizer and participant journeys in a real browser
   against the `make dev` stack, including kit save/restore, the live mode, the
   invite-fragment stripping, and a restore-and-unlock after a 700,000-block gap with every
   device's RPC refusing `eth_getLogs` over 10,000 blocks (devices follow the chain's clock).
7. **Testnet dress rehearsal**: one full ceremony plus one bound DAVINCI process on Sepolia with
   real humans before any production use. The headless half is scripted:
   `scripts/sepolia/deploy.sh` and `scripts/sepolia/run.sh` deploy the pinned release and drive
   an n = 3, t = 2 ceremony through a local relayer with authenticated reads
   (`docs/deployments.md`).

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

## 9. Migration: v1 → v2

A v2 deployment is a **new manager**, never an upgrade: the storage layout, the external surface
and the EIP-712 domain version ("2") all change, and nothing on a v1 manager can be migrated in
place. v1 ceremonies finish their lives on the v1 manager; new ceremonies are created on v2.
There is no state-copy tool and none is planned — a ceremony is bound to its manager by `ctx` and
every signature in it.

What carries over unchanged:

- **The circuits** (§2): v2 changes neither circuit, so the artifacts, vkeys and
  `circuitReleaseId` are reused if the pins match. Never run `make circuits` merely to refresh
  fixtures — the setup is randomized and churns every pin. The production multi-party phase 2 is
  still outstanding and combines naturally with the v2 deployment: it produces a new
  `circuitReleaseId`, which forces a new manager anyway, so one deployment serves both.
- **Key derivation and recovery kits**: all §5.2 derivations and the kit format keep their v1
  tags (protocol §2.4); a kit written against a v1 ceremony stays valid for that ceremony.

What regenerates (generated files, never hand-edited):

- SDK/Foundry/circuit **vectors**: `eip712.json` (domain version "2", CreateCeremony,
  OpenDecryption), new `codec.json`, `partialdata.json`, `schedule.json`; `dealing.json` and the
  circuit vectors are reused as-is (protocol §12).
- Foundry **proof fixtures** (`TestInputs.t.sol` pattern): regenerated against the v2 calldata
  shapes from the *existing* zkeys — new calldata, same proofs where inputs are unchanged.
- The vendored `ICouncilManager.sol` in davinci-contracts, the SDK's hand-written ABI, and the
  relayer's action schemas.

DAVINCI ordering (§3), strict:

1. the davinci-sdk major release that understands key mode 3 ships first (old SDKs throw on the
   first mode-3 process they read);
2. the davinci-contracts registry redeploy with the COUNCIL mode and the CouncilAdapter bound to
   the **v2** manager (the v1 manager never gets an adapter: no gate view, different request
   surface);
3. the davinci-sequencer release with `KeyMode::Council` and the retry-on-closed-gate poller.

Council-side shipping order: contracts (the §1.7 size gate and the §1.8 re-measurement have
passed) → relayer (it must understand the new actions before the app emits them) → SDK release →
app. The relayer and app are versioned to one manager each; running a v1 and a v2 stack in
parallel during the transition is expected and harmless.

Release gates, all **met** on the merged implementation: the function-complete EIP-170 size
measurement (§1.7: manager 21,777 B, views 6,521 B, ops 6,345 B); the measured §1.8 table on
both forks, replacing the analytical numbers; the §7 batteries green, including both six-month
delayed-reveal runs and the DAVINCI zero-result case. Milestone 2 (code-data storage) ships, if
ever, as a further v3-style deployment gated on the measured v2 headroom and savings (§1.8).

## 10. Status

**v2 is implemented and tested end to end on Anvil**: contracts (manager + views + ops, §1.7),
the unchanged circuits, SDK, relayer (scheduler and partial-data sourcing), app, the DAVINCI
round trip against the `council` branches of davinci-contracts, davinci-sdk and
davinci-sequencer, and the §7 batteries including both six-month delayed-reveal runs and the
DAVINCI zero-result case. The §9 release gates are met: the §1.7 sizes and the full §1.8 gas
table are measured on the merged contracts. The v2 spec was adopted 2026-10-06 and the
implementation merged immediately after. The stack was audited in October 2026 — seven
independent reviews, no forgery or exploitable flaw, every finding fixed on `main`; scope,
method and the full finding list are in [audit-2026-10.md](audit-2026-10.md). Open before any
production use:

- a real multi-party phase 2 (§2), which means a new `circuitReleaseId` and a new manager —
  combined with the v2 deployment (the ceremony tooling is under `circuits/scripts/ceremony/`).
  Until then the development setup serves only the Gnosis production beta, whose owner accepted
  it for the beta (`docs/deployments.md`);
- the Sepolia **v2 redeploy** and dress rehearsal with real people: the current Sepolia manager
  (`docs/deployments.md`) is still protocol v1; `scripts/sepolia/deploy.sh` already verifies the
  v2 shape, including CouncilOps at the manager's second CREATE;
- the davinci-contracts registry redeploy with the COUNCIL key mode, shipped after the davinci-sdk
  major release that understands mode 3 (§3, §9);
- a public relayer and a CORS-enabled mirror of the circuit files for the app.

Out of scope for v2 (unchanged from v1 unless noted): notifications (e-mail/push), refund vault
or any on-chain gas economics, external wallets (MetaMask/hardware/ERC-1271/Safe), passkeys,
share refresh/resharing, `n > 16`, a Chaum–Pedersen no-circuit fallback profile, embedded DAVINCI
process creation in the app, persistent on-chain partial vectors (the explicit §10.4 non-goal),
and code-data storage (milestone 2).
