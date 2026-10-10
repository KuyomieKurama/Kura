import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  GalleryDlAdapter,
  type AssetManifest,
  type ResolvedAsset,
  type RunCredentials,
  type SourcePost
} from '../../packages/adapters/src/index.js';
import { tempDir, testWorkspace } from '../adapters/helpers.js';
import { fakeInstagramGalleryDl, type FakeInstagramTool, type InstagramToolControl } from '../instagram/fake-instagram-tool.js';

/*
 * The fixtures are what the real gallery-dl 1.32.16 Patreon and Pixiv extractors print for synthetic API data
 * (see fixtures/generate-fixtures.py). The fake tool replays them per URL.
 */

const PATREON = 'https://www.patreon.com';
const PIXIV = 'https://www.pixiv.net';
const CREATOR_TOOL_URL = `${PATREON}/c/owntestcreator/posts`;
const ARTIST_TOOL_URL = `${PIXIV}/users/4242/artworks`;
const jobContext = { jobId: 'job-platforms', leaseGeneration: 1 };
// Made-up values that must never show up in an argument or in the run environment.
const FAKE_PIXIV_TOKEN = 'FAKE-pixiv_refresh-token-for-tests-ONLY-0123456789';

type Entry = [number, ...unknown[]];
const fixture = async (name: string): Promise<Entry[]> => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8')) as Entry[];

/** Splits a feed listing into the listings of its single posts, keyed by post id. */
function splitByPost(entries: Entry[]): Map<string, Entry[]> {
  const byPost = new Map<string, Entry[]>();
  let current: Entry[] | undefined;
  for (const entry of entries) {
    if (entry[0] === 2) {
      current = [];
      byPost.set(String((entry.at(-1) as { id: number }).id), current);
    }
    current?.push(entry);
  }
  return byPost;
}

async function listings(): Promise<Record<string, unknown>> {
  const result: Record<string, unknown> = {};
  const patreon = await fixture('patreon-creator');
  result[CREATOR_TOOL_URL] = patreon;
  for (const [id, entries] of splitByPost(patreon)) result[`${PATREON}/posts/${id}`] = entries;
  const pixiv = await fixture('pixiv-user');
  result[ARTIST_TOOL_URL] = pixiv;
  for (const [id, entries] of splitByPost(pixiv)) result[`${PIXIV}/artworks/${id}`] = entries;
  result[`${PIXIV}/users/4242/illustrations`] = await fixture('pixiv-user-illustrations');
  result[`${PIXIV}/users/4242/manga`] = await fixture('pixiv-user-manga');
  return result;
}

interface Setup { adapter: GalleryDlAdapter; tool: FakeInstagramTool; workRoot: string }

async function setup(control: InstagramToolControl = {}, options: { patreonMaxPostsPerRun?: number; pixivMaxPostsPerRun?: number } = {}): Promise<Setup> {
  const tool = await fakeInstagramGalleryDl({ listings: await listings(), ...control });
  const workRoot = await tempDir('kura-platforms-workroot-');
  const adapter = await GalleryDlAdapter.create({ binary: tool.binary, workRoot, extraEnv: tool.env, ...options });
  return { adapter, tool, workRoot };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

const discover = (adapter: GalleryDlAdapter, url: string, credentials?: RunCredentials): Promise<SourcePost[]> =>
  collect(adapter.discover({ ...jobContext, target: adapter.validateTarget(url), credentials }));

async function manifestOf(adapter: GalleryDlAdapter, posts: SourcePost[], id: string, credentials?: RunCredentials): Promise<{ post: SourcePost; manifest: AssetManifest }> {
  const post = posts.find((candidate) => candidate.platformPostId === id)!;
  return { post, manifest: await adapter.resolveAssets(post, { preset: 'BEST_AVAILABLE' }, { credentials }) };
}

const toolCalls = async (tool: FakeInstagramTool): Promise<string[][]> => (await tool.calls()).filter((args) => !args.includes('--version'));
const optionValue = (args: string[], option: string): string | undefined => args[args.indexOf(option) + 1];

async function failureOf(promise: Promise<unknown>): Promise<AdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return error as AdapterError;
  }
  throw new Error('expected a failure');
}

describe('target recognition', () => {
  const adapter = GalleryDlAdapter.forTargetValidationOnly();

  it.each([
    ['https://www.patreon.com/owntestcreator', 'creator_feed', 'https://www.patreon.com/c/owntestcreator/posts', 'owntestcreator'],
    ['https://www.patreon.com/c/owntestcreator?utm_source=x', 'creator_feed', 'https://www.patreon.com/c/owntestcreator/posts', 'owntestcreator'],
    ['https://patreon.com/posts/own-post-1001', 'post', 'https://www.patreon.com/posts/own-post-1001', '1001'],
    ['https://www.pixiv.net/en/users/4242', 'creator_feed', 'https://www.pixiv.net/users/4242/artworks', '4242'],
    ['https://www.pixiv.net/users/4242/illustrations?p=2', 'creator_feed', 'https://www.pixiv.net/users/4242/illustrations', '4242'],
    ['https://www.pixiv.net/artworks/7001', 'post', 'https://www.pixiv.net/artworks/7001', '7001']
  ] as const)('%s becomes %s %s', (url, kind, canonical, platformId) => {
    expect(adapter.validateTarget(url)).toMatchObject({ adapterId: 'gallery-dl', kind, canonicalUrl: canonical, platformId });
  });

  it.each([
    'https://www.patreon.com/home',
    'https://www.patreon.com/collection/123',
    'https://www.patreon.com/user?u=55',
    'https://www.patreon.com/c/owntestcreator/posts/1001',
    'https://www.pixiv.net/users/4242/bookmarks/artworks',
    'https://www.pixiv.net/artworks/abc',
    'https://www.pixiv.net/'
  ])('refuses %s', (url) => {
    expect(() => adapter.validateTarget(url)).toThrow(AdapterError);
  });
});

describe('Patreon creator', () => {
  it('lists the posts of a creator, newest first, with their own post address', async () => {
    const { adapter, tool } = await setup();
    const posts = await discover(adapter, `${PATREON}/owntestcreator`);

    expect(posts.map((post) => post.platformPostId)).toEqual(['1001', '1002', '1003', '1004', '1005']);
    expect(posts[0]).toMatchObject({
      adapterId: 'gallery-dl', sourceType: 'patreon', title: 'Sketches and a bonus file', canonicalUrl: `${PATREON}/posts/1001`,
      creator: { platformId: '55', displayName: 'Own Test Creator' }, publishedAt: '2026-03-03T10:00:00.000Z'
    });
    const [call] = await toolCalls(tool);
    expect(call).toEqual([
      '--config-ignore', '--dump-json', '-o', 'output.jsonl=true', '--sleep-request', '3-6', '--sleep-extractor', '3-6', '--retries', '0',
      '--post-range', '1-50', '--', CREATOR_TOOL_URL
    ]);
  });

  it('honours the configured bound of posts per run', async () => {
    const { adapter } = await setup({}, { patreonMaxPostsPerRun: 2 });
    expect((await discover(adapter, `${PATREON}/owntestcreator`)).map((post) => post.platformPostId)).toEqual(['1001', '1002']);
  });

  it('hands the cookies file over with -C and never writes the session back', async () => {
    const { adapter, tool } = await setup();
    await discover(adapter, `${PATREON}/owntestcreator`, { cookiesFilePath: '/run/kura/private/cookies.txt' });
    const [call] = await toolCalls(tool);
    expect(optionValue(call!, '-C')).toBe('/run/kura/private/cookies.txt');
    expect(call).toContain('extractor.patreon.cookies-update=false');
    expect(call).not.toContain('-c');
  });

  it('turns a post into its files, an embedded video, a locked post and a hosted stream', async () => {
    const { adapter } = await setup();
    const posts = await discover(adapter, `${PATREON}/owntestcreator`);

    const images = (await manifestOf(adapter, posts, '1001')).manifest;
    expect(images.discoveryComplete).toBe(true);
    expect(images.assets.map((asset) => [asset.originalName, asset.mediaType, asset.unavailable])).toEqual([
      ['page-1.jpg', 'image/jpeg', undefined],
      ['page-2.png', 'image/png', undefined],
      ['bonus-files.zip', 'application/zip', undefined],
      ['cover.jpg', 'image/jpeg', undefined],
      ['inline-picture.png', 'image/png', undefined]
    ]);

    const embed = (await manifestOf(adapter, posts, '1002')).manifest;
    expect(embed.discoveryComplete).toBe(true);
    expect(embed.assets).toHaveLength(1);
    expect(embed.assets[0]!.unavailable).toMatchObject({ code: 'ASSET_UNSUPPORTED', message: expect.stringContaining('YouTube') });

    const locked = (await manifestOf(adapter, posts, '1003')).manifest;
    expect(locked.assets).toHaveLength(1);
    expect(locked.assets[0]!.unavailable).toMatchObject({ code: 'ASSET_LOCKED', message: expect.stringContaining('Nicht zugänglich') });

    const stream = (await manifestOf(adapter, posts, '1004')).manifest;
    expect(stream.assets).toHaveLength(1);
    expect(stream.assets[0]!.unavailable).toMatchObject({ code: 'ASSET_UNSUPPORTED', message: expect.stringContaining('HLS') });
  });

  it('never downloads an asset that is marked as unavailable, and never passes a ytdl: address to the tool', async () => {
    const { adapter, tool } = await setup();
    const posts = await discover(adapter, `${PATREON}/owntestcreator`);
    const { post, manifest } = await manifestOf(adapter, posts, '1004');
    const workspace = await testWorkspace();

    await expect(adapter.stage(manifest.assets[0]!, {
      ...jobContext, post, policy: { preset: 'BEST_AVAILABLE' }, workspace, limits: { maxBytes: 1024 * 1024 }
    } as never)).rejects.toMatchObject({ code: 'STAGING_REJECTED' });
    expect((await tool.calls()).flat().some((argument) => argument.startsWith('ytdl:'))).toBe(false);
  });

  it('downloads one file by its position', async () => {
    const { adapter, tool } = await setup();
    const posts = await discover(adapter, `${PATREON}/owntestcreator`);
    const { post, manifest } = await manifestOf(adapter, posts, '1001');
    const workspace = await testWorkspace();
    const asset = manifest.assets[0] as ResolvedAsset;

    const staged = await adapter.stage(asset, {
      ...jobContext, post, policy: { preset: 'BEST_AVAILABLE' }, workspace, limits: { maxBytes: 1024 * 1024 },
      credentials: { cookiesFilePath: '/run/kura/private/cookies.txt' }
    } as never);
    expect(staged.mediaType).toBeTruthy();
    const download = (await toolCalls(tool)).find((args) => args.includes('--range'))!;
    expect(optionValue(download, '--range')).toBe('1');
    expect(optionValue(download, '--sleep')).toBe('2-5');
    expect(optionValue(download, '-C')).toBe('/run/kura/private/cookies.txt');
    expect(download.at(-1)).toBe(`${PATREON}/posts/1001`);
  });

  it.each([
    ['patreon-error-auth', 'AUTH_REQUIRED'],
    ['patreon-error-notfound', 'TARGET_NOT_FOUND'],
    ['patreon-error-ratelimit', 'RATE_LIMITED']
  ])('classifies the tool error %s as %s', async (name, code) => {
    const { adapter } = await setup({ listings: { [CREATOR_TOOL_URL]: await fixture(name) } });
    const error = await failureOf(discover(adapter, `${PATREON}/owntestcreator`));
    expect(error.code).toBe(code);
  });
});

describe('Pixiv artist', () => {
  const credentials: RunCredentials = { configFilePath: '/run/kura/private/gallery-dl.conf' };

  it('lists the works of an artist and passes the token only through the configuration file', async () => {
    const { adapter, tool } = await setup();
    const posts = await discover(adapter, `${PIXIV}/users/4242`, credentials);

    expect(posts.map((post) => post.platformPostId)).toEqual(['7003', '7002', '7001', '7000']);
    expect(posts[1]).toMatchObject({
      sourceType: 'pixiv', title: 'Own animation', canonicalUrl: `${PIXIV}/artworks/7002`, creator: { platformId: '4242', displayName: 'Own Test Artist' }
    });
    const [call] = await toolCalls(tool);
    expect(call).toEqual([
      '--config-ignore', '--dump-json', '-o', 'output.jsonl=true', '--sleep-request', '2-4', '--sleep-extractor', '2-4', '--retries', '0',
      '-o', 'extractor.pixiv.sanity=false', '-o', 'extractor.pixiv.ugoira=true',
      '-c', '/run/kura/private/gallery-dl.conf', '--post-range', '1-50', '--', ARTIST_TOOL_URL
    ]);
    expect([...(await tool.calls()), ...(await tool.environments()).map((environment) => Object.values(environment))].flat().join('\n')).not.toContain(FAKE_PIXIV_TOKEN);
  });

  it('restricts the feed to illustrations or to manga with a fixed expression', async () => {
    const { adapter, tool } = await setup();
    await discover(adapter, `${PIXIV}/users/4242/illustrations`, credentials);
    await discover(adapter, `${PIXIV}/users/4242/manga`, credentials);
    // Each feed is read by a stream, and then checked once more because it ended before the bound.
    const calls = (await toolCalls(tool)).filter((args) => args.includes('output.jsonl=true'));
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain('--post-filter');
    expect(calls[1]).toContain('--post-filter');
    expect(optionValue(calls[0]!, '--post-filter')).not.toBe(optionValue(calls[1]!, '--post-filter'));
  });

  it('lists the pages of a work as separate files, with the type of the work', async () => {
    const { adapter } = await setup();
    const posts = await discover(adapter, `${PIXIV}/users/4242`, credentials);
    const manga = (await manifestOf(adapter, posts, '7003', credentials)).manifest;
    expect(manga.assets.map((asset) => asset.originalName)).toEqual(['7003_p0.png', '7003_p1.png', '7003_p2.png']);
    expect(manga.discoveryComplete).toBe(true);
  });

  it('keeps an ugoira as the zip of its frames and adds the frame timing as a file of its own', async () => {
    const { adapter } = await setup();
    const posts = await discover(adapter, `${PIXIV}/users/4242`, credentials);
    const { post, manifest } = await manifestOf(adapter, posts, '7002', credentials);

    expect(manifest.assets).toHaveLength(2);
    expect(manifest.assets[0]).toMatchObject({ mediaType: 'application/zip', role: 'original' });
    const timing = manifest.assets[1]!;
    expect(timing).toMatchObject({ sourceAssetId: 'ugoira-timing', mediaType: 'application/json', role: 'variant', variant: 'ugoira-timing', originalName: '7002_ugoira_timing.json' });

    const workspace = await testWorkspace();
    const staged = await adapter.stage(timing, {
      ...jobContext, post, policy: { preset: 'BEST_AVAILABLE' }, workspace, limits: { maxBytes: 1024 * 1024 }, credentials
    } as never);
    expect(staged.mediaType).toBe('application/json');
    const written = JSON.parse(await readFile(staged.absolutePath, 'utf8')) as { schema: string; workId: string; frames: Array<{ file: string; delay: number }> };
    expect(written.schema).toBe('kura-ugoira-timing-1');
    expect(written.workId).toBe('7002');
    expect(written.frames).toEqual([
      { file: '000000.jpg', delay: 70 }, { file: '000001.jpg', delay: 100 }, { file: '000002.jpg', delay: 70 }, { file: '000003.jpg', delay: 100 }
    ]);
  });

  it.each([
    ['pixiv-error-no-token', 'AUTH_REQUIRED'],
    ['pixiv-error-revoked-token', 'AUTH_REQUIRED'],
    ['pixiv-error-notfound', 'TARGET_NOT_FOUND']
  ])('classifies the tool error %s as %s', async (name, code) => {
    const { adapter } = await setup({ listings: { [ARTIST_TOOL_URL]: await fixture(name) } });
    const error = await failureOf(discover(adapter, `${PIXIV}/users/4242`, credentials));
    expect(error.code).toBe(code);
  });

  it('refuses a configuration path that is not absolute', async () => {
    const { adapter } = await setup();
    const error = await failureOf(discover(adapter, `${PIXIV}/users/4242`, { configFilePath: '--evil' }));
    expect(error.code).toBe('PROCESS_SPAWN_FAILED');
  });
});
