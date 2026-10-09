import { afterEach, describe, expect, it } from 'vitest';
import { createPipelineFixture, type PipelineFixture } from '../m5b/fixture.js';
import type { ControllableTool } from '../m5b/tools.js';
import { fakeInstagramGalleryDl, fixture, INSTAGRAM_ROOT, type FakeInstagramTool, type InstagramToolControl } from './fake-instagram-tool.js';

const PROFILE = `${INSTAGRAM_ROOT}/own_test_account/`;
const PROFILE_TOOL_URL = `${INSTAGRAM_ROOT}/own_test_account/posts/`;
const postUrl = (code: string, kind: 'p' | 'reel' = 'p') => `${INSTAGRAM_ROOT}/${kind}/${code}/`;
const errorEntry = (error: string, message: string): unknown[] => [[-1, { error, message }]];

/** The listings of the profile fixture and of each of its posts, as the real extractor prints them. */
async function listings(profile = 'profile-posts'): Promise<Record<string, unknown>> {
  const entries = (await fixture(profile)) as Array<[number, ...unknown[]]>;
  const byPost = new Map<string, unknown[]>();
  let current: unknown[] | undefined;
  for (const entry of entries) {
    if (entry[0] === 2) {
      const metadata = entry.at(-1) as { post_shortcode: string };
      current = [];
      byPost.set(metadata.post_shortcode, current);
    }
    current?.push(entry);
  }
  const result: Record<string, unknown> = { [PROFILE_TOOL_URL]: entries };
  for (const [code, messages] of byPost) {
    const type = (messages[0] as [number, { type: string }])[1].type;
    result[postUrl(code, type === 'reel' ? 'reel' : 'p')] = messages;
  }
  return result;
}

describe('Instagram through the download pipeline (fake gallery-dl, real PostgreSQL, no network)', () => {
  const open: PipelineFixture[] = [];
  const start = async (tool: FakeInstagramTool) => {
    const subject = await createPipelineFixture({ tools: { galleryDl: tool as unknown as ControllableTool } });
    open.push(subject);
    return subject;
  };
  const newTool = (control: InstagramToolControl) => fakeInstagramGalleryDl(control);
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  const downloadCalls = async (tool: FakeInstagramTool) => (await tool.calls()).filter((args) => args.includes('--range'));
  const listingCalls = async (tool: FakeInstagramTool) => (await tool.calls()).filter((args) => args.includes('--dump-json'));

  it('stores every post of a profile: photos, a carousel as several assets, a reel as one video', async () => {
    const tool = await newTool({ listings: await listings() });
    const subject = await start(tool);
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PROFILE);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toEqual({ result: 'stored' });
    expect(await subject.rows('SELECT platform, adapter_id, platform_post_id, state FROM download_posts ORDER BY platform_post_id')).toEqual(
      ['DCarous0001', 'DNewReel001', 'DOlder00001', 'DPhoto00001', 'DPinned0001'].map((code) => ({ platform: 'instagram', adapter_id: 'gallery-dl', platform_post_id: code, state: 'stored' }))
    );
    const assets = await subject.rows<{ platform_post_id: string; asset_index: number; media_type: string; state: string }>(
      `SELECT p.platform_post_id, a.asset_index, a.media_type, a.state FROM download_assets a JOIN download_posts p ON p.id = a.post_id ORDER BY p.platform_post_id, a.asset_index`
    );
    expect(assets.map((asset) => `${asset.platform_post_id}#${asset.asset_index}:${asset.media_type}`)).toEqual([
      'DCarous0001#0:image/jpeg', 'DCarous0001#1:image/jpeg', 'DCarous0001#2:video/mp4',
      'DNewReel001#0:video/mp4', 'DOlder00001#0:image/jpeg', 'DPhoto00001#0:image/jpeg', 'DPinned0001#0:image/jpeg'
    ]);
    expect(assets.every((asset) => asset.state === 'stored')).toBe(true);
    expect(await subject.rows('SELECT state, platform, posts_found, assets_stored FROM download_runs')).toEqual([{ state: 'stored', platform: 'instagram', posts_found: 5, assets_stored: 7 }]);
    const [sync] = await subject.rows<{ last_seen_post_id: string }>('SELECT last_seen_post_id FROM subscription_sync_state');
    expect(sync).toBeDefined();
  });

  it('on the second run fetches only the posts that are new', async () => {
    const tool = await newTool({ listings: await listings() });
    const subject = await start(tool);
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PROFILE);
    expect((await subject.runOnce(userId, subscription.id)).outcome).toEqual({ result: 'stored' });
    const downloadsBefore = (await downloadCalls(tool)).length;
    const listingsBefore = (await listingCalls(tool)).length;

    // One more post appears at the top of the profile.
    await tool.control({ listings: await listings('profile-posts-newer') });
    subject.advance(3600);
    const second = await subject.runOnce(userId, subscription.id);

    expect(second.outcome).toEqual({ result: 'stored' });
    const newDownloads = (await downloadCalls(tool)).slice(downloadsBefore);
    expect(newDownloads).toHaveLength(1);
    expect(newDownloads[0]!.slice(-2)).toEqual(['--', postUrl('DExtraNew01')]);
    // Two profile listings (probe and discovery) and one single-post listing for the new post; the five archived posts are not asked again.
    const newListings = (await listingCalls(tool)).slice(listingsBefore).map((args) => args.at(-1));
    expect(newListings).toEqual([PROFILE_TOOL_URL, PROFILE_TOOL_URL, postUrl('DExtraNew01')]);
    expect(await subject.rows('SELECT posts_found, posts_skipped, assets_stored FROM download_runs ORDER BY started_at')).toEqual([
      { posts_found: 5, posts_skipped: 0, assets_stored: 7 }, { posts_found: 6, posts_skipped: 5, assets_stored: 1 }
    ]);
    expect((await subject.rows('SELECT 1 FROM download_posts')).length).toBe(6);
  });

  it('bounds the first run of a long profile to the default of 50 posts, newest first', async () => {
    const photoListing = (index: number): unknown[] => {
      const code = `DBulk${String(index).padStart(5, '0')}`;
      const metadata = { post_shortcode: code, owner_id: '4242424242', username: 'own_test_account', fullname: 'Own Test Account', type: 'post', date: `2026-02-${String(1 + (index % 27)).padStart(2, '0')} 00:00:00`, num: 1, count: 1, extension: 'jpg', media_id: String(7000 + index) };
      return [[2, metadata], [3, 'https://scontent.example.invalid/x.jpg', metadata]];
    };
    const sixty = Array.from({ length: 60 }, (_unused, index) => photoListing(index));
    const posts: Record<string, unknown> = { [PROFILE_TOOL_URL]: sixty.flat() };
    for (const messages of sixty) posts[postUrl((messages[0] as [number, { post_shortcode: string }])[1].post_shortcode)] = messages;
    const tool = await newTool({ listings: posts });
    const subject = await start(tool);
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PROFILE);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toEqual({ result: 'stored' });
    expect((await subject.rows('SELECT 1 FROM download_posts')).length).toBe(50);
    const [listing] = await listingCalls(tool);
    expect(listing!).toContain('--post-range');
  });

  it('stores a single carousel and a single reel from their own addresses', async () => {
    const tool = await newTool({ listings: await listings() });
    const subject = await start(tool);
    const userId = await subject.newUser();
    const carousel = await subject.subscribe(userId, 'https://www.instagram.com/p/DCarous0001/?igsh=abc', 'Carousel');
    const reel = await subject.subscribe(userId, 'https://www.instagram.com/reels/DNewReel001/', 'Reel');

    expect((await subject.runOnce(userId, carousel.id)).outcome).toEqual({ result: 'stored' });
    expect((await subject.runOnce(userId, reel.id)).outcome).toEqual({ result: 'stored' });

    expect(await subject.rows('SELECT platform_post_id, state FROM download_posts ORDER BY platform_post_id')).toEqual([
      { platform_post_id: 'DCarous0001', state: 'stored' }, { platform_post_id: 'DNewReel001', state: 'stored' }
    ]);
    expect((await subject.rows('SELECT 1 FROM download_assets WHERE state = $1', ['stored'])).length).toBe(4);
  });

  describe('when Instagram wants a login, throttles or does not know the target', () => {
    it('waits for a login (waiting_auth) and pauses the subscription instead of reporting "no new posts"', async () => {
      const tool = await newTool({ listings: { [PROFILE_TOOL_URL]: errorEntry('AbortExtraction', 'HTTP redirect to login page (https://www.instagram.com/accounts/login/)') } });
      const subject = await start(tool);
      const userId = await subject.newUser();
      const subscription = await subject.subscribe(userId, PROFILE);

      const { outcome } = await subject.runOnce(userId, subscription.id);

      expect(outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { runState: 'waiting_auth', code: 'AUTH_REQUIRED', pauseSubscription: true } });
      expect(await subject.rows('SELECT state, error_code FROM download_runs')).toEqual([{ state: 'waiting_auth', error_code: 'AUTH_REQUIRED' }]);
      expect((await subject.subscriptions.getSubscription(userId, subscription.id)).status).toBe('paused');
      expect(await subject.rows('SELECT 1 FROM subscription_sync_state')).toEqual([]);
      expect(await subject.rows('SELECT 1 FROM download_posts')).toEqual([]);
    });

    it('treats a profile that lists nothing like a missing login, not like a quiet profile', async () => {
      const tool = await newTool({ listings: { [PROFILE_TOOL_URL]: [] } });
      const subject = await start(tool);
      const userId = await subject.newUser();
      const subscription = await subject.subscribe(userId, PROFILE);

      const { outcome } = await subject.runOnce(userId, subscription.id);

      expect(outcome).toMatchObject({ result: 'problem', disposition: { runState: 'waiting_auth', code: 'AUTH_REQUIRED' } });
      expect(await subject.rows('SELECT state FROM download_runs')).toEqual([{ state: 'waiting_auth' }]);
      expect(await subject.rows('SELECT 1 FROM subscription_sync_state')).toEqual([]);
    });

    it('shows the German hint for a private profile', async () => {
      const tool = await newTool({ listings: { [PROFILE_TOOL_URL]: [] }, listingStderr: "[instagram][warning] own_test_account's posts are private\n" });
      const subject = await start(tool);
      const userId = await subject.newUser();
      const subscription = await subject.subscribe(userId, PROFILE);

      await subject.runOnce(userId, subscription.id);

      const [run] = await subject.rows<{ error_message: string }>('SELECT error_message FROM download_runs');
      expect(run!.error_message).toMatch(/Profil ist privat/);
    });

    it('waits and tries again later after a 429 (waiting_rate_limit with back-off)', async () => {
      const tool = await newTool({ listings: { [PROFILE_TOOL_URL]: errorEntry('HttpError', "'429 Too Many Requests' for 'https://www.instagram.com/graphql/query'") } });
      const subject = await start(tool);
      const userId = await subject.newUser();
      const subscription = await subject.subscribe(userId, PROFILE);

      const { outcome } = await subject.runOnce(userId, subscription.id);

      expect(outcome).toMatchObject({ result: 'problem', queue: 'retry_wait', disposition: { runState: 'waiting_rate_limit', code: 'RATE_LIMITED', retryable: true, retryAfterSeconds: 900 } });
      expect((await subject.subscriptions.getSubscription(userId, subscription.id)).status).not.toBe('paused');
      expect(await subject.rows('SELECT state, error_code FROM download_runs')).toEqual([{ state: 'waiting_rate_limit', error_code: 'RATE_LIMITED' }]);
    });

    it('fails for good when the profile does not exist', async () => {
      const tool = await newTool({ listings: { [PROFILE_TOOL_URL]: errorEntry('NotFoundError', 'Requested user could not be found') } });
      const subject = await start(tool);
      const userId = await subject.newUser();
      const subscription = await subject.subscribe(userId, PROFILE);

      const { outcome } = await subject.runOnce(userId, subscription.id);

      expect(outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { runState: 'failed', code: 'TARGET_NOT_FOUND', retryable: false } });
      const [run] = await subject.rows<{ error_message: string }>('SELECT error_message FROM download_runs');
      expect(run!.error_message).toMatch(/Profil wurde nicht gefunden/);
    });

    it('archives what was listed before the throttling, ends with waiting_rate_limit and does not move the sync mark', async () => {
      const all = await listings();
      const profile = (all[PROFILE_TOOL_URL] as unknown[]);
      const tool = await newTool({ listings: { ...all, [PROFILE_TOOL_URL]: [...profile, ...errorEntry('HttpError', "'429 Too Many Requests' for 'https://www.instagram.com/graphql/query'")] } });
      const subject = await start(tool);
      const userId = await subject.newUser();
      const subscription = await subject.subscribe(userId, PROFILE);

      const { outcome } = await subject.runOnce(userId, subscription.id);

      expect(outcome).toMatchObject({ result: 'problem', partial: true, disposition: { runState: 'waiting_rate_limit' } });
      expect((await subject.rows('SELECT 1 FROM download_posts WHERE state = $1', ['stored'])).length).toBe(5);
      expect(await subject.rows('SELECT 1 FROM subscription_sync_state')).toEqual([]);
      expect(await subject.rows('SELECT state FROM download_runs')).toEqual([{ state: 'waiting_rate_limit' }]);
    });

    it('stops the whole run at the first post that cannot be read because of throttling', async () => {
      const all = await listings();
      const throttled = errorEntry('HttpError', "'429 Too Many Requests' for 'https://www.instagram.com/api/v1/media/1/info/'");
      const tool = await newTool({ listings: { ...all, [postUrl('DNewReel001', 'reel')]: throttled, [postUrl('DCarous0001')]: throttled } });
      const subject = await start(tool);
      const userId = await subject.newUser();
      const subscription = await subject.subscribe(userId, PROFILE);

      const { outcome } = await subject.runOnce(userId, subscription.id);

      expect(outcome).toMatchObject({ result: 'problem', disposition: { runState: 'waiting_rate_limit', code: 'RATE_LIMITED' } });
      // The newest post comes first and is throttled: no other post is tried afterwards.
      const asked = (await listingCalls(tool)).map((args) => args.at(-1));
      expect(asked).toEqual([PROFILE_TOOL_URL, PROFILE_TOOL_URL, postUrl('DNewReel001', 'reel')]);
      expect(await subject.rows('SELECT 1 FROM subscription_sync_state')).toEqual([]);
    });

    it('stops the whole run when the login wall appears while a file is downloaded', async () => {
      const tool = await newTool({
        listings: await listings(),
        downloadFailure: { stderr: "[instagram][error] HttpError: '403 Forbidden' for 'https://scontent.example.invalid/x'", exitCode: 4 }
      });
      const subject = await start(tool);
      const userId = await subject.newUser();
      const subscription = await subject.subscribe(userId, PROFILE);

      const { outcome } = await subject.runOnce(userId, subscription.id);

      expect(outcome).toMatchObject({ result: 'problem', disposition: { runState: 'waiting_auth', code: 'AUTH_REQUIRED' } });
      expect((await downloadCalls(tool)).length).toBe(1);
      expect((await subject.subscriptions.getSubscription(userId, subscription.id)).status).toBe('paused');
    });
  });

  it('says that the tool is not installed, not that the profile is "defective", when gallery-dl is missing', async () => {
    const subject = await createPipelineFixture({ tools: {} });
    open.push(subject);
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, PROFILE);

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { code: 'TOOL_UNAVAILABLE' } });
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).targetState).toBe('valid');
  });

  it('refuses stories with the precise German sentence and marks the target invalid', async () => {
    const tool = await newTool({ listings: await listings() });
    const subject = await start(tool);
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, 'https://www.instagram.com/stories/own_test_account/');

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toMatchObject({ result: 'problem', queue: 'failed', disposition: { code: 'TARGET_UNSUPPORTED' } });
    const [run] = await subject.rows<{ error_message: string }>('SELECT error_message FROM download_runs');
    expect(run!.error_message).toMatch(/Stories sind zurzeit nicht unterstützt/);
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).targetState).toBe('invalid');
    expect(await tool.calls()).toHaveLength(1); // only the version check
  });
});
