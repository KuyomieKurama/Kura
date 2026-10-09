import { afterEach, describe, expect, it } from 'vitest';
import { createApiFixture, type ApiFixture, type TestLogin } from '../m4b/api-fixture.js';

/*
 * The address check and the adapter overview for the new target kinds (P2): YouTube channels and playlists,
 * Pornhub videos, lists and photo albums. German texts, no em dashes, no emoji.
 */

describe('source check and adapter overview for YouTube and Pornhub (API on real PostgreSQL)', () => {
  const open: ApiFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((api) => api.cleanup()));
  });

  async function start() {
    const api = await createApiFixture();
    open.push(api);
    return { api, alice: await api.addUser('alice') };
  }

  const validate = async (api: ApiFixture, alice: TestLogin, url: string) =>
    (await api.call(alice, 'POST', '/api/v1/sources/validate', { url })).json() as Record<string, unknown> & { notices: string[] };

  const FORBIDDEN_CHARACTERS = /[\u2013\u2014\u{1F300}-\u{1FAFF}\u2600-\u27BF]/u;

  it.each([
    ['https://www.youtube.com/@owntestchannel', 'https://www.youtube.com/@owntestchannel/videos', /Reiter Videos dieses Kanals/],
    ['https://www.youtube.com/@owntestchannel/streams', 'https://www.youtube.com/@owntestchannel/streams', /Reiter Livestreams/],
    ['https://www.youtube.com/@owntestchannel/shorts', 'https://www.youtube.com/@owntestchannel/shorts', /Reiter Shorts/],
    ['https://www.youtube.com/channel/UC1234567890abcdefghijkl', 'https://www.youtube.com/channel/UC1234567890abcdefghijkl/videos', /Kanals geladen/],
    ['https://www.youtube.com/playlist?list=PLabcdefghijklmnop&si=x', 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop', /ersten Videos dieser Playlist in der Reihenfolge von YouTube/]
  ])('recognises %s as a YouTube feed and explains what is read', async (url, canonicalUrl, notice) => {
    const { api, alice } = await start();
    const result = await validate(api, alice, url);
    expect(result).toMatchObject({
      supported: true, platform: 'youtube', platformLabel: 'YouTube', targetKind: 'creator_feed', canonicalUrl, adapter: { id: 'yt-dlp' },
      capabilities: { creatorFeed: true, videos: true, images: false, pagination: true, authKind: 'cookies' },
      credentials: { platform: 'youtube', stored: false, loginNeeded: false }
    });
    expect(result.notices.join(' ')).toMatch(notice);
    expect(result.notices.join(' ')).toMatch(/YouTube-Cookies/); // the optional login for age-restricted and members-only videos
    expect(result.notices.join(' ')).not.toMatch(/Profils/);
  });

  it('says that a watch address with a playlist is the single video, and how to get the playlist', async () => {
    const { api, alice } = await start();
    const result = await validate(api, alice, 'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghijklmnop&index=2');
    expect(result).toMatchObject({ supported: true, targetKind: 'post', canonicalUrl: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
    expect(result.notices.join(' ')).toMatch(/Die Adresse nennt auch eine Playlist\. Geladen wird nur das Video\./);

    const plain = await validate(api, alice, 'https://youtu.be/dQw4w9WgXcQ');
    expect(plain.notices.join(' ')).not.toMatch(/nennt auch eine Playlist/);
  });

  it.each([
    ['https://www.pornhub.com/view_video.php?viewkey=ph5aaaaaaaaaaa1', 'post', 'yt-dlp'],
    ['https://www.pornhub.com/model/owntestmodel', 'creator_feed', 'yt-dlp'],
    ['https://www.pornhub.com/channels/own-channel/videos', 'creator_feed', 'yt-dlp'],
    ['https://www.pornhub.com/playlist/44121572', 'creator_feed', 'yt-dlp'],
    ['https://www.pornhub.com/album/4242', 'post', 'gallery-dl']
  ])('recognises %s as a Pornhub %s with %s and needs no login', async (url, targetKind, adapterId) => {
    const { api, alice } = await start();
    const result = await validate(api, alice, url);
    expect(result).toMatchObject({ supported: true, platform: 'pornhub', platformLabel: 'Pornhub', targetKind, adapter: { id: adapterId }, capabilities: { authKind: 'none' } });
    expect(result.credentials).toBeUndefined();
    expect(result.notices.join(' ')).toMatch(/ohne Anmeldung abgerufen/);
    if (adapterId === 'gallery-dl') expect(result).toMatchObject({ capabilities: { images: true, videos: false, creatorFeed: false } });
    else expect(result).toMatchObject({ capabilities: { images: false, videos: true, creatorFeed: true } });
  });

  it.each([
    ['https://www.youtube.com/@owntestchannel/playlists', /Reiter eines YouTube-Kanals ist zurzeit nicht unterstützt/],
    ['https://www.youtube.com/playlist?list=WL', /hängt von einem Konto oder vom Moment ab/],
    ['https://www.youtube.com/watch?v=short', /Kennung des YouTube-Videos ist ungültig/],
    ['https://www.pornhub.com/categories', /Pornhub-Adresse ist zurzeit nicht unterstützt/],
    ['https://www.pornhub.com/photo/12345', /Einzelne Fotos \(\/photo\/\.\.\.\) sind zurzeit nicht unterstützt/],
    ['https://www.pornhub.com/model/owntestmodel/photos', /Foto-Alben und GIFs eines Models oder Benutzers/],
    ['https://www.pornhubpremium.com/view_video.php?viewkey=ph5aaaaaaaaaaa1', /Pornhub Premium ist zurzeit nicht unterstützt/]
  ])('rejects %s with its own German sentence', async (url, message) => {
    const { api, alice } = await start();
    const result = await validate(api, alice, url);
    expect(result.supported).toBe(false);
    expect(result.message).toMatch(message);
  });

  it('has no em dash, en dash or emoji in any of its texts', async () => {
    const { api, alice } = await start();
    const urls = [
      'https://www.youtube.com/@owntestchannel', 'https://www.youtube.com/playlist?list=PLabcdefghijklmnop',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLabcdefghijklmnop', 'https://www.pornhub.com/model/owntestmodel',
      'https://www.pornhub.com/album/4242', 'https://www.pornhub.com/categories', 'https://www.youtube.com/feed/subscriptions',
      'https://www.pornhub.com/model/x/photos', 'https://www.youtube.com/playlist?list=WL', 'https://www.pornhub.com/view_video.php?viewkey=ph5aaaaaaaaaaa1'
    ];
    for (const url of urls) expect(JSON.stringify(await validate(api, alice, url)), url).not.toMatch(FORBIDDEN_CHARACTERS);
    const adapters = (await api.call(alice, 'GET', '/api/v1/adapters')).body;
    expect(adapters).not.toMatch(FORBIDDEN_CHARACTERS);
  });

  it('lists the kinds of address per adapter and platform in the adapter overview', async () => {
    const { api, alice } = await start();
    const adapters = (await api.call(alice, 'GET', '/api/v1/adapters')).json().adapters as Array<{ id: string; sourceTypes: Array<{ id: string; addressKinds: string[]; capabilities: Record<string, unknown> }> }>;
    const kinds = (adapterId: string, sourceType: string) => adapters.find((adapter) => adapter.id === adapterId)!.sourceTypes.find((type) => type.id === sourceType)!;

    expect(kinds('yt-dlp', 'youtube').addressKinds).toEqual(['Einzelnes Video (watch, youtu.be, Shorts, Live)', 'Playlist', 'Kanal (Reiter Videos, Shorts, Livestreams)']);
    expect(kinds('yt-dlp', 'youtube').capabilities).toMatchObject({ creatorFeed: true, videos: true, authKind: 'cookies' });
    expect(kinds('yt-dlp', 'pornhub').addressKinds).toEqual(['Einzelnes Video', 'Videos eines Models, Pornstars, Kanals oder Benutzers', 'Öffentliche Playlist']);
    expect(kinds('yt-dlp', 'pornhub').capabilities).toMatchObject({ creatorFeed: true, videos: true, images: false, authKind: 'none' });
    expect(kinds('gallery-dl', 'pornhub').addressKinds).toEqual(['Einzelnes Fotoalbum']);
    expect(kinds('gallery-dl', 'pornhub').capabilities).toMatchObject({ creatorFeed: false, images: true, videos: false });
    for (const adapter of adapters) for (const type of adapter.sourceTypes) expect(type.addressKinds.length, `${adapter.id}:${type.id}`).toBeGreaterThan(0);
  });
});
