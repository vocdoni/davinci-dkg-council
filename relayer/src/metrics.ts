/**
 * GET /v1/metrics: what an operator must watch for a relayer that has to stay up for months
 * (hot-key funding, budget, stuck transactions, the workers, RPC health), with the alerts the
 * documented thresholds raise (docs/relayer.md, "Monitoring"). 200 while no alert fires, 503
 * otherwise, the full body either way, so a plain HTTP uptime check alerts without parsing it.
 *
 * The RPC agreement probe performs the check the app makes before trusting a read (protocol
 * §9.3): every configured endpoint's finalized block, compared by hash at the lowest finalized
 * height among them. A provider stuck on an old fork, frozen, or answering for another chain
 * shows up here before members see "RPC providers disagree".
 *
 * Results are cached for `ttlMs` (15 s), and concurrent requests share one collection.
 */

import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';
import type { Endpoint } from './broadcast.js';
import { shortMessage } from './errors.js';
import type { LoopStatus, TxSender } from './sender.js';
import type { StateStore } from './state.js';

export interface AlertThresholds {
  /** Alert when the hot key holds less (COUNCIL_ALERT_MIN_BALANCE_WEI). */
  minBalanceWei: bigint;
  /** Alert when less than this percentage of the daily budget is left (COUNCIL_ALERT_BUDGET_PERCENT). */
  minBudgetPercent: number;
  /** Alert when a transaction is unmined for longer (COUNCIL_ALERT_PENDING_MS). */
  maxPendingMs: number;
  /** Alert when a worker had no successful pass for longer (COUNCIL_ALERT_STALE_MS). */
  maxStaleMs: number;
  /** Alert when an endpoint's finalized block lags the others by more (COUNCIL_ALERT_RPC_LAG_BLOCKS). */
  maxRpcLagBlocks: bigint;
}

export interface RpcEndpointProbe {
  name: string;
  finalizedBlock?: string;
  finalizedHash?: Hex;
  /** Its hash at the compared height. */
  hashAtCompared?: Hex;
  error?: string;
}

export interface RpcProbe {
  endpoints: RpcEndpointProbe[];
  /** The lowest finalized height among the endpoints that answered (where hashes are compared). */
  comparedBlock?: string;
  /** Every answering endpoint has the same block there; null with fewer than two answers. */
  agree: boolean | null;
  /** Highest minus lowest finalized height. */
  lagBlocks: string;
}

/** Each endpoint's finalized block, and their hashes at the lowest finalized height. */
export async function probeRpcAgreement(endpoints: Endpoint[]): Promise<RpcProbe> {
  const probes: (RpcEndpointProbe & { n?: bigint })[] = await Promise.all(
    endpoints.map(async (ep) => {
      try {
        const b = await ep.client.getBlock({ blockTag: 'finalized' });
        if (b.number === null || b.hash === null) return { name: ep.name, error: 'no finalized block' };
        return { name: ep.name, n: b.number, finalizedBlock: b.number.toString(), finalizedHash: b.hash };
      } catch (err) {
        return { name: ep.name, error: shortMessage(err) };
      }
    }),
  );
  const answered = probes.filter((p) => p.n !== undefined);
  if (answered.length === 0) return { endpoints: probes.map(strip), agree: null, lagBlocks: '0' };
  let lo = answered[0]?.n as bigint;
  let hi = lo;
  for (const p of answered) {
    if ((p.n as bigint) < lo) lo = p.n as bigint;
    if ((p.n as bigint) > hi) hi = p.n as bigint;
  }
  await Promise.all(
    answered.map(async (p) => {
      if (p.n === lo) {
        p.hashAtCompared = p.finalizedHash;
        return;
      }
      try {
        const ep = endpoints[probes.indexOf(p)] as Endpoint;
        const b = await ep.client.getBlock({ blockNumber: lo });
        p.hashAtCompared = b.hash ?? undefined;
      } catch (err) {
        p.error = `block ${lo}: ${shortMessage(err)}`;
      }
    }),
  );
  const hashes = answered.filter((p) => p.hashAtCompared !== undefined).map((p) => p.hashAtCompared);
  const agree = hashes.length < 2 ? null : hashes.every((h) => h === hashes[0]);
  return { endpoints: probes.map(strip), comparedBlock: lo.toString(), agree, lagBlocks: (hi - lo).toString() };
}

const strip = ({ n: _n, ...p }: RpcEndpointProbe & { n?: bigint }): RpcEndpointProbe => p;

export interface MetricsOptions {
  chainId: bigint;
  manager: Hex;
  sender: Pick<
    TxSender,
    | 'address'
    | 'balance'
    | 'budget'
    | 'pendingCount'
    | 'awaitingFinality'
    | 'oldestPendingMs'
    | 'oldestUnfinalMs'
    | 'foreignTransactions'
    | 'monitorStatus'
  >;
  scheduler?: { status(): LoopStatus & { watching: number } };
  combiner?: { status(): LoopStatus & { open: number; tracked: number; discovery: LoopStatus & { nextBlock: string } } };
  /** One client per configured RPC URL (the broadcast endpoints). */
  endpoints: Endpoint[];
  store?: StateStore;
  thresholds: AlertThresholds;
  ttlMs?: number;
  now?: () => number;
}

const age = (now: number, at: number | undefined): number | null => (at === undefined ? null : Math.max(0, now - at));
/** A mined transaction still not final after this long: the RPCs' finalized block is stuck. */
const FINALITY_ALERT_MS = 3_600_000;

export class Metrics {
  private readonly startedAt: number;
  private cached: { at: number; status: number; body: Record<string, unknown> } | undefined;
  private inflight: Promise<{ status: number; body: Record<string, unknown> }> | undefined;

  constructor(private readonly opts: MetricsOptions) {
    this.startedAt = this.now();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  /** The metrics document and its HTTP status (cached, shared by concurrent callers). */
  async collect(): Promise<{ status: number; body: Record<string, unknown> }> {
    const ttl = this.opts.ttlMs ?? 15_000;
    if (this.cached && this.now() - this.cached.at < ttl) return this.cached;
    this.inflight ??= this.build().finally(() => {
      this.inflight = undefined;
    });
    return this.inflight;
  }

  private async build(): Promise<{ at: number; status: number; body: Record<string, unknown> }> {
    const { sender, thresholds: th } = this.opts;
    const now = this.now();
    const alerts: string[] = [];

    let balance: bigint | undefined;
    try {
      balance = await sender.balance();
      if (balance < th.minBalanceWei) {
        alerts.push(`hot key balance ${balance} wei is below ${th.minBalanceWei} wei: top it up`);
      }
    } catch (err) {
      alerts.push(`cannot read the hot key balance: ${shortMessage(err)}`);
    }

    const limit = sender.budget.limitWei;
    const remaining = sender.budget.remaining();
    if (remaining !== undefined && remaining * 100n < limit * BigInt(th.minBudgetPercent)) {
      alerts.push(`daily budget nearly used: ${remaining} of ${limit} wei left`);
    }

    const oldest = sender.oldestPendingMs();
    if (oldest > th.maxPendingMs) alerts.push(`a transaction has been pending for ${Math.round(oldest / 60_000)} min`);
    const unfinal = sender.oldestUnfinalMs();
    if (unfinal > FINALITY_ALERT_MS) {
      alerts.push(
        `${sender.awaitingFinality} mined transaction(s) await finality, the oldest for ${Math.round(unfinal / 60_000)} min: ` +
          'the finalized block does not advance (sends pause at 512)',
      );
    }
    if (sender.foreignTransactions > 0) {
      alerts.push(`the hot key sent ${sender.foreignTransactions} transaction(s) this relayer did not: give it a key nothing else uses`);
    }

    const loop = (name: string, st: LoopStatus | undefined): Record<string, unknown> | null => {
      if (!st) return null;
      const since = now - (st.lastSuccessAt ?? this.startedAt);
      if (since > th.maxStaleMs) alerts.push(`${name}: no successful pass for ${Math.round(since / 60_000)} min`);
      return { lastSuccessAt: st.lastSuccessAt ?? null, lastSuccessAgeMs: age(now, st.lastSuccessAt), consecutiveFailures: st.failures };
    };
    const monitor = loop('transaction monitor', sender.monitorStatus());
    const sched = this.opts.scheduler?.status();
    const comb = this.opts.combiner?.status();
    const scheduler = sched ? { ...loop('scheduler', sched), watching: sched.watching } : null;
    const combiner = comb
      ? {
          ...loop('combine worker', comb),
          openRequests: comb.open,
          trackedCeremonies: comb.tracked,
          discovery: {
            lastSuccessAt: comb.discovery.lastSuccessAt ?? null,
            consecutiveFailures: comb.discovery.failures,
            nextBlock: comb.discovery.nextBlock,
          },
        }
      : null;

    const rpc = await probeRpcAgreement(this.opts.endpoints);
    for (const ep of rpc.endpoints) if (ep.error !== undefined) alerts.push(`rpc ${ep.name}: ${ep.error}`);
    if (rpc.agree === false) alerts.push(`rpc endpoints disagree on finalized block ${rpc.comparedBlock}`);
    if (BigInt(rpc.lagBlocks) > th.maxRpcLagBlocks) {
      alerts.push(`rpc finalized blocks are ${rpc.lagBlocks} blocks apart (threshold ${th.maxRpcLagBlocks})`);
    }

    const body: Record<string, unknown> = {
      ok: alerts.length === 0,
      alerts,
      checkedAt: now,
      chainId: this.opts.chainId.toString(),
      manager: this.opts.manager,
      relayer: sender.address,
      balanceWei: balance?.toString() ?? null,
      budget: {
        limitWei: limit.toString(),
        windowMs: sender.budget.windowMs,
        spentWei: sender.budget.spent().toString(),
        inFlightWei: sender.budget.inFlight().toString(),
        remainingWei: remaining?.toString() ?? null,
      },
      transactions: {
        pending: sender.pendingCount,
        awaitingFinality: sender.awaitingFinality,
        oldestPendingMs: oldest,
        oldestUnfinalMs: unfinal,
        foreignTransactions: sender.foreignTransactions,
        monitor,
      },
      scheduler,
      combiner,
      rpc,
      stateFileBytes: this.opts.store?.lastWriteBytes ?? null,
      thresholds: {
        minBalanceWei: th.minBalanceWei.toString(),
        minBudgetPercent: th.minBudgetPercent,
        maxPendingMs: th.maxPendingMs,
        maxStaleMs: th.maxStaleMs,
        maxRpcLagBlocks: th.maxRpcLagBlocks.toString(),
      },
    };
    this.cached = { at: now, status: alerts.length === 0 ? 200 : 503, body };
    return this.cached;
  }
}
