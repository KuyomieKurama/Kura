import { afterEach, describe, expect, it } from 'vitest';
import { createPipelineFixture, type PipelineFixture } from '../m5b/fixture.js';
import type { ControllableTool } from '../m5b/tools.js';
import {
  fakePatreonGalleryDl, feedCalls, PATREON_CREATOR_URL, postId, postUrl, type PatreonControl, type PatreonTool
} from './fake-patreon-tool.js';

/*
 * F2 through the real worker (executor, history, blob store on real PostgreSQL) with a fake gallery-dl that prints a
 * Patreon creator feed: posts are recorded while the feed is read, a failure in the middle keeps what was found, a post
 * the account may not view is recorded as such and is no failure, and timeouts and the size limit give clear messages.
 */

describe('a Patreon creator through the worker (fake gallery-dl, real PostgreSQL, no network)', () => {
  const open: PipelineFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  async function setup(control: PatreonControl, options: { feedListingIdleTimeoutMs?: number } = {}) {
    const tool: PatreonTool = await fakePatreonGalleryDl(control);
    const subject = await createPipelineFixture({ tools: { galleryDl: tool as unknown as ControllableTool }, ...options });
    open.push(subject);
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PATREON_CREATOR_URL);
    const run = async () => {
      subject.advance(3600);
      return (await subject.runOnce(userId, subscription.id)).outcome;
    };
    return { tool, subject, userId, subscription, run };
  }

  const runs = (subject: PipelineFixture) => subject.rows<Record<string, unknown>>(
    `SELECT state, error_code, error_message, posts_found, posts_skipped, assets_stored, assets_failed
       FROM download_runs ORDER BY started_at, id`
  );
  const postRows = (subject: PipelineFixture) => subject.rows<{ platform_post_id: string; state: string; revision_key: string }>(
    'SELECT platform_post_id, state, revision_key FROM download_posts ORDER BY platform_post_id, discovered_at, id'
  );
  const assetRows = (subject: PipelineFixture) => subject.rows<{ post: string; asset: string; state: string; error_code: string | null }>(
    `SELECT p.platform_post_id AS post, a.source_asset_id AS asset, a.state, a.error_code
       FROM download_assets a JOIN download_posts p ON p.id = a.post_id ORDER BY p.platform_post_id, a.asset_index, p.discovered_at`
  );
  const singlePostCalls = async (tool: PatreonTool, from = 0) => (await tool.calls()).slice(from)
    .filter((args) => args.includes('--dump-json') && args.at(-1)!.includes('/posts/'));

  it('records the posts while the feed is still being read, and the counters move', async () => {
    const { subject, run } = await setup({ posts: 14, filesPerPost: 1, contentBytes: 3000, postDelayMs: 150 });

    const samples: { state: string; found: number; posts: number }[] = [];
    let finished = false;
    const finishing = run().finally(() => { finished = true; });
    while (!finished) {
      const [row] = await subject.rows<{ state: string; posts_found: number; posts: number }>(
        `SELECT state, posts_found, (SELECT count(*) FROM download_posts)::int AS posts FROM download_runs ORDER BY started_at DESC LIMIT 1`
      );
      if (row) samples.push({ state: row.state, found: row.posts_found, posts: row.posts });
      await new Promise((resolve) => setTimeout(resolve, 40));
    }
    expect(await finishing).toEqual({ result: 'stored' });

    // While the tool was still printing (state "discovering"), posts_found and the posts in the history grew step by step.
    const discovering = samples.filter((sample) => sample.state === 'discovering');
    const foundWhileReading = [...new Set(discovering.map((sample) => sample.found))];
    expect(foundWhileReading.length, JSON.stringify(foundWhileReading)).toBeGreaterThanOrEqual(5);
    expect(foundWhileReading.every((found, index) => index === 0 || found > foundWhileReading[index - 1]!)).toBe(true);
    // Seen in the middle of the feed, not only at its end.
    expect(foundWhileReading.filter((found) => found > 0 && found < 14).length).toBeGreaterThanOrEqual(4);
    expect(discovering.some((sample) => sample.found > 0 && sample.posts === sample.found)).toBe(true);
    expect(await runs(subject)).toEqual([expect.objectContaining({ state: 'stored', posts_found: 14, assets_stored: 14 })]);
  }, 60_000);

  describe('a listing that ends in the middle', () => {
    it('keeps the posts found before the end, says what happened, and the next run completes without duplicates', async () => {
      const control: PatreonControl = { posts: 12, filesPerPost: 1, contentBytes: 2000 };
      const { tool, subject, run } = await setup({ ...control, streamEndsAfter: { posts: 8, how: 'silent' } });

      const outcome = await run();

      expect(outcome).toMatchObject({
        result: 'problem', partial: true,
        disposition: { runState: 'retry_wait', code: 'NETWORK_FAILED', retryable: true, message: expect.stringMatching(/Patreon.*unvollständig.*erneut/s) }
      });
      expect(await postRows(subject)).toHaveLength(8);
      expect((await assetRows(subject)).every((asset) => asset.state === 'stored')).toBe(true);
      expect(await runs(subject)).toEqual([expect.objectContaining({
        state: 'partially_completed', error_code: 'NETWORK_FAILED', posts_found: 8, assets_stored: 8
      })]);
      // The end of the feed was not reached, so the sync state must not say it was.
      expect(await subject.rows('SELECT 1 FROM subscription_sync_state WHERE checked_through IS NOT NULL')).toEqual([]);

      await tool.control(control);
      expect(await run()).toEqual({ result: 'stored' });

      expect(await postRows(subject)).toHaveLength(12);
      expect(new Set((await postRows(subject)).map((row) => row.platform_post_id)).size).toBe(12);
      expect((await runs(subject))[1]).toMatchObject({ state: 'stored', posts_found: 12, posts_skipped: 8, assets_stored: 4 });
    });

    it('is retried with the waiting time of the queue, not given up', async () => {
      const { subject, run } = await setup({ posts: 12, filesPerPost: 1, contentBytes: 2000, streamEndsAfter: { posts: 8, how: 'silent' } });
      await run();
      const [job] = await subject.rows<{ state: string }>('SELECT state FROM job_runs');
      expect(job).toEqual({ state: 'retry_wait' });
    });

    it('turns a tool that goes quiet into a timeout message naming Patreon, and keeps the earlier posts', async () => {
      const { subject, run } = await setup({ posts: 12, filesPerPost: 1, contentBytes: 2000, streamEndsAfter: { posts: 6, how: 'hang' } }, { feedListingIdleTimeoutMs: 1_500 });

      const outcome = await run();

      expect(outcome).toMatchObject({
        result: 'problem',
        disposition: { runState: 'retry_wait', code: 'PROCESS_TIMEOUT', retryable: true, message: expect.stringMatching(/^Patreon hat nicht rechtzeitig geantwortet/) }
      });
      // The sixth post was still being printed.
      expect((await postRows(subject)).map((row) => row.platform_post_id)).toEqual(Array.from({ length: 5 }, (_unused, index) => postId(index)));
      expect(await runs(subject)).toEqual([expect.objectContaining({ error_code: 'PROCESS_TIMEOUT', posts_found: 5 })]);
    }, 60_000);

    it('tells that a post is too large to be read (retried, the other posts are stored)', async () => {
      const { subject, run } = await setup({ posts: 6, filesPerPost: 1, contentBytes: 2000, hugePost: { index: 2, bytes: 9 * 1024 * 1024 } });

      const outcome = await run();

      expect(outcome).toMatchObject({
        result: 'problem',
        disposition: { runState: 'retry_wait', code: 'PROCESS_OUTPUT_LIMIT', retryable: true, message: expect.stringMatching(/Patreon.*zu groß/) }
      });
      expect((await postRows(subject)).map((row) => row.platform_post_id)).toEqual(['9000', '9001', '9003', '9004', '9005']);
    }, 60_000);
  });

  describe('posts the account may not view', () => {
    const control: PatreonControl = { posts: 6, filesPerPost: 2, contentBytes: 2000, locked: [1, 4] };

    it('are recorded as not accessible, with the reason, and the run ends without a problem', async () => {
      const { subject, run } = await setup(control);

      expect(await run()).toEqual({ result: 'stored' });

      expect(await assetRows(subject)).toEqual([
        { post: '9000', asset: expect.stringMatching(/^hash-/), state: 'stored', error_code: null },
        { post: '9000', asset: expect.stringMatching(/^hash-/), state: 'stored', error_code: null },
        { post: '9001', asset: 'locked', state: 'failed', error_code: 'ASSET_LOCKED' },
        { post: '9002', asset: expect.stringMatching(/^hash-/), state: 'stored', error_code: null },
        { post: '9002', asset: expect.stringMatching(/^hash-/), state: 'stored', error_code: null },
        { post: '9003', asset: expect.stringMatching(/^hash-/), state: 'stored', error_code: null },
        { post: '9003', asset: expect.stringMatching(/^hash-/), state: 'stored', error_code: null },
        { post: '9004', asset: 'locked', state: 'failed', error_code: 'ASSET_LOCKED' },
        { post: '9005', asset: expect.stringMatching(/^hash-/), state: 'stored', error_code: null },
        { post: '9005', asset: expect.stringMatching(/^hash-/), state: 'stored', error_code: null }
      ]);
      const [message] = await subject.rows<{ error_message: string }>("SELECT error_message FROM download_assets WHERE error_code = 'ASSET_LOCKED' LIMIT 1");
      expect(message!.error_message).toMatch(/^Nicht zugänglich: .*Patreon.*gesperrt.*kein Fehler/);
      // Not a failure: the run counts no failed asset and is "stored".
      expect(await runs(subject)).toEqual([expect.objectContaining({ state: 'stored', error_code: null, posts_found: 6, assets_stored: 8, assets_failed: 0 })]);
    });

    it('are not read again and again, but a post that is released later is loaded', async () => {
      const { tool, subject, run } = await setup(control);
      await run();
      const before = (await tool.calls()).length;

      // Two more runs while the posts stay locked: no single-post listing for them, no download, no new rows.
      expect(await run()).toEqual({ result: 'stored' });
      expect(await run()).toEqual({ result: 'stored' });
      expect(await singlePostCalls(tool, before)).toEqual([]);
      expect((await tool.calls()).slice(before).filter((args) => args.includes('--range'))).toEqual([]);
      expect(await postRows(subject)).toHaveLength(6);

      // The creator lets this account see post 9001: Patreon lists its files, which gives the post a new revision.
      await tool.control({ ...control, locked: [4] });
      const releasedFrom = (await tool.calls()).length;
      expect(await run()).toEqual({ result: 'stored' });
      expect((await singlePostCalls(tool, releasedFrom)).map((args) => args.at(-1))).toEqual([postUrl(1)]);
      expect((await tool.calls()).slice(releasedFrom).filter((args) => args.includes('--range'))).toHaveLength(2);
      const released = (await assetRows(subject)).filter((asset) => asset.post === '9001');
      expect(released.map((asset) => [asset.state, asset.error_code])).toEqual([['failed', 'ASSET_LOCKED'], ['stored', null], ['stored', null]]);
    });
  });

  it('reads the creator with one stream per run and asks for each post only once it is a new one', async () => {
    const { tool, subject, run } = await setup({ posts: 5, filesPerPost: 1, contentBytes: 1000 });
    await run();
    const calls = await tool.calls();
    // probe (one post), the stream, the check that the short feed ended; then one listing per post and one download per file.
    expect(feedCalls(calls).map((args) => args.includes('output.jsonl=true'))).toEqual([false, true, false]);
    expect((await singlePostCalls(tool)).length).toBe(5);
    expect(await postRows(subject)).toHaveLength(5);
  });
});
