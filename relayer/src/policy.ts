/**
 * Sponsorship policy: which actions the hot key pays for, and how many.
 *
 * - Slots: the one-shot protocol state an action consumes (enforced by the sender from
 *   acceptance until settlement, see sender.ts).
 * - Quotas: per-ceremony / per-request counts of sponsored transactions, derived from the
 *   protocol bounds (one create/close/finalize/abort, ≤ 64 invites, ≤ 16 joins and deals,
 *   ≤ n partials per request, combines bounded by the request's fields), plus a configurable
 *   number of grants (allowAdapter + authorizeCreator). Charged only after a successful
 *   simulation, undone if the broadcast fails, persisted across restarts.
 * - Admission: createCeremony may require an allow-listed organizer or a bearer API token;
 *   when either is configured ("restricted" mode) every other action is sponsored only for
 *   ceremonies created through this relayer or organized by an allow-listed address. A
 *   per-organizer rolling-24 h cap bounds sponsored ceremonies in every mode.
 *
 * Everything sponsored, the combine worker included, also passes the sender's global budget.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import {
  ceremonyId as computeCeremonyId,
  COUNCIL_MANAGER_ABI,
  encodeAction,
  MAX_INVITES,
  MAX_N,
  type Action,
  type Hex,
} from '@vocdoni/davinci-dkg-council-sdk';
import type { PublicClient } from 'viem';
import { extractRevertData, RelayError, shortMessage } from './errors.js';
import { RateLimiter } from './ratelimit.js';
import type { SendOptions, TxSender } from './sender.js';
import type { StateStore } from './state.js';

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
  source: 'http' | 'combiner';
  /** Bearer token from the Authorization header. */
  token?: string;
}

interface Quota {
  key: string;
  amount: number;
  limit: number;
}

interface Plan {
  cid: Hex;
  slots: string[];
  quotas: Quota[];
  rateKey: string;
  /** createCeremony only. */
  create?: { organizer: string; admit: boolean };
}

const DAY_MS = 24 * 3_600_000;
const digest = (s: string): Buffer => createHash('sha256').update(s).digest();

export class SponsorPolicy {
  private readonly allowlist: Set<string>;
  private readonly tokenDigests: Buffer[];
  private readonly limiter: RateLimiter;

  constructor(
    private readonly opts: {
      client: PublicClient;
      chainId: bigint;
      manager: Hex;
      store: StateStore;
      config: PolicyConfig;
      now?: () => number;
    },
  ) {
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

  private tokenValid(token: string | undefined): boolean {
    if (token === undefined) return false;
    const d = digest(token);
    return this.tokenDigests.some((t) => timingSafeEqual(t, d));
  }

  private async read<T>(functionName: string, args: readonly unknown[]): Promise<T | undefined> {
    try {
      return (await this.opts.client.readContract({
        address: this.opts.manager,
        abi: COUNCIL_MANAGER_ABI,
        functionName: functionName as never,
        args: args as never,
      })) as T;
    } catch (err) {
      // A revert with data (UnknownCeremony, …) is an answer: simulation will refuse the
      // action. Anything else — including a bare -32603, which viem reports as "reverted" —
      // is not: retry later rather than guess.
      if (extractRevertData(err) !== undefined) return undefined;
      throw new RelayError('INTERNAL', `chain read ${functionName} failed: ${shortMessage(err)}`);
    }
  }

  /**
   * Restricted mode: the ceremony was admitted here or is organized by an allow-listed address.
   * NOT_SPONSORED is a verified denial (the chain answered); an RPC failure is INTERNAL and
   * retryable, never a denial.
   */
  async ensureSponsored(cid: Hex): Promise<void> {
    if (!this.restricted) return;
    const id = cid.toLowerCase() as Hex;
    if (this.opts.store.state.admitted.includes(id)) return;
    let organizer: string | undefined;
    try {
      const view = (await this.opts.client.readContract({
        address: this.opts.manager,
        abi: COUNCIL_MANAGER_ABI,
        functionName: 'getCeremony',
        args: [id],
      })) as { organizer: Hex };
      organizer = view.organizer.toLowerCase();
    } catch (err) {
      if (extractRevertData(err) === undefined) {
        throw new RelayError('INTERNAL', `could not verify sponsorship of ${id}: ${shortMessage(err)}`);
      }
      // UnknownCeremony: not ours to sponsor.
    }
    if (organizer !== undefined && this.allowlist.has(organizer)) return;
    throw new RelayError('NOT_SPONSORED', `ceremony ${id} is not sponsored by this relayer`);
  }

  /** Slots, quotas and admission of one action (before simulation; cheap reads only). */
  private async plan(action: Action, ctx: SponsorContext): Promise<Plan> {
    const grants = this.opts.config.maxGrantsPerCeremony;
    switch (action.kind) {
      case 'createCeremony': {
        const m = action.message;
        const organizer = m.organizer.toLowerCase();
        const cid = computeCeremonyId(this.opts.chainId, this.opts.manager, m.organizer, m.nonce).toLowerCase() as Hex;
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
        };
      }
      case 'addInvites':
      case 'closeRegistration':
      case 'allowAdapter':
      case 'authorizeCreator':
      case 'join':
      case 'deal': {
        const cid = action.message.ceremonyId.toLowerCase() as Hex;
        await this.ensureSponsored(cid);
        const base = { cid, rateKey: `ceremony:${cid}` };
        switch (action.kind) {
          case 'addInvites':
            return {
              ...base,
              slots: [`cer:${cid}:invites-from:${action.message.firstInviteId}`],
              quotas: [{ key: `cer:${cid}:invites`, amount: action.message.inviteKeys.length, limit: MAX_INVITES }],
            };
          case 'closeRegistration':
            return { ...base, slots: [`cer:${cid}:phase`], quotas: [{ key: `cer:${cid}:close`, amount: 1, limit: 1 }] };
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
      case 'finalize':
      case 'abort': {
        const cid = action.ceremonyId.toLowerCase() as Hex;
        await this.ensureSponsored(cid);
        return {
          cid,
          slots: [`cer:${cid}:phase`],
          quotas: [{ key: `cer:${cid}:${action.kind}`, amount: 1, limit: 1 }],
          rateKey: `ceremony:${cid}`,
        };
      }
      case 'submitPartial': {
        const cid = action.message.ceremonyId.toLowerCase() as Hex;
        const rid = action.message.requestId.toLowerCase() as Hex;
        await this.ensureSponsored(cid);
        const view = await this.read<{ n: number }>('getCeremony', [cid]);
        const n = view && view.n > 0 ? view.n : MAX_N;
        return {
          cid,
          slots: [`req:${rid}:partial:${action.message.participantIndex}`],
          quotas: [{ key: `req:${rid}:partial`, amount: 1, limit: n }],
          rateKey: `ceremony:${cid}`,
        };
      }
      case 'combine': {
        const rid = action.requestId.toLowerCase() as Hex;
        const req = await this.read<readonly [Hex, number]>('getRequest', [rid]);
        const cid = (req?.[0] ?? '0x000000000000000000000000').toLowerCase() as Hex;
        const fieldCount = req?.[1] ?? 0;
        if (req) await this.ensureSponsored(cid);
        else if (this.restricted) throw new RelayError('NOT_SPONSORED', `request ${rid} is not sponsored by this relayer`);
        return {
          cid,
          slots: action.fieldIndexes.map((k) => `req:${rid}:field:${k}`),
          // fieldCount fields, plus one retry each (a lost race or a reorg).
          quotas: [{ key: `req:${rid}:combine-fields`, amount: action.fieldIndexes.length, limit: 2 * fieldCount }],
          rateKey: ctx.source === 'combiner' ? '' : `request:${rid}`,
        };
      }
    }
  }

  /** The charge applied after a successful simulation; returns its undo. */
  private reserve(plan: Plan): () => void {
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
    const rate = this.opts.config.ceremonyRatePerMinute;
    if (plan.rateKey && !this.limiter.take(plan.rateKey, rate)) {
      throw new RelayError('RATE_LIMITED', `too many sponsored actions for ${plan.rateKey}`);
    }
    for (const q of plan.quotas) s.quotas[q.key] = (s.quotas[q.key] ?? 0) + q.amount;
    if (plan.create && creates) {
      s.organizerCreates[plan.create.organizer] = [...creates, this.now];
      if (plan.create.admit && !s.admitted.includes(plan.cid)) s.admitted.push(plan.cid);
    }
    return () => {
      for (const q of plan.quotas) s.quotas[q.key] = (s.quotas[q.key] ?? q.amount) - q.amount;
      if (plan.create && creates) {
        s.organizerCreates[plan.create.organizer] = creates;
        if (plan.create.admit) s.admitted = s.admitted.filter((c) => c !== plan.cid);
      }
      if (plan.rateKey) this.limiter.refund(plan.rateKey);
      this.opts.store.flush();
    };
  }

  /** Admission checks now; slots and the post-simulation charge for the sender. */
  async sendOptions(action: Action, ctx: SponsorContext): Promise<SendOptions> {
    const plan = await this.plan(action, ctx);
    return { slots: plan.slots, reserve: () => this.reserve(plan) };
  }
}

/** The one path to the hot key: policy, then simulate-and-send. */
export class Sponsor {
  constructor(
    private readonly policy: SponsorPolicy,
    private readonly sender: Pick<TxSender, 'send'>,
    private readonly manager: Hex,
  ) {}

  async sponsor(action: Action, ctx: SponsorContext): Promise<Hex> {
    const options = await this.policy.sendOptions(action, ctx);
    return this.sender.send(this.manager, encodeAction(action), options);
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
