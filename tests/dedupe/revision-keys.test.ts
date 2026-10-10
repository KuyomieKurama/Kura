import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  galleryDlRevisionKey,
  GalleryDlAdapter,
  isContentStableAssetId,
  isLegacyRevisionKey,
  videoRevisionKey,
  YtDlpAdapter,
  type SourcePost
} from '../../packages/adapters/src/index.js';
import { endOfNewPosts, listingOfPost, type PostListing } from '../../packages/adapters/src/gallery-dl-listing.js';
import { tempDir } from '../adapters/helpers.js';
import { fakeInstagramGalleryDl, fixture as instagramFixture, INSTAGRAM_ROOT } from '../instagram/fake-instagram-tool.js';
import { fakeYtDlpTool, listingOf, videoMetadata } from '../platforms/fake-ytdlp.js';

/*
 * D3: the revision key of a post depends on the post and on its files, and on nothing else. The listings below are the
 * fixtures that the real gallery-dl 1.32.16 extractors printed (tests/instagram, tests/platforms), changed the way two
 * requests for the same post differ: another date, another file extension, another signed URL.
 */

type Entry = [number, ...unknown[]];
const jobContext = { jobId: 'job-d3', leaseGeneration: 1 };
const PATREON = 'https://www.patreon.com';
const PIXIV = 'https://www.pixiv.net';

const platformFixture = async (name: string): Promise<Entry[]> =>
  JSON.parse(await readFile(new URL(`../platforms/fixtures/${name}.json`, import.meta.url), 'utf8')) as Entry[];

/** Applies `change` to the metadata of every entry (the post entries and the file entries) of a deep copy. */
function mutated(entries: readonly unknown[], change: (metadata: Record<string, unknown>, entry: Entry) => void): unknown[] {
  const copy = JSON.parse(JSON.stringify(entries)) as Entry[];
  for (const entry of copy) {
    const metadata = (entry[0] === 2 ? entry[1] : entry[0] === 3 ? entry[2] : undefined) as Record<string, unknown> | undefined;
    if (metadata) change(metadata, entry);
  }
  return copy;
}

async function discoverFrom(listings: Record<string, unknown>, url: string): Promise<SourcePost[]> {
  const tool = await fakeInstagramGalleryDl({ listings });
  const adapter = await GalleryDlAdapter.create({ binary: tool.binary, workRoot: await tempDir('kura-d3-workroot-'), extraEnv: tool.env });
  const posts: SourcePost[] = [];
  for await (const post of adapter.discover({ ...jobContext, target: adapter.validateTarget(url) })) posts.push(post);
  return posts;
}

const keysOf = (posts: readonly SourcePost[]) => Object.fromEntries(posts.map((post) => [post.platformPostId, post.revisionKey]));

describe('revision keys of gallery-dl posts', () => {
  const PROFILE = `${INSTAGRAM_ROOT}/own_test_account/`;
  const PROFILE_TOOL_URL = `${INSTAGRAM_ROOT}/own_test_account/posts/`;

  it('Instagram: the same posts get the same keys when date, extension and signed URL differ between two listings', async () => {
    const original = await instagramFixture('profile-posts');
    const other = mutated(original, (metadata, entry) => {
      for (const field of ['date', 'post_date']) if (typeof metadata[field] === 'string') metadata[field] = '2030-12-31 23:59:59';
      if (typeof metadata.extension === 'string') metadata.extension = metadata.extension === 'jpg' ? 'webp' : 'jpg';
      if (entry[0] === 3 && typeof entry[1] === 'string') entry[1] = `${entry[1].split('?')[0]}?stp=dst-jpg&oh=other-signature&oe=FFFFFFFF`;
    });

    const first = await discoverFrom({ [PROFILE_TOOL_URL]: original }, PROFILE);
    const second = await discoverFrom({ [PROFILE_TOOL_URL]: other }, PROFILE);

    expect(first.length).toBeGreaterThanOrEqual(5);
    expect(second.map((post) => post.platformPostId).sort()).toEqual(first.map((post) => post.platformPostId).sort());
    expect(keysOf(second)).toEqual(keysOf(first));
    for (const post of first) expect(post.revisionKey).toMatch(/^g-[0-9a-f]{24}$/);
  });

  it('Instagram: a new file in a carousel is a new revision; the order of the files is not', async () => {
    const original = await instagramFixture('profile-posts');
    const carouselEntries = original.filter((entry) => Array.isArray(entry) && entry[0] === 3 && (entry[2] as { post_shortcode?: string }).post_shortcode === 'DCarous0001') as Entry[];
    expect(carouselEntries.length).toBeGreaterThan(1);

    const added = [...original] as Entry[];
    const lastOfCarousel = added.lastIndexOf(carouselEntries.at(-1)!);
    const extra = JSON.parse(JSON.stringify(carouselEntries.at(-1))) as Entry;
    (extra[2] as Record<string, unknown>).media_id = '99999999999999999';
    added.splice(lastOfCarousel + 1, 0, extra);
    const reordered = (original as Entry[]).slice();
    const [firstIndex, secondIndex] = carouselEntries.slice(0, 2).map((entry) => reordered.indexOf(entry)) as [number, number];
    [reordered[firstIndex], reordered[secondIndex]] = [reordered[secondIndex]!, reordered[firstIndex]!];

    const base = keysOf(await discoverFrom({ [PROFILE_TOOL_URL]: original }, PROFILE));
    const withNewFile = keysOf(await discoverFrom({ [PROFILE_TOOL_URL]: added }, PROFILE));
    const withOtherOrder = keysOf(await discoverFrom({ [PROFILE_TOOL_URL]: reordered }, PROFILE));

    expect(withNewFile.DCarous0001).not.toBe(base.DCarous0001);
    expect({ ...withNewFile, DCarous0001: base.DCarous0001 }).toEqual(base);
    expect(withOtherOrder).toEqual(base);
  });

  it('Patreon: files are identified by the hash of their URL path, the key does not depend on dates or extensions', async () => {
    const original = await platformFixture('patreon-creator');
    const other = mutated(original, (metadata, entry) => {
      for (const field of ['date', 'published_at']) if (typeof metadata[field] === 'string') metadata[field] = '2031-01-01T00:00:00.000+00:00';
      if (typeof metadata.extension === 'string') metadata.extension = 'png';
      if (entry[0] === 3 && typeof entry[1] === 'string') entry[1] = entry[1].replace(/\?.*$/, '') + '?token-time=1&token-hash=different';
    });
    const listings = (entries: unknown[]) => ({ [`${PATREON}/c/owntestcreator/posts`]: entries });

    const first = await discoverFrom(listings(original), `${PATREON}/owntestcreator`);
    const second = await discoverFrom(listings(other), `${PATREON}/owntestcreator`);

    expect(keysOf(second)).toEqual(keysOf(first));
    const withFiles = original.filter((entry) => entry[0] === 3 && /^[0-9a-f]{32}$/.test((entry[2] as { hash?: string }).hash ?? ''));
    expect(withFiles.length).toBeGreaterThan(3);
    const listing = listingOfPost({ directory: undefined, files: withFiles.map((entry) => entry[2] as Record<string, unknown>), filesTruncated: false, ytdlFiles: new Set() }, 'patreon');
    expect(listing.files.every((file) => file.sourceAssetId === `hash-${(withFiles[file.index]![2] as { hash: string }).hash}`)).toBe(true);
    expect(listing.files.every((file) => isContentStableAssetId('patreon', file.sourceAssetId))).toBe(true);
  });

  it('Pixiv: pages are identified by number and original URL without extension; a replaced page is a new revision', async () => {
    const original = await platformFixture('pixiv-user');
    const other = mutated(original, (metadata, entry) => {
      for (const field of ['date', 'date_url', 'create_date']) if (typeof metadata[field] === 'string') metadata[field] = '2031-01-01 00:00:00';
      if (typeof metadata.extension === 'string') metadata.extension = 'jpg';
      if (typeof metadata.url === 'string') metadata.url = metadata.url.replace(/\.png$/, '.jpg');
      if (entry[0] === 3 && typeof entry[1] === 'string') entry[1] = entry[1].replace(/\.png$/, '.jpg');
    });
    const replaced = mutated(original, (metadata, entry) => {
      if (metadata.id === 7003 && metadata.num === 1 && typeof metadata.url === 'string') {
        metadata.url = metadata.url.replace('/10/00/00/', '/11/30/45/');
        if (entry[0] === 3) entry[1] = metadata.url;
      }
    });
    const listings = (entries: unknown[]) => ({ [`${PIXIV}/users/4242/artworks`]: entries });

    const first = await discoverFrom(listings(original), `${PIXIV}/users/4242`);
    const second = await discoverFrom(listings(other), `${PIXIV}/users/4242`);
    const third = await discoverFrom(listings(replaced), `${PIXIV}/users/4242`);

    expect(keysOf(second)).toEqual(keysOf(first));
    expect(third.filter((post) => post.revisionKey !== first.find((candidate) => candidate.platformPostId === post.platformPostId)!.revisionKey).map((post) => post.platformPostId)).toEqual(['7003']);
  });

  it('is built from the post id and the sorted set of file ids only', () => {
    expect(galleryDlRevisionKey('P1', ['media-2', 'media-1'])).toBe(galleryDlRevisionKey('P1', ['media-1', 'media-2', 'media-1']));
    expect(galleryDlRevisionKey('P1', ['media-1'])).not.toBe(galleryDlRevisionKey('P1', ['media-1', 'media-2']));
    expect(galleryDlRevisionKey('P1', ['media-1'])).not.toBe(galleryDlRevisionKey('P2', ['media-1']));
    expect(videoRevisionKey('dQw4w9WgXcQ')).toMatch(/^v-[0-9a-f]{24}$/);
  });

  it('recognises the key formats of before D3 and no new one', () => {
    for (const key of ['l-ac3b94b7c3feb9761b014f37', 'l-f5b8b49c55426950c701d7a4', 'd-0123456789abcdef01234567', 'f-0123456789abcdef01234567']) {
      expect(isLegacyRevisionKey(key)).toBe(true);
    }
    for (const key of [galleryDlRevisionKey('P', ['media-1']), videoRevisionKey('x'), 'h-0123456789abcdef01234567', '1']) {
      expect(isLegacyRevisionKey(key)).toBe(false);
    }
  });

  it('lets an id stand for its content only where the id says which content it is', () => {
    expect(isContentStableAssetId('instagram', 'media-3969939798690444191')).toBe(true);
    expect(isContentStableAssetId('patreon', 'hash-0000000000000000000000000000000b')).toBe(true);
    expect(isContentStableAssetId('pixiv', 'page-1-0123456789ab')).toBe(true);
    expect(isContentStableAssetId('youtube', 'video')).toBe(true);
    expect(isContentStableAssetId('pornhub', 'photo-123')).toBe(true);
    for (const [type, id] of [['instagram', 'file-0'], ['pixiv', 'ugoira'], ['pixiv', 'ugoira-timing'], ['patreon', 'embed-0'], ['patreon', 'locked'], ['direct_media', 'media-1'], ['direct_media', 'video']] as const) {
      expect(isContentStableAssetId(type, id), `${type} ${id}`).toBe(false);
    }
  });
});

describe('revision keys of yt-dlp videos', () => {
  const CHANNEL_URL = 'https://www.youtube.com/@owntestchannel/videos';
  const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;

  it('depend on the video id only: the same video has the same key alone and in a list, whatever its date or duration says', async () => {
    const tool = await fakeYtDlpTool({
      lists: { [CHANNEL_URL]: await listingOf('ytdlp-youtube-channel-flat.json') },
      videos: { [watch('aaaaaaaaaa1')]: await videoMetadata('ytdlp-youtube-video-h264.json', 'aaaaaaaaaa1') }
    });
    const adapter = await YtDlpAdapter.create({ binary: tool.binary, workRoot: await tempDir('kura-d3-ytdlp-'), extraEnv: tool.env });
    const discover = async (url: string): Promise<SourcePost[]> => {
      const posts: SourcePost[] = [];
      for await (const post of adapter.discover({ ...jobContext, target: adapter.validateTarget(url) })) posts.push(post);
      return posts;
    };

    const inList = (await discover(CHANNEL_URL)).find((post) => post.platformPostId === 'aaaaaaaaaa1')!;
    const [alone] = await discover(watch('aaaaaaaaaa1'));
    await tool.control({ videos: { [watch('aaaaaaaaaa1')]: await videoMetadata('ytdlp-youtube-video-h264.json', 'aaaaaaaaaa1', { upload_date: '20300101', duration: 1234.5 }) } });
    const [changed] = await discover(watch('aaaaaaaaaa1'));

    expect(alone!.revisionKey).toBe(inList.revisionKey);
    expect(changed!.revisionKey).toBe(inList.revisionKey);
    expect(inList.revisionKey).toBe(videoRevisionKey('aaaaaaaaaa1'));
  });
});

describe('endOfNewPosts (the stop rule of an incremental feed listing)', () => {
  const listing = (id: string, date: string | null): PostListing => ({ ...listingOfPost({ directory: undefined, files: [], filesTruncated: false, ytdlFiles: new Set() }, 'instagram'), postId: id, date });
  const day = (offset: number) => new Date(Date.UTC(2026, 2, 30 - offset)).toISOString();
  const feed = (...ids: string[]) => ids.map((id, index) => listing(id, day(index)));

  it('ends after three known posts in a row, and says how many posts are needed', () => {
    expect(endOfNewPosts(feed('n1', 'n2', 'k1', 'k2', 'k3', 'k4'), new Set(['k1', 'k2', 'k3', 'k4']))).toBe(5);
  });

  it('does not end while fewer than three known posts follow each other, or before the first known post', () => {
    expect(endOfNewPosts(feed('n1', 'k1', 'k2', 'n2', 'n3'), new Set(['k1', 'k2']))).toBeNull();
    expect(endOfNewPosts(feed('n1', 'n2', 'n3'), new Set(['k1']))).toBeNull();
    expect(endOfNewPosts(feed('k1', 'k2'), new Set(['k1', 'k2']))).toBeNull();
  });

  it('does not take pinned posts for the end: old known posts first, newer posts behind them', () => {
    const pinned = ['k1', 'k2', 'k3'].map((id, index) => listing(id, `2025-01-0${index + 1}T00:00:00.000Z`));
    const rest = [listing('n1', day(0)), listing('n2', day(1)), listing('k4', day(2))];
    expect(endOfNewPosts([...pinned, ...rest], new Set(['k1', 'k2', 'k3', 'k4']))).toBeNull();
  });

  it('never ends on a listing in which a post has no date', () => {
    const posts = [listing('n1', day(0)), listing('k1', day(1)), listing('k2', day(2)), listing('k3', null)];
    expect(endOfNewPosts(posts, new Set(['k1', 'k2', 'k3']))).toBeNull();
  });
});
