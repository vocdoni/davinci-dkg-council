/**
 * Council protocol constants (protocol.md §2).
 *
 * This module is the single source every other module imports. Every pinned
 * value here is asserted against the cross-implementation vectors
 * (`tests/vectors/constants.json`) and recomputed in unit tests.
 */

/** BN254 scalar field prime = circom native field = BabyJubJub coordinate field. */
export const P = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

/** Prime order of BabyJubJub's large subgroup. All secret scalars live in F_r. */
export const R = 2736030358979909402780800718157159386076813972158567259200215660948447373041n;

/** Twisted Edwards coefficients (circomlib chart): a·x² + y² = 1 + d·x²·y². */
export const TE_A = 168700n;
export const TE_D = 168696n;

/** Cofactor. */
export const COFACTOR = 8n;

/** Curve order 8·r. */
export const CURVE_ORDER = 21888242871839275222246405745257275088614511777268538073601725287587578984328n;

/** Generator G = circomlib Base8 (generates the prime-order subgroup), TE coordinates. */
export const GX = 5299619240641551281634865583518297030282874472190772894086521144482721001553n;
export const GY = 16950150798460657717958625567821834550301663161624707787222815936182638968203n;

/** Identity element O = (0, 1). */
export const IDENTITY_X = 0n;
export const IDENTITY_Y = 1n;

/** TE <-> reduced-form x scaling constants (protocol §2.2): x_reduced = x_te·K mod p. */
export const FORM_K = 15527681003928902128179717624703512672403908117992798440346960750464748824729n;
export const FORM_K_INV = 1911982854305225074381251344103329931637610209014896889891168275855466657090n;

/** secp256k1 group order (authorization / capability key modulus). */
export const SECP256K1_N = 115792089237316195423570985008687907852837564279074904382605163141518161494337n;

// --- Sizes and bounds (protocol §2.3) ---

export const MAX_N = 16;
export const MAX_T = 16;
export const MAX_FIELDS = 16;
export const RESULT_BOUND = 1n << 40n;
export const MAX_COMBINE_FIELDS = 4;
export const MAX_INVITES = 64;
export const MIN_DEALING_DURATION = 600n; // seconds

/** Number of public signals of the dealing circuit (protocol §8.5). */
export const DEAL_PUBLIC_SIGNALS = 87;
/** Number of public signals of the partial-decryption circuit (protocol §10.1). */
export const PARTIAL_PUBLIC_SIGNALS = 67;

// --- Domain tags (protocol §2.4) ---

export const TAG_CEREMONY = 'davinci-dkg-council/v1/ceremony';
export const TAG_ROSTER = 'davinci-dkg-council/v1/roster';
export const TAG_DEAL_CONTEXT = 'davinci-dkg-council/v1/deal-context';
export const TAG_DEAL_PAYLOAD = 'davinci-dkg-council/v1/deal-payload';
export const TAG_JOIN_POP = 'davinci-dkg-council/v1/join-pop';
export const TAG_REQUEST = 'davinci-dkg-council/v1/request';
export const TAG_PARTIAL_PAYLOAD = 'davinci-dkg-council/v1/partial-payload';
export const TAG_CIRCUIT_RELEASE = 'davinci-dkg-council/v1/circuit-release';
export const TAG_SHARE_MASK = 'davinci-dkg-council/v1/share-mask-poseidon';

/** Pinned keccak256(utf8(tag)) values; recomputed and asserted in tests. */
export const TAG_HASHES: Record<string, `0x${string}`> = {
  [TAG_CEREMONY]: '0xecb738c07e6a59197a7fd9e2f5e6116948f75ddf4ac1167be6d353868161465f',
  [TAG_ROSTER]: '0x2c9d4948616c1a88c354348793d30f18ea38d1f04ad5854da9e32746a3b11ac9',
  [TAG_DEAL_CONTEXT]: '0xdbb35e5b108ffc795df6963925b9215f480adc307c37d7301c3e91d8e2b7bb7c',
  [TAG_DEAL_PAYLOAD]: '0x1326b87fc239e1401c315964035b32e39ac95374aecd1472e03710d68890394e',
  [TAG_JOIN_POP]: '0xf82c8d4d3410e2766e553a29e47765d8dca7d7bb5d3c8d1226c3736cb39bbb19',
  [TAG_REQUEST]: '0x2044a532478c345d057d687f1827a3c194b5c92d1c7471f6aa59fe10fe010ba7',
  [TAG_PARTIAL_PAYLOAD]: '0x790ea2a939d8ccdf25ac8c84f7bffca5476a976d584b89ca4a7f365b8e85c589',
  [TAG_CIRCUIT_RELEASE]: '0x9e489062d0e615d54b9cf250918652a1541571f981e4892e70d382d1536fdf5c',
  [TAG_SHARE_MASK]: '0xd8262d0eb7248e9458410cb71d8ace07c8eabd235f11ed9fb71812260a9dc8f2',
};

/**
 * The share-mask field constant: the only tag reduced into the field
 * (`uint256(keccak256(tag)) mod p`, protocol §2.4).
 */
export const MASK_CONST = 10214054970402064552395134490408265161209242095674905809605444618984955431150n;

/**
 * Rejection-sampling limit for F_r: `floor(2^256 / r) · r = 42·r` (protocol §3.1).
 */
export const LIMIT_R = 114913275077156194916793630162600694215226186830659824886409057759834789667722n;

// --- Key derivation (protocol §5) ---

/** HKDF-Extract salt for the recovery root. */
export const SEED_SALT = 'davinci-dkg-council/seed/v1';

export const DERIVE_PREFIX = 'davinci-dkg-council/v1/derive/';
export const PURPOSE_AUTH = `${DERIVE_PREFIX}auth-secp256k1`;
export const PURPOSE_SHARE_ENCRYPTION = `${DERIVE_PREFIX}share-encryption-bjj`;
export const PURPOSE_ORGANIZER_AUTH = `${DERIVE_PREFIX}organizer-auth-secp256k1`;
export const PURPOSE_INVITE_CAPABILITY = `${DERIVE_PREFIX}invite-capability-secp256k1`;
export const PURPOSE_DEALER_COEFFICIENT = `${DERIVE_PREFIX}dealer-coefficient`;
export const PURPOSE_DEALER_EPHEMERAL = `${DERIVE_PREFIX}dealer-ephemeral`;

/** Derivation version, fixed for v1. */
export const DERIVATION_VERSION = 1;

// --- EIP-712 (protocol §7.1) ---

export const EIP712_NAME = 'DAVINCI DKG Council';
export const EIP712_VERSION = '1';

/** Ceremony phases (architecture §1.2). */
export enum Phase {
  None = 0,
  Registration = 1,
  Dealing = 2,
  Live = 3,
  Aborted = 4,
}

/** Recovery kit format identifier (protocol §5.3). */
export const KIT_FORMAT = 'davinci-dkg-council-kit/v1';
