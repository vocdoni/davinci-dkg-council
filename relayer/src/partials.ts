/**
 * Partial-data availability for the combiner (protocol §10.4). The contract keeps only a hash
 * and a publication block per accepted partial; the padded D vectors themselves travel in
 * calldata and in `PartialDataPublished`. The relayer sources them in the normative order
 * (SDK `sourcePartialVectors`): this cache first, then ONE `eth_getLogs` at the stored
 * publication block, then a member's re-publication. Whatever the transport, a vector is used
 * only if its recomputed `partialDataHash` equals the stored one, so neither the cache nor a log
 * is trusted.
 *
 * The cache holds every vector the relayer relayed (submitPartial, publishPartialData, combine)
 * or fetched, one JSON file per request under the data directory, and drops a request once it
 * is complete. Losing it costs log reads or a re-publication, never correctness.
 */

import { mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import {
  COUNCIL_MANAGER_ABI,
  MAX_FIELDS,
  partialVectorCacheKey,
  type Hex,
  type PartialCommitment,
  type PartialVectorCache,
  type PartialVectorSource,
  type Point,
} from '@vocdoni/davinci-dkg-council-sdk';
import { parseEventLogs, type AbiEvent, type PublicClient } from 'viem';
import type { ChainState } from './chainstate.js';

/** Requests whose vectors are kept; the least recently touched is evicted beyond it. */
const DEFAULT_MAX_REQUESTS = 1024;
const REQUEST_ID = /^0x[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]{0,77})$/;

interface RequestEntry {
  /** Last write (eviction order). */
  at: number;
  /** `index:dataHash` -> padded D vector. */
  vectors: Map<string, Point[]>;
}

interface RequestFile {
  version: 1;
  at: number;
  vectors: Record<string, [string, string][]>;
}

const isVector = (v: unknown): v is [string, string][] =>
  Array.isArray(v) &&
  v.length === MAX_FIELDS &&
  v.every((p) => Array.isArray(p) && p.length === 2 && p.every((c) => typeof c === 'string' && DECIMAL.test(c)));

/** `PartialVectorCache.set` is typed after `Map.set`; its result is never used. */
const UNUSED = new Map<string, Point[]>();

/** The persistent D-vector cache, keyed like the SDK's (`partialVectorCacheKey`). */
export class PartialVectorStore {
  /** This store as the SDK cache of `sourcePartialVectors`. */
  readonly cache: PartialVectorCache = {
    get: (key) => this.get(key),
    set: (key, D) => {
      this.set(key, D);
      return UNUSED;
    },
  };
  private readonly requests = new Map<Hex, RequestEntry>();
  private readonly prefix: string;
  private readonly maxRequests: number;
  private readonly now: () => number;

  /** `dir` undefined keeps the cache in memory only (tests). */
  constructor(
    readonly chainId: bigint,
    readonly manager: Hex,
    readonly dir?: string,
    opts: { maxRequests?: number; now?: () => number } = {},
  ) {
    this.prefix = `${chainId}:${manager.toLowerCase()}:`;
    this.maxRequests = opts.maxRequests ?? DEFAULT_MAX_REQUESTS;
    this.now = opts.now ?? Date.now;
    if (dir) this.load(dir);
  }

  /** The cache directory of one deployment: `<dataDir>/<chainId>-<manager>-partials`. */
  static dirFor(dataDir: string, chainId: bigint, manager: Hex): string {
    return path.join(dataDir, `${chainId}-${manager.toLowerCase()}-partials`);
  }

  private load(dir: string): void {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw err;
    }
    for (const name of names) {
      const rid = name.replace(/\.json$/, '') as Hex;
      if (!name.endsWith('.json') || !REQUEST_ID.test(rid)) continue;
      let file: RequestFile;
      try {
        file = JSON.parse(readFileSync(path.join(dir, name), 'utf8')) as RequestFile;
      } catch {
        continue; // a torn or foreign file: the vectors are re-sourced from logs or re-publication
      }
      if (file?.version !== 1 || typeof file.vectors !== 'object' || file.vectors === null) continue;
      const vectors = new Map<string, Point[]>();
      for (const [key, v] of Object.entries(file.vectors)) {
        if (!/^\d{1,2}:0x[0-9a-f]{64}$/.test(key) || !isVector(v)) continue;
        vectors.set(key, v.map(([x, y]) => ({ x: BigInt(x), y: BigInt(y) })));
      }
      if (vectors.size > 0) this.requests.set(rid, { at: typeof file.at === 'number' ? file.at : 0, vectors });
    }
  }

  private parse(key: string): { requestId: Hex; slot: string } | undefined {
    if (!key.startsWith(this.prefix)) return undefined;
    const [rid, index, dataHash] = key.slice(this.prefix.length).split(':');
    if (rid === undefined || index === undefined || dataHash === undefined) return undefined;
    return { requestId: rid.toLowerCase() as Hex, slot: `${index}:${dataHash.toLowerCase()}` };
  }

  get(key: string): Point[] | undefined {
    const k = this.parse(key);
    return k ? this.requests.get(k.requestId)?.vectors.get(k.slot) : undefined;
  }

  set(key: string, D: Point[]): void {
    const k = this.parse(key);
    if (!k || D.length !== MAX_FIELDS || !REQUEST_ID.test(k.requestId)) return;
    let entry = this.requests.get(k.requestId);
    const known = entry?.vectors.get(k.slot);
    // The key carries the commitment, so the same key normally means the same vector: no rewrite.
    if (known && known.every((p, i) => p.x === D[i]?.x && p.y === D[i]?.y)) return;
    if (!entry) {
      entry = { at: 0, vectors: new Map() };
      this.requests.set(k.requestId, entry);
    }
    entry.at = this.now();
    entry.vectors.set(k.slot, D.map((p) => ({ x: p.x, y: p.y })));
    this.write(k.requestId, entry);
    this.evict();
  }

  /** Cache member `index`'s vector under its partial-data hash. */
  put(requestId: Hex, index: number, dataHash: Hex, D: Point[]): void {
    this.set(partialVectorCacheKey(this.chainId, this.manager, requestId, index, dataHash), D);
  }

  has(requestId: Hex, index: number, dataHash: Hex): boolean {
    return this.vector(requestId, index, dataHash) !== undefined;
  }

  /** The vector cached for member `index` under `dataHash` (unauthenticated: check its hash). */
  vector(requestId: Hex, index: number, dataHash: Hex): Point[] | undefined {
    return this.get(partialVectorCacheKey(this.chainId, this.manager, requestId, index, dataHash));
  }

  /** Forget a request (complete, or not this relayer's to combine). */
  drop(requestId: Hex): void {
    const rid = requestId.toLowerCase() as Hex;
    if (!this.requests.delete(rid) || !this.dir) return;
    rmSync(path.join(this.dir, `${rid}.json`), { force: true });
  }

  /** Requests with cached vectors. */
  get size(): number {
    return this.requests.size;
  }

  private evict(): void {
    while (this.requests.size > this.maxRequests) {
      let oldest: Hex | undefined;
      let at = Number.POSITIVE_INFINITY;
      for (const [rid, e] of this.requests) {
        if (e.at < at) {
          at = e.at;
          oldest = rid;
        }
      }
      if (oldest === undefined) return;
      this.drop(oldest);
    }
  }

  private write(requestId: Hex, entry: RequestEntry): void {
    if (!this.dir) return;
    mkdirSync(this.dir, { recursive: true });
    const file: RequestFile = { version: 1, at: entry.at, vectors: {} };
    for (const [slot, D] of entry.vectors) file.vectors[slot] = D.map((p) => [p.x.toString(), p.y.toString()]);
    const target = path.join(this.dir, `${requestId}.json`);
    writeFileSync(`${target}.tmp`, JSON.stringify(file));
    renameSync(`${target}.tmp`, target);
  }
}

const PUBLISHED_EVENT = COUNCIL_MANAGER_ABI.find((e) => e.type === 'event' && e.name === 'PartialDataPublished') as AbiEvent;

/** One single-block read: the vector when the block still holds it, the refusal when there was one. */
export interface FetchResult {
  vector?: Point[];
  error?: unknown;
}

/** A `PartialVectorSource` whose log read also says why it found nothing. */
export interface VectorFetcher extends PartialVectorSource {
  fetch(requestId: Hex, index: number, publishedBlock: bigint): Promise<FetchResult>;
}

/**
 * The chain side of `sourcePartialVectors` over the relayer's RPC client: the stored commitment
 * at the head, and the single-block `eth_getLogs` at its publication block (protocol §10.4,
 * the one deliberate log read; never a range). For the combiner a block the provider no longer
 * serves, or any refusal, reads as "not there" (it retries, then waits for a re-publication);
 * `fetch` keeps the refusal so the sponsorship policy can tell a transient one from an absence.
 */
export class ChainPartialSource implements VectorFetcher {
  constructor(
    private readonly client: PublicClient,
    private readonly chain: ChainState,
  ) {}

  getPartialCommitment(requestId: Hex, index: number): Promise<PartialCommitment> {
    return this.chain.partialCommitment(requestId, index);
  }

  async fetchPublishedVector(requestId: Hex, index: number, publishedBlock: bigint): Promise<Point[] | undefined> {
    return (await this.fetch(requestId, index, publishedBlock)).vector;
  }

  async fetch(requestId: Hex, index: number, publishedBlock: bigint): Promise<FetchResult> {
    if (publishedBlock === 0n) return {};
    let logs;
    try {
      logs = await this.client.getLogs({
        address: this.chain.manager,
        event: PUBLISHED_EVENT,
        args: { requestId } as never,
        fromBlock: publishedBlock,
        toBlock: publishedBlock,
      });
    } catch (error) {
      return { error };
    }
    for (const log of parseEventLogs({ abi: COUNCIL_MANAGER_ABI, logs, eventName: 'PartialDataPublished' })) {
      if (log.address.toLowerCase() !== this.chain.manager.toLowerCase()) continue;
      const a = log.args as { requestId: Hex; index: number; D: readonly (readonly [bigint, bigint])[] };
      if (a.requestId.toLowerCase() !== requestId.toLowerCase() || Number(a.index) !== index) continue;
      return { vector: a.D.map(([x, y]) => ({ x, y })) };
    }
    return {};
  }
}
