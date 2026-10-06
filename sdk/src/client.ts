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
import { MAX_FIELDS, Phase } from './constants.js';
import { normalizeCeremonyId } from './encoding.js';
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
  Dealing,
  Hex,
  PartialRequestSnapshot,
  Point,
  RequestView,
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

  /** The full frozen roster, one authenticated snapshot (§9.3 item 2). */
  async getRoster(cid: Hex, anchor?: FinalizedAnchor): Promise<{ roster: Roster; view: CeremonyView; anchor: FinalizedAnchor }> {
    const id = normalizeCeremonyId(cid);
    const first = await this.authenticatedRead([{ functionName: 'getCeremony', args: [id] }], anchor);
    const view = first.results[0] as CeremonyView;
    const n = view.n;
    const calls: ViewCall[] = [];
    for (let i = 1; i <= n; i++) calls.push({ functionName: 'getParticipant', args: [id, i] });
    const { results } = await this.authenticatedRead(calls, first.anchor);
    const authAddresses: Hex[] = [];
    const memberKeys: Point[] = [];
    for (const r of results) {
      const [auth, pkX, pkY] = r as [Hex, bigint, bigint, boolean];
      authAddresses.push(auth);
      memberKeys.push({ x: pkX, y: pkY });
    }
    return { roster: { t: view.threshold, n, authAddresses, memberKeys }, view, anchor: first.anchor };
  }

  async getDealing(cid: Hex, dealerIndex: number, anchor?: FinalizedAnchor): Promise<Dealing> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getDealing', args: [normalizeCeremonyId(cid), dealerIndex] }],
      anchor,
    );
    const [C, E, masked] = results[0] as [readonly (readonly [bigint, bigint])[], readonly [bigint, bigint], readonly bigint[]];
    return {
      C: C.map(([x, y]) => ({ x, y })),
      E: { x: E[0], y: E[1] },
      masked: masked.slice(),
    };
  }

  /** All accepted dealings of QUAL, one snapshot. */
  async getQualDealings(cid: Hex, qual: number[], anchor?: FinalizedAnchor): Promise<Map<number, Dealing>> {
    const id = normalizeCeremonyId(cid);
    const { results } = await this.authenticatedRead(
      qual.map((j) => ({ functionName: 'getDealing', args: [id, j] })),
      anchor,
    );
    const out = new Map<number, Dealing>();
    qual.forEach((j, idx) => {
      const [C, E, masked] = results[idx] as [
        readonly (readonly [bigint, bigint])[],
        readonly [bigint, bigint],
        readonly bigint[],
      ];
      out.set(j, { C: C.map(([x, y]) => ({ x, y })), E: { x: E[0], y: E[1] }, masked: masked.slice() });
    });
    return out;
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

  async getRequest(requestIdValue: Hex, anchor?: FinalizedAnchor): Promise<RequestView> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getRequest', args: [requestIdValue] }],
      anchor,
    );
    const [cid, fieldCount, completedBitmap, partialBitmap, cts] = results[0] as [
      Hex,
      number,
      number,
      number,
      readonly (readonly bigint[])[],
    ];
    return {
      ceremonyId: cid,
      fieldCount,
      completedBitmap,
      partialBitmap,
      cts: cts.map((row) => [row[0], row[1], row[2], row[3]] as [bigint, bigint, bigint, bigint]),
    };
  }

  /**
   * The authenticated, frozen snapshot `buildPartialDecryption` requires
   * (§9.3). Reads request, ceremony and PK_i at one finalized anchor across
   * every provider, cross-checks them, and refuses if the request does not
   * exist, belongs to a different ceremony than `expectedCeremonyId`, the
   * ceremony is not Live, or `participantIndex` is outside the roster.
   */
  async getPartialRequestSnapshot(
    requestIdValue: Hex,
    participantIndex: number,
    opts?: { expectedCeremonyId?: Hex },
  ): Promise<PartialRequestSnapshot> {
    const anchor = await this.finalizedAnchor();
    const request = await this.getRequest(requestIdValue, anchor);
    if (request.fieldCount < 1 || request.fieldCount > MAX_FIELDS) {
      throw new Error('council client: request does not exist (fieldCount must be 1..16)');
    }
    const cid = normalizeCeremonyId(request.ceremonyId);
    if (opts?.expectedCeremonyId !== undefined && normalizeCeremonyId(opts.expectedCeremonyId) !== cid) {
      throw new Error('council client: request belongs to a different ceremony than expected');
    }
    const { results } = await this.authenticatedRead(
      [
        { functionName: 'getCeremony', args: [cid] },
        { functionName: 'getMemberKey', args: [cid, participantIndex] },
      ],
      anchor,
    );
    const view = results[0] as CeremonyView;
    if (view.phase !== Phase.Live) {
      throw new Error(`council client: ceremony is not Live (phase ${view.phase})`);
    }
    if (!Number.isInteger(participantIndex) || participantIndex < 1 || participantIndex > view.n) {
      throw new Error('council client: participantIndex is outside the roster (1..n)');
    }
    const [mkX, mkY] = results[1] as [bigint, bigint];
    const cts = request.cts
      .slice(0, request.fieldCount)
      .map(([x1, y1, x2, y2]) => Object.freeze({ c1: Object.freeze({ x: x1, y: y1 }), c2: Object.freeze({ x: x2, y: y2 }) }));
    return Object.freeze({
      chainId: this.chainId,
      manager: this.manager,
      ceremonyId: cid,
      requestId: requestIdValue,
      phase: view.phase,
      n: view.n,
      participantIndex,
      memberKey: Object.freeze({ x: mkX, y: mkY }),
      fieldCount: request.fieldCount,
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
      for (let i = 1; i <= count; i++) calls.push({ functionName: 'getParticipant', args: [cid, i] });
      const { results } = await this.authenticatedRead(calls, first.anchor);
      for (let i = 0; i < results.length; i++) {
        const [addr, pkX, pkY] = results[i] as [Hex, bigint, bigint, boolean];
        if (addr.toLowerCase() !== auth) continue;
        participantIndex = i + 1;
        const pk = identity.sharePublicKey;
        if (pk && (pk.x !== pkX || pk.y !== pkY)) {
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

  async getPartial(requestIdValue: Hex, index: number, anchor?: FinalizedAnchor): Promise<Point[]> {
    const { results } = await this.authenticatedRead(
      [{ functionName: 'getPartial', args: [requestIdValue, index] }],
      anchor,
    );
    return (results[0] as readonly (readonly [bigint, bigint])[]).map(([x, y]) => ({ x, y }));
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
        args: [action.requestId, action.memberSet, action.fieldIndexes, action.plaintexts] as never,
      });
  }
}
