/**
 * In-memory chain + services fakes. All protocol values (roster hash, deal
 * context, dealings, member keys, ciphertexts) are built with the real SDK so
 * the flows' checks run for real; only transport and proving are faked.
 */

import {
  addPoints,
  buildDealing,
  compressPoint,
  dealContext,
  dealerCoefficients,
  dealerEphemeral,
  generateMnemonic,
  hornerEval,
  KNOWN_CIRCUIT_RELEASES,
  mulBase,
  mulPoint,
  organizerAuthKey,
  Phase,
  PhaseMode,
  rootFromMnemonic,
  requestId as sdkRequestId,
  rosterHash,
  ceremonyId as sdkCeremonyId,
  type Action,
  type CeremonyView,
  type Dealing,
  type DealWitnessInput,
  type FinalizedAnchor,
  type Groth16Proof,
  type Hex,
  type PartialCommitment,
  type PartialRequestSnapshot,
  type PartialWitnessInput,
  type PhasePolicyView,
  type Point,
  type RecoverySlice,
  type RequestMeta,
  type Roster,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { AppConfig } from '../../src/config';
import { participantKeys, type ParticipantKeys } from '../../src/flows/participant';
import type { ChainReader, ManagerEvent } from '../../src/lib/chain';
import type { Services } from '../../src/services';

export const MANAGER = '0x00000000000000000000000000000000000000aa' as Hex;
const DEFAULT_MANAGER = MANAGER;

export function makeConfig(manager: Hex = MANAGER): AppConfig {
  return {
    chainId: 31337,
    manager,
    rpcUrls: ['http://127.0.0.1:8545'],
    relayerUrls: [],
    artifactsBaseUrls: [],
    deploymentBlock: 0,
    legacyDeployments: [],
    devMode: true,
  };
}

const ANCHOR: FinalizedAnchor = { blockNumber: 1n, blockHash: `0x${'ab'.repeat(32)}` as Hex };
const ZERO_PROOF: Groth16Proof = { pA: [0n, 0n], pB: [[0n, 0n], [0n, 0n]], pC: [0n, 0n] };

/** Recompute the pinned public signals from a witness input (what a sound proof would carry). */
function signalsFromWitness(circuit: 'deal' | 'partial', w: DealWitnessInput | PartialWitnessInput): bigint[] {
  if (circuit === 'deal') {
    const d = w as DealWitnessInput;
    return [
      d.ctxHi,
      d.ctxLo,
      d.dealerIndex,
      d.n,
      d.t,
      ...d.C.flat(),
      ...d.E,
      ...d.X.flat(),
      ...d.masked,
    ].map(BigInt);
  }
  const p = w as PartialWitnessInput;
  return [...p.PK, p.activeCount, ...p.C1.flat(), ...p.D.flat()].map(BigInt);
}

/** The request state the fake keeps (the v2 ABI splits it into meta + compressed cts). */
export interface FakeRequest {
  ceremonyId: Hex;
  fieldCount: number;
  completedBitmap: number;
  partialBitmap: number;
  cts: [bigint, bigint, bigint, bigint][];
}

/** The mutable §8.1 policy knobs of the fake (PhasePolicyView minus the computed fields). */
export interface FakePolicy {
  registrationMode: number;
  decryptionMode: number;
  dealingDuration: bigint;
  decryptionOpenAt: bigint;
  manualDecryptionFallbackAt: bigint;
  manualOpenedAt: bigint;
}

export class FakeChain implements ChainReader {
  readonly chainId: bigint;
  readonly manager: Hex;
  view: CeremonyView;
  roster: Roster;
  releaseId: Hex;
  cid: Hex;
  dealings: Map<number, Dealing>;
  memberPks: Point[]; // PK_i, slot i-1
  invites: { key: Hex; consumed: boolean }[] = [];
  participants: { auth: Hex; key: Point; inviteId: number }[] = [];
  /** Every bound request id in binding order (includes bound-but-not-submitted votes). */
  requestIds: string[] = [];
  /** Submitted requests only (the contract's request record is created on submission). */
  requests = new Map<string, FakeRequest>();
  plaintexts = new Map<string, { ready: boolean; values: bigint[] }>();
  /** §8.1 policy; default: manual close, manual decryption already opened (gate open in Live). */
  policy: FakePolicy = {
    registrationMode: PhaseMode.Manual as number,
    decryptionMode: PhaseMode.Manual as number,
    dealingDuration: 3600n,
    decryptionOpenAt: 0n,
    manualDecryptionFallbackAt: 0n,
    manualOpenedAt: 1n,
  };
  /** §10.2 partial commitments, keyed `${requestId}:${memberIndex}`. */
  partials = new Map<string, PartialCommitment>();
  /** §10.4 published D vectors, keyed `${requestId}:${memberIndex}`. */
  published = new Map<string, Point[]>();
  allowedAdapters = new Set<string>();
  authorizedCreators = new Set<string>();
  bindings = new Map<string, { cid: Hex; requestId: Hex; requested: boolean }>();
  /** getRequestOrigin per request id: (adapter, processId, creator), as bindProcess stores it. */
  origins = new Map<string, [Hex, Hex, Hex]>();
  /** When set, getPartialRequestSnapshot throws (simulates a failed authenticated read). */
  snapshotError: string | null = null;
  /** When > 0, each batch containing a getParticipant call throws once and decrements. */
  participantReadFailures = 0;
  /**
   * When set, every historical (event log) read rejects with this message — a provider that
   * prunes or refuses old blocks — while authenticated current-state reads keep working.
   */
  historyError: string | null = null;

  constructor(args: {
    config: AppConfig;
    cid: Hex;
    view: CeremonyView;
    roster: Roster;
    releaseId: Hex;
    dealings: Map<number, Dealing>;
    memberPks: Point[];
  }) {
    this.chainId = BigInt(args.config.chainId);
    this.manager = args.config.manager;
    this.cid = args.cid;
    this.view = args.view;
    this.roster = args.roster;
    this.releaseId = args.releaseId;
    this.dealings = args.dealings;
    this.memberPks = args.memberPks;
  }

  async finalizedAnchor(): Promise<FinalizedAnchor> {
    return ANCHOR;
  }

  async authenticatedRead(calls: { functionName: string; args?: readonly unknown[] }[]) {
    const results = calls.map((c) => {
      switch (c.functionName) {
        case 'getRequestCount':
          return BigInt(this.requestIds.length);
        case 'getRequestIdsPage': {
          const offset = Number(c.args?.[1]);
          return this.requestIds.slice(offset, offset + Number(c.args?.[2]));
        }
        case 'getRequestOrigin': {
          const origin = this.origins.get(String(c.args?.[0]).toLowerCase());
          if (!origin) throw new Error('UnknownRequest()');
          return origin;
        }
        case 'getParticipantCompressed': {
          if (this.participantReadFailures > 0) {
            this.participantReadFailures -= 1;
            throw new Error('participant read failed');
          }
          const i = Number(c.args?.[1]);
          const p = this.participants[i - 1];
          if (!p) throw new Error(`no participant ${i}`);
          // Real ABI: (address auth, uint256 compressedKey, bool dealt).
          return [p.auth, compressPoint(p.key), ((BigInt(this.view.qualBitmap) >> BigInt(i - 1)) & 1n) === 1n];
        }
        case 'getBinding': {
          const key = `${String(c.args?.[0]).toLowerCase()}:${String(c.args?.[1]).toLowerCase()}`;
          const bound = this.bindings.get(key);
          if (!bound) throw new Error('UnknownBinding()'); // as the contract: no binding, no answer
          return bound;
        }
        case 'isAdapterAllowed':
          return this.allowedAdapters.has(String(c.args?.[1]).toLowerCase());
        case 'isCreatorAuthorized':
          return this.authorizedCreators.has(String(c.args?.[1]).toLowerCase());
        case 'participantIndexOf': {
          const auth = String(c.args?.[1]).toLowerCase();
          return this.participants.findIndex((p) => p.auth.toLowerCase() === auth) + 1;
        }
        default:
          throw new Error(`FakeChain: unhandled view ${c.functionName}`);
      }
    });
    // getBinding returns a tuple on chain
    const mapped = results.map((r) =>
      typeof r === 'object' && r !== null && 'requested' in r
        ? [(r as { cid: Hex }).cid, (r as { requestId: Hex }).requestId, (r as { requested: boolean }).requested]
        : r,
    );
    return { results: mapped, anchor: ANCHOR };
  }

  async getCeremony(cid?: Hex): Promise<CeremonyView> {
    // As the contract: the views revert for a committee this manager does not hold.
    if (cid !== undefined && cid.toLowerCase() !== this.cid.toLowerCase()) throw new Error('UnknownCeremony()');
    return this.view;
  }

  async getInvite(_cid: Hex, inviteId: number) {
    const inv = this.invites[inviteId];
    if (!inv) throw new Error('no such invite');
    return inv;
  }

  async getRoster() {
    return { roster: this.roster, view: this.view, anchor: ANCHOR };
  }

  async getPublicKey(): Promise<Point> {
    return { x: this.view.pkX, y: this.view.pkY };
  }

  async getMemberKey(_cid: Hex, index: number): Promise<Point> {
    return this.memberPks[index - 1] as Point;
  }

  /** The §8.7 gate as the contract evaluates it. */
  gateOpen(nowSeconds = Math.floor(Date.now() / 1000)): boolean {
    if (this.view.phase !== (Phase.Live as number)) return false;
    const now = BigInt(nowSeconds);
    if (this.policy.decryptionMode === (PhaseMode.Scheduled as number)) return now >= this.policy.decryptionOpenAt;
    return (
      this.policy.manualOpenedAt !== 0n ||
      (this.policy.manualDecryptionFallbackAt !== 0n && now >= this.policy.manualDecryptionFallbackAt)
    );
  }

  async getPolicy(): Promise<PhasePolicyView> {
    const now = BigInt(Math.floor(Date.now() / 1000));
    const scheduledRegistrationCloseDue =
      this.view.phase === (Phase.Registration as number) &&
      this.view.registrationDeadline !== 0n &&
      now >= this.view.registrationDeadline &&
      now <= this.view.registrationDeadline + this.policy.dealingDuration &&
      this.view.joinedCount >= this.view.threshold;
    return { ...this.policy, decryptionOpen: this.gateOpen(), scheduledRegistrationCloseDue };
  }

  async getAggregates(): Promise<Point[]> {
    return Array.from({ length: 16 }, (_, k) =>
      [...this.dealings.values()].map((d) => d.C[k] as Point).reduce((acc, p) => addPoints(acc, p)),
    );
  }

  async getRecoverySlice(_cid: Hex, memberIndex: number): Promise<RecoverySlice> {
    const slot = (j: number): Dealing | undefined =>
      ((this.view.qualBitmap >> (j - 1)) & 1) === 1 ? this.dealings.get(j) : undefined;
    return {
      qualBitmap: this.view.qualBitmap,
      compressedE: Array.from({ length: 16 }, (_, i) => {
        const d = slot(i + 1);
        return d ? compressPoint(d.E) : 0n;
      }),
      maskedShares: Array.from({ length: 16 }, (_, i) => slot(i + 1)?.masked[memberIndex - 1] ?? 0n),
    };
  }

  async getRequestMeta(requestId: Hex): Promise<RequestMeta> {
    const r = this.requests.get(requestId.toLowerCase());
    // As the contract: an unknown request reads as the mapping default (all zero).
    if (!r) return { ceremonyId: `0x${'00'.repeat(12)}` as Hex, fieldCount: 0, completedBitmap: 0, partialBitmap: 0 };
    return {
      ceremonyId: r.ceremonyId,
      fieldCount: r.fieldCount,
      completedBitmap: r.completedBitmap,
      partialBitmap: r.partialBitmap,
    };
  }

  async getPartialCommitment(requestId: Hex, index: number): Promise<PartialCommitment> {
    return (
      this.partials.get(`${requestId.toLowerCase()}:${index}`) ?? {
        accepted: false,
        dataHash: `0x${'00'.repeat(32)}` as Hex,
        publishedBlock: 0n,
      }
    );
  }

  async fetchPublishedVector(requestId: Hex, index: number, publishedBlock: bigint): Promise<Point[] | undefined> {
    if (this.historyError) throw new Error(this.historyError);
    if (publishedBlock === 0n) return undefined;
    return this.published.get(`${requestId.toLowerCase()}:${index}`);
  }

  async getPlaintexts(requestId: Hex) {
    return this.plaintexts.get(requestId.toLowerCase()) ?? { ready: false, values: [] };
  }

  async getCircuitReleaseId(): Promise<Hex> {
    return this.releaseId;
  }

  async getPartialRequestSnapshot(
    requestId: Hex,
    participantIndex: number,
    _opts?: { expectedCeremonyId?: Hex },
  ): Promise<PartialRequestSnapshot> {
    if (this.snapshotError) throw new Error(this.snapshotError);
    const req = this.requests.get(requestId.toLowerCase());
    if (!req || req.fieldCount < 1) throw new Error('snapshot: the request does not exist at the anchor');
    // The real client refuses to build a snapshot while the §8.7 gate is closed.
    if (!this.gateOpen()) throw new Error('snapshot: the decryption gate is closed (§8.7)');
    return {
      chainId: this.chainId,
      manager: this.manager,
      ceremonyId: this.cid,
      requestId,
      phase: this.view.phase,
      decryptionOpen: true,
      rosterHash: this.view.rosterHash,
      ctx: this.view.ctx,
      n: this.view.n,
      participantIndex,
      memberKey: this.memberPks[participantIndex - 1] as Point,
      fieldCount: req.fieldCount,
      cts: req.cts.map(([c1x, c1y, c2x, c2y]) => ({ c1: { x: c1x, y: c1y }, c2: { x: c2x, y: c2y } })),
      anchor: ANCHOR,
    };
  }

  async verifyRestoredIdentity(identity: {
    role: 'participant' | 'organizer';
    ceremonyId: Hex;
    authAddress: Hex;
    sharePublicKey?: Point;
  }) {
    const base = { phase: this.view.phase, rosterHash: this.view.rosterHash };
    if (identity.ceremonyId.toLowerCase() !== this.cid.toLowerCase()) {
      return { ok: false, mismatches: ['unknown ceremony'], ...base };
    }
    if (identity.role === 'organizer') {
      const ok = identity.authAddress.toLowerCase() === this.view.organizer.toLowerCase();
      return { ok, mismatches: ok ? [] : ['organizer address does not match'], ...base };
    }
    const idx = this.participants.findIndex((p) => p.auth.toLowerCase() === identity.authAddress.toLowerCase());
    if (idx < 0) return { ok: false, mismatches: ['not a registered participant'], ...base };
    const stored = this.participants[idx]?.key;
    if (
      identity.sharePublicKey &&
      stored &&
      (stored.x !== identity.sharePublicKey.x || stored.y !== identity.sharePublicKey.y)
    ) {
      return { ok: false, mismatches: ['share key does not match'], ...base };
    }
    return { ok: true, mismatches: [], participantIndex: idx + 1, ...base };
  }
}

export interface Fixture {
  config: AppConfig;
  cid: Hex;
  organizerMnemonic: string;
  memberMnemonics: string[];
  memberKeys: ParticipantKeys[];
  roster: Roster;
  rosterHash: Hex;
  ctx: Hex;
  chain: FakeChain;
  services: Services;
  /** Every action passed to services.submit, in order. */
  actions: Action[];
  /** ParticipantJoined events returned by services.joinedEvents (labels only). */
  events: ManagerEvent[];
  groupPk: Point;
  /**
   * Add a decryption request with real ciphertexts for `values`, bound (unless `bind: false`)
   * by ADAPTER for `processId` (default PROCESS_ID) and CREATOR; returns its request id.
   * `submitted: false` binds the vote without submitting its results (§9.3 'not-submitted').
   */
  addRequest(
    values: bigint[],
    opts?: { bind?: boolean; allow?: boolean; authorize?: boolean; processId?: Hex; submitted?: boolean },
  ): Hex;
}

export const ADAPTER = '0x00000000000000000000000000000000000000ad' as Hex;
export const CREATOR = '0x00000000000000000000000000000000000000c0' as Hex;
export const PROCESS_ID = `0x${'cd'.repeat(31)}` as Hex;

/** Build a full consistent ceremony: n members, all dealings accepted, Live, gate open. */
export function makeFixture(
  opts: {
    t?: number;
    n?: number;
    phase?: Phase;
    policy?: Partial<FakePolicy>;
    /** Derivation account index of every member's and the organizer's keys (protocol §5.2). */
    accountIndex?: number;
    /** Another manager (a second deployment on the same chain). */
    manager?: Hex;
  } = {},
): Fixture {
  const t = opts.t ?? 2;
  const n = opts.n ?? 3;
  const accountIndex = opts.accountIndex ?? 0;
  const MANAGER = opts.manager ?? DEFAULT_MANAGER;
  const config = makeConfig(MANAGER);
  const chainId = BigInt(config.chainId);
  const organizerMnemonic = generateMnemonic();
  const org = organizerAuthKey(rootFromMnemonic(organizerMnemonic), { chainId, manager: MANAGER, accountIndex });
  const cid = sdkCeremonyId(chainId, MANAGER, org.address, 1n);
  const memberMnemonics = Array.from({ length: n }, () => generateMnemonic());
  const memberKeys = memberMnemonics.map((m) => participantKeys(m, config, cid, accountIndex));
  const roster: Roster = {
    t,
    n,
    authAddresses: memberKeys.map((k) => k.auth.address),
    memberKeys: memberKeys.map((k) => k.share.publicKey),
  };
  const rh = rosterHash(chainId, MANAGER, cid, roster);
  // The release this build pins (a development setup), as a real deployment would report it.
  const releaseId = (KNOWN_CIRCUIT_RELEASES[0] as { id: Hex }).id;
  const ctx = dealContext(chainId, MANAGER, cid, rh, releaseId);

  const dealings = new Map<number, Dealing>();
  for (let j = 1; j <= n; j++) {
    const root = rootFromMnemonic(memberMnemonics[j - 1] as string);
    const dctx = {
      chainId,
      manager: MANAGER,
      ceremonyId: cid,
      accountIndex,
      rosterHash: rh,
      dealerIndex: j,
      t,
      circuitReleaseId: releaseId,
    };
    const built = buildDealing({
      ctx,
      dealerIndex: j,
      t,
      n,
      memberKeys: roster.memberKeys,
      coefficients: dealerCoefficients(root, dctx),
      ephemeral: dealerEphemeral(root, dctx),
    });
    dealings.set(j, { C: built.C, E: built.E, masked: built.masked });
  }
  const sum = (points: Point[]) => points.reduce((acc, p) => addPoints(acc, p));
  const groupPk = sum([...dealings.values()].map((d) => d.C[0] as Point));
  const memberPks = Array.from({ length: n }, (_, i) =>
    sum([...dealings.values()].map((d) => hornerEval(d.C, i + 1))),
  );

  const phase = opts.phase ?? Phase.Live;
  const view: CeremonyView = {
    phase,
    organizer: org.address,
    threshold: t,
    n,
    registrationDeadline: BigInt(Math.floor(Date.now() / 1000) + 3600),
    dealingDeadline: BigInt(Math.floor(Date.now() / 1000) + 7200),
    joinedCount: n,
    dealtCount: n,
    rosterHash: rh,
    ctx,
    inviteCount: n,
    consumedInvites: (1n << BigInt(n)) - 1n,
    qualBitmap: phase >= Phase.Live ? (1 << n) - 1 : 0,
    pkX: groupPk.x,
    pkY: groupPk.y,
  };

  const chain = new FakeChain({ config, cid, view, roster, releaseId, dealings, memberPks });
  if (opts.policy) chain.policy = { ...chain.policy, ...opts.policy };
  chain.participants = memberKeys.map((k, i) => ({ auth: k.auth.address, key: k.share.publicKey, inviteId: i }));
  chain.invites = memberKeys.map((k) => ({ key: k.auth.address, consumed: true }));

  const actions: Action[] = [];
  const events: ManagerEvent[] = memberKeys.map((k, i) => ({
    eventName: 'ParticipantJoined',
    args: { cid, index: i + 1, auth: k.auth.address, inviteId: i },
  }));
  const services: Services = {
    config,
    client: chain,
    submit: async (action) => {
      actions.push(action);
      return `0x${'01'.repeat(32)}` as Hex;
    },
    waitTx: async () => {},
    txStatus: async () => ({ status: 'confirmed' }),
    trackCeremony: async () => true,
    prove: async (circuit, witnessInput) => ({
      proof: ZERO_PROOF,
      publicSignals: signalsFromWitness(circuit, witnessInput),
    }),
    joinedEvents: async () => ({ events, complete: true }),
  };

  const addRequest = (
    values: bigint[],
    o: { bind?: boolean; allow?: boolean; authorize?: boolean; processId?: Hex; submitted?: boolean } = {},
  ): Hex => {
    const processId = o.processId ?? PROCESS_ID;
    const requestId = sdkRequestId(chainId, MANAGER, cid, ADAPTER, processId);
    chain.requestIds.push(requestId.toLowerCase());
    if (o.submitted !== false) {
      const cts = values.map((v, k) => {
        const r = 1000n + BigInt(k);
        const c1 = mulBase(r);
        const c2 = addPoints(mulBase(v), mulPoint(groupPk, r));
        return [c1.x, c1.y, c2.x, c2.y] as [bigint, bigint, bigint, bigint];
      });
      chain.requests.set(requestId.toLowerCase(), {
        ceremonyId: cid,
        fieldCount: values.length,
        completedBitmap: 0,
        partialBitmap: 0,
        cts,
      });
    }
    if (o.bind !== false) {
      chain.bindings.set(`${ADAPTER.toLowerCase()}:${processId.toLowerCase()}`, {
        cid,
        requestId,
        requested: o.submitted !== false,
      });
      chain.origins.set(requestId.toLowerCase(), [ADAPTER, processId, CREATOR]);
    }
    if (o.allow !== false) chain.allowedAdapters.add(ADAPTER.toLowerCase());
    if (o.authorize !== false) chain.authorizedCreators.add(CREATOR.toLowerCase());
    return requestId;
  };

  return {
    config,
    cid,
    organizerMnemonic,
    memberMnemonics,
    memberKeys,
    roster,
    rosterHash: rh,
    ctx,
    chain,
    services,
    actions,
    events,
    groupPk,
    addRequest,
  };
}
