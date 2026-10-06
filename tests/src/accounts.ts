/** Anvil's prefunded accounts (default mnemonic), by role. */

import type { Hex } from '@vocdoni/davinci-dkg-council-sdk';
import { createWalletClient, http, toHex, type WalletClient } from 'viem';
import { mnemonicToAccount } from 'viem/accounts';
import { foundry } from 'viem/chains';

const ANVIL_MNEMONIC = 'test test test test test test test test test test test junk';

export const ACCOUNT = { deployer: 0, relayer: 1, direct: 2, registry: 3, creator: 4 } as const;

export const anvilAccount = (index: number) => mnemonicToAccount(ANVIL_MNEMONIC, { addressIndex: index });

export const anvilKey = (index: number): Hex => toHex(anvilAccount(index).getHdKey().privateKey as Uint8Array);

export function walletFor(rpcUrl: string, index: number): WalletClient {
  return createWalletClient({ account: anvilAccount(index), chain: foundry, transport: http(rpcUrl) });
}
