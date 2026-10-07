/**
 * A mocked chain for the relayer unit tests: an in-memory EIP-1193 node
 * (nonces, mempool, EIP-1559 fee checks, automine or manual mining, block
 * timestamps, a holdable `finalized` snapshot, receipts, logs) hosting a fake
 * v2 CouncilManager. The fake implements what the relayer observes and sends,
 * following the contract (solidity/src/CouncilManager.sol, CouncilOps.sol,
 * CouncilViews.sol): both closes (re-supplied roster authenticated against the
 * compressed words), deal (roster check only), finalize/abort with the §8.4
 * predicates, openDecryption and the §8.7 gate, submitPartial (C1
 * authentication, the partial-data hash, PartialDataPublished), publishPartialData
 * and the v2 combine (hash-checked vectors, authenticated C2, the exact per-field
 * check via the SDK). Proofs and signatures are not checked; createCeremony,
 * addInvites, join and the grants are accepted unless a revert is forced.
 */

import {
  authenticateCompressed,
  COUNCIL_MANAGER_ABI,
  compressPoint,
  evalPoly,
  elgamalEncrypt,
  IDENTITY,
  MAX_COMBINE_FIELDS,
  mulBase,
  mulPoint,
  partialDataHash,
  R,
  RESULT_BOUND,
  sampleNonce,
  verifyCombine,
  type Hex,
  type Point,
} from '@vocdoni/davinci-dkg-council-sdk';
import {
  createPublicClient,
  custom,
  decodeFunctionData,
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionResult,
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  RpcRequestError,
  toHex,
  type AbiEvent,
  type PublicClient,
} from 'viem';

const ABI = COUNCIL_MANAGER_ABI;

export const MANAGER: Hex = '0x5fbdb2315678afecb367f032d93f642f64180aa3';
export const RELAYER_KEY: Hex = '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';
export const RELAYER_ADDRESS: Hex = '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266';
export const CHAIN_ID = 31337n;
/** Timestamp of block 0; every block adds one second (`setTime` moves the whole chain). */
export const GENESIS_TIME = 1_700_000_000n;

class Revert extends Error {
  constructor(readonly errorName: string) {
    super(errorName);
  }
}

export function rpcError(code: number, message: string, data?: Hex): RpcRequestError {
  return new RpcRequestError({ body: {}, error: { code, message, data }, url: 'mock://chain' });
}

interface LogEntry {
  eventName: string;
  args: Record<string, unknown>;
}

/** Default share-encryption keys of members 1..16 (any distinct subgroup points will do). */
export const MEMBER_KEYS: Point[] = Array.from({ length: 16 }, (_, i) => mulBase(BigInt(1000 + i)));

/** Test setup of a ceremony; every omitted field takes the default noted. */
export interface FakeCeremony {
  phase: number;
  threshold: number;
  /** Frozen committee size (0 while in Registration). */
  n: number;
  organizer?: Hex;
  /** Joined members (default: n). */
  joined?: number;
  /** QUAL bitmap, bit j-1 = dealer j (default: all n dealt — finalize is allowed early). */
  qual?: number;
  /** PhaseMode (default: Manual). */
  registrationMode?: number;
  /** Default 0 (Manual without expiry). */
  registrationDeadline?: bigint;
  /** Default 600 s. */
  dealingDuration?: bigint;
  /** Default 0 (already past). */
  dealingDeadline?: bigint;
  /** PhaseMode (default: Scheduled). */
  decryptionMode?: number;
  /** Default 0: a Scheduled gate open as soon as the ceremony is Live. */
  decryptionOpenAt?: bigint;
  manualDecryptionFallbackAt?: bigint;
  manualOpenedAt?: bigint;
  /** X_i in join order (default: MEMBER_KEYS). */
  keys?: Point[];
}

export type Ceremony = Required<FakeCeremony>;

export interface FakeRequest {
  cid: Hex;
  fieldCount: number;
  /** [C1.x, C1.y, C2.x, C2.y] per field (stored compressed by the contract; served compressed). */
  cts: [bigint, bigint, bigint, bigint][];
  /** partialDataHash of every accepted member (the partial bitmap is its key set). */
  hashes: Map<number, Hex>;
  /** Block of each member's latest D publication. */
  published: Map<number, bigint>;
  completed: number;
  plaintexts: bigint[];
}

const cloneRequest = (r: FakeRequest): FakeRequest => ({
  ...r,
  cts: r.cts.slice(),
  hashes: new Map(r.hashes),
  published: new Map(r.published),
  plaintexts: r.plaintexts.slice(),
});

export const cloneRequests = (m: Map<Hex, FakeRequest>): Map<Hex, FakeRequest> =>
  new Map([...m].map(([k, r]) => [k, cloneRequest(r)]));

export const cloneCeremonies = (m: Map<Hex, Ceremony>): Map<Hex, Ceremony> =>
  new Map([...m].map(([k, c]) => [k, { ...c, keys: c.keys.slice() }]));

/** Identity-pad a D vector to 16 slots. */
export function pad(D: Point[]): Point[] {
  const padded = D.slice();
  while (padded.length < 16) padded.push(IDENTITY);
  return padded;
}

const toPoint = (row: readonly bigint[]): Point => ({ x: row[0] as bigint, y: row[1] as bigint });
const popcount = (v: number): number => {
  let n = 0;
  for (let x = v; x; x &= x - 1) n++;
  return n;
};

/** The state one call sees: the head, or the held `finalized` snapshot. */
export interface ManagerState {
  ceremonies: Map<Hex, Ceremony>;
  requests: Map<Hex, FakeRequest>;
  /** block.timestamp */
  now: bigint;
  /** block.number */
  block: bigint;
}

export class FakeManager {
  ceremonies = new Map<Hex, Ceremony>();
  requests = new Map<Hex, FakeRequest>();
  /** Bound processes without a request (getRequestMeta returns fieldCount 0, like the contract). */
  readonly bound = new Map<Hex, Hex>();
  /** Force `fn` to revert with a custom error until deleted. */
  readonly forced = new Map<string, string>();
  /** Words served instead of the stored ones (a corrupted or hostile RPC answer). */
  readonly wordOverride = {
    /** requestId -> [C1 word, C2 word] per field (getRequestCompressed). */
    request: new Map<Hex, [bigint, bigint][]>(),
    /** `cid:index` -> roster key word (getParticipantCompressed). */
    participant: new Map<string, bigint>(),
  };
  /** Committed state-changing calls, in order. */
  readonly calls: { fn: string; args: readonly unknown[]; from: Hex }[] = [];

  static ceremony(c: FakeCeremony): Ceremony {
    return {
      organizer: '0x0000000000000000000000000000000000000001',
      joined: c.n,
      qual: (1 << c.n) - 1,
      registrationMode: 0,
      registrationDeadline: 0n,
      dealingDuration: 600n,
      dealingDeadline: 0n,
      decryptionMode: 1,
      decryptionOpenAt: 0n,
      manualDecryptionFallbackAt: 0n,
      manualOpenedAt: 0n,
      keys: MEMBER_KEYS,
      ...c,
    } as Ceremony;
  }

  private static existing(st: ManagerState, cid: unknown): Ceremony {
    const c = st.ceremonies.get((cid as string).toLowerCase() as Hex);
    if (!c) throw new Revert('UnknownCeremony');
    return c;
  }

  /** protocol §8.7 */
  static open(c: Ceremony, now: bigint): boolean {
    if (c.phase !== 3) return false;
    if (c.decryptionMode === 1) return now >= c.decryptionOpenAt;
    return c.manualOpenedAt !== 0n || (c.manualDecryptionFallbackAt !== 0n && now >= c.manualDecryptionFallbackAt);
  }

  /** CouncilCurve.authenticate: canonical, on curve, exact compressed equality. */
  private static authenticate(supplied: readonly bigint[], stored: bigint): void {
    const verdict = authenticateCompressed(stored, toPoint(supplied));
    if (verdict !== 'ok') throw new Revert(verdict);
  }

  /** The §8.3 roster freeze shared by both closes. */
  private static freeze(c: Ceremony, rosterKeys: readonly (readonly bigint[])[], dealingDeadline: bigint, commit: boolean): void {
    if (rosterKeys.length !== c.joined) throw new Revert('RosterMismatch');
    rosterKeys.forEach((k, i) => FakeManager.authenticate(k, compressPoint(c.keys[i] as Point)));
    if (!commit) return;
    c.n = c.joined;
    c.dealingDeadline = dealingDeadline;
    c.phase = 2;
  }

  exec(fn: string, args: readonly unknown[], from: Hex, commit: boolean, st: ManagerState): LogEntry[] {
    const forced = this.forced.get(fn);
    if (forced) throw new Revert(forced);
    const logs: LogEntry[] = [];
    const now = st.now;
    switch (fn) {
      case 'closeRegistration': {
        const [a, , rosterKeys] = args as [{ ceremonyId: Hex; participantCount: number }, Hex, bigint[][]];
        const c = FakeManager.existing(st, a.ceremonyId);
        if (c.phase !== 1) throw new Revert('WrongPhase');
        if (c.registrationMode !== 0) throw new Revert('WrongMode');
        if (c.registrationDeadline !== 0n && now >= c.registrationDeadline) throw new Revert('RegistrationEnded');
        if (a.participantCount !== c.joined) throw new Revert('RosterMismatch');
        if (c.joined < c.threshold) throw new Revert('BelowThreshold');
        FakeManager.freeze(c, rosterKeys, now + c.dealingDuration, commit);
        break;
      }
      case 'closeRegistrationScheduled': {
        const [cid, rosterKeys] = args as [Hex, bigint[][]];
        const c = FakeManager.existing(st, cid);
        if (c.phase !== 1) throw new Revert('WrongPhase');
        if (c.registrationDeadline === 0n) throw new Revert('WrongMode');
        if (now < c.registrationDeadline) throw new Revert('RegistrationNotDue');
        const deadline = c.registrationDeadline + c.dealingDuration;
        if (now > deadline) throw new Revert('Expired');
        if (c.joined < c.threshold) throw new Revert('BelowThreshold');
        FakeManager.freeze(c, rosterKeys, deadline, commit);
        break;
      }
      case 'deal': {
        const [a, , , , , , , , rosterKeys] = args as [{ ceremonyId: Hex; dealerIndex: number }, ...unknown[]];
        const c = FakeManager.existing(st, a.ceremonyId);
        if (c.phase !== 2) throw new Revert('WrongPhase');
        if (now > c.dealingDeadline) throw new Revert('Expired');
        const j = a.dealerIndex;
        if (j === 0 || j > c.n) throw new Revert('NotQualified');
        if (c.qual & (1 << (j - 1))) throw new Revert('AlreadyDealt');
        const roster = rosterKeys as bigint[][];
        if (roster.length !== c.n) throw new Revert('RosterMismatch');
        roster.forEach((k, i) => FakeManager.authenticate(k, compressPoint(c.keys[i] as Point)));
        if (commit) c.qual |= 1 << (j - 1);
        break;
      }
      case 'finalize': {
        const c = FakeManager.existing(st, args[0]);
        if (c.phase !== 2) throw new Revert('WrongPhase');
        const dealt = popcount(c.qual);
        if (dealt !== c.n && (now <= c.dealingDeadline || dealt < c.threshold)) throw new Revert('FinalizeConditionNotMet');
        if (commit) {
          c.phase = 3;
          logs.push({ eventName: 'CeremonyFinalized', args: { cid: args[0], qualBitmap: c.qual, pkX: 0n, pkY: 1n } });
        }
        break;
      }
      case 'abort': {
        const c = FakeManager.existing(st, args[0]);
        if (c.phase === 1) {
          const d = c.registrationDeadline;
          if (d === 0n || ((now < d || c.joined >= c.threshold) && now <= d + c.dealingDuration)) {
            throw new Revert('AbortConditionNotMet');
          }
        } else if (c.phase === 2) {
          if (now <= c.dealingDeadline || popcount(c.qual) >= c.threshold) throw new Revert('AbortConditionNotMet');
        } else {
          throw new Revert('WrongPhase');
        }
        if (commit) {
          logs.push({ eventName: 'CeremonyAborted', args: { cid: args[0], phaseAtAbort: c.phase } });
          c.phase = 4;
        }
        break;
      }
      case 'openDecryption': {
        const [a] = args as [{ ceremonyId: Hex }];
        const c = FakeManager.existing(st, a.ceremonyId);
        if (c.phase !== 3) throw new Revert('WrongPhase');
        if (c.decryptionMode !== 0) throw new Revert('WrongMode');
        if (FakeManager.open(c, now)) throw new Revert('AlreadyOpen');
        if (commit) {
          c.manualOpenedAt = now;
          logs.push({ eventName: 'DecryptionOpened', args: { cid: a.ceremonyId, openedAt: now } });
        }
        break;
      }
      case 'submitPartial':
        logs.push(...this.submitPartial(args, commit, st));
        break;
      case 'publishPartialData':
        logs.push(...this.publishPartialData(args, commit, st));
        break;
      case 'combine':
        logs.push(...this.combine(args, commit, st));
        break;
      default:
        break;
    }
    if (commit) this.calls.push({ fn, args, from });
    return logs;
  }

  private static dataHash(r: FakeRequest, requestId: Hex, index: number, D: readonly (readonly bigint[])[]): Hex {
    return partialDataHash({
      chainId: CHAIN_ID,
      manager: MANAGER,
      ceremonyId: r.cid,
      requestId,
      participantIndex: index,
      fieldCount: r.fieldCount,
      D: D.map(toPoint),
    });
  }

  private submitPartial(args: readonly unknown[], commit: boolean, st: ManagerState): LogEntry[] {
    const [a, , D, , , , C1] = args as [
      { ceremonyId: Hex; requestId: Hex; participantIndex: number },
      Hex,
      bigint[][],
      unknown,
      unknown,
      unknown,
      bigint[][],
    ];
    const c = FakeManager.existing(st, a.ceremonyId);
    const rid = a.requestId.toLowerCase() as Hex;
    const r = st.requests.get(rid);
    if (!r || r.cid !== a.ceremonyId.toLowerCase()) throw new Revert('UnknownRequest');
    if (!FakeManager.open(c, st.now)) throw new Revert('DecryptionNotOpen');
    const i = a.participantIndex;
    if (i === 0 || i > c.n) throw new Revert('NotQualified');
    if (r.hashes.has(i)) throw new Revert('AlreadyPartial');
    D.forEach((p, k) => {
      if (k >= r.fieldCount && (p[0] !== 0n || p[1] !== 1n)) throw new Revert('BadPadding');
    });
    if (C1.length !== r.fieldCount) throw new Revert('BadFieldCount');
    C1.forEach((p, k) => FakeManager.authenticate(p, compressPoint(toPoint(r.cts[k] as bigint[]))));
    const dataHash = FakeManager.dataHash(r, rid, i, D);
    if (!commit) return [];
    r.hashes.set(i, dataHash);
    r.published.set(i, st.block);
    return [
      { eventName: 'PartialAccepted', args: { requestId: rid, index: i } },
      { eventName: 'PartialDataPublished', args: { requestId: rid, index: i, dataHash, D } },
    ];
  }

  private publishPartialData(args: readonly unknown[], commit: boolean, st: ManagerState): LogEntry[] {
    const [requestId, i, D] = args as [Hex, number, bigint[][]];
    const rid = requestId.toLowerCase() as Hex;
    const r = st.requests.get(rid);
    if (!r || r.fieldCount === 0) throw new Revert('UnknownRequest');
    if (!FakeManager.open(FakeManager.existing(st, r.cid), st.now)) throw new Revert('DecryptionNotOpen');
    if (!r.hashes.has(i)) throw new Revert('MissingPartial');
    const dataHash = FakeManager.dataHash(r, rid, i, D);
    if (dataHash !== r.hashes.get(i)) throw new Revert('PartialDataMismatch');
    if (!commit) return [];
    r.published.set(i, st.block);
    return [{ eventName: 'PartialDataPublished', args: { requestId: rid, index: i, dataHash, D } }];
  }

  private combine(args: readonly unknown[], commit: boolean, st: ManagerState): LogEntry[] {
    const [requestId, memberSet, fieldIndexes, plaintexts, partialVectors, C2] = args as [
      Hex,
      number[],
      number[],
      bigint[],
      bigint[][][],
      bigint[][],
    ];
    const rid = requestId.toLowerCase() as Hex;
    const req = st.requests.get(rid);
    if (!req || req.fieldCount === 0) throw new Revert('UnknownRequest');
    const c = FakeManager.existing(st, req.cid);
    if (!FakeManager.open(c, st.now)) throw new Revert('DecryptionNotOpen');
    if (memberSet.length !== c.threshold) throw new Revert('BadMemberSet');
    memberSet.forEach((i, k) => {
      if (i < 1 || i > c.n || (k > 0 && i <= (memberSet[k - 1] as number))) throw new Revert('BadMemberSet');
      if (!req.hashes.has(i)) throw new Revert('MissingPartial');
    });
    if (fieldIndexes.length < 1 || fieldIndexes.length > MAX_COMBINE_FIELDS) throw new Revert('BadFieldIndexes');
    if (plaintexts.length !== fieldIndexes.length) throw new Revert('BadFieldIndexes');
    fieldIndexes.forEach((k, j) => {
      if (k >= req.fieldCount || (j > 0 && k <= (fieldIndexes[j - 1] as number))) throw new Revert('BadFieldIndexes');
      if (req.completed & (1 << k)) throw new Revert('FieldCompleted');
      if ((plaintexts[j] as bigint) >= RESULT_BOUND) throw new Revert('PlaintextTooLarge');
    });
    if (partialVectors.length !== memberSet.length) throw new Revert('BadMemberSet');
    memberSet.forEach((i, k) => {
      if (FakeManager.dataHash(req, rid, i, partialVectors[k] as bigint[][]) !== req.hashes.get(i)) {
        throw new Revert('PartialDataMismatch');
      }
    });
    if (C2.length !== fieldIndexes.length) throw new Revert('BadFieldIndexes');
    fieldIndexes.forEach((k, j) => {
      const row = req.cts[k] as bigint[];
      FakeManager.authenticate(C2[j] as bigint[], compressPoint({ x: row[2] as bigint, y: row[3] as bigint }));
      const perField = new Map(memberSet.map((i, m) => [i, toPoint((partialVectors[m] as bigint[][])[k] as bigint[])]));
      if (!verifyCombine(plaintexts[j] as bigint, toPoint(C2[j] as bigint[]), memberSet, perField)) {
        throw new Revert('CombineCheckFailed');
      }
    });
    const logs: LogEntry[] = [];
    if (commit) {
      fieldIndexes.forEach((k, j) => {
        req.completed |= 1 << k;
        req.plaintexts[k] = plaintexts[j] as bigint;
      });
      logs.push({ eventName: 'FieldsCombined', args: { requestId, fieldIndexes, plaintexts } });
      if (req.completed === (1 << req.fieldCount) - 1) logs.push({ eventName: 'RequestCompleted', args: { requestId } });
    }
    return logs;
  }

  /** The ceremony's bound request ids in binding order (submitted ones, then bound-only ones). */
  private requestIds(st: ManagerState, cid: Hex): Hex[] {
    const id = cid.toLowerCase();
    const ids = [...st.requests].filter(([, r]) => r.cid === id).map(([rid]) => rid);
    for (const [rid, c] of this.bound) if (c.toLowerCase() === id && !ids.includes(rid)) ids.push(rid);
    return ids;
  }

  view(fn: string, args: readonly unknown[], st: ManagerState): unknown {
    const request = (): FakeRequest | undefined => st.requests.get((args[0] as string).toLowerCase() as Hex);
    switch (fn) {
      case 'getCeremony': {
        const c = FakeManager.existing(st, args[0]);
        return {
          phase: c.phase,
          organizer: c.organizer,
          threshold: c.threshold,
          n: c.n,
          registrationDeadline: c.registrationDeadline,
          dealingDeadline: c.dealingDeadline,
          joinedCount: c.joined,
          dealtCount: popcount(c.qual),
          // Not the protocol's hash: enough that another frozen roster reads as another value.
          rosterHash:
            c.n > 0
              ? keccak256(encodeAbiParameters([{ type: 'uint256[]' }], [c.keys.slice(0, c.n).map((k) => compressPoint(k))]))
              : `0x${'00'.repeat(32)}`,
          ctx: `0x${'00'.repeat(32)}`,
          inviteCount: c.joined,
          consumedInvites: 0n,
          qualBitmap: c.qual,
          pkX: 0n,
          pkY: 1n,
        };
      }
      case 'getPolicy': {
        const c = FakeManager.existing(st, args[0]);
        const d = c.registrationDeadline;
        return {
          registrationMode: c.registrationMode,
          decryptionMode: c.decryptionMode,
          dealingDuration: c.dealingDuration,
          decryptionOpenAt: c.decryptionOpenAt,
          manualDecryptionFallbackAt: c.manualDecryptionFallbackAt,
          manualOpenedAt: c.manualOpenedAt,
          decryptionOpen: FakeManager.open(c, st.now),
          scheduledRegistrationCloseDue:
            c.phase === 1 && d !== 0n && st.now >= d && st.now <= d + c.dealingDuration && c.joined >= c.threshold,
        };
      }
      case 'isDecryptionOpen':
        return FakeManager.open(FakeManager.existing(st, args[0]), st.now);
      case 'getParticipantCompressed': {
        const c = FakeManager.existing(st, args[0]);
        const i = args[1] as number;
        if (i === 0 || i > c.joined) throw new Revert('NotQualified');
        const word = this.wordOverride.participant.get(`${(args[0] as string).toLowerCase()}:${i}`);
        return [
          `0x${(0xa000 + i).toString(16).padStart(40, '0')}`,
          word ?? compressPoint(c.keys[i - 1] as Point),
          (c.qual & (1 << (i - 1))) !== 0,
        ];
      }
      case 'getRequestMeta': {
        const id = (args[0] as string).toLowerCase() as Hex;
        const r = request();
        const boundCid = this.bound.get(id);
        if (!r && boundCid) return [boundCid, 0, 0, 0];
        if (!r) throw new Revert('UnknownRequest');
        let bitmap = 0;
        for (const i of r.hashes.keys()) bitmap |= 1 << (i - 1);
        return [r.cid, r.fieldCount, r.completed, bitmap];
      }
      case 'getRequestCompressed': {
        const r = request();
        if (!r) throw new Revert('UnknownRequest');
        const words = this.wordOverride.request.get((args[0] as string).toLowerCase() as Hex);
        if (words) return words;
        return r.cts.map((row) => [compressPoint({ x: row[0], y: row[1] }), compressPoint({ x: row[2], y: row[3] })]);
      }
      case 'getPartialCommitment': {
        const r = request();
        if (!r) throw new Revert('UnknownRequest');
        const i = args[1] as number;
        const h = r.hashes.get(i);
        return h ? [true, h, r.published.get(i) ?? 0n] : [false, `0x${'00'.repeat(32)}`, 0n];
      }
      case 'getRequestCount':
        FakeManager.existing(st, args[0]);
        return BigInt(this.requestIds(st, args[0] as Hex).length);
      case 'getRequestIdsPage': {
        FakeManager.existing(st, args[0]);
        const [, offset, limit] = args as [Hex, bigint, bigint];
        return this.requestIds(st, args[0] as Hex).slice(Number(offset), Number(offset + limit));
      }
      case 'getPlaintexts': {
        const r = request();
        if (!r) throw new Revert('UnknownRequest');
        return [r.fieldCount > 0 && r.completed === (1 << r.fieldCount) - 1, r.plaintexts];
      }
      case 'circuitReleaseId':
        return `0x${'ab'.repeat(32)}`;
      default:
        throw new Revert('UnknownCeremony');
    }
  }
}

interface MempoolTx {
  hash: Hex;
  raw: Hex;
  from: Hex;
  nonce: number;
  to: Hex;
  data: Hex;
  gas: bigint;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

interface StoredLog {
  address: Hex;
  topics: Hex[];
  data: Hex;
  blockNumber: bigint;
  transactionHash: Hex;
  logIndex: number;
}

const hex = (v: bigint | number): Hex => toHex(v);
const blockHash = (n: bigint): Hex => keccak256(toHex(n, { size: 32 }));

export interface MockChainOptions {
  chainId?: bigint;
  automine?: boolean;
}

export class MockChain {
  readonly chainId: bigint;
  readonly manager = new FakeManager();
  automine: boolean;
  baseFee = 1_000_000_000n;
  tip = 1_000_000_000n;
  gasLimit = 30_000_000n;
  gasEstimate = 100_000n;
  /** The relayer key's balance (eth_getBalance). */
  balance = 10n ** 21n;
  blockNumber = 1n;
  /** Timestamp of block 0 (see `setTime`). */
  private t0 = GENESIS_TIME;
  /** Throw this (once) from the next eth_sendRawTransaction. */
  failNextSend: RpcRequestError | undefined;
  /** Accept the next eth_sendRawTransaction, then throw this (a lost response). */
  loseNextResponse: RpcRequestError | undefined;
  /** Fail the next eth_call with this transport error (not a revert). */
  failNextCall: Error | undefined;
  /** Observe every eth_sendRawTransaction before the node handles it. */
  beforeSend: ((raw: Hex) => void) | undefined;
  /**
   * Blocks the backend answering eth_getLogs lags behind the one answering eth_blockNumber (a
   * load-balanced public RPC): a range past its head is refused like publicnode and Tenderly do.
   */
  logsHeadLag = 0n;
  /** Widest eth_getLogs range served; wider ones are refused like a public provider's cap. */
  maxLogRange: bigint | undefined;
  /** eth_getLogs from a block below this is refused for good (a provider that pruned history). */
  logsPrunedBelow: bigint | undefined;
  /** eth_getLogs over a range covering this block is refused for good (a block it cannot serve). */
  logsRefusedAt: bigint | undefined;
  /** Fail every request whose method this returns an error for (until cleared). */
  failRequests: ((method: string) => Error | undefined) | undefined;
  readonly mined = new Map<string, number>();
  readonly mempool: MempoolTx[] = [];
  readonly sentRaw: Hex[] = [];
  readonly txs = new Map<Hex, MempoolTx & { blockNumber?: bigint }>();
  readonly receipts = new Map<Hex, Record<string, unknown>>();
  readonly logs: StoredLog[] = [];
  readonly client: PublicClient;

  constructor(opts: MockChainOptions = {}) {
    this.chainId = opts.chainId ?? 31337n;
    this.automine = opts.automine ?? true;
    this.client = createPublicClient({
      transport: custom({ request: ({ method, params }) => this.request(method, (params ?? []) as unknown[]) }, { retryCount: 0 }),
      cacheTime: 0,
      pollingInterval: 50,
    }) as PublicClient;
  }

  /**
   * Another RPC endpoint onto this chain (another provider). `send` may replace the node's
   * handling of eth_sendRawTransaction — refuse it like a provider plan, rate-limit it, or
   * rewrite the node's error into something uninformative. `calls` counts its sends.
   */
  endpoint(send?: (raw: Hex, forward: () => Promise<unknown>) => Promise<unknown>): { client: PublicClient; calls: () => number } {
    let calls = 0;
    const client = createPublicClient({
      transport: custom(
        {
          request: ({ method, params }) => {
            const p = (params ?? []) as unknown[];
            if (method !== 'eth_sendRawTransaction') return this.request(method, p);
            calls++;
            const forward = () => this.request(method, p);
            return send ? send(p[0] as Hex, forward) : forward();
          },
        },
        { retryCount: 0 },
      ),
      cacheTime: 0,
    }) as PublicClient;
    return { client, calls: () => calls };
  }

  minedNonce(addr: string): number {
    return this.mined.get(addr.toLowerCase()) ?? 0;
  }

  pendingNonce(addr: string): number {
    let n = this.minedNonce(addr);
    const mine = this.mempool.filter((t) => t.from === addr.toLowerCase()).map((t) => t.nonce);
    while (mine.includes(n)) n++;
    return n;
  }

  private blockOf(tag: unknown): bigint {
    if (tag === 'latest' || tag === 'pending' || tag === undefined) return this.blockNumber;
    if (tag === 'finalized' || tag === 'safe') return this.finalized?.block ?? this.blockNumber;
    return BigInt(tag as string);
  }

  /** block.timestamp of block `n`. */
  timeOf(n: bigint): bigint {
    return this.t0 + n;
  }

  /** The head's timestamp. */
  get now(): bigint {
    return this.timeOf(this.blockNumber);
  }

  /** Move the chain's clock so the head's timestamp is `ts` (the finalized block keeps its lag). */
  setTime(ts: bigint): void {
    this.t0 = ts - this.blockNumber;
  }

  private block(tag: unknown): Record<string, unknown> {
    const n = this.blockOf(tag);
    return {
      number: hex(n),
      hash: blockHash(n),
      parentHash: blockHash(n - 1n),
      timestamp: hex(this.timeOf(n)),
      gasLimit: hex(this.gasLimit),
      gasUsed: '0x0',
      baseFeePerGas: hex(this.baseFee),
      miner: '0x0000000000000000000000000000000000000000',
      difficulty: '0x0',
      totalDifficulty: '0x0',
      extraData: '0x',
      logsBloom: `0x${'00'.repeat(256)}`,
      nonce: '0x0000000000000000',
      sha3Uncles: `0x${'00'.repeat(32)}`,
      size: '0x0',
      stateRoot: `0x${'00'.repeat(32)}`,
      receiptsRoot: `0x${'00'.repeat(32)}`,
      transactionsRoot: `0x${'00'.repeat(32)}`,
      mixHash: `0x${'00'.repeat(32)}`,
      transactions: [],
      uncles: [],
    };
  }

  /** The manager state at a block tag: the held finalized snapshot at or below its block, else the head. */
  private stateAt(tag: unknown): ManagerState {
    const n = this.blockOf(tag);
    const f = this.finalized;
    const head = tag === undefined || tag === 'latest' || tag === 'pending';
    if (f && !head && n <= f.block) return { ceremonies: f.ceremonies, requests: f.requests, now: this.timeOf(f.block), block: f.block };
    return { ceremonies: this.manager.ceremonies, requests: this.manager.requests, now: this.now, block: this.blockNumber };
  }

  /** Run a call against the fake manager; returns encoded output or throws a revert RPC error. */
  private run(
    from: Hex,
    to: Hex | undefined,
    data: Hex,
    commit: boolean,
    blockTag?: unknown,
  ): { output: Hex; logs: LogEntry[] } {
    if (to?.toLowerCase() !== MANAGER) return { output: '0x', logs: [] };
    try {
      const { functionName, args } = decodeFunctionData({ abi: ABI, data });
      const item = ABI.find((x) => x.type === 'function' && x.name === functionName) as { stateMutability: string };
      const st = this.stateAt(blockTag);
      if (item.stateMutability === 'view' || item.stateMutability === 'pure') {
        const result = this.manager.view(functionName, args ?? [], st);
        return { output: encodeFunctionResult({ abi: ABI, functionName, result } as never), logs: [] };
      }
      const logs = this.manager.exec(functionName, args ?? [], from, commit, st);
      return { output: '0x', logs };
    } catch (err) {
      if (err instanceof Revert) {
        const revertData = encodeErrorResult({ abi: ABI, errorName: err.errorName } as never);
        throw rpcError(3, `execution reverted: ${err.errorName}`, revertData);
      }
      throw rpcError(3, 'execution reverted', '0x');
    }
  }

  private encodeLogs(entries: LogEntry[], txHash: Hex, block: bigint): StoredLog[] {
    return entries.map((e, logIndex) => {
      const item = ABI.find((x) => x.type === 'event' && x.name === e.eventName) as AbiEvent;
      const topics = encodeEventTopics({ abi: [item], eventName: e.eventName, args: e.args } as never) as Hex[];
      const nonIndexed = item.inputs.filter((i) => !i.indexed);
      const data = encodeAbiParameters(
        nonIndexed,
        nonIndexed.map((i) => e.args[i.name as string]),
      );
      return { address: MANAGER, topics, data, blockNumber: block, transactionHash: txHash, logIndex };
    });
  }

  private emitBlock(entries: LogEntry[]): void {
    this.blockNumber++;
    const txHash = keccak256(toHex(`event-block-${this.blockNumber}`));
    this.logs.push(...this.encodeLogs(entries, txHash, this.blockNumber));
  }

  /**
   * Manager state at the `finalized` tag (and every block up to it); undefined means
   * finalized = latest. `holdFinalized` freezes it at the current head, `rollback` reorgs
   * latest back to it.
   */
  finalized:
    | { ceremonies: Map<Hex, Ceremony>; requests: Map<Hex, FakeRequest>; block: bigint; nonces: Map<string, number> }
    | undefined;

  holdFinalized(): void {
    this.finalized = {
      ceremonies: cloneCeremonies(this.manager.ceremonies),
      requests: cloneRequests(this.manager.requests),
      block: this.blockNumber,
      nonces: new Map(this.mined),
    };
  }

  /**
   * A reorg back to the held finalized block: every receipt, log and nonce above it is gone and
   * the manager state is rolled back. `keep` puts the reorged-out transactions back into the
   * mempool (a node that retained them); otherwise the node forgets them entirely.
   */
  reorg(opts: { keep?: boolean } = {}): void {
    const f = this.finalized;
    if (!f) throw new Error('reorg needs a held finalized block');
    for (const [hash, r] of [...this.receipts]) {
      if (BigInt(r.blockNumber as string) <= f.block) continue;
      this.receipts.delete(hash);
      const tx = this.txs.get(hash);
      if (!tx) continue;
      tx.blockNumber = undefined;
      if (opts.keep) this.mempool.push(tx);
      else this.txs.delete(hash);
    }
    for (let i = this.logs.length - 1; i >= 0; i--) if ((this.logs[i] as StoredLog).blockNumber > f.block) this.logs.splice(i, 1);
    this.mined.clear();
    for (const [addr, n] of f.nonces) this.mined.set(addr, n);
    this.rollback();
    this.blockNumber = f.block;
  }

  releaseFinalized(): void {
    this.finalized = undefined;
  }

  rollback(): void {
    if (!this.finalized) return;
    this.manager.ceremonies = cloneCeremonies(this.finalized.ceremonies);
    this.manager.requests = cloneRequests(this.finalized.requests);
  }

  /** Test setup: register (or replace) a ceremony in the fake manager. */
  addCeremony(cid: Hex, c: FakeCeremony): Ceremony {
    const full = FakeManager.ceremony(c);
    this.manager.ceremonies.set(cid.toLowerCase() as Hex, full);
    return full;
  }

  /**
   * Test setup: a request admitted by an adapter (emits RequestSubmitted in a new block, or
   * at `atBlock` — a log a reorg placed at an already-scanned height).
   */
  addRequest(requestId: Hex, cid: Hex, cts: [bigint, bigint, bigint, bigint][], atBlock?: bigint): void {
    const id = requestId.toLowerCase() as Hex;
    this.manager.requests.set(id, {
      cid: cid.toLowerCase() as Hex,
      fieldCount: cts.length,
      cts,
      hashes: new Map(),
      published: new Map(),
      completed: 0,
      plaintexts: cts.map(() => 0n),
    });
    const entry = { eventName: 'RequestSubmitted', args: { requestId: id, cid, fieldCount: cts.length } };
    if (atBlock === undefined) this.emitBlock([entry]);
    else this.logs.push(...this.encodeLogs([entry], keccak256(toHex(`reorg-${id}`)), atBlock));
  }

  /**
   * Test setup: an accepted partial (D padded to 16 with the identity): its hash and publication
   * block are stored, the vector is only in the PartialDataPublished log of that block.
   */
  addPartial(requestId: Hex, index: number, D: Point[]): void {
    const id = requestId.toLowerCase() as Hex;
    const req = this.manager.requests.get(id) as FakeRequest;
    const padded = pad(D);
    const dataHash = partialDataHash({
      chainId: this.chainId,
      manager: MANAGER,
      ceremonyId: req.cid,
      requestId: id,
      participantIndex: index,
      fieldCount: req.fieldCount,
      D: padded,
    });
    req.hashes.set(index, dataHash);
    req.published.set(index, this.blockNumber + 1n);
    this.emitBlock([
      { eventName: 'PartialAccepted', args: { requestId: id, index } },
      { eventName: 'PartialDataPublished', args: { requestId: id, index, dataHash, D: padded.map((p) => [p.x, p.y]) } },
    ]);
  }

  /** Forget every PartialDataPublished log (a provider that no longer serves those blocks). */
  dropPublishedLogs(): void {
    const topic = encodeEventTopics({ abi: ABI, eventName: 'PartialDataPublished' } as never)[0];
    for (let i = this.logs.length - 1; i >= 0; i--) if ((this.logs[i] as StoredLog).topics[0] === topic) this.logs.splice(i, 1);
  }

  private async sendRaw(raw: Hex): Promise<Hex> {
    this.beforeSend?.(raw);
    if (this.failNextSend) {
      const err = this.failNextSend;
      this.failNextSend = undefined;
      throw err;
    }
    const tx = parseTransaction(raw);
    if (tx.chainId !== Number(this.chainId)) throw rpcError(-32000, 'invalid chain id');
    const from = (await recoverTransactionAddress({ serializedTransaction: raw as never })).toLowerCase() as Hex;
    const hash = keccak256(raw);
    const nonce = tx.nonce as number;
    if (nonce < this.minedNonce(from)) throw rpcError(-32000, 'nonce too low');
    const maxFeePerGas = tx.maxFeePerGas ?? tx.gasPrice ?? 0n;
    const maxPriorityFeePerGas = tx.maxPriorityFeePerGas ?? tx.gasPrice ?? 0n;
    const existing = this.mempool.findIndex((t) => t.from === from && t.nonce === nonce);
    if (existing >= 0) {
      const old = this.mempool[existing] as MempoolTx;
      if (old.hash === hash) throw rpcError(-32000, 'already known');
      if (maxFeePerGas * 10n < old.maxFeePerGas * 11n || maxPriorityFeePerGas * 10n < old.maxPriorityFeePerGas * 11n) {
        throw rpcError(-32000, 'replacement transaction underpriced');
      }
      this.mempool.splice(existing, 1);
    }
    const entry: MempoolTx = {
      hash,
      raw,
      from,
      nonce,
      to: (tx.to ?? '0x') as Hex,
      data: (tx.data ?? '0x') as Hex,
      gas: tx.gas ?? 0n,
      maxFeePerGas,
      maxPriorityFeePerGas,
    };
    this.mempool.push(entry);
    this.sentRaw.push(raw);
    this.txs.set(hash, entry);
    if (this.automine) this.mine();
    if (this.loseNextResponse) {
      const err = this.loseNextResponse;
      this.loseNextResponse = undefined;
      throw err; // accepted, but the caller never hears so
    }
    return hash;
  }

  /** Mine every executable mempool transaction, one per block (in nonce order per sender). */
  mine(): void {
    for (;;) {
      const next = this.mempool.find((t) => t.nonce === this.minedNonce(t.from) && t.maxFeePerGas >= this.baseFee);
      if (!next) return;
      this.mempool.splice(this.mempool.indexOf(next), 1);
      this.blockNumber++;
      let status = '0x1';
      let logs: StoredLog[] = [];
      try {
        const { logs: entries } = this.run(next.from, next.to, next.data, true);
        logs = this.encodeLogs(entries, next.hash, this.blockNumber);
      } catch {
        status = '0x0';
      }
      this.logs.push(...logs);
      this.mined.set(next.from, next.nonce + 1);
      const stored = this.txs.get(next.hash);
      if (stored) stored.blockNumber = this.blockNumber;
      this.receipts.set(next.hash, {
        transactionHash: next.hash,
        transactionIndex: '0x0',
        blockHash: blockHash(this.blockNumber),
        blockNumber: hex(this.blockNumber),
        from: next.from,
        to: next.to,
        cumulativeGasUsed: hex(50_000n),
        gasUsed: hex(50_000n),
        effectiveGasPrice: hex(this.baseFee + next.maxPriorityFeePerGas),
        contractAddress: null,
        logs: logs.map((l) => this.formatLog(l)),
        logsBloom: `0x${'00'.repeat(256)}`,
        status,
        type: '0x2',
      });
    }
  }

  private formatLog(l: StoredLog): Record<string, unknown> {
    return {
      address: l.address,
      topics: l.topics,
      data: l.data,
      blockNumber: hex(l.blockNumber),
      blockHash: blockHash(l.blockNumber),
      transactionHash: l.transactionHash,
      transactionIndex: '0x0',
      logIndex: hex(l.logIndex),
      removed: false,
    };
  }

  private getLogs(filter: { address?: Hex; topics?: (Hex | Hex[] | null)[]; fromBlock?: string; toBlock?: string }): unknown[] {
    const from = filter.fromBlock && filter.fromBlock !== 'latest' ? BigInt(filter.fromBlock) : 0n;
    const to = filter.toBlock && filter.toBlock !== 'latest' ? BigInt(filter.toBlock) : this.blockNumber;
    const head = this.blockNumber - this.logsHeadLag;
    if (to > head) {
      throw rpcError(-32602, `block range extends beyond current head block: requested ${to}, head ${head}`);
    }
    if (this.logsPrunedBelow !== undefined && from < this.logsPrunedBelow) {
      throw rpcError(-32000, 'pruned history unavailable');
    }
    if (this.logsRefusedAt !== undefined && from <= this.logsRefusedAt && this.logsRefusedAt <= to) {
      throw rpcError(-32000, `missing receipts for block ${this.logsRefusedAt}`);
    }
    if (this.maxLogRange !== undefined && to - from + 1n > this.maxLogRange) {
      throw rpcError(-32005, `query exceeds max block range ${this.maxLogRange}`);
    }
    const matches = (want: Hex | Hex[] | null | undefined, got: Hex | undefined): boolean =>
      !want || (Array.isArray(want) ? want.includes(got as Hex) : want === got);
    const [topic0, topic1] = filter.topics ?? [];
    return this.logs
      .filter((l) => l.blockNumber >= from && l.blockNumber <= to)
      .filter((l) => !filter.address || l.address === filter.address.toLowerCase())
      .filter((l) => matches(topic0, l.topics[0]) && matches(topic1, l.topics[1]))
      .map((l) => this.formatLog(l));
  }

  private txByHash(hash: Hex): Record<string, unknown> | null {
    const t = this.txs.get(hash);
    if (!t) return null;
    return {
      hash: t.hash,
      from: t.from,
      to: t.to,
      input: t.data,
      nonce: hex(t.nonce),
      gas: hex(t.gas),
      maxFeePerGas: hex(t.maxFeePerGas),
      maxPriorityFeePerGas: hex(t.maxPriorityFeePerGas),
      value: '0x0',
      type: '0x2',
      chainId: hex(this.chainId),
      blockNumber: t.blockNumber !== undefined ? hex(t.blockNumber) : null,
      blockHash: t.blockNumber !== undefined ? blockHash(t.blockNumber) : null,
      transactionIndex: t.blockNumber !== undefined ? '0x0' : null,
      v: '0x0',
      r: '0x1',
      s: '0x1',
      yParity: '0x0',
      accessList: [],
    };
  }

  async request(method: string, params: unknown[]): Promise<unknown> {
    const failure = this.failRequests?.(method);
    if (failure) throw failure;
    switch (method) {
      case 'eth_chainId':
        return hex(this.chainId);
      case 'eth_blockNumber':
        return hex(this.blockNumber);
      case 'eth_getBlockByNumber':
        return this.block(params[0]);
      case 'eth_gasPrice':
        return hex(this.baseFee);
      case 'eth_maxPriorityFeePerGas':
        return hex(this.tip);
      case 'eth_getBalance':
        return hex(this.balance);
      case 'eth_getCode':
        return (params[0] as string).toLowerCase() === MANAGER ? '0x6080' : '0x';
      case 'eth_getTransactionCount': {
        const [addr, tag] = params as [string, string];
        if ((tag === 'finalized' || tag === 'safe') && this.finalized) {
          return hex(this.finalized.nonces.get(addr.toLowerCase()) ?? 0);
        }
        return hex(tag === 'pending' ? this.pendingNonce(addr) : this.minedNonce(addr));
      }
      case 'eth_call': {
        if (this.failNextCall) {
          const err = this.failNextCall;
          this.failNextCall = undefined;
          throw err;
        }
        const call = params[0] as { from?: Hex; to?: Hex; data?: Hex; input?: Hex };
        const from = (call.from ?? RELAYER_ADDRESS).toLowerCase() as Hex;
        return this.run(from, call.to, call.data ?? call.input ?? '0x', false, params[1]).output;
      }
      case 'eth_estimateGas': {
        const call = params[0] as { from?: Hex; to?: Hex; data?: Hex; input?: Hex };
        this.run((call.from ?? RELAYER_ADDRESS).toLowerCase() as Hex, call.to, call.data ?? call.input ?? '0x', false);
        return hex(this.gasEstimate);
      }
      case 'eth_sendRawTransaction':
        return this.sendRaw(params[0] as Hex);
      case 'eth_getTransactionReceipt':
        return this.receipts.get(params[0] as Hex) ?? null;
      case 'eth_getTransactionByHash':
        return this.txByHash(params[0] as Hex);
      case 'eth_getLogs':
        return this.getLogs(params[0] as never);
      default:
        throw rpcError(-32601, `method ${method} not supported by the mock`);
    }
  }
}

// --- threshold-key fixtures (real BabyJubJub arithmetic through the SDK) ---

export interface TestKey {
  P: Point;
  shares: Map<number, bigint>;
}

/** A random degree-(t-1) sharing among members 1..n. */
export function testKey(t: number, n: number): TestKey {
  const coeffs = Array.from({ length: t }, () => sampleNonce() % R);
  const shares = new Map<number, bigint>();
  for (let i = 1; i <= n; i++) shares.set(i, evalPoly(coeffs, BigInt(i)));
  return { P: mulBase(coeffs[0] as bigint), shares };
}

/** Encrypt plaintexts under P: cts rows [C1.x, C1.y, C2.x, C2.y] and the C1 points. */
export function encryptAll(P: Point, plaintexts: bigint[]): { cts: [bigint, bigint, bigint, bigint][]; c1s: Point[] } {
  const cts: [bigint, bigint, bigint, bigint][] = [];
  const c1s: Point[] = [];
  for (const m of plaintexts) {
    const { c1, c2 } = elgamalEncrypt(P, m, sampleNonce());
    cts.push([c1.x, c1.y, c2.x, c2.y]);
    c1s.push(c1);
  }
  return { cts, c1s };
}

/** D_k = s·C1_k for every field. */
export const partialOf = (share: bigint, c1s: Point[]): Point[] => c1s.map((c1) => mulPoint(c1, share));

export const ceremonyIdOf = (n: number): Hex => `0x${n.toString(16).padStart(24, '0')}`;
export const requestIdOf = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
