import { readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { FeedMessageReader, type ParsedPost } from '../../packages/adapters/src/gallery-dl-output.js';
import { listingOfPost } from '../../packages/adapters/src/gallery-dl-listing.js';
import type { SourceType } from '../../packages/adapters/src/index.js';

/*
 * F2: a listing is reduced to the fields Kura reads as it arrives. That must change nothing about what is read: for every
 * listing made by the real extractors of gallery-dl 1.32.16 (the fixtures of Instagram, Patreon, Pixiv and Pornhub), the
 * post read from the reduced messages equals the post read from the complete messages.
 */

type Entry = [number, ...unknown[]];
const read = async (path: string): Promise<Entry[]> => JSON.parse(await readFile(new URL(path, import.meta.url), 'utf8')) as Entry[];

/** What the tool printed, as lines. */
const lines = (entries: readonly Entry[]): Buffer[] => entries.map((entry) => Buffer.from(JSON.stringify(entry)));

/** The posts of a listing as the old reader built them: complete metadata, nothing reduced. */
function completePosts(entries: readonly Entry[]): ParsedPost[] {
  const posts: { directory: Record<string, unknown> | undefined; files: Record<string, unknown>[]; filesTruncated: boolean; ytdlFiles: Set<number> }[] = [];
  for (const entry of entries) {
    if (entry[0] === 2) posts.push({ directory: entry[1] as Record<string, unknown>, files: [], filesTruncated: false, ytdlFiles: new Set() });
    if (entry[0] === 3) {
      const current = posts.at(-1)!;
      if ((entry[1] as string).startsWith('ytdl:')) current.ytdlFiles.add(current.files.length);
      current.files.push(entry[2] as Record<string, unknown>);
    }
  }
  return posts;
}

function reducedPosts(entries: readonly Entry[]): ParsedPost[] {
  const reader = new FeedMessageReader();
  const posts: ParsedPost[] = [];
  for (const line of lines(entries)) {
    const completed = reader.push(line);
    if (completed) posts.push(completed);
  }
  const last = reader.finish();
  if (last) posts.push(last);
  return posts;
}

const FIXTURES: readonly [SourceType, string][] = [
  ['instagram', '../instagram/fixtures/profile-posts.json'],
  ['instagram', '../instagram/fixtures/profile-reels.json'],
  ['patreon', '../platforms/fixtures/patreon-creator.json'],
  ['pixiv', '../platforms/fixtures/pixiv-user.json'],
  ['pixiv', '../platforms/fixtures/pixiv-user-manga.json'],
  ['pixiv', '../platforms/fixtures/pixiv-user-illustrations.json'],
  ['pornhub', '../platforms/fixtures/pornhub-album.json']
];

describe('reducing the messages of a listing', () => {
  it.each(FIXTURES)('changes nothing about the posts read from a %s listing (%s)', async (sourceType, path) => {
    const entries = await read(path);
    const complete = completePosts(entries);
    const reduced = reducedPosts(entries);

    expect(reduced).toHaveLength(complete.length);
    expect(complete.length).toBeGreaterThan(0);
    reduced.forEach((post, index) => {
      expect(listingOfPost(post, sourceType), `post ${index + 1}`).toEqual(listingOfPost(complete[index]!, sourceType));
    });
  });

  it('keeps little of a Patreon message: the post text and the image maps are dropped', async () => {
    const entries = await read('../platforms/fixtures/patreon-creator.json');
    const complete = entries.map((entry) => JSON.stringify(entry).length).reduce((sum, length) => sum + length, 0);
    const kept: number[] = [];
    for (const post of reducedPosts(entries)) {
      kept.push(JSON.stringify(post.directory ?? {}).length, ...post.files.map((file) => JSON.stringify(file).length));
    }
    const reduced = kept.reduce((sum, length) => sum + length, 0);
    expect(reduced).toBeLessThan(complete / 2);
  });

  it('keeps no field of a message that listingOfPost does not read', () => {
    const reader = new FeedMessageReader();
    reader.push(Buffer.from(JSON.stringify([2, { id: 1, title: 'a', content: '<p>big</p>'.repeat(1000), secret_token: 'abc', user: { id: '5', name: 'n', email: 'x@example.invalid' } }])));
    const post = reader.finish()!;
    expect(post.directory).toEqual({ id: 1, title: 'a', user: { id: '5', name: 'n' } });
  });

  it('skips the files of a post whose start was lost, until the next post begins', () => {
    const reader = new FeedMessageReader();
    reader.push(Buffer.from(JSON.stringify([2, { id: 1 }])));
    reader.push(Buffer.from(JSON.stringify([3, 'https://x.invalid/a.jpg', { id: 1, extension: 'jpg' }])));
    reader.dropped(); // the start of post 2 was too large
    expect(reader.push(Buffer.from(JSON.stringify([3, 'https://x.invalid/b.jpg', { id: 2, extension: 'jpg' }])))).toBeUndefined();
    const first = reader.push(Buffer.from(JSON.stringify([2, { id: 3 }])));
    expect(first?.files).toHaveLength(1);
    reader.push(Buffer.from(JSON.stringify([3, 'https://x.invalid/c.jpg', { id: 3, extension: 'jpg' }])));
    expect(reader.finish()?.files).toHaveLength(1);
    expect(reader.oversizeLines).toBe(1);
  });

  it('refuses a line that is not JSON instead of guessing', () => {
    expect(() => new FeedMessageReader().push(Buffer.from('this is not json'))).toThrowError(/not valid JSON/);
  });
});
