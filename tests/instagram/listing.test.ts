import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  GalleryDlAdapter,
  INSTAGRAM_DEFAULT_MAX_POSTS_PER_RUN,
  type AssetManifest,
  type SourcePost
} from '../../packages/adapters/src/index.js';
import { tempDir, testWorkspace } from '../adapters/helpers.js';
import { fakeInstagramGalleryDl, fixture, INSTAGRAM_ROOT, type FakeInstagramTool, type InstagramToolControl } from './fake-instagram-tool.js';

const jobContext = { jobId: 'job-ig', leaseGeneration: 1 };
const PROFILE = `${INSTAGRAM_ROOT}/own_test_account/`;
const PROFILE_TOOL_URL = `${INSTAGRAM_ROOT}/own_test_account/posts/`;
const REELS_TAB = `${INSTAGRAM_ROOT}/own_test_account/reels/`;

/** Listings as the tool prints them for each URL it may be asked about; fixtures come from the real extractor code. */
async function allListings(): Promise<Record<string, unknown>> {
  return {
    [PROFILE_TOOL_URL]: await fixture('profile-posts'),
    [REELS_TAB]: await fixture('profile-reels'),
    [`${INSTAGRAM_ROOT}/p/DPhoto00001/`]: await fixture('post-photo'),
    [`${INSTAGRAM_ROOT}/p/DCarous0001/`]: await fixture('post-carousel'),
    [`${INSTAGRAM_ROOT}/reel/DNewReel001/`]: await fixture('post-reel')
  };
}

interface Setup { adapter: GalleryDlAdapter; tool: FakeInstagramTool; workRoot: string }

async function setup(control: InstagramToolControl = {}, options: { instagramMaxPostsPerRun?: number } = {}): Promise<Setup> {
  const tool = await fakeInstagramGalleryDl({ listings: await allListings(), ...control });
  const workRoot = await tempDir('kura-ig-workroot-');
  const adapter = await GalleryDlAdapter.create({ binary: tool.binary, workRoot, extraEnv: tool.env, ...options });
  return { adapter, tool, workRoot };
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const items: T[] = [];
  for await (const item of iterable) items.push(item);
  return items;
}

async function discover(adapter: GalleryDlAdapter, url: string): Promise<SourcePost[]> {
  return collect(adapter.discover({ ...jobContext, target: adapter.validateTarget(url) }));
}

async function resolve(adapter: GalleryDlAdapter, url: string): Promise<{ post: SourcePost; manifest: AssetManifest }> {
  const [post] = await discover(adapter, url);
  return { post: post!, manifest: await adapter.resolveAssets(post!, { preset: 'BEST_AVAILABLE' }) };
}

/** The argument arrays of the calls that were not `--version`. */
async function toolCalls(tool: FakeInstagramTool): Promise<string[][]> {
  return (await tool.calls()).filter((args) => !args.includes('--version'));
}

function optionValue(args: string[], option: string): string | undefined {
  const at = args.indexOf(option);
  return at >= 0 ? args[at + 1] : undefined;
}

describe('Instagram capabilities', () => {
  it('declares single posts, feeds, pagination, images and videos with cookies as the login for Instagram only', async () => {
    const { adapter } = await setup();
    const { capabilitiesForSourceType } = await import('../../packages/adapters/src/index.js');
    expect(capabilitiesForSourceType(adapter.capabilities(), 'instagram')).toMatchObject({
      single_post: true, creator_feed: true, pagination: true, images: true, videos: true, auth_kind: 'cookies', resume: false
    });
    expect(capabilitiesForSourceType(adapter.capabilities(), 'pixiv')).toMatchObject({ creator_feed: false, auth_kind: 'none' });
  });
});

describe('single posts', () => {
  it('turns a single photo into one image asset', async () => {
    const { adapter } = await setup();
    const { post, manifest } = await resolve(adapter, 'https://www.instagram.com/p/DPhoto00001/?igsh=abc');

    expect(post).toMatchObject({
      adapterId: 'gallery-dl', sourceType: 'instagram', platformPostId: 'DPhoto00001', canonicalUrl: `${INSTAGRAM_ROOT}/p/DPhoto00001/`,
      creator: { platformId: '4242424242', displayName: 'Own Test Account' }, title: 'Own photo #test', publishedAt: '2026-01-03T00:00:00.000Z'
    });
    expect(manifest).toMatchObject({ platformPostId: 'DPhoto00001', creatorId: '4242424242', discoveryComplete: true, errors: [] });
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0]).toMatchObject({
      assetIndex: 0, sourceAssetId: 'media-3000000000000000103', originalName: 'DPhoto00001_1.jpg', mediaType: 'image/jpeg',
      role: 'original', completeness: 'complete', quality: { width: 1080, height: 1350, container: 'jpg' }
    });
  });

  it('turns a carousel into one asset per image or video, with the position as index', async () => {
    const { adapter } = await setup();
    const { post, manifest } = await resolve(adapter, 'https://www.instagram.com/p/DCarous0001/');

    // The date of the post, not the date of its first item.
    expect(post.publishedAt).toBe('2026-01-04T00:00:00.000Z');
    expect(manifest.assets.map((asset) => [asset.assetIndex, asset.sourceAssetId, asset.originalName, asset.mediaType])).toEqual([
      [0, 'media-9001', 'DCarous0001_1.jpg', 'image/jpeg'],
      [1, 'media-9002', 'DCarous0001_2.jpg', 'image/jpeg'],
      [2, 'media-9003', 'DCarous0001_3.mp4', 'video/mp4']
    ]);
    expect(manifest.discoveryComplete).toBe(true);
  });

  it('turns a reel into one video asset and no separate thumbnail', async () => {
    const { adapter } = await setup();
    const { post, manifest } = await resolve(adapter, 'https://www.instagram.com/reel/DNewReel001/');

    expect(post.canonicalUrl).toBe(`${INSTAGRAM_ROOT}/reel/DNewReel001/`);
    expect(manifest.assets).toHaveLength(1);
    expect(manifest.assets[0]).toMatchObject({ assetIndex: 0, mediaType: 'video/mp4', originalName: 'DNewReel001_1.mp4', role: 'original', variant: 'original' });
    expect(manifest.assets.filter((asset) => asset.mediaType.startsWith('image/'))).toEqual([]);
  });

  it('asks gallery-dl for the reel under /reel/ when the address used /reels/', async () => {
    const { adapter, tool } = await setup();
    await discover(adapter, 'https://www.instagram.com/reels/DNewReel001/');
    const [listing] = await toolCalls(tool);
    expect(listing!.slice(-2)).toEqual(['--', `${INSTAGRAM_ROOT}/reel/DNewReel001/`]);
  });

  it('addresses each asset of a carousel only by its position and stages the right bytes', async () => {
    const { adapter, tool } = await setup();
    const { post, manifest } = await resolve(adapter, 'https://www.instagram.com/p/DCarous0001/');
    const staged = [];
    for (const asset of manifest.assets) {
      staged.push(await adapter.stage(asset, { ...jobContext, post, policy: { preset: 'BEST_AVAILABLE' }, limits: { maxBytes: 10 * 1024 * 1024 }, workspace: await testWorkspace() }));
    }
    expect(staged.map((file) => [file.assetIndex, file.mediaType])).toEqual([[0, 'image/jpeg'], [1, 'image/jpeg'], [2, 'video/mp4']]);
    expect(new Set(staged.map((file) => file.sha256)).size).toBe(3);

    const downloads = (await toolCalls(tool)).filter((args) => args.includes('--range'));
    expect(downloads.map((args) => optionValue(args, '--range'))).toEqual(['1', '2', '3']);
    for (const args of downloads) {
      expect(args.slice(-2)).toEqual(['--', `${INSTAGRAM_ROOT}/p/DCarous0001/`]);
      expect(args).toContain('--sleep');
      expect(optionValue(args, '--sleep')).toBe('2-5');
    }
  });

  it('refuses an Instagram post that came back for a different shortcode', async () => {
    const { adapter } = await setup({ listings: { [`${INSTAGRAM_ROOT}/p/DPhoto00001/`]: await fixture('post-reel') } });
    await expect(discover(adapter, 'https://www.instagram.com/p/DPhoto00001/')).rejects.toMatchObject({ code: 'OUTPUT_INVALID' });
  });
});

describe('profile discovery', () => {
  it('lists the posts of a profile newest first with stable ids, and addresses each by its own URL', async () => {
    const { adapter } = await setup();
    const posts = await discover(adapter, 'https://www.instagram.com/Own_Test_Account/?igsh=abc');

    // The tool prints the pinned (old) post first; the adapter orders by date.
    expect(posts.map((post) => post.platformPostId)).toEqual(['DNewReel001', 'DCarous0001', 'DPhoto00001', 'DOlder00001', 'DPinned0001']);
    expect(posts.map((post) => post.canonicalUrl)).toEqual([
      `${INSTAGRAM_ROOT}/reel/DNewReel001/`, `${INSTAGRAM_ROOT}/p/DCarous0001/`, `${INSTAGRAM_ROOT}/p/DPhoto00001/`,
      `${INSTAGRAM_ROOT}/p/DOlder00001/`, `${INSTAGRAM_ROOT}/p/DPinned0001/`
    ]);
    expect(posts.map((post) => post.publishedAt)).toEqual([
      '2026-01-05T00:00:00.000Z', '2026-01-04T00:00:00.000Z', '2026-01-03T00:00:00.000Z', '2026-01-02T00:00:00.000Z', '2025-01-01T00:00:00.000Z'
    ]);
    for (const post of posts) {
      expect(post).toMatchObject({ adapterId: 'gallery-dl', sourceType: 'instagram', creator: { platformId: '4242424242', displayName: 'Own Test Account' } });
      expect(post.revisionKey).toMatch(/^l-[0-9a-f]{24}$/);
    }
    // Ids and revision keys are stable between two runs over the same data.
    expect((await discover(adapter, PROFILE)).map((post) => [post.platformPostId, post.revisionKey])).toEqual(posts.map((post) => [post.platformPostId, post.revisionKey]));
  });

  it('reads the profile through its explicit /posts/ page and with polite settings', async () => {
    const { adapter, tool } = await setup();
    await discover(adapter, PROFILE);
    const [listing] = await toolCalls(tool);
    expect(listing).toEqual([
      '--config-ignore', '--dump-json',
      '--sleep-request', '8-15', '--retries', '0', '-o', 'extractor.instagram.videos=merged',
      '--post-range', `1-${INSTAGRAM_DEFAULT_MAX_POSTS_PER_RUN}`,
      '--', PROFILE_TOOL_URL
    ]);
  });

  it('bounds the run to the configured number of posts (the first run of a subscription)', async () => {
    expect(INSTAGRAM_DEFAULT_MAX_POSTS_PER_RUN).toBe(50);
    const { adapter, tool } = await setup({}, { instagramMaxPostsPerRun: 2 });
    const posts = await discover(adapter, PROFILE);
    expect(optionValue((await toolCalls(tool))[0]!, '--post-range')).toBe('1-2');
    expect(posts).toHaveLength(2);
  });

  it('cuts a listing that is longer than the bound even if the tool ignored the range', async () => {
    const profile = await fixture('profile-posts');
    const { adapter } = await setup({ rawOutput: JSON.stringify(profile) }, { instagramMaxPostsPerRun: 3 });
    expect(await discover(adapter, PROFILE)).toHaveLength(3);
  });

  it.each([0, 501, 1.5, Number.NaN])('rejects a bound of %s', async (instagramMaxPostsPerRun) => {
    const tool = await fakeInstagramGalleryDl();
    await expect(GalleryDlAdapter.create({ binary: tool.binary, workRoot: await tempDir(), instagramMaxPostsPerRun })).rejects.toMatchObject({ code: 'BINARY_NOT_CONFIGURED' });
  });

  it('reads the reels tab as a profile with the reels page as the tool address', async () => {
    const { adapter, tool } = await setup();
    const posts = await discover(adapter, 'https://www.instagram.com/own_test_account/reels/');
    expect(posts.map((post) => post.platformPostId)).toEqual(['DNewReel001']);
    expect(posts[0]!.canonicalUrl).toBe(`${INSTAGRAM_ROOT}/reel/DNewReel001/`);
    expect((await toolCalls(tool))[0]!.slice(-2)).toEqual(['--', REELS_TAB]);
  });

  it('probes a profile with a single post so that a login problem shows up early and cheaply', async () => {
    const { adapter, tool } = await setup();
    const summary = await adapter.probe({ ...jobContext, target: adapter.validateTarget(PROFILE) });
    expect(summary).toMatchObject({ available: true, creatorId: '4242424242', creatorName: 'Own Test Account', title: 'Instagram: Own Test Account' });
    expect(optionValue((await toolCalls(tool))[0]!, '--post-range')).toBe('1-1');
  });

  it('resolves a post of the profile like a single post: one asset per carousel item, a reel as one video', async () => {
    const { adapter } = await setup();
    const posts = await discover(adapter, PROFILE);
    const carousel = posts.find((post) => post.platformPostId === 'DCarous0001')!;
    const reel = posts.find((post) => post.platformPostId === 'DNewReel001')!;
    const carouselManifest = await adapter.resolveAssets(carousel, { preset: 'BEST_AVAILABLE' });
    const reelManifest = await adapter.resolveAssets(reel, { preset: 'BEST_AVAILABLE' });
    expect(carouselManifest.assets.map((asset) => asset.assetIndex)).toEqual([0, 1, 2]);
    expect(reelManifest.assets.map((asset) => asset.mediaType)).toEqual(['video/mp4']);
  });

  it('lists a post only once even if the tool printed it twice, and skips entries without a usable shortcode', async () => {
    const profile = (await fixture('profile-posts')) as Array<[number, ...unknown[]]>;
    const photo = profile.filter((entry) => (entry.at(-1) as Record<string, unknown>).post_shortcode === 'DPhoto00001');
    const hostile = photo.map((entry) => [entry[0], ...entry.slice(1, -1), { ...(entry.at(-1) as object), post_shortcode: '--exec=touch /tmp/pwned' }]);
    const { adapter, tool } = await setup({ rawOutput: JSON.stringify([...profile, ...photo, ...hostile]) });
    const posts = await discover(adapter, PROFILE);
    expect(posts.map((post) => post.platformPostId).sort()).toEqual(['DCarous0001', 'DNewReel001', 'DOlder00001', 'DPhoto00001', 'DPinned0001']);
    for (const args of await tool.calls()) expect(args.join(' ')).not.toContain('pwned');
  });

  it('tolerates posts without optional fields and then keeps the order of the tool', async () => {
    const bare = [
      [2, { category: 'instagram', post_shortcode: 'DBare000001', type: 'post' }],
      [3, 'https://scontent.example.invalid/a.jpg', { post_shortcode: 'DBare000001', num: 1, extension: 'jpg' }],
      [2, { category: 'instagram', post_shortcode: 'DBare000002' }],
      [3, 'https://scontent.example.invalid/b.mp4', { post_shortcode: 'DBare000002', num: 1, extension: 'mp4', width: 'wide' }]
    ];
    const { adapter } = await setup({ listings: { [PROFILE_TOOL_URL]: bare, [`${INSTAGRAM_ROOT}/p/DBare000002/`]: bare.slice(2) } });
    const posts = await discover(adapter, PROFILE);
    expect(posts.map((post) => post.platformPostId)).toEqual(['DBare000001', 'DBare000002']);
    expect(posts[0]).toMatchObject({ creator: { platformId: 'unknown', displayName: null }, title: null, publishedAt: null });
    const manifest = await adapter.resolveAssets(posts[1]!, { preset: 'BEST_AVAILABLE' });
    expect(manifest.assets[0]).toMatchObject({ mediaType: 'video/mp4', quality: { width: null, height: null }, originalName: 'DBare000002_1.mp4' });
  });

  it('never lets metadata of the listing reach an argument list', async () => {
    const profile = (await fixture('profile-posts')) as Array<[number, ...unknown[]]>;
    const hostile = profile.map((entry) => {
      const metadata = { ...(entry.at(-1) as Record<string, unknown>), username: '--exec=touch /tmp/pwned', fullname: '-o evil\u0000', description: '--config=/etc/shadow\n--write-link', display_url: 'file:///etc/passwd', post_url: '--exec=id' };
      return [...entry.slice(0, -1), metadata];
    });
    const { adapter, tool, workRoot } = await setup({ listings: { [PROFILE_TOOL_URL]: hostile, ...Object.fromEntries(Object.entries(await allListings()).filter(([url]) => url.includes('/p/') || url.includes('/reel/'))) } });
    const posts = await discover(adapter, PROFILE);
    const manifest = await adapter.resolveAssets(posts[0]!, { preset: 'BEST_AVAILABLE' });
    expect(manifest.assets).toHaveLength(1);
    expect(posts[0]!.creator.displayName).toBe('-o evil');
    for (const args of await tool.calls()) {
      const joined = args.join(' ');
      for (const needle of ['pwned', '/etc/shadow', 'write-link', 'evil', 'passwd', 'exec=id']) expect(joined).not.toContain(needle);
    }
    expect(await readdir(workRoot)).toEqual([]);
  });
});
