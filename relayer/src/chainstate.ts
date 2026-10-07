/**
 * The contract state the relayer reads (architecture §1.2 views), and the calldata it rebuilds
 * from it. `rosterKeys` (both closes and deal), `C1` (submitPartial) and `C2` (combine) never
 * travel on the relay wire (architecture §5.1): the contract stores those points compressed
 * (protocol §2.5), so the relayer decompresses the stored words with the SDK codec and
 * re-supplies the full points, which the contract authenticates against the same words. A wrong
 * rebuild can therefore only fail simulation; it is never paid for.
 *
 * Every word is decoded strictly (the SDK codec refuses bit 254, x >= p, non-residues and an odd
 * parity on a zero root) and must give a prime-subgroup, non-identity point, as every key and
 * ciphertext the contract admits is. Anything else — a corrupted or hostile RPC answer — is a
 * MalformedPointError for that one action, request or ceremony: never memoized, never used (a
 * combine never searches a discrete log of it), and retried with the caller's backoff.
 */

import {
  CodecError,
  COUNCIL_MANAGER_ABI,
  decompressPoint,
  isIdentity,
  isInPrimeSubgroup,
  type Action,
  type CeremonyView,
  type Hex,
  type PartialCommitment,
  type PhasePolicyView,
  type Point,
  type RequestMeta,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { PublicClient } from 'viem';
import { extractRevertData, RelayError, shortMessage, simulationError } from './errors.js';

/** Where a read is evaluated: the head (default) or one block (the scheduler's finalized anchor). */
export type ReadAt = { blockNumber: bigint } | { blockTag: 'finalized' } | undefined;

/** The ciphertext points of a submitted request, decompressed (exactly fieldCount of each). */
export interface RequestPoints {
  ceremonyId: Hex;
  fieldCount: number;
  c1: Point[];
  c2: Point[];
}

/** A stored point word that does not decode to a prime-subgroup, non-identity point. */
export class MalformedPointError extends RelayError {
  constructor(
    readonly label: string,
    readonly reason: string,
  ) {
    super('INTERNAL', `stored ${label} is not a valid point (${reason}); refusing to use it`);
    this.name = 'MalformedPointError';
  }
}

/** Entries kept per memo (decompressed words, frozen rosters, request shapes): all immutable. */
const MAX_MEMO = 4096;

/** Insert into a bounded memo, evicting the oldest entry. */
function remember<K, V>(memo: Map<K, V>, key: K, value: V): V {
  if (!memo.has(key) && memo.size >= MAX_MEMO) memo.delete(memo.keys().next().value as K);
  memo.set(key, value);
  return value;
}

export class ChainState {
  /** Frozen rosters (after close), keyed by `ceremonyId:rosterHash`. */
  private readonly rosters = new Map<string, Point[]>();
  /** Ceremony id and field count of submitted requests (immutable once fieldCount > 0). */
  private readonly shapes = new Map<Hex, { ceremonyId: Hex; fieldCount: number }>();
  private readonly points = new Map<bigint, Point>();

  constructor(
    private readonly client: PublicClient,
    readonly manager: Hex,
  ) {}

  /** One view call (latest unless `at` says otherwise); reverts and transport errors propagate. */
  async read<T>(functionName: string, args: readonly unknown[], at?: ReadAt): Promise<T> {
    return (await this.client.readContract({
      address: this.manager,
      abi: COUNCIL_MANAGER_ABI,
      functionName: functionName as never,
      args: args as never,
      ...(at ?? {}),
    })) as T;
  }

  ceremony(cid: Hex, at?: ReadAt): Promise<CeremonyView> {
    return this.read<CeremonyView>('getCeremony', [cid], at);
  }

  policy(cid: Hex, at?: ReadAt): Promise<PhasePolicyView> {
    return this.read<PhasePolicyView>('getPolicy', [cid], at);
  }

  isDecryptionOpen(cid: Hex, at?: ReadAt): Promise<boolean> {
    return this.read<boolean>('isDecryptionOpen', [cid], at);
  }

  async requestMeta(requestId: Hex, at?: ReadAt): Promise<RequestMeta> {
    const [cid, fieldCount, completedBitmap, partialBitmap] = await this.read<readonly [Hex, number, number, number]>(
      'getRequestMeta',
      [requestId],
      at,
    );
    const meta = {
      ceremonyId: cid.toLowerCase() as Hex,
      fieldCount: Number(fieldCount),
      completedBitmap: Number(completedBitmap),
      partialBitmap: Number(partialBitmap),
    };
    if (meta.fieldCount > 0) {
      remember(this.shapes, requestId.toLowerCase() as Hex, { ceremonyId: meta.ceremonyId, fieldCount: meta.fieldCount });
    }
    return meta;
  }

  /** Ceremony id and field count of a submitted request (fieldCount 0: bound, not submitted). */
  async requestShape(requestId: Hex): Promise<{ ceremonyId: Hex; fieldCount: number }> {
    const known = this.shapes.get(requestId.toLowerCase() as Hex);
    if (known) return known;
    const meta = await this.requestMeta(requestId);
    return { ceremonyId: meta.ceremonyId, fieldCount: meta.fieldCount };
  }

  async partialCommitment(requestId: Hex, index: number, at?: ReadAt): Promise<PartialCommitment> {
    const [accepted, dataHash, publishedBlock] = await this.read<readonly [boolean, Hex, bigint]>(
      'getPartialCommitment',
      [requestId, index],
      at,
    );
    return { accepted, dataHash, publishedBlock: BigInt(publishedBlock) };
  }

  /**
   * Decode a stored word strictly and require a prime-subgroup, non-identity point. Unreachable
   * for a word the contract stored (each came from a validated point), so a failure means the
   * answer was corrupted: it is refused and never memoized.
   */
  private decompress(word: bigint, label: string): Point {
    const known = this.points.get(word);
    if (known) return known;
    let p: Point;
    try {
      p = decompressPoint(word);
    } catch (err) {
      throw new MalformedPointError(label, err instanceof CodecError && err.reason ? err.reason : shortMessage(err));
    }
    if (isIdentity(p)) throw new MalformedPointError(label, 'identity');
    if (!isInPrimeSubgroup(p)) throw new MalformedPointError(label, 'not in the prime-order subgroup');
    return remember(this.points, word, p);
  }

  /**
   * The joined roster in join order, full TE (both closes and deal take it as `rosterKeys`):
   * `n` keys once registration closed, else the `joinedCount` joined so far. The view and the
   * rows are read at one block; a frozen roster is kept under its `rosterHash`, so a reorg that
   * replaces the close (another roster, the same ceremony id) is read afresh.
   */
  async rosterKeys(cid: Hex): Promise<Point[]> {
    const id = cid.toLowerCase() as Hex;
    const at = { blockNumber: await this.client.getBlockNumber({ cacheTime: 0 }) };
    const view = await this.ceremony(id, at);
    const frozen = view.n > 0 ? `${id}:${view.rosterHash.toLowerCase()}` : undefined;
    const known = frozen !== undefined ? this.rosters.get(frozen) : undefined;
    if (known) return known;
    const count = view.n > 0 ? view.n : view.joinedCount;
    const rows = await Promise.all(
      Array.from({ length: count }, (_, i) =>
        this.read<readonly [Hex, bigint, boolean]>('getParticipantCompressed', [id, i + 1], at),
      ),
    );
    const keys = rows.map(([, word], i) => this.decompress(word, `roster key ${i + 1} of ${id}`));
    return frozen !== undefined ? remember(this.rosters, frozen, keys) : keys;
  }

  /** The request's C1 and C2 points, decompressed from the stored words (protocol §9.2). */
  async requestPoints(requestId: Hex): Promise<RequestPoints> {
    const [shape, words] = await Promise.all([
      this.requestMeta(requestId),
      this.read<readonly (readonly [bigint, bigint])[]>('getRequestCompressed', [requestId]),
    ]);
    const c1: Point[] = [];
    const c2: Point[] = [];
    words.forEach(([w1, w2], k) => {
      c1.push(this.decompress(w1, `C1[${k}] of ${requestId}`));
      c2.push(this.decompress(w2, `C2[${k}] of ${requestId}`));
    });
    return { ceremonyId: shape.ceremonyId, fieldCount: shape.fieldCount, c1, c2 };
  }

  /**
   * The action with every relayer-rebuilt point filled in from state (architecture §5.1). A
   * read the contract refuses (UnknownCeremony, UnknownRequest, …) is the answer simulation
   * would give: SIMULATION_REVERTED. A transport failure is INTERNAL and retryable.
   */
  async complete(action: Action): Promise<Action> {
    try {
      switch (action.kind) {
        case 'closeRegistration':
        case 'deal':
          return action.rosterKeys ? action : { ...action, rosterKeys: await this.rosterKeys(action.message.ceremonyId) };
        case 'closeRegistrationScheduled':
          return action.rosterKeys ? action : { ...action, rosterKeys: await this.rosterKeys(action.ceremonyId) };
        case 'submitPartial':
          return action.C1 ? action : { ...action, C1: (await this.requestPoints(action.message.requestId)).c1 };
        case 'combine': {
          if (action.C2) return action;
          const { c2 } = await this.requestPoints(action.requestId);
          // An index outside the request is left for the contract to refuse (BadFieldIndexes).
          return { ...action, C2: action.fieldIndexes.map((k) => c2[k] ?? { x: 0n, y: 1n }) };
        }
        default:
          return action;
      }
    } catch (err) {
      if (err instanceof RelayError) throw err;
      if (extractRevertData(err) !== undefined) throw simulationError(err);
      throw new RelayError('INTERNAL', `chain read failed: ${shortMessage(err)}`);
    }
  }
}
