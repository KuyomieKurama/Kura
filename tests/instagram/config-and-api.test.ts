import { afterEach, describe, expect, it } from 'vitest';
import { loadDownloadConfig } from '../../apps/worker/src/config.js';
import { createApiFixture, type ApiFixture } from '../m4b/api-fixture.js';

describe('KURA_INSTAGRAM_MAX_POSTS_PER_RUN', () => {
  const base = { DATABASE_URL: 'postgres://h/db' };

  it('defaults to 50 posts per run', () => {
    expect(loadDownloadConfig(base)!.instagramMaxPostsPerRun).toBe(50);
    expect(loadDownloadConfig({ ...base, KURA_INSTAGRAM_MAX_POSTS_PER_RUN: '' })!.instagramMaxPostsPerRun).toBe(50);
  });

  it('can be set between 1 and 500', () => {
    expect(loadDownloadConfig({ ...base, KURA_INSTAGRAM_MAX_POSTS_PER_RUN: '12' })!.instagramMaxPostsPerRun).toBe(12);
    expect(loadDownloadConfig({ ...base, KURA_INSTAGRAM_MAX_POSTS_PER_RUN: '500' })!.instagramMaxPostsPerRun).toBe(500);
  });

  it.each(['0', '501', '-3', '2.5', 'many'])('refuses %s', (value) => {
    expect(() => loadDownloadConfig({ ...base, KURA_INSTAGRAM_MAX_POSTS_PER_RUN: value })).toThrow(/KURA_INSTAGRAM_MAX_POSTS_PER_RUN/);
  });
});

describe('address check for Instagram (API on real PostgreSQL)', () => {
  const open: ApiFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((api) => api.cleanup()));
  });

  /** One API with one user per test (every fixture owns its database); the returned function checks addresses. */
  async function start() {
    const api = await createApiFixture();
    open.push(api);
    const alice = await api.addUser('alice');
    return async (url: string) => {
      const response = await api.call(alice, 'POST', '/api/v1/sources/validate', { url });
      expect(response.statusCode).toBe(200);
      return response.json() as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
    };
  }

  it('recognises a profile as a feed of gallery-dl and says what that means', async () => {
    const validate = await start();
    const result = await validate('https://www.instagram.com/Own_Test/?igsh=abc');
    expect(result).toMatchObject({
      supported: true, platform: 'instagram', platformLabel: 'Instagram', targetKind: 'creator_feed', canonicalUrl: 'https://www.instagram.com/own_test/',
      adapter: { id: 'gallery-dl' },
      capabilities: { singlePost: true, creatorFeed: true, pagination: true, images: true, videos: true, authKind: 'cookies', authLabel: 'Cookies' }
    });
    expect(result.notices.join(' ')).toMatch(/neuesten Beiträge dieses Profils/);
    expect(result.notices.join(' ')).toMatch(/nur mit angemeldeter Sitzung \(Cookies\)/);
    expect(result.notices.join(' ')).not.toMatch(/genau dieser eine Beitrag/);
  });

  it('recognises the reels tab, single posts and reels', async () => {
    const validate = await start();
    expect(await validate('https://www.instagram.com/own_test/reels/')).toMatchObject({ supported: true, targetKind: 'creator_feed', canonicalUrl: 'https://www.instagram.com/own_test/reels/' });
    expect(await validate('https://www.instagram.com/reels/DNewReel001/')).toMatchObject({ supported: true, targetKind: 'post', canonicalUrl: 'https://www.instagram.com/reel/DNewReel001/' });
    const post = await validate('https://www.instagram.com/p/DCarous0001/');
    expect(post).toMatchObject({ supported: true, targetKind: 'post' });
    expect(post.notices.join(' ')).toMatch(/genau dieser eine Beitrag/);
  });

  it('keeps Pixiv a single-post source with no login, although the adapter as a whole can do more', async () => {
    const validate = await start();
    const result = await validate('https://www.pixiv.net/artworks/98765');
    expect(result).toMatchObject({ supported: true, capabilities: { creatorFeed: false, pagination: false, videos: false, authKind: 'none' } });
  });

  it.each([
    ['https://www.instagram.com/stories/own_test/', /Stories sind zurzeit nicht unterstützt/],
    ['https://www.instagram.com/own_test/highlights/', /Highlights sind zurzeit nicht unterstützt/],
    ['https://www.instagram.com/own_test/tagged/', /Markierte Beiträge .* zurzeit nicht unterstützt/],
    ['https://www.instagram.com/explore/tags/own/', /kein Profil, kein Beitrag und kein Reel/],
    ['https://www.instagram.com/own!test/', /Benutzername ist ungültig/]
  ])('answers %s with a precise German sentence', async (url, message) => {
    const result = await (await start())(url);
    expect(result.supported).toBe(false);
    expect(result.message).toMatch(message);
  });
});
