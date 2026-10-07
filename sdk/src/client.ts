/**
 * Chain client (architecture §4 `client`, protocol §9.3 item 1).
 *
 * Security-relevant reads are "authenticated": every read runs against at
 * least two independently administered RPC providers, pinned to one finalized
 * block whose hash all providers must agree on, and the responses must be
 * identical. On disagreement or unavailability the client refuses — it never
 * takes the first successful response. A single RPC is permitted only in an
 * explicitly declared local development mode, never on a production chain.
 */

import {
  createPublicClient,
  encodeFunctionData,
  http,
  parseEventLogs,
  type AbiEvent,
  type Log,
  type PublicClient,
} from 'viem';
import { COUNCIL_MANAGER_ABI } from './abi.js';
import { circuitReleaseStatus, type CircuitReleaseStatus } from './artifacts.js';
import { compressPoint, decompressPoint } from './codec.js';
import { MAX_FIELDS, Phase } from './constants.js';
import { assertValidSubgroupPoint, hornerEval, pointEq } from './curve.js';
import { dealContext, normalizeCeremonyId, rosterHash as computeRosterHash } from './encoding.js';
import { scanLogs, type LogScanResult } from './logs.js';
import {
  readRequestBinding,
  readRequestIds,
  readRequestOrigin,
  type RequestBinding,
  type RequestOrigin,
} from './requests.js';
import type {
  Action,
  CeremonyView,
  Hex,
  PartialCommitment,
  PartialRequestSnapshot,
  PhasePolicyView,
  Point,
  RecoverySlice,
  RequestMeta,
  Roster,
} from './types.js';

export interface CouncilClientOptions {
  chainId: bigint;
  manager: Hex;
  /** Pinned RPC endpoints; at least 2 independent providers required. */
  rpcUrls?: string[];
  /**
   * Explicit local development mode (e.g. Anvil): permits a single RPC.
   * Never set this against a production chain.
   */
  devMode?: boolean;
  /** Preconstructed clients (tests); overrides rpcUrls. */
  clients?: PublicClient[];
}

export interface FinalizedAnchor {
  blockNumber: bigint;
  blockHash: Hex;
}

/**
 * The manager is deployed at the chain head but has no code yet at the
 * finalized height, so authenticated reads (which pin to the finalized
 * block) cannot serve it yet. Transient right after deployment: finality
 * typically takes ~15 min on Sepolia, ~1–2 min on Gnosis. Wait with
 * `CouncilClient.waitForFinalizedDeployment` or retry later.
 */
export class NotFinalizedYetError extends Error {
  constructor(
    readonly manager: Hex,
    /** The finalized height the read was pinned to (no code there yet). */
    readonly finalizedBlock: bigint,
    /** The latest height observed (code exists there). */
    readonly latestBlock: bigint,
  ) {
    super(
      `council client: manager ${manager} has no code at finalized block ${finalizedBlock} ` +
        `(latest ${latestBlock}) — the deployment is not finalized yet`,
    );
    this.name = 'NotFinalizedYetError';
  }
}

/** Chains on which devMode (a single RPC provider) is permitted. */
const LOCAL_CHAIN_IDS = new Set<bigint>([31337n, 1337n]);

/** Normalize an RPC URL for duplicate detection (scheme/host lowercased, trailing slash dropped). */
const normalizeRpcUrl = (url: string): string => {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`council client: invalid RPC URL ${url}`);
  }
  const path = u.pathname.replace(/\/+$/, '');
  return `${u.protocol.toLowerCase()}//${u.host.toLowerCase()}${path}${u.search}`;
};

/** Deterministic serialization (bigint-safe) for cross-provider comparison. */
const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, val: unknown) => (typeof val === 'bigint' ? `#${val.toString(10)}` : val));

/** One view call of an authenticated batch read. */
export interface ViewCall {
  functionName: string;
  args?: readonly unknown[];
}

/** CouncilManager event names (for `scanEvents`). */
export type ManagerEventName = Extract<(typeof COUNCIL_MANAGER_ABI)[number], { type: 'event' }>['name'];

export class CouncilClient {
  readonly chainId: bigint;
  readonly manager: Hex;
  private readonly clients: PublicClient[];
  private chainChecked: Promise<void> | undefined;
  /** Anchors this instance issued (or re-validated) — see `authenticatedRead`. */
  private readonly issuedAnchors = new WeakSet<FinalizedAnchor>();

  constructor(options: CouncilClientOptions) {
    this.chainId = options.chainId;
    this.manager = options.manager;
    if (options.rpcUrls && !options.clients) {
      const normalized = options.rpcUrls.map(normalizeRpcUrl);
      if (new Set(normalized).size !== normalized.length) {
        throw new Error('council client: duplicate RPC endpoints — the providers must be independent');
      }
    }
    this.clients =
      options.clients ?? (options.rpcUrls ?? []).map((url) => createPublicClient({ transport: http(url) }));
    if (this.clients.length === 0) throw new Error('council client: need at least one RPC endpoint');
    if (this.clients.length < 2) {
      if (!options.devMode) {
        throw new Error(
          'council client: a single RPC endpoint is only permitted in explicit local development mode (devMode)',
        );
      }
      if (!LOCAL_CHAIN_IDS.has(this.chainId)) {
        throw new Error(
          `council client: devMode (single RPC) is only permitted on a local development chain (31337/1337), not ${this.chainId}`,
        );
      }
    }
  }

  /** Every provider must serve the pinned chain (checked once, lazily). */
  private verifyChain(): Promise<void> {
    this.chainChecked ??= (async () => {
      const ids = await Promise.all(this.clients.map((c) => c.getChainId()));
      for (const id of ids) {
        if (BigInt(id) !== this.chainId) {
          throw new Error(`council client: RPC serves chain ${id}, pinned deployment is ${this.chainId}`);
        }
      }
    })();
    return this.chainChecked;
  }

  /** The finalized block all providers agree on (§9.3 item 1). */
  async finalizedAnchor(): Promise<FinalizedAnchor> {
    await this.verifyChain();
    const blocks = await Promise.all(this.clients.map((c) => c.getBlock({ blockTag: 'finalized' })));
    const first = blocks[0];
    if (!first) throw new Error('council client: no finalized block');
    for (const b of blocks) {
      if (b.hash !== first.hash || b.number !== first.number) {
        throw new Error('council client: RPC providers disagree on the finalized block — refusing');
      }
    }
    const anchor: FinalizedAnchor = { blockNumber: first.number, blockHash: first.hash as Hex };
    this.issuedAnchors.add(anchor);
    return anchor;
  }

  /**
   * A caller-supplied anchor is trusted only if this instance issued it;
   * anything else is re-validated against every provider: the block at
   * `anchor.blockNumber` must carry exactly `anchor.blockHash` and every
   * provider's finalized head must be at or past it.
   */
  private async validateAnchor(anchor: FinalizedAnchor): Promise<void> {
    if (this.issuedAnchors.has(anchor)) return;
    await this.verifyChain();
    const [byNumber, finals] = await Promise.all([
      Promise.all(this.clients.map((c) => c.getBlock({ blockNumber: anchor.blockNumber }))),
      Promise.all(this.clients.map((c) => c.getBlock({ blockTag: 'finalized' }))),
    ]);
    for (const b of byNumber) {
      if (b.hash !== anchor.blockHash) {
        throw new Error('council client: anchor block hash does not match the chain — refusing');
      }
    }
    for (const f of finals) {
      if (f.number < anchor.blockNumber) {
        throw new Error('council client: anchor block is not finalized on every provider — refusing');
      }
    }
    this.issuedAnchors.add(anchor);
  }

  private async readOne(client: PublicClient, call: ViewCall, blockNumber: bigint): Promise<unknown> {
    return client.readContract({
      address: this.manager,
      abi: COUNCIL_MANAGER_ABI,
      functionName: call.functionName as never,
      args: (call.args ?? []) as never,
      blockNumber,
    });
  }

  /**
   * Authenticated batch read: all calls at one agreed finalized block, every
   * provider required to return identical results.
   *
   * An `anchor` is honored only if this instance issued it (`finalizedAnchor`
   * or a previous read); any other anchor object is first re-validated
   * against every provider (hash at that height, finalized status), so a
   * forged or stale anchor can never pin reads to an unverified block.
   */
  async authenticatedRead(calls: ViewCall[], anchor?: FinalizedAnchor): Promise<{ results: unknown[]; anchor: FinalizedAnchor }> {
    if (anchor) await this.validateAnchor(anchor);
    const at = anchor ?? (await this.finalizedAnchor());
    let perClient: unknown[][];
    try {
      perClient = await Promise.all(
        this.clients.map((c) => Promise.all(calls.map((call) => this.readOne(c, call, at.blockNumber)))),
      );
    } catch (err) {
      await this.throwIfNotFinalized(at);
      throw err;
    }
    const reference = perClient[0] as unknown[];
    for (let ci = 1; ci < perClient.length; ci++) {
      const other = perClient[ci] as unknown[];
      for (let i = 0; i < calls.length; i++) {
        if (canonical(other[i]) !== canonical(reference[i])) {
          const fn = (calls[i] as ViewCall).functionName;
          throw new Error(`council client: RPC providers disagree on ${fn} at block ${at.blockNumber} — refusing`);
        }
      }
    }
    return { results: reference, anchor: at };
  }

  /**
   * A read failed at the finalized anchor: if the manager has no code there
   * but does at the latest block, the deployment simply is not finalized yet
   * — surface that as a typed `NotFinalizedYetError` instead of the raw ABI
   * decode error. Probe failures are swallowed so the original error wins.
   */
  private async throwIfNotFinalized(at: FinalizedAnchor): Promise<void> {
    let atAnchor: string | undefined;
    let atLatest: string | undefined;
    let latest = at.blockNumber;
    try {
      const client = this.clients[0] as PublicClient;
      [atAnchor, atLatest, latest] = await Promise.all([
        client.getCode({ address: this.manager, blockNumber: at.blockNumber }),
        client.getCode({ address: this.manager, blockTag: 'latest' }),
        client.getBlockNumber(),
      ]);
    } catch {
      return; // probe unavailable; let the original error propagate
    }
    const empty = (code?: string) => code === undefined || code === '0x';
    if (!empty(atAnchor)) return; // code is there; not our condition
    if (!empty(atLatest)) throw new NotFinalizedYetError(this.manager, at.blockNumber, latest);
    throw new Error(`council client: no contract code at manager ${this.manager} on this chain`);
  }

  /**
   * Wait until the manager has code at the finalized block on every
   * provider — i.e. until authenticated reads stop throwing
   * `NotFinalizedYetError` right after deployment. Resolves to the first
   * anchor carrying the code; `onProgress` fires once per poll with the
   * heights, so the app can show "waiting for the network to confirm
   * (usually ~15 min on Sepolia, ~1–2 min on Gnosis)". Throws
   * `NotFinalizedYetError` on timeout.
   */
  async waitForFinalizedDeployment(
    opts: {
      /** Default 20 minutes. */
      timeoutMs?: number;
      /** Default 10 seconds. */
      pollMs?: number;
      onProgress?: (p: { finalizedBlock: bigint; latestBlock: bigint }) => void;
    } = {},
  ): Promise<FinalizedAnchor> {
    const timeoutMs = opts.timeoutMs ?? 20 * 60_000;
    const pollMs = opts.pollMs ?? 10_000;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const anchor = await this.finalizedAnchor();
      const codes = await Promise.all(
        this.clients.map((c) => c.getCode({ address: this.manager, blockNumber: anchor.blockNumber })),
      );
      if (codes.every((code) => code !== undefined && code !== '0x')) return anchor;
      const latest = await (this.clients[0] as PublicClient).getBlockNumber();
      opts.onProgress?.({ finalizedBlock: anchor.blockNumber, latestBlock: latest });
      if (Date.now() + pollMs > deadline) {
        throw new NotFinalizedYetError(this.manager, anchor.blockNumber, latest);
      }
      await new Promise((resolve) => setTimeout(resolve, pollMs));
    }
  }

  // --- typed views (architecture §1.2) ---

  async getCeremony(cid: Hex, anchor?: FinalizedAnchor): Promise<CeremonyView> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getCeremony', args: [normalizeCeremonyId(cid)] }],
      anchor,
    );
    return results[0] as CeremonyView;
  }

  async getInvite(cid: Hex, inviteId: number, anchor?: FinalizedAnchor): Promise<{ key: Hex; consumed: boolean }> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getInvite', args: [normalizeCeremonyId(cid), inviteId] }],
      anchor,
    );
    const [key, consumed] = results[0] as [Hex, boolean];
    return { key, consumed };
  }

  /** The ceremony's phase policy (architecture §1.2; §8.1/§8.7). */
  async getPolicy(cid: Hex, anchor?: FinalizedAnchor): Promise<PhasePolicyView> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getPolicy', args: [normalizeCeremonyId(cid)] }],
      anchor,
    );
    return results[0] as PhasePolicyView;
  }

  /** The §8.7 decryption gate, as the contract evaluates it. */
  async isDecryptionOpen(cid: Hex, anchor?: FinalizedAnchor): Promise<boolean> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'isDecryptionOpen', args: [normalizeCeremonyId(cid)] }],
      anchor,
    );
    return results[0] as boolean;
  }

  async protocolVersion(anchor?: FinalizedAnchor): Promise<number> {
    const { results } = await this.authenticatedRead([{ functionName: 'protocolVersion' }], anchor);
    return Number(results[0]);
  }

  async getParticipantCompressed(
    cid: Hex,
    index: number,
    anchor?: FinalizedAnchor,
  ): Promise<{ auth: Hex; compressedKey: bigint; dealt: boolean }> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getParticipantCompressed', args: [normalizeCeremonyId(cid), index] }],
      anchor,
    );
    const [auth, compressedKey, dealt] = results[0] as [Hex, bigint, boolean];
    return { auth, compressedKey, dealt };
  }

  /**
   * The full frozen roster, one authenticated snapshot (§9.3 item 2). Every
   * X_i is stored compressed; it is decompressed per §2.5 and re-validated
   * (canonical, on curve, prime subgroup, non-identity) here.
   */
  async getRoster(cid: Hex, anchor?: FinalizedAnchor): Promise<{ roster: Roster; view: CeremonyView; anchor: FinalizedAnchor }> {
    const id = normalizeCeremonyId(cid);
    const first = await this.authenticatedRead([{ functionName: 'getCeremony', args: [id] }], anchor);
    const view = first.results[0] as CeremonyView;
    const n = view.n;
    const calls: ViewCall[] = [];
    for (let i = 1; i <= n; i++) calls.push({ functionName: 'getParticipantCompressed', args: [id, i] });
    const { results } = await this.authenticatedRead(calls, first.anchor);
    const authAddresses: Hex[] = [];
    const memberKeys: Point[] = [];
    results.forEach((r, i) => {
      const [auth, compressedKey] = r as [Hex, bigint, boolean];
      authAddresses.push(auth);
      const key = decompressPoint(compressedKey);
      assertValidSubgroupPoint(key, `X_${i + 1}`);
      memberKeys.push(key);
    });
    return { roster: { t: view.threshold, n, authAddresses, memberKeys }, view, anchor: first.anchor };
  }

  /** The stored aggregates A_0..A_15 (full TE, identity padded above t−1). */
  async getAggregates(cid: Hex, anchor?: FinalizedAnchor): Promise<Point[]> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getAggregates', args: [normalizeCeremonyId(cid)] }],
      anchor,
    );
    return (results[0] as readonly (readonly [bigint, bigint])[]).map(([x, y]) => ({ x, y }));
  }

  /** One dealer's durable recovery data: compressed(E_j) + its masked-share row. */
  async getRecoveryDealing(
    cid: Hex,
    dealerIndex: number,
    anchor?: FinalizedAnchor,
  ): Promise<{ compressedE: bigint; maskedShares: bigint[] }> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getRecoveryDealing', args: [normalizeCeremonyId(cid), dealerIndex] }],
      anchor,
    );
    const [compressedE, maskedShares] = results[0] as [bigint, readonly bigint[]];
    return { compressedE, maskedShares: maskedShares.slice() };
  }

  /** One member's recovery slice (§8.6): QUAL bitmap + per-dealer compressed(E_j), masked_{j,m}. */
  async getRecoverySlice(cid: Hex, memberIndex: number, anchor?: FinalizedAnchor): Promise<RecoverySlice> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getRecoverySlice', args: [normalizeCeremonyId(cid), memberIndex] }],
      anchor,
    );
    const [qualBitmap, compressedE, maskedShares] = results[0] as [number, readonly bigint[], readonly bigint[]];
    return { qualBitmap: Number(qualBitmap), compressedE: compressedE.slice(), maskedShares: maskedShares.slice() };
  }

  async getPublicKey(cid: Hex, anchor?: FinalizedAnchor): Promise<Point> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getPublicKey', args: [normalizeCeremonyId(cid)] }],
      anchor,
    );
    const [x, y] = results[0] as [bigint, bigint];
    return { x, y };
  }

  async getMemberKey(cid: Hex, index: number, anchor?: FinalizedAnchor): Promise<Point> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getMemberKey', args: [normalizeCeremonyId(cid), index] }],
      anchor,
    );
    const [x, y] = results[0] as [bigint, bigint];
    return { x, y };
  }

  async getRequestMeta(requestIdValue: Hex, anchor?: FinalizedAnchor): Promise<RequestMeta> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getRequestMeta', args: [requestIdValue] }],
      anchor,
    );
    const [cid, fieldCount, completedBitmap, partialBitmap] = results[0] as [Hex, number, number, number];
    return {
      ceremonyId: cid,
      fieldCount: Number(fieldCount),
      completedBitmap: Number(completedBitmap),
      partialBitmap: Number(partialBitmap),
    };
  }

  /** The stored compressed ciphertext words, one `[compressed(C1_k), compressed(C2_k)]` pair per field. */
  async getRequestCompressed(requestIdValue: Hex, anchor?: FinalizedAnchor): Promise<[bigint, bigint][]> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getRequestCompressed', args: [requestIdValue] }],
      anchor,
    );
    return (results[0] as readonly (readonly [bigint, bigint])[]).map(([c1, c2]) => [c1, c2]);
  }

  /** A member's partial commitment (§10.2): admitted bit, stored dataHash, publishedBlock. */
  async getPartialCommitment(requestIdValue: Hex, index: number, anchor?: FinalizedAnchor): Promise<PartialCommitment> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getPartialCommitment', args: [requestIdValue, index] }],
      anchor,
    );
    const [accepted, dataHash, publishedBlock] = results[0] as [boolean, Hex, bigint];
    return { accepted, dataHash, publishedBlock: BigInt(publishedBlock) };
  }

  /**
   * The authenticated, frozen snapshot `buildPartialDecryption` requires
   * (§9.3). Reads request meta, ceremony, policy gate, PK_i, aggregates,
   * roster and the compressed ciphertexts at one finalized anchor across
   * every provider, and refuses if: the request does not exist or belongs to
   * a different ceremony than `expectedCeremonyId`; the ceremony is not Live;
   * the §8.7 gate is closed (read from `isDecryptionOpen`, never a local
   * clock); `participantIndex` is outside the roster; the stored rosterHash
   * or ctx differs from the locally recomputed value; PK_i differs from
   * Horner(A, i) recomputed locally; or any decompressed C1/C2 fails the
   * canonical/on-curve/subgroup checks.
   */
  async getPartialRequestSnapshot(
    requestIdValue: Hex,
    participantIndex: number,
    opts?: { expectedCeremonyId?: Hex },
  ): Promise<PartialRequestSnapshot> {
    const anchor = await this.finalizedAnchor();
    const meta = await this.getRequestMeta(requestIdValue, anchor);
    if (meta.fieldCount < 1 || meta.fieldCount > MAX_FIELDS) {
      throw new Error('council client: request does not exist (fieldCount must be 1..16)');
    }
    const cid = normalizeCeremonyId(meta.ceremonyId);
    if (opts?.expectedCeremonyId !== undefined && normalizeCeremonyId(opts.expectedCeremonyId) !== cid) {
      throw new Error('council client: request belongs to a different ceremony than expected');
    }
    const { results } = await this.authenticatedRead(
      [
        { functionName: 'getCeremony', args: [cid] },
        { functionName: 'getMemberKey', args: [cid, participantIndex] },
        { functionName: 'isDecryptionOpen', args: [cid] },
        { functionName: 'getRequestCompressed', args: [requestIdValue] },
        { functionName: 'getAggregates', args: [cid] },
        { functionName: 'circuitReleaseId' },
      ],
      anchor,
    );
    const view = results[0] as CeremonyView;
    if (view.phase !== Phase.Live) {
      throw new Error(`council client: ceremony is not Live (phase ${view.phase})`);
    }
    const open = results[2] as boolean;
    if (!open) {
      throw new Error(
        'council client: the decryption gate is closed (§8.7) — refusing to snapshot for a partial before opening',
      );
    }
    if (!Number.isInteger(participantIndex) || participantIndex < 1 || participantIndex > view.n) {
      throw new Error('council client: participantIndex is outside the roster (1..n)');
    }
    // §9.3 item 2: stored rosterHash and ctx must equal the locally recomputed values.
    const { roster } = await this.getRoster(cid, anchor);
    const localRosterHash = computeRosterHash(this.chainId, this.manager, cid, roster);
    if (localRosterHash.toLowerCase() !== view.rosterHash.toLowerCase()) {
      throw new Error('council client: stored rosterHash does not match the locally recomputed roster — refusing');
    }
    const releaseId = results[5] as Hex;
    const localCtx = dealContext(this.chainId, this.manager, cid, view.rosterHash, releaseId);
    if (localCtx.toLowerCase() !== view.ctx.toLowerCase()) {
      throw new Error('council client: stored ctx does not match the locally recomputed deal context — refusing');
    }
    // §9.3 item 5 (cross-check half): PK_i must equal Horner(A, i) recomputed locally.
    const [mkX, mkY] = results[1] as [bigint, bigint];
    const memberKey = { x: mkX, y: mkY };
    const aggregates = (results[4] as readonly (readonly [bigint, bigint])[]).map(([x, y]) => ({ x, y }));
    if (!pointEq(hornerEval(aggregates, participantIndex), memberKey)) {
      throw new Error('council client: stored PK_i does not match Horner(A, i) — refusing');
    }
    // §9.3 item 4: decompress and validate every ciphertext point.
    const compressed = results[3] as readonly (readonly [bigint, bigint])[];
    if (compressed.length !== meta.fieldCount) {
      throw new Error('council client: stored ciphertext count does not match fieldCount');
    }
    const cts = compressed.map(([w1, w2], k) => {
      const c1 = decompressPoint(w1);
      const c2 = decompressPoint(w2);
      assertValidSubgroupPoint(c1, `C1[${k}]`);
      assertValidSubgroupPoint(c2, `C2[${k}]`);
      return Object.freeze({ c1: Object.freeze(c1), c2: Object.freeze(c2) });
    });
    return Object.freeze({
      chainId: this.chainId,
      manager: this.manager,
      ceremonyId: cid,
      requestId: requestIdValue,
      phase: view.phase,
      decryptionOpen: open,
      rosterHash: view.rosterHash,
      ctx: view.ctx,
      n: view.n,
      participantIndex,
      memberKey: Object.freeze(memberKey),
      fieldCount: meta.fieldCount,
      cts: Object.freeze(cts),
      anchor,
    });
  }

  /**
   * Authenticate a restored identity against chain registration state
   * (protocol §5.3 restore). Takes only public values (derive them with
   * `kitEntryIdentity`); compares the organizer address against the
   * ceremony's organizer, or scans the registered participants for the auth
   * address and cross-checks X_i — and returns the participant index and
   * roster hash as recorded on chain, never as recorded in the kit.
   */
  async verifyRestoredIdentity(
    identity: { role: 'participant' | 'organizer'; ceremonyId: Hex; authAddress: Hex; sharePublicKey?: Point },
    anchor?: FinalizedAnchor,
  ): Promise<{
    ok: boolean;
    mismatches: string[];
    phase: number;
    rosterHash: Hex;
    participantIndex?: number;
  }> {
    const cid = normalizeCeremonyId(identity.ceremonyId);
    const first = await this.authenticatedRead([{ functionName: 'getCeremony', args: [cid] }], anchor);
    const view = first.results[0] as CeremonyView;
    const mismatches: string[] = [];
    if (view.phase === Phase.None) mismatches.push('ceremony: unknown on chain');
    const auth = identity.authAddress.toLowerCase();
    if (identity.role === 'organizer') {
      if (view.organizer.toLowerCase() !== auth) {
        mismatches.push(`organizer: chain has ${view.organizer.toLowerCase()}, derived ${auth}`);
      }
      return { ok: mismatches.length === 0, mismatches, phase: view.phase, rosterHash: view.rosterHash };
    }
    const count = view.phase === Phase.Registration ? view.joinedCount : view.n;
    let participantIndex: number | undefined;
    if (count > 0) {
      const calls: ViewCall[] = [];
      for (let i = 1; i <= count; i++) calls.push({ functionName: 'getParticipantCompressed', args: [cid, i] });
      const { results } = await this.authenticatedRead(calls, first.anchor);
      for (let i = 0; i < results.length; i++) {
        const [addr, compressedKey] = results[i] as [Hex, bigint, boolean];
        if (addr.toLowerCase() !== auth) continue;
        participantIndex = i + 1;
        const pk = identity.sharePublicKey;
        if (pk && compressPoint(pk) !== compressedKey) {
          mismatches.push(`sharePublicKey: chain X_${i + 1} does not match the derived key`);
        }
        break;
      }
    }
    if (participantIndex === undefined) {
      mismatches.push('participant: derived auth address is not registered in this ceremony');
    }
    return { ok: mismatches.length === 0, mismatches, phase: view.phase, rosterHash: view.rosterHash, participantIndex };
  }

  /**
   * The single owner-approved log read of the protocol (§10.4): ONE
   * `eth_getLogs` restricted to the stored `publishedBlock`, filtered on the
   * pinned manager address and `PartialDataPublished(requestId)`, returning
   * this member's emitted padded D vector (or undefined). Unauthenticated by
   * itself — the caller (`sourcePartialVectors`) only uses the result if its
   * recomputed `partialDataHash` equals the hash stored on chain. Rejects when
   * every provider refuses the read; `sourcePartialVectors` turns that into a
   * missing vector (history is never required, §10.4).
   */
  async fetchPublishedVector(requestIdValue: Hex, index: number, publishedBlock: bigint): Promise<Point[] | undefined> {
    if (publishedBlock === 0n) return undefined;
    const event = COUNCIL_MANAGER_ABI.find(
      (e) => e.type === 'event' && e.name === 'PartialDataPublished',
    ) as AbiEvent;
    let lastErr: unknown;
    for (const client of this.clients) {
      let logs: Log[];
      try {
        logs = await client.getLogs({
          address: this.manager,
          event,
          args: { requestId: requestIdValue } as never,
          fromBlock: publishedBlock,
          toBlock: publishedBlock,
        });
      } catch (err) {
        lastErr = err;
        continue;
      }
      for (const log of parseEventLogs({ abi: COUNCIL_MANAGER_ABI, logs, eventName: 'PartialDataPublished' })) {
        if (log.address.toLowerCase() !== this.manager.toLowerCase()) continue;
        const a = log.args as { requestId: Hex; index: number; D: readonly (readonly [bigint, bigint])[] };
        if (a.requestId.toLowerCase() !== requestIdValue.toLowerCase() || Number(a.index) !== index) continue;
        return a.D.map(([x, y]) => ({ x, y }));
      }
      return undefined; // provider answered; the block holds no matching log
    }
    throw new Error('council client: every provider failed the single-block log fetch', { cause: lastErr });
  }

  async getPlaintexts(requestIdValue: Hex, anchor?: FinalizedAnchor): Promise<{ ready: boolean; values: bigint[] }> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getPlaintexts', args: [requestIdValue] }],
      anchor,
    );
    const [ready, values] = results[0] as [boolean, readonly bigint[]];
    return { ready, values: values.slice() };
  }

  async getCircuitReleaseId(anchor?: FinalizedAnchor): Promise<Hex> {
    const { results } = await this.authenticatedRead([{ functionName: 'circuitReleaseId' }], anchor);
    return results[0] as Hex;
  }

  /**
   * The trust status of this manager's circuit release (authenticated id,
   * looked up in the SDK's pins): apps must warn whenever it is not
   * `production` — a development setup can be forged by its holder.
   */
  async getCircuitReleaseStatus(anchor?: FinalizedAnchor): Promise<CircuitReleaseStatus> {
    return circuitReleaseStatus(await this.getCircuitReleaseId(anchor));
  }

  // --- requests, from state (no logs; protocol §9.3 item 3) ---

  /** Who bound a request: adapter, DAVINCI process id and creator. */
  async getRequestOrigin(requestIdValue: Hex, anchor?: FinalizedAnchor): Promise<RequestOrigin> {
    const { adapter, processId, creator } = await readRequestOrigin(this, requestIdValue, anchor);
    return { adapter, processId, creator };
  }

  /** Every request id bound to the ceremony, in binding order, paged at one anchor. */
  async getRequestIds(cid: Hex, anchor?: FinalizedAnchor): Promise<Hex[]> {
    return (await readRequestIds(this, cid, anchor)).ids;
  }

  /**
   * The vote a request belongs to, derived from the request record and authenticated at one
   * finalized anchor (`readRequestBinding`): never from logs, so it works however old the
   * ceremony is.
   */
  async verifyRequestBinding(cid: Hex, requestIdValue: Hex, anchor?: FinalizedAnchor): Promise<RequestBinding> {
    return readRequestBinding(this, cid, requestIdValue, anchor);
  }

  // --- events (cosmetic discovery only; act on authenticated state, never on logs) ---

  /**
   * Paged, resumable scan of manager events from the first provider (falling back to the
   * others), decoded. Unauthenticated: labels and linkage only. Ranges of at most `chunkSize`
   * blocks (default 10,000), halved when a provider refuses one; an incomplete result carries
   * `nextBlock` to resume from instead of throwing. `args` filters indexed arguments of
   * `eventName` (e.g. `{ cid }`).
   */
  async scanEvents(opts: {
    fromBlock: bigint;
    toBlock?: bigint;
    eventName?: ManagerEventName;
    args?: Record<string, unknown>;
    chunkSize?: bigint;
    maxRequests?: number;
    signal?: AbortSignal;
  }): Promise<LogScanResult & { events: ReturnType<typeof decodeManagerLogs> }> {
    const event = opts.eventName
      ? (COUNCIL_MANAGER_ABI.find((e) => e.type === 'event' && e.name === opts.eventName) as AbiEvent | undefined)
      : undefined;
    if (opts.eventName && !event) throw new Error(`council client: unknown event ${opts.eventName}`);
    const result = await scanLogs(this.clients, {
      address: this.manager,
      event,
      args: opts.args,
      fromBlock: opts.fromBlock,
      toBlock: opts.toBlock,
      chunkSize: opts.chunkSize,
      maxRequests: opts.maxRequests,
      signal: opts.signal,
    });
    return { ...result, events: decodeManagerLogs(result.logs) };
  }

  /**
   * Every manager event in `[fromBlock, toBlock]` (default: up to the head), read in ranges of
   * at most 10,000 blocks. Throws when the scan cannot complete; prefer `scanEvents`.
   */
  async getEvents(args: { fromBlock: bigint; toBlock?: bigint }): Promise<ReturnType<typeof decodeManagerLogs>> {
    const result = await this.scanEvents({ fromBlock: args.fromBlock, toBlock: args.toBlock });
    if (!result.complete) {
      throw new Error(
        `council client: event scan stopped at block ${result.nextBlock} of ${result.toBlock}` +
          (result.error instanceof Error ? ` (${result.error.message})` : ''),
        { cause: result.error },
      );
    }
    return result.events;
  }

  // --- direct submission (any funded account; relayer bypass) ---

  /** The exact calldata of an action, for direct sending or simulation. */
  actionCalldata(action: Action): { to: Hex; data: Hex } {
    return { to: this.manager, data: encodeAction(action) };
  }

  /** Send an action directly from any funded viem wallet client. */
  async sendAction(
    wallet: { sendTransaction(args: { to: Hex; data: Hex }): Promise<Hex> },
    action: Action,
  ): Promise<Hex> {
    const { to, data } = this.actionCalldata(action);
    return wallet.sendTransaction({ to, data });
  }
}

/** Decode CouncilManager logs into typed events. */
export function decodeManagerLogs(logs: Log[]) {
  return parseEventLogs({ abi: COUNCIL_MANAGER_ABI, logs });
}

const pointRow = (p: Point): [bigint, bigint] => [p.x, p.y];

/** A relayer-rebuilt field is optional on the Action but required for direct calldata. */
function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`encodeAction: ${what} is required for direct submission (the relayer rebuilds it)`);
  return v;
}

/** Encode an action into CouncilManager calldata (pure; exported for tests). */
export function encodeAction(action: Action): Hex {
  const abi = COUNCIL_MANAGER_ABI;
  switch (action.kind) {
    case 'createCeremony':
      return encodeFunctionData({ abi, functionName: 'createCeremony', args: [action.message, action.signature] as never });
    case 'addInvites':
      return encodeFunctionData({ abi, functionName: 'addInvites', args: [action.message, action.signature] as never });
    case 'closeRegistration':
      return encodeFunctionData({
        abi,
        functionName: 'closeRegistration',
        args: [action.message, action.signature, need(action.rosterKeys, 'rosterKeys').map(pointRow)] as never,
      });
    case 'closeRegistrationScheduled':
      return encodeFunctionData({
        abi,
        functionName: 'closeRegistrationScheduled',
        args: [action.ceremonyId, need(action.rosterKeys, 'rosterKeys').map(pointRow)] as never,
      });
    case 'openDecryption':
      return encodeFunctionData({
        abi,
        functionName: 'openDecryption',
        args: [action.message, action.signature] as never,
      });
    case 'allowAdapter':
      return encodeFunctionData({ abi, functionName: 'allowAdapter', args: [action.message, action.signature] as never });
    case 'authorizeCreator':
      return encodeFunctionData({
        abi,
        functionName: 'authorizeCreator',
        args: [action.message, action.signature] as never,
      });
    case 'join':
      return encodeFunctionData({
        abi,
        functionName: 'join',
        args: [action.message, action.signature, action.invite, action.inviteSignature] as never,
      });
    case 'deal':
      return encodeFunctionData({
        abi,
        functionName: 'deal',
        args: [
          action.message,
          action.signature,
          action.payload.C.map(pointRow),
          pointRow(action.payload.E),
          action.payload.masked,
          action.payload.proof.pA,
          action.payload.proof.pB,
          action.payload.proof.pC,
          need(action.rosterKeys, 'rosterKeys').map(pointRow),
        ] as never,
      });
    case 'submitPartial':
      return encodeFunctionData({
        abi,
        functionName: 'submitPartial',
        args: [
          action.message,
          action.signature,
          action.payload.D.map(pointRow),
          action.payload.proof.pA,
          action.payload.proof.pB,
          action.payload.proof.pC,
          need(action.C1, 'C1').map(pointRow),
        ] as never,
      });
    case 'finalize':
      return encodeFunctionData({ abi, functionName: 'finalize', args: [action.ceremonyId] as never });
    case 'abort':
      return encodeFunctionData({ abi, functionName: 'abort', args: [action.ceremonyId] as never });
    case 'combine':
      return encodeFunctionData({
        abi,
        functionName: 'combine',
        args: [
          action.requestId,
          action.memberSet,
          action.fieldIndexes,
          action.plaintexts,
          action.partialVectors.map((v) => v.map(pointRow)),
          need(action.C2, 'C2').map(pointRow),
        ] as never,
      });
    case 'publishPartialData':
      return encodeFunctionData({
        abi,
        functionName: 'publishPartialData',
        args: [action.requestId, action.participantIndex, action.D.map(pointRow)] as never,
      });
  }
}
