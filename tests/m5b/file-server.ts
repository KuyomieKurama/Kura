import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

export interface ServedFile {
  body: Buffer;
  contentType: string;
  etag?: string;
  /** Default 200. */
  status?: number;
  /** Extra response headers (for example retry-after). */
  headers?: Record<string, string>;
  /** Send this many bytes, then wait for `release()` before sending the rest. */
  stallAfterBytes?: number;
  /**
   * Which requests to this path stall (1-based). The direct URL adapter asks four times before it
   * delivers bytes (probe, discover, resolve, download), so the download is the fourth request.
   * Default: all of them.
   */
  stallRequests?: number[];
}

/** A plain HTTP server on loopback that serves files. Tests reach it through an injected fetcher. */
export class FileServer {
  readonly requests: Array<{ method: string; path: string }> = [];
  private readonly files = new Map<string, ServedFile>();
  private readonly server: Server = createServer((request, response) => void this.route(request, response));
  private releaseStalled: (() => void) | undefined;
  private stalled = new Promise<void>((resolve) => { this.releaseStalled = resolve; });
  port = 0;

  async start(): Promise<void> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('file server did not bind');
    this.port = address.port;
  }

  async stop(): Promise<void> {
    this.release();
    this.server.closeAllConnections();
    await new Promise<void>((resolve, reject) => this.server.close((error) => (error ? reject(error) : resolve())));
  }

  /** The URL a subscription uses. The injected test fetcher turns it into a request to this server. */
  url(path: string): string {
    return `https://127.0.0.1:${this.port}${path}`;
  }

  serve(path: string, file: ServedFile): void {
    this.files.set(path, file);
  }

  release(): void {
    this.releaseStalled?.();
  }

  count(path: string): number {
    return this.requests.filter((request) => request.path === path).length;
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://test').pathname;
    this.requests.push({ method: request.method ?? 'GET', path });
    const file = this.files.get(path);
    if (!file) {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(file.status ?? 200, {
      'content-type': file.contentType,
      'content-length': String(file.body.length),
      ...(file.etag ? { etag: file.etag } : {}),
      ...file.headers
    });
    if (request.method === 'HEAD') {
      response.end();
      return;
    }
    const number = this.count(path);
    const stall = file.stallAfterBytes !== undefined
      && file.stallAfterBytes < file.body.length
      && (file.stallRequests === undefined || file.stallRequests.includes(number));
    if (stall && file.stallAfterBytes !== undefined) {
      response.write(file.body.subarray(0, file.stallAfterBytes));
      await this.stalled;
      if (response.destroyed) return;
      response.end(file.body.subarray(file.stallAfterBytes));
      return;
    }
    response.end(file.body);
  }
}
