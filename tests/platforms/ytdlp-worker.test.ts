import { existsSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { credentialAad } from '../../packages/adapters/src/index.js';
import { encryptSecret } from '../../apps/api/src/immich-routes.js';
import { CREDENTIAL_MESSAGES } from '../../apps/worker/src/credentials.js';
import { JobExecutor } from '../../apps/worker/src/executor.js';
import { createPipelineFixture, type PipelineFixture } from '../m5b/fixture.js';
import type { ControllableTool } from '../m5b/tools.js';
import { FAKE_YOUTUBE_LOGIN, FAKE_YOUTUBE_SAPISID, youtubeCookieFile } from './credential-samples.js';
import { failureOf, fakeYtDlpTool, listingOf, readFixtureJson, videoMetadata, type FakeYtDlp, type YtDlpControl } from './fake-ytdlp.js';

/*
 * Whole runs through the real worker (executor, history, blob store on real PostgreSQL) with the fake yt-dlp that
 * replays real yt-dlp output: lists, incremental runs, per-entry states, login and throttling problems.
 */

const CHANNEL_URL = 'https://www.youtube.com/@owntestchannel/videos';
const PLAYLIST_URL = 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop';
const PORNHUB_LIST_URL = 'https://www.pornhub.com/model/owntestmodel/videos';
const watch = (id: string) => `https://www.youtube.com/watch?v=${id}`;
const phVideo = (key: string) => `https://www.pornhub.com/view_video.php?viewkey=${key}`;

interface PostRow { platform_post_id: string; state: string; platform: string; revision_key: string }
interface AssetRow { platform_post_id: string; state: string; error_code: string | null; error_message: string | null; media_type: string }

describe('YouTube and Pornhub lists through the worker (fake yt-dlp, real PostgreSQL, no network)', () => {
  const open: PipelineFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  async function start(control: YtDlpControl) {
    const tool: FakeYtDlp = await fakeYtDlpTool(control);
    const subject = await createPipelineFixture({ tools: { ytDlp: tool as unknown as ControllableTool } });
    open.push(subject);
    const userId = await subject.newUser();
    // The executor of the fixture has no secret key; this one can read stored logins.
    const executor = new JobExecutor({
      pool: subject.pool, queue: subject.queue, subscriptions: subject.subscriptions, history: subject.history, blobstore: subject.blobstore,
      catalog: subject.catalog, handover: subject.handover, clock: subject.clock, logger: subject.logger, workDir: subject.workDir,
      maxAssetBytes: 10 * 1024 * 1024, secretKey: subject.secretKey
    });
    const runOnce = async (ownerId: string, subscriptionId: string) => ({
      outcome: await executor.execute(await subject.queueAndClaim(ownerId, subscriptionId), new AbortController().signal)
    });
    return { subject: Object.assign(subject, { runOnce }), tool, userId };
  }

  const posts = (subject: PipelineFixture) => subject.rows<PostRow>(
    'SELECT platform_post_id, state, platform, revision_key FROM download_posts ORDER BY platform_post_id'
  );
  const assets = (subject: PipelineFixture) => subject.rows<AssetRow>(
    `SELECT p.platform_post_id, a.state, a.error_code, a.error_message, a.media_type
       FROM download_assets a JOIN download_posts p ON p.id = a.post_id ORDER BY p.platform_post_id, a.asset_index`
  );
  const runs = (subject: PipelineFixture) => subject.rows<Record<string, unknown>>(
    'SELECT state, error_code, error_message, posts_found, posts_skipped, assets_stored, assets_failed, platform FROM download_runs ORDER BY started_at'
  );
  const downloadCalls = async (tool: FakeYtDlp) => (await tool.calls()).filter((args) => args.includes('--no-progress'));

  /** The channel of five videos: good, running livestream, announced, good, private. */
  async function channelControl(): Promise<YtDlpControl> {
    const listing = await readFixtureJson<{ entries: { id: string }[] }>('ytdlp-youtube-channel-flat.json');
    const wanted = ['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3', 'aaaaaaaaaa5', 'aaaaaaaaaa6'];
    const entries = wanted.map((id) => listing.entries.find((entry) => entry.id === id)!);
    return {
      lists: { [CHANNEL_URL]: { stdout: JSON.stringify({ ...listing, entries }) } },
      videos: {
        [watch('aaaaaaaaaa1')]: await videoMetadata('ytdlp-youtube-video-modern.json', 'aaaaaaaaaa1'),
        [watch('aaaaaaaaaa2')]: await videoMetadata('ytdlp-youtube-video-live.json', 'aaaaaaaaaa2'),
        [watch('aaaaaaaaaa3')]: await failureOf('ytdlp-error-youtube-premiere.txt'),
        [watch('aaaaaaaaaa5')]: await videoMetadata('ytdlp-youtube-video-h264.json', 'aaaaaaaaaa5'),
        [watch('aaaaaaaaaa6')]: await failureOf('ytdlp-error-youtube-private.txt')
      },
      downloads: { [watch('aaaaaaaaaa1')]: { ext: 'webm' } }
    };
  }

  it('stores what can be stored, records a state for every other entry, and fetches nothing twice on the next run', async () => {
    const { subject, tool, userId } = await start(await channelControl());
    const subscription = await subject.subscribe(userId, 'https://www.youtube.com/@owntestchannel');

    const first = await subject.runOnce(userId, subscription.id);

    expect(first.outcome).toMatchObject({ result: 'problem', partial: true, disposition: { code: 'ASSET_NOT_ACCESSIBLE' } });
    expect(await posts(subject)).toEqual([
      expect.objectContaining({ platform_post_id: 'aaaaaaaaaa1', state: 'stored', platform: 'youtube' }),
      expect.objectContaining({ platform_post_id: 'aaaaaaaaaa2', state: 'failed' }),
      expect.objectContaining({ platform_post_id: 'aaaaaaaaaa3', state: 'failed' }),
      expect.objectContaining({ platform_post_id: 'aaaaaaaaaa5', state: 'stored' }),
      expect.objectContaining({ platform_post_id: 'aaaaaaaaaa6', state: 'failed' })
    ]);
    const firstAssets = await assets(subject);
    expect(firstAssets.map((row) => [row.platform_post_id, row.state, row.error_code, row.media_type])).toEqual([
      ['aaaaaaaaaa1', 'stored', null, 'video/webm'],
      ['aaaaaaaaaa2', 'failed', 'ASSET_NOT_YET_AVAILABLE', 'application/octet-stream'],
      ['aaaaaaaaaa3', 'failed', 'ASSET_NOT_YET_AVAILABLE', 'application/octet-stream'],
      ['aaaaaaaaaa5', 'stored', null, 'video/mp4'],
      ['aaaaaaaaaa6', 'failed', 'ASSET_NOT_ACCESSIBLE', 'application/octet-stream']
    ]);
    expect(firstAssets[1]!.error_message).toMatch(/Livestream läuft gerade/);
    expect(firstAssets[4]!.error_message).toMatch(/privat/);
    // Only the private video counts as a failure; a running stream and an announced video are not failures of the run.
    expect(await runs(subject)).toEqual([expect.objectContaining({
      state: 'partially_completed', error_code: 'ASSET_NOT_ACCESSIBLE', posts_found: 5, posts_skipped: 0, assets_stored: 2, assets_failed: 1, platform: 'youtube'
    })]);
    expect(await downloadCalls(tool)).toHaveLength(2);

    // Second run: the two stored videos are skipped without a request, the other three are looked at again.
    const second = await subject.runOnce(userId, subscription.id);
    expect(second.outcome).toEqual({ result: 'stored' });
    expect(await downloadCalls(tool)).toHaveLength(2);
    expect((await runs(subject))[1]).toMatchObject({ state: 'stored', posts_found: 5, posts_skipped: 2, assets_stored: 0, assets_failed: 0 });
    expect(await posts(subject)).toHaveLength(5);
    expect((await assets(subject)).map((row) => row.error_code)).toEqual([null, 'ASSET_NOT_YET_AVAILABLE', 'ASSET_NOT_YET_AVAILABLE', null, 'ASSET_NOT_ACCESSIBLE']);

    // The stream ends: the next run stores it as an ordinary video; nothing else is downloaded again.
    const control = await channelControl();
    control.videos![watch('aaaaaaaaaa2')] = await videoMetadata('ytdlp-youtube-video-h264.json', 'aaaaaaaaaa2', { live_status: 'was_live' });
    await tool.control(control);
    const third = await subject.runOnce(userId, subscription.id);
    expect(third.outcome).toEqual({ result: 'stored' });
    expect((await posts(subject)).find((row) => row.platform_post_id === 'aaaaaaaaaa2')!.state).toBe('stored');
    expect(await downloadCalls(tool)).toHaveLength(3);
  });

  it('adds only the new video when a channel got one, and the known videos keep their revision', async () => {
    const control = await channelControl();
    const { subject, tool, userId } = await start(control);
    const subscription = await subject.subscribe(userId, CHANNEL_URL);
    await subject.runOnce(userId, subscription.id);
    const known = await posts(subject);

    const listing = await readFixtureJson<{ entries: Record<string, unknown>[] }>('ytdlp-youtube-channel-flat.json');
    const fresh = { ...listing.entries[0]!, id: 'bbbbbbbbbb1', url: watch('bbbbbbbbbb1'), title: 'Brand new' };
    const current = JSON.parse(control.lists![CHANNEL_URL]!.stdout!) as { entries: Record<string, unknown>[] };
    await tool.control({
      ...control,
      lists: { [CHANNEL_URL]: { stdout: JSON.stringify({ ...current, entries: [fresh, ...current.entries] }) } },
      videos: { ...control.videos, [watch('bbbbbbbbbb1')]: await videoMetadata('ytdlp-youtube-video-h264.json', 'bbbbbbbbbb1') }
    });
    const before = (await downloadCalls(tool)).length;
    await subject.runOnce(userId, subscription.id);

    expect((await downloadCalls(tool)).length).toBe(before + 1);
    const after = await posts(subject);
    expect(after.map((row) => row.platform_post_id)).toEqual(['aaaaaaaaaa1', 'aaaaaaaaaa2', 'aaaaaaaaaa3', 'aaaaaaaaaa5', 'aaaaaaaaaa6', 'bbbbbbbbbb1']);
    for (const row of known) expect(after.find((candidate) => candidate.platform_post_id === row.platform_post_id)!.revision_key).toBe(row.revision_key);
  });

  it('reads a playlist the same way', async () => {
    const control: YtDlpControl = {
      lists: { [PLAYLIST_URL]: await listingOf('ytdlp-youtube-playlist-flat.json') },
      videos: {
        [watch('aaaaaaaaaa1')]: await videoMetadata('ytdlp-youtube-video-h264.json', 'aaaaaaaaaa1'),
        [watch('aaaaaaaaaa2')]: await videoMetadata('ytdlp-youtube-video-live.json', 'aaaaaaaaaa2'),
        [watch('aaaaaaaaaa3')]: await videoMetadata('ytdlp-youtube-video-h264.json', 'aaaaaaaaaa3')
      }
    };
    const { subject, userId } = await start(control);
    const subscription = await subject.subscribe(userId, `https://www.youtube.com/watch?list=PLabcdefghijklmnop`);
    const { outcome } = await subject.runOnce(userId, subscription.id);
    expect(outcome).toEqual({ result: 'stored' });
    expect((await posts(subject)).map((row) => [row.platform_post_id, row.state])).toEqual([
      ['aaaaaaaaaa1', 'stored'], ['aaaaaaaaaa2', 'failed'], ['aaaaaaaaaa3', 'stored']
    ]);
  });

  it('ends a run that meets the bot check with the cookies hint, pauses the subscription and keeps the check for the user', async () => {
    const { subject, userId } = await start({
      lists: { [CHANNEL_URL]: await listingOf('ytdlp-youtube-channel-flat.json') },
      videos: { [watch('aaaaaaaaaa1')]: await failureOf('ytdlp-error-youtube-bot.txt') }
    });
    const subscription = await subject.subscribe(userId, CHANNEL_URL);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { runState: 'waiting_auth', code: 'AUTH_REQUIRED', pauseSubscription: true } });
    const [run] = await runs(subject);
    expect(run).toMatchObject({ state: 'waiting_auth', error_code: 'AUTH_REQUIRED' });
    expect(run!.error_message).toMatch(/Sicherheitsprüfung/);
    expect(run!.error_message).toMatch(/YouTube-Cookies|Cookies/);
    expect(await subject.rows('SELECT status FROM subscriptions WHERE id = $1', [subscription.id])).toEqual([{ status: 'paused' }]);
    // The run stopped at the first video: the others were not even looked at.
    expect(await posts(subject)).toEqual([expect.objectContaining({ platform_post_id: 'aaaaaaaaaa1' })]);
  });

  it('hands stored YouTube cookies to the tool as a 0600 file, deletes it afterwards and never logs them', async () => {
    const { subject, tool, userId } = await start({
      lists: { [CHANNEL_URL]: await listingOf('ytdlp-youtube-channel-flat.json') },
      videos: { [watch('aaaaaaaaaa1')]: await failureOf('ytdlp-error-youtube-bot.txt') }
    });
    const cookies = youtubeCookieFile();
    const encrypted = encryptSecret(subject.secretKey, cookies, credentialAad('youtube', userId));
    await subject.pool.query(
      `INSERT INTO platform_credentials (id, user_id, platform, cookies_ciphertext, cookies_nonce, cookie_count, earliest_expiry, kind)
       VALUES ($1, $2, 'youtube', $3, $4, 2, NULL, 'cookies')`,
      [randomUUID(), userId, encrypted.ciphertext, encrypted.nonce]
    );
    const subscription = await subject.subscribe(userId, CHANNEL_URL);

    await subject.runOnce(userId, subscription.id);

    const seen = await tool.cookies();
    expect(seen.length).toBeGreaterThanOrEqual(2); // the listing and the video
    for (const observation of seen) {
      expect(observation).toMatchObject({ mode: '600', content: cookies });
      expect(existsSync(observation.path)).toBe(false);
    }
    expect((await readdir(subject.workDir)).filter((name) => name.startsWith('run-'))).toEqual([]);
    // With a login in place the problem is worded as a rejected login, and the stored login is marked.
    const [run] = await runs(subject);
    expect(run!.error_message).toMatch(/trotz der hinterlegten Cookies/);
    expect(await subject.rows('SELECT last_result FROM platform_credentials WHERE user_id = $1', [userId])).toEqual([{ last_result: 'auth_required' }]);
    expect(CREDENTIAL_MESSAGES.youtube.expired).not.toBe(run!.error_message);

    const everything = JSON.stringify([subject.logs, await subject.rows('SELECT * FROM download_runs'), await subject.rows('SELECT * FROM audit_events'), await tool.calls()]);
    expect(everything).not.toContain(FAKE_YOUTUBE_LOGIN);
    expect(everything).not.toContain(FAKE_YOUTUBE_SAPISID);
  });

  it('waits for the rate limit instead of failing when the list answers with HTTP 429', async () => {
    const { subject, userId } = await start({ lists: { [CHANNEL_URL]: await failureOf('ytdlp-error-youtube-http429.txt') } });
    const subscription = await subject.subscribe(userId, CHANNEL_URL);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { runState: 'waiting_rate_limit', code: 'RATE_LIMITED', retryable: true } });
    expect(await posts(subject)).toEqual([]);
    expect(await subject.rows('SELECT status FROM subscriptions WHERE id = $1', [subscription.id])).toEqual([{ status: 'active' }]);
  });

  it('fails clearly, without retry, for a channel that does not exist', async () => {
    const { subject, userId } = await start({ lists: { [CHANNEL_URL]: await failureOf('ytdlp-error-youtube-channel-missing.txt') } });
    const subscription = await subject.subscribe(userId, CHANNEL_URL);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { runState: 'failed', code: 'TARGET_NOT_FOUND', retryable: false } });
    expect((await runs(subject))[0]!.error_message).toMatch(/Kanal oder die Playlist wurde nicht gefunden/);
  });

  it('records a private single video as the state of its entry and ends the run with that reason', async () => {
    const { subject, userId } = await start({ videos: { [watch('dQw4w9WgXcQ')]: await failureOf('ytdlp-error-youtube-private.txt') } });
    const subscription = await subject.subscribe(userId, 'https://youtu.be/dQw4w9WgXcQ?si=tracking');

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { code: 'ASSET_NOT_ACCESSIBLE', retryable: false } });
    expect(await assets(subject)).toEqual([expect.objectContaining({ platform_post_id: 'dQw4w9WgXcQ', state: 'failed', error_code: 'ASSET_NOT_ACCESSIBLE' })]);
  });

  it('stores the videos of a Pornhub model list, marks removed ones, and uses no cookies', async () => {
    const keys = ['ph5aaaaaaaaaaa1', 'ph5aaaaaaaaaaa2', 'ph5aaaaaaaaaaa3'];
    const info = (key: string) => ({ stdout: JSON.stringify({ _type: 'video', id: key, title: `Clip ${key}`, ext: 'mp4', uploader: 'Own Uploader', uploader_id: '/users/own-uploader', width: 1280, height: 720 }) });
    const { subject, tool, userId } = await start({
      lists: { [PORNHUB_LIST_URL]: await listingOf('ytdlp-pornhub-model-videos.json') },
      videos: { [phVideo(keys[0]!)]: info(keys[0]!), [phVideo(keys[1]!)]: await failureOf('ytdlp-error-pornhub-removed.txt'), [phVideo(keys[2]!)]: info(keys[2]!) }
    });
    const subscription = await subject.subscribe(userId, 'https://www.pornhub.com/model/owntestmodel');

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', partial: true, disposition: { code: 'ASSET_NOT_ACCESSIBLE' } });
    expect((await posts(subject)).map((row) => [row.platform_post_id, row.state, row.platform])).toEqual([
      [keys[0], 'stored', 'pornhub'], [keys[1], 'failed', 'pornhub'], [keys[2], 'stored', 'pornhub']
    ]);
    expect((await assets(subject))[1]!.error_message).toMatch(/von Pornhub entfernt/);
    expect((await tool.calls()).flat()).not.toContain('--cookies');
    const [run] = await runs(subject);
    expect(run).toMatchObject({ platform: 'pornhub', assets_stored: 2, assets_failed: 1 });
  });
});
