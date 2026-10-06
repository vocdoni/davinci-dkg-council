/**
 * Runtime configuration from `public/config.json` (architecture §6).
 *
 * `rpcUrls` must list at least two independently administered providers on a
 * production chain — protocol §9.3's authenticated-read rule depends on it. A
 * single entry is accepted only together with an explicit local/dev
 * declaration (`devMode: true`, e.g. Anvil on chain 31337).
 */

import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';

export interface AppConfig {
  chainId: number;
  manager: Hex;
  rpcUrls: string[];
  /** null = no relayer: direct sending (dev mode only). */
  relayerUrl: string | null;
  /** Mirror for the pinned circuit artifacts; null = canonical release URL. */
  artifactsBaseUrl: string | null;
  /**
   * The block the manager was deployed at: where a scan of event logs starts when the
   * committee's own creation block is not known (labels only; nothing critical reads logs).
   */
  deploymentBlock: number;
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
  const normalizedUrls = (o.rpcUrls as string[]).map((u) => {
    try {
      const parsed = new URL(u);
      return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
    } catch {
      throw new ConfigError(`invalid RPC URL ${u}`);
    }
  });
  if (new Set(normalizedUrls).size !== normalizedUrls.length) {
    throw new ConfigError('rpcUrls lists the same endpoint twice — the providers must be independent');
  }
  if (o.relayerUrl !== null && o.relayerUrl !== undefined && typeof o.relayerUrl !== 'string') {
    throw new ConfigError('relayerUrl must be a URL string or null');
  }
  if (o.artifactsBaseUrl !== null && o.artifactsBaseUrl !== undefined && typeof o.artifactsBaseUrl !== 'string') {
    throw new ConfigError('artifactsBaseUrl must be a URL string or null');
  }
  const deploymentBlock = o.deploymentBlock ?? 0;
  if (typeof deploymentBlock !== 'number' || !Number.isInteger(deploymentBlock) || deploymentBlock < 0) {
    throw new ConfigError('deploymentBlock must be a non-negative integer');
  }
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
  return {
    chainId: o.chainId,
    manager: o.manager.toLowerCase() as Hex,
    rpcUrls: o.rpcUrls as string[],
    relayerUrl: (o.relayerUrl as string | undefined) ?? null,
    artifactsBaseUrl: (o.artifactsBaseUrl as string | undefined) ?? null,
    deploymentBlock,
    ...(logChunkBlocks === undefined ? {} : { logChunkBlocks }),
    devMode,
    devPrivateKey: o.devPrivateKey as Hex | undefined,
  };
}

/**
 * Fetch and validate the runtime config. Build-time env can pick another
 * file from `public/` and fill its placeholder URLs — `make ui-sepolia
 * RELAYER_URL=… ARTIFACTS_URL=…` serves `config.sepolia.json` this way.
 * Production builds set none of these and read `/config.json` as before.
 */
export async function loadConfig(fetchFn: typeof fetch = fetch): Promise<AppConfig> {
  const env: Record<string, string | undefined> = import.meta.env ?? {};
  const res = await fetchFn(env.VITE_CONFIG || '/config.json', { cache: 'no-cache' });
  if (!res.ok) throw new ConfigError(`HTTP ${res.status}`);
  const raw: unknown = await res.json();
  if (typeof raw === 'object' && raw !== null) {
    const o = raw as Record<string, unknown>;
    if (env.VITE_RELAYER_URL) o.relayerUrl = env.VITE_RELAYER_URL;
    if (env.VITE_ARTIFACTS_URL) o.artifactsBaseUrl = env.VITE_ARTIFACTS_URL;
  }
  return validateConfig(raw);
}
