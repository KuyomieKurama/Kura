import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { controllableGalleryDl, controllableYtDlp } from './tools.js';
import { createPipelineFixture, type PipelineFixture } from './fixture.js';

const PIXIV = 'https://www.pixiv.net/artworks/98765';
const YOUTUBE = 'https://www.youtube.com/watch?v=dQw4w9WgXcQ';
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const pixivFile = (index: number) => Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from(`pixiv file ${index}`)]);

describe('download pipeline with the CLI adapters (fake yt-dlp and gallery-dl, no network)', () => {
  const open: PipelineFixture[] = [];
  const start = async (...args: Parameters<typeof createPipelineFixture>) => {
    const subject = await createPipelineFixture(...args);
    open.push(subject);
    return subject;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  it('stores every file of a multi-page post with gallery-dl', async () => {
    const galleryDl = await controllableGalleryDl(3);
    const subject = await start({ tools: { galleryDl } });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PIXIV);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toEqual({ result: 'stored' });
    const assets = await subject.rows<{ asset_index: number; state: string; sha256: string }>('SELECT asset_index, state, sha256 FROM download_assets ORDER BY asset_index');
    expect(assets).toEqual([0, 1, 2].map((index) => ({ asset_index: index, state: 'stored', sha256: sha256(pixivFile(index)) })));
    expect(await subject.rows('SELECT platform, adapter_id, adapter_version, state, creator_platform_id, creator_name, platform_post_id FROM download_posts')).toEqual([
      { platform: 'pixiv', adapter_id: 'gallery-dl', adapter_version: '1.32.2', state: 'stored', creator_platform_id: '12345', creator_name: 'own_artist', platform_post_id: '98765' }
    ]);
    expect(await subject.rows('SELECT state, assets_stored, platform FROM download_runs')).toEqual([{ state: 'stored', assets_stored: 3, platform: 'pixiv' }]);
    expect((await subject.rows('SELECT 1 FROM blobstore_objects')).length).toBe(3);
  });

  it('downloads a YouTube video with yt-dlp', async () => {
    const ytDlp = await controllableYtDlp();
    const subject = await start({ tools: { ytDlp } });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, YOUTUBE);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toEqual({ result: 'stored' });
    expect(await subject.rows('SELECT media_type, state FROM download_assets')).toEqual([{ media_type: 'video/mp4', state: 'stored' }]);
    expect(await subject.rows('SELECT platform, adapter_id, adapter_version FROM download_runs')).toEqual([{ platform: 'youtube', adapter_id: 'yt-dlp', adapter_version: '2026.07.04' }]);
  });

  it('keeps a post with one failed file partially completed and later fetches only the missing file', async () => {
    const galleryDl = await controllableGalleryDl(3, { failIndexes: [1], stderr: 'connection reset by peer' });
    const subject = await start({ tools: { galleryDl } });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PIXIV);

    const first = await subject.runOnce(userId, subscription.id);

    expect(first.outcome).toMatchObject({ result: 'problem', partial: true, queue: 'retry_wait', disposition: { code: 'PROCESS_FAILED', retryable: true } });
    expect(await subject.rows('SELECT state FROM download_posts')).toEqual([{ state: 'partially_completed' }]);
    expect(await subject.rows('SELECT state, assets_stored, assets_failed FROM download_runs')).toEqual([{ state: 'partially_completed', assets_stored: 2, assets_failed: 1 }]);
    expect(await subject.rows('SELECT asset_index, state, attempts FROM download_assets ORDER BY asset_index')).toEqual([
      { asset_index: 0, state: 'stored', attempts: 1 },
      { asset_index: 1, state: 'failed', attempts: 1 },
      { asset_index: 2, state: 'stored', attempts: 1 }
    ]);
    // The discovery mark exists, but it is not a download success: the post is not archived yet.
    const [sync] = await subject.rows<{ last_seen_post_id: string }>('SELECT * FROM subscription_sync_state');
    expect(sync!.last_seen_post_id).toBe('98765');
    expect((await subject.rows('SELECT 1 FROM download_posts WHERE state = $1', ['stored'])).length).toBe(0);

    await galleryDl.control({});
    subject.advance(3600);
    const second = await subject.runOnce(userId, subscription.id);

    expect(second.outcome).toEqual({ result: 'stored' });
    expect(second.lease.leaseGeneration).toBe(2);
    expect(await subject.rows('SELECT asset_index, state, attempts FROM download_assets ORDER BY asset_index')).toEqual([
      { asset_index: 0, state: 'stored', attempts: 1 },
      { asset_index: 1, state: 'stored', attempts: 2 },
      { asset_index: 2, state: 'stored', attempts: 1 }
    ]);
    expect(await subject.rows('SELECT state FROM download_posts')).toEqual([{ state: 'stored' }]);
    // Downloads per file position: 1 -> once, 2 -> twice (failed, then fixed), 3 -> once.
    const downloads = (await galleryDl.calls()).filter((call) => call.includes('--range')).map((call) => call[call.indexOf('--range') + 1]);
    expect(downloads.sort()).toEqual(['1', '2', '2', '3']);
    expect((await subject.rows('SELECT state FROM job_runs'))[0]).toEqual({ state: 'succeeded' });
  });

  it('stops at the first file when the source wants a login, pauses the subscription and does not move the check mark', async () => {
    const galleryDl = await controllableGalleryDl(3, { failIndexes: [0], stderr: 'ERROR: HTTP Error 403: Forbidden' });
    const subject = await start({ tools: { galleryDl } });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PIXIV);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { runState: 'waiting_auth', code: 'AUTH_REQUIRED' } });
    expect(await subject.rows('SELECT state, error_code FROM download_runs')).toEqual([{ state: 'waiting_auth', error_code: 'AUTH_REQUIRED' }]);
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).status).toBe('paused');
    // Only the first file was tried; the others were not hammered with a rejected login.
    expect((await galleryDl.calls()).filter((call) => call.includes('--range')).length).toBe(1);
    expect(await subject.rows('SELECT state FROM download_assets ORDER BY asset_index')).toEqual([{ state: 'failed' }, { state: 'pending' }, { state: 'pending' }]);
    // The post is not marked as archived and the run is a failure, not "no news".
    expect(await subject.rows('SELECT state FROM download_posts')).toEqual([{ state: 'failed' }]);
    expect((await subject.rows('SELECT state FROM job_runs'))[0]).toEqual({ state: 'failed' });
  });

  it('treats a rejected login while listing as waiting_auth and never as "no new posts"', async () => {
    const ytDlp = await controllableYtDlp({ listingFailure: 'ERROR: [youtube] dQw4w9WgXcQ: Sign in to confirm you are not a bot' });
    const subject = await start({ tools: { ytDlp } });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, YOUTUBE);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', disposition: { runState: 'waiting_auth' } });
    expect(await subject.rows('SELECT 1 FROM subscription_sync_state')).toEqual([]);
    expect(await subject.rows('SELECT 1 FROM download_posts')).toEqual([]);
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).status).toBe('paused');
  });

  it('waits and retries after a rate limit and honours the wait', async () => {
    const galleryDl = await controllableGalleryDl(2, { failIndexes: [0], stderr: 'HttpError: 429 Too Many Requests' });
    const subject = await start({ tools: { galleryDl } });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PIXIV);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'retry_wait', disposition: { runState: 'waiting_rate_limit', code: 'RATE_LIMITED' } });
    const [job] = await subject.rows<{ state: string; run_after: Date }>('SELECT state, run_after FROM job_runs');
    expect(job!.state).toBe('retry_wait');
    expect(job!.run_after.getTime() - subject.clock.now().getTime()).toBeGreaterThanOrEqual(15 * 60 * 1000);
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).status).toBe('active');
  });

  it('says that a tool is not installed instead of "unsupported" and keeps the address valid', async () => {
    const subject = await start();
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, YOUTUBE);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { code: 'TOOL_UNAVAILABLE', runState: 'failed' } });
    const [run] = await subject.rows<{ error_message: string; state: string }>('SELECT state, error_message FROM download_runs');
    expect(run).toEqual({ state: 'failed', error_message: 'Das benötigte Werkzeug ist auf dem Server nicht installiert oder nicht freigegeben.' });
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).targetState).toBe('valid');
  });

  it.each([
    ['https://www.youtube.com/feed/subscriptions', 'TARGET_UNSUPPORTED'],
    ['https://www.youtube.com/playlist?list=PL12345', 'TARGET_INVALID'],
    ['https://www.instagram.com/stories/someprofile/', 'TARGET_UNSUPPORTED'],
    ['http://media.example.test/pic.jpg', 'TARGET_INVALID']
  ])('marks %s as invalid with %s', async (url, code) => {
    const ytDlp = await controllableYtDlp();
    const subject = await start({ tools: { ytDlp } });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, url);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { code } });
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).targetState).toBe('invalid');
  });

  it('shows adapter availability the way the API reads it', async () => {
    const galleryDl = await controllableGalleryDl(1);
    const subject = await start({ tools: { galleryDl } });

    await subject.catalog.publish(subject.pool);

    expect(await subject.rows('SELECT adapter_id, adapter_version, availability, reason_code FROM adapter_status ORDER BY adapter_id')).toEqual([
      { adapter_id: 'direct-url', adapter_version: '1', availability: 'available', reason_code: null },
      { adapter_id: 'gallery-dl', adapter_version: '1.32.2', availability: 'available', reason_code: null },
      { adapter_id: 'yt-dlp', adapter_version: null, availability: 'unavailable', reason_code: 'BINARY_NOT_CONFIGURED' }
    ]);
  });

  it('reports a tool with the wrong hash as unavailable and never starts it', async () => {
    const galleryDl = await controllableGalleryDl(1);
    const subject = await start();
    const tampered = { ...galleryDl.binary, sha256: 'f'.repeat(64) };
    subject.catalog['options'].tools.galleryDl = tampered;

    await subject.catalog.refresh();

    expect(subject.catalog.availability.find((entry) => entry.adapterId === 'gallery-dl')).toMatchObject({ available: false, reasonCode: 'BINARY_HASH_MISMATCH' });
    expect(await galleryDl.calls()).toEqual([]);
  });
});
