#!/usr/bin/env node
/**
 * Minimal local-dev relayer: accepts the SDK's §5.1 wire format, rebuilds the
 * typed action, and sends it from a funded Anvil account. Not for production
 * (no policy checks, no rate limiting, no persistence).
 *
 *   MANAGER=0x… node scripts/mock-relayer.mjs
 *   env: RPC_URL (default http://127.0.0.1:8545), CHAIN_ID (31337),
 *        PORT (8788), RELAYER_KEY (Anvil account #0)
 */

import http from 'node:http';
import { CouncilClient } from '@vocdoni/davinci-dkg-council-sdk';
import { createPublicClient, createWalletClient, defineChain, http as viemHttp } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

const RPC_URL = process.env.RPC_URL ?? 'http://127.0.0.1:8545';
const CHAIN_ID = Number(process.env.CHAIN_ID ?? 31337);
const PORT = Number(process.env.PORT ?? 8788);
const MANAGER = process.env.MANAGER;
const RELAYER_KEY =
  process.env.RELAYER_KEY ?? '0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80';

if (!MANAGER) {
  console.error('mock-relayer: set MANAGER=0x… (the CouncilManager address)');
  process.exit(1);
}

const chain = defineChain({
  id: CHAIN_ID,
  name: 'local',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [RPC_URL] } },
});
const account = privateKeyToAccount(RELAYER_KEY);
const wallet = createWalletClient({ account, chain, transport: viemHttp(RPC_URL) });
const publicClient = createPublicClient({ chain, transport: viemHttp(RPC_URL) });
const client = new CouncilClient({
  chainId: BigInt(CHAIN_ID),
  manager: MANAGER,
  rpcUrls: [RPC_URL],
  devMode: true,
});

// --- wire decoding (inverse of the SDK's relayRequestBody) ---

const toBig = (v) => (typeof v === 'string' && /^(0|[1-9][0-9]*)$/.test(v) ? BigInt(v) : v);
const msg = (m) => Object.fromEntries(Object.entries(m).map(([k, v]) => [k, Array.isArray(v) ? v.map(toBig) : toBig(v)]));
const point = ([x, y]) => ({ x: BigInt(x), y: BigInt(y) });
const proof = (p) => ({ pA: p.pA.map(BigInt), pB: p.pB.map((r) => r.map(BigInt)), pC: p.pC.map(BigInt) });

function decodeAction(body) {
  switch (body.action) {
    case 'createCeremony':
    case 'addInvites':
    case 'closeRegistration':
    case 'allowAdapter':
    case 'authorizeCreator':
      return { kind: body.action, message: msg(body.message), signature: body.signatures[0] };
    case 'join':
      return {
        kind: 'join',
        message: msg(body.message.join),
        invite: msg(body.message.invite),
        signature: body.signatures[0],
        inviteSignature: body.signatures[1],
      };
    case 'deal':
      return {
        kind: 'deal',
        message: msg(body.message),
        signature: body.signatures[0],
        payload: {
          C: body.payload.C.map(point),
          E: point(body.payload.E),
          masked: body.payload.masked.map(BigInt),
          proof: proof(body.payload.proof),
        },
      };
    case 'submitPartial':
      return {
        kind: 'submitPartial',
        message: msg(body.message),
        signature: body.signatures[0],
        payload: { D: body.payload.D.map(point), proof: proof(body.payload.proof) },
      };
    case 'finalize':
    case 'abort':
      return { kind: body.action, ceremonyId: body.payload.ceremonyId };
    case 'combine':
      return {
        kind: 'combine',
        requestId: body.payload.requestId,
        memberSet: body.payload.memberSet,
        fieldIndexes: body.payload.fieldIndexes,
        plaintexts: body.payload.plaintexts.map(BigInt),
      };
    default:
      throw new Error(`unknown action ${body.action}`);
  }
}

// --- http server ---

const json = (res, status, body) => {
  res.writeHead(status, {
    'content-type': 'application/json',
    'access-control-allow-origin': '*',
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET, POST, OPTIONS',
  });
  res.end(JSON.stringify(body));
};

const readBody = (req) =>
  new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => (data += c));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (err) {
        reject(err);
      }
    });
    req.on('error', reject);
  });

http
  .createServer(async (req, res) => {
    try {
      if (req.method === 'OPTIONS') return json(res, 204, {});
      if (req.method === 'GET' && req.url === '/v1/health') {
        const balanceWei = (await publicClient.getBalance({ address: account.address })).toString();
        return json(res, 200, { ok: true, chainId: String(CHAIN_ID), manager: MANAGER, relayer: account.address, balanceWei });
      }
      if (req.method === 'GET' && req.url?.startsWith('/v1/status/')) {
        const txHash = req.url.slice('/v1/status/'.length);
        try {
          const receipt = await publicClient.getTransactionReceipt({ hash: txHash });
          return json(res, 200, {
            status: receipt.status === 'success' ? 'confirmed' : 'failed',
            blockNumber: receipt.blockNumber.toString(),
          });
        } catch {
          return json(res, 200, { status: 'pending' });
        }
      }
      if (req.method === 'POST' && req.url === '/v1/relay') {
        const body = await readBody(req);
        if (body.chainId !== String(CHAIN_ID)) {
          return json(res, 400, { error: 'WRONG_CHAIN', detail: `expected chainId ${CHAIN_ID}` });
        }
        const { to, data } = client.actionCalldata(decodeAction(body));
        const txHash = await wallet.sendTransaction({ to, data });
        console.log(`[mock-relayer] ${body.action} -> ${txHash}`);
        return json(res, 200, { txHash });
      }
      return json(res, 404, { error: 'NOT_FOUND', detail: req.url });
    } catch (err) {
      console.error('[mock-relayer]', err);
      return json(res, 500, { error: 'INTERNAL', detail: err instanceof Error ? err.message : String(err) });
    }
  })
  .listen(PORT, () => {
    console.log(`mock relayer on http://127.0.0.1:${PORT} (chain ${CHAIN_ID}, manager ${MANAGER}, from ${account.address})`);
  });
