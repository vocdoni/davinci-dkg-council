/**
 * In-memory chain + services fakes. All protocol values (roster hash, deal
 * context, dealings, member keys, ciphertexts) are built with the real SDK so
 * the flows' checks run for real; only transport and proving are faked.
 */

import {
  addPoints,
  buildDealing,
  dealContext,
  dealerCoefficients,
  dealerEphemeral,
  generateMnemonic,
  hornerEval,
  mulBase,
  mulPoint,
  organizerAuthKey,
  Phase,
  rootFromMnemonic,
  rosterHash,
  ceremonyId as sdkCeremonyId,
  type Action,
  type CeremonyView,
  type Dealing,
  type DealWitnessInput,
  type FinalizedAnchor,
  type Groth16Proof,
  type Hex,
  type PartialRequestSnapshot,
  type PartialWitnessInput,
  type Point,
  type RequestView,
  type Roster,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { AppConfig } from '../../src/config';
import { participantKeys, type ParticipantKeys } from '../../src/flows/participant';
import type { ChainReader, ManagerEvent } from '../../src/lib/chain';
import type { Services } from '../../src/services';

export const MANAGER = '0x00000000000000000000000000000000000000aa' as Hex;

export function makeConfig(): AppConfig {
  return {
    chainId: 31337,
    manager: MANAGER,
    rpcUrls: ['http://127.0.0.1:8545'],
    relayerUrl: null,
    artifactsBaseUrl: null,
    deploymentBlock: 0,
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
  requests = new Map<string, RequestView>();
  plaintexts = new Map<string, { ready: boolean; values: bigint[] }>();
  allowedAdapters = new Set<string>();
  bindings = new Map<string, { cid: Hex; requestId: Hex; requested: boolean }>();
  /** When set, getPartialRequestSnapshot throws (simulates a failed authenticated read). */
  snapshotError: string | null = null;
  /** When > 0, each batch containing a getParticipant call throws once and decrements. */
  participantReadFailures = 0;

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
        case 'getRequestIds':
          return [...this.requests.keys()];
        case 'getParticipant': {
          if (this.participantReadFailures > 0) {
            this.participantReadFailures -= 1;
            throw new Error('participant read failed');
          }
          const i = Number(c.args?.[1]);
          const p = this.participants[i - 1];
          if (!p) throw new Error(`no participant ${i}`);
          // Real ABI: (address auth, uint256 pkX, uint256 pkY, bool dealt).
          return [p.auth, p.key.x, p.key.y, ((BigInt(this.view.qualBitmap) >> BigInt(i - 1)) & 1n) === 1n];
        }
        case 'getBinding': {
          const key = `${String(c.args?.[0]).toLowerCase()}:${String(c.args?.[1]).toLowerCase()}`;
          return this.bindings.get(key) ?? { cid: `0x${'00'.repeat(32)}`, requestId: `0x${'00'.repeat(32)}`, requested: false };
        }
        case 'isAdapterAllowed':
          return this.allowedAdapters.has(String(c.args?.[1]).toLowerCase());
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

  async getCeremony(): Promise<CeremonyView> {
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

  async getQualDealings(_cid: Hex, qual: number[]) {
    const out = new Map<number, Dealing>();
    for (const j of qual) {
      const d = this.dealings.get(j);
      if (d) out.set(j, d);
    }
    return out;
  }

  async getPublicKey(): Promise<Point> {
    return { x: this.view.pkX, y: this.view.pkY };
  }

  async getMemberKey(_cid: Hex, index: number): Promise<Point> {
    return this.memberPks[index - 1] as Point;
  }

  async getRequest(requestId: Hex): Promise<RequestView> {
    const r = this.requests.get(requestId.toLowerCase());
    if (!r) throw new Error('no such request');
    return r;
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
    const req = await this.getRequest(requestId);
    return {
      chainId: this.chainId,
      manager: this.manager,
      ceremonyId: this.cid,
      requestId,
      phase: this.view.phase,
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
  /** Discovery events returned by services.getEvents. */
  events: ManagerEvent[];
  groupPk: Point;
  /** Add a decryption request with real ciphertexts for `values`. */
  addRequest(requestId: Hex, values: bigint[], opts?: { bind?: boolean; allow?: boolean }): void;
}

export const ADAPTER = '0x00000000000000000000000000000000000000ad' as Hex;
export const PROCESS_ID = `0x${'cd'.repeat(32)}` as Hex;

/** Build a full consistent ceremony: n members, all dealings accepted, Live. */
export function makeFixture(opts: { t?: number; n?: number; phase?: Phase } = {}): Fixture {
  const t = opts.t ?? 2;
  const n = opts.n ?? 3;
  const config = makeConfig();
  const chainId = BigInt(config.chainId);
  const organizerMnemonic = generateMnemonic();
  const org = organizerAuthKey(rootFromMnemonic(organizerMnemonic), { chainId, manager: MANAGER });
  const cid = sdkCeremonyId(chainId, MANAGER, org.address, 1n);
  const memberMnemonics = Array.from({ length: n }, () => generateMnemonic());
  const memberKeys = memberMnemonics.map((m) => participantKeys(m, config, cid));
  const roster: Roster = {
    t,
    n,
    authAddresses: memberKeys.map((k) => k.auth.address),
    memberKeys: memberKeys.map((k) => k.share.publicKey),
  };
  const rh = rosterHash(chainId, MANAGER, cid, roster);
  const releaseId = `0x${'11'.repeat(32)}` as Hex;
  const ctx = dealContext(chainId, MANAGER, cid, rh, releaseId);

  const dealings = new Map<number, Dealing>();
  for (let j = 1; j <= n; j++) {
    const root = rootFromMnemonic(memberMnemonics[j - 1] as string);
    const dctx = {
      chainId,
      manager: MANAGER,
      ceremonyId: cid,
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
    prove: async (circuit, witnessInput) => ({
      proof: ZERO_PROOF,
      publicSignals: signalsFromWitness(circuit, witnessInput),
    }),
    getEvents: async () => events,
  };

  const addRequest = (requestId: Hex, values: bigint[], o: { bind?: boolean; allow?: boolean } = {}) => {
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
    if (o.bind !== false) {
      chain.bindings.set(`${ADAPTER.toLowerCase()}:${PROCESS_ID.toLowerCase()}`, { cid, requestId, requested: true });
      events.push({ eventName: 'ProcessBound', args: { cid, adapter: ADAPTER, processId: PROCESS_ID, requestId } });
    }
    if (o.allow !== false) chain.allowedAdapters.add(ADAPTER.toLowerCase());
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
