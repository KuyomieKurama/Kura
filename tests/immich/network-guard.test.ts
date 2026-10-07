import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyAddress,
  createGuardedFetch,
  ImmichTargetBlockedError,
  normalizeEndpoint,
  type EndpointApprovals
} from '../../packages/immich-client/src/index.js';

describe('classifyAddress', () => {
  it.each([
    ['8.8.8.8', 'public'],
    ['93.184.216.34', 'public'],
    ['2606:4700:4700::1111', 'public'],
    ['127.0.0.1', 'approval-required'],
    ['10.1.2.3', 'approval-required'],
    ['172.16.0.1', 'approval-required'],
    ['172.31.255.255', 'approval-required'],
    ['192.168.178.20', 'approval-required'],
    ['100.64.0.1', 'approval-required'],
    ['::1', 'approval-required'],
    ['fd12:3456:789a::1', 'approval-required'],
    ['::ffff:10.0.0.5', 'approval-required'],
    ['::ffff:7f00:1', 'approval-required'],
    ['172.32.0.1', 'public'],
    ['169.254.169.254', 'always-blocked'],
    ['169.254.0.1', 'always-blocked'],
    ['100.100.100.200', 'always-blocked'],
    ['0.0.0.0', 'always-blocked'],
    ['224.0.0.1', 'always-blocked'],
    ['255.255.255.255', 'always-blocked'],
    ['fe80::1', 'always-blocked'],
    ['fe80::1%eth0', 'always-blocked'],
    ['fd00:ec2::254', 'always-blocked'],
    ['::', 'always-blocked'],
    ['ff02::1', 'always-blocked'],
    ['::ffff:169.254.169.254', 'always-blocked'],
    ['::ffff:a9fe:a9fe', 'always-blocked'],
    ['64:ff9b::a9fe:a9fe', 'always-blocked'],
    ['not-an-address', 'always-blocked']
  ])('%s is %s', (address, expected) => {
    expect(classifyAddress(address)).toBe(expected);
  });
});

describe('normalizeEndpoint', () => {
  it('lower-cases hosts, accepts IPv6 with or without brackets and rejects malformed input', () => {
    expect(normalizeEndpoint('Immich.LAN', 2283)).toEqual({ host: 'immich.lan', port: 2283 });
    expect(normalizeEndpoint('::1', 2283)).toEqual({ host: '::1', port: 2283 });
    expect(normalizeEndpoint('[::1]', 2283)).toEqual({ host: '::1', port: 2283 });
    expect(normalizeEndpoint('10.0.0.5', 80)).toEqual({ host: '10.0.0.5', port: 80 });
    for (const bad of ['', 'a/b', 'user@host', 'host?x', 'host name']) expect(normalizeEndpoint(bad, 80)).toBeUndefined();
    for (const port of [0, 65_536, 1.5, Number.NaN]) expect(normalizeEndpoint('immich.lan', port)).toBeUndefined();
  });
});

class Listener {
  hits = 0;
  paths: string[] = [];
  private readonly server = createServer((request, response) => { this.handle(request, response); });
  constructor(private readonly respond: (request: IncomingMessage, response: ServerResponse) => void) {}

  private handle(request: IncomingMessage, response: ServerResponse): void {
    this.hits += 1;
    this.paths.push(request.url ?? '');
    this.respond(request, response);
  }

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('listener did not bind');
    return address.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

function approvalsFor(...approved: string[]): EndpointApprovals {
  return { isApproved: async (host, port) => approved.includes(`${host}:${port}`) };
}

const ok = (_request: IncomingMessage, response: ServerResponse) => {
  response.writeHead(200, { 'content-type': 'text/plain' });
  response.end('pong');
};

describe('guarded fetch', () => {
  const listeners: Listener[] = [];
  afterEach(async () => { await Promise.all(listeners.splice(0).map((listener) => listener.stop())); });

  async function listen(respond = ok): Promise<{ listener: Listener; port: number }> {
    const listener = new Listener(respond);
    listeners.push(listener);
    return { listener, port: await listener.start() };
  }

  it('blocks a loopback endpoint by default and never connects', async () => {
    const { listener, port } = await listen();
    const guarded = createGuardedFetch({ approvals: approvalsFor() });
    await expect(guarded(`http://127.0.0.1:${port}/api/server/ping`)).rejects.toMatchObject({
      name: 'ImmichTargetBlockedError', code: 'TARGET_NOT_APPROVED'
    });
    expect(listener.hits).toBe(0);
  });

  it('allows exactly the approved host and port', async () => {
    const approved = await listen();
    const other = await listen();
    const guarded = createGuardedFetch({ approvals: approvalsFor(`127.0.0.1:${approved.port}`) });
    const response = await guarded(`http://127.0.0.1:${approved.port}/ping`);
    expect(response.status).toBe(200);
    expect(await response.text()).toBe('pong');
    await expect(guarded(`http://127.0.0.1:${other.port}/ping`)).rejects.toBeInstanceOf(ImmichTargetBlockedError);
    expect(other.listener.hits).toBe(0);
  });

  it.each([
    'http://169.254.169.254/latest/meta-data/',
    'http://[fe80::1]/',
    'http://[::ffff:169.254.169.254]/',
    'http://100.100.100.200/',
    'http://0.0.0.0:2283/'
  ])('never allows %s, even when it is approved', async (url) => {
    const target = new URL(url);
    const port = target.port ? target.port : '80';
    const host = target.hostname.replace(/^\[|\]$/g, '');
    const guarded = createGuardedFetch({ approvals: { isApproved: async () => true } });
    await expect(guarded(url)).rejects.toMatchObject({ code: 'TARGET_BLOCKED', host, port: Number(port) });
  });

  it('checks the resolved address of a host name and blocks metadata answers, also among several answers', async () => {
    const guarded = createGuardedFetch({
      approvals: { isApproved: async () => true },
      resolveHost: async (host) => host === 'mixed.test' ? ['8.8.8.8', '169.254.169.254'] : ['169.254.169.254']
    });
    await expect(guarded('http://metadata.test/')).rejects.toMatchObject({ code: 'TARGET_BLOCKED' });
    await expect(guarded('http://mixed.test/')).rejects.toMatchObject({ code: 'TARGET_BLOCKED' });
  });

  it('requires approval for a host name that resolves to a private address', async () => {
    const { listener, port } = await listen();
    const resolveHost = async () => ['127.0.0.1'];
    await expect(createGuardedFetch({ approvals: approvalsFor(), resolveHost })(`http://immich.test:${port}/`))
      .rejects.toMatchObject({ code: 'TARGET_NOT_APPROVED', host: 'immich.test', port });
    expect(listener.hits).toBe(0);
    const approved = createGuardedFetch({ approvals: approvalsFor(`immich.test:${port}`), resolveHost });
    expect((await approved(`http://immich.test:${port}/`)).status).toBe(200);
    expect(listener.hits).toBe(1);
  });

  it('resolves once per request and connects to exactly the verified address (DNS rebinding)', async () => {
    const { listener, port } = await listen();
    const answers = [['127.0.0.1'], ['169.254.169.254']];
    let lookups = 0;
    const guarded = createGuardedFetch({
      approvals: approvalsFor(`rebind.test:${port}`),
      resolveHost: async () => answers[Math.min(lookups++, answers.length - 1)]!
    });
    expect((await guarded(`http://rebind.test:${port}/`)).status).toBe(200);
    expect(lookups).toBe(1);
    expect(listener.hits).toBe(1);
    // The rebound answer is verified on the next request and blocked.
    await expect(guarded(`http://rebind.test:${port}/`)).rejects.toMatchObject({ code: 'TARGET_BLOCKED' });
    expect(lookups).toBe(2);
    expect(listener.hits).toBe(1);
  });

  it('does not follow a redirect to a private or metadata address', async () => {
    const destination = await listen();
    const redirecting = await listen((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${destination.port}/secret` });
      response.end();
    });
    const metadataRedirect = await listen((_request, response) => {
      response.writeHead(307, { location: 'http://169.254.169.254/latest/meta-data/' });
      response.end();
    });
    const guarded = createGuardedFetch({
      approvals: approvalsFor(
        `127.0.0.1:${redirecting.port}`,
        `127.0.0.1:${destination.port}`,
        `127.0.0.1:${metadataRedirect.port}`
      )
    });
    const first = await guarded(`http://127.0.0.1:${redirecting.port}/start`);
    expect(first.status).toBe(302);
    expect(first.headers.get('location')).toContain(`:${destination.port}/secret`);
    expect(destination.listener.hits).toBe(0);
    expect((await guarded(`http://127.0.0.1:${metadataRedirect.port}/start`)).status).toBe(307);
  });

  it('streams request bodies and passes headers and methods through', async () => {
    const received: { method?: string; key?: string; body: string } = { body: '' };
    const { port } = await listen((request, response) => {
      received.method = request.method;
      received.key = String(request.headers['x-api-key']);
      request.on('data', (chunk: Buffer) => { received.body += chunk.toString('utf8'); });
      request.on('end', () => { response.writeHead(201); response.end('{}'); });
    });
    const guarded = createGuardedFetch({ approvals: approvalsFor(`127.0.0.1:${port}`) });
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('chunk-1;'));
        controller.enqueue(new TextEncoder().encode('chunk-2'));
        controller.close();
      }
    });
    const response = await guarded(new URL(`http://127.0.0.1:${port}/upload`), {
      method: 'POST', headers: { 'x-api-key': 'k' }, body: stream, duplex: 'half'
    } as RequestInit & { duplex: 'half' });
    expect(response.status).toBe(201);
    expect(received).toEqual({ method: 'POST', key: 'k', body: 'chunk-1;chunk-2' });
  });
});
