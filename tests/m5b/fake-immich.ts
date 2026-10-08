import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

export type UploadMode = 'normal' | 'uncertain' | 'corrupt';

/**
 * A fake Immich that really keeps the uploaded bytes, so that the readback of the original compares what
 * was sent. (The M3 fake returns fixed bytes and cannot catch a transfer of the wrong data.)
 */
export class FakeImmich {
  readonly assets = new Map<string, Buffer>();
  uploads = 0;
  mode: UploadMode;
  private readonly server = createServer((request, response) => void this.route(request, response));

  constructor(mode: UploadMode = 'normal') {
    this.mode = mode;
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('fake immich did not bind');
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  private json(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://fake').pathname;
    if (path === '/api/server/ping') return this.json(response, 200, { ping: 'pong' });
    if (path === '/api/server/version') return this.json(response, 200, { major: 3, minor: 2, patch: 1, prerelease: null });
    if (path === '/api/users/me') return this.json(response, 200, { id: 'fake-account' });
    if (path === '/api/assets/bulk-upload-check') return this.json(response, 200, { results: [] });
    if (path === '/api/assets' && request.method === 'POST') return this.upload(request, response);
    const match = /^\/api\/assets\/([^/]+)(?:\/(original))?$/.exec(path);
    if (match) {
      const asset = this.assets.get(match[1]!);
      if (!asset) return this.json(response, 404, {});
      if (match[2] === 'original') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(asset);
        return;
      }
      return this.json(response, 200, { id: match[1], ownerId: 'fake-account' });
    }
    return this.json(response, 404, {});
  }

  private async upload(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.uploads += 1;
    if (this.mode === 'uncertain') {
      request.once('data', () => request.socket.destroy());
      return;
    }
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const boundary = /boundary=(.+)$/.exec(String(request.headers['content-type']))?.[1];
    if (!boundary) return this.json(response, 400, {});
    const bytes = extractFilePart(Buffer.concat(chunks), boundary);
    const id = `asset-${this.assets.size + 1}`;
    this.assets.set(id, this.mode === 'corrupt' ? Buffer.concat([bytes, Buffer.from('!')]) : bytes);
    return this.json(response, 201, { id, status: 'created' });
  }
}

/** Returns the content of the `assetData` part of a multipart/form-data body. */
function extractFilePart(body: Buffer, boundary: string): Buffer {
  const marker = Buffer.from('name="assetData"');
  const nameAt = body.indexOf(marker);
  const contentStart = body.indexOf(Buffer.from('\r\n\r\n'), nameAt) + 4;
  const contentEnd = body.indexOf(Buffer.from(`\r\n--${boundary}`), contentStart);
  return body.subarray(contentStart, contentEnd);
}
