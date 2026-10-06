# DAVINCI DKG Council protocol, version 1

Status: normative specification. This document is the source of truth for the
Council circuits, the CouncilManager contract, the TypeScript SDK and the relayer. Independent
implementations that follow it must produce byte-identical hashes, signatures, public-input vectors
and on-chain encodings. Where this spec and an implementation disagree, the implementation is wrong.

Council is an invite-only threshold DKG: an organizer invites up to 16 people, each joins from a
browser with a key derived from a 12-word recovery phrase, each contributes one proven Feldman
dealing, and the contract aggregates the contributions into one ElGamal public key on BabyJubJub.
DAVINCI processes bound to the ceremony encrypt their tallies under that key; any `t` of the `n`
members can later decrypt the final accumulator, each with one small browser proof. There is no
complaint round, no acknowledgment round and no finalization proof: every dealing is proven correct
before it is accepted, so every member provably holds a valid share of every accepted dealing.

Design lineage: this spec instantiates the "B-circom" protocol proposal (internal design note,
2026-10-05)
with the project owner's binding decisions: capacity 16, one key per ceremony shared by its bound
DAVINCI processes, circom/snarkjs Groth16 for dealing and partial decryption, per-field exact
combine checks, no finalization circuit, circomlib twisted Edwards coordinates on the wire, and a
relayer funded off chain.

## 1. Notation and conventions

- `p` is the BN254 scalar field prime, which is both the circom native field and BabyJubJub's
  coordinate field. `r` is the prime order of BabyJubJub's large subgroup. All point coordinates
  are elements of `F_p`; all secret scalars, shares, polynomial coefficients and Lagrange
  coefficients are elements of `F_r`.
- Integers on the wire are unsigned, big-endian, ABI-encoded. "canonical" for a coordinate means
  `< p`; for a scalar, `< r`.
- `keccak256` is Ethereum Keccak-256. `abi.encode` is Solidity ABI encoding with the declared
  types, including the standard head/tail layout for dynamic arrays. TypeScript implementations
  must use an ABI encoder (e.g. viem `encodeAbiParameters`) with the exact same type list; ad-hoc
  concatenation is forbidden.
- Tagged hash: for a domain tag string `tag` and typed fields `f1..fk`,

  ```
  K(tag, f1..fk) = keccak256(abi.encode(keccak256(utf8(tag)), f1, .., fk))
  ```

  The tag hash is a `bytes32` and is always the first encoded word.
- `bytes12` values (ceremony ids) are ABI-encoded as Solidity `bytes12`: left-aligned in a 32-byte
  word, right-padded with zeros. `bytes31` (DAVINCI process ids) likewise.
- A `bytes32` value enters a circuit as two 128-bit limbs: `hi` = the big-endian integer of bytes
  0..15, `lo` = bytes 16..31. Never reduce a `bytes32` modulo `p`; the one exception is the
  share-mask constant in §2.4, whose reduction is part of its definition and whose value is pinned
  here.
- Points on the wire, in storage, in events, in circuit public inputs and in all hashes are in the
  **circomlib twisted Edwards form (TE)** as `(x, y)` pairs, each canonical in `F_p`. The reduced
  form exists only inside the contract's arithmetic (§2.2).
- Member indexes are one-based (`1..n`). Array slots are zero-based (`0..15`); slot `i` always
  corresponds to member `i+1`. Coefficient indexes `k` and ciphertext field indexes are zero-based.

## 2. Constants

### 2.1 Curve

BabyJubJub in the circomlib twisted Edwards chart: `a·x² + y² = 1 + d·x²·y²` over `F_p` with

| Constant | Value |
|---|---|
| `p` (coordinate field, circom native field) | `21888242871839275222246405745257275088548364400416034343698204186575808495617` |
| `a` (TE) | `168700` |
| `d` (TE) | `168696` |
| `r` (prime subgroup order) | `2736030358979909402780800718157159386076813972158567259200215660948447373041` |
| cofactor `h` | `8` |
| curve order `8·r` | `21888242871839275222246405745257275088614511777268538073601725287587578984328` |
| identity `O` | `(0, 1)` |
| generator `G` = circomlib `Base8` | `x = 5299619240641551281634865583518297030282874472190772894086521144482721001553` |
| | `y = 16950150798460657717958625567821834550301663161624707787222815936182638968203` |

`G` generates the prime-order subgroup. Every Council scalar multiplication is to base `G` or to
a base previously validated to lie in the prime subgroup. `r` has 251 bits; the generic discrete
log work factor is about `2^125`, and BN254's pairing security is commonly estimated below 128
bits. Do not describe Council as 128-bit secure.

### 2.2 TE <-> reduced-form map

The contract uses `solidity/src/libraries/BabyJubJub.sol`, vendored unchanged from the davinci-dkg
NI-DKG, which implements the reduced chart (`a = -1`) that the NI-DKG uses. The two charts are
isomorphic; only `x` is scaled:

```
x_reduced = mulmod(x_te, K, p)        K     = 15527681003928902128179717624703512672403908117992798440346960750464748824729
x_te      = mulmod(x_reduced, K_INV, p)  K_INV = 1911982854305225074381251344103329931637610209014896889891168275855466657090
```

`K² = -168700 mod p`; `K` maps `Base8` to the reduced-form generator
`(9671717474070082183213120605117400219616337014328744928644933853176787189663, Base8.y)` pinned
in `BabyJubJub.sol`. `y` is unchanged, the identity `(0, 1)` is fixed, scalars are unchanged, and
the map is a group isomorphism, so any group equation checked in the reduced chart holds in TE and
vice versa. The same constants live in davinci-contracts `src/libraries/BjjFormLib.sol`.

The contract converts **only** at these points, and nowhere else:

1. Join: `X_i` and the PoP nonce point `A` are converted TE -> reduced before
   `BabyJubJub.isInPrimeSubgroup` / `verifySchnorrEquation`.
2. Finalization: each stored `C_{j,k}` is converted TE -> reduced for the aggregation
   `A_k = Σ C_{j,k}` and the Horner evaluations `PK_i`; the resulting `A_k`, `P`, `PK_i` are
   converted back to TE before storage.
3. Request admission: each `C1_k`, `C2_k` is converted TE -> reduced for the on-curve and
   prime-subgroup checks (the stored request keeps the TE words).
4. Combine: `C2_k`, every selected `D_{i,k}` and `G` are converted TE -> reduced for the per-field
   group equation; nothing from this computation is stored.
5. Nowhere else. Storage, events, view functions, EIP-712 payload hashes, circuit public inputs
   and all `K(...)` transcripts use TE words exclusively. One `mulmod` per converted x-coordinate.

### 2.3 Sizes and bounds

| Constant | Value | Meaning |
|---|---|---|
| `MAX_N` | 16 | maximum committee size; dealing circuit recipient capacity |
| `MAX_T` | 16 | maximum threshold; dealing circuit coefficient capacity |
| `MAX_FIELDS` | 16 | ciphertext fields per decryption request; partial circuit capacity |
| `RESULT_BOUND` | `2^40` | exclusive upper bound on every combined plaintext |
| `MAX_COMBINE_FIELDS` | 4 | maximum fields per combine transaction |
| `MAX_INVITES` | 64 | maximum invites per ceremony (across create + add-invites) |
| `MIN_DEALING_DURATION` | 600 s | floor on the dealing window |
| threshold rule | `1 <= t <= n <= 16` | `t` fixed at creation, `n` frozen at close, close requires `n >= t` |

`RESULT_BOUND` is a protocol constant, not per-request data: with per-field exact combine checks
(§10) a tighter bound buys no soundness, and DAVINCI's own cap `maxValue·maxVoters <= 10^12` is
below `2^40`.

### 2.4 Domain tags

All Council domain strings carry the prefix `davinci-dkg-council/v1/`. The pinned tags and their
`keccak256(utf8(tag))` values:

| Tag | keccak256 |
|---|---|
| `davinci-dkg-council/v1/ceremony` | `0xecb738c07e6a59197a7fd9e2f5e6116948f75ddf4ac1167be6d353868161465f` |
| `davinci-dkg-council/v1/roster` | `0x2c9d4948616c1a88c354348793d30f18ea38d1f04ad5854da9e32746a3b11ac9` |
| `davinci-dkg-council/v1/deal-context` | `0xdbb35e5b108ffc795df6963925b9215f480adc307c37d7301c3e91d8e2b7bb7c` |
| `davinci-dkg-council/v1/deal-payload` | `0x1326b87fc239e1401c315964035b32e39ac95374aecd1472e03710d68890394e` |
| `davinci-dkg-council/v1/join-pop` | `0xf82c8d4d3410e2766e553a29e47765d8dca7d7bb5d3c8d1226c3736cb39bbb19` |
| `davinci-dkg-council/v1/request` | `0x2044a532478c345d057d687f1827a3c194b5c92d1c7471f6aa59fe10fe010ba7` |
| `davinci-dkg-council/v1/partial-payload` | `0x790ea2a939d8ccdf25ac8c84f7bffca5476a976d584b89ca4a7f365b8e85c589` |
| `davinci-dkg-council/v1/circuit-release` | `0x9e489062d0e615d54b9cf250918652a1541571f981e4892e70d382d1536fdf5c` |
| `davinci-dkg-council/v1/share-mask-poseidon` | `0xd8262d0eb7248e9458410cb71d8ace07c8eabd235f11ed9fb71812260a9dc8f2` |

The share-mask field constant is the only tag that is reduced into the field:

```
MASK_CONST = uint256(keccak256(utf8("davinci-dkg-council/v1/share-mask-poseidon"))) mod p
           = 10214054970402064552395134490408265161209242095674905809605444618984955431150
```

Key-derivation purpose labels (HKDF info, §5) use the prefix `davinci-dkg-council/v1/derive/` and are listed
in §5.2. Every pinned value in this section must appear in the cross-implementation test vectors.

## 3. Hashing primitives

### 3.1 HashToScalar

`HashToScalar(tag, f1..fk)` produces a uniform scalar in `F_r` by rejection sampling:

```
for counter = 0, 1, 2, ...:
    u = uint256(keccak256(abi.encode(keccak256(utf8(tag)), f1, .., fk, uint32(counter))))
    if u < LIMIT_R: return u mod r
```

with `LIMIT_R = floor(2^256 / r) · r = 42·r =
114913275077156194916793630162600694215226186830659824886409057759834789667722`. The rejection
probability per attempt is below 0.8%. Implementations (on chain and off) try counters 0 through
255 inclusive; exhausting them is an error (revert/abort), never a wraparound — unreachable in
practice. Challenges (join PoP) accept the value zero. Secret derivations never use HashToScalar;
they use the HKDF construction of §5.1, which applies the same rejection rule with per-modulus
limits.

### 3.2 Poseidon

Poseidon over `F_p` with the circomlib parameterization (the one implemented by
`circomlib/circuits/poseidon.circom` and by `poseidon-lite`). Council uses only the 7-input
instance, `Poseidon7`, for the share mask (§8.3).

## 4. Identifiers

### 4.1 Ceremony id

```
ceremonyId = bytes12(K("davinci-dkg-council/v1/ceremony",
    uint256 chainId, address manager, address organizer, uint64 nonce))
```

`bytes12(bytes32)` takes the 12 most significant bytes. `manager` is the CouncilManager address,
`organizer` the organizer's authorization address (§5.3), `nonce` a client-chosen `uint64` (the
SDK uses a random one). The client computes the id before creation; the contract recomputes it
from the signed CreateCeremony action and rejects a ceremony id that already exists or equals
`bytes12(0)` (in that event the organizer picks another nonce). The 96-bit truncation gives about
`2^48` birthday collision resistance; this is acceptable because ids are consumed one-shot on
chain and bound to chain, manager and organizer inside the preimage, so a collision only blocks
the colliding creation, never redirects an existing ceremony.

### 4.2 Participant index and invite id

Participants are numbered by join order: the first accepted join is member 1, the next member 2,
and so on; `n` is the number of accepted joins when registration closes. Indexes never change
afterwards; a member that fails to deal keeps its index and its shares. Invites are numbered
`inviteId = 0, 1, 2, ..` in the order their capability addresses are registered (CreateCeremony
order first, then each AddInvites in order).

### 4.3 Roster hash and dealing context

Frozen at close:

```
rosterHash = K("davinci-dkg-council/v1/roster",
    uint256 chainId, address manager, bytes12 ceremonyId,
    uint8 t, uint8 n,
    address[] authAddresses,      // index order, length n
    uint256[] pkxs, uint256[] pkys)  // X_i in TE, index order, length n

ctx = K("davinci-dkg-council/v1/deal-context",
    uint256 chainId, address manager, bytes12 ceremonyId,
    bytes32 rosterHash, bytes32 circuitReleaseId)
```

`ctx` enters the dealing circuit as limbs `ctxHi, ctxLo` (§1). It binds every dealing to the exact
chain, contract, ceremony, roster (including every recipient key, `t` and `n`) and circuit
release; a dealing replayed in any other context fails its mask equations.

### 4.4 Circuit release id

```
circuitReleaseId = K("davinci-dkg-council/v1/circuit-release",
    bytes32 sha256(deal_vkey_file), bytes32 sha256(partial_vkey_file))
```

The sha256 digests are over the released verification-key JSON file bytes, byte-exact as
published (never re-serialized, re-indented or re-encoded; see the architecture document's
artifact pinning). The value is an immutable constructor parameter of the CouncilManager; a
circuit release change therefore means a new manager deployment.

### 4.5 Request id and binding records

```
requestId = K("davinci-dkg-council/v1/request",
    uint256 chainId, address manager, bytes12 ceremonyId,
    address adapter, bytes31 processId)
```

A **binding record** is created when an allowed adapter binds a process (§9.1): keyed by
`(adapter, processId)`, it stores `ceremonyId`, the authorized `creator` passed by the adapter and
the derived `requestId`. A **request record** is created when the same adapter later submits the
ciphertexts (§9.2); exactly one request may ever exist per binding. The id namespace is
adapter-authorized, never first-come-first-served by arbitrary accounts, so the aid-squatting
class of the public DKG (davinci-dkg issue #14) does not exist here.

## 5. Keys, derivation and the recovery kit

### 5.1 Root and DeriveScalar

Each person has one root: 128 bits from `crypto.getRandomValues`, represented as a standard
12-word BIP-39 mnemonic (English wordlist, standard checksum and NFKD normalization). The BIP-39
seed is derived with an **empty passphrase**, fixed in v1. Let `S` be the 64-byte seed.

```
PRK = HKDF-Extract(SHA-256, salt = utf8("davinci-dkg-council/seed/v1"), IKM = S)

DeriveScalar(q, purpose, contextFields, allowZero):
    for counter = 0, 1, 2, ...:
        info = abi.encode(keccak256(utf8(purpose)),
                          keccak256(abi.encode(contextFields...)),
                          uint32(counter))
        u = uint256_be(HKDF-Expand(SHA-256, PRK, info, 32))
        if u >= floor(2^256 / q) * q: continue
        v = u mod q
        if v == 0 and not allowZero: continue
        return v
```

For `q = r`, the limit is `LIMIT_R` (§3.1). For `q = secp256k1n =
115792089237316195423570985008687907852837564279074904382605163141518161494337`,
`floor(2^256/q) = 1`, so the limit is `q` itself. Implementations must not substitute a bare
`mod q`. The counter is a `uint32` running `0 .. 2^32 - 1`; exhaustion is an error, never a
wraparound.

### 5.2 Derivation labels and contexts

Derivation version is `1` and account index defaults to `0` throughout.

| Purpose (`davinci-dkg-council/v1/derive/` + label) | Modulus | Context fields (`abi.encode` types in order) | Zero |
|---|---|---|---|
| `auth-secp256k1` | secp256k1n | `uint256 chainId, address manager, bytes12 ceremonyId, uint32 accountIndex, uint32 derivationVersion` | no |
| `share-encryption-bjj` | `r` | same as `auth-secp256k1` | no |
| `organizer-auth-secp256k1` | secp256k1n | `uint256 chainId, address manager, uint32 accountIndex, uint32 derivationVersion` | no |
| `invite-capability-secp256k1` | secp256k1n | `uint256 chainId, address manager, bytes12 ceremonyId, uint32 inviteId, uint32 derivationVersion` | no |
| `dealer-coefficient` | `r` | frozen context (below) + `uint8 k` | yes |
| `dealer-ephemeral` | `r` | frozen context (below) | no |

The dealer frozen context is
`uint256 chainId, address manager, bytes12 ceremonyId, uint32 accountIndex, uint32
derivationVersion, bytes32 rosterHash, uint8 dealerIndex, uint8 t, bytes32 circuitReleaseId`.

Participant keys per ceremony:

- authorization secret `d_auth` (purpose `auth-secp256k1`); the participant's **authorization
  address** is the Ethereum address of `d_auth`. It signs EIP-712 actions and holds no funds.
- share-encryption secret `x_i` (purpose `share-encryption-bjj`); `X_i = x_i·G` in TE is the key
  registered at join. `x_i` decrypts shares; it never signs actions and is never sent anywhere.

The organizer key (purpose `organizer-auth-secp256k1`) exists before any ceremony id does; the
ceremony id is derived from its address (§4.1). Invite capability keys are derived from the
**organizer's** root, so the organizer can regenerate any invite link at any time (the "nudge"
flow); handing a capability to an invitee discloses nothing about the organizer root. Dealer
coefficients and the ephemeral are derived deterministically so an interrupted proving session is
reproducible from the root plus public chain state; they depend on the full frozen context, so a
different roster, ceremony or circuit release yields unrelated values. Groth16 prover randomness
and any Schnorr nonce use the CSPRNG and are never derived from the root.

The registration/share-key separation is strict: `X_i` is the share-encryption key; the threshold
verification key `PK_i = s_i·G` exists only after finalization and is computed by the contract,
never registered.

### 5.3 Recovery kit

The kit is **data**, never executable. Two artifacts:

1. A printable sheet with the 12 words.
2. A versioned JSON file:

```json
{
  "format": "davinci-dkg-council-kit/v1",
  "private": {
    "mnemonic": "<12 words, single spaces>",
    "wordlist": "english",
    "derivationVersion": 1
  },
  "manifest": [
    {
      "role": "participant" | "organizer",
      "chainId": 100,
      "manager": "0x...",
      "ceremonyId": "0x...24 hex...",
      "accountIndex": 0,
      "authAddress": "0x...",
      "sharePublicKey": { "x": "<dec>", "y": "<dec>" },
      "participantIndex": 3,
      "rosterHash": "0x...",
      "circuitReleaseId": "0x...",
      "appUrl": "https://..."
    }
  ],
  "checksum": "0x..."
}
```

Manifest entries are role-specific: a `participant` entry requires `authAddress` and
`sharePublicKey`, with `participantIndex` and `rosterHash` optional until assigned (add them once
known); an `organizer` entry requires `authAddress` (checked on restore against the ceremony's
stored organizer) and carries no participant fields. Encoding is canonical: decimal strings for
`chainId` and point coordinates, fixed-width lowercase `0x`-hex for byte values, plain JSON
integers only for small bounded indexes. The checksum is

```
checksum = keccak256(abi.encode(string mnemonic, string jcsManifest))
```

where `mnemonic` is the exact `private.mnemonic` string and `jcsManifest` is the RFC 8785 (JCS)
canonical serialization of the `manifest` array as a UTF-8 string. v1 readers accept only
`wordlist: "english"` and `derivationVersion: 1` and reject anything else.

The manifest is public data; it exists because per-ceremony addresses make bare-mnemonic discovery
require scanning chain events, and because months-later recovery should not depend on the
organizer's website. The checksum detects corruption only; it is not authentication. On restore,
the SDK re-derives the keys and **must** compare `authAddress` and `sharePublicKey` against
authenticated chain state before using them (§9.3 item 1 defines authenticated reads); missing
participant metadata (index, roster hash) is derived from that chain state, never trusted from the
file. Before join, the rehearsal compares the re-derived keys against the locally prepared join
keys; after join, against chain state. The app must offer an updated kit export whenever the
manifest grows (a new ceremony, an assigned index). The file holds the root in plaintext with an explicit
warning (anyone holding the file can act as the participant); password-encrypted export is a v2
option, not v1. The join flow requires a recovery rehearsal: the app forces a kit download, then
requires re-entry/re-import and checks `x_i·G == X_i` and the derived address before the Join
action is signed.

Compromise of the root compromises every ceremony derived from it, past and future. There is no
share refresh in v1; treat the `< t` collusion bound as cumulative over the key's lifetime.

## 6. Invitations

The contract stores, per ceremony, an append-only array of **invite capability addresses** (the
Ethereum addresses of the capability keys) with a consumed flag each. CreateCeremony registers the
initial list; AddInvites (organizer-signed, Registration phase only and only while
`block.timestamp <= registrationDeadline` — an invite nobody could redeem must not be
registrable) appends more, up to `MAX_INVITES` total. AddInvites authenticates the appended
indexes: the signed struct carries
`firstInviteId`, the contract accepts it only if `firstInviteId` equals the current invite count,
requires `inviteKeys.length >= 1` and a resulting count `<= MAX_INVITES`, and element `k` of the
batch receives invite id `firstInviteId + k` (its capability key is derived with exactly that id,
§5.2) — so a replayed or reordered batch cannot shift ids. Every address must be non-zero and
unique across the union of all capability addresses ever registered for the ceremony
(`DuplicateInvite()` otherwise).

The invite link carries the capability secret in the URL fragment:

```
https://<app>/c/0x<ceremonyId 24 hex>#v1.<inviteId decimal>.<capability secret, 64 lowercase hex>
```

The fragment is never sent in HTTP requests, but it is visible to page JavaScript, extensions,
history sync and anyone who stores the message containing the link. The app removes it from the
address bar (`history.replaceState`) immediately after import and must not load third-party
scripts. An unredeemed link is a **bearer credential**: whoever opens it first can join as
themselves. No wrapper changes that; the mitigations are out-of-band delivery, organizer review of
the roster before closing, and participants refusing a roster they do not recognize.

At join, the invitee's browser signs the EIP-712 `Invite` struct (§7.2) with the capability key,
binding the capability to the invitee's fresh authorization address and `X_i`. A mempool observer
can replay the join transaction (harmless, idempotent-reverts) but cannot redirect it to another
participant or key without forging that signature. The capability is consumed by the accepted
join; a consumed invite never validates again.

## 7. EIP-712 actions

### 7.1 Domain and signature rules

The exact domain type string (no spaces after commas) and its type hash:

```
EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)
typehash = 0x8b73c3c69bb8fe3d512ecc4cf759cc79239f7b179b0ffacaa9a75d522b39400f
name = "DAVINCI DKG Council", version = "1", chainId = the real chain id,
verifyingContract = the CouncilManager address
```

Signature verification requires, with no exception: exactly 65 bytes `r || s || v`;
`v ∈ {27, 28}`; `1 <= r < secp256k1n`; `1 <= s <= floor(secp256k1n / 2)` (low-s); `ecrecover`
over the EIP-712 digest returns a **non-zero** address; and that address equals the expected
signer, which must itself be non-zero (organizer, stored invite capability address, or the
participant's registered authorization address). A zero recovered address (invalid signature)
must never compare equal to anything.

Replay protection is **one-shot by state plus expiry**, no sequential nonces: every action's
acceptance transitions state such that an identical second submission reverts (ceremony id exists,
invite consumed, participant joined, dealer dealt, partial accepted, adapter/creator already
listed), and every struct carries `validUntil` with the rule `block.timestamp <= validUntil`.
Cross-chain, cross-manager and cross-ceremony replays are excluded by the domain and the
`ceremonyId`/`requestId` fields. Identical relay by a third party is harmless by design: no action
has a beneficiary derived from `msg.sender`.

### 7.2 Typed structs

Exact `encodeType` strings (field names, types and order are normative):

```
CreateCeremony(address organizer,uint64 nonce,uint8 threshold,uint64 registrationDeadline,uint64 dealingDuration,address[] inviteKeys,uint64 validUntil)
AddInvites(bytes12 ceremonyId,uint32 firstInviteId,address[] inviteKeys,uint64 validUntil)
CloseRegistration(bytes12 ceremonyId,uint8 participantCount,uint64 validUntil)
AllowAdapter(bytes12 ceremonyId,address adapter,uint64 validUntil)
AuthorizeCreator(bytes12 ceremonyId,address creator,uint64 validUntil)
Invite(bytes12 ceremonyId,uint32 inviteId,address participant,uint256 pkX,uint256 pkY,uint64 validUntil)
Join(bytes12 ceremonyId,address participant,uint32 inviteId,uint256 pkX,uint256 pkY,uint256 popAx,uint256 popAy,uint256 popZ,uint64 validUntil)
Deal(bytes12 ceremonyId,uint8 dealerIndex,bytes32 payloadHash,uint64 validUntil)
Partial(bytes12 ceremonyId,bytes32 requestId,uint8 participantIndex,bytes32 payloadHash,uint64 validUntil)
```

Array fields hash per EIP-712 (keccak256 of the concatenated 32-byte encoded elements). Signers:
CreateCeremony, AddInvites, CloseRegistration, AllowAdapter, AuthorizeCreator by the organizer;
Invite by the invite capability key; Join, Deal, Partial by the participant's authorization key. A
Join submission carries two signatures (participant over Join, capability over Invite); the two
structs must agree on `ceremonyId`, `inviteId`, `participant`, `pkX`, `pkY`.

Payload hashes bind the heavy calldata that would be unwieldy as typed fields:

```
Deal.payloadHash = keccak256(abi.encode(
    keccak256(utf8("davinci-dkg-council/v1/deal-payload")),
    bytes32 ctx,
    uint256[2][16] C,          // commitment points, TE, identity padding for k >= t
    uint256[2] E,              // ephemeral point, TE
    uint256[16] masked,        // masked shares, zero padding for i >= n
    uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC))

Partial.payloadHash = keccak256(abi.encode(
    keccak256(utf8("davinci-dkg-council/v1/partial-payload")),
    bytes32 requestId,
    uint256[2][16] D,          // partial points, TE, identity padding for k >= fieldCount
    uint256[2] proofA, uint256[2][2] proofB, uint256[2] proofC))
```

The contract recomputes the payload hash from the actual submitted arrays and proof and rejects a
mismatch, so a relayer cannot substitute any component of a signed submission.

Groth16 proof word convention, pinned for both the payload hash and the calldata: the proof words
are exactly those of snarkjs `groth16.exportSolidityCallData`, i.e. `proofA = [pi_a[0], pi_a[1]]`,
`proofB = [[pi_b[0][1], pi_b[0][0]], [pi_b[1][1], pi_b[1][0]]]` (G2 limbs swapped relative to the
proof JSON), `proofC = [pi_c[0], pi_c[1]]`; projective coordinates are omitted. Field ranges:
BabyJubJub coordinates and masked shares (`C`, `E`, `masked`, `D`) are elements of `p` and the
contract rejects any such word `>= p`; Groth16 proof coordinates live in the BN254 **base** field
`qBN = 21888242871839275222246405745257275088696311157297823662689037894645226208583` (`> p`),
and the contract rejects any of the eight proof words `>= qBN` (`NonCanonical()`) before the
verifier runs, so the signed payload hash has exactly one encoding per proof — an implementation
must never reduce or reject proof words against `p`. Identifiers and payload hashes are plain
`bytes32` with no field bound.

### 7.3 Permissionless calls

`finalize(ceremonyId)`, `abort(ceremonyId)` and `combine(...)` take no signature: their validity
is a pure function of chain state, so the caller's identity is irrelevant. `bindProcess` and
`submitRequest` are authorized by `msg.sender` being an allowed adapter (§9), not by signature.

## 8. Ceremony state machine

```
enum Phase { None = 0, Registration = 1, Dealing = 2, Live = 3, Aborted = 4 }
```

Flow: `Registration -> Dealing -> Live`, terminal `Aborted`. `Live` never expires. `None` is the
zero-initialized storage value: **a ceremony exists iff `phase != None`**. Every state-changing
operation except creation must reject a nonexistent ceremony (`UnknownCeremony()`) before any
authorization check or storage change; creation must require `phase == None` and initialize the
ceremony atomically in the same transaction.

### 8.1 Create

`createCeremony(action, orgSig)` verifies the organizer signature, recomputes and claims the
ceremony id (§4.1, phase must be `None`), and requires: `organizer != address(0)`;
`1 <= threshold <= 16`; `registrationDeadline > block.timestamp`; `dealingDuration >=
MIN_DEALING_DURATION`; `1 <= |inviteKeys| <= MAX_INVITES`, entries distinct and non-zero. It stores the organizer address, `t`, deadlines and the invite
list, and sets phase `Registration`. Funding, relayer choice and invitee identity are off-chain
concerns and never influence the key material.

### 8.2 Join

`join(action, participantSig, inviteSig)` requires, atomically:

1. phase `Registration` and `block.timestamp <= registrationDeadline`; fewer than 16 members;
2. both `validUntil` checks; both signatures valid; the invite signer equals the stored unconsumed
   capability address at `inviteId`; struct cross-checks (§7.2);
3. `participant` address non-zero and not yet used in this ceremony; `(pkX, pkY)` canonical, on
   curve, **in the prime subgroup** (explicit `isInPrimeSubgroup` after TE -> reduced conversion; the Schnorr
   equation alone is not accepted as a subgroup argument), not the identity, and not equal to any
   already registered member key. These checks are **load-bearing**: the dealing circuit takes
   every roster key as a valid non-identity prime-subgroup point without re-checking it (the
   adversarial review's `x = 0` join key, for example, is stopped only here);
4. the Schnorr proof of possession verifies: with challenge

   ```
   c = HashToScalar("davinci-dkg-council/v1/join-pop",
       uint256 chainId, address manager, bytes12 ceremonyId,
       address participant, uint256 pkX, uint256 pkY, uint256 popAx, uint256 popAy)
   ```

   (TE coordinates in the transcript), require `popZ < r`, `(popAx, popAy)` canonical and on
   curve, and `popZ·G - c·X_i == A`, checked via
   `BabyJubJub.verifySchnorrEquation(popZ, c, ax, ay, pkx, pky)` (six scalar arguments: `z`, `c`,
   then the nonce point and the public key, each as reduced-form x and y). Prover side: the nonce
   `k` is sampled fresh per proof from the CSPRNG, never from the recovery-root KDF: draw 32
   random bytes, interpret big-endian as `u`, reject `u >= LIMIT_R`, set `k = u mod r`, reject
   `k = 0` and retry; then `A = k·G`, `z = k + c·x_i mod r`.

The member receives the next index. The join UI must have completed the recovery rehearsal
(§5.3) before signing: joining acknowledges possession of the key and acceptance of the ceremony
parameters, nothing more; shares do not exist yet.

### 8.3 Close, roster freeze and dealing

`closeRegistration(action, orgSig)`: phase `Registration`, `block.timestamp <=
registrationDeadline`, `participantCount == joined count` (pins the roster the organizer saw
against late joins), `joined count >= t`. Effects: `n` frozen, `rosterHash` and `ctx` computed and
stored (§4.3), `dealingDeadline = block.timestamp + dealingDuration`, phase `Dealing`. Nothing
about `t`, the member set, keys or deadlines is mutable afterwards.

Each member may submit at most one dealing while phase is `Dealing` and `block.timestamp <=
dealingDeadline`. Dealer `j` (its member index, 1-based) derives coefficients
`a_{j,0}..a_{j,t-1}` (purpose `dealer-coefficient`, k = 0..t-1, zero allowed) and ephemeral
`e_j != 0` (purpose `dealer-ephemeral`) per §5.2, and computes over `F_r` and the curve:

```
f_j(z) = Σ_{k<t} a_{j,k}·z^k  (mod r)
C_{j,k} = a_{j,k}·G                 for k < t;   C_{j,k} = O for k >= t
E_j = e_j·G
s_{j,m} = f_j(m) mod r              for each member m = 1..n
S_{j,m} = e_j·X_m                   (ECDH, X_m from the frozen roster)
h_{j,m} = Poseidon7(MASK_CONST, ctxHi, ctxLo, j, m, S_{j,m}.x, S_{j,m}.y)
masked_{j,m} = s_{j,m} + h_{j,m}  mod p          // native-field mask, NOT mod r
masked slot i (= member i+1) for i >= n is 0
```

The dealer submits `C[16]`, `E`, `masked[16]`, the Groth16 dealing proof (§8.5) and the signed
Deal action. The contract requires: dealer has not dealt; the Deal signer is the authorization
address of member `dealerIndex`; every `C`, `E` and `masked` word `< p` (proof words are exempt,
§7.2); `C_k == (0,1)` for `k >= t` and `masked_i == 0` for `i >= n` (also enforced by the proof;
checked early for clear errors); the recomputed `payloadHash` matches the signed one. It then builds the public input vector itself
from storage and the submitted payload (§8.5) and calls the DealVerifier. On success the complete
dealing is stored in contract state (not merely hashed: months-later recovery reads it back
through view functions). A failed proof changes nothing. A relayer cannot alter any component
without invalidating the signature or the proof.

Client obligation before dealing: after registration closes, the client must display the frozen
ordered roster and require the member's explicit approval of its exact `rosterHash` before
authorizing a dealing (identity confirmation happens out of band). An automatic "live" mode may
pre-download artifacts, but must never sign or relay a dealing merely because the phase changed;
auto-submission is permitted only for a roster hash the member already approved locally.

All 16 coefficients are circuit witnesses tied to their commitments; Council deliberately does
not port the NI-DKG's constant-term/cofactor-preimage optimization (davinci-dkg `docs/pool-keys.md`), because
the one-key budget does not need it and the simpler statement is easier to audit.

### 8.4 QUAL, finalize, abort

```
QUAL = { j : a dealing from j was accepted }        // acceptance already implies validity
```

QUAL is all such dealers, never a selected subset; a dealer cannot withdraw; a member that did not
deal remains a full recipient. `finalize(ceremonyId)` is permissionless and valid when phase is
`Dealing` and either `block.timestamp > dealingDeadline` with `|QUAL| >= t`, or `|QUAL| == n`
(early finalize; QUAL cannot grow further). It computes, in the reduced chart:

```
A_k = Σ_{j in QUAL} C_{j,k}            for k = 0..t-1
P   = A_0
PK_m = Σ_{k<t} m^k·A_k = Horner(A, m)  for every member m = 1..n
```

and stores `A_0..A_{t-1}`, `P` and all `PK_m` in TE, flips phase to `Live`, and freezes QUAL. If
`P == O` the ceremony is set to `Aborted` instead (producing such a `P` requires proving knowledge
of a discrete log the adversary cannot know, so this is defense in depth, not an expected path).
No caller-supplied aggregate is ever trusted; the contract computes everything from stored
dealings. `|QUAL| >= t` guarantees at least one honest dealer under the `< t` collusion
assumption; it is deliberately the same conservative policy as the public DKG.

`abort(ceremonyId)` is permissionless and valid exactly when: phase `Registration` and
`block.timestamp > registrationDeadline` (the organizer never closed), or phase `Dealing` and
`block.timestamp > dealingDeadline` with `|QUAL| < t`. A restart is a new ceremony id with fresh
dealings; accepted contributions are never deleted or replaced under the old id.

Availability guarantee, stated exactly: let H be the honest members who retain their root (or
kit), accepted the frozen roster, and can read chain state. Every member of H can recover a valid
final share (§8.6) at any later time, even if it never dealt and was offline at finalization,
because every accepted dealing provably encrypts a correct share to every registered member. If
at least `t` members of H participate when a request is open, decryption completes. The guarantee
is conditional on retained keys, chain data availability and future participation; no on-chain
condition proves someone will remember their words.

### 8.5 Dealing circuit statement

Groth16 over BN254, circom. Public input vector, exactly 87 field elements, in this order:

| Index | Signal |
|---|---|
| 0 | `ctxHi` |
| 1 | `ctxLo` |
| 2 | `dealerIndex` (1-based) |
| 3 | `n` |
| 4 | `t` |
| 5..36 | `C[k].x, C[k].y` for k = 0..15 |
| 37..38 | `E.x, E.y` |
| 39..70 | `X[i].x, X[i].y` for i = 0..15 (slot i = member i+1) |
| 71..86 | `masked[i]` for i = 0..15 |

The generated snarkjs verifier's `_pubSignals` order must equal this table; the reference circuit
achieves it by declaring these as the main component's public inputs in this order with no public
outputs, and the release pins the generated verifier. The contract supplies index 0..4 and 39..70
from its own state (`ctx`, the authenticated dealer's index, `n`, `t`, the frozen roster in TE,
and `G` = Base8 for every slot `i >= n`), and 5..38 and 71..86 from the submitted payload. No
caller-supplied alternative input vector exists.

Signal names and witness-input JSON keys are pinned so independent circuit and SDK
implementations interoperate without coordination. `deal.circom` main component, declaration
order (publics exactly as the table above; row-major flattening of the arrays reproduces it):

```
signal input ctxHi;  signal input ctxLo;
signal input dealerIndex;  signal input n;  signal input t;
signal input C[16][2];      // [k][0] = x, [k][1] = y
signal input E[2];
signal input X[16][2];
signal input masked[16];
signal input a[16];         // private: coefficients, a[k] = 0 for k >= t
signal input e;             // private: ephemeral
signal input s[16];         // private: shares, s[i] = 0 for i >= n
component main {public [ctxHi, ctxLo, dealerIndex, n, t, C, E, X, masked]} = Deal();
```

The witness-input JSON uses exactly these keys, every value a decimal string, arrays nested as
declared.

Private witness: `a_0..a_15`, `e`, `s_0..s_15` (slot i = share of member i+1), plus constrained
bit decompositions and gadget intermediates. The circuit enforces:

1. Ranges: `1 <= t <= n <= 16`, `1 <= dealerIndex <= n`, `ctxHi < 2^128`, `ctxLo < 2^128`.
2. Scalar canonicality: every `a_k`, `e` and every active `s_i` is decomposed to 251 bits with an
   explicit `< r` comparison (a native-field `Num2Bits`-style check alone is insufficient: it
   admits values in `[r, p)`). `e != 0`. `e`'s bit vector is computed once and reused by every
   ECDH multiplication.
3. Commitments: `C[k] == a_k·G` (fixed-base) for all k; for `k >= t` additionally `a_k == 0`, so
   `C[k] == O`. `E == e·G`.
4. Per recipient slot i with activity bit `u_i = (i < n)`:
   - if active: `s_i·G == Horner(C, i+1)` where `Horner(C, m) = C_15` folded down by
     `Acc <- m·Acc + C_k` for k = 14..0; the multiplier `i+1` is a compile-time constant per
     slot (small, at most 16), and the identity padding of `C` above `t-1` makes the full 16-step
     evaluation equal `Σ_{k<t} (i+1)^k·C_k` for every `t`;
   - if active: `S_i == e·X_i` (variable-base `EscalarMulAny`; the contract guarantees every
     registered `X_i` and the `G` padding is a non-identity prime-subgroup point), and
     `masked_i == s_i + Poseidon7(MASK_CONST, ctxHi, ctxLo, dealerIndex, i+1, S_i.x, S_i.y)`
     in the native field (no reduction mod r anywhere);
   - if inactive (`i >= n`): `s_i == 0`, `masked_i == 0`, **`X_i == G`** (the circuit constrains
     the Base8 padding itself — `(1 − u_i)·(X_i − G) == 0` — rather than relying on the contract
     alone to supply it), and the Feldman and mask equations are disabled by `u_i`. The circuit
     must not output any function of a polynomial evaluation at an inactive slot: a dummy
     recipient with a known key would otherwise leak a real share.
5. Every public input is touched by at least one dedicated quadratic constraint (one `x·x` row per
   public signal, the `pubSq` block in `deal.circom`), mirroring davinci-dkg's `circuits/common/publicrows.go`;
   verify the property on the **optimized** R1CS, not the source. Current snarkjs already adds one
   constraint per public input on its own, making these 87 rows (67 in the partial circuit)
   redundant today — they are kept deliberately so the property is owned by the circuit source,
   not by an undocumented toolchain behavior that an optimizer flag or snarkjs release could
   remove.

Gadget rules, binding for both circuits (circomlib pinned at 2.0.5):

- **Direct use of `EscalarMulFix(251, Base8)` is forbidden.** The gadget is incomplete for some
  canonical scalars: its first segment covers 249 bits with compensation
  `Q = 2^250 + (2^249 - 1)/7`, and for `s* = r - Q =
  797546722194482024037982888770643071568945925300745316575367714387401675944` (also `s* + 2^249`
  and `s* + 2·2^249`) the final Montgomery addition adds inverse points and witness generation
  fails (`montgomery.circom` divides by zero). This is a completeness defect, not a forgery
  vector, but an honest dealer or decryptor could be unable to prove. Every fixed-base
  multiplication instead splits the constrained little-endian bit vector into `b[0..245]` and
  `b[246..250]`, computes `EscalarMulFix(246, G)` and `EscalarMulFix(5, [2^246]·G)`, and combines
  the two results with a complete `BabyAdd` — using the same validated decomposition that feeds
  the `< r` check. Inactive bases for `EscalarMulAny` are fixed to `G` to maintain a uniform
  non-identity-base precondition; the raw Edwards-to-Montgomery conversion is undefined at the
  identity, and the inspected `EscalarMulAny` version handles an identity *output* by internally
  substituting `G` and selecting the identity at its output.
- Positive (completeness) tests must include: zero coefficients, zero shares, identity outputs,
  scalar `r - 1`, and the three exceptional scalars above.

Measured size (`circuits-v1`, circom `--O2`): **83,395 constraints**; `deal_final.zkey`
51.3 MB, `deal.wasm` 2.98 MB; snarkjs proving in Node 1.45 s with 32 threads, 7.0 s single-thread
(a browser Web Worker lands between those). Proving runs in a Web Worker; the witness never
leaves the browser.

### 8.6 Share recovery

Member `m` with secret `x_m`, at any time after finalization, reads the frozen roster, `ctx`,
QUAL and every accepted dealing from chain state and computes, for each `j` in QUAL:

```
S_{j,m} = x_m·E_j
h_{j,m} = Poseidon7(MASK_CONST, ctxHi, ctxLo, j, m, S_{j,m}.x, S_{j,m}.y)
s_{j,m} = masked_{j,m} - h_{j,m}  mod p
```

Since `s_{j,m} < r < p`, the mod-p unmasking is exact. The client must then check, and hard-fail
on any mismatch:

1. `s_{j,m} < r` (cannot fail for an accepted dealing; detects wrong context or implementation);
2. `s_{j,m}·G == Horner(C_j, m)` per dealer;
3. `s_m = Σ_{j in QUAL} s_{j,m} mod r` satisfies `s_m·G == PK_m` as stored by the contract.

These checks are defense in depth; the dealing proofs are what guarantee they pass. A discrepancy
between an accepted proof and a failed check is a circuit/protocol incident requiring a halt, not
a dispute to adjudicate.

## 9. Process binding and decryption requests

### 9.1 Authorization and binding

The CouncilManager has no owner. Per ceremony, the organizer maintains two add-only sets via
signed actions (any phase; in practice after `Live`):

- **allowed adapters**: contract addresses permitted to bind processes and submit requests for
  this ceremony (for DAVINCI, the CouncilAdapter created by the ProcessRegistry);
- **authorized creators**: addresses permitted to create processes bound to this ceremony.

`bindProcess(ceremonyId, processId, creator)` succeeds only when the ceremony is `Live`,
`msg.sender` is an allowed adapter of that ceremony, `creator` is an authorized creator of that
ceremony, and no binding exists for `(msg.sender, processId)`. It stores the binding record
(§4.5) and returns `P` in TE; the adapter hands it to the registry as the process encryption key
(no chart conversion needed: DAVINCI uses TE). v1 has no revocation: once allowed or authorized,
an adapter/creator stays so for the ceremony's lifetime. Organizers must treat these actions as
irreversible policy.

Members should understand what they authorize by joining: the organizer can bind any number of
processes created by authorized creators through allowed adapters. If a committee intends to
approve individual elections, that approval is social (refuse to decrypt) or a future protocol
extension; v1 does not bind agendas on chain.

### 9.2 Request admission

`submitRequest(ceremonyId, processId, cts[])` loads the binding record by
`(msg.sender, processId)` and requires: the binding exists; `binding.ceremonyId == ceremonyId`
(the supplied id is cross-checked against the record, never trusted as a lookup key); the
ceremony is `Live`; no request was ever submitted for that binding (one request per bound
process, immutable afterwards); `1 <= fieldCount <= 16`. The request is stored under
`binding.requestId`. For every field `k`, the
ciphertext `(C1_k, C2_k)` in TE must be: canonical, on curve, **in the prime subgroup** (both C1
and C2, checked after TE -> reduced conversion), and not the identity. The contract deliberately
pays the subgroup checks here, once per request, so that partial proofs may assume valid bases.
These admission checks are **load-bearing**, not belt-and-braces: the partial circuit proves
`D = s·C1` for whatever `C1` the contract feeds it, so a non-canonical word such as
`C1 = (0, p − 1)` or a torsion-shifted `C1` (both found guarded only here by the adversarial
review) is stopped at admission or nowhere.
Identity handling: DAVINCI's registry skips all-zero accumulator fields before calling the adapter
(its `zeroSkipped` mapping) and rejects half-identity fields, so an identity C1 or C2 reaching the
manager is a protocol violation and is rejected; a non-DAVINCI adapter must do its own
zero-field mapping upstream. The request record stores the TE words, `fieldCount`, `requestId`,
and empty partial/completion state. Plaintext bound: every combined `m_k` must satisfy
`m_k < RESULT_BOUND = 2^40`; DAVINCI's `maxValue·maxVoters <= 10^12` cap keeps honest results far
below it.

Requests have no deadline: a `Live` ceremony serves requests indefinitely. What gates decryption
in time is the DAVINCI side (process ended, grace closed, accumulator proven against the settled
state root) plus the committee's own participation. State this honestly: the contract bounds what
it accepts; it cannot prevent `t` colluding members from decrypting anything off chain.

### 9.3 Browser checks before computing a partial

A client must refuse to compute `s_i·C1` for anything it has not independently verified from
chain state via its pinned deployment. Before signing a Partial action it must check:

1. the state snapshot is authenticated: the client performs every security-relevant read against
   at least two independently administered pinned RPC providers (at least one assumed honest) and
   requires them to agree on the finalized block hash and, at that block, on the ceremony,
   binding, request, membership and verification-key state; on disagreement or unavailability it
   refuses — it never takes the first successful response. Chain id and CouncilManager address
   must match the app's pinned deployment (an untrusted RPC's claimed chain id is not
   authentication). The request's admission must be in a finalized block before a partial or its
   proof leaves the browser. A light client may replace the two-provider rule later. Exception: a
   single RPC endpoint is permitted only when the app runs in an explicitly declared local
   development mode (e.g. Anvil, chain id 31337), never on a production chain;
2. the ceremony is `Live`, its stored `rosterHash`/`ctx` match the locally recomputed values, and
   the member's own index, authorization address and `X_i` match the roster;
3. the request exists on chain, was submitted by an adapter the ceremony allows, and is bound to
   a process id the user can be shown;
4. every `C1_k` (and `C2_k`) is canonical, on curve and in the prime subgroup, re-checked locally
   in TE; never "repair" an invalid point by cofactor multiplication: that decrypts a different
   ciphertext — reject it;
5. the recovered `s_i` is canonical and `s_i·G == PK_i` as stored on chain;
6. the full public-input vector is reconstructed locally, never accepted as an opaque pre-hashed
   blob from a relayer, email or website.

## 10. Partial decryption and combine

### 10.1 Partial circuit statement

Participant `i` computes `D_{i,k} = s_i·C1_k` for `k < fieldCount`. Public input vector, exactly
67 field elements:

| Index | Signal |
|---|---|
| 0..1 | `PK.x, PK.y` |
| 2 | `activeCount` (= fieldCount, `1..16`) |
| 3..34 | `C1[k].x, C1[k].y` for k = 0..15 |
| 35..66 | `D[k].x, D[k].y` for k = 0..15 |

Inactive padding: the contract supplies `C1[k] = G` (Base8) for `k >= activeCount`, and requires
`D[k] = O` for `k >= activeCount`; the circuit constrains both itself
(`(1 − act_k)·(C1_k − G) == 0` and the gated product equations force `D_k = O`), so the padding
does not rest on the contract alone. Inactive bases are fixed to `G` to maintain a uniform
non-identity-base precondition: the raw Edwards-to-Montgomery conversion is undefined at the
identity, and the inspected `EscalarMulAny` version handles identity by internally substituting
`G` and selecting the identity at its output (§8.5 gadget rules apply to this circuit too,
circomlib 2.0.5 pinned).

Signal names and witness-input JSON keys, pinned as in §8.5:

```
signal input PK[2];  signal input activeCount;
signal input C1[16][2];  signal input D[16][2];
signal input s;             // private
component main {public [PK, activeCount, C1, D]} = Partial();
```

Private witness: `s` and its bits. Constraints:

1. `s` decomposed to 251 bits, `s < r`; the bit vector is shared by all multiplications;
2. `PK == s·G` (fixed-base, the §8.5 split construction — never `EscalarMulFix(251, Base8)`);
3. for `k < activeCount`: `D[k] == s·C1[k]` (variable-base on the request-validated subgroup
   base); for `k >= activeCount`: `D[k] == O` and the product constraint is gated off;
4. `1 <= activeCount <= 16`;
5. one dedicated quadratic row per public input (as in §8.5 item 5).

`s = 0` (and `PK = O`) is a mathematically valid share; the §8.5 positive-test battery (zero
scalar, identity outputs, `r - 1`, the exceptional scalars) applies to this circuit as well.
Measured size (`circuits-v1`, circom `--O2`): **37,712 constraints**;
`partial_final.zkey` 20.0 MB, `partial.wasm` 233 KB; snarkjs proving in Node 0.55 s with 32
threads, 4.0 s single-thread.

### 10.2 Partial admission

`submitPartial(action, sig, D, proof)` first loads the request by `action.requestId` and
requires: the request exists; `action.ceremonyId == request.ceremonyId` (a partial signed and
proven under an attacker-controlled ceremony with a victim's request id is rejected before it can
consume a slot). From that stored ceremony — and only from it — the contract takes `n`, the
member's authorization address and `PK_i`. It then requires: `participantIndex ∈ 1..n`; the
signer is that member's authorization address; no accepted partial yet for
`(requestId, participantIndex)`; every `D` word `< p` (proof words are exempt, §7.2);
`D[k] == (0,1)` for `k >= fieldCount`; the recomputed `payloadHash` matches the signed one. The
contract builds the public inputs itself: `PK` = the stored `PK_i` of that member (TE),
`activeCount` and `C1` (plus `G` padding) from the stored request, `D` from the payload. On success the full `D` vector is stored. Context binding is
at the action/state boundary: the signed Partial action binds this exact `requestId` and payload,
and one-shot state prevents reuse; the mathematical statement `D = s·C1` is deliberately
context-free, and an unconstrained "request id" circuit input would add nothing (it would not
appear in any constraint). Since every `D` is proven equal to `s·C1` on a subgroup base, the
contract performs no subgroup products on `D`.

Because the per-field combine check (§10.3) is exact, partial soundness does not rest on any
batching argument: a malicious last submitter cannot steer the result; an invalid `D` simply
cannot be proven.

### 10.3 Combine

Once at least `t` partials are accepted for a request, anyone may call

```
combine(requestId, uint8[] memberSet, uint8[] fieldIndexes, uint64[] plaintexts)
```

Validation: `memberSet` has exactly `t` entries, strictly increasing, each in `1..n` and each with
an accepted partial for this request; `fieldIndexes` has 1 to `MAX_COMBINE_FIELDS = 4` entries,
strictly increasing, each `< fieldCount` and not yet completed; `plaintexts` has the same length
with every `m_k < 2^40`. Different chunks may use different member sets.

The contract computes the Lagrange coefficients itself, over `F_r`:

```
λ_i = Π_{h in S, h != i}  h · (h - i)^(-1)   mod r      for each i in S
```

with differences taken mod r and inversion via the modexp precompile (exponent `r - 2`); supplied
coefficients are never accepted. Then for each field `k` in the chunk it checks, in the group
(reduced chart internally):

```
m_k·G + Σ_{i in S} λ_i·D_{i,k}  ==  C2_k
```

This is the per-field **exact** check: no random-linear-combination batching exists anywhere in
Council's decryption path, so there is no weight-transcript soundness surface and no grinding
analysis to maintain. An incorrect in-range `m_k` fails outright because `2^40 < r`. On success
each field's plaintext is stored and marked complete, atomically per chunk; completed fields are
immutable; the request is complete when all `fieldCount` fields are. The DAVINCI adapter's
`plaintexts` view reports `ready` only then, so the registry can never read a partial result
vector as final.

Off chain, the combiner computes `M_k = C2_k - Σ λ_i·D_{i,k}` from public data and finds
`m_k` with `M_k = m_k·G` by baby-step/giant-step bounded by `2^40` (about `2^20` baby steps and
up to `2^20` giant steps per field; roughly 40–70 MB of table). The relayer runs this natively;
anyone can (prior art runs a full 2^40 BabyJubJub BSGS in a browser in seconds). The combiner
needs no trust: it only proposes `m_k` values the contract verifies exactly. If a plaintext is
out of range — impossible for an accumulator proven under DAVINCI's result cap — the field can
never complete and the request stays incomplete; there is no out-of-range escape hatch.

## 11. Security considerations

### 11.1 Threat table

| Adversary / event | Consequence | Protocol response |
|---|---|---|
| Organizer controls `t` identities (sock puppets) | Can decrypt everything the key protects | Not preventable cryptographically. Invites prove possession of a link, not personhood. Mitigate socially: out-of-band identity confirmation, roster shown to every member before dealing, members refuse unknown rosters |
| Invite link stolen before redemption | Thief joins as a legitimate member | Bearer capability by design; out-of-band delivery and roster review; organizer closes only after confirming identities |
| Dealer submits garbage or adapts after seeing others | Rejected unless proof-valid; key bias by selective abort/last-move remains | Proofs make bad shares impossible; `P` is explicitly **not** an unbiased beacon — Council claims key secrecy under one honest QUAL dealer, not unbiased key generation (a GJKR-class protocol would be needed for that) |
| Member never deals | Smaller QUAL | Member stays a recipient with full shares; `|QUAL| >= t` still required |
| Member disappears before decryption | Reduced liveness | Any `t` of `n` members suffice; choose `t` with absentees in mind (the app says this at creation) |
| Malicious relayer | Censorship, delay | Cannot forge or alter anything (signatures + proofs + payload hashes); every call is submittable by anyone from any funded account; clients keep signed payloads for resubmission |
| Last partial submitter | Tries to steer the tally | Impossible: every partial is individually proven, the combine check is exact per field |
| Combiner proposes wrong plaintexts | Tally corruption attempt | Exact per-field group equation; no batching to grind |
| Caller supplies off-curve / torsion C1 | Secret leakage via invalid-point arithmetic | Subgroup checks at request admission on chain and again in the browser (§9.3); never cofactor-"repair" |
| Organizer binds an unexpected process | Committee becomes a decryption oracle for it | Binding requires allowed adapter + authorized creator; both are organizer policy members accepted by joining; see §11.2 for the residual guarantee |
| Recovery kit leaked | Full impersonation of that participant; all ceremonies under that root | Kit carries an explicit warning; per-ceremony derivation separates contexts but not root compromise; no refresh in v1 |
| Malicious frontend / dependency | Exfiltrates roots and witnesses | Pinned, reproducible, third-party-script-free app; artifact hashes pinned; independent client possible from this spec; the threshold assumption covers endpoints too |
| Chain reorg / censorship near a deadline | Honest dealing excluded | Generous deadlines; deterministic dealing rederivation makes resubmission free; abort+restart is always safe |

### 11.2 One key for several processes: the conditional guarantee

Council deliberately uses one ceremony key for every process bound to it (an assembly runs
several votes with one committee). A partial for a ciphertext `C1` is mathematically valid for
the same `C1` anywhere; domain tags do not change `s·C1`. The isolation between processes is
therefore **conditional**, and holds only while all of the following are true:

1. only authorized creators can bind processes, and only through adapters the ceremony allows;
2. the only request path is an allowed adapter submitting the **authenticated final accumulator**
   of a bound process (for DAVINCI: SMT inclusion against the settled state root, end + grace
   gates, process terminalized before partials appear);
3. the manager exposes no generic decrypt endpoint — requests exist only through bindings;
4. every ballot entering an accumulator proves knowledge of its plaintext and randomness and binds
   its process id and encryption key (DAVINCI's ballot circuit and zkVM guest do this at the
   inspected sources), which blocks copying an unknown target ciphertext into a new election.

The conditional privacy claim additionally assumes fresh, independent encryption randomness for
honest ballots and correct context separation wherever (re-)encryption randomness is derived
deterministically: a proof of knowledge of randomness does not establish its freshness, and
repeated randomness links ciphertexts across processes. It also assumes that the deployed ballot
and transition verifiers enforce the semantics stated here, the hardness of CDH/DDH on BabyJubJub
and the security of hashed-DH with Poseidon, HKDF pseudorandomness, Groth16 zero-knowledge and
knowledge soundness, and an uncompromised trusted setup. This document argues the composition; it
is not a full multi-session security reduction.

Condition 4 is inherited from the deployed DAVINCI proof system; this spec does not re-verify
that the deployed verifier keys match the inspected sources. If any condition fails, one key
across processes degrades to a shared privacy domain with a cross-process decryption oracle.
Additional honest statements: `t` colluding members can decrypt individual blob ballots off chain
regardless of any on-chain gate; and small or overlapping electorates leak individual choices by
subtraction even with perfect ciphertext isolation. Organizers who need hard isolation between
two votes should run two ceremonies.

### 11.3 What Council does not claim

- No Sybil resistance, no personhood: invites are capabilities.
- No unbiased key: secrecy under one honest accepted dealer, nothing stronger.
- No forced participation: decryption liveness is a human property; the protocol only makes any
  `t` members sufficient.
- No forward secrecy: the recovery property is the deliberate opposite; root compromise is
  retroactive.
- No post-quantum security; about `2^125` classical group security and BN254 pairing assumptions.

## 12. Cross-implementation vectors

The committed vectors live at `tests/vectors/` and are asserted by the SDK tests, the Foundry
tests and the circuit tests. Files and contents:

| File | Contents |
|---|---|
| `constants.json` | every §2 constant, all tag hashes, `MASK_CONST`, `LIMIT_R`, one fixed 7-input `Poseidon7` evaluation (cross-checks the Poseidon parameterization) |
| `derivation.json` | `HashToScalar` and `DeriveScalar` outputs including at least one rejection-loop case; a full key derivation (every §5.2 purpose) from the pinned test mnemonic `test test test test test test test test test test test junk` |
| `identifiers.json` | ceremony id, roster hash, `ctx`, request id examples |
| `eip712.json` | domain separator and one digest per §7.2 struct |
| `dealing.json` | a complete honest dealing end to end: coefficients, shares, masks, both payload hashes, and the full 87-word public-input vector |
| `recovery.json` | §8.6 share recovery for the `dealing.json` ceremony |
| `combine.json` | Lagrange coefficient vectors for several member subsets and one full combine equation instance |

The vectors pin test-only deployment parameters — chain id `31337`, manager
`0x5fbdb2315678afecb367f032d93f642f64180aa3`, circuit release id
`0xe7561fc861548402ef3be7636860f2f3222d56434400696037fca59f7e85e8b0` — that belong to no real
release (the development release's id is the architecture document's pin); a vector file
matching a live deployment would be a bug, not a convenience.

The generator, `circuits/scripts/gen-vectors.ts` (`make vectors`), is a standalone TypeScript
program (noble-hashes/noble-curves, poseidon-lite and viem only). It must **not** import the SDK: the SDK asserting vectors produced by its own code
would be self-referential. The acceptance tests of the implementation (mutation, adversarial,
padding, zero-share, replay) are listed in `docs/architecture.md`.
