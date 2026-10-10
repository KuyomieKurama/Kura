import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createMediaFixture, patternBytes, tinyPng, type MediaFixture } from '../media/fixture.js';
import type { TestLogin } from '../m4b/api-fixture.js';
import { newRevisionKey, seedRevision } from './seed-duplicates.js';

/*
 * D3: the media list shows each stored file once per subscription. The history of the test VM holds every post of a
 * profile twice (two revision keys for one unchanged post, the same checksums); nothing of that is deleted, the list
 * shows what was downloaded, once.
 */

interface ListedItem { id: string; platformPostId: string; postTitle: string | null; originalName: string; mediaKind: string; copies: number; byteSize: number }
interface Listing { items: ListedItem[]; nextCursor: string | null; counts?: { all: number; image: number; video: number } }

describe('media list with duplicate rows in the history', () => {
  let fixture: MediaFixture;
  let alice: TestLogin;
  let subscription: string;
  let otherSubscription: string;
  const VIDEO = patternBytes(70 * 1024);
  const photoA = tinyPng('photo-a');
  const photoB = tinyPng('photo-b');
  const photoC = tinyPng('photo-c');

  const list = async (query = '', login = alice, id = subscription): Promise<Listing> => {
    const response = await fixture.get(login, `/api/v1/subscriptions/${id}/media${query}`);
    expect(response.statusCode).toBe(200);
    return response.json() as Listing;
  };

  beforeAll(async () => {
    fixture = await createMediaFixture();
    alice = await fixture.api.addUser('alice');
    subscription = await fixture.createSubscription(alice, 'Profil');
    otherSubscription = await fixture.createSubscription(alice, 'Anderes Profil');
    const run = await fixture.startRun(alice, subscription, { finished: true });
    const otherRun = await fixture.startRun(alice, otherSubscription, { finished: true });
    const files = (suffix: string) => [
      { sourceAssetId: 'media-1', name: `A_${suffix}.png`, mime: 'image/png', bytes: photoA },
      { sourceAssetId: 'media-2', name: `B_${suffix}.png`, mime: 'image/png', bytes: photoB }
    ];

    // Post P exists twice (two keys, two runs 30 minutes apart), with the same two files each time.
    await seedRevision(fixture, alice, subscription, run, { platformPostId: 'P', revisionKey: newRevisionKey(), title: 'alte Zeile', discoveredAt: '2026-06-01T21:25:00Z', files: files('alt') });
    await seedRevision(fixture, alice, subscription, run, { platformPostId: 'P', revisionKey: newRevisionKey(), title: 'neue Zeile', discoveredAt: '2026-06-01T21:58:00Z', files: files('neu') });
    // Post Q (a reel) exists twice as well; post R has one file that is only stored once.
    const reel = [{ sourceAssetId: 'media-3', name: 'Q.mp4', mime: 'video/mp4', bytes: VIDEO }];
    await seedRevision(fixture, alice, subscription, run, { platformPostId: 'Q', revisionKey: newRevisionKey(), title: 'Reel alt', discoveredAt: '2026-06-01T21:26:00Z', files: reel });
    await seedRevision(fixture, alice, subscription, run, { platformPostId: 'Q', revisionKey: newRevisionKey(), title: 'Reel neu', discoveredAt: '2026-06-01T21:59:00Z', files: reel });
    await seedRevision(fixture, alice, subscription, run, { platformPostId: 'R', revisionKey: newRevisionKey(), title: 'Einzeln', discoveredAt: '2026-06-01T22:00:00Z', files: [{ sourceAssetId: 'media-4', name: 'R.png', mime: 'image/png', bytes: photoC }] });
    // The same photo in another subscription is not a duplicate of the first.
    await seedRevision(fixture, alice, otherSubscription, otherRun, { platformPostId: 'P', revisionKey: newRevisionKey(), title: 'anderes Abo', discoveredAt: '2026-06-02T08:00:00Z', files: files('x').slice(0, 1) });
  });

  afterAll(async () => { await fixture.cleanup(); });

  it('lists each file once, with the data of the newest post row, and counts files, not rows', async () => {
    const rows = await fixture.api.pool.query("SELECT count(*)::int AS n FROM download_assets WHERE state = 'stored'");
    expect(rows.rows[0].n).toBe(8);

    const listing = await list();

    expect(listing.items.map((item) => [item.platformPostId, item.postTitle, item.copies])).toEqual([
      ['R', 'Einzeln', 1], ['Q', 'Reel neu', 2], ['P', 'neue Zeile', 2], ['P', 'neue Zeile', 2]
    ]);
    expect(listing.counts).toEqual({ all: 4, image: 3, video: 1 });
    expect(listing.items.map((item) => item.mediaKind).sort()).toEqual(['image', 'image', 'image', 'video']);
    // The file name of the newest row, because the newest row wins for the metadata.
    expect(listing.items.filter((item) => item.platformPostId === 'P').map((item) => item.originalName).sort()).toEqual(['A_neu.png', 'B_neu.png']);
  });

  it('pages through the distinct files without repeating or skipping one', async () => {
    const seen: string[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < 5; page += 1) {
      const result: Listing = await list(`?limit=1${cursor ? `&cursor=${cursor}` : ''}`);
      expect(result.items.length).toBeLessThanOrEqual(1);
      seen.push(...result.items.map((item) => item.id));
      cursor = result.nextCursor;
      if (!cursor) break;
    }
    expect(seen).toHaveLength(4);
    expect(new Set(seen).size).toBe(4);
    expect(cursor).toBeNull();
  });

  it('filters by type on the distinct files and keeps the totals of the whole subscription', async () => {
    const images = await list('?type=image');
    const videos = await list('?type=video');
    expect(images.items).toHaveLength(3);
    expect(videos.items.map((item) => item.platformPostId)).toEqual(['Q']);
    expect(images.counts).toEqual({ all: 4, image: 3, video: 1 });
  });

  it('keeps another subscription apart: its copy of the same bytes is its own entry', async () => {
    const other = await list('', alice, otherSubscription);
    expect(other.items.map((item) => [item.platformPostId, item.copies])).toEqual([['P', 1]]);
    expect(other.counts).toEqual({ all: 1, image: 1, video: 0 });
  });

  it('deletes nothing: every duplicate row and the one stored object per file are still there', async () => {
    const assets = await fixture.api.pool.query("SELECT count(*)::int AS n FROM download_assets WHERE state = 'stored'");
    const posts = await fixture.api.pool.query('SELECT count(*)::int AS n FROM download_posts');
    const blobs = await fixture.api.pool.query('SELECT count(*)::int AS n, sum(reference_count)::int AS references FROM blobstore_objects');
    expect(assets.rows[0].n).toBe(8);
    expect(posts.rows[0].n).toBe(6);
    // Four different files in the blob store (A, B, the video, C); the rows refer to them 8 times in all.
    expect(blobs.rows[0]).toEqual({ n: 4, references: 8 });
  });
});
