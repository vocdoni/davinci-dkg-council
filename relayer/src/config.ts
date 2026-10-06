/**
 * Relayer configuration from the environment (architecture §5.2; full table in README.md).
 */

import { isIP } from 'node:net';
import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';

export interface RelayerConfig {
  rpcUrls: string[];
  manager: Hex;
  privateKey: Hex;
  port: number;
  host: string;
  dataDir: string;
  combinerEnabled: boolean;
  maxFeeWei: bigint;
  /** Undefined: no per-transaction cap below the block gas limit (state-gas chains). */
  maxTxGas: bigint | undefined;
  /** The chain prices state growth separately (EIP-8037): see COUNCIL_STATE_GAS. */
  stateGas: boolean;
  dailyBudgetWei: bigint;
  corsOrigins: string[];
  rateLimitPerIp: number;
  rateLimitPerCeremony: number;
  ingressRatePerIp: number;
  maxConcurrentRequests: number;
  trustedProxies: string[];
  organizerAllowlist: string[];
  apiTokens: string[];
  organizerDailyCeremonies: number;
  maxGrantsPerCeremony: number;
  startBlock: bigint;
  logRange: bigint;
  combinerPollMs: number;
  bsgsBabySteps: number;
  bumpAfterMs: number;
  txPollMs: number;
  nonceRefreshMs: number;
}

type Env = Record<string, string | undefined>;

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/;
const KEY_RE = /^0x[0-9a-fA-F]{64}$/;

function required(env: Env, name: string, alias?: string): string {
  const v = env[name] ?? (alias ? env[alias] : undefined);
  if (v === undefined || v.trim() === '') throw new Error(`config: ${name} is required`);
  return v.trim();
}

function int(env: Env, name: string, fallback: number, min = 0): number {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  const v = Number(raw);
  if (!Number.isSafeInteger(v) || v < min) throw new Error(`config: ${name} must be an integer >= ${min}`);
  return v;
}

function big(env: Env, name: string, fallback: bigint): bigint {
  const raw = env[name];
  if (raw === undefined || raw.trim() === '') return fallback;
  if (!/^[0-9]+$/.test(raw.trim())) throw new Error(`config: ${name} must be a decimal integer`);
  return BigInt(raw.trim());
}

function bool(env: Env, name: string): boolean {
  const raw = (env[name] ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'false' || raw === '0' || raw === 'no') return false;
  if (raw === 'true' || raw === '1' || raw === 'yes') return true;
  throw new Error(`config: ${name} must be true or false`);
}

const list = (raw: string | undefined): string[] =>
  (raw ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

export function loadConfig(env: Env): RelayerConfig {
  if (env.COUNCIL_TRUST_PROXY !== undefined) {
    throw new Error('config: COUNCIL_TRUST_PROXY was replaced by COUNCIL_TRUSTED_PROXIES (proxy IPs or CIDRs)');
  }
  const rpcUrls = list(required(env, 'COUNCIL_RPC_URL'));
  for (const url of rpcUrls) {
    if (!/^(https?|wss?):\/\//.test(url)) throw new Error(`config: COUNCIL_RPC_URL entry is not a URL: ${url}`);
  }
  const manager = required(env, 'COUNCIL_MANAGER_ADDRESS');
  if (!ADDRESS_RE.test(manager)) throw new Error('config: COUNCIL_MANAGER_ADDRESS must be a 20-byte 0x address');
  let privateKey = required(env, 'COUNCIL_PRIVATE_KEY', 'RELAYER_PRIVATE_KEY');
  if (!privateKey.startsWith('0x')) privateKey = `0x${privateKey}`;
  if (!KEY_RE.test(privateKey)) throw new Error('config: COUNCIL_PRIVATE_KEY must be a 32-byte hex key');

  const trustedProxies = list(env.COUNCIL_TRUSTED_PROXIES);
  for (const p of trustedProxies) {
    const [addr, prefix] = p.split('/');
    if (isIP(addr ?? '') === 0 || (prefix !== undefined && !/^[0-9]{1,3}$/.test(prefix))) {
      throw new Error(`config: COUNCIL_TRUSTED_PROXIES entry is not an IP or CIDR: ${p}`);
    }
  }
  const organizerAllowlist = list(env.COUNCIL_ORGANIZER_ALLOWLIST).map((a) => {
    if (!ADDRESS_RE.test(a)) throw new Error(`config: COUNCIL_ORGANIZER_ALLOWLIST entry is not an address: ${a}`);
    return a.toLowerCase();
  });
  // EIP-7825 (Osaka) rejects a gas limit above 2^24. With EIP-8037 (Glamsterdam) that bounds
  // execution gas only: state gas comes on top, so by default only the block gas limit caps.
  const stateGas = bool(env, 'COUNCIL_STATE_GAS');
  const maxTxGasSet = (env.COUNCIL_MAX_TX_GAS ?? '').trim() !== '';
  const maxTxGas = maxTxGasSet ? big(env, 'COUNCIL_MAX_TX_GAS', 0n) : stateGas ? undefined : 16_777_216n;
  if (maxTxGas !== undefined && maxTxGas < 21_000n) throw new Error('config: COUNCIL_MAX_TX_GAS must be at least 21000');
  const apiTokens = list(env.COUNCIL_API_TOKENS);
  for (const t of apiTokens) {
    if (t.length < 16) throw new Error('config: COUNCIL_API_TOKENS entries must be at least 16 characters');
  }

  return {
    rpcUrls,
    manager: manager.toLowerCase() as Hex,
    privateKey: privateKey as Hex,
    port: int(env, 'COUNCIL_PORT', 8080),
    host: (env.COUNCIL_HOST ?? '').trim() || '0.0.0.0',
    dataDir: (env.COUNCIL_DATA_DIR ?? '').trim() || './data',
    combinerEnabled: bool(env, 'COUNCIL_COMBINER_ENABLED'),
    maxFeeWei: big(env, 'COUNCIL_MAX_FEE_WEI', 100_000_000_000n),
    maxTxGas,
    stateGas,
    dailyBudgetWei: big(env, 'COUNCIL_DAILY_BUDGET_WEI', 1_000_000_000_000_000_000n),
    corsOrigins: list(env.COUNCIL_CORS_ORIGINS),
    rateLimitPerIp: int(env, 'COUNCIL_RATE_LIMIT', 60, 1),
    rateLimitPerCeremony: int(env, 'COUNCIL_CEREMONY_RATE_LIMIT', 120, 1),
    ingressRatePerIp: int(env, 'COUNCIL_INGRESS_RATE_LIMIT', 600, 1),
    maxConcurrentRequests: int(env, 'COUNCIL_MAX_CONCURRENT_REQUESTS', 64, 1),
    trustedProxies,
    organizerAllowlist,
    apiTokens,
    organizerDailyCeremonies: int(env, 'COUNCIL_ORGANIZER_DAILY_CEREMONIES', 5),
    maxGrantsPerCeremony: int(env, 'COUNCIL_MAX_GRANTS', 8),
    startBlock: big(env, 'COUNCIL_START_BLOCK', 0n),
    logRange: big(env, 'COUNCIL_LOG_RANGE', 5000n),
    combinerPollMs: int(env, 'COUNCIL_COMBINER_POLL_MS', 5000, 100),
    bsgsBabySteps: int(env, 'COUNCIL_BSGS_BABY_STEPS', 1 << 20, 1),
    bumpAfterMs: int(env, 'COUNCIL_TX_BUMP_AFTER_MS', 30_000, 1000),
    txPollMs: int(env, 'COUNCIL_TX_POLL_MS', 3000, 100),
    nonceRefreshMs: int(env, 'COUNCIL_NONCE_REFRESH_MS', 15_000, 0),
  };
}
