import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface FakeRequest {
  method: string;
  path: string;
  query: string;
  headers: IncomingMessage['headers'];
}

type Responder = (request: FakeRequest, response: ServerResponse) => void;

/** A local HTTP server that plays the GitHub REST API. Tests never reach the real network. */
export class FakeGithub {
  readonly requests: FakeRequest[] = [];
  private readonly routes = new Map<string, Responder>();
  private server: Server | undefined;
  apiBase = '';

  /** `path` is matched against the request path without query string, e.g. /repos/o/r/tags */
  on(path: string, responder: Responder): this {
    this.routes.set(path, responder);
    return this;
  }

  json(path: string, body: unknown, status = 200, headers: Record<string, string> = {}): this {
    return this.on(path, (_request, response) => {
      response.writeHead(status, { 'content-type': 'application/json', ...headers });
      response.end(JSON.stringify(body));
    });
  }

  requestsTo(path: string): FakeRequest[] {
    return this.requests.filter((request) => request.path === path);
  }

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      const url = new URL(request.url ?? '/', 'http://fake');
      const record = { method: request.method ?? 'GET', path: url.pathname, query: url.search, headers: request.headers };
      this.requests.push(record);
      const responder = this.routes.get(url.pathname);
      if (!responder) {
        response.writeHead(404, { 'content-type': 'application/json' });
        response.end('{"message":"Not Found"}');
        return;
      }
      responder(record, response);
    });
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.apiBase = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }
}
