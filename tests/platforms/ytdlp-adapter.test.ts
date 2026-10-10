import { chmod, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  YtDlpAdapter,
  type AssetManifest,
  type RunCredentials,
  type SourcePost
} from '../../packages/adapters/src/index.js';
import { tempDir, testWorkspace } from '../adapters/helpers.js';
import {
  failureOf,
  fakeYtDlpTool,
  listingOf,
  readFixtureJson,
  videoMetadata,
  type FakeYtDlp,
  type YtDlpControl
} from './fake-ytdlp.js';

/*
 * The adapter against a fake yt-dlp that replays real yt-dlp 2026.8.19 output (fixtures/ytdlp-*, see
 * generate-ytdlp-fixtures.py). What the fixtures show is the shape of the real tool, not the behaviour of YouTube or
 * Pornhub: no real request was made.
 */

const jobContext = { jobId: 'job-p2', leaseGeneration: 1 };
const CHANNEL_URL = 'https://www.youtube.com/@owntestchannel/videos';
const SHORTS_URL = 'https://www.youtube.com/@owntestchannel/shorts';
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop';
const PORNHUB_LIST_URL = 'https://www.pornhub.com/model/owntestmodel/videos';
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const phVideo = (key: string) => `https://www.pornhub.com/view_video.php?viewkey=${key}`;
const BEST = 'bestvideo*+bestaudio/best';

// The six videos of the channel fixture, newest first.
const CHANNEL_IDS = ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3', 'aaaaaaaaaa4', 'aaaaaaaaaa5', 'aaaaaaaaaa6'];
const PORNHUB_KEYS = ['ph5aaaaaaaaaaa1', 'ph5aaaaaaaaaaa2', 'ph5aaaaaaaaaaa3'];

interface Setup { adapter: YtDlpAdapter; tool: FakeYtDlp; workRoot: string }

async function setup(control: YtDlpControl = {}, options: { youtubeMaxPostsPerRun?: number; pornhubMaxPostsPerRun?: number; toolPath?: string } = {}): Promise<Setup> {
  const tool = await fakeYtDlpTool({
    lists: {
      [CHANNEL_URL]: await listingOf('ytdlp-youtube-channel-flat.json'),
      [SHORTS_URL]: await listingOf('ytdlp-youtube-shorts-flat.json'),
      [PLAYLIST_URL]: await listingOf('ytdlp-youtube-playlist-flat.json'),
      [PORNHUB_LIST_URL]: await listingOf('ytdlp-pornhub-model-videos.json')
    },
    ...control
  });
  const workRoot = await tempDir('kura-p2-workroot-');
  const { toolPath, ...limits } = options;
  const adapter = await YtDlpAdapter.create({
    binary: tool.binary,
    workRoot,
    extraEnv: { ...tool.env, ...(toolPath ? { PATH: toolPath } : {}) },
    ...limits
  });
  return { adapter, tool, workRoot };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

const discover = (adapter: YtDlpAdapter, url: string, credentials?: RunCredentials): Promise<SourcePost[]> =>
  collect(adapter.discover({ ...jobContext, target: adapter.validateTarget(url), ...(credentials ? { credentials } : {}) }));

const resolve = (adapter: YtDlpAdapter, post: SourcePost, credentials?: RunCredentials): Promise<AssetManifest> =>
  adapter.resolveAssets(post, { preset: 'BEST_AVAILABLE' }, credentials ? { credentials } : undefined);

async function failureCode(promise: Promise<unknown>): Promise<AdapterError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return error as AdapterError;
  }
  throw new Error('expected an AdapterError');
}

const calls = (tool: FakeYtDlp) => tool.calls();
const optionValue = (args: string[], option: string): string | undefined => args[args.indexOf(option) + 1];
const FORBIDDEN_OPTIONS = [
  '--exec', '--netrc-cmd', '--write-link', '--external-downloader', '--downloader', '--plugin-dirs', '--config-locations',
  '--batch-file', '--cookies-from-browser', '--remote-components', '--js-runtimes', '--proxy', '--ffmpeg-location'
];

describe('flat listings of channels, playlists and Pornhub lists', () => {
  it('reads a channel tab newest first with the exact flat-listing arguments', async () => {
    const { adapter, tool } = await setup();
    const posts = await discover(adapter, 'https://www.youtube.com/@owntestchannel');
    expect(posts.map((post) => post.platformPostId)).toEqual(CHANNEL_IDS);
    expect(posts[0]).toMatchObject({
      adapterId: 'yt-dlp', sourceType: 'youtube', title: 'Newest upload', canonicalUrl: watch('aaaaaaaaaa1'),
      creator: { platformId: 'UC1234567890abcdefghijkl', displayName: 'Own Test Channel' }, publishedAt: null
    });
    expect(posts[0]!.revisionKey).toMatch(/^v-[0-9a-f]{24}$/);

    expect(await calls(tool)).toEqual([[
      '--ignore-config', '--no-update', '--no-cache-dir', '--no-warnings', '--yes-playlist',
      '--extractor-retries', '0', '--sleep-requests', '1',
      '--flat-playlist', '--dump-single-json', '--playlist-items', '1:50', '--', CHANNEL_URL
    ]]);
  });

  it('caps a run at the configured number of entries and passes the cap to the tool', async () => {
    const { adapter, tool } = await setup({}, { youtubeMaxPostsPerRun: 2 });
    const posts = await discover(adapter, CHANNEL_URL);
    expect(posts.map((post) => post.platformPostId)).toEqual(CHANNEL_IDS.slice(0, 2));
    expect(optionValue((await calls(tool))[0]!, '--playlist-items')).toBe('1:2');
  });

  it('applies the cap itself even if the tool returns more entries than asked for', async () => {
    const stdout = (await listingOf('ytdlp-youtube-channel-flat.json')).stdout!;
    const { adapter } = await setup({ lists: { [CHANNEL_URL]: { stdout, ignorePlaylistItems: true } } }, { youtubeMaxPostsPerRun: 3 });
    expect((await discover(adapter, CHANNEL_URL)).map((post) => post.platformPostId)).toEqual(CHANNEL_IDS.slice(0, 3));
  });

  it.each([[0], [-1], [501], [1.5], [Number.NaN]])('refuses the cap %s as a configuration error', async (cap) => {
    const tool = await fakeYtDlpTool();
    const error = await failureCode(YtDlpAdapter.create({ binary: tool.binary, workRoot: await tempDir(), youtubeMaxPostsPerRun: cap }));
    expect(error.code).toBe('BINARY_NOT_CONFIGURED');
    expect((await failureCode(YtDlpAdapter.create({ binary: tool.binary, workRoot: await tempDir(), pornhubMaxPostsPerRun: cap }))).code).toBe('BINARY_NOT_CONFIGURED');
  });

  it('is incremental by stable video ids: a second run lists the same ids with the same revision keys', async () => {
    const { adapter, tool } = await setup();
    const first = await discover(adapter, CHANNEL_URL);

    // New upload on top, old titles edited, view counts changed: the known videos keep id and revision.
    const changed = await readFixtureJson<{ entries: Record<string, unknown>[] }>('ytdlp-youtube-channel-flat.json');
    const fresh = { ...changed.entries[0]!, id: 'bbbbbbbbbb1', url: watch('bbbbbbbbbb1'), title: 'Brand new' };
    const edited = changed.entries.map((entry, index) => (index === 0 ? { ...entry, title: 'Renamed', view_count: 999999 } : entry));
    await tool.control({ lists: { [CHANNEL_URL]: { stdout: JSON.stringify({ ...changed, entries: [fresh, ...edited] }) } } });
    const second = await discover(adapter, CHANNEL_URL);

    expect(second.map((post) => post.platformPostId)).toEqual(['bbbbbbbbbb1', ...CHANNEL_IDS]);
    for (const post of first) {
      const again = second.find((candidate) => candidate.platformPostId === post.platformPostId)!;
      expect(again.revisionKey).toBe(post.revisionKey);
    }
  });

  it('reads a playlist in the order the site delivers it, with the owner of each video', async () => {
    const { adapter, tool } = await setup();
    const posts = await discover(adapter, PLAYLIST_URL);
    expect(posts.map((post) => post.platformPostId)).toEqual(['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3']);
    expect(posts[0]!.creator).toEqual({ platformId: 'UC1234567890abcdefghijkl', displayName: 'Own Test Channel' });
    expect((await calls(tool))[0]!.at(-1)).toBe(PLAYLIST_URL);
  });

  it('reads the shorts tab; every short is addressed by its watch address', async () => {
    const { adapter } = await setup();
    const posts = await discover(adapter, SHORTS_URL);
    expect(posts.map((post) => [post.platformPostId, post.canonicalUrl])).toEqual([['sssssssss01', watch('sssssssss01')]]);
  });

  it('reads a Pornhub list: ids come from the url of each entry because the entries carry no id', async () => {
    const { adapter, tool } = await setup();
    const posts = await discover(adapter, 'https://www.pornhub.com/model/owntestmodel');
    expect(posts.map((post) => post.platformPostId)).toEqual(PORNHUB_KEYS);
    expect(posts[0]).toMatchObject({
      sourceType: 'pornhub', title: 'Own clip one', canonicalUrl: phVideo('ph5aaaaaaaaaaa1'),
      creator: { platformId: 'model:owntestmodel', displayName: 'owntestmodel' }
    });
    expect((await calls(tool))[0]).toEqual([
      '--ignore-config', '--no-update', '--no-cache-dir', '--no-warnings', '--yes-playlist',
      '--extractor-retries', '0', '--sleep-requests', '1',
      '--flat-playlist', '--dump-single-json', '--playlist-items', '1:50', '--', PORNHUB_LIST_URL
    ]);
  });

  it('caps a Pornhub list with its own setting', async () => {
    const { adapter, tool } = await setup({}, { pornhubMaxPostsPerRun: 1, youtubeMaxPostsPerRun: 5 });
    expect((await discover(adapter, PORNHUB_LIST_URL)).map((post) => post.platformPostId)).toEqual([PORNHUB_KEYS[0]]);
    expect(optionValue((await calls(tool))[0]!, '--playlist-items')).toBe('1:1');
  });

  it('probes a list with one entry and names its owner', async () => {
    const { adapter, tool } = await setup();
    const summary = await adapter.probe({ ...jobContext, target: adapter.validateTarget(CHANNEL_URL) });
    expect(summary).toMatchObject({ available: true, title: 'YouTube: Own Test Channel', creatorId: 'UC1234567890abcdefghijkl', creatorName: 'Own Test Channel' });
    expect(optionValue((await calls(tool))[0]!, '--playlist-items')).toBe('1:1');
  });

  it('skips everything in a listing that is not a video with a usable id, and never uses it as an argument', async () => {
    const base = await readFixtureJson<{ entries: Record<string, unknown>[] }>('ytdlp-youtube-channel-flat.json');
    const hostile = {
      ...base,
      entries: [
        { ...base.entries[0], id: '--exec=touch /tmp/pwned', url: 'https://www.youtube.com/watch?v=--exec=id', title: '--exec=id' },
        { ...base.entries[0], id: 'short' },
        { ...base.entries[0], id: 'cccccccccc1', ie_key: 'YoutubeTab' },
        { ...base.entries[0], id: 'cccccccccc2', title: '--netrc-cmd=id\n--write-link', channel_id: '$(id)', channel: 'evil\u0000name' },
        { ...base.entries[0], id: 'cccccccccc2' },
        'not an object',
        null
      ]
    };
    const { adapter, tool } = await setup({ lists: { [CHANNEL_URL]: { stdout: JSON.stringify(hostile) } } });
    const posts = await discover(adapter, CHANNEL_URL);
    expect(posts.map((post) => post.platformPostId)).toEqual(['cccccccccc2']);
    expect(posts[0]).toMatchObject({ title: '--netrc-cmd=id --write-link', creator: { platformId: 'UC1234567890abcdefghijkl', displayName: 'evil name' } });
    // "$(id)" is no channel id; the owner of the list is used instead.
    for (const args of await calls(tool)) {
      const joined = args.join(' ');
      expect(joined).not.toContain('pwned');
      expect(joined).not.toContain('netrc');
      expect(joined).not.toContain('write-link');
    }
  });

  it.each([
    ['output that is not JSON', 'WARNING: something\n{"entries":'],
    ['a JSON array', '[1, 2]'],
    ['a single video instead of a list', JSON.stringify({ _type: 'video', id: 'dQw4w9WgXcQ' })],
    ['a list without entries', JSON.stringify({ _type: 'playlist', id: 'x' })]
  ])('rejects %s', async (_name, stdout) => {
    const { adapter } = await setup({ lists: { [CHANNEL_URL]: { stdout } } });
    expect((await failureCode(discover(adapter, CHANNEL_URL))).code).toBe('OUTPUT_INVALID');
  });

  it('treats an empty list as an empty list, not as a failure', async () => {
    const { adapter } = await setup({ lists: { [CHANNEL_URL]: { stdout: JSON.stringify({ _type: 'playlist', id: 'UC1234567890abcdefghijkl', entries: [] }) } } });
    expect(await discover(adapter, CHANNEL_URL)).toEqual([]);
  });
});

describe('single videos: format selection, merge and the extension of the result', () => {
  it('names the container that yt-dlp reports for the merged streams (vp9 + opus: webm, h264 + aac: mp4)', async () => {
    const { adapter } = await setup({
      videos: {
        [watch('aaaaaaaaaa1')]: await videoMetadata('ytdlp-youtube-video-modern.json', 'aaaaaaaaaa1'),
        [watch('aaaaaaaaaa5')]: await videoMetadata('ytdlp-youtube-video-h264.json', 'aaaaaaaaaa5')
      }
    });
    const posts = await discover(adapter, CHANNEL_URL);
    const modern = await resolve(adapter, posts.find((post) => post.platformPostId === 'aaaaaaaaaa1')!);
    expect(modern).toMatchObject({ discoveryComplete: true, errors: [] });
    expect(modern.assets[0]).toMatchObject({
      sourceAssetId: 'video', originalName: 'Own test video.webm', mediaType: 'video/webm',
      quality: { preset: 'BEST_AVAILABLE', width: 3840, height: 2160, container: 'webm' }
    });
    const compatible = await resolve(adapter, posts.find((post) => post.platformPostId === 'aaaaaaaaaa5')!);
    expect(compatible.assets[0]).toMatchObject({ originalName: 'Own test video.mp4', mediaType: 'video/mp4', quality: { width: 1920, height: 1080, container: 'mp4' } });
  });

  it('asks for the best video and audio stream, merged into mp4, webm or mkv, in every metadata and download call', async () => {
    const id = 'dQw4w9WgXcQ';
    const { adapter, tool } = await setup({ videos: { [watch(id)]: await videoMetadata('ytdlp-youtube-video-modern.json', id) } });
    const [post] = await discover(adapter, watch(id));
    const manifest = await resolve(adapter, post!);
    const workspace = await testWorkspace();
    const staged = await adapter.stage!(manifest.assets[0]!, {
      ...jobContext, post: post!, policy: { preset: 'BEST_AVAILABLE' }, limits: { maxBytes: 10 * 1024 * 1024 }, workspace
    });
    expect(staged).toMatchObject({ mediaType: 'video/mp4', relativePath: 'media/item-0000.mp4' });

    const all = await calls(tool);
    expect(all).toHaveLength(3); // discover, resolve, download
    for (const args of all) {
      expect(args.slice(-2)).toEqual(['--', watch(id)]);
      expect(optionValue(args, '-f')).toBe(BEST);
      expect(optionValue(args, '--merge-output-format')).toBe('mp4/webm/mkv');
      expect(args).toContain('--no-playlist');
      expect(args).not.toContain('--yes-playlist');
      for (const forbidden of FORBIDDEN_OPTIONS) expect(args.some((arg) => arg.startsWith(forbidden))).toBe(false);
    }
    expect(all[2]).toEqual([
      '--ignore-config', '--no-update', '--no-cache-dir', '--no-warnings', '--no-playlist',
      '--extractor-retries', '0', '--sleep-requests', '1', '--sleep-interval', '3', '--max-sleep-interval', '8',
      '--no-progress', '--no-mtime', '--max-filesize', String(10 * 1024 * 1024),
      '-f', BEST, '--merge-output-format', 'mp4/webm/mkv', '--abort-on-unavailable-fragments',
      '-o', 'asset.%(ext)s', '--', watch(id)
    ]);
  });

  it('finds ffmpeg and deno through the PATH the administrator configured, and sets no JavaScript runtime option', async () => {
    const id = 'dQw4w9WgXcQ';
    const { adapter, tool } = await setup({ videos: { [watch(id)]: await videoMetadata('ytdlp-youtube-video-h264.json', id) } }, { toolPath: '/opt/kura-tools/bin' });
    await discover(adapter, watch(id));
    const [environment] = await tool.environments();
    expect(environment!.PATH).toBe('/opt/kura-tools/bin');
    // yt-dlp enables deno by default (options.py: --js-runtimes default ['deno']) and looks it up on PATH.
    for (const args of await calls(tool)) {
      expect(args).not.toContain('--js-runtimes');
      expect(args).not.toContain('--remote-components');
      expect(args).not.toContain('--ffmpeg-location');
    }
  });

  it('downloads a webm result as such', async () => {
    const id = 'dQw4w9WgXcQ';
    const { adapter } = await setup({
      videos: { [watch(id)]: await videoMetadata('ytdlp-youtube-video-modern.json', id) },
      downloads: { [watch(id)]: { ext: 'webm' } }
    });
    const [post] = await discover(adapter, watch(id));
    const manifest = await resolve(adapter, post!);
    const staged = await adapter.stage!(manifest.assets[0]!, {
      ...jobContext, post: post!, policy: { preset: 'BEST_AVAILABLE' }, limits: { maxBytes: 10 * 1024 * 1024 }, workspace: await testWorkspace()
    });
    expect(staged).toMatchObject({ mediaType: 'video/webm', relativePath: 'media/item-0000.webm' });
  });

  it('derives the revision of a single video from its id alone, like a video of a list', async () => {
    const id = 'dQw4w9WgXcQ';
    const { adapter } = await setup({ videos: { [watch(id)]: await videoMetadata('ytdlp-youtube-video-h264.json', id) } });
    const [post] = await discover(adapter, watch(id));
    expect(post!.revisionKey).toMatch(/^v-[0-9a-f]{24}$/);
    expect(post).toMatchObject({ publishedAt: '2026-01-05T00:00:00.000Z', title: 'Own test video' });
  });
});

describe('livestreams and announced videos', () => {
  it('skips a running livestream with its own entry state and never starts a download for it', async () => {
    const live = 'aaaaaaaaaa2';
    const { adapter, tool } = await setup({ videos: { [watch(live)]: await videoMetadata('ytdlp-youtube-video-live.json', live) } });
    const posts = await discover(adapter, CHANNEL_URL);
    const manifest = await resolve(adapter, posts.find((post) => post.platformPostId === live)!);

    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0]).toMatchObject({
      unavailable: { code: 'ASSET_NOT_YET_AVAILABLE', message: expect.stringContaining('Livestream läuft gerade') },
      completeness: 'incomplete'
    });
    const workspace = await testWorkspace();
    expect((await failureCode(adapter.stage!(manifest.assets[0]!, {
      ...jobContext, post: posts[1]!, policy: { preset: 'BEST_AVAILABLE' }, limits: { maxBytes: 1024 }, workspace
    }))).code).toBe('STAGING_REJECTED');
    // Only the listing and the metadata call ran; no download call exists.
    expect((await calls(tool)).filter((args) => args.includes('--no-progress'))).toEqual([]);
  });

  it.each([
    ['a premiere', 'ytdlp-error-youtube-premiere.txt'],
    ['a live event that has not begun', 'ytdlp-error-youtube-live-upcoming.txt']
  ])('records %s as not yet available instead of failing the run', async (_name, fixtureName) => {
    const { adapter } = await setup({ videos: { [watch('aaaaaaaaaa3')]: await failureOf(fixtureName) } });
    const posts = await discover(adapter, CHANNEL_URL);
    const manifest = await resolve(adapter, posts.find((post) => post.platformPostId === 'aaaaaaaaaa3')!);
    expect(manifest.assets[0]!.unavailable).toMatchObject({ code: 'ASSET_NOT_YET_AVAILABLE', message: expect.stringContaining('angekündigt') });
  });

  it('downloads a livestream that has ended (was_live) like any other video', async () => {
    const ended = 'aaaaaaaaaa6';
    const { adapter } = await setup({ videos: { [watch(ended)]: await videoMetadata('ytdlp-youtube-video-h264.json', ended, { live_status: 'was_live', was_live: true }) } });
    const posts = await discover(adapter, CHANNEL_URL);
    const manifest = await resolve(adapter, posts.find((post) => post.platformPostId === ended)!);
    expect(manifest.assets[0]).toMatchObject({ mediaType: 'video/mp4' });
    expect(manifest.assets[0]!.unavailable).toBeUndefined();
  });
});

describe('failures and entry states, from the error output of the real yt-dlp', () => {
  const ID = 'aaaaaaaaaa4';
  const withCookies = (path = '/run/kura/private/cookies.txt'): RunCredentials => ({ cookiesFilePath: path });

  async function postWith(video: Awaited<ReturnType<typeof failureOf>>, credentials?: RunCredentials) {
    const { adapter, tool } = await setup({ videos: { [watch(ID)]: video } });
    const posts = await discover(adapter, CHANNEL_URL, credentials);
    return { adapter, tool, post: posts.find((post) => post.platformPostId === ID)! };
  }

  it('maps "Sign in to confirm you are not a bot" to AUTH_REQUIRED and says to upload YouTube cookies', async () => {
    const { adapter, post } = await postWith(await failureOf('ytdlp-error-youtube-bot.txt'));
    const error = await failureCode(resolve(adapter, post));
    expect(error.code).toBe('AUTH_REQUIRED');
    expect(error.userMessage).toMatch(/Sicherheitsprüfung/);
    expect(error.userMessage).toMatch(/Cookies/);
    expect(error.userMessage).not.toMatch(/ — |–/);
    // The tool's own text is kept as untrusted diagnostics only.
    expect(error.message).not.toMatch(/Sign in/);
    expect(error.untrustedDiagnostics).toMatch(/not a bot/);
  });

  it('words the bot check differently when cookies were already handed over', async () => {
    const { adapter, post } = await postWith(await failureOf('ytdlp-error-youtube-bot.txt'));
    const error = await failureCode(resolve(adapter, post, withCookies()));
    expect(error).toMatchObject({ code: 'AUTH_REQUIRED' });
    expect(error.userMessage).toMatch(/trotz der hinterlegten Cookies/);
  });

  it.each([
    ['age-restricted', 'ytdlp-error-youtube-age.txt'],
    ['members-only', 'ytdlp-error-youtube-members.txt']
  ])('maps a %s video to AUTH_REQUIRED without cookies, so the worker asks for YouTube cookies', async (_name, fixtureName) => {
    const { adapter, post } = await postWith(await failureOf(fixtureName));
    expect((await failureCode(resolve(adapter, post))).code).toBe('AUTH_REQUIRED');
  });

  it.each([
    ['age-restricted', 'ytdlp-error-youtube-age.txt', /Altersbeschränkung/],
    ['members-only', 'ytdlp-error-youtube-members.txt', /Kanalmitglieder/]
  ])('records a %s video as not accessible for an account that is already logged in, and goes on', async (_name, fixtureName, message) => {
    const { adapter, post } = await postWith(await failureOf(fixtureName), withCookies());
    const manifest = await resolve(adapter, post, withCookies());
    expect(manifest.assets[0]!.unavailable).toMatchObject({ code: 'ASSET_NOT_ACCESSIBLE', message: expect.stringMatching(message) });
  });

  it.each([
    ['a private video', 'ytdlp-error-youtube-private.txt', /privat/],
    ['a removed video', 'ytdlp-error-youtube-unavailable.txt', /nicht mehr verfügbar/],
    ['a video blocked in the region', 'ytdlp-error-youtube-geo.txt', /Regionssperre/]
  ])('records %s as a terminal state of that entry, whether or not cookies exist', async (_name, fixtureName, message) => {
    for (const credentials of [undefined, withCookies()]) {
      const { adapter, post } = await postWith(await failureOf(fixtureName), credentials);
      const manifest = await resolve(adapter, post, credentials);
      expect(manifest).toMatchObject({ discoveryComplete: true, errors: [] });
      expect(manifest.assets[0]!.unavailable).toMatchObject({ code: 'ASSET_NOT_ACCESSIBLE', message: expect.stringMatching(message) });
    }
  });

  it.each([
    ['HTTP 429', 'ytdlp-error-youtube-http429.txt'],
    ['"This content isn\u2019t available, try again later"', 'ytdlp-error-youtube-trylater.txt']
  ])('maps %s to RATE_LIMITED', async (_name, fixtureName) => {
    const { adapter, post } = await postWith(await failureOf(fixtureName));
    expect((await failureCode(resolve(adapter, post))).code).toBe('RATE_LIMITED');
  });

  it.each([
    ['HTTP 429', 'ytdlp-error-youtube-http429.txt', 'RATE_LIMITED'],
    ['a bot check', 'ytdlp-error-youtube-bot.txt', 'AUTH_REQUIRED'],
    ['a missing channel', 'ytdlp-error-youtube-channel-missing.txt', 'TARGET_NOT_FOUND'],
    ['a missing tab', 'ytdlp-error-youtube-no-tab.txt', 'TARGET_NOT_FOUND'],
    ['a missing playlist', 'ytdlp-error-youtube-playlist-missing.txt', 'TARGET_NOT_FOUND']
  ])('maps %s of a listing to %s', async (_name, fixtureName, code) => {
    const { adapter } = await setup({ lists: { [CHANNEL_URL]: await failureOf(fixtureName) } });
    const error = await failureCode(discover(adapter, CHANNEL_URL));
    expect(error.code).toBe(code);
    if (code === 'TARGET_NOT_FOUND') expect(error.userMessage).toMatch(/nicht gefunden|Reiter/);
  });

  it('answers a private or removed list as a missing target, not as one unavailable entry', async () => {
    const { adapter } = await setup({ lists: { [PLAYLIST_URL]: await failureOf('ytdlp-error-youtube-private.txt') } });
    expect((await failureCode(discover(adapter, PLAYLIST_URL))).code).toBe('TARGET_NOT_FOUND');
  });

  it('keeps an unknown failure as PROCESS_FAILED with the tool text only as diagnostics', async () => {
    const { adapter } = await setup({ lists: { [CHANNEL_URL]: { stderr: 'ERROR: [youtube:tab] x: something nobody has seen --exec=id\n', exitCode: 1 } } });
    const error = await failureCode(discover(adapter, CHANNEL_URL));
    expect(error.code).toBe('PROCESS_FAILED');
    expect(error.message).not.toContain('exec');
    expect(error.untrustedDiagnostics).toContain('something nobody has seen');
  });

  it('reports a missing ffmpeg as a tool that is not installed, not as a broken video', async () => {
    const stderr = 'ERROR: You have requested merging of multiple formats but ffmpeg is not installed. Aborting due to --abort-on-error\n';
    const { adapter, tool } = await setup({ videos: { [watch(ID)]: await videoMetadata('ytdlp-youtube-video-h264.json', ID) } });
    const [post] = (await discover(adapter, CHANNEL_URL)).filter((candidate) => candidate.platformPostId === ID);
    const manifest = await resolve(adapter, post!);
    await tool.control({ videos: { [watch(ID)]: await videoMetadata('ytdlp-youtube-video-h264.json', ID) }, downloads: { [watch(ID)]: { exitCode: 1, stderr } } });
    const error = await failureCode(adapter.stage!(manifest.assets[0]!, {
      ...jobContext, post: post!, policy: { preset: 'BEST_AVAILABLE' }, limits: { maxBytes: 1024 * 1024 }, workspace: await testWorkspace()
    }));
    expect(error.code).toBe('BINARY_NOT_CONFIGURED');
  });

  it('does not let a warning line decide anything', async () => {
    const { adapter } = await setup({ lists: { [CHANNEL_URL]: { stderr: 'WARNING: [youtube] Sign in to confirm you are not a bot\n', exitCode: 1 } } });
    expect((await failureCode(discover(adapter, CHANNEL_URL))).code).toBe('PROCESS_FAILED');
  });

  it('turns a failed download into an asset failure of that video, or into a run-wide problem for a login or throttling', async () => {
    const { adapter, tool } = await setup({ videos: { [watch(ID)]: await videoMetadata('ytdlp-youtube-video-h264.json', ID) } });
    const [post] = (await discover(adapter, CHANNEL_URL)).filter((candidate) => candidate.platformPostId === ID);
    const manifest = await resolve(adapter, post!);
    const context = { ...jobContext, post: post!, policy: { preset: 'BEST_AVAILABLE' as const }, limits: { maxBytes: 1024 * 1024 } };

    const cases: Array<[string, string, string]> = [
      ['ytdlp-error-youtube-private.txt', 'TARGET_NOT_FOUND', 'privat'],
      ['ytdlp-error-youtube-http429.txt', 'RATE_LIMITED', ''],
      ['ytdlp-error-youtube-bot.txt', 'AUTH_REQUIRED', 'Sicherheitsprüfung']
    ];
    for (const [fixtureName, code, message] of cases) {
      const failed = await failureOf(fixtureName);
      await tool.control({ videos: { [watch(ID)]: await videoMetadata('ytdlp-youtube-video-h264.json', ID) }, downloads: { [watch(ID)]: { exitCode: 1, stderr: failed.stderr } } });
      const error = await failureCode(adapter.stage!(manifest.assets[0]!, { ...context, workspace: await testWorkspace() }));
      expect(error.code).toBe(code);
      if (message) expect(error.userMessage).toContain(message);
    }
  });
});

describe('Pornhub entries', () => {
  const KEY = 'ph5aaaaaaaaaaa1';

  async function pornhubPost(video: Awaited<ReturnType<typeof failureOf>>) {
    const { adapter, tool } = await setup({ videos: { [phVideo(KEY)]: video } });
    const posts = await discover(adapter, phVideo(KEY));
    return { adapter, tool, post: posts[0]! };
  }

  it('reads a single video, with the creator taken from the uploader path', async () => {
    const info = JSON.stringify({
      _type: 'video', id: KEY, title: 'Own clip one', ext: 'mp4', uploader: 'Own Uploader', uploader_id: '/users/own-uploader',
      upload_date: '20260105', duration: 361, width: 1280, height: 720, formats: []
    });
    const { adapter, tool } = await setup({ videos: { [phVideo(KEY)]: { stdout: info } } });
    const [post] = await discover(adapter, phVideo(KEY));
    expect(post).toMatchObject({
      sourceType: 'pornhub', platformPostId: KEY, canonicalUrl: phVideo(KEY), title: 'Own clip one',
      creator: { platformId: 'users:own-uploader', displayName: 'Own Uploader' }
    });
    const manifest = await resolve(adapter, post!);
    expect(manifest.assets[0]).toMatchObject({ mediaType: 'video/mp4', quality: { width: 1280, height: 720 } });
    // Pornhub gets the same pacing and format options, and never a cookies option.
    for (const args of await calls(tool)) {
      expect(args).toContain('--sleep-requests');
      expect(args).not.toContain('--cookies');
    }
  });

  it('refuses metadata for a different viewkey than requested', async () => {
    const wrong = JSON.stringify({ _type: 'video', id: 'ph5bbbbbbbbbbb2', title: 'x', ext: 'mp4' });
    const { adapter } = await setup({ videos: { [phVideo(KEY)]: { stdout: wrong } } });
    expect((await failureCode(discover(adapter, phVideo(KEY)))).code).toBe('OUTPUT_INVALID');
  });

  it.each([
    ['a video that was removed', 'ytdlp-error-pornhub-removed.txt', /von Pornhub entfernt/],
    ['a region block', 'ytdlp-error-pornhub-geo.txt', /Regionssperre/],
    ['a redirect (deleted or login needed)', 'ytdlp-error-pornhub-redirect.txt', /weitergeleitet/]
  ])('records %s as a terminal state of that entry', async (_name, fixtureName, message) => {
    const { adapter, post } = await pornhubPost(await failureOf(fixtureName));
    const manifest = await resolve(adapter, post);
    expect(manifest.assets[0]!.unavailable).toMatchObject({ code: 'ASSET_NOT_ACCESSIBLE', message: expect.stringMatching(message) });
  });

  it('maps a refused request (HTTP 403) of a list to AUTH_REQUIRED with a Pornhub sentence, and a missing list to TARGET_NOT_FOUND', async () => {
    const refused = { stderr: 'ERROR: [PornHubPagedVideoList] x: Unable to download webpage: HTTP Error 403: Forbidden\n', exitCode: 1 };
    const missing = { stderr: 'ERROR: [PornHubPagedVideoList] x: Unable to download webpage: HTTP Error 404: Not Found\n', exitCode: 1 };
    const { adapter, tool } = await setup({ lists: { [PORNHUB_LIST_URL]: refused } });
    const blocked = await failureCode(discover(adapter, PORNHUB_LIST_URL));
    expect(blocked.code).toBe('AUTH_REQUIRED');
    expect(blocked.userMessage).toMatch(/Pornhub hat den Abruf abgelehnt/);
    await tool.control({ lists: { [PORNHUB_LIST_URL]: missing } });
    const gone = await failureCode(discover(adapter, PORNHUB_LIST_URL));
    expect(gone.code).toBe('TARGET_NOT_FOUND');
    expect(gone.userMessage).toMatch(/Pornhub-Seite wurde nicht gefunden/);
  });
});

describe('cookies', () => {
  const SECRET = 'FAKE-YOUTUBE-LOGIN-INFO-0123456789';

  async function cookieFile(): Promise<string> {
    const directory = join(await tempDir('kura-p2-cookies-'), 'private');
    await mkdir(directory, { mode: 0o700 });
    const path = join(directory, 'cookies.txt');
    await writeFile(path, `# Netscape HTTP Cookie File\n.youtube.com\tTRUE\t/\tTRUE\t2000000000\tLOGIN_INFO\t${SECRET}\n`, { mode: 0o600 });
    await chmod(path, 0o600);
    return path;
  }

  it('passes the cookies file to YouTube lists, metadata and downloads, and the tool can read it', async () => {
    const id = 'dQw4w9WgXcQ';
    const path = await cookieFile();
    const credentials = { cookiesFilePath: path };
    const { adapter, tool } = await setup({ videos: { [watch(id)]: await videoMetadata('ytdlp-youtube-video-h264.json', id) } });

    await discover(adapter, CHANNEL_URL, credentials);
    const [post] = await discover(adapter, watch(id), credentials);
    const manifest = await resolve(adapter, post!, credentials);
    await adapter.stage!(manifest.assets[0]!, {
      ...jobContext, post: post!, policy: { preset: 'BEST_AVAILABLE' }, limits: { maxBytes: 1024 * 1024 }, workspace: await testWorkspace(), credentials
    });

    const all = await calls(tool);
    expect(all).toHaveLength(4);
    for (const args of all) expect(optionValue(args, '--cookies')).toBe(path);
    const seen = await tool.cookies();
    expect(seen).toHaveLength(4);
    for (const observation of seen) expect(observation).toMatchObject({ path, mode: '600', content: expect.stringContaining(SECRET) });
  });

  it('passes no --cookies option when nothing was handed over, and never to Pornhub or Instagram', async () => {
    const path = await cookieFile();
    const { adapter, tool } = await setup({ videos: { [phVideo('ph5aaaaaaaaaaa1')]: { stdout: JSON.stringify({ _type: 'video', id: 'ph5aaaaaaaaaaa1', title: 'x', ext: 'mp4' }) } } });
    await discover(adapter, CHANNEL_URL);
    await discover(adapter, PORNHUB_LIST_URL, { cookiesFilePath: path });
    await discover(adapter, phVideo('ph5aaaaaaaaaaa1'), { cookiesFilePath: path });
    expect((await calls(tool)).flat()).not.toContain('--cookies');
    expect(await tool.cookies()).toEqual([]);
  });

  it('refuses a cookies path that is not absolute or has control characters before any process starts', async () => {
    const { adapter, tool } = await setup();
    for (const cookiesFilePath of ['--evil', 'relative/cookies.txt', '/run/kura/cookies.txt\n--exec=id']) {
      expect((await failureCode(discover(adapter, CHANNEL_URL, { cookiesFilePath }))).code).toBe('PROCESS_SPAWN_FAILED');
    }
    expect(await calls(tool)).toEqual([]);
  });

  it('never carries the cookie content into an argument, the environment, an error or a post', async () => {
    const path = await cookieFile();
    const credentials = { cookiesFilePath: path };
    const { adapter, tool } = await setup({ lists: { [CHANNEL_URL]: await failureOf('ytdlp-error-youtube-bot.txt') } });
    const error = await failureCode(discover(adapter, CHANNEL_URL, credentials));
    const text = JSON.stringify([error.message, error.userMessage, error.untrustedDiagnostics, error.code]);
    expect(text).not.toContain(SECRET);
    expect(JSON.stringify(await calls(tool))).not.toContain(SECRET);
    expect(JSON.stringify(await tool.environments())).not.toContain(SECRET);

    await tool.control({ lists: { [CHANNEL_URL]: await listingOf('ytdlp-youtube-channel-flat.json') } });
    expect(JSON.stringify(await discover(adapter, CHANNEL_URL, credentials))).not.toContain(SECRET);
  });
});

describe('options and stored posts cannot be forged', () => {
  it('puts the URL after "--" in every call, and no option from the advisories or for remote code', async () => {
    const id = 'aaaaaaaaaa1';
    const { adapter, tool } = await setup({ videos: { [watch(id)]: await videoMetadata('ytdlp-youtube-video-h264.json', id) } });
    const posts = await discover(adapter, CHANNEL_URL);
    await discover(adapter, PORNHUB_LIST_URL);
    await resolve(adapter, posts[0]!);
    for (const args of await calls(tool)) {
      const separator = args.indexOf('--');
      expect(separator).toBe(args.length - 2);
      expect(args[separator + 1]).toMatch(/^https:\/\//);
      expect(args).toEqual(expect.arrayContaining(['--ignore-config', '--no-update', '--no-cache-dir']));
      for (const forbidden of FORBIDDEN_OPTIONS) expect(args.some((arg) => arg.startsWith(forbidden))).toBe(false);
    }
  });

  it('refuses a post whose stored address was changed, and a target that does not match its canonical address', async () => {
    const { adapter, tool } = await setup();
    const [post] = await discover(adapter, CHANNEL_URL);
    const before = (await calls(tool)).length;
    for (const canonicalUrl of [
      '--exec=touch /tmp/pwned',
      'https://evil.example.test/x',
      `${post!.canonicalUrl}&x=1`,
      CHANNEL_URL, // a feed is no post
      'https://www.youtube.com/playlist?list=PLabcdefghijklmnop'
    ]) {
      expect((await failureCode(resolve(adapter, { ...post!, canonicalUrl }))).code).toMatch(/^TARGET_/);
    }
    expect((await failureCode(resolve(adapter, { ...post!, platformPostId: 'zzzzzzzzzzz' }))).code).toBe('TARGET_INVALID');
    expect((await failureCode(resolve(adapter, { ...post!, sourceType: 'pornhub' }))).code).toBe('TARGET_INVALID');
    expect((await failureCode(resolve(adapter, { ...post!, adapterId: 'gallery-dl' }))).code).toBe('TARGET_INVALID');

    const target = adapter.validateTarget(CHANNEL_URL);
    for (const forged of [
      { ...target, canonicalUrl: 'https://www.youtube.com/@other/videos' },
      { ...target, platformId: 'x' },
      { ...target, kind: 'post' as const }
    ]) {
      expect((await failureCode(collect(adapter.discover({ ...jobContext, target: forged })))).code).toBe('TARGET_INVALID');
    }
    expect((await calls(tool)).length).toBe(before);
  });

  it('refuses presets other than BEST_AVAILABLE', async () => {
    const { adapter } = await setup();
    const [post] = await discover(adapter, CHANNEL_URL);
    expect((await failureCode(adapter.resolveAssets(post!, { preset: 'SOURCE_BYTES' }))).code).toBe('POLICY_UNSUPPORTED');
  });

  it('cannot run at all in the validation-only instance the API uses', async () => {
    const recognizer = YtDlpAdapter.forTargetValidationOnly();
    const target = recognizer.validateTarget(CHANNEL_URL);
    expect((await failureCode(collect(recognizer.discover({ ...jobContext, target })))).code).toBe('BINARY_NOT_CONFIGURED');
  });
});
