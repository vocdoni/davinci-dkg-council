/**
 * Runtime configuration from `public/config.json` (architecture §6).
 *
 * `rpcUrls` must list at least two independently administered providers on a
 * production chain — protocol §9.3's authenticated-read rule depends on it. A
 * single entry is accepted only together with an explicit local/dev
 * declaration (`devMode: true`, e.g. Anvil on chain 31337).
 */

import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';

/**
 * An older manager on the same chain whose committees this copy still serves: kits and links made
 * before a redeploy keep working on the same origin. Reads use the app's RPC providers; actions go
 * to this deployment's own relayers (a relayer serves one manager).
 */
export interface LegacyDeployment {
  manager: Hex;
  /** Where label scans of its event logs start (labels only). */
  deploymentBlock: number;
  /** Its relayers, tried in order; empty = nothing can be sent for its committees. */
  relayerUrls: string[];
  /** Operator's name for it (e.g. "2026 rehearsal"); display only. */
  label?: string;
}

export interface AppConfig {
  chainId: number;
  /** The current deployment: new committees are created here. */
  manager: Hex;
  rpcUrls: string[];
  /**
   * The current deployment's relayers, tried in order (the next one when one is down, busy, out
   * of budget or not sponsoring). Empty = no relayer: direct sending (dev mode only).
   * config.json accepts `relayerUrl` (one URL or null) and/or `relayerUrls`.
   */
  relayerUrls: string[];
  /**
   * Mirrors for the pinned circuit artifacts, tried in order (every copy is checked against the
   * SDK's sha256 pins, so any mirror is as good as the original); `{release}` is replaced with
   * the release tag. Empty = the canonical release URL. config.json accepts `artifactsBaseUrl`
   * (one URL or null) and/or `artifactsBaseUrls`.
   */
  artifactsBaseUrls: string[];
  /**
   * The block the manager was deployed at: where a scan of event logs starts when the
   * committee's own creation block is not known (labels only; nothing critical reads logs).
   */
  deploymentBlock: number;
  /** Older managers on this chain still served (current first is `manager`). */
  legacyDeployments: LegacyDeployment[];
  /** Blocks per eth_getLogs request of those scans (default 10,000; halved when a provider refuses). */
  logChunkBlocks?: number;
  /** Explicit local development declaration (permits a single RPC). */
  devMode: boolean;
  /** Dev only: funded key for direct sending when no relayer runs. */
  devPrivateKey?: Hex;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(`config.json: ${message}`);
    this.name = 'ConfigError';
  }
}

const isHexAddress = (v: unknown): v is Hex => typeof v === 'string' && /^0x[0-9a-fA-F]{40}$/.test(v);

/** scheme/host lowercased, trailing slash dropped: what "the same endpoint" means. */
function normalizeUrl(u: string, what: string): string {
  try {
    const parsed = new URL(u);
    return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
  } catch {
    throw new ConfigError(`invalid ${what} URL ${u}`);
  }
}

/**
 * A list of http(s) URLs from `singular` (a string, or null/absent) and/or `plural` (an array),
 * singular first, in order, without duplicates (a repeated entry is a configuration mistake).
 */
function urlList(o: Record<string, unknown>, singular: string, plural: string, what: string): string[] {
  const one = o[singular];
  const many = o[plural];
  if (one !== null && one !== undefined && typeof one !== 'string') {
    throw new ConfigError(`${singular} must be a URL string or null`);
  }
  if (many !== undefined && !(Array.isArray(many) && many.every((u) => typeof u === 'string'))) {
    throw new ConfigError(`${plural} must be an array of URL strings`);
  }
  const urls = [...(typeof one === 'string' && one.trim() !== '' ? [one] : []), ...((many as string[] | undefined) ?? [])];
  for (const u of urls) {
    if (!/^https?:\/\//i.test(u)) throw new ConfigError(`${plural} entries must be http(s) URLs (${u})`);
  }
  const normalized = urls.map((u) => normalizeUrl(u.replace('{release}', 'release'), what));
  if (new Set(normalized).size !== normalized.length) throw new ConfigError(`${plural} lists the same URL twice`);
  return urls;
}

function blockNumber(v: unknown, what: string): number {
  const b = v ?? 0;
  if (typeof b !== 'number' || !Number.isInteger(b) || b < 0) throw new ConfigError(`${what} must be a non-negative integer`);
  return b;
}

/** Validate a parsed config.json object. Throws ConfigError on any problem. */
export function validateConfig(raw: unknown): AppConfig {
  if (typeof raw !== 'object' || raw === null) throw new ConfigError('not an object');
  const o = raw as Record<string, unknown>;

  if (typeof o.chainId !== 'number' || !Number.isInteger(o.chainId) || o.chainId <= 0) {
    throw new ConfigError('chainId must be a positive integer');
  }
  if (!isHexAddress(o.manager)) throw new ConfigError('manager must be a 0x address');
  if (!Array.isArray(o.rpcUrls) || o.rpcUrls.length === 0 || !o.rpcUrls.every((u) => typeof u === 'string' && /^https?:\/\//i.test(u))) {
    throw new ConfigError('rpcUrls must be a non-empty array of http(s) URLs');
  }
  const devMode = o.devMode === true;
  if (o.rpcUrls.length < 2 && !devMode) {
    throw new ConfigError(
      'rpcUrls must list at least two independently administered providers; a single one is only allowed with "devMode": true (local development)',
    );
  }
  if (devMode && o.chainId !== 31337 && o.chainId !== 1337) {
    throw new ConfigError('devMode is only allowed on a local development chain (31337 or 1337)');
  }
  const normalizedUrls = (o.rpcUrls as string[]).map((u) => normalizeUrl(u, 'RPC'));
  if (new Set(normalizedUrls).size !== normalizedUrls.length) {
    throw new ConfigError('rpcUrls lists the same endpoint twice — the providers must be independent');
  }
  const relayerUrls = urlList(o, 'relayerUrl', 'relayerUrls', 'relayer');
  const artifactsBaseUrls = urlList(o, 'artifactsBaseUrl', 'artifactsBaseUrls', 'artifacts');
  const deploymentBlock = blockNumber(o.deploymentBlock, 'deploymentBlock');
  const logChunkBlocks = o.logChunkBlocks;
  if (
    logChunkBlocks !== undefined &&
    (typeof logChunkBlocks !== 'number' || !Number.isInteger(logChunkBlocks) || logChunkBlocks < 1 || logChunkBlocks > 1_000_000)
  ) {
    throw new ConfigError('logChunkBlocks must be an integer between 1 and 1,000,000');
  }
  if (o.devPrivateKey !== undefined && !(typeof o.devPrivateKey === 'string' && /^0x[0-9a-fA-F]{64}$/.test(o.devPrivateKey))) {
    throw new ConfigError('devPrivateKey must be a 32-byte 0x-hex string');
  }
  if (o.devPrivateKey !== undefined && !devMode) {
    throw new ConfigError('devPrivateKey is only allowed with "devMode": true');
  }
  const manager = o.manager.toLowerCase() as Hex;
  const legacyDeployments = legacyList(o.legacyDeployments, o.chainId, manager);
  return {
    chainId: o.chainId,
    manager,
    rpcUrls: o.rpcUrls as string[],
    relayerUrls,
    artifactsBaseUrls,
    deploymentBlock,
    legacyDeployments,
    ...(logChunkBlocks === undefined ? {} : { logChunkBlocks }),
    devMode,
    devPrivateKey: o.devPrivateKey as Hex | undefined,
  };
}

function legacyList(raw: unknown, chainId: number, current: Hex): LegacyDeployment[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw)) throw new ConfigError('legacyDeployments must be an array');
  const seen = new Set<string>([current]);
  return raw.map((entry, i) => {
    const at = `legacyDeployments[${i}]`;
    if (typeof entry !== 'object' || entry === null) throw new ConfigError(`${at} must be an object`);
    const d = entry as Record<string, unknown>;
    if (!isHexAddress(d.manager)) throw new ConfigError(`${at}.manager must be a 0x address`);
    const manager = d.manager.toLowerCase() as Hex;
    if (seen.has(manager)) throw new ConfigError(`${at}.manager is listed twice (or is the current manager)`);
    seen.add(manager);
    if (d.chainId !== undefined && d.chainId !== chainId) {
      throw new ConfigError(`${at}.chainId must be the app's chain (${chainId}): legacy deployments share its providers`);
    }
    if (d.label !== undefined && typeof d.label !== 'string') throw new ConfigError(`${at}.label must be a string`);
    return {
      manager,
      deploymentBlock: blockNumber(d.deploymentBlock, `${at}.deploymentBlock`),
      relayerUrls: urlList(d, 'relayerUrl', 'relayerUrls', `${at} relayer`),
      ...(typeof d.label === 'string' && d.label.trim() !== '' ? { label: d.label.trim() } : {}),
    };
  });
}

/** The config one legacy deployment's services run with: the app's chain and providers, its manager and relayers. */
export function legacyConfig(config: AppConfig, legacy: LegacyDeployment): AppConfig {
  return {
    ...config,
    manager: legacy.manager,
    deploymentBlock: legacy.deploymentBlock,
    relayerUrls: legacy.relayerUrls,
    legacyDeployments: [],
  };
}

/** Comma-separated env override → URL list. */
const envList = (v: string): string[] =>
  v
    .split(',')
    .map((u) => u.trim())
    .filter((u) => u !== '');

/**
 * Fetch and validate the runtime config. Build-time env can pick another
 * file from `public/` and fill its placeholder URLs — `make ui-sepolia
 * RELAYER_URL=… ARTIFACTS_URL=…` serves `config.sepolia.json` this way (each
 * may list several URLs, comma-separated, tried in order).
 * Production builds set none of these and read `/config.json` as before.
 */
export async function loadConfig(fetchFn: typeof fetch = fetch): Promise<AppConfig> {
  const env: Record<string, string | undefined> = import.meta.env ?? {};
  const res = await fetchFn(env.VITE_CONFIG || '/config.json', { cache: 'no-cache' });
  if (!res.ok) throw new ConfigError(`HTTP ${res.status}`);
  const raw: unknown = await res.json();
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>;
    if (env.VITE_RELAYER_URL) {
      delete o.relayerUrl;
      o.relayerUrls = envList(env.VITE_RELAYER_URL);
    }
    if (env.VITE_ARTIFACTS_URL) {
      delete o.artifactsBaseUrl;
      o.artifactsBaseUrls = envList(env.VITE_ARTIFACTS_URL);
    }
  }
  return validateConfig(raw);
}
