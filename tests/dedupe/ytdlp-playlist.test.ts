import { afterEach, describe, expect, it } from 'vitest';
import { createPipelineFixture, type PipelineFixture } from '../m5b/fixture.js';
import type { ControllableTool } from '../m5b/tools.js';
import { fakeYtDlpTool, listingOf, videoMetadata, type FakeYtDlp } from '../platforms/fake-ytdlp.js';

/*
 * D3: a YouTube playlist that is read again is not archived again (fake yt-dlp, real PostgreSQL, no network). A flat list
 * of a playlist is one cheap request and its order is the owner's, not the newest first, so a playlist is always read
 * in full; what makes the repeat run quiet is that no archived video is asked for or downloaded again.
 */

const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop';
const IDS = ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3'];
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;

describe('a YouTube playlist read twice', () => {
  const open: PipelineFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  async function setup() {
    const tool: FakeYtDlp = await fakeYtDlpTool({
      lists: { [PLAYLIST_URL]: await listingOf('ytdlp-youtube-playlist-flat.json') },
      videos: Object.fromEntries(await Promise.all(IDS.map(async (id) => [watch(id), await videoMetadata('ytdlp-youtube-video-h264.json', id)] as const)))
    });
    const subject = await createPipelineFixture({ tools: { ytDlp: tool as unknown as ControllableTool } });
    open.push(subject);
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, 'https://www.youtube.com/watch?list=PLabcdefghijklmnop');
    const run = async () => {
      subject.advance(3600);
      return (await subject.runOnce(userId, subscription.id)).outcome;
    };
    return { tool, subject, run };
  }

  const counts = async (subject: PipelineFixture) => (await subject.rows<{ posts: number; assets: number; blobs: number }>(
    `SELECT (SELECT count(*) FROM download_posts)::int AS posts, (SELECT count(*) FROM download_assets WHERE state = 'stored')::int AS assets,
            (SELECT count(*) FROM blobstore_objects)::int AS blobs`
  ))[0]!;
  const keys = async (subject: PipelineFixture) => (await subject.rows<{ k: string }>('SELECT platform_post_id || \' \' || revision_key AS k FROM download_posts ORDER BY 1')).map((row) => row.k);
  const downloads = async (tool: FakeYtDlp, from: number) => (await tool.calls()).slice(from).filter((args) => args.includes('--no-progress'));
  const videoMetadataCalls = async (tool: FakeYtDlp, from: number) => (await tool.calls()).slice(from).filter((args) => args.includes('--dump-single-json') && !args.includes('--flat-playlist'));

  it('creates no new post and no new asset on the second run and asks for no single video', async () => {
    const { tool, subject, run } = await setup();

    expect(await run()).toEqual({ result: 'stored' });
    expect(await counts(subject)).toEqual({ posts: 3, assets: 3, blobs: 3 });
    const firstKeys = await keys(subject);
    const before = (await tool.calls()).length;

    expect(await run()).toEqual({ result: 'stored' });

    expect(await counts(subject)).toEqual({ posts: 3, assets: 3, blobs: 3 });
    expect(await keys(subject)).toEqual(firstKeys);
    expect(await downloads(tool, before)).toEqual([]);
    expect(await videoMetadataCalls(tool, before)).toEqual([]);
    expect(await subject.rows('SELECT state, posts_found, posts_skipped, assets_stored FROM download_runs ORDER BY started_at')).toEqual([
      { state: 'stored', posts_found: 3, posts_skipped: 0, assets_stored: 3 },
      { state: 'stored', posts_found: 3, posts_skipped: 3, assets_stored: 0 }
    ]);
  });

  it('does not archive again what was archived under the old key format (id, upload date, duration)', async () => {
    const { tool, subject, run } = await setup();
    await run();
    await subject.rows("UPDATE download_posts SET revision_key = 'd-' || substr(md5(id::text), 1, 24)");
    const before = (await tool.calls()).length;

    expect(await run()).toEqual({ result: 'stored' });

    expect(await counts(subject)).toEqual({ posts: 3, assets: 3, blobs: 3 });
    expect(await downloads(tool, before)).toEqual([]);
    expect(await videoMetadataCalls(tool, before)).toEqual([]);
  });

  it('downloads only the video that was added to the playlist', async () => {
    const { tool, subject, run } = await setup();
    await run();
    const list = JSON.parse((await listingOf('ytdlp-youtube-playlist-flat.json')).stdout!) as { entries: Record<string, unknown>[] };
    const added = { ...list.entries[0]!, id: 'bbbbbbbbbb1', url: watch('bbbbbbbbbb1'), title: 'Added later' };
    const current = await tool.calls();
    await tool.control({
      lists: { [PLAYLIST_URL]: { stdout: JSON.stringify({ ...list, entries: [...list.entries, added] }) } },
      videos: Object.fromEntries(await Promise.all([...IDS, 'bbbbbbbbbb1'].map(async (id) => [watch(id), await videoMetadata('ytdlp-youtube-video-h264.json', id)] as const)))
    });

    expect(await run()).toEqual({ result: 'stored' });

    expect(await counts(subject)).toEqual({ posts: 4, assets: 4, blobs: 4 });
    expect(await downloads(tool, current.length)).toHaveLength(1);
  });
});
