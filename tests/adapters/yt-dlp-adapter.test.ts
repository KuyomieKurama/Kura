import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  AdapterRegistry,
  YtDlpAdapter,
  YT_DLP_MINIMUM_VERSION,
  capabilitiesForSourceType,
  type DownloadContext,
  type ResolvedAsset,
  type SourcePost
} from '../../packages/adapters/src/index.js';
import { fakeYtDlp, youtubeInfo, type FakeTool, type FakeYtDlpConfig } from './fake-tools.js';
import { MP4_BYTES, tempDir, testWorkspace } from './helpers.js';

const VIDEO_URL = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const jobContext = { jobId: 'job-1', leaseGeneration: 1 };

interface Setup { adapter: YtDlpAdapter; tool: FakeTool; workRoot: string }

async function setup(config: FakeYtDlpConfig = {}, options: { metadataTimeoutMs?: number; downloadTimeoutMs?: number } = {}): Promise<Setup> {
  const tool = await fakeYtDlp({ info: youtubeInfo(), ...config });
  const workRoot = await tempDir('kura-workroot-');
  const adapter = await YtDlpAdapter.create({ binary: tool.binary, workRoot, extraEnv: tool.env, ...options });
  return { adapter, tool, workRoot };
}

async function codeOf(promise: Promise<unknown>): Promise<string> {
  const error = await promise.then(() => undefined, (caught: unknown) => caught);
  expect(error, 'expected an AdapterError').toBeInstanceOf(AdapterError);
  return (error as AdapterError).code;
}

async function postOf(adapter: YtDlpAdapter, url = VIDEO_URL): Promise<SourcePost> {
  for await (const post of adapter.discover({ ...jobContext, target: adapter.validateTarget(url) })) return post;
  throw new Error('no post');
}

function downloadContext(post: SourcePost, maxBytes = 10 * 1024 * 1024): DownloadContext {
  return { ...jobContext, post, policy: { preset: 'BEST_AVAILABLE' }, limits: { maxBytes } };
}

async function collect(chunks: AsyncIterable<Uint8Array>): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Buffer.concat(parts);
}

async function resolved(adapter: YtDlpAdapter): Promise<{ post: SourcePost; asset: ResolvedAsset }> {
  const post = await postOf(adapter);
  const manifest = await adapter.resolveAssets(post, { preset: 'BEST_AVAILABLE' });
  return { post, asset: manifest.assets[0]! };
}

describe('YtDlpAdapter version and binary checks', () => {
  it.each([
    [YT_DLP_MINIMUM_VERSION],
    ['2026.07.05'],
    ['2026.08.01.123456'],
    ['2027.01.01']
  ])('accepts version %s', async (version) => {
    const { adapter } = await setup({ version });
    expect(adapter.capabilities().adapterVersion).toBe(version);
  });

  it.each([
    ['2026.07.03'],
    ['2025.12.31'],
    ['2026.06.30.999999']
  ])('refuses version %s, which is below the D-007 floor', async (version) => {
    const tool = await fakeYtDlp({ version });
    expect(await codeOf(YtDlpAdapter.create({ binary: tool.binary, workRoot: await tempDir() }))).toBe('BINARY_VERSION_REJECTED');
  });

  it.each([['not a version'], ['v2026.07.04'], ['2026.07.04; rm -rf /'], ['']])('refuses the unparsable version %j', async (version) => {
    const tool = await fakeYtDlp({ version });
    expect(await codeOf(YtDlpAdapter.create({ binary: tool.binary, workRoot: await tempDir() }))).toBe('BINARY_VERSION_REJECTED');
  });

  it('lets the administrator raise the floor but never lower it', async () => {
    const tool = await fakeYtDlp({ version: '2026.07.10' });
    const workRoot = await tempDir();
    expect(await codeOf(YtDlpAdapter.create({ binary: tool.binary, workRoot, minimumVersion: '2026.08.01' }))).toBe('BINARY_VERSION_REJECTED');
    const old = await fakeYtDlp({ version: '2026.01.01' });
    expect(await codeOf(YtDlpAdapter.create({ binary: old.binary, workRoot, minimumVersion: '2020.01.01' }))).toBe('BINARY_VERSION_REJECTED');
  });

  it('refuses a binary whose hash does not match and never runs it', async () => {
    const tool = await fakeYtDlp();
    const wrong = { path: tool.binary.path, sha256: '0'.repeat(64) };
    expect(await codeOf(YtDlpAdapter.create({ binary: wrong, workRoot: await tempDir() }))).toBe('BINARY_HASH_MISMATCH');
    expect(await tool.calls()).toEqual([]);
  });
});

describe('YtDlpAdapter capabilities', () => {
  it('declares videos, YouTube and Pornhub lists, and nothing it cannot prove', async () => {
    const { adapter } = await setup();
    expect(adapter.capabilities()).toMatchObject({
      adapterId: 'yt-dlp', sourceTypes: ['youtube', 'pornhub', 'instagram'], single_post: true, creator_feed: true, pagination: true,
      resume: false, images: false, videos: true, page_snapshot: false, quality_variants: false, auth_kind: 'none', presets: ['BEST_AVAILABLE']
    });
    const forType = (sourceType: 'youtube' | 'pornhub' | 'instagram') => capabilitiesForSourceType(adapter.capabilities(), sourceType);
    expect(forType('youtube')).toMatchObject({ creator_feed: true, pagination: true, videos: true, images: false, auth_kind: 'cookies' });
    expect(forType('pornhub')).toMatchObject({ creator_feed: true, pagination: true, videos: true, images: false, auth_kind: 'none' });
    // Instagram profiles are gallery-dl's; yt-dlp only serves single posts as a fallback.
    expect(forType('instagram')).toMatchObject({ creator_feed: false, pagination: false, auth_kind: 'none' });
  });
});

describe('YtDlpAdapter.validateTarget', () => {
  it.each([
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtube.com/watch?v=dQw4w9WgXcQ&list=PL123&t=30s#frag', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://m.youtube.com/watch?v=dQw4w9WgXcQ', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://youtu.be/dQw4w9WgXcQ?si=abc', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.youtube.com/shorts/dQw4w9WgXcQ', 'youtube', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'dQw4w9WgXcQ'],
    ['https://www.instagram.com/reel/Cabc123XYZ/?igsh=tracking', 'instagram', 'https://www.instagram.com/reel/Cabc123XYZ/', 'Cabc123XYZ'],
    ['https://instagram.com/p/Cabc123XYZ', 'instagram', 'https://www.instagram.com/p/Cabc123XYZ/', 'Cabc123XYZ']
  ])('accepts %s', async (input, sourceType, canonicalUrl, platformId) => {
    const { adapter } = await setup();
    expect(adapter.validateTarget(input)).toEqual({ adapterId: 'yt-dlp', sourceType, kind: 'post', canonicalUrl, platformId });
  });

  it.each([
    ['a leading dash', '-o /etc/passwd'],
    ['--exec as a URL', '--exec=touch /tmp/pwned'],
    ['--exec after the URL', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ --exec=id'],
    ['a newline injection', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ\n--exec=id'],
    ['a carriage return', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ\r--exec=id'],
    ['a NUL byte', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ\0--exec=id'],
    ['http', 'http://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['credentials that hide the real host', 'https://www.youtube.com@evil.example.test/watch?v=dQw4w9WgXcQ'],
    ['an id with an option', 'https://www.youtube.com/watch?v=--exec=id'],
    ['an id of the wrong length', 'https://www.youtube.com/watch?v=short']
  ])('rejects %s as invalid', async (_name, input) => {
    const { adapter } = await setup();
    expect(() => adapter.validateTarget(input)).toThrowError(expect.objectContaining({ code: 'TARGET_INVALID' }));
  });

  it.each([
    ['a YouTube feed page', 'https://www.youtube.com/feed/subscriptions'],
    ['a look-alike host', 'https://www.youtube.com.evil.example.test/watch?v=dQw4w9WgXcQ'],
    ['the URL inside another URL', 'https://evil.example.test/?u=https://www.youtube.com/watch?v=dQw4w9WgXcQ'],
    ['Pixiv, which is gallery-dl only (D-008)', 'https://www.pixiv.net/artworks/98765'],
    ['an unlisted portal', 'https://videos.example.test/watch/123'],
    ['an Instagram story', 'https://www.instagram.com/stories/owntest/123/']
  ])('rejects %s as unsupported', async (_name, input) => {
    const { adapter } = await setup();
    expect(() => adapter.validateTarget(input)).toThrowError(expect.objectContaining({ code: 'TARGET_UNSUPPORTED' }));
  });

  it('marks instagram:user as broken, as plan 04 requires', async () => {
    const { adapter } = await setup();
    expect(() => adapter.validateTarget('https://www.instagram.com/owntest/')).toThrowError(expect.objectContaining({ code: 'TARGET_BROKEN' }));
    const registry = new AdapterRegistry();
    registry.register(adapter);
    expect(() => registry.select('https://www.instagram.com/owntest/')).toThrowError(expect.objectContaining({ code: 'TARGET_BROKEN' }));
  });
});

describe('YtDlpAdapter metadata', () => {
  it('probes, discovers and resolves a normalized manifest', async () => {
    const { adapter } = await setup();
    const target = adapter.validateTarget(VIDEO_URL);

    expect(await adapter.probe({ ...jobContext, target })).toMatchObject({
      available: true, title: 'Own test video', creatorId: 'UC1234567890abcdefghijkl', creatorName: 'Own Test Channel'
    });

    const post = await postOf(adapter);
    expect(post).toMatchObject({
      adapterId: 'yt-dlp', sourceType: 'youtube', platformPostId: 'dQw4w9WgXcQ', canonicalUrl: VIDEO_URL,
      creator: { platformId: 'UC1234567890abcdefghijkl', displayName: 'Own Test Channel' },
      publishedAt: '2026-01-05T00:00:00.000Z'
    });
    expect(post.revisionKey).toMatch(/^d-[0-9a-f]{24}$/);

    const manifest = await adapter.resolveAssets(post, { preset: 'BEST_AVAILABLE' });
    expect(manifest).toMatchObject({
      schemaVersion: 1, adapterId: 'yt-dlp', adapterVersion: '2026.07.04', sourceType: 'youtube',
      platformPostId: 'dQw4w9WgXcQ', creatorId: 'UC1234567890abcdefghijkl', revisionKey: post.revisionKey, discoveryComplete: true, errors: []
    });
    expect(manifest.assets).toEqual([{
      sourceAssetId: 'video', assetIndex: 0, originalName: 'Own test video.mp4', mediaType: 'video/mp4', role: 'original', variant: 'best',
      quality: { preset: 'BEST_AVAILABLE', width: 1920, height: 1080, container: 'mp4' }, declaredBytes: null, completeness: 'complete'
    }]);
    expect(JSON.stringify(manifest)).not.toContain('SECRET');
  });

  it('keeps the revision key stable when only the title changes', async () => {
    const first = await setup({ info: youtubeInfo({ title: 'Before' }) });
    const second = await setup({ info: youtubeInfo({ title: 'After' }) });
    expect((await postOf(first.adapter)).revisionKey).toBe((await postOf(second.adapter)).revisionKey);
  });

  it('never lets untrusted metadata reach the argument list or the manifest unsanitized', async () => {
    const hostile = youtubeInfo({
      title: '--exec=touch /tmp/pwned\n\u0007--netrc-cmd=id',
      channel: 'evil\u0000name',
      uploader_id: '--write-link',
      channel_id: '$(id)',
      ext: '../../etc/passwd',
      webpage_url: 'https://evil.example.test/-o/etc/cron.d/x',
      width: '1920; rm -rf /',
      formats: [{ url: '--exec=id' }]
    });
    const { adapter, tool, workRoot } = await setup({ info: hostile });
    const post = await postOf(adapter);
    const manifest = await adapter.resolveAssets(post, { preset: 'BEST_AVAILABLE' });
    const staged = await adapter.stage!(
      { sourceAssetId: 'video', assetIndex: 0, originalName: 'x.mp4', mediaType: 'video/mp4', role: 'original', variant: 'best',
        quality: { preset: 'BEST_AVAILABLE', width: null, height: null, container: null }, declaredBytes: null, completeness: 'complete' },
      { ...downloadContext(post), workspace: await testWorkspace() }
    );
    expect(staged.relativePath).toBe('media/item-0000.mp4');

    expect(post.title).toBe('--exec=touch /tmp/pwned --netrc-cmd=id');
    expect(post.creator.platformId).toBe('unknown'); // "$(id)" and "--write-link" are not identifiers
    expect(post.creator.displayName).toBe('evil name');
    expect(manifest.assets).toHaveLength(0); // unusable container
    expect(manifest.errors).toEqual([{ code: 'ASSET_UNSUPPORTED', message: expect.any(String) }]);
    expect(manifest.discoveryComplete).toBe(false);

    for (const args of await tool.calls()) {
      const joined = args.join(' ');
      expect(joined).not.toContain('pwned');
      expect(joined).not.toContain('netrc');
      expect(joined).not.toContain('write-link');
      expect(joined).not.toContain('evil.example.test');
    }
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('puts the URL after "--" in every call and passes no option from the advisories', async () => {
    const { adapter, tool } = await setup();
    const { post, asset } = await resolved(adapter);
    await adapter.stage!(asset, { ...downloadContext(post), workspace: await testWorkspace() });
    const calls = (await tool.calls()).filter((args) => !args.includes('--version'));
    expect(calls).toHaveLength(3); // discover, resolve, download
    for (const args of calls) {
      expect(args.slice(-2)).toEqual(['--', VIDEO_URL]);
      expect(args).toContain('--ignore-config');
      expect(args).toContain('--no-update');
      for (const forbidden of ['--exec', '--netrc-cmd', '--write-link', '--external-downloader', '--downloader', '--plugin-dirs', '--config-locations', '--batch-file', '--cookies-from-browser']) {
        expect(args.some((arg) => arg.startsWith(forbidden))).toBe(false);
      }
    }
    const download = calls[2]!;
    expect(download).toEqual([
      '--ignore-config', '--no-update', '--no-cache-dir', '--no-warnings', '--no-playlist',
      '--extractor-retries', '0', '--sleep-requests', '1', '--sleep-interval', '3', '--max-sleep-interval', '8',
      '--no-progress', '--no-mtime', '--max-filesize', String(10 * 1024 * 1024),
      '-f', 'bestvideo*+bestaudio/best', '--merge-output-format', 'mp4/webm/mkv', '--abort-on-unavailable-fragments',
      '-o', 'asset.%(ext)s', '--', VIDEO_URL
    ]);
  });

  it('rejects metadata for a different video than requested', async () => {
    const { adapter } = await setup({ info: youtubeInfo({ id: 'AAAAAAAAAAA' }) });
    expect(await codeOf(postOf(adapter))).toBe('OUTPUT_INVALID');
  });

  it.each([
    ['output that is not JSON', { rawInfoOutput: 'WARNING: something\n{"id":' }],
    ['a JSON array', { info: [1, 2, 3] }],
    ['a playlist result', { info: youtubeInfo({ _type: 'playlist', entries: [] }) }],
    ['a result without an id', { info: youtubeInfo({ id: undefined }) }]
  ])('rejects %s', async (_name, config) => {
    const { adapter } = await setup(config as FakeYtDlpConfig);
    expect(await codeOf(postOf(adapter))).toBe('OUTPUT_INVALID');
  });

  it('reports a tool failure without copying tool text into the message', async () => {
    const { adapter } = await setup({ rawInfoOutput: '', infoExitCode: 1 });
    const error = await postOf(adapter).then(() => undefined, (caught: unknown) => caught as AdapterError);
    expect(error).toBeInstanceOf(AdapterError);
    expect(error!.code).toBe('PROCESS_FAILED');
    expect(error!.message).not.toMatch(/exec|Sign in/);
  });

  it('terminates a metadata call that hangs', async () => {
    const { adapter } = await setup({ infoHang: true }, { metadataTimeoutMs: 500 });
    expect(await codeOf(postOf(adapter))).toBe('PROCESS_TIMEOUT');
  });

  it('rejects presets other than BEST_AVAILABLE without silent fallback', async () => {
    const { adapter } = await setup();
    const post = await postOf(adapter);
    expect(await codeOf(adapter.resolveAssets(post, { preset: 'SOURCE_BYTES' }))).toBe('POLICY_UNSUPPORTED');
    expect(await codeOf(adapter.resolveAssets(post, { preset: 'WITH_EXTRAS' }))).toBe('POLICY_UNSUPPORTED');
  });

  it('refuses a post whose stored URL was tampered with', async () => {
    const { adapter, tool } = await setup();
    const post = await postOf(adapter);
    const callsBefore = (await tool.calls()).length;
    for (const canonicalUrl of ['--exec=touch /tmp/pwned', 'https://evil.example.test/x', 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&x=1']) {
      expect(await codeOf(adapter.resolveAssets({ ...post, canonicalUrl }, { preset: 'BEST_AVAILABLE' }))).toMatch(/^TARGET_/);
    }
    expect(await codeOf(adapter.resolveAssets({ ...post, platformPostId: 'AAAAAAAAAAA' }, { preset: 'BEST_AVAILABLE' }))).toBe('TARGET_INVALID');
    expect(await codeOf(adapter.resolveAssets({ ...post, adapterId: 'gallery-dl' }, { preset: 'BEST_AVAILABLE' }))).toBe('TARGET_INVALID');
    expect((await tool.calls()).length).toBe(callsBefore);
  });
});

describe('YtDlpAdapter downloads', () => {
  it('stages a checked file under a name Kura chose', async () => {
    const { adapter } = await setup();
    const { post, asset } = await resolved(adapter);
    const workspace = await testWorkspace();
    const staged = await adapter.stage!(asset, { ...downloadContext(post), workspace });
    expect(staged).toMatchObject({ assetIndex: 0, relativePath: 'media/item-0000.mp4', mediaType: 'video/mp4', byteLength: MP4_BYTES.length });
    expect(await readdir(workspace.mediaDir)).toEqual(['item-0000.mp4']);
  });

  it('streams the file through download() and removes its workspace afterwards', async () => {
    const { adapter, workRoot } = await setup();
    const { post, asset } = await resolved(adapter);
    expect(await collect(adapter.download(asset, downloadContext(post)))).toEqual(MP4_BYTES);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('removes the workspace when the consumer stops early', async () => {
    const { adapter, workRoot } = await setup();
    const { post, asset } = await resolved(adapter);
    const iterator = adapter.download(asset, downloadContext(post))[Symbol.asyncIterator]();
    await iterator.next();
    await iterator.return?.();
    expect(await readdir(workRoot)).toEqual([]);
  });

  it.each([
    ['the tool asks for a sign in', 'fail', 'AUTH_REQUIRED'],
    ['it leaves extra files behind', 'extra-file', 'STAGING_REJECTED'],
    ['it writes something that is not a video', 'html', 'STAGING_REJECTED'],
    ['it leaves a symlink', 'symlink', 'STAGING_REJECTED'],
    ['it writes a file type that is not allowed', 'wrong-extension', 'STAGING_REJECTED']
  ] as const)('rejects the result when %s, and cleans up', async (_name, download, expectedCode) => {
    const { adapter, workRoot } = await setup({ download });
    const { post, asset } = await resolved(adapter);
    const workspace = await testWorkspace();
    expect(await codeOf(adapter.stage!(asset, { ...downloadContext(post), workspace }))).toBe(expectedCode);
    expect(await readdir(workspace.mediaDir)).toEqual([]);
    expect(await workspace.usedBytes()).toBe(0); // the scratch directory of the failed run is gone
    expect(await codeOf(collect(adapter.download(asset, downloadContext(post))))).toBe(expectedCode);
    expect(await readdir(workRoot)).toEqual([]);
  });

  it('applies the size limit to the staged file', async () => {
    const { adapter } = await setup();
    const { post, asset } = await resolved(adapter);
    const workspace = await testWorkspace();
    expect(await codeOf(adapter.stage!(asset, { ...downloadContext(post, MP4_BYTES.length - 1), workspace }))).toBe('SIZE_LIMIT');
  });

  it('kills a download that exceeds the runtime limit', async () => {
    const { adapter } = await setup({ download: 'hang' }, { downloadTimeoutMs: 500 });
    const { post, asset } = await resolved(adapter);
    expect(await codeOf(adapter.stage!(asset, { ...downloadContext(post), workspace: await testWorkspace() }))).toBe('PROCESS_TIMEOUT');
  });

  it('kills a download that exceeds the temp space limit', async () => {
    // limit = space used so far + 2 x maxBytes + 64 MiB headroom; the fake writes 80 MiB and keeps running.
    const { adapter } = await setup({ download: 'flood-disk' }, { downloadTimeoutMs: 20_000 });
    const { post, asset } = await resolved(adapter);
    const workspace = await testWorkspace();
    expect(await codeOf(adapter.stage!(asset, { ...downloadContext(post, 1024), workspace }))).toBe('PROCESS_TEMP_LIMIT');
    expect(await workspace.usedBytes()).toBe(0);
  });
});

describe('YtDlpAdapter YouTube cookies (P1)', () => {
  it('hands an optional cookies file over with --cookies, for YouTube only', async () => {
    const { adapter, tool } = await setup();
    const credentials = { cookiesFilePath: '/run/kura/private/cookies.txt' };
    const target = adapter.validateTarget(VIDEO_URL);
    for await (const post of adapter.discover({ ...jobContext, target, credentials })) expect(post.platformPostId).toBeTruthy();
    const call = (await tool.calls()).find((args) => args.includes('--dump-single-json'))!;
    expect(call[call.indexOf('--cookies') + 1]).toBe('/run/kura/private/cookies.txt');
  });

  it('runs without --cookies when nothing was stored, and refuses a path that is not absolute', async () => {
    const { adapter, tool } = await setup();
    const target = adapter.validateTarget(VIDEO_URL);
    for await (const post of adapter.discover({ ...jobContext, target })) expect(post).toBeTruthy();
    expect((await tool.calls()).flat()).not.toContain('--cookies');
    expect(await codeOf((async () => { for await (const post of adapter.discover({ ...jobContext, target, credentials: { cookiesFilePath: '--evil' } })) void post; })())).toBe('PROCESS_SPAWN_FAILED');
  });
});
