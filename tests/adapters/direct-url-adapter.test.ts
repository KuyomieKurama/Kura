import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  DirectUrlAdapter,
  stageByteStream,
  toPersistableAsset,
  type CanonicalTarget,
  type DownloadContext,
  type ResolvedAsset,
  type SourcePost
} from '../../packages/adapters/src/index.js';
import { createGuardedFetch, type EndpointApprovals } from '../../packages/immich-client/src/index.js';
import { JPEG_BYTES, sha256Hex, testWorkspace } from './helpers.js';

const denyAll: EndpointApprovals = { isApproved: async () => false };
const jobContext = { jobId: 'job-1', leaseGeneration: 1 };

type Handler = (url: URL, init: RequestInit | undefined) => Response | Promise<Response>;

/**
 * Hosts with a handler are answered locally ("public servers"). Every other
 * host goes through the real address-verifying guard, with DNS answers taken
 * from `dns`, so blocked targets are rejected by the production code path.
 */
function routedFetcher(handlers: Record<string, Handler>, dns: Record<string, string[]> = {}, approvals: EndpointApprovals = denyAll): typeof fetch {
  const guarded = createGuardedFetch({ approvals, resolveHost: async (host) => dns[host] ?? ['203.0.113.77'] });
  return async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : (input as Request).url);
    const handler = handlers[url.host];
    return handler ? handler(url, init) : guarded(url, init);
  };
}

function image(extraHeaders: Record<string, string> = {}, body: Uint8Array = JPEG_BYTES): Response {
  return new Response(body, { status: 200, headers: { 'content-type': 'image/jpeg', 'content-length': String(body.length), ...extraHeaders } });
}

const redirect = (location: string, status = 302): Response => new Response(null, { status, headers: { location } });

function adapterWith(fetcher: typeof fetch, extra: Partial<ConstructorParameters<typeof DirectUrlAdapter>[0]> = {}): DirectUrlAdapter {
  return new DirectUrlAdapter({ approvals: denyAll, fetcher, ...extra });
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

async function firstPost(adapter: DirectUrlAdapter, target: CanonicalTarget): Promise<SourcePost> {
  for await (const post of adapter.discover({ ...jobContext, target })) return post;
  throw new Error('no post discovered');
}

async function resolveOnly(adapter: DirectUrlAdapter, url: string): Promise<{ post: SourcePost; asset: ResolvedAsset }> {
  const post = await firstPost(adapter, adapter.validateTarget(url));
  const manifest = await adapter.resolveAssets(post, { preset: 'SOURCE_BYTES' });
  return { post, asset: manifest.assets[0]! };
}

function downloadContext(post: SourcePost, maxBytes = 1024 * 1024): DownloadContext {
  return { ...jobContext, post, policy: { preset: 'SOURCE_BYTES' }, limits: { maxBytes } };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error, 'expected an AdapterError').toBeInstanceOf(AdapterError);
  return (error as AdapterError).code;
}

describe('DirectUrlAdapter.validateTarget', () => {
  const adapter = adapterWith(routedFetcher({}));

  it('accepts an https URL and rebuilds it without the fragment', () => {
    const target = adapter.validateTarget('https://Media.Example.test/path/pic.jpg?x=1#frag');
    expect(target).toMatchObject({
      adapterId: 'direct-url', sourceType: 'direct_media', kind: 'post', canonicalUrl: 'https://media.example.test/path/pic.jpg?x=1'
    });
    expect(target.platformId).toMatch(/^[0-9a-f]{32}$/);
  });

  it.each([
    ['http', 'http://media.example.test/pic.jpg'],
    ['ftp', 'ftp://media.example.test/pic.jpg'],
    ['file', 'file:///etc/passwd'],
    ['javascript', 'javascript:alert(1)'],
    ['credentials', 'https://user:pass@media.example.test/pic.jpg'],
    ['a leading dash', '--exec=touch /tmp/x'],
    ['a single dash option', '-o /tmp/x'],
    ['a newline', 'https://media.example.test/pic.jpg\n--exec=id'],
    ['a space', 'https://media.example.test/a b.jpg'],
    ['a tab', 'https://media.example.test/\tpic.jpg'],
    ['a backslash', 'https://media.example.test\\@evil.test/pic.jpg'],
    ['an empty string', ''],
    ['a relative path', '/pic.jpg'],
    ['too long', `https://media.example.test/${'a'.repeat(3000)}`]
  ])('rejects %s', (_name, input) => {
    expect(() => adapter.validateTarget(input)).toThrowError(expect.objectContaining({ code: 'TARGET_INVALID' }));
  });
});

describe('DirectUrlAdapter capabilities', () => {
  it('declares only what the code does', () => {
    const capabilities = adapterWith(routedFetcher({})).capabilities();
    expect(capabilities).toMatchObject({
      sourceTypes: ['direct_media'], single_post: true, creator_feed: false, pagination: false, resume: false,
      images: true, videos: true, page_snapshot: false, quality_variants: false, auth_kind: 'none'
    });
  });
});

describe('DirectUrlAdapter happy path', () => {
  it('probes, discovers, resolves and downloads with checks on the way', async () => {
    const adapter = adapterWith(routedFetcher({ 'cdn.example.test': () => image({ etag: '"v1"' }) }));
    const target = adapter.validateTarget('https://cdn.example.test/dir/photo%20one.jpg');

    const summary = await adapter.probe({ ...jobContext, target });
    expect(summary).toMatchObject({ available: true, title: 'photo_one.jpg', creatorId: 'cdn.example.test' });

    const post = await firstPost(adapter, target);
    expect(post.revisionKey).toMatch(/^h-[0-9a-f]{24}$/);
    expect(post.canonicalUrl).toBe(target.canonicalUrl);

    const manifest = await adapter.resolveAssets(post, { preset: 'BEST_AVAILABLE' });
    expect(manifest).toMatchObject({ schemaVersion: 1, discoveryComplete: true, platformPostId: target.platformId, errors: [] });
    const asset = manifest.assets[0]!;
    expect(asset).toMatchObject({
      assetIndex: 0, mediaType: 'image/jpeg', originalName: 'photo_one.jpg', role: 'original', variant: 'original',
      declaredBytes: JPEG_BYTES.length, completeness: 'complete'
    });

    expect(await collect(adapter.download(asset, downloadContext(post)))).toEqual(JPEG_BYTES);
  });

  it('keeps the short-lived URL out of the persistable asset', async () => {
    const adapter = adapterWith(routedFetcher({
      'cdn.example.test': () => redirect('https://files.example.test/signed.jpg?token=SECRET-TOKEN'),
      'files.example.test': () => image()
    }));
    const { asset } = await resolveOnly(adapter, 'https://cdn.example.test/a.jpg');
    expect(asset.shortLived?.downloadUrl).toBe('https://files.example.test/signed.jpg?token=SECRET-TOKEN');
    expect(JSON.stringify(toPersistableAsset(asset))).not.toContain('SECRET-TOKEN');
    expect(toPersistableAsset(asset)).not.toHaveProperty('shortLived');
  });

  it('streams into the staging area with size and hash', async () => {
    const adapter = adapterWith(routedFetcher({ 'cdn.example.test': () => image() }));
    const { post, asset } = await resolveOnly(adapter, 'https://cdn.example.test/a.jpg');
    const workspace = await testWorkspace();
    const staged = await stageByteStream(adapter.download(asset, downloadContext(post)), workspace, asset.assetIndex, asset.mediaType, 1024);
    expect(staged).toMatchObject({ byteLength: JPEG_BYTES.length, sha256: sha256Hex(JPEG_BYTES), mediaType: 'image/jpeg' });
  });

  it('rejects presets it cannot honour instead of falling back silently', async () => {
    const adapter = adapterWith(routedFetcher({ 'cdn.example.test': () => image() }));
    const post = await firstPost(adapter, adapter.validateTarget('https://cdn.example.test/a.jpg'));
    expect(await codeOf(adapter.resolveAssets(post, { preset: 'WITH_EXTRAS' }))).toBe('POLICY_UNSUPPORTED');
  });
});

describe('DirectUrlAdapter redirects and network policy', () => {
  it('follows redirects across hosts and records the final URL', async () => {
    const adapter = adapterWith(routedFetcher({
      'a.example.test': () => redirect('https://b.example.test/next'),
      'b.example.test': (url) => (url.pathname === '/next' ? redirect('/final.jpg', 301) : image())
    }));
    const { asset } = await resolveOnly(adapter, 'https://a.example.test/start');
    expect(asset.shortLived?.downloadUrl).toBe('https://b.example.test/final.jpg');
  });

  it.each([
    ['http downgrade', 'http://files.example.test/a.jpg'],
    ['a file URL', 'file:///etc/passwd'],
    ['a javascript URL', 'javascript:alert(1)'],
    ['credentials in the target', 'https://user:pw@files.example.test/a.jpg']
  ])('rejects a redirect to %s', async (_name, location) => {
    const adapter = adapterWith(routedFetcher({ 'a.example.test': () => redirect(location) }));
    expect(await codeOf(resolveOnly(adapter, 'https://a.example.test/x'))).toBe('REDIRECT_REJECTED');
  });

  it('rejects a redirect without Location and a redirect loop', async () => {
    const withoutLocation = adapterWith(routedFetcher({ 'a.example.test': () => new Response(null, { status: 302 }) }));
    expect(await codeOf(resolveOnly(withoutLocation, 'https://a.example.test/x'))).toBe('REDIRECT_REJECTED');

    let hops = 0;
    const looping = adapterWith(routedFetcher({ 'a.example.test': () => { hops += 1; return redirect('https://a.example.test/again'); } }), { maxRedirects: 3 });
    expect(await codeOf(resolveOnly(looping, 'https://a.example.test/x'))).toBe('REDIRECT_REJECTED');
    expect(hops).toBe(4);
  });

  it.each([
    ['a private address', 'https://internal.example.test/secret.jpg', { 'internal.example.test': ['10.0.0.5'] }],
    ['loopback', 'https://loopback.example.test/secret.jpg', { 'loopback.example.test': ['127.0.0.1'] }],
    ['IPv6 loopback', 'https://[::1]/secret.jpg', {}],
    ['the cloud metadata address', 'https://169.254.169.254/latest/meta-data/', {}],
    ['a hostname resolving to the metadata address', 'https://meta.example.test/x.jpg', { 'meta.example.test': ['169.254.169.254'] }],
    ['an IPv4-mapped IPv6 loopback', 'https://mapped.example.test/x.jpg', { 'mapped.example.test': ['::ffff:127.0.0.1'] }],
    ['a DNS answer mixing public and private addresses (rebinding)', 'https://rebind.example.test/x.jpg', { 'rebind.example.test': ['93.184.216.34', '192.168.1.10'] }]
  ])('blocks a redirect to %s', async (_name, location, dns) => {
    const adapter = adapterWith(routedFetcher({ 'a.example.test': () => redirect(location) }, dns));
    expect(await codeOf(resolveOnly(adapter, 'https://a.example.test/x'))).toBe('NETWORK_BLOCKED');
  });

  it('blocks a private address given directly as the target', async () => {
    const adapter = adapterWith(routedFetcher({}, { 'internal.example.test': ['192.168.178.20'] }));
    expect(await codeOf(adapter.probe({ ...jobContext, target: adapter.validateTarget('https://internal.example.test/x.jpg') }))).toBe('NETWORK_BLOCKED');
  });

  it('never allows link-local or metadata addresses, even when an administrator approved everything', async () => {
    const approveAll: EndpointApprovals = { isApproved: async () => true };
    const adapter = adapterWith(routedFetcher({}, {}, approveAll));
    expect(await codeOf(adapter.probe({ ...jobContext, target: adapter.validateTarget('https://169.254.169.254/x.jpg') }))).toBe('NETWORK_BLOCKED');
  });

  it('lets an administrator-approved private endpoint pass the guard (the connection itself then fails here)', async () => {
    const asked: string[] = [];
    const approvals: EndpointApprovals = { isApproved: async (host, port) => { asked.push(`${host}:${port}`); return true; } };
    const adapter = new DirectUrlAdapter({ approvals, resolveHost: async () => ['127.0.0.1'] });
    const code = await codeOf(adapter.probe({ ...jobContext, target: adapter.validateTarget('https://nas.example.test:9/x.jpg') }));
    expect(asked).toEqual(['nas.example.test:9']);
    expect(code).toBe('NETWORK_FAILED'); // nothing listens on 127.0.0.1:9, but the guard let the request through
  });
});

describe('DirectUrlAdapter response checks', () => {
  async function resolveCode(response: () => Response, extra: Partial<ConstructorParameters<typeof DirectUrlAdapter>[0]> = {}): Promise<string> {
    const adapter = adapterWith(routedFetcher({ 'cdn.example.test': response }), extra);
    return codeOf(resolveOnly(adapter, 'https://cdn.example.test/a'));
  }

  it('rejects HTML and other types that are not allowlisted', async () => {
    expect(await resolveCode(() => new Response('<html></html>', { headers: { 'content-type': 'text/html; charset=utf-8' } }))).toBe('MIME_REJECTED');
    expect(await resolveCode(() => new Response('x', { headers: { 'content-type': 'application/x-msdownload' } }))).toBe('MIME_REJECTED');
    expect(await resolveCode(() => new Response('x', { headers: { 'content-type': 'image/svg+xml' } }))).toBe('MIME_REJECTED');
  });

  it('rejects a response without Content-Type', async () => {
    expect(await resolveCode(() => new Response(new Uint8Array(JPEG_BYTES)))).toBe('MIME_REJECTED');
  });

  it('rejects an announced size above the limit before reading the body', async () => {
    expect(await resolveCode(() => image({ 'content-length': '5000' }), { maxAssetBytes: 1000 })).toBe('SIZE_LIMIT');
  });

  it('rejects compressed transfer encodings', async () => {
    expect(await resolveCode(() => image({ 'content-encoding': 'gzip' }))).toBe('DOWNLOAD_FAILED');
  });

  it('rejects error statuses', async () => {
    expect(await resolveCode(() => new Response('gone', { status: 410 }))).toBe('DOWNLOAD_FAILED');
    expect(await resolveCode(() => new Response('oops', { status: 500 }))).toBe('DOWNLOAD_FAILED');
  });

  it('refuses a download whose bytes are not the declared media type', async () => {
    let call = 0;
    const adapter = adapterWith(routedFetcher({
      'cdn.example.test': () => {
        call += 1;
        return call <= 2 ? image() : image({}, Buffer.from('<html><body>login required</body></html>'));
      }
    }));
    const { post, asset } = await resolveOnly(adapter, 'https://cdn.example.test/a.jpg');
    expect(await codeOf(collect(adapter.download(asset, downloadContext(post))))).toBe('MIME_REJECTED');
  });

  it('refuses a download whose media type changed since resolving', async () => {
    let call = 0;
    const adapter = adapterWith(routedFetcher({
      'cdn.example.test': () => {
        call += 1;
        return call <= 2 ? image() : new Response(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), { headers: { 'content-type': 'image/png' } });
      }
    }));
    const { post, asset } = await resolveOnly(adapter, 'https://cdn.example.test/a.jpg');
    expect(await codeOf(collect(adapter.download(asset, downloadContext(post))))).toBe('MIME_REJECTED');
  });

  it('stops a body that grows beyond the limit although no length was announced', async () => {
    const big = Buffer.concat([JPEG_BYTES, Buffer.alloc(5000)]);
    let call = 0;
    const adapter = adapterWith(routedFetcher({
      'cdn.example.test': () => {
        call += 1;
        return call <= 2
          ? image()
          : new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(big)); controller.close(); } }), { headers: { 'content-type': 'image/jpeg' } });
      }
    }));
    const { post, asset } = await resolveOnly(adapter, 'https://cdn.example.test/a.jpg');
    expect(await codeOf(collect(adapter.download(asset, downloadContext(post, 1000))))).toBe('SIZE_LIMIT');
  });

  it('detects a body shorter than the announced length', async () => {
    let call = 0;
    const adapter = adapterWith(routedFetcher({
      'cdn.example.test': () => {
        call += 1;
        return call <= 2 ? image() : new Response(JPEG_BYTES.subarray(0, 10), { headers: { 'content-type': 'image/jpeg', 'content-length': String(JPEG_BYTES.length) } });
      }
    }));
    const { post, asset } = await resolveOnly(adapter, 'https://cdn.example.test/a.jpg');
    expect(await codeOf(collect(adapter.download(asset, downloadContext(post))))).toBe('DOWNLOAD_FAILED');
  });

  it('gives up on a server that never answers the request', async () => {
    const adapter = adapterWith(routedFetcher({
      'cdn.example.test': (_url, init) => new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
      })
    }), { idleTimeoutMs: 150 });
    expect(await codeOf(adapter.probe({ ...jobContext, target: adapter.validateTarget('https://cdn.example.test/a.jpg') }))).toBe('NETWORK_FAILED');
  });

  it('gives up on a server that stops sending the body', async () => {
    let call = 0;
    const adapter = adapterWith(routedFetcher({
      'cdn.example.test': (_url, init) => {
        call += 1;
        if (call <= 2) return image();
        return new Response(new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(JPEG_BYTES.subarray(0, 8)));
            init?.signal?.addEventListener('abort', () => controller.error(new Error('aborted')));
          }
        }), { headers: { 'content-type': 'image/jpeg' } });
      }
    }), { idleTimeoutMs: 150 });
    const { post, asset } = await resolveOnly(adapter, 'https://cdn.example.test/a.jpg');
    expect(await codeOf(collect(adapter.download(asset, downloadContext(post))))).toBe('NETWORK_FAILED');
  });
});
