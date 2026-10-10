import { afterEach, describe, expect, it, vi } from 'vitest';
import { createPipelineFixture, type PipelineFixture } from '../m5b/fixture.js';
import type { ControllableTool } from '../m5b/tools.js';
import {
  fakeFeedTool, feedListings, galleryDlDate, plainPosts, postUrl, PROFILE, PROFILE_TOOL_URL,
  type FeedPost, type FeedTool
} from './feed-tool.js';

/*
 * D3: a profile that is read again is not archived again. Whole runs through the real worker (executor, history, blob
 * store on real PostgreSQL) with a fake gallery-dl whose listings can change between two runs.
 */

describe('repeat runs over an Instagram profile (fake gallery-dl, real PostgreSQL, no network)', () => {
  const open: PipelineFixture[] = [];
  afterEach(async () => {
    vi.restoreAllMocks();
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  async function setup(posts: readonly FeedPost[]) {
    const tool = await fakeFeedTool({ listings: feedListings(posts) });
    const subject = await createPipelineFixture({ tools: { galleryDl: tool as unknown as ControllableTool } });
    open.push(subject);
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PROFILE);
    const run = async () => {
      subject.advance(3600);
      return (await subject.runOnce(userId, subscription.id)).outcome;
    };
    return { tool, subject, userId, subscription, run };
  }

  const counts = async (subject: PipelineFixture) => (await subject.rows<{ posts: number; assets: number; stored: number; blobs: number }>(
    `SELECT (SELECT count(*) FROM download_posts)::int AS posts, (SELECT count(*) FROM download_assets)::int AS assets,
            (SELECT count(*) FROM download_assets WHERE state = 'stored')::int AS stored, (SELECT count(*) FROM blobstore_objects)::int AS blobs`
  ))[0]!;
  const revisionKeys = async (subject: PipelineFixture) =>
    (await subject.rows<{ k: string }>('SELECT platform_post_id || \' \' || revision_key AS k FROM download_posts ORDER BY 1')).map((row) => row.k);

  /** The `--post-range` of each profile listing since `from`, in order (the first is the probe of the target). */
  const profileRanges = async (tool: FeedTool, from = 0) => (await tool.calls()).slice(from)
    .filter((args) => args.includes('--dump-json') && args.at(-1) === PROFILE_TOOL_URL)
    .map((args) => args[args.indexOf('--post-range') + 1]);
  const downloads = async (tool: FeedTool, from = 0) => (await tool.calls()).slice(from).filter((args) => args.includes('--range'));
  const singlePostListings = async (tool: FeedTool, from = 0) => (await tool.calls()).slice(from)
    .filter((args) => args.includes('--dump-json') && args.at(-1) !== PROFILE_TOOL_URL).map((args) => args.at(-1));

  it('stores nothing on the second run over an unchanged profile and stops after the first window of the feed', async () => {
    const { tool, subject, run } = await setup(plainPosts(30));

    expect(await run()).toEqual({ result: 'stored' });
    expect(await counts(subject)).toEqual({ posts: 30, assets: 30, stored: 30, blobs: 30 });
    expect(await profileRanges(tool)).toEqual(['1-1', '1-50']);
    const keys = await revisionKeys(subject);
    const before = (await tool.calls()).length;

    expect(await run()).toEqual({ result: 'stored' });

    expect(await counts(subject)).toEqual({ posts: 30, assets: 30, stored: 30, blobs: 30 });
    expect(await revisionKeys(subject)).toEqual(keys);
    // The probe and one window of 12 posts: no download, no listing of a single post.
    expect(await profileRanges(tool, before)).toEqual(['1-1', '1-12']);
    expect(await downloads(tool, before)).toEqual([]);
    expect(await singlePostListings(tool, before)).toEqual([]);
    expect((await tool.calls()).length - before).toBe(2);
    expect(await subject.rows('SELECT state, posts_found, posts_skipped, assets_stored, assets_failed FROM download_runs ORDER BY started_at')).toEqual([
      { state: 'stored', posts_found: 30, posts_skipped: 0, assets_stored: 30, assets_failed: 0 },
      { state: 'stored', posts_found: 12, posts_skipped: 12, assets_stored: 0, assets_failed: 0 }
    ]);
  });

  it('does not create a new revision when only the date or the file extension in the listing differs', async () => {
    const { tool, subject, run } = await setup(plainPosts(30));
    await run();
    const keys = await revisionKeys(subject);
    const before = (await tool.calls()).length;

    // Instagram served another format and another timestamp for the same, unchanged posts.
    await tool.control({ listings: feedListings(plainPosts(30, { hour: 11, extension: 'webp' })) });
    expect(await run()).toEqual({ result: 'stored' });

    expect(await revisionKeys(subject)).toEqual(keys);
    expect(await counts(subject)).toEqual({ posts: 30, assets: 30, stored: 30, blobs: 30 });
    expect(await downloads(tool, before)).toEqual([]);
    expect(await singlePostListings(tool, before)).toEqual([]);
  });

  it('creates a new revision for a real new file in a post and downloads only that file', async () => {
    const posts = plainPosts(30);
    const { tool, subject, run } = await setup(posts);
    await run();
    const before = (await tool.calls()).length;
    const writes = vi.spyOn(subject.blobstore, 'beginWrite');

    const edited = posts.map((post, index) => (index === 5 ? { ...post, files: [...post.files, { mediaId: '9001' }] } : post));
    await tool.control({ listings: feedListings(edited) });
    expect(await run()).toEqual({ result: 'stored' });

    expect(await counts(subject)).toEqual({ posts: 31, assets: 32, stored: 32, blobs: 31 });
    const revisions = await subject.rows<{ state: string; assets: number }>(
      `SELECT p.state, (SELECT count(*) FROM download_assets a WHERE a.post_id = p.id)::int AS assets
         FROM download_posts p WHERE p.platform_post_id = $1 ORDER BY p.discovered_at`, [posts[5]!.code]
    );
    expect(revisions).toEqual([{ state: 'stored', assets: 1 }, { state: 'stored', assets: 2 }]);
    // One file was fetched and imported: the one that is new. The file the revision already had is the stored one.
    const fetched = await downloads(tool, before);
    expect(fetched).toHaveLength(1);
    expect(fetched[0]!.slice(fetched[0]!.indexOf('--range'))).toEqual(['--range', '2', '--filesize-max', expect.any(String), '--', postUrl(posts[5]!.code)]);
    expect(writes).toHaveBeenCalledTimes(1);
    const shared = await subject.rows<{ reference_count: number; rows: number }>(
      `SELECT b.reference_count, count(*)::int AS rows FROM download_assets a JOIN blobstore_objects b ON b.id::text = a.blob_object_id
        WHERE a.source_asset_id = 'media-1005' GROUP BY b.reference_count`
    );
    expect(shared).toEqual([{ reference_count: 2, rows: 2 }]);
  });

  it('records the same file in two posts once in the blob store (asset-level dedupe by checksum)', async () => {
    const same: FeedPost[] = [
      { code: 'DSameA00001', date: '2026-03-02 10:00:00', files: [{ mediaId: '7001' }] },
      { code: 'DSameB00001', date: '2026-03-01 10:00:00', files: [{ mediaId: '7001' }] }
    ];
    const { tool, subject, run } = await setup(same);
    const writes = vi.spyOn(subject.blobstore, 'beginWrite');

    expect(await run()).toEqual({ result: 'stored' });

    expect(await downloads(tool)).toHaveLength(2);
    // The second file is recognised by its checksum after the download and is not written to the blob store again.
    expect(writes).toHaveBeenCalledTimes(1);
    const rows = await subject.rows<{ blob_object_id: string; sha256: string }>('SELECT blob_object_id, sha256 FROM download_assets WHERE state = \'stored\'');
    expect(rows).toHaveLength(2);
    expect(rows[0]!.blob_object_id).toBe(rows[1]!.blob_object_id);
    expect(rows[0]!.sha256).toBe(rows[1]!.sha256);
    expect(await subject.rows('SELECT reference_count FROM blobstore_objects')).toEqual([{ reference_count: 2 }]);
  });

  describe('a history from before the fix (old-format revision keys, every post twice)', () => {
    /** Rewrites the keys to the old format and adds a second row of each of the first ten posts, as the VM database has. */
    async function ageHistory(subject: PipelineFixture): Promise<void> {
      await subject.rows("UPDATE download_posts SET revision_key = 'l-' || substr(md5(id::text), 1, 24)");
      const first = await subject.rows<{ id: string }>('SELECT id FROM download_posts ORDER BY platform_post_id LIMIT 10');
      for (const { id } of first) {
        const [copy] = await subject.rows<{ id: string }>(
          `INSERT INTO download_posts (id, user_id, run_id, subscription_id, platform, adapter_id, adapter_version, creator_platform_id,
                                       creator_name, platform_post_id, revision_key, title, source_url, published_at, state, discovery_complete, discovered_at, completed_at)
           SELECT gen_random_uuid(), user_id, run_id, subscription_id, platform, adapter_id, adapter_version, creator_platform_id,
                  creator_name, platform_post_id, 'l-' || substr(md5(random()::text), 1, 24), title, source_url, published_at, state, discovery_complete, now(), completed_at
             FROM download_posts WHERE id = $1 RETURNING id`, [id]
        );
        await subject.rows(
          `INSERT INTO download_assets (id, post_id, user_id, asset_index, source_asset_id, original_name, media_type, role, variant, state, attempts,
                                        byte_size, sha256, sha1, blob_object_id, stored_at, handover_state)
           SELECT gen_random_uuid(), $2, user_id, asset_index, source_asset_id, original_name, media_type, role, variant, state, attempts,
                  byte_size, sha256, sha1, blob_object_id, now(), handover_state FROM download_assets WHERE post_id = $1`, [id, copy!.id]
        );
      }
    }

    it('treats archived posts with an old key as unchanged: no new rows, no download, no request for a single post', async () => {
      const { tool, subject, run } = await setup(plainPosts(30));
      await run();
      await ageHistory(subject);
      expect(await counts(subject)).toEqual({ posts: 40, assets: 40, stored: 40, blobs: 30 });
      const before = (await tool.calls()).length;

      expect(await run()).toEqual({ result: 'stored' });

      expect(await counts(subject)).toEqual({ posts: 40, assets: 40, stored: 40, blobs: 30 });
      expect(await downloads(tool, before)).toEqual([]);
      expect(await singlePostListings(tool, before)).toEqual([]);
      expect(await profileRanges(tool, before)).toEqual(['1-1', '1-12']);
    });

    it('still stores a post that is new after the old history', async () => {
      const posts = plainPosts(30);
      const { tool, subject, run } = await setup(posts);
      await run();
      await ageHistory(subject);
      const newest: FeedPost = { code: 'DBrandNew01', date: galleryDlDate(Date.UTC(2026, 2, 31)), files: [{ mediaId: '8001' }] };
      await tool.control({ listings: feedListings([newest, ...posts]) });

      expect(await run()).toEqual({ result: 'stored' });

      expect(await counts(subject)).toEqual({ posts: 41, assets: 41, stored: 41, blobs: 31 });
      expect((await downloads(tool)).slice(-1)[0]!.at(-1)).toBe(postUrl('DBrandNew01'));
    });
  });

  describe('the stop rule', () => {
    it('reads the whole range again after a run that ended with a problem', async () => {
      const { tool, subject, run } = await setup(plainPosts(30));
      await run();
      await tool.control({ listings: feedListings(plainPosts(30)), listingFailure: { stderr: "[gallery-dl][error] HTTP Error: '503 Service Unavailable' for 'https://www.instagram.com/api'", exitCode: 4 } });
      const failed = await run();
      expect(failed).toMatchObject({ result: 'problem' });
      await tool.control({ listings: feedListings(plainPosts(30)) });
      const before = (await tool.calls()).length;

      expect(await run()).toEqual({ result: 'stored' });

      expect(await profileRanges(tool, before)).toEqual(['1-1', '1-50']);
      expect(await counts(subject)).toEqual({ posts: 30, assets: 30, stored: 30, blobs: 30 });
    });

    it('is not fooled by pinned posts, which are printed first although they are old', async () => {
      const pinned = plainPosts(3, { prefix: 'DPinned', firstMediaId: 500 }).map((post, index) => ({ ...post, date: `2025-01-0${index + 1} 10:00:00` }));
      const regular = plainPosts(30);
      const { tool, subject, run } = await setup([...pinned, ...regular]);
      await run();
      expect((await counts(subject)).posts).toBe(33);
      const before = (await tool.calls()).length;

      // Twenty new posts appear. The pinned (known) posts are still printed first.
      const fresh = plainPosts(20, { prefix: 'DFresh', firstMediaId: 3000, hour: 12 }).map((post, index) => ({ ...post, date: galleryDlDate(Date.UTC(2026, 3, 30) - index * 86_400_000) }));
      await tool.control({ listings: feedListings([...pinned, ...fresh, ...regular]) });
      expect(await run()).toEqual({ result: 'stored' });

      expect((await counts(subject)).posts).toBe(53);
      expect((await downloads(tool, before))).toHaveLength(20);
      // The first windows hold the pinned posts and new ones only; the walk goes on until it meets old posts.
      expect(await profileRanges(tool, before)).toEqual(['1-1', '1-12', '1-24', '1-48']);
    });

    it('does not look at an edit of a post behind the archived ones (documented limit of incremental runs)', async () => {
      const posts = plainPosts(30);
      const { tool, subject, run } = await setup(posts);
      await run();
      const edited = posts.map((post, index) => (index === 20 ? { ...post, files: [...post.files, { mediaId: '9002' }] } : post));
      await tool.control({ listings: feedListings(edited) });

      await run();

      expect(await counts(subject)).toEqual({ posts: 30, assets: 30, stored: 30, blobs: 30 });
    });

    it('retries a post that is not completely archived even though it lies behind the stop point', async () => {
      const posts = plainPosts(30);
      const { tool, subject, run } = await setup(posts);
      await run();
      // Post 20 once ended with an asset that could not be reached (private for the account then, reachable now).
      await subject.rows(
        `UPDATE download_assets SET state = 'failed', error_code = 'ASSET_NOT_ACCESSIBLE', error_message = 'nicht zugänglich', sha256 = NULL, byte_size = NULL,
                blob_object_id = NULL, stored_at = NULL, sha1 = NULL
          WHERE post_id = (SELECT id FROM download_posts WHERE platform_post_id = $1)`, [posts[20]!.code]
      );
      await subject.rows('UPDATE download_posts SET state = \'partially_completed\' WHERE platform_post_id = $1', [posts[20]!.code]);
      const before = (await tool.calls()).length;

      expect(await run()).toEqual({ result: 'stored' });

      expect(await profileRanges(tool, before)).toEqual(['1-1', '1-12']);
      expect(await downloads(tool, before)).toHaveLength(1);
      expect(await subject.rows('SELECT state FROM download_posts WHERE platform_post_id = $1', [posts[20]!.code])).toEqual([{ state: 'stored' }]);
      expect((await counts(subject)).posts).toBe(30);

      // Completed now: the next run does not ask for it any more.
      const after = (await tool.calls()).length;
      await run();
      expect(await singlePostListings(tool, after)).toEqual([]);
      expect(await downloads(tool, after)).toEqual([]);
    });
  });
});
