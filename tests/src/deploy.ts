/** Contract artifacts (`solidity/out`) and deployment with viem. */

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import {
  circuitReleaseId,
  COUNCIL_ARTIFACTS,
  verifyArtifactBytes,
  type Hex,
} from '@vocdoni/davinci-dkg-council-sdk';
import { keccak256, type Abi, type PublicClient, type WalletClient } from 'viem';
import { ARTIFACTS_DIR, CONTRACTS_DIR } from './infra.js';

export interface Artifact {
  abi: Abi;
  bytecode: Hex;
}

export function loadArtifact(file: string, contract: string): Artifact {
  const json = JSON.parse(readFileSync(path.join(CONTRACTS_DIR, 'out', file, `${contract}.json`), 'utf8')) as {
    abi: Abi;
    bytecode: { object: Hex; linkReferences?: Record<string, unknown> };
  };
  if (json.bytecode.linkReferences && Object.keys(json.bytecode.linkReferences).length > 0) {
    throw new Error(`${contract}: library linking is not supported`);
  }
  return { abi: json.abi, bytecode: json.bytecode.object };
}

/**
 * Check every local dev artifact against the SDK pins and derive the circuit release id from
 * the byte-exact vkey files (protocol §4.4); it must match the release manifest.
 */
export function devCircuitRelease(): { releaseId: Hex; wasm: Record<'deal' | 'partial', string>; zkey: Record<'deal' | 'partial', string> } {
  const files = { wasm: { deal: '', partial: '' }, zkey: { deal: '', partial: '' } };
  for (const circuit of ['deal', 'partial'] as const) {
    for (const kind of ['wasm', 'zkey', 'vkey'] as const) {
      const pin = COUNCIL_ARTIFACTS[circuit][kind];
      const file = path.join(ARTIFACTS_DIR, pin.url.slice(pin.url.lastIndexOf('/') + 1));
      verifyArtifactBytes(pin, new Uint8Array(readFileSync(file)));
      if (kind !== 'vkey') files[kind][circuit] = file;
    }
  }
  const vkeyDigest = (name: string): Hex =>
    `0x${createHash('sha256').update(readFileSync(path.join(ARTIFACTS_DIR, name))).digest('hex')}`;
  const releaseId = circuitReleaseId(vkeyDigest('deal_vkey.json'), vkeyDigest('partial_vkey.json'));
  const manifest = JSON.parse(readFileSync(path.join(ARTIFACTS_DIR, 'release.json'), 'utf8')) as { circuitReleaseId: Hex };
  if (manifest.circuitReleaseId !== releaseId) {
    throw new Error(`circuit release id mismatch: vkeys give ${releaseId}, release.json says ${manifest.circuitReleaseId}`);
  }
  return { releaseId, ...files };
}

export async function deploy(
  wallet: WalletClient,
  client: PublicClient,
  artifact: Artifact,
  args: readonly unknown[] = [],
): Promise<Hex> {
  const hash = await wallet.deployContract({
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    args,
    account: wallet.account ?? null,
    chain: wallet.chain,
  } as never);
  const receipt = await client.waitForTransactionReceipt({ hash });
  if (receipt.status !== 'success' || !receipt.contractAddress) throw new Error('deployment failed');
  return receipt.contractAddress.toLowerCase() as Hex;
}

export interface CouncilDeployment {
  manager: Hex;
  dealVerifier: Hex;
  partialVerifier: Hex;
}

/** A bytes32 constant pinned in `script/CouncilRelease.sol`. */
function releasePin(name: string): Hex {
  const src = readFileSync(path.join(CONTRACTS_DIR, 'script', 'CouncilRelease.sol'), 'utf8');
  const m = new RegExp(`${name}\\s*=\\s*(0x[0-9a-fA-F]{64})`).exec(src);
  if (!m) throw new Error(`CouncilRelease.sol: ${name} not found`);
  return (m[1] as string).toLowerCase() as Hex;
}

/**
 * DealVerifier + PartialVerifier (generated, real) + CouncilManager bound to the dev release
 * id, held to the same pins as `script/Deploy.s.sol`: the release id and the verifiers' runtime
 * code hashes in `script/CouncilRelease.sol`.
 */
export async function deployCouncil(wallet: WalletClient, client: PublicClient, releaseId: Hex): Promise<CouncilDeployment> {
  if (releaseId !== releasePin('CIRCUIT_RELEASE_ID')) throw new Error('circuit release id differs from CouncilRelease.sol');
  const dealVerifier = await deploy(wallet, client, loadArtifact('DealVerifier.sol', 'DealVerifier'));
  const partialVerifier = await deploy(wallet, client, loadArtifact('PartialVerifier.sol', 'PartialVerifier'));
  for (const [address, pin] of [
    [dealVerifier, 'DEAL_VERIFIER_CODEHASH'],
    [partialVerifier, 'PARTIAL_VERIFIER_CODEHASH'],
  ] as const) {
    const code = await client.getCode({ address });
    if (!code || keccak256(code) !== releasePin(pin)) throw new Error(`${pin}: deployed verifier code differs from the pin`);
  }
  const manager = await deploy(wallet, client, loadArtifact('CouncilManager.sol', 'CouncilManager'), [
    dealVerifier,
    partialVerifier,
    releaseId,
  ]);
  return { manager, dealVerifier, partialVerifier };
}
