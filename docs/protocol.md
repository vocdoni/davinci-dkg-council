# DAVINCI DKG Council protocol, version 2

Status: normative specification. This document is the source of truth for the
Council circuits, the CouncilManager contract, the TypeScript SDK and the relayer. Independent
implementations that follow it must produce byte-identical hashes, signatures, public-input vectors
and on-chain encodings. Where this spec and an implementation disagree, the implementation is wrong.

Version 2 (approved 2026-10-06) changes two things against version 1, and nothing else. **(A)
Storage diet, milestone 1 (slots-only)**: persistent roster keys, dealer ephemerals and request
ciphertexts are stored compressed (§2.5); per-dealer commitment vectors are replaced by an
aggregate maintained incrementally at deal time (§8.3); member verification keys are computed on
demand by Horner (§8.6, §10.2); and partial-decryption vectors are committed by hash plus a
publication block locator and re-supplied at combine (§10.2–§10.4). Code-data (STOP-prefixed
`CREATE`) storage is deferred to a milestone 2 (architecture, future work). **(B)
Scheduled/manual phases**: each ceremony fixes at creation, independently, how registration
closes and when decryption may open — each either Scheduled (an absolute timestamp,
permissionless once due) or Manual (an organizer action) — §8.1, §8.3, §8.7. Both circuit
statements, their public-input vectors (full TE coordinates in calldata), the recovery-root
derivation and the recovery-kit format are unchanged. A v2 deployment is a new manager with
EIP-712 domain version "2", never an upgrade; ceremonies on a v1 manager remain governed by the
v1 specification (architecture, migration).

Council is an invite-only threshold DKG: an organizer invites up to 16 people, each joins from a
browser with a key derived from a 12-word recovery phrase, each contributes one proven Feldman
dealing, and the contract aggregates the contributions into one ElGamal public key on BabyJubJub.
DAVINCI processes bound to the ceremony encrypt their tallies under that key; any `t` of the `n`
members can later decrypt the final accumulator, each with one small browser proof. There is no
complaint round, no acknowledgment round and no finalization proof: every dealing is proven correct
before it is accepted, so every member provably holds a valid share of every accepted dealing.

Design lineage: version 1 instantiated the "B-circom" protocol proposal (internal design note,
2026-10-05)
with the project owner's binding decisions: capacity 16, one key per ceremony shared by its bound
DAVINCI processes, circom/snarkjs Groth16 for dealing and partial decryption, per-field exact
combine checks, no finalization circuit, circomlib twisted Edwards coordinates on the wire, and a
relayer funded off chain. Version 2 instantiates the storage/phase-control design note (2026-10-06)
and its review, with the lead's binding decisions: milestone 1 is the slots-only storage profile;
a member's own path never reads historical logs or calldata, with the combiner's single-block log
read and deterministic re-publication as the combine-data story (§10.4); registration and
decryption policies are independent per ceremony; the DAVINCI registry waits for the opening gate
even for all-zero results (architecture, DAVINCI integration); and neither circuit changes.

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
- Points on the wire, in events, in circuit public inputs, in signed payloads and in all hashes
  are in the **circomlib twisted Edwards form (TE)** as `(x, y)` pairs, each canonical in `F_p`.
  The reduced form exists only inside the contract's arithmetic (§2.2). Persistent storage is the
  one v2 exception: immutable roster keys, dealer ephemerals and request ciphertexts are stored in
  the compressed encoding of §2.5 (one word per point), and the mutable aggregate coordinates are
  stored with the `+1` bias of §8.3. A compressed word can exceed `p` (its top bit carries the `y`
  parity) and MUST never enter a circuit, a hash or a signature payload as if it were a
  coordinate.
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
2. Dealing: each submitted `C_{j,k}` and, from the second accepted dealing on, the stored
   aggregate `A_k` are converted TE -> reduced for the incremental aggregation
   `A_k <- A_k + C_{j,k}` (§8.3); the results are converted back to TE before (biased) storage.
3. Member keys: `getMemberKey` and partial admission (§10.2) convert the stored `A_k` TE ->
   reduced for the on-demand Horner evaluation `PK_i = Horner(A, i)` and the result back to TE.
   Nothing from this computation is stored.
4. Request admission: each `C1_k`, `C2_k` is converted TE -> reduced for the on-curve and
   prime-subgroup checks (the stored request keeps compressed words, §2.5).
5. Combine: `C2_k`, every selected `D_{i,k}` and `G` are converted TE -> reduced for the per-field
   group equation; nothing from this computation is stored.
6. Compressed-point authentication (§2.5): the on-curve check of a caller-supplied full point
   converts TE -> reduced internally; the equality comparison itself is on the TE words.
7. Nowhere else. Events, view outputs, EIP-712 payload hashes, circuit public inputs
   and all `K(...)` transcripts use full TE words exclusively. One `mulmod` per converted
   x-coordinate.

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
| `MAX_DEALING_DURATION` | 31,536,000 s (365 days) | ceiling on the dealing window: no close can overflow `uint64` and every `Dealing` phase times out |
| threshold rule | `1 <= t <= n <= 16` | `t` fixed at creation, `n` frozen at close, close requires `n >= t` |
| `PhaseMode` | `{ Manual = 0, Scheduled = 1 }` | registration-close and decryption-opening policy modes (§8.1, §8.3, §8.7); any other byte is `BadSchedule()` |

`RESULT_BOUND` is a protocol constant, not per-request data: with per-field exact combine checks
(§10) a tighter bound buys no soundness, and DAVINCI's own cap `maxValue·maxVoters <= 10^12` is
below `2^40`.

### 2.4 Domain tags

Version 1 pinned its domain strings with the prefix `davinci-dkg-council/v1/`; v2 freezes every
one of them unchanged (re-tagging would change `MASK_CONST`, a literal inside `deal.circom`, and
force a circuit release for a cosmetic rename) and adds exactly one new tag. The pinned tags and
their `keccak256(utf8(tag))` values:

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
| `davinci-dkg-council/v2/partial-data` | `0xe9c88d2345099d5c36ae9c5ef6fb2d2396dc1633fee75cfb7680fca2214182af` |

`davinci-dkg-council/v2/partial-data` is the durable partial-data commitment tag (§10.2), the only
v2 addition. The EIP-712 domain `version` changes separately to `"2"` (§7.1); key-derivation
labels keep the v1 prefix, so a recovery phrase derives the same keys against a v1 and a v2
deployment (ids and contexts still differ through the manager address).

The share-mask field constant is the only tag that is reduced into the field:

```
MASK_CONST = uint256(keccak256(utf8("davinci-dkg-council/v1/share-mask-poseidon"))) mod p
           = 10214054970402064552395134490408265161209242095674905809605444618984955431150
```

Key-derivation purpose labels (HKDF info, §5) use the prefix `davinci-dkg-council/v1/derive/` and are listed
in §5.2. Every pinned value in this section must appear in the cross-implementation test vectors.

### 2.5 Compressed point encoding

v2 stores each immutable point — a roster key `X_i`, a dealer ephemeral `E_j`, a request
ciphertext component `C1_k`/`C2_k` — as one 32-byte unsigned big-endian word:

```
compressed(x, y) = x | ((y & 1) << 255)
```

Bits 0..253 hold the canonical `x < p` (254 bits suffice), bit 254 is reserved and MUST be zero,
bit 255 holds the parity of the canonical `y`. This is an x-plus-parity-of-y encoding — not any
library's y-plus-sign-of-x Edwards format; do not reuse a library codec.

Decoding (clients only; the contract never decompresses): reject if bit 254 is set or
`x >= p`; solve the TE equation `a·x² + y² = 1 + d·x²·y²` for
`y² = (1 − a·x²) / (1 − d·x²) mod p`; take a square root by Tonelli–Shanks and reject if `y²` is
a non-residue; pick the root whose parity matches bit 255.
Because `p ≡ 1 (mod 4)` — in fact `v₂(p−1) = 28` — the `y²^((p+1)/4)` exponentiation shortcut is
**invalid** for this field; a general Tonelli–Shanks (or an equivalent constant pre-computation)
is required, and an implementation using the shortcut will fail the §12 vectors.

Pinned examples (also in the §12 vectors):

| Point | compressed |
|---|---|
| `G` (Base8; `y` odd) | `0x8bb77a6ad63e739b4eacb2e09d6277c12ab8d8010534e0b62893f3f6bb957051` |
| `−G` (`y` odd — TE negation flips `x`, not `y`) | `0xa4acd4080af32c8e69a392d5e41ee09bfd7b104774848fdb1b4e019d346a8fb0` |
| identity `O = (0, 1)` | `0x8000000000000000000000000000000000000000000000000000000000000000` |
| `(0, p − 1)` (order two) | `0x0000000000000000000000000000000000000000000000000000000000000000` |

The all-zero word is **not** identity padding: it decodes to `(0, p − 1)`, a canonical on-curve
point of order two that MUST fail any prime-subgroup admission. Code that treats a zero word as
"empty" or as `O` is wrong; presence is always tracked separately (bitmaps, counts), never
inferred from a zero word.

**Contract authentication without square roots.** The contract never computes `y` from `x`.
Wherever a stored compressed point is needed in full — the roster at close and deal, `C1` at
partial admission, `C2` at combine — the caller supplies the full TE point and the contract
authenticates it, in this exact order:

1. `x < p` and `y < p` (before any chart conversion or modular arithmetic);
2. the point satisfies the TE curve equation (`CouncilCurve.requireOnCurveTE`);
3. `compressed(x, y)` equals the stored word exactly (`CompressedPointMismatch()` otherwise).

Step 2 is load-bearing, not belt-and-braces: parity-plus-`x` alone does not pin `y` among all
field elements — `(G.x, G.y + 2)` has `y` with the same parity and compresses to the stored word
for `G`, but it is not on the curve. The §12 vectors pin this exact adversarial point, and tests
must drive it (and its analogues) into every authentication entry point. On canonical on-curve
points the encoding is injective — the curve equation admits exactly two `y` per valid `x` and
they differ in parity (they sum to `p`, odd) — so steps 1–3 admit exactly the point that was
stored. Subgroup membership is therefore **inherited**, never re-checked: roster keys were
subgroup-checked at join, `C1`/`C2` at request admission, and `E` is `e·G` by the dealing proof.
An authenticated replay is exactly the admitted point. A codec validates a curve encoding only;
the caller applies the subgroup/non-identity policy, and no implementation may "repair" a point
by cofactor multiplication.

What stays uncompressed: the mutable aggregates `A_k` (full TE with the `+1` bias, §8.3) —
compressing them would force either on-chain square roots or caller-supplied aggregate snapshots
that a concurrent dealing can invalidate — and everything that is not a point.

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
warning (anyone holding the file can act as the participant); password-encrypted export remains a
future option — protocol v2 does not add it. The join flow requires a recovery rehearsal: the app forces a kit download, then
requires re-entry/re-import and checks `x_i·G == X_i` and the derived address before the Join
action is signed.

Recovery months later needs exactly: the kit (or the twelve words plus the public locator
`{chainId, manager, ceremonyId, accountIndex}`), a compatible client with the pinned proving
assets, and **current** chain state through public RPC providers — never event logs, old
transaction bodies, receipts, an indexer or an archive node (§8.6, §9.3, §10.4). The kit format
stays `davinci-dkg-council-kit/v1` under protocol v2; a deployment's API version is identified by
its pinned manager address and the manager's `protocolVersion()` view (`2`), never guessed from
responses.

Compromise of the root compromises every ceremony derived from it, past and future. There is no
share refresh; treat the `< t` collusion bound as cumulative over the key's lifetime.

## 6. Invitations

The contract stores, per ceremony, an append-only array of **invite capability addresses** (the
Ethereum addresses of the capability keys) with a consumed flag each. CreateCeremony registers the
initial list; AddInvites (organizer-signed, Registration phase only and only while joining is
open under §8.2's cutoff — strictly before a nonzero `registrationDeadline`, and without time
limit for a Manual ceremony that has none; an invite nobody could redeem must not be registrable)
appends more, up to `MAX_INVITES` total. AddInvites authenticates the appended
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
name = "DAVINCI DKG Council", version = "2", chainId = the real chain id,
verifyingContract = the CouncilManager address
```

The domain version was `"1"` in v1; every v2 action is signed under version `"2"` against the v2
manager address, so no v1 signature ever validates on a v2 deployment or vice versa.

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
CreateCeremony(address organizer,uint64 nonce,uint8 threshold,uint8 registrationMode,uint64 registrationDeadline,uint64 dealingDuration,uint8 decryptionMode,uint64 decryptionOpenAt,uint64 manualDecryptionFallbackAt,address[] inviteKeys,uint64 validUntil)
OpenDecryption(bytes12 ceremonyId,uint64 validUntil)
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
CreateCeremony, AddInvites, CloseRegistration, AllowAdapter, AuthorizeCreator, OpenDecryption by
the organizer; Invite by the invite capability key; Join, Deal, Partial by the participant's
authorization key. A Join submission carries two signatures (participant over Join, capability
over Invite); the two structs must agree on `ceremonyId`, `inviteId`, `participant`, `pkX`,
`pkY`. An OpenDecryption signature is a bearer instruction once it exists: relay is
permissionless by design, so the organizer's client must not create or export one before the
organizer wants opening to be possible, and should keep `validUntil` short.

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
mismatch, so a relayer cannot substitute any component of a signed submission. Both payload hash
definitions are unchanged in v2; the durable partial-data commitment of §10.2 is deliberately a
different hash (it excludes the proof).

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

`finalize(ceremonyId)`, `abort(ceremonyId)`, `closeRegistrationScheduled(ceremonyId, rosterKeys)`
(§8.3), `publishPartialData(requestId, participantIndex, D)` (§10.4) and `combine(...)` take no
signature: their validity is a pure function of chain state and of calldata authenticated against
it, so the caller's identity is irrelevant. `bindProcess` and `submitRequest` are authorized by
`msg.sender` being an allowed adapter (§9), not by signature.

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
`1 <= threshold <= 16`; `MIN_DEALING_DURATION <= dealingDuration <= MAX_DEALING_DURATION`
(`BadDuration()`, checked before every phase-policy rule — without the ceiling a Manual
registration without expiry could carry a near-`2^64` duration whose organizer close overflows
forever, a ceremony that could neither close nor abort);
`1 <= |inviteKeys| <= MAX_INVITES`, entries distinct and non-zero; and a consistent phase policy:

- `registrationMode` and `decryptionMode` are each exactly `Manual = 0` or `Scheduled = 1`
  (`BadSchedule()` otherwise).
- Scheduled registration: `registrationDeadline > block.timestamp`, and
  `registrationDeadline + dealingDuration` fits `uint64`. (Every timestamp addition and narrowing
  in §8 is overflow-checked; overflow reverts, never wraps.)
- Manual registration: `registrationDeadline == 0` (no expiry — joining ends only by the
  organizer's CloseRegistration), or `registrationDeadline > block.timestamp` — an expiry at
  which registration **closes** permissionlessly if at least `t` members have joined, and the
  ceremony becomes abortable otherwise (§8.3, §8.4). When nonzero, its sum with `dealingDuration`
  must fit `uint64`.
- Scheduled decryption: `decryptionOpenAt > block.timestamp` and
  `manualDecryptionFallbackAt == 0`.
- Manual decryption: `decryptionOpenAt == 0`; `manualDecryptionFallbackAt` is `0` (no fallback)
  or `> block.timestamp`.
- When registration is Scheduled, a scheduled `decryptionOpenAt` or a nonzero
  `manualDecryptionFallbackAt` must be strictly later than
  `registrationDeadline + dealingDuration`.

A decryption date is a **not-before eligibility time**, never a promise that the key is ready
then: if closing or finalization happens late, opening becomes effective only once the ceremony
is `Live` (§8.7), and clients display the published date as-is rather than silently shifting it.
Every policy field is immutable after creation: there is no reschedule, pause, re-open or
per-request override. The call stores the organizer address, `t`, the policy fields and the
invite list, and sets phase `Registration`. Funding, relayer choice and invitee identity are
off-chain concerns and never influence the key material.

### 8.2 Join

`join(action, participantSig, inviteSig)` requires, atomically:

1. phase `Registration` and joining open: `registrationDeadline == 0` (Manual without expiry) or
   `block.timestamp < registrationDeadline` — the interval is **half-open** in v2
   (`RegistrationEnded()` at and after a nonzero cutoff; from that instant the time-based close
   and abort of §8.3/§8.4 own the transition, so the joined count they see is already frozen);
   fewer than 16 members;
2. both `validUntil` checks; both signatures valid; the invite signer equals the stored unconsumed
   capability address at `inviteId`; struct cross-checks (§7.2);
3. `participant` address non-zero and not yet used in this ceremony; `(pkX, pkY)` canonical, on
   curve, **in the prime subgroup** (explicit `isInPrimeSubgroup` after TE -> reduced conversion; the Schnorr
   equation alone is not accepted as a subgroup argument), not the identity, and not equal to any
   already registered member key. These checks are **load-bearing**: the dealing circuit takes
   every roster key as a valid non-identity prime-subgroup point without re-checking it (the
   adversarial review's `x = 0` join key, for example, is stopped only here). The accepted key is
   stored as `{auth, compressed(X_i)}` (§2.5); duplicate detection keys on the compressed word,
   which equals full-point comparison because the encoding is injective on canonical on-curve
   points;
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

Registration ends through one of two paths. Both freeze the same roster data and differ only in
authorization and in how `dealingDeadline` is derived. Both take the joined share-encryption keys
as calldata — `rosterKeys`, the full TE points in join order, length = joined count — because the
contract stores them compressed: it authenticates every entry against its stored word (§2.5), the
authorization addresses come from storage, and it computes `rosterHash` and `ctx` itself (§4.3).
No caller-supplied roster hash or opaque input vector exists.

**Manual close** `closeRegistration(action, orgSig, rosterKeys)`: requires
`registrationMode == Manual` (`WrongMode()` in Scheduled mode — invitees were promised time until
the published date, so the organizer cannot cut it short), phase `Registration`, joining still
open (`block.timestamp < registrationDeadline` when the expiry is nonzero, as in §8.2;
`RegistrationEnded()` after), `participantCount == joined count` (pins the roster the organizer
saw against late joins), `joined count >= t`. Effects: `n` frozen, `rosterHash` and `ctx` stored,
`dealingDeadline = block.timestamp + dealingDuration` (overflow-checked), phase `Dealing`.

**Time-based close** `closeRegistrationScheduled(ceremonyId, rosterKeys)`: permissionless, no
signature, no early override. Valid when phase is `Registration`; `registrationDeadline != 0`
(`WrongMode()` for a Manual ceremony without expiry); `block.timestamp >= registrationDeadline`
(`RegistrationNotDue()` before); `block.timestamp <= registrationDeadline + dealingDuration`
(`Expired()` after — see below); and `joined count >= t` (`BelowThreshold()`; abort is then the
valid move, §8.4). Effects as above, except
`dealingDeadline = registrationDeadline + dealingDuration` — **never**
`block.timestamp + dealingDuration`: a delayed caller consumes the remaining scheduled dealing
window and can never move the ceremony's schedule. This is the close path of a Scheduled
registration, and equally of a Manual registration whose expiry passed with enough members: at
the cutoff joining stops by predicate (§8.2) even while the stored phase still reads
`Registration`, and any browser or relayer may then submit the close — the chain does not wake
itself at a date, but no keeper dependency exists either, because ordinary client polling
suffices and nothing is lost by a late close. A close executed exactly at
`registrationDeadline + dealingDuration` creates a `Dealing` phase already at its deadline
(dealings are accepted only at that same timestamp; abort becomes valid one second later); any
later close reverts `Expired()` and the ceremony is abortable — a missed schedule aborts rather
than silently stretching.

Nothing about `t`, the member set, keys, deadlines or policy is mutable after close. Each member
may submit at most one dealing while phase is `Dealing` and `block.timestamp <=
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

The dealer submits `C[16]`, `E`, `masked[16]`, the Groth16 dealing proof (§8.5), the signed Deal
action and `rosterKeys` — the frozen roster again, in full TE (immutable after close, so no
pending dealing can make it stale). The contract requires: dealer has not dealt; the Deal signer
is the authorization address of member `dealerIndex`; every roster entry authenticates against
its stored compressed word, with length exactly `n` (§2.5); every `C`, `E` and `masked` word
`< p` (proof words are exempt, §7.2); `C_k == (0,1)` for `k >= t` and `masked_i == 0` for
`i >= n` (also enforced by the proof; checked early for clear errors); the recomputed
`payloadHash` matches the signed one. The Deal payload hash deliberately does not add the roster:
`ctx` already binds it, and the compressed-word authentication admits exactly one full value per
slot. It then builds the public input vector itself from storage and the authenticated calldata
(§8.5) and calls the DealVerifier.

On success the contract persists `compressed(E_j)` and the `n` active masked words, and folds the
commitments into a running aggregate instead of storing them:

```
first accepted dealing:   A_k <- C_{j,k}          for k < t   (verified points copied, no curve op)
every later one:          A_k <- A_k + C_{j,k}    for k < t   (complete extended coordinates,
                                                               one batch inversion for the t results)
```

The whole acceptance is atomic — validate, authenticate the roster, verify the proof, update the
aggregates, persist `E`/masked, set the QUAL bit and dealt count, emit — and any failure rolls
back everything: a failed proof changes nothing, a dealer cannot deal twice, and no
caller-supplied aggregate or aggregate snapshot exists anywhere in the API. Inductively, after
every acceptance `A_k = Σ_{j in QUAL} C_{j,k}` — exactly what v1's finalize computed in one batch
— and QUAL only grows, only by verified dealings. An intermediate identity value in any `A_k` is
legal and never aborts anything (§8.4 checks only the final `A_0`). The per-dealer commitment
vectors `C_j` are **not** durable state: they remain public in the accepted transaction's
calldata and events for whoever wants to attribute a historical dealing, but nothing in this
protocol may depend on reading them back (§8.6). A relayer cannot alter any component without
invalidating the signature, the proof or the authentication.

Aggregate storage encoding: each `A_k` coordinate is stored biased as `(x+1, y+1)`, each in
`[1, p]`; views and arithmetic subtract one. The bias makes every initialized aggregate slot
nonzero — including identity and cancellation values — so "unset" is distinguishable from
"identity" without an extra flag. Biased words are a storage detail only: never wire, event, hash
or circuit inputs, and readers must not decode uninitialized zeros by subtraction (before the
first dealing, `A` is implicitly the identity vector).

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
deal remains a full recipient. `finalize(ceremonyId)` is permissionless and its eligibility rule
is exactly v1's: phase `Dealing` and either `block.timestamp > dealingDeadline` with
`|QUAL| >= t`, or `|QUAL| == n` (early finalize; QUAL cannot grow further). Because the
aggregates are maintained at deal time (§8.3), finalize computes and stores nothing: it reads
`A_0`, sets the ceremony `Aborted` if `A_0 == O` (producing such a `P` requires proving knowledge
of a discrete log the adversary cannot know, so this is defense in depth, not an expected path),
and otherwise flips phase to `Live`, freezes QUAL and emits the full TE `P = A_0`. The key `P`,
the aggregates and every member key

```
PK_m = Σ_{k<t} m^k·A_k = Horner(A, m)
```

exist from then on as views over the stored aggregates; no member-key slot is ever written (§8.6,
§10.2). No caller-supplied aggregate is ever trusted. `|QUAL| >= t` guarantees at least one
honest dealer under the `< t` collusion assumption; it is deliberately the same conservative
policy as the public DKG.

`abort(ceremonyId)` is permissionless and valid exactly when:

- phase `Registration` with a nonzero `registrationDeadline` (Scheduled, or Manual with expiry),
  and either `block.timestamp >= registrationDeadline && joined count < t` (the roster never
  reached the threshold, so closing is impossible) or
  `block.timestamp > registrationDeadline + dealingDuration` regardless of the joined count
  (nobody closed within the scheduled window; closing is now `Expired()` and the schedule cannot
  be extended, §8.3);
- phase `Dealing` and `block.timestamp > dealingDeadline` with `|QUAL| < t` (unchanged from v1).

A Manual ceremony without expiry has no timeout abort: it waits for the organizer's close
indefinitely (clients warn about this at creation; a fresh ceremony is always possible, the stale
one is never repurposed). The close and abort predicates are disjoint at every instant: a roster
with `joined count >= t` cannot be aborted anywhere in
`[registrationDeadline, registrationDeadline + dealingDuration]`, where the permissionless close
is valid, and ordinary proposer timestamp skew is harmless because every window is
product-timescale (§8.7, clock semantics). `Live` and `Aborted` are terminal; a restart is a new
ceremony id with fresh dealings; accepted contributions are never deleted or replaced under the
old id.

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
outputs, and the release pins the generated verifier. The contract supplies index 0..4 from its
own state (`ctx`, the authenticated dealer's index, `n`, `t`); index 39..70 from the caller's
`rosterKeys` calldata after authenticating every active entry against the stored compressed
roster (§2.5, §8.3) — an authenticated entry is exactly the point admitted at join, including its
prime-subgroup membership — with `G` = Base8 for every slot `i >= n`; and 5..38 and 71..86 from
the submitted payload. No caller-supplied alternative input vector exists, and no compressed word
ever enters the vector. **v2 changes neither circuit**: the statement, both public-input orders,
the signal names, witness keys and padding rules are byte-identical to v1, and every public input
stays a full canonical TE coordinate in calldata.

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

Member `m` with secret `x_m`, at any time after finalization, reads from **current** chain state
— never event logs, old transaction calldata or receipts — the frozen roster (compressed,
decompressed and revalidated locally per §2.5), `ctx`, QUAL, every QUAL dealer's `compressed(E_j)`
and `masked_{j,m}`, and the aggregates `A`. For each `j` in QUAL:

```
E_j: decompress; require canonical, on curve, prime subgroup, non-identity locally
     before any secret-dependent arithmetic
S_{j,m} = x_m·E_j
h_{j,m} = Poseidon7(MASK_CONST, ctxHi, ctxLo, j, m, S_{j,m}.x, S_{j,m}.y)
s_{j,m} = masked_{j,m} - h_{j,m}  mod p
```

Since `s_{j,m} < r < p`, the mod-p unmasking is exact. The client must then check, and hard-fail
on any mismatch:

1. `s_{j,m} < r` for every dealer (cannot fail for an accepted dealing; detects wrong context or
   implementation);
2. every `A_k` read from state is canonical, on curve and in the prime subgroup (the identity is
   allowed), checked locally;
3. `s_m = Σ_{j in QUAL} s_{j,m} mod r` satisfies `s_m·G == Horner(A, m) = PK_m`, computed locally
   and cross-checked against the contract's `getMemberKey` view.

v1's mandatory per-dealer Feldman check `s_{j,m}·G == Horner(C_j, m)` no longer exists: the
per-dealer commitment vectors are not durable state (§8.3). The guarantee is not weakened — each
`C_j` was proof-verified at acceptance and folded into `A`, and the aggregate check above catches
any corruption of the sum — but per-dealer **attribution** of a corruption is lost; that is an
accepted, deliberate trade. A client that still holds historical `C_j` calldata may use it for
debugging, but recovery MUST NOT depend on it. These checks are defense in depth; the dealing
proofs are what guarantee they pass. On any mismatch: halt. Do not attempt alternate reductions,
omit a dealer, or repair a point by cofactor multiplication; a discrepancy between an accepted
proof and a failed check is a circuit/protocol incident requiring a halt, not a dispute to
adjudicate. A member that never dealt, or was offline at finalization, recovers its complete
final share exactly the same way.

### 8.7 Decryption opening

Each ceremony fixes at creation (§8.1) an immutable, ceremony-wide decryption-opening policy. All
times are absolute `uint64` Unix seconds evaluated against `block.timestamp`; only
`dealingDuration` is a duration. The gate predicate, for an existing ceremony `c`:

```
isDecryptionOpen(c, now) =
  c.phase == Live && (
       (c.decryptionMode == Scheduled && now >= c.decryptionOpenAt)
    || (c.decryptionMode == Manual && (
            c.manualOpenedAt != 0
         || (c.manualDecryptionFallbackAt != 0 && now >= c.manualDecryptionFallbackAt)))
  )
```

`openDecryption(action, orgSig)` requires an existing `Live` ceremony, Manual mode (`WrongMode()`
for Scheduled — a scheduled date cannot be accelerated), a valid unexpired organizer signature
over the OpenDecryption struct (§7.2), and `isDecryptionOpen == false` (`AlreadyOpen()`
otherwise, including when the fallback date has already opened the gate). It sets
`manualOpenedAt = block.timestamp` and emits `DecryptionOpened`. Scheduled opening and the manual
fallback are effective **by predicate alone**: zero transactions, zero state writes, no event, no
keeper — views are authoritative and clients poll them. Opening is irreversible and
ceremony-wide: it applies to every existing and future request, because every request shares one
key; two processes that need independent opening dates need two ceremonies. There are no
per-request opening timestamps, which would falsely suggest cryptographic isolation.

The gate is enforced on **`submitPartial`, `combine` and `publishPartialData`**
(`DecryptionNotOpen()`), checked before any expensive verification or arithmetic; a gate failure
never consumes a one-shot slot or changes a result. (On `publishPartialData` the check is
uniformity, not protection — a partial cannot exist before opening, so nothing is blocked there;
this is stated so future readers do not hunt for the attack it prevents.) Gating only combine
would be useless: `t` accepted partials are already public data. Requests may be admitted while
the gate is closed (§9.2). Honest clients enforce the same policy on themselves: a client MUST
refuse to compute, export or prove `D = s_i·C1` until a finalized authenticated snapshot (§9.3)
says the gate is open; recovering one's share locally before opening is fine, but it must not
trigger partial generation.

State this honestly everywhere it is user-visible: the gate is **policy, not a cryptographic time
lock**. It bounds what the contract accepts and what honest members and clients do; any `t`
colluding members can recover their shares and compute partials and plaintexts off chain at any
earlier time, and a timestamp cannot split the shared key into separate privacy domains (§11.2).
For elections the recommended Manual configuration carries a **nonzero fallback date** ("I can
open the results sooner; otherwise the committee may unlock them on this date"): without one,
loss or permanent absence of the organizer blocks honest on-chain progress forever. Disabling the
fallback is an explicit advanced choice. For a hard honest-client not-before date, use Scheduled,
not Manual-with-fallback. The fallback is an availability backstop, not forced decryption: `t`
willing, key-retaining members and transaction inclusion are still needed.

Clock semantics: every timestamp gate is evaluated at an included block, not at a wall-clock
alarm; block production, proposer timestamp rules, RPC lag and finality delay every transition,
and no execution at the displayed second is guaranteed. Ordinary validator timestamp skew (a few
seconds) is tolerated by construction: every window is product-timescale (hours to months) and
the close/abort predicates are disjoint at every instant (§8.4), so skew can only shift a
transition by seconds, never create a state where two contradictory moves are both valid. Clients
display dates with an explicit timezone and wait for a finalized open snapshot, never for a
device countdown.

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
`D = s·C1` for whatever `C1` the contract feeds it, so a small-order point such as
`C1 = (0, p − 1)` — a canonical, on-curve point of order two, rejected by the prime-subgroup
check, not by canonicality — or a torsion-shifted `C1` (both found guarded only here by the
adversarial review) is stopped at admission or nowhere.
Identity handling: DAVINCI's registry skips all-zero accumulator fields before calling the adapter
(its `zeroSkipped` mapping) and rejects half-identity fields, so an identity C1 or C2 reaching the
manager is a protocol violation and is rejected; a non-DAVINCI adapter must do its own
zero-field mapping upstream. The request record stores `fieldCount`, `requestId`, empty
partial/completion state and the ciphertexts as compressed words (§2.5):
`compressed(C1_0), compressed(C2_0), compressed(C1_1), …` in field order — stored, never
hash-only, because a request can arrive months before the gate opens (§8.7) and its complete
ciphertexts must stay recoverable from current state; the SDK decompresses and revalidates them
locally (§9.3). Plaintext bound: every combined `m_k` must satisfy
`m_k < RESULT_BOUND = 2^40`; DAVINCI's `maxValue·maxVoters <= 10^12` cap keeps honest results far
below it.

Requests have no deadline, and admission is independent of the decryption gate: a `Live` ceremony
accepts requests indefinitely, before or after its opening date. What gates decryption in time is
the DAVINCI side (process ended, grace closed, accumulator proven against the settled state root)
plus the ceremony's opening policy (§8.7) plus the committee's own participation. State this
honestly: the contract bounds what it accepts; it cannot prevent `t` colluding members from
decrypting anything off chain.

### 9.3 Browser checks before computing a partial

A client must refuse to compute `s_i·C1` for anything it has not independently verified from
chain state via its pinned deployment. Before signing a Partial action it must check:

1. the state snapshot is authenticated: the client performs every security-relevant read against
   at least two independently administered pinned RPC providers (at least one assumed honest) and
   requires them to agree on the finalized block hash and, at that block, on the ceremony,
   binding, request, membership, phase-policy/opening and verification-key state; on disagreement
   or unavailability it refuses — it never takes the first successful response. Chain id and CouncilManager address
   must match the app's pinned deployment (an untrusted RPC's claimed chain id is not
   authentication). The request's admission must be in a finalized block before a partial or its
   proof leaves the browser. A light client may replace the two-provider rule later. Exception: a
   single RPC endpoint is permitted only when the app runs in an explicitly declared local
   development mode (e.g. Anvil, chain id 31337), never on a production chain;
2. the ceremony is `Live`, **its decryption gate is open (§8.7)** — the client refuses to compute
   `D` while it is closed, however valid everything else is — its stored `rosterHash`/`ctx` match
   the locally recomputed values (roster keys decompressed from state and revalidated per §2.5),
   and the member's own index, authorization address and `X_i` match the roster;
3. the request exists on chain, was submitted by an adapter the ceremony allows, and is bound to
   a process id the user can be shown;
4. every `C1_k` (and `C2_k`), decompressed from the stored words, is canonical, on curve and in
   the prime subgroup, re-checked locally in TE; never "repair" an invalid point by cofactor
   multiplication: that decrypts a different ciphertext — reject it;
5. the recovered `s_i` is canonical and `s_i·G == PK_i`, with `PK_i = Horner(A, i)` recomputed
   locally from the stored aggregates and cross-checked against the `getMemberKey` view;
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

Inactive padding: the contract supplies `C1[k] = G` (Base8) for `k >= activeCount` (the active
`C1` entries come from the caller's calldata, authenticated against the stored compressed words,
and `PK` is derived from the aggregates — §10.2; the vector itself is unchanged from v1), and
requires `D[k] = O` for `k >= activeCount`; the circuit constrains both itself
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

`submitPartial(action, sig, D, proof, C1)` first loads the request by `action.requestId` and
requires: the request exists; `action.ceremonyId == request.ceremonyId` (a partial signed and
proven under an attacker-controlled ceremony with a victim's request id is rejected before it can
consume a slot); and the ceremony's decryption gate is open (§8.7, `DecryptionNotOpen()`),
checked before any expensive work. From that stored ceremony — and only from it — the contract
takes `n` and the member's authorization address, and derives `PK_i = Horner(A,
participantIndex)` from the stored aggregates (§2.2 item 3); no member-key slot exists and no
caller-supplied `PK` is ever accepted. The `C1` calldata carries the request's active ciphertext
bases as full TE points, exactly `fieldCount` of them in field order; each is authenticated
against its stored compressed word (§2.5), and the contract fills slots `k >= fieldCount` with
`G` internally. It then requires: `participantIndex ∈ 1..n`; the signer is that member's
authorization address; no accepted partial yet for `(requestId, participantIndex)`; every `D`
word `< p` (proof words are exempt, §7.2); `D[k] == (0,1)` for `k >= fieldCount`; the recomputed
`payloadHash` (unchanged from v1: requestId, `D`, proof) matches the signed one. The contract
builds the public inputs itself and calls the PartialVerifier.

On success the contract does **not** store the `D` coordinates. It computes the durable
partial-data commitment

```
partialDataHash = K("davinci-dkg-council/v2/partial-data",
    uint256 chainId, address manager, bytes12 ceremonyId, bytes32 requestId,
    uint8 participantIndex, uint8 fieldCount,
    uint256[2][16] D)        // full TE, identity-padded through slot 15,
                             // exactly as in the Partial payload
```

stores that one word, sets the member's bit in the partial bitmap (existence is the bitmap, never
"the hash is nonzero"), records the block number of this publication (`uint64`, packed;
`BlockNumberOverflow()` rather than truncation — unreachable in practice), and emits
`PartialAccepted` plus `PartialDataPublished(requestId, participantIndex, partialDataHash, D)`
carrying all 16 padded points. Combine re-supplies the vectors against this commitment (§10.3);
§10.4 defines where they live meanwhile. The commitment is deliberately **not** the signed
Partial payload hash: that hash includes the Groth16 proof, whose prover randomness is not
recoverable from the member's root, whereas `D` is deterministic from the recovered share and the
stored ciphertexts — determinism is what makes permissionless re-publication (§10.4) possible.
The preimage binds chain, manager, ceremony, request, member index, field count and every padded
point, so substitution, permutation, truncation, cross-request and cross-chain replay all fail
(§12 vectors). Context binding is otherwise unchanged at the action/state boundary: the signed
Partial action binds this exact `requestId` and payload, and one-shot state prevents reuse; the
mathematical statement `D = s·C1` is deliberately context-free, and an unconstrained "request id"
circuit input would add nothing (it would not appear in any constraint). Since every `D` is
proven equal to `s·C1` on a subgroup base, the contract performs no subgroup products on `D`.

Because the per-field combine check (§10.3) is exact, partial soundness does not rest on any
batching argument: a malicious last submitter cannot steer the result; an invalid `D` simply
cannot be proven.

### 10.3 Combine

Once at least `t` partials are accepted for a request and the gate is open, anyone may call

```
combine(requestId, uint8[] memberSet, uint8[] fieldIndexes, uint64[] plaintexts,
        uint256[2][16][] partialVectors, uint256[2][] C2)
```

re-supplying the data the contract committed to but did not keep: `partialVectors` holds exactly
`t` full identity-padded `D` vectors, one per `memberSet` entry in that order; `C2` holds one
full TE point per supplied field index, in that order. Validation, in order and all of it before
any curve arithmetic:

1. the request's ceremony is `Live` and its decryption gate is open (§8.7);
2. the v1 checks, unchanged: `memberSet` has exactly `t` entries, strictly increasing, each in
   `1..n` and each with an accepted partial for this request; `fieldIndexes` has 1 to
   `MAX_COMBINE_FIELDS = 4` entries, strictly increasing, each `< fieldCount` and not yet
   completed; `plaintexts` has the same length with every `m_k < 2^40`. Different chunks may use
   different member sets;
3. for every selected member, the contract recomputes the **full** `partialDataHash` of §10.2 —
   over the complete padded 16-slot vector with the stored ceremony/request context and
   `fieldCount`, never over a field slice — and requires exact equality with the stored
   commitment (`PartialDataMismatch()`). This re-authenticates the original proof-validated,
   canonical, padded vector without re-running its Groth16 proof and without any subgroup
   product;
4. every supplied `C2_k` is authenticated against its stored compressed word (§2.5: canonical,
   on curve, exact compressed equality).

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
analysis to maintain — and the re-supplied calldata adds no new assumption, because the hash
commitment admits exactly one vector per member. An incorrect in-range `m_k` fails outright
because `2^40 < r`. On success each field's plaintext is stored (a `uint40` storage lane behind
the unchanged `uint64` ABI, lossless under `RESULT_BOUND = 2^40`) and marked complete, atomically
per chunk; completed fields are immutable, and the completion bitmap — never a nonzero value —
distinguishes a legitimate zero plaintext from an uncompleted field. The request is complete when
all `fieldCount` fields are. The DAVINCI adapter's `plaintexts` view reports `ready` only then,
so the registry can never read a partial result vector as final.

Calldata is the deliberate price of the storage diet: at `n = t = f = 16` the re-supplied vectors
are `16·16·2·32 = 16,384` bytes per combine call, repeated over the eight 2-field chunks.
`MAX_COMBINE_FIELDS = 4` and the combiner's conservative `min(4, max(1, ⌊32/t⌋))` chunk guideline
are unchanged; benchmark larger chunks before ever changing the guideline. (A possible later
micro-optimization — compare the compressed computed right-hand side against the stored `C2` word
and drop the `C2` calldata — is deliberately not in v2: the explicit authenticated interface is
easier to review next to the exact equation.)

Off chain, the combiner computes `M_k = C2_k - Σ λ_i·D_{i,k}` from public data and finds
`m_k` with `M_k = m_k·G` by baby-step/giant-step bounded by `2^40` (about `2^20` baby steps and
up to `2^20` giant steps per field; roughly 40–70 MB of table). The relayer runs this natively;
anyone can (prior art runs a full 2^40 BabyJubJub BSGS in a browser in seconds). The combiner
needs no trust: it only proposes `m_k` values the contract verifies exactly. If a plaintext is
out of range — impossible for an accumulator proven under DAVINCI's result cap — the field can
never complete and the request stays incomplete; there is no out-of-range escape hatch.

### 10.4 Partial-data availability and re-publication

The storage diet changes where `D` vectors live between partial and combine, so v2 states the
data-availability rules exactly.

**A member's own path never reads history.** Joining, contributing, recovering a share, and
computing and submitting a partial read only current contract state through the view functions at
a finalized anchor — never event logs, old transaction calldata, receipts, an indexer or an
archive node. Decryption happens months after the ceremony behind public RPC providers that prune
exactly those; this rule is load-bearing and tested.

**The combiner path, normative order.** To build a combine call, the combiner (relayer or SDK):

1. uses its own cache of every `D` vector it submitted or relayed — the SDK persists the member's
   own vector at submit time, the relayer caches every vector it carries until the request
   completes;
2. else performs **one** `eth_getLogs` query at the exact block number stored in that member's
   partial commitment (`getPartialCommitment`), filtered by request and member — a single-block
   query at a recorded recent block, never a range scan — and checks the emitting address and the
   recomputed `partialDataHash` against state. The hash is the authentication; logs, caches,
   files or any other transport are interchangeable and untrusted. This bounded read is the one
   deliberate, owner-approved exception to the no-historical-reads rule, and it is a convenience:
   path 3 never needs it;
3. as the liveness fallback, has any accepted member republish: because `D` is deterministic from
   the member's recovered share and the stored ciphertexts (§10.2), a member who returns — months
   later, with nothing but the twelve words and current state — recomputes `D = s_i·C1` and calls
   `publishPartialData`; the old commitment matches without the old proof. Old logs are therefore
   never *required*, by anyone.

`publishPartialData(requestId, participantIndex, D)` is permissionless: it requires an admitted
partial for that member (the bitmap) and the open gate (§8.7; uniformity, not protection),
recomputes the deterministic `partialDataHash` over the supplied vector and rejects a mismatch
(`PartialDataMismatch()`), emits `PartialDataPublished` again and updates that member's
publication block to the current one. It never changes the stored hash, the bitmap, any proof,
the member set or a completed plaintext, and the one-shot rule of `submitPartial` does not apply
to it.

**The changed liveness property, stated exactly.** `t` partial *hashes* alone no longer let an
unattended combiner finish after every copy of their preimages has disappeared: at least `t`
matching vectors must be available through some transport, or enough accepted members must return
to reconstruct them. The months-scale ceremony-to-decryption recovery guarantee (§8.4, §8.6) is
unaffected — shares, aggregates and ciphertexts stay in state — and in the normal flow partials
are produced at decryption time, so combine data is minutes old when it is needed; short-lived
combine data is the explicit, deliberate exception. A deployment that instead requires indefinite
unattended completion after the last member disappears must persist compressed `D` (about `t·f`
words per request) rather than hashes; that is a known non-goal of v2.

Relayer sponsorship of re-publication must be restricted to incomplete requests with genuinely
missing or stale data, with per-request/member backoff: a permissionless same-data refresh must
not become a loophole around the relayer's spending quotas. Ordinary self-paying callers need no
such rule in the contract.

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
| Recovery kit leaked | Full impersonation of that participant; all ceremonies under that root | Kit carries an explicit warning; per-ceremony derivation separates contexts but not root compromise; no refresh in any version |
| Malicious frontend / dependency | Exfiltrates roots and witnesses | Pinned, reproducible, third-party-script-free app; artifact hashes pinned; independent client possible from this spec; the threshold assumption covers endpoints too |
| Chain reorg / censorship near a deadline | Honest dealing excluded | Generous deadlines; deterministic dealing rederivation makes resubmission free; abort+restart is always safe |
| Organizer absent forever (Manual decryption, no fallback) | Honest on-chain decryption blocked forever | Policy choice, warned at creation; the recommended default is a nonzero fallback date (§8.7); `t` members can still decrypt off chain — absence blocks only the on-chain path |
| Late time-based-close caller | Tries to stretch the dealing window | `dealingDeadline` derives from the scheduled time, never the caller's block (§8.3); after the window, close is refused and abort opens |
| Combine data (`D` vectors) lost before combine | Decryption stalls with hashes on chain | Any accepted member recomputes and republishes its own `D` deterministically (§10.4); shares, aggregates and ciphertexts never leave state |
| `t` members compute partials before the opening date | Early disclosure off chain | Not preventable: the gate is policy, not a time lock (§8.7); the contract refuses early partials/combines and honest clients refuse to compute them — nothing more is claimed |
| Caller substitutes a same-compressed full point | Forged roster key / ciphertext at authentication | On-curve check inside §2.5 authentication (`(G.x, G.y+2)` is the pinned example); injectivity on canonical on-curve points makes the stored word admit exactly one point |

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
two votes should run two ceremonies. The decryption gate (§8.7) adds nothing to this analysis: it
bounds the contract and honest clients, never `t` colluding members, and the `< t` corruption
bound remains cumulative over the key's lifetime (§5.3).

### 11.3 What Council does not claim

- No Sybil resistance, no personhood: invites are capabilities.
- No unbiased key: secrecy under one honest accepted dealer, nothing stronger.
- No forced participation: decryption liveness is a human property; the protocol only makes any
  `t` members sufficient.
- No forward secrecy: the recovery property is the deliberate opposite; root compromise is
  retroactive.
- No post-quantum security; about `2^125` classical group security and BN254 pairing assumptions.
- No cryptographic time lock: the decryption opening policy (§8.7) binds the contract and honest
  clients; `t` colluding members can decrypt off chain at any time.
- No unattended combine after total combine-data loss: liveness then needs a returning accepted
  member or a surviving vector copy (§10.4); everything months-scale stays recoverable from
  state.

### 11.4 Long-term risks over the key's lifetime

A ceremony key routinely protects results for months. The risks below are not attacks on any
single step; they accumulate or only bite long after the ceremony, which is where operational
documents, not the contract, carry the mitigation. The operator-facing procedures live in
[organizer-guide.md](organizer-guide.md), [hosting.md](hosting.md), [forks.md](forks.md) and
[incident-response.md](incident-response.md).

| Long-term risk | Consequence | Guidance |
|---|---|---|
| Cumulative member compromise | The `< t` collusion bound is cumulative over the key's lifetime: shares compromised in different months add up, and everything ever encrypted to the key is then readable, forever | Size `t` for the lifetime, not the ceremony week; retire keys; fresh ceremony per election cycle (organizer-guide) |
| Recovery-root exposure spans ceremonies | One leaked root impersonates that person in every ceremony derived from it, past and future; per-ceremony derivation separates contexts, not root compromise | Fresh roots (new twelve words) where committees must fail independently |
| Kits are plaintext roots | Whoever holds a kit file is that member | Offline custody, never pooled by the organizer; password-encrypted export is a future option (§5.3) |
| A future refresh would not erase exposure | Even if resharing existed, old ciphertexts would stay decryptable by old share sets; there is no refresh in any version | Do not plan around a refresh; plan key lifetime instead |
| Organizer disappearance | Manual decryption without a fallback blocks honest on-chain opening forever; Manual registration without an expiry can stall a ceremony in Registration forever | Nonzero fallback date and a registration expiry (§8.1, §8.7); the app warns when disabled |
| Manual fallback semantics | The fallback is a latest-opening backstop, never a not-before: the organizer can always open earlier | For a hard honest-client not-before date, use Scheduled (§8.7) |
| Adapter grants are load-bearing | An arbitrary allowed adapter can submit requests the committee will decrypt — a decryption oracle for the key (§11.2) | Allow only the official DAVINCI adapter, read from the registry itself; authorize only known creators (organizer-guide) |
| One key across processes | A shared privacy domain under conditional isolation (§11.2); opening dates cannot split it | Separate ceremonies for independent privacy domains; separate roots for hard isolation |
| Timestamp predicates are not alarms | Transitions take effect at an included block, delayed by block production, RPC lag and finality — never at the displayed second (§8.7) | Clients wait for finalized snapshots; operators plan for finality lag, not wall clocks |
| RPC unanimity can stall | Authenticated reads require every configured provider to agree (§9.3): one lagging or frozen provider halts the app, by design | Provider hygiene as an active duty: quarterly and pre-opening reviews, documented rotation (hosting.md) |
| The 365-day bound is the dealing window only | `MAX_DEALING_DURATION` bounds nothing but the Dealing phase; a Live ceremony and its key never expire | Key-lifetime management is organizer policy, not a protocol limit |
| No upgrade, no pause | A bug found mid-election cannot be fixed in place; a Live ceremony can never be stopped on chain | A written incident policy before any real election: suspend client participation, exceptional independently verified tallying by `t` members, cancel and rerun on a new deployment (incident-response.md) |

## 12. Cross-implementation vectors

The committed vectors live at `tests/vectors/` and are asserted by the SDK tests, the Foundry
tests and the circuit tests. Files and contents:

| File | Contents |
|---|---|
| `constants.json` | every §2 constant, all tag hashes, `MASK_CONST`, `LIMIT_R`, one fixed 7-input `Poseidon7` evaluation (cross-checks the Poseidon parameterization) |
| `derivation.json` | `HashToScalar` and `DeriveScalar` outputs including at least one rejection-loop case; a full key derivation (every §5.2 purpose) from the pinned test mnemonic `test test test test test test test test test test test junk` |
| `identifiers.json` | ceremony id, roster hash, `ctx`, request id examples |
| `eip712.json` | domain separator (version `"2"`) and one digest per §7.2 struct, including the v2 CreateCeremony and OpenDecryption |
| `dealing.json` | a complete honest dealing end to end: coefficients, shares, masks, both payload hashes, and the full 87-word public-input vector (unchanged in v2) |
| `recovery.json` | §8.6 share recovery for the `dealing.json` ceremony: ephemeral/mask/aggregate-based, with no per-dealer commitment dependency |
| `combine.json` | Lagrange coefficient vectors for several member subsets and one full combine equation instance |
| `codec.json` | §2.5 encodings: `G`, `−G`, `O`, the order-two `(0, p−1)` zero word, a torsion point, a `y`-parity edge case; rejections: set bit 254, `x >= p`, coordinate aliases `x + p` / `y + p`, a nonsquare `y²`, and the same-compressed off-curve point `(G.x, G.y + 2)` |
| `partialdata.json` | deterministic `partialDataHash` vectors (§10.2), including a mutation of every bound preimage field |
| `schedule.json` | §8.1 policy-validation cases and the §8.3/§8.4/§8.7 predicate boundaries at `−1` / equal / `+1` of every timestamp |

v2 regenerates every signature and calldata fixture (the domain version changed); circuit-level
vectors and fixtures for the unchanged statements remain valid and are reused, not regenerated
(the circuit setup is randomized, so gratuitous regeneration only churns pins).

The vectors pin test-only deployment parameters — chain id `31337`, manager
`0x5fbdb2315678afecb367f032d93f642f64180aa3`, circuit release id
`0xe7561fc861548402ef3be7636860f2f3222d56434400696037fca59f7e85e8b0` — that belong to no real
release (the development release's id is the architecture document's pin); a vector file
matching a live deployment would be a bug, not a convenience.

The generator, `circuits/scripts/gen-vectors.ts` (`make vectors`), is a standalone TypeScript
program (noble-hashes/noble-curves, poseidon-lite and viem only). It must **not** import the SDK: the SDK asserting vectors produced by its own code
would be self-referential. The acceptance tests of the implementation (mutation, adversarial,
padding, zero-share, replay) are listed in `docs/architecture.md`.
