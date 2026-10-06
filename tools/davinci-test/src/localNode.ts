/**
 * A local stand-in for a sequencer node, for chains without one (Anvil):
 *
 * - `GET /info` reports the chain, the registry and the pins the registry holds, so
 *   `DavinciSDK.init()` accepts it. It says `observer: true`: it takes no votes and issues no
 *   keys, which a COUNCIL process never asks a node for.
 * - It hosts what the SDK uploads (the census file and the metadata document) under
 *   `/files/<sha256>.json`, for as long as this process runs.
 *
 * Everything else is 404. Real deployments pass their nodes' URLs and an uploader instead.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { ProcessRegistryService, Uploader, UploadRequest } from '@vocdoni/davinci-sdk';

export class LocalNode {
  private readonly files = new Map<string, { body: Uint8Array; contentType: string }>();
  private readonly server = createServer((req, res) => this.handle(req, res));

  private constructor(private readonly info: Record<string, unknown>) {}

  /** A node for `registry`'s deployment on a free loopback port. */
  static async start(registry: ProcessRegistryService): Promise<LocalNode> {
    const [chainId, ballotVkHash, batchProgramVk, resultsProgramVk] = await Promise.all([
      registry.getChainID(),
      registry.getBallotVKHash(),
      registry.getBatchProgramVK(),
      registry.getResultsProgramVK(),
    ]);
    const node = new LocalNode({
      sequencerAddress: null,
      chainId: Number(chainId),
      processRegistry: registry.address,
      ballotVkHash,
      batchProgramVk,
      resultsProgramVk,
      observer: true,
      settledBySelf: 0,
      syncedFromOthers: 0,
      lostRaces: 0,
    });
    await new Promise<void>((ok) => node.server.listen(0, '127.0.0.1', ok));
    return node;
  }

  get url(): string {
    return `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  readonly uploader: Uploader = {
    upload: async (request: UploadRequest) => {
      const path = `/files/${request.sha256.slice(2)}.json`;
      this.files.set(path, { body: request.data, contentType: request.contentType });
      return `${this.url}${path}`;
    },
  };

  close(): Promise<void> {
    this.server.closeAllConnections();
    return new Promise((ok) => this.server.close(() => ok()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const path = new URL(req.url ?? '/', this.url).pathname;
    const file = req.method === 'GET' ? this.files.get(path) : undefined;
    if (file) {
      res.writeHead(200, { 'content-type': file.contentType });
      res.end(file.body);
      return;
    }
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    if (req.method === 'GET' && path === '/info') return json(200, this.info);
    if (req.method === 'GET' && path === '/ping') return json(200, {});
    json(404, { error: 'not found', code: 40401 });
  }
}
