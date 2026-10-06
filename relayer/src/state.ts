/**
 * The relayer's only local state: one JSON file under COUNCIL_DATA_DIR, written atomically
 * (temp file + rename) after every change. It holds what a restart must not forget — signed
 * pending transactions (so evicted ones are rebroadcast and their nonces never reused), recent
 * transaction outcomes (for /v1/status), the rolling spend log of the budget, and the
 * sponsorship counters. Chain state remains the only truth about the protocol.
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';

export type PersistedFees =
  | { type: 'eip1559'; maxFeePerGas: string; maxPriorityFeePerGas: string }
  | { type: 'legacy'; gasPrice: string };

export interface PersistedTx {
  nonce: number;
  to: Hex;
  data: Hex;
  gas: string;
  fees: PersistedFees;
  raw: Hex;
  hashes: Hex[];
  lastSentAt: number;
  slots: string[];
  reservedWei: string;
}

export interface SettledTx {
  hashes: Hex[];
  state: 'confirmed' | 'failed';
  blockNumber?: string;
  revertReason?: string;
  minedHash?: Hex;
  settledAt: number;
}

export interface RelayerState {
  version: 1;
  pending: PersistedTx[];
  history: SettledTx[];
  /** Spend log of the rolling budget window. */
  spend: { t: number; wei: string }[];
  /** Sponsorship counters, key -> units used. */
  quotas: Record<string, number>;
  /** Ceremonies admitted by this relayer (restricted mode). */
  admitted: Hex[];
  /** Organizer -> timestamps of sponsored createCeremony. */
  organizerCreates: Record<string, number[]>;
}

export const emptyState = (): RelayerState => ({
  version: 1,
  pending: [],
  history: [],
  spend: [],
  quotas: {},
  admitted: [],
  organizerCreates: {},
});

export class StateStore {
  readonly state: RelayerState;

  /** `file` undefined keeps the state in memory only (tests). */
  constructor(readonly file?: string) {
    this.state = file ? StateStore.read(file) : emptyState();
  }

  /** The state file of one deployment and hot key: `<dir>/<chainId>-<manager>-<relayer>.json`. */
  static fileFor(dir: string, chainId: bigint, manager: Hex, relayer: Hex): string {
    return path.join(dir, `${chainId}-${manager.toLowerCase()}-${relayer.toLowerCase()}.json`);
  }

  private static read(file: string): RelayerState {
    let text: string;
    try {
      text = readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyState();
      throw err;
    }
    const parsed = JSON.parse(text) as Partial<RelayerState>;
    if (parsed.version !== 1) throw new Error(`state file ${file}: unsupported version ${String(parsed.version)}`);
    return { ...emptyState(), ...parsed } as RelayerState;
  }

  /** Persist atomically. */
  flush(): void {
    if (!this.file) return;
    mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify(this.state));
    renameSync(tmp, this.file);
  }
}
