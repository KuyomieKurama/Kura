import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  AdapterRegistry,
  deliverAssets,
  GalleryDlAdapter,
  YtDlpAdapter,
  capabilitiesForSourceType,
  type AssetManifest,
  type DownloadContext,
  type SourcePost,
  type SourceType
} from '../../packages/adapters/src/index.js';
import { fakeGalleryDl, fakeYtDlp, pixivListing, youtubeInfo, type FakeGalleryDlConfig, type FakeTool } from './fake-tools.js';
import { JPEG_BYTES, PNG_BYTES, tempDir, testWorkspace } from './helpers.js';

const PIXIV_URL = 'https://www.pixiv.net/artworks/98765';
const jobContext = { jobId: 'job-7', leaseGeneration: 3 };

interface Setup { adapter: GalleryDlAdapter; tool: FakeTool; workRoot: string }

async function setup(config: FakeGalleryDlConfig = {}, options: { minimumVersion?: string; metadataTimeoutMs?: number } = {}): Promise<Setup> {
  const tool = await fakeGalleryDl({ listing: pixivListing(), ...config });
  const workRoot = await tempDir('kura-workroot-');
  const adapter = await GalleryDlAdapter.create({ binary: tool.binary, workRoot, extraEnv: tool.env, ...options });
  return { adapter, tool, workRoot };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error, 'expected an AdapterError').toBeInstanceOf(AdapterError);
  return (error as AdapterError).code;
}

async function postOf(adapter: GalleryDlAdapter, url = PIXIV_URL): Promise<SourcePost> {
  for await (const post of adapter.discover({ ...jobContext, target: adapter.validateTarget(url) })) return post;
  throw new Error('no post');
}

function context(post: SourcePost, maxBytes = 10 * 1024 * 1024): DownloadContext {
  return { ...jobContext, post, policy: { preset: 'SOURCE_BYTES' }, limits: { maxBytes } };
}

async function resolve(adapter: GalleryDlAdapter, url = PIXIV_URL): Promise<{ post: SourcePost; manifest: AssetManifest }> {
  const post = await postOf(adapter, url);
  return { post, manifest: await adapter.resolveAssets(post, { preset: 'SOURCE_BYTES' }) };
}

describe('GalleryDlAdapter basics', () => {
  it('declares what it can do per platform: feeds on all three, cookies for Instagram and Patreon, a token for Pixiv', async () => {
    const { adapter } = await setup();
    expect(adapter.capabilities()).toMatchObject({
      adapterId: 'gallery-dl', adapterVersion: '1.32.2', sourceTypes: ['pixiv', 'instagram', 'patreon'], single_post: true,
      creator_feed: true, pagination: true, resume: false, images: true, videos: true, page_snapshot: false,
      quality_variants: false, auth_kind: 'cookies', presets: ['BEST_AVAILABLE', 'SOURCE_BYTES']
    });
    const forType = (sourceType: SourceType) => capabilitiesForSourceType(adapter.capabilities(), sourceType);
    expect(forType('instagram')).toMatchObject({ single_post: true, creator_feed: true, pagination: true, images: true, videos: true, auth_kind: 'cookies' });
    expect(forType('patreon')).toMatchObject({ single_post: true, creator_feed: true, pagination: true, images: true, videos: true, auth_kind: 'cookies' });
    // Ugoira are stored as zip archives, so Pixiv declares no videos (P1).
    expect(forType('pixiv')).toMatchObject({ single_post: true, creator_feed: true, pagination: true, images: true, videos: false, auth_kind: 'token' });
  });

  it('refuses a mismatching hash, an unparsable version and a version below an administrator floor', async () => {
    const tool = await fakeGalleryDl();
    const workRoot = await tempDir();
    expect(await codeOf(GalleryDlAdapter.create({ binary: { ...tool.binary, sha256: 'f'.repeat(64) }, workRoot }))).toBe('BINARY_HASH_MISMATCH');
    expect(await codeOf(GalleryDlAdapter.create({ binary: tool.binary, workRoot, minimumVersion: '1.40.0' }))).toBe('BINARY_VERSION_REJECTED');
    expect(await codeOf(GalleryDlAdapter.create({ binary: tool.binary, workRoot, minimumVersion: 'latest' }))).toBe('BINARY_NOT_CONFIGURED');
    const odd = await fakeGalleryDl({ version: 'gallery-dl 1.32.2; evil' });
    expect(await codeOf(GalleryDlAdapter.create({ binary: odd.binary, workRoot }))).toBe('BINARY_VERSION_REJECTED');
  });

  it.each([
    ['https://www.pixiv.net/artworks/98765', 'pixiv', 'https://www.pixiv.net/artworks/98765', '98765'],
    ['https://www.pixiv.net/en/artworks/98765?x=1#top', 'pixiv', 'https://www.pixiv.net/artworks/98765', '98765'],
    ['https://www.instagram.com/p/Cabc123XYZ/', 'instagram', 'https://www.instagram.com/p/Cabc123XYZ/', 'Cabc123XYZ'],
    ['https://www.patreon.com/posts/own-post-title-123456', 'patreon', 'https://www.patreon.com/posts/own-post-title-123456', '123456'],
    ['https://www.patreon.com/posts/123456', 'patreon', 'https://www.patreon.com/posts/123456', '123456']
  ])('accepts %s', async (input, sourceType, canonicalUrl, platformId) => {
    const { adapter } = await setup();
    expect(adapter.validateTarget(input)).toEqual({ adapterId: 'gallery-dl', sourceType, kind: 'post', canonicalUrl, platformId });
  });

  it.each([
    ['a leading dash', '--dump-json'],
    ['--exec as a URL', '--exec=touch /tmp/pwned'],
    ['a newline injection', 'https://www.pixiv.net/artworks/98765\n--exec=id'],
    ['a non-numeric artwork id', 'https://www.pixiv.net/artworks/--exec'],
    ['http', 'http://www.pixiv.net/artworks/98765'],
    ['credentials', 'https://user@www.pixiv.net/artworks/98765']
  ])('rejects %s as invalid', async (_name, input) => {
    const { adapter } = await setup();
    expect(() => adapter.validateTarget(input)).toThrowError(expect.objectContaining({ code: 'TARGET_INVALID' }));
  });

  it.each([
    ['a Pixiv bookmarks page', 'https://www.pixiv.net/users/12345/bookmarks/artworks'],
    ['the Patreon home feed', 'https://www.patreon.com/home'],
    ['a look-alike host', 'https://www.pixiv.net.evil.example.test/artworks/98765'],
    ['an unlisted site', 'https://example.test/artworks/98765']
  ])('rejects %s as unsupported', async (_name, input) => {
    const { adapter } = await setup();
    expect(() => adapter.validateTarget(input)).toThrowError(expect.objectContaining({ code: 'TARGET_UNSUPPORTED' }));
  });
});

describe('GalleryDlAdapter metadata', () => {
  it('turns the listing into a normalized manifest and never keeps file URLs', async () => {
    const { adapter, tool } = await setup();
    const { post, manifest } = await resolve(adapter);

    expect(post).toMatchObject({
      adapterId: 'gallery-dl', sourceType: 'pixiv', platformPostId: '98765', canonicalUrl: PIXIV_URL, title: 'Own test artwork',
      creator: { platformId: '12345', displayName: 'own_artist' }, publishedAt: '2026-01-01T00:00:00.000Z'
    });
    expect(post.revisionKey).toMatch(/^l-[0-9a-f]{24}$/);
    expect(manifest).toMatchObject({ schemaVersion: 1, platformPostId: '98765', creatorId: '12345', discoveryComplete: true, errors: [] });
    expect(manifest.assets.map((asset) => [asset.assetIndex, asset.sourceAssetId, asset.originalName, asset.mediaType])).toEqual([
      [0, 'file-0', '98765_p0.png', 'image/png'],
      [1, 'file-1', '98765_p1.png', 'image/png'],
      [2, 'file-2', '98765_p2.png', 'image/png']
    ]);
    expect(manifest.assets[0]).toMatchObject({ role: 'original', variant: 'original', quality: { width: 1200, height: 900, container: 'png' }, completeness: 'complete' });
    expect(JSON.stringify(manifest)).not.toContain('pximg');
    for (const asset of manifest.assets) expect(asset).not.toHaveProperty('shortLived');

    for (const args of await tool.calls()) {
      if (args.includes('--version')) continue;
      expect(args.slice(-2)).toEqual(['--', PIXIV_URL]);
      expect(args[0]).toBe('--config-ignore');
    }
  });

  it('marks the enumeration incomplete when the tool reported errors but listed files', async () => {
    const { adapter } = await setup({ listingExitCode: 4 });
    const { manifest } = await resolve(adapter);
    expect(manifest.assets).toHaveLength(3);
    expect(manifest.discoveryComplete).toBe(false);
    expect(manifest.errors).toEqual([{ code: 'TOOL_REPORTED_ERRORS', message: expect.stringContaining('4') }]);
  });

  it('fails when the tool failed and listed nothing (for example a bad cookie), instead of reporting "no new posts"', async () => {
    const { adapter } = await setup({ rawListingOutput: '', listingExitCode: 1 });
    expect(await codeOf(postOf(adapter))).toBe('PROCESS_FAILED');
  });

  it('does not treat an empty listing as a complete post', async () => {
    const { adapter } = await setup({ listing: [] });
    const { manifest } = await resolve(adapter);
    expect(manifest.assets).toHaveLength(0);
    expect(manifest.discoveryComplete).toBe(false);
    expect(manifest.errors.map((error) => error.code)).toEqual(['NO_FILES']);
  });

  it('cuts off an unreasonable number of files and says so', async () => {
    const { adapter } = await setup({ listing: pixivListing(1_005) });
    const { manifest } = await resolve(adapter);
    expect(manifest.assets).toHaveLength(1_000);
    expect(manifest.discoveryComplete).toBe(false);
    expect(manifest.errors.map((error) => error.code)).toEqual(['LISTING_TRUNCATED']);
  });

  it('lists files with a disallowed type as errors instead of assets', async () => {
    const listing = [...pixivListing(2), [3, 'https://i.pximg.net/x.exe', { id: 98765, num: 2, extension: 'exe', filename: 'x' }]];
    const { adapter } = await setup({ listing });
    const { manifest } = await resolve(adapter);
    expect(manifest.assets).toHaveLength(2);
    expect(manifest.errors).toEqual([{ code: 'ASSET_UNSUPPORTED', message: expect.any(String) }]);
    expect(manifest.discoveryComplete).toBe(false);
  });

  it('rejects files that belong to a different post than requested', async () => {
    const { adapter } = await setup({ listing: pixivListing(2, { id: 11111 }) });
    expect(await codeOf(postOf(adapter))).toBe('OUTPUT_INVALID');
  });

  it.each([
    ['output that is not JSON', { rawListingOutput: '[[3, "https://x", {' }],
    ['a JSON object', { listing: { files: [] } }],
    ['a listing whose posts have no id', { listing: pixivListing(1, { id: undefined }) }]
  ])('rejects %s', async (_name, config) => {
    const { adapter } = await setup(config as FakeGalleryDlConfig);
    expect(await codeOf(postOf(adapter))).toBe('OUTPUT_INVALID');
  });

  it('never lets hostile metadata reach an argument list', async () => {
    const listing = [
      [2, { category: 'pixiv', directory: ['--exec=touch /tmp/pwned'] }],
      [3, '--exec=touch /tmp/pwned', {
        id: 98765, num: 0, extension: 'png', filename: '--config=/etc/shadow\n--exec=id', title: '-o evil', date: 'yesterday',
        user: { id: '--write-link', name: 'evil\u0000name' }, width: -5, height: '10; rm -rf /'
      }],
      [3, 'file:///etc/passwd', { id: 98765, num: 1, extension: '../../etc/passwd', filename: '../../x' }],
      [4, 'https://example.test/queued', { id: 98765 }]
    ];
    const { adapter, tool, workRoot } = await setup({ listing });
    const { post, manifest } = await resolve(adapter);
    const workspace = await testWorkspace();
    await adapter.stage!(manifest.assets[0]!, { ...context(post), workspace });

    expect(post.creator).toEqual({ platformId: 'unknown', displayName: 'evil name' });
    expect(post.publishedAt).toBeNull();
    expect(manifest.assets.map((asset) => asset.originalName)).toEqual(['config_etc_shadow --exec_id.png']);
    expect(manifest.assets[0]!.quality).toMatchObject({ width: null, height: null });
    expect(manifest.errors).toHaveLength(1); // the "../../etc/passwd" extension
    for (const args of await tool.calls()) {
      const joined = args.join(' ');
      for (const needle of ['pwned', '/etc/shadow', 'evil', 'passwd', 'write-link', 'queued']) expect(joined).not.toContain(needle);
    }
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('rejects presets it cannot honour', async () => {
    const { adapter } = await setup();
    const post = await postOf(adapter);
    expect(await codeOf(adapter.resolveAssets(post, { preset: 'WITH_EXTRAS' }))).toBe('POLICY_UNSUPPORTED');
  });

  it('refuses a post whose stored URL or id was tampered with', async () => {
    const { adapter, tool } = await setup();
    const post = await postOf(adapter);
    const before = (await tool.calls()).length;
    expect(await codeOf(adapter.resolveAssets({ ...post, canonicalUrl: '--exec=id' }, { preset: 'SOURCE_BYTES' }))).toBe('TARGET_INVALID');
    expect(await codeOf(adapter.resolveAssets({ ...post, canonicalUrl: 'https://evil.example.test/' }, { preset: 'SOURCE_BYTES' }))).toBe('TARGET_UNSUPPORTED');
    expect(await codeOf(adapter.resolveAssets({ ...post, platformPostId: '1' }, { preset: 'SOURCE_BYTES' }))).toBe('TARGET_INVALID');
    expect((await tool.calls()).length).toBe(before);
  });
});

describe('GalleryDlAdapter downloads', () => {
  it('addresses a file only by its position and writes into the scratch directory', async () => {
    const { adapter, tool } = await setup();
    const { post, manifest } = await resolve(adapter);
    const workspace = await testWorkspace();
    const staged = await adapter.stage!(manifest.assets[1]!, { ...context(post), workspace });
    expect(staged).toMatchObject({ assetIndex: 1, relativePath: 'media/item-0001.jpg', mediaType: 'image/jpeg', byteLength: JPEG_BYTES.length });

    const download = (await tool.calls()).at(-1)!;
    // Pixiv pacing (P1): the delays are Kura's own choice and are documented in docs/vm-setup.md.
    expect(download).toEqual([
      '--config-ignore',
      '--sleep-request', '2-4', '--sleep-extractor', '2-4', '--retries', '0',
      '-o', 'extractor.pixiv.sanity=false', '-o', 'extractor.pixiv.ugoira=true', '--sleep', '1-3',
      '-D', expect.stringContaining(workspace.rootDir), '-f', 'asset.{extension}', '--range', '2',
      '--filesize-max', String(10 * 1024 * 1024), '--', PIXIV_URL
    ]);
  });

  it('streams a file through download() and cleans its workspace', async () => {
    const { adapter, workRoot } = await setup({ fileExtensions: { 0: 'png' } });
    const { post, manifest } = await resolve(adapter);
    const chunks: Uint8Array[] = [];
    for await (const chunk of adapter.download(manifest.assets[0]!, context(post))) chunks.push(chunk);
    expect(Buffer.concat(chunks)).toEqual(PNG_BYTES);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('rejects an asset index outside the supported range', async () => {
    const { adapter } = await setup();
    const { post, manifest } = await resolve(adapter);
    const workspace = await testWorkspace();
    for (const assetIndex of [-1, 1_000, 1.5]) {
      expect(await codeOf(adapter.stage!({ ...manifest.assets[0]!, assetIndex }, { ...context(post), workspace }))).toBe('TARGET_INVALID');
    }
  });
});

describe('deliverAssets: completion per asset', () => {
  it('stages the four good files of a five-file post when one download fails, and says "partially completed"', async () => {
    const { adapter, tool } = await setup({ listing: pixivListing(5), failIndexes: [2] });
    const { post, manifest } = await resolve(adapter);
    const workspace = await testWorkspace();

    const delivery = await deliverAssets({
      adapter, post, manifest, policy: { preset: 'SOURCE_BYTES' }, workspace, ...jobContext, limits: { maxBytes: 10 * 1024 * 1024 }
    });

    expect(delivery.completion).toBe('partially_completed');
    expect(delivery.outcomes.map((outcome) => `${outcome.assetIndex}:${outcome.status}`)).toEqual(['0:staged', '1:staged', '2:failed', '3:staged', '4:staged']);
    const failed = delivery.outcomes[2]!;
    expect(failed).toMatchObject({ status: 'failed', errorCode: 'RATE_LIMITED', sourceAssetId: 'file-2' }); // the fake prints a 429
    expect(JSON.stringify(failed)).not.toContain('429'); // tool text never becomes part of the outcome
    expect(await readdir(workspace.mediaDir)).toEqual(['item-0000.jpg', 'item-0001.jpg', 'item-0003.jpg', 'item-0004.jpg']);
    expect((await tool.calls()).filter((args) => args.includes('--range'))).toHaveLength(5);

    const result = JSON.parse(await readFile(delivery.resultFile, 'utf8')) as {
      schemaVersion: number; jobId: string; leaseGeneration: number; adapterId: string; discoveryComplete: boolean;
      items: Array<{ sourcePostId: string; sourceAssetId: string; relativePath: string; sha256: string; metadata: { creatorId: string; index: number } }>;
      errors: Array<{ sourceAssetId?: string; code: string }>;
    };
    expect(delivery.resultFile).toBe(join(workspace.rootDir, 'result.json'));
    expect(result).toMatchObject({ schemaVersion: 1, jobId: 'job-7', leaseGeneration: 3, adapterId: 'gallery-dl', discoveryComplete: true });
    expect(result.items.map((item) => item.relativePath)).toEqual(['media/item-0000.jpg', 'media/item-0001.jpg', 'media/item-0003.jpg', 'media/item-0004.jpg']);
    expect(result.items[0]).toMatchObject({ sourcePostId: '98765', sourceAssetId: 'file-0', metadata: { creatorId: '12345', index: 0 } });
    expect(result.errors).toEqual([{ sourceAssetId: 'file-2', code: 'RATE_LIMITED', message: expect.any(String) }]);
  });

  it('reports "complete" only when every asset is staged and the enumeration was clean', async () => {
    const { adapter } = await setup({ listing: pixivListing(2) });
    const { post, manifest } = await resolve(adapter);
    const delivery = await deliverAssets({
      adapter, post, manifest, policy: { preset: 'SOURCE_BYTES' }, workspace: await testWorkspace(), ...jobContext, limits: { maxBytes: 1024 * 1024 }
    });
    expect(delivery.completion).toBe('complete');
  });

  it('reports "partially completed" when all listed files arrived but the listing itself was not clean', async () => {
    const { adapter } = await setup({ listing: pixivListing(2), listingExitCode: 4 });
    const { post, manifest } = await resolve(adapter);
    const delivery = await deliverAssets({
      adapter, post, manifest, policy: { preset: 'SOURCE_BYTES' }, workspace: await testWorkspace(), ...jobContext, limits: { maxBytes: 1024 * 1024 }
    });
    expect(delivery.outcomes.every((outcome) => outcome.status === 'staged')).toBe(true);
    expect(delivery.completion).toBe('partially_completed');
  });

  it('reports "failed" when no asset could be staged', async () => {
    const { adapter } = await setup({ listing: pixivListing(2), failIndexes: [0, 1] });
    const { post, manifest } = await resolve(adapter);
    const delivery = await deliverAssets({
      adapter, post, manifest, policy: { preset: 'SOURCE_BYTES' }, workspace: await testWorkspace(), ...jobContext, limits: { maxBytes: 1024 * 1024 }
    });
    expect(delivery.completion).toBe('failed');
    expect(delivery.outcomes.map((outcome) => outcome.status)).toEqual(['failed', 'failed']);
  });

  it('stops the whole delivery when the caller aborts', async () => {
    const { adapter } = await setup({ listing: pixivListing(2) });
    const { post, manifest } = await resolve(adapter);
    await expect(deliverAssets({
      adapter, post, manifest, policy: { preset: 'SOURCE_BYTES' }, workspace: await testWorkspace(), ...jobContext,
      limits: { maxBytes: 1024 * 1024 }, signal: AbortSignal.abort()
    })).rejects.toMatchObject({ code: 'PROCESS_ABORTED' });
  });

  it('turns an unexpected exception of an adapter into a failed asset without leaking its text', async () => {
    const { adapter } = await setup({ listing: pixivListing(2) });
    const { post, manifest } = await resolve(adapter);
    const crashing = { ...adapter, capabilities: () => adapter.capabilities(), stage: () => { throw new Error('secret internals at /srv/x'); } };
    const delivery = await deliverAssets({
      adapter: crashing as unknown as GalleryDlAdapter, post, manifest, policy: { preset: 'SOURCE_BYTES' }, workspace: await testWorkspace(), ...jobContext, limits: { maxBytes: 1024 * 1024 }
    });
    expect(delivery.outcomes[0]).toMatchObject({ status: 'failed', errorCode: 'UNEXPECTED' });
    expect(JSON.stringify(delivery.outcomes)).not.toContain('secret internals');
  });
});

describe('adapters together', () => {
  it('a kill switch for yt-dlp leaves gallery-dl serving the same Instagram post, and yt-dlp keeps serving YouTube', async () => {
    const ytTool = await fakeYtDlp({ info: youtubeInfo() });
    const ytDlp = await YtDlpAdapter.create({ binary: ytTool.binary, workRoot: await tempDir() });
    const { adapter: galleryDl } = await setup();
    const registry = new AdapterRegistry();
    registry.register(galleryDl); // Instagram: gallery-dl first (plan 04, section 2)
    registry.register(ytDlp);

    const reel = 'https://www.instagram.com/reel/Cabc123XYZ/';
    expect(registry.lookup(reel).candidates.map((entry) => entry.adapter.capabilities().adapterId)).toEqual(['gallery-dl', 'yt-dlp']);

    registry.disable({ adapterId: 'gallery-dl', sourceType: 'instagram', reason: 'extractor broken' });
    expect(registry.select(reel).adapter.capabilities().adapterId).toBe('yt-dlp');
    expect(registry.select(PIXIV_URL).adapter.capabilities().adapterId).toBe('gallery-dl');
    expect(registry.select('https://www.youtube.com/watch?v=dQw4w9WgXcQ').adapter.capabilities().adapterId).toBe('yt-dlp');

    registry.disable({ adapterId: 'yt-dlp', adapterVersion: '2026.07.04', reason: 'advisory' });
    expect(() => registry.select(reel)).toThrowError(expect.objectContaining({ code: 'ADAPTER_DISABLED' }));
    expect(registry.select(PIXIV_URL).adapter.capabilities().adapterId).toBe('gallery-dl');
  });
});
