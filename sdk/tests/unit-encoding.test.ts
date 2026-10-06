/** Unit tests for encodings, JCS, the recovery kit and invite links. */

import { describe, expect, it } from 'vitest';
import {
  bigIntToHex32,
  bytes32ToLimbs,
  fromDecimal,
  hexToBigInt32,
  isCanonicalScalar,
  limbsToBytes32,
  normalizeCeremonyId,
  normalizeProcessId,
  toDecimal,
} from '../src/encoding.js';
import { jcsCanonicalize } from '../src/jcs.js';
import {
  buildKit,
  kitChecksum,
  parseKit,
  printableSheet,
  rehearseEntry,
  restoreFromKit,
  serializeKit,
  type KitManifestEntry,
} from '../src/kit.js';
import {
  buildInviteLink,
  deriveInviteCapability,
  parseInviteFragment,
  parseInviteLink,
  signInvite,
} from '../src/invites.js';
import { assertCanonicalSignature, recoverActionSigner } from '../src/eip712.js';
import { participantAuthKey, rootFromMnemonic, shareEncryptionKey } from '../src/keys.js';
import { P, R, SECP256K1_N } from '../src/constants.js';
import type { Hex, InviteMessage } from '../src/types.js';

const MNEMONIC = 'test test test test test test test test test test test junk';
const MANAGER: Hex = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
const CID: Hex = '0xba92d83fa5be494b998b1667';

describe('encoding round trips and rejections', () => {
  it('bytes32 <-> limbs', () => {
    const h: Hex = '0x4154f898755e39e2aa28ff07207710cfd25b161c473563bdab203dbd5d9e7794';
    expect(limbsToBytes32(bytes32ToLimbs(h))).toBe(h);
    const limbs = bytes32ToLimbs(h);
    expect(limbs.hi).toBe(BigInt(`0x${h.slice(2, 34)}`));
    expect(limbs.lo).toBe(BigInt(`0x${h.slice(34)}`));
  });

  it('bigint <-> hex32 and decimal', () => {
    for (const v of [0n, 1n, P - 1n, (1n << 255n) + 7n]) {
      expect(hexToBigInt32(bigIntToHex32(v))).toBe(v);
      expect(fromDecimal(toDecimal(v))).toBe(v);
    }
    expect(() => fromDecimal('01')).toThrow();
    expect(() => fromDecimal('')).toThrow();
    expect(() => fromDecimal('-1')).toThrow();
    expect(() => bigIntToHex32(1n << 256n)).toThrow();
  });

  it('id normalization accepts exact widths only', () => {
    expect(normalizeCeremonyId('0xBA92D83FA5BE494B998B1667')).toBe(CID);
    expect(() => normalizeCeremonyId('0x1234')).toThrow();
    expect(() => normalizeCeremonyId(`${CID}00`)).toThrow();
    const pid = `0x${'7'.repeat(62)}`;
    expect(normalizeProcessId(pid.toUpperCase().replace('0X', '0x'))).toBe(pid);
    expect(() => normalizeProcessId(`0x${'7'.repeat(64)}`)).toThrow();
  });

  it('scalar canonicity', () => {
    expect(isCanonicalScalar(0n)).toBe(true);
    expect(isCanonicalScalar(R - 1n)).toBe(true);
    expect(isCanonicalScalar(R)).toBe(false);
    expect(isCanonicalScalar(-1n)).toBe(false);
  });
});

describe('jcs (RFC 8785)', () => {
  it('sorts keys and canonicalizes recursively', () => {
    expect(jcsCanonicalize({ b: 2, a: 1 } as never)).toBe('{"a":1,"b":2}');
    expect(jcsCanonicalize({ z: [{ y: true, x: null }], a: 'x' } as never)).toBe('{"a":"x","z":[{"x":null,"y":true}]}');
  });

  it('serializes strings and numbers like JSON.stringify', () => {
    expect(jcsCanonicalize({ s: 'a\n"b"é' } as never)).toBe('{"s":"a\\n\\"b\\"é"}');
    expect(jcsCanonicalize({ n: 10 } as never)).toBe('{"n":10}');
    expect(jcsCanonicalize({ n: 0.5 } as never)).toBe('{"n":0.5}');
  });

  it('rejects non-JSON values', () => {
    expect(() => jcsCanonicalize({ n: Number.NaN } as never)).toThrow();
    expect(() => jcsCanonicalize({ n: Infinity } as never)).toThrow();
  });
});

describe('recovery kit', () => {
  const root = rootFromMnemonic(MNEMONIC);
  const keyCtx = { chainId: 31337n, manager: MANAGER, ceremonyId: CID };
  const auth = participantAuthKey(root, keyCtx);
  const share = shareEncryptionKey(root, keyCtx);
  const entry: KitManifestEntry = {
    role: 'participant',
    chainId: '31337',
    manager: MANAGER,
    ceremonyId: CID,
    accountIndex: 0,
    authAddress: auth.address.toLowerCase() as Hex,
    sharePublicKey: { x: toDecimal(share.publicKey.x), y: toDecimal(share.publicKey.y) },
  };

  it('build -> serialize -> parse -> restore round trips', () => {
    const kit = buildKit(MNEMONIC, [entry]);
    expect(kit.checksum).toBe(kitChecksum(MNEMONIC, [entry]));
    const parsed = parseKit(serializeKit(kit));
    expect(parsed).toEqual(kit);
    const { root: restored } = restoreFromKit(parsed);
    expect(restored.prk).toEqual(root.prk);
  });

  it('detects tampering via the checksum', () => {
    const kit = buildKit(MNEMONIC, [entry]);
    const tampered = serializeKit({
      ...kit,
      manifest: [{ ...entry, accountIndex: 1 }],
    });
    expect(() => parseKit(tampered)).toThrow(/checksum mismatch/);
  });

  it('rejects malformed kits', () => {
    expect(() => parseKit('not json')).toThrow(/not valid JSON/);
    const kit = buildKit(MNEMONIC, [entry]);
    expect(() => parseKit(JSON.stringify({ ...kit, format: 'davinci-dkg-council-kit/v9' }))).toThrow(/format/);
    expect(() =>
      parseKit(JSON.stringify({ ...kit, private: { ...kit.private, derivationVersion: 2 } })),
    ).toThrow(/derivationVersion/);
    expect(() => buildKit('one two three', [entry])).toThrow(/invalid mnemonic/);
    expect(() => buildKit(MNEMONIC, [{ ...entry, manager: '0xABC' as Hex }])).toThrow();
    expect(() => buildKit(MNEMONIC, [{ ...entry, sharePublicKey: undefined }])).toThrow();
  });

  it('rehearsal matches the derived keys and flags mismatches', () => {
    const ok = rehearseEntry(root, entry);
    expect(ok.ok).toBe(true);
    expect(ok.mismatches).toEqual([]);
    const bad = rehearseEntry(root, { ...entry, authAddress: MANAGER });
    expect(bad.ok).toBe(false);
    expect(bad.mismatches.length).toBe(1);
  });

  it('printable sheet lists the numbered words and the warning', () => {
    const sheet = printableSheet(MNEMONIC);
    expect(sheet).toContain(' 1. test');
    expect(sheet).toContain('12. junk');
    expect(sheet).toContain('no way to reset');
  });
});

describe('invite links and signatures', () => {
  const root = rootFromMnemonic(MNEMONIC);
  const params = { chainId: 31337n, manager: MANAGER, ceremonyId: CID, inviteId: 3 };

  it('link build/parse round trip', () => {
    const cap = deriveInviteCapability(root, params);
    const link = buildInviteLink('https://app.example/', { ceremonyId: CID, inviteId: 3, secret: cap.secret });
    expect(link).toBe(`https://app.example/c/${CID}#v1.3.${cap.secret.toString(16).padStart(64, '0')}`);
    expect(parseInviteLink(link)).toEqual({ ceremonyId: CID, inviteId: 3, secret: cap.secret });
    expect(parseInviteFragment(`v1.3.${'0'.repeat(63)}1`)).toEqual({ inviteId: 3, secret: 1n });
    expect(() => parseInviteFragment('v2.3.deadbeef')).toThrow();
    expect(() => parseInviteFragment(`v1.3.${'0'.repeat(64)}`)).toThrow(/out of range/);
    expect(() => buildInviteLink('https://a.b', { ceremonyId: CID, inviteId: 1, secret: SECP256K1_N })).toThrow();
  });

  it('signInvite produces a signature recoverable to the capability address', async () => {
    const cap = deriveInviteCapability(root, params);
    const message: InviteMessage = {
      ceremonyId: CID,
      inviteId: 3,
      participant: MANAGER,
      pkX: 1n,
      pkY: 2n,
      validUntil: 2000000000n,
    };
    const sig = await signInvite(cap.secret, 31337n, MANAGER, message);
    assertCanonicalSignature(sig);
    const signer = await recoverActionSigner(31337n, MANAGER, 'Invite', message, sig);
    expect(signer.toLowerCase()).toBe(cap.address.toLowerCase());
  });

  it('assertCanonicalSignature negatives', () => {
    expect(() => assertCanonicalSignature('0x1234' as Hex)).toThrow(/65 bytes/);
    const r = '11'.repeat(32);
    const lowS = '22'.repeat(32);
    expect(() => assertCanonicalSignature(`0x${r}${lowS}1b` as Hex)).not.toThrow();
    expect(() => assertCanonicalSignature(`0x${r}${lowS}00` as Hex)).toThrow(/v must be/);
    const highS = (SECP256K1_N / 2n + 1n).toString(16).padStart(64, '0');
    expect(() => assertCanonicalSignature(`0x${r}${highS}1b` as Hex)).toThrow(/low-s/);
    expect(() => assertCanonicalSignature(`0x${'0'.repeat(64)}${lowS}1b` as Hex)).toThrow(/r out of range/);
  });
});
