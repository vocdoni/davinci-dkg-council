/**
 * Display-only DAVINCI vote titles: the `title` of the process-metadata document the pinned
 * ProcessRegistry points to. Members read it next to a vote they are asked to unlock, so it is
 * treated like any authenticated value (architecture §9.3): every configured provider must agree
 * on the registry's `(metadataURI, metadataHash)` pair, and the fetched bytes must SHA-256-hash
 * to `metadataHash` before anything from them is shown. Anything off resolves to undefined and
 * the UI falls back to the raw process id.
 */

import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';

/** Served documents are capped on the DAVINCI side at 4 MB; refuse anything bigger. */
const MAX_METADATA_BYTES = 4 * 1024 * 1024;

/** Vendored from DAVINCI's ProcessRegistry ABI (davinci-contracts); decoding needs the full tuple. */
export const GET_PROCESS_ABI = [
  {
    type: 'function',
    name: 'getProcess',
    stateMutability: 'view',
    inputs: [{ name: 'processId', type: 'bytes31' }],
    outputs: [
      {
        name: '',
        type: 'tuple',
        components: [
          { name: 'status', type: 'uint8' },
          { name: 'organizationId', type: 'address' },
          {
            name: 'encryptionKey',
            type: 'tuple',
            components: [
              { name: 'x', type: 'uint256' },
              { name: 'y', type: 'uint256' },
            ],
          },
          { name: 'latestStateRoot', type: 'bytes32' },
          { name: 'result', type: 'uint256[]' },
          { name: 'startTime', type: 'uint256' },
          { name: 'duration', type: 'uint256' },
          { name: 'maxVoters', type: 'uint256' },
          { name: 'votersCount', type: 'uint256' },
          { name: 'overwrittenVotesCount', type: 'uint256' },
          { name: 'creationBlock', type: 'uint256' },
          { name: 'batchNumber', type: 'uint256' },
          { name: 'metadataURI', type: 'string' },
          { name: 'metadataHash', type: 'bytes32' },
          {
            name: 'ballotMode',
            type: 'tuple',
            components: [
              { name: 'uniqueValues', type: 'bool' },
              { name: 'numFields', type: 'uint8' },
              { name: 'groupSize', type: 'uint8' },
              { name: 'costExponent', type: 'uint8' },
              { name: 'maxValue', type: 'uint256' },
              { name: 'minValue', type: 'uint256' },
              { name: 'maxValueSum', type: 'uint256' },
              { name: 'minValueSum', type: 'uint256' },
            ],
          },
          {
            name: 'census',
            type: 'tuple',
            components: [
              { name: 'censusOrigin', type: 'uint8' },
              { name: 'censusRoot', type: 'bytes32' },
              { name: 'contractAddress', type: 'address' },
              { name: 'censusURI', type: 'string' },
              { name: 'onchainAllowAnyValidRoot', type: 'bool' },
            ],
          },
          { name: 'keyMode', type: 'uint8' },
          { name: 'dkgEpochId', type: 'bytes12' },
          { name: 'dkgFirstIndex', type: 'uint16' },
          { name: 'dkgCount', type: 'uint8' },
          { name: 'dkgZeroSkipped', type: 'uint16' },
          { name: 'dkgResultsRequested', type: 'bool' },
          { name: 'dkgAid', type: 'bytes32' },
          { name: 'grace', type: 'uint32' },
          { name: 'lastVoteAt', type: 'uint64' },
        ],
      },
    ],
  },
] as const;

/** The slice of a viem client this module reads with (tests inject fakes). */
export interface ProcessReader {
  readContract(args: {
    address: Hex;
    abi: typeof GET_PROCESS_ABI;
    functionName: 'getProcess';
    args: readonly [Hex];
  }): Promise<unknown>;
}

interface MetaPointer {
  metadataURI: string;
  metadataHash: Hex;
}

export async function fetchVoteTitle(
  clients: ProcessReader[],
  registry: Hex,
  processId: Hex,
  fetchFn: typeof fetch = fetch,
): Promise<string | undefined> {
  const results = await Promise.allSettled(
    clients.map(
      (c) =>
        c.readContract({ address: registry, abi: GET_PROCESS_ABI, functionName: 'getProcess', args: [processId] }) as Promise<MetaPointer>,
    ),
  );
  const ok = results.filter((r): r is PromiseFulfilledResult<MetaPointer> => r.status === 'fulfilled').map((r) => r.value);
  const first = ok[0];
  if (!first) return undefined;
  const uri = first.metadataURI;
  const hash = first.metadataHash.toLowerCase();
  // Cosmetic, but every provider that answered must tell the same story (§9.3).
  if (ok.some((p) => p.metadataURI !== uri || p.metadataHash.toLowerCase() !== hash)) return undefined;
  if (BigInt(hash) === 0n || !/^https?:\/\//i.test(uri)) return undefined;

  const res = await fetchFn(uri, { redirect: 'error', credentials: 'omit' });
  if (!res.ok) return undefined;
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.length > MAX_METADATA_BYTES) return undefined;
  // The registry's hash is the trust anchor: show nothing a provider did not commit to.
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  const hex = `0x${Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('')}`;
  if (hex !== hash) return undefined;

  const doc: unknown = JSON.parse(new TextDecoder().decode(bytes));
  const raw = (doc as { title?: unknown })?.title;
  const text =
    typeof raw === 'string' ? raw : typeof (raw as { default?: unknown })?.default === 'string' ? (raw as { default: string }).default : undefined;
  const trimmed = text?.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 120 ? `${trimmed.slice(0, 119)}…` : trimmed;
}

/** Per-process memoized titles; a miss (undefined) is retried on the next ask. */
export function makeVoteTitle(
  clients: ProcessReader[],
  registry: Hex,
  fetchFn: typeof fetch = fetch,
): (processId: Hex) => Promise<string | undefined> {
  const cache = new Map<string, Promise<string | undefined>>();
  return (processId) => {
    const key = processId.toLowerCase();
    let p = cache.get(key);
    if (!p) {
      p = fetchVoteTitle(clients, registry, processId, fetchFn).catch(() => undefined);
      void p.then((t) => {
        if (t === undefined) cache.delete(key);
      });
      cache.set(key, p);
    }
    return p;
  };
}
