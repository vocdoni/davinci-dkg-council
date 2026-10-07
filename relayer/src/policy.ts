/**
 * Sponsorship policy: which actions the hot key pays for, and how many.
 *
 * - Slots: the one-shot protocol state an action consumes (enforced by the sender from
 *   acceptance until settlement, see sender.ts).
 * - Quotas: per-ceremony / per-request counts of sponsored transactions, derived from the
 *   protocol bounds (one create, close, finalize, abort and openDecryption, ≤ 64 invites,
 *   ≤ 16 joins and deals, ≤ n partials and ≤ 2·n re-publications per request, combines bounded
 *   by the request's fields), plus a configurable number of grants (allowAdapter +
 *   authorizeCreator). Charged only after a successful simulation, undone if the broadcast
 *   fails, persisted across restarts.
 * - Re-publication (protocol §10.4): publishPartialData is sponsored only for an incomplete
 *   request whose member vector this relayer cannot source itself (no cached copy, no log at the
 *   stored publication block), with a doubling per-(request, member) backoff, so a same-data
 *   refresh never becomes a way around the quotas.
 * - Admission: createCeremony may require an allow-listed organizer or a bearer API token;
 *   when either is configured ("restricted" mode) every other action is sponsored only for
 *   ceremonies created through this relayer or organized by an allow-listed address. A
 *   per-organizer rolling-24 h cap bounds sponsored ceremonies in every mode.
 *
 * Everything sponsored, the combine worker and the scheduler included, also passes the
 * sender's global budget. The relayer rebuilds the points the wire omits (rosterKeys, C1, C2)
 * from state before simulating (chainstate.ts), and caches every D vector it relays
 * (partials.ts). A relayed decryption action (openDecryption, submitPartial, re-publication,
 * combine) marks its ceremony for the combine worker's state enumeration (`state.tracked`).
 *
 * Bookkeeping is garbage-collected (`gc`, every few minutes): expired organizer records and
 * re-publication backoffs, zero counters, and the counters of ceremonies and requests that can
 * take no more sponsored action of their kind, judged at the finalized block — every counter of
 * an aborted ceremony, the phase counters (create, invites, close, join, deal, finalize, abort)
 * of a live one, every counter of a complete request, and ids unknown there for a day.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ceremonyId as computeCeremonyId,
  encodeAction,
  MAX_FIELDS,
  MAX_INVITES,
  MAX_N,
  partialDataHash,
  Phase,
  type Action,
  type Hex,
  type Point,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { PublicClient } from 'viem';
import { ChainState } from './chainstate.js';
import { isTransientReadError } from './broadcast.js';
import { extractRevertData, RelayError, shortMessage } from './errors.js';
import { silentLogger, type Logger } from './log.js';
import { ChainPartialSource, PartialVectorStore, type VectorFetcher } from './partials.js';
import { RateLimiter } from './ratelimit.js';
import type { SendOptions, TxSender } from './sender.js';
import { trackCeremony, type StateStore } from './state.js';

export interface PolicyConfig {
  /** Organizers whose ceremonies are sponsored (lowercase addresses). */
  organizerAllowlist: string[];
  /** Bearer tokens that admit a createCeremony. */
  apiTokens: string[];
  /** Sponsored ceremonies per organizer per rolling 24 h; 0 = unlimited. */
  organizerDailyCeremonies: number;
  /** Sponsored allowAdapter + authorizeCreator per ceremony. */
  maxGrantsPerCeremony: number;
  /** Sponsored actions per ceremony (or request) per minute, charged after simulation. */
  ceremonyRatePerMinute: number;
}

export interface SponsorContext {
  source: 'http' | 'combiner' | 'scheduler';
  /** Bearer token from the Authorization header. */
  token?: string;
}

interface Quota {
  key: string;
  amount: number;
  limit: number;
}

/** A D vector to cache once its action is sent (keyed by its partial-data hash). */
interface CachedVector {
  requestId: Hex;
  index: number;
  dataHash: Hex;
  D: Point[];
}

interface Plan {
  cid: Hex;
  slots: string[];
  quotas: Quota[];
  rateKey: string;
  /** createCeremony only. */
  create?: { organizer: string; admit: boolean };
  /** Record the ceremony for the scheduler once sent. */
  watch: boolean;
  /** Record the ceremony for the combine worker's state enumeration once sent. */
  track?: boolean;
  /** publishPartialData: the `requestId:index` backoff key. */
  republish?: string;
  vectors?: CachedVector[];
}

const DAY_MS = 24 * 3_600_000;
/** Base of the doubling per-(request, member) re-publication backoff. */
export const REPUBLISH_BACKOFF_MS = 10 * 60_000;
/** Re-publication records older than this are forgotten. */
const REPUBLISH_MEMORY_MS = 30 * DAY_MS;
/** Ceremonies the scheduler watches at most (oldest dropped first). */
export const MAX_WATCHED = 10_000;
const ZERO_CID = '0x000000000000000000000000' as Hex;
/** Quota names that no longer apply once a ceremony is Live. */
const PHASE_QUOTAS = new Set(['create', 'invites', 'close', 'join', 'deal', 'finalize', 'abort']);
/** An id unknown at the finalized block this long (a reverted create, a request never bound) is forgotten. */
const UNKNOWN_FORGET_MS = DAY_MS;
/** Chain reads per garbage-collection pass. */
const GC_READS = 32;
const digest = (s: string): Buffer => createHash('sha256').update(s).digest();
const lower = <T extends string>(v: T): T => v.toLowerCase() as T;

export class SponsorPolicy {
  /** State reads and calldata rebuilds (shared with the sponsor). */
  readonly chain: ChainState;
  /** Every D vector relayed or observed (protocol §10.4). */
  readonly partials: PartialVectorStore;
  private readonly source: VectorFetcher;
  private readonly allowlist: Set<string>;
  private readonly tokenDigests: Buffer[];
  private readonly limiter: RateLimiter;
  /** Garbage collection: rotation cursor, first time an id was unknown at the finalized block. */
  private gcCursor = 0;
  private readonly unknownSince = new Map<string, number>();
  private gcTimer: NodeJS.Timeout | undefined;

  constructor(
    private readonly opts: {
      client: PublicClient;
      chainId: bigint;
      manager: Hex;
      store: StateStore;
      config: PolicyConfig;
      chain?: ChainState;
      partials?: PartialVectorStore;
      source?: VectorFetcher;
      now?: () => number;
    },
  ) {
    this.chain = opts.chain ?? new ChainState(opts.client, opts.manager);
    this.partials = opts.partials ?? new PartialVectorStore(opts.chainId, opts.manager);
    this.source = opts.source ?? new ChainPartialSource(opts.client, this.chain);
    this.allowlist = new Set(opts.config.organizerAllowlist.map((a) => a.toLowerCase()));
    this.tokenDigests = opts.config.apiTokens.map(digest);
    this.limiter = new RateLimiter(60_000, opts.now);
  }

  private get now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** Restricted mode: an allow-list or API tokens are configured. */
  get restricted(): boolean {
    return this.allowlist.size > 0 || this.tokenDigests.length > 0;
  }

  /** A valid bearer API token (COUNCIL_API_TOKENS). */
  tokenValid(token: string | undefined): boolean {
    if (token === undefined) return false;
    const d = digest(token);
    return this.tokenDigests.some((t) => timingSafeEqual(t, d));
  }

  /**
   * A view read whose revert is an answer (UnknownCeremony, UnknownRequest, …: simulation will
   * refuse the action) and whose transport failure is not: retry later rather than guess. A bare
   * -32603, which viem reports as "reverted", is a transport failure too.
   */
  private async read<T>(fn: () => Promise<T>, what: string): Promise<T | undefined> {
    try {
      return await fn();
    } catch (err) {
      if (err instanceof RelayError) throw err;
      if (extractRevertData(err) !== undefined) return undefined;
      throw new RelayError('INTERNAL', `chain read ${what} failed: ${shortMessage(err)}`);
    }
  }

  /**
   * Restricted mode: the ceremony was admitted here or is organized by an allow-listed address.
   * NOT_SPONSORED is a verified denial (the chain answered); an RPC failure is INTERNAL and
   * retryable, never a denial.
   */
  async ensureSponsored(cid: Hex): Promise<void> {
    if (!this.restricted) return;
    const id = lower(cid);
    if (this.opts.store.state.admitted.includes(id)) return;
    let organizer: string | undefined;
    try {
      organizer = lower((await this.chain.ceremony(id)).organizer);
    } catch (err) {
      if (extractRevertData(err) === undefined) {
        throw new RelayError('INTERNAL', `could not verify sponsorship of ${id}: ${shortMessage(err)}`);
      }
      // UnknownCeremony: not ours to sponsor.
    }
    if (organizer !== undefined && this.allowlist.has(organizer)) return;
    throw new RelayError('NOT_SPONSORED', `ceremony ${id} is not sponsored by this relayer`);
  }

  /** n of a closed ceremony, MAX_N before close or when the ceremony is unknown. */
  private async committeeSize(cid: Hex): Promise<number> {
    const view = await this.read(() => this.chain.ceremony(cid), 'getCeremony');
    return view && view.n > 0 ? view.n : MAX_N;
  }

  /** Ceremony and field count of a request; the zero id and 0 when it is not submitted. */
  private async shape(requestId: Hex): Promise<{ ceremonyId: Hex; fieldCount: number }> {
    return (
      (await this.read(() => this.chain.requestShape(requestId), 'getRequestMeta')) ?? { ceremonyId: ZERO_CID, fieldCount: 0 }
    );
  }

  private hash(cid: Hex, requestId: Hex, index: number, fieldCount: number, D: Point[]): Hex | undefined {
    if (fieldCount < 1 || fieldCount > MAX_FIELDS || D.length !== MAX_FIELDS) return undefined;
    return partialDataHash({
      chainId: this.opts.chainId,
      manager: this.opts.manager,
      ceremonyId: cid,
      requestId,
      participantIndex: index,
      fieldCount,
      D,
    });
  }

  /** Slots, quotas and admission of one action (before simulation; cheap reads only). */
  async plan(action: Action, ctx: SponsorContext): Promise<Plan> {
    const grants = this.opts.config.maxGrantsPerCeremony;
    switch (action.kind) {
      case 'createCeremony': {
        const m = action.message;
        const organizer = m.organizer.toLowerCase();
        const cid = lower(computeCeremonyId(this.opts.chainId, this.opts.manager, m.organizer, m.nonce));
        if (this.restricted && !this.allowlist.has(organizer) && !this.tokenValid(ctx.token)) {
          throw new RelayError('UNAUTHORIZED', 'creating a ceremony needs an allow-listed organizer or an API token');
        }
        return {
          cid,
          slots: [`cer:${cid}:create`],
          quotas: [
            { key: `cer:${cid}:create`, amount: 1, limit: 1 },
            { key: `cer:${cid}:invites`, amount: m.inviteKeys.length, limit: MAX_INVITES },
          ],
          rateKey: `ceremony:${cid}`,
          create: { organizer, admit: this.restricted },
          watch: true,
        };
      }
      case 'addInvites':
      case 'closeRegistration':
      case 'openDecryption':
      case 'allowAdapter':
      case 'authorizeCreator':
      case 'join':
      case 'deal': {
        const cid = lower(action.message.ceremonyId);
        await this.ensureSponsored(cid);
        const base = { cid, rateKey: `ceremony:${cid}`, watch: true };
        switch (action.kind) {
          case 'addInvites':
            return {
              ...base,
              slots: [`cer:${cid}:invites-from:${action.message.firstInviteId}`],
              quotas: [{ key: `cer:${cid}:invites`, amount: action.message.inviteKeys.length, limit: MAX_INVITES }],
            };
          case 'closeRegistration':
            // One close per ceremony, whichever path (manual or time-based) takes it.
            return { ...base, slots: [`cer:${cid}:phase`], quotas: [{ key: `cer:${cid}:close`, amount: 1, limit: 1 }] };
          case 'openDecryption':
            return {
              ...base,
              slots: [`cer:${cid}:open`],
              quotas: [{ key: `cer:${cid}:open`, amount: 1, limit: 1 }],
              track: ctx.source === 'http',
            };
          case 'allowAdapter':
            return {
              ...base,
              slots: [`cer:${cid}:adapter:${action.message.adapter.toLowerCase()}`],
              quotas: [{ key: `cer:${cid}:grant`, amount: 1, limit: grants }],
            };
          case 'authorizeCreator':
            return {
              ...base,
              slots: [`cer:${cid}:creator:${action.message.creator.toLowerCase()}`],
              quotas: [{ key: `cer:${cid}:grant`, amount: 1, limit: grants }],
            };
          case 'join':
            return {
              ...base,
              // Every piece of one-shot join state: the invite, the participant, the key.
              slots: [
                `cer:${cid}:invite:${action.message.inviteId}`,
                `cer:${cid}:participant:${action.message.participant.toLowerCase()}`,
                `cer:${cid}:key:${action.message.pkX}:${action.message.pkY}`,
              ],
              quotas: [{ key: `cer:${cid}:join`, amount: 1, limit: MAX_N }],
            };
          default:
            return {
              ...base,
              slots: [`cer:${cid}:deal:${action.message.dealerIndex}`],
              quotas: [{ key: `cer:${cid}:deal`, amount: 1, limit: MAX_N }],
            };
        }
      }
      case 'closeRegistrationScheduled':
      case 'finalize':
      case 'abort': {
        const cid = lower(action.ceremonyId);
        await this.ensureSponsored(cid);
        const quota = action.kind === 'closeRegistrationScheduled' ? 'close' : action.kind;
        return {
          cid,
          slots: [`cer:${cid}:phase`],
          quotas: [{ key: `cer:${cid}:${quota}`, amount: 1, limit: 1 }],
          rateKey: ctx.source === 'scheduler' ? '' : `ceremony:${cid}`,
          watch: true,
        };
      }
      case 'submitPartial': {
        const m = action.message;
        const cid = lower(m.ceremonyId);
        const rid = lower(m.requestId);
        await this.ensureSponsored(cid);
        const n = await this.committeeSize(cid);
        const { fieldCount } = await this.shape(rid);
        const dataHash = this.hash(cid, rid, m.participantIndex, fieldCount, action.payload.D);
        return {
          cid,
          slots: [`req:${rid}:partial:${m.participantIndex}`],
          quotas: [{ key: `req:${rid}:partial`, amount: 1, limit: n }],
          rateKey: `ceremony:${cid}`,
          watch: false,
          track: ctx.source === 'http',
          vectors: dataHash ? [{ requestId: rid, index: m.participantIndex, dataHash, D: action.payload.D }] : undefined,
        };
      }
      case 'combine': {
        const rid = lower(action.requestId);
        const { ceremonyId: cid, fieldCount } = await this.shape(rid);
        if (fieldCount > 0) await this.ensureSponsored(cid);
        else if (this.restricted) throw new RelayError('NOT_SPONSORED', `request ${rid} is not sponsored by this relayer`);
        const vectors: CachedVector[] = [];
        action.memberSet.forEach((index, i) => {
          const D = action.partialVectors[i];
          const dataHash = D && this.hash(cid, rid, index, fieldCount, D);
          if (D && dataHash) vectors.push({ requestId: rid, index, dataHash, D });
        });
        return {
          cid,
          slots: action.fieldIndexes.map((k) => `req:${rid}:field:${k}`),
          // fieldCount fields, plus one retry each (a lost race or a reorg).
          quotas: [{ key: `req:${rid}:combine-fields`, amount: action.fieldIndexes.length, limit: 2 * fieldCount }],
          rateKey: ctx.source === 'combiner' ? '' : `request:${rid}`,
          watch: false,
          track: ctx.source === 'http',
          vectors,
        };
      }
      case 'publishPartialData':
        return this.planRepublication(action);
    }
  }

  /**
   * publishPartialData (protocol §10.4): sponsored only for an incomplete request whose member
   * vector this relayer cannot source itself. A vector it can source (from its cache, or from
   * the log at the stored publication block — which it then caches) needs no transaction.
   */
  private async planRepublication(action: Extract<Action, { kind: 'publishPartialData' }>): Promise<Plan> {
    const rid = lower(action.requestId);
    const index = action.participantIndex;
    const meta = await this.read(() => this.chain.requestMeta(rid), 'getRequestMeta');
    const cid = meta?.ceremonyId ?? ZERO_CID;
    const base = {
      cid,
      slots: [`req:${rid}:publish:${index}`],
      rateKey: `request:${rid}`,
      watch: false,
      track: true,
      republish: `${rid}:${index}`,
    };
    if (!meta || meta.fieldCount === 0) {
      if (this.restricted) throw new RelayError('NOT_SPONSORED', `request ${rid} is not sponsored by this relayer`);
      return { ...base, quotas: [] }; // simulation refuses it (UnknownRequest)
    }
    await this.ensureSponsored(cid);
    const full = (1 << meta.fieldCount) - 1;
    if ((meta.completedBitmap & full) === full) {
      throw new RelayError('NOT_SPONSORED', `request ${rid} is complete: re-publishing its partial data is not sponsored`);
    }
    const n = await this.committeeSize(cid);
    const quotas = [{ key: `req:${rid}:publish`, amount: 1, limit: 2 * n }];
    const c = await this.read(() => this.chain.partialCommitment(rid, index), 'getPartialCommitment');
    if (!c?.accepted) return { ...base, quotas }; // simulation refuses it (MissingPartial)
    // Only an authenticated copy counts: a corrupted cache entry must not block the recovery path.
    const authentic = (D: Point[] | undefined): D is Point[] =>
      D !== undefined && this.hash(cid, rid, index, meta.fieldCount, D)?.toLowerCase() === c.dataHash.toLowerCase();
    if (authentic(this.partials.vector(rid, index, c.dataHash))) {
      throw new RelayError('NOT_SPONSORED', `this relayer holds member ${index}'s partial data for ${rid}: nothing to re-publish`);
    }
    const logged = await this.source.fetch(rid, index, c.publishedBlock);
    if (authentic(logged.vector)) {
      this.partials.put(rid, index, c.dataHash, logged.vector);
      throw new RelayError('NOT_SPONSORED', `member ${index}'s partial data for ${rid} is still published: nothing to re-publish`);
    }
    // A refusal that clears by itself (rate limit, timeout, a backend behind the head) says
    // nothing about the data: retry, do not pay. A pruned block or a refused method does.
    if (logged.error !== undefined && isTransientReadError(logged.error)) {
      const why = shortMessage(logged.error);
      throw new RelayError('INTERNAL', `could not read the publication block of member ${index} for ${rid}: ${why}; retry`);
    }
    return { ...base, quotas, vectors: [{ requestId: rid, index, dataHash: c.dataHash, D: action.D }] };
  }

  /** The charge applied after a successful simulation; returns its undo. */
  private reserve(plan: Plan, ctx: SponsorContext): () => void {
    const s = this.opts.store.state;
    for (const q of plan.quotas) {
      const used = s.quotas[q.key] ?? 0;
      if (used + q.amount > q.limit) {
        throw new RelayError('QUOTA_EXCEEDED', `sponsorship quota ${q.key} is used up (${used}/${q.limit})`);
      }
    }
    let creates: number[] | undefined;
    if (plan.create) {
      const cap = this.opts.config.organizerDailyCeremonies;
      creates = (s.organizerCreates[plan.create.organizer] ?? []).filter((t) => t > this.now - DAY_MS);
      if (cap > 0 && creates.length >= cap) {
        throw new RelayError('QUOTA_EXCEEDED', `organizer ${plan.create.organizer} reached ${cap} sponsored ceremonies in 24 h`);
      }
    }
    const previous = plan.republish !== undefined ? s.republished[plan.republish] : undefined;
    if (previous) {
      const wait = REPUBLISH_BACKOFF_MS * 2 ** (previous.count - 1);
      if (this.now - previous.at < wait) {
        throw new RelayError(
          'RATE_LIMITED',
          `re-publication of ${plan.republish} was sponsored ${Math.round((this.now - previous.at) / 60_000)} min ago; ` +
            `the next one in ${Math.ceil((previous.at + wait - this.now) / 60_000)} min`,
        );
      }
    }
    const rate = this.opts.config.ceremonyRatePerMinute;
    if (plan.rateKey && !this.limiter.take(plan.rateKey, rate)) {
      throw new RelayError('RATE_LIMITED', `too many sponsored actions for ${plan.rateKey}`);
    }
    for (const q of plan.quotas) s.quotas[q.key] = (s.quotas[q.key] ?? 0) + q.amount;
    if (plan.create && creates) {
      s.organizerCreates[plan.create.organizer] = [...creates, this.now];
      if (plan.create.admit && !s.admitted.includes(plan.cid)) s.admitted.push(plan.cid);
    }
    if (plan.republish !== undefined) {
      for (const [key, r] of Object.entries(s.republished)) if (r.at < this.now - REPUBLISH_MEMORY_MS) delete s.republished[key];
      s.republished[plan.republish] = { count: (previous?.count ?? 0) + 1, at: this.now };
    }
    const watched = plan.watch && ctx.source === 'http' && plan.cid !== ZERO_CID && !s.watched.includes(plan.cid);
    if (watched) {
      s.watched.push(plan.cid);
      if (s.watched.length > MAX_WATCHED) s.watched.splice(0, s.watched.length - MAX_WATCHED);
    }
    return () => {
      // A rollback leaves no zero entries behind.
      for (const q of plan.quotas) {
        const left = (s.quotas[q.key] ?? q.amount) - q.amount;
        if (left > 0) s.quotas[q.key] = left;
        else delete s.quotas[q.key];
      }
      if (plan.create && creates) {
        if (creates.length > 0) s.organizerCreates[plan.create.organizer] = creates;
        else delete s.organizerCreates[plan.create.organizer];
        if (plan.create.admit) s.admitted = s.admitted.filter((c) => c !== plan.cid);
      }
      if (plan.republish !== undefined) {
        if (previous) s.republished[plan.republish] = previous;
        else delete s.republished[plan.republish];
      }
      if (watched) s.watched = s.watched.filter((c) => c !== plan.cid);
      if (plan.rateKey) this.limiter.refund(plan.rateKey);
      this.opts.store.flushSoon();
    };
  }

  /** Admission checks now; slots and the post-simulation charge for the sender. */
  async sendOptions(action: Action, ctx: SponsorContext): Promise<SendOptions & { plan: Plan }> {
    const plan = await this.plan(action, ctx);
    return { plan, slots: plan.slots, reserve: () => this.reserve(plan, ctx) };
  }

  /**
   * After a successful send: keep every D vector the action carried (protocol §10.4 path 1), and
   * have the combine worker enumerate the ceremony's requests from state.
   */
  sent(plan: Plan): void {
    for (const v of plan.vectors ?? []) this.partials.put(v.requestId, v.index, v.dataHash, v.D);
    if (plan.track && plan.cid !== ZERO_CID && trackCeremony(this.opts.store.state, plan.cid)) this.opts.store.flushSoon();
  }

  /**
   * One garbage-collection pass over the sponsorship bookkeeping (see the module comment): at
   * most GC_READS finalized-block reads, in rotation over the ceremonies and requests that have
   * counters (and the admitted and tracked ceremonies). A read that fails ends the pass; nothing
   * is pruned on a guess. Returns whether anything changed (the caller persists).
   */
  async gc(maxReads = GC_READS): Promise<boolean> {
    const s = this.opts.store.state;
    const now = this.now;
    let changed = false;
    for (const [org, times] of Object.entries(s.organizerCreates)) {
      const recent = times.filter((t) => t > now - DAY_MS);
      if (recent.length === times.length) continue;
      if (recent.length > 0) s.organizerCreates[org] = recent;
      else delete s.organizerCreates[org];
      changed = true;
    }
    for (const [key, used] of Object.entries(s.quotas)) {
      if (used > 0) continue;
      delete s.quotas[key];
      changed = true;
    }
    for (const [key, r] of Object.entries(s.republished)) {
      if (r.at >= now - REPUBLISH_MEMORY_MS) continue;
      delete s.republished[key];
      changed = true;
    }

    // Subjects: `cer:<cid>` and `req:<rid>` with counters, admitted and tracked ceremonies.
    const subjects = new Set<string>();
    for (const key of Object.keys(s.quotas)) {
      const [kind, id] = key.split(':');
      if ((kind === 'cer' || kind === 'req') && id) subjects.add(`${kind}:${id}`);
    }
    for (const cid of [...s.admitted, ...s.tracked]) subjects.add(`cer:${cid}`);
    for (const key of Object.keys(s.republished)) subjects.add(`req:${key.split(':')[0] ?? ''}`);
    const list = [...subjects];
    for (const k of this.unknownSince.keys()) if (!subjects.has(k)) this.unknownSince.delete(k);
    if (list.length === 0) return changed;
    const at = { blockTag: 'finalized' } as const;
    let reads = 0;
    for (; reads < Math.min(maxReads, list.length); reads++) {
      const subject = list[(this.gcCursor + reads) % list.length] as string;
      const [kind, id] = subject.split(':') as ['cer' | 'req', Hex];
      let verdict: 'all' | 'phase' | 'keep';
      try {
        verdict = kind === 'cer' ? await this.ceremonyVerdict(id, at) : await this.requestVerdict(id, at);
      } catch (err) {
        if (extractRevertData(err) === undefined) break; // transport: try again on the next pass
        // Unknown at the finalized block: young, or never there. Forget it after a day.
        const since = this.unknownSince.get(subject) ?? now;
        this.unknownSince.set(subject, since);
        verdict = now - since >= UNKNOWN_FORGET_MS ? 'all' : 'keep';
      }
      if (verdict === 'keep') continue;
      this.unknownSince.delete(subject);
      if (this.prune(kind, id, verdict)) changed = true;
    }
    this.gcCursor = (this.gcCursor + reads) % Math.max(1, list.length);
    return changed;
  }

  private async ceremonyVerdict(cid: Hex, at: { blockTag: 'finalized' }): Promise<'all' | 'phase' | 'keep'> {
    const view = await this.chain.ceremony(cid, at);
    if (view.phase === Phase.Aborted || view.phase === Phase.None) return 'all';
    return view.phase === Phase.Live ? 'phase' : 'keep';
  }

  private async requestVerdict(rid: Hex, at: { blockTag: 'finalized' }): Promise<'all' | 'keep'> {
    const meta = await this.chain.requestMeta(rid, at);
    const full = (1 << meta.fieldCount) - 1;
    return meta.fieldCount > 0 && (meta.completedBitmap & full) === full ? 'all' : 'keep';
  }

  /** Drop a subject's counters: all of them, or only the phase ones of a live ceremony. */
  private prune(kind: 'cer' | 'req', id: Hex, what: 'all' | 'phase'): boolean {
    const s = this.opts.store.state;
    const prefix = `${kind}:${id}:`;
    let changed = false;
    for (const key of Object.keys(s.quotas)) {
      if (!key.startsWith(prefix)) continue;
      if (what === 'phase' && !PHASE_QUOTAS.has(key.slice(prefix.length))) continue;
      delete s.quotas[key];
      changed = true;
    }
    if (what === 'all' && kind === 'cer') {
      const admitted = s.admitted.filter((c) => c !== id);
      const tracked = s.tracked.filter((c) => c !== id);
      changed ||= admitted.length !== s.admitted.length || tracked.length !== s.tracked.length;
      s.admitted = admitted;
      s.tracked = tracked;
    }
    if (what === 'all' && kind === 'req') {
      for (const key of Object.keys(s.republished)) {
        if (!key.startsWith(`${id}:`)) continue;
        delete s.republished[key];
        changed = true;
      }
    }
    return changed;
  }

  /** Run `gc` every `intervalMs` (after the previous pass completed), persisting what changed. */
  startGc(intervalMs: number, log: Logger = silentLogger): void {
    this.stopGc();
    const loop = (): void => {
      this.gc()
        .then(
          (changed) => {
            if (changed) this.opts.store.flushSoon();
          },
          (err: unknown) => log.info('state garbage collection deferred', { err: shortMessage(err) }),
        )
        .finally(() => {
          if (this.gcTimer === undefined) return;
          this.gcTimer = setTimeout(loop, intervalMs);
          this.gcTimer.unref();
        });
    };
    this.gcTimer = setTimeout(loop, intervalMs);
    this.gcTimer.unref();
  }

  stopGc(): void {
    if (this.gcTimer) clearTimeout(this.gcTimer);
    this.gcTimer = undefined;
  }
}

/** The one path to the hot key: policy, the points rebuilt from state, then simulate-and-send. */
export class Sponsor {
  constructor(
    private readonly policy: SponsorPolicy,
    private readonly sender: Pick<TxSender, 'send' | 'holds'>,
    private readonly manager: Hex,
  ) {}

  async sponsor(action: Action, ctx: SponsorContext): Promise<Hex> {
    // A combine of this request in flight may complete it: re-publishing now would be paid for
    // nothing (the contract accepts a publication after completion).
    if (action.kind === 'publishPartialData' && this.sender.holds(`req:${action.requestId.toLowerCase()}:field:`)) {
      throw new RelayError('CONFLICT', `a combine of ${action.requestId} is pending; retry the re-publication once it settles`);
    }
    const options = await this.policy.sendOptions(action, ctx);
    const full = await this.policy.chain.complete(action);
    const hash = await this.sender.send(this.manager, encodeAction(full), options);
    this.policy.sent(options.plan);
    return hash;
  }

  /** False for a verified NOT_SPONSORED ceremony; throws when it cannot be verified now. */
  async admits(cid: Hex): Promise<boolean> {
    try {
      await this.policy.ensureSponsored(cid);
      return true;
    } catch (err) {
      if (err instanceof RelayError && err.code === 'NOT_SPONSORED') return false;
      throw err;
    }
  }
}
