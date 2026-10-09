import { describe, expect, it } from 'vitest';
import {
  AdapterError,
  capabilitiesForSourceType,
  createTargetRecognizer,
  GalleryDlAdapter,
  selectSource,
  YtDlpAdapter
} from '../../packages/adapters/src/index.js';

/*
 * Address rules of P2: YouTube videos, playlists and channels, Pornhub videos, video lists, playlists and photo albums.
 * No tool runs here: the adapters are the validation-only instances the API uses.
 */

const ytDlp = YtDlpAdapter.forTargetValidationOnly();
const galleryDl = GalleryDlAdapter.forTargetValidationOnly();
const ID = 'dQw4w9WgXcQ';
const CHANNEL = 'UC1234567890abcdefghijkl';
const PLAYLIST = 'PLabcdefghijklmnop';

function codeOf(action: () => unknown): string {
  try {
    action();
  } catch (error) {
    expect(error).toBeInstanceOf(AdapterError);
    return (error as AdapterError).code;
  }
  throw new Error('expected an AdapterError');
}

describe('YouTube single videos', () => {
  it.each([
    [`https://www.youtube.com/watch?v=${ID}`],
    [`https://youtube.com/watch?v=${ID}&t=30s&feature=share&pp=abc&utm_source=x#frag`],
    [`https://m.youtube.com/watch?v=${ID}`],
    [`https://youtu.be/${ID}?si=tracking&t=3`],
    [`https://www.youtube.com/shorts/${ID}?feature=share`],
    [`https://www.youtube.com/live/${ID}?si=abc`],
    // "The video wins" (documented): a watch address with a list is the single video, the list parameter is dropped.
    [`https://www.youtube.com/watch?v=${ID}&list=${PLAYLIST}&index=3`],
    [`https://youtu.be/${ID}?list=${PLAYLIST}`]
  ])('%s is the single video with a clean canonical address', (url) => {
    expect(ytDlp.validateTarget(url)).toEqual({
      adapterId: 'yt-dlp', sourceType: 'youtube', kind: 'post', canonicalUrl: `https://www.youtube.com/watch?v=${ID}`, platformId: ID
    });
  });
});

describe('YouTube playlists', () => {
  it.each([
    [`https://www.youtube.com/playlist?list=${PLAYLIST}`],
    [`https://www.youtube.com/playlist?list=${PLAYLIST}&si=tracking&index=2`],
    [`https://m.youtube.com/playlist?list=${PLAYLIST}`],
    // No video id given: only the playlist can be meant (yt-dlp itself falls back to it).
    [`https://www.youtube.com/watch?list=${PLAYLIST}`]
  ])('%s is a playlist feed', (url) => {
    expect(ytDlp.validateTarget(url)).toEqual({
      adapterId: 'yt-dlp', sourceType: 'youtube', kind: 'creator_feed', canonicalUrl: `https://www.youtube.com/playlist?list=${PLAYLIST}`, platformId: PLAYLIST
    });
  });

  it.each([['UU1234567890abcdefghijkl'], ['FLabcdefghijklmnop'], ['OLAK5uy_abcdefghijklmnop']])('accepts the playlist kind %s', (list) => {
    expect(ytDlp.validateTarget(`https://www.youtube.com/playlist?list=${list}`)).toMatchObject({ kind: 'creator_feed', platformId: list });
  });

  it.each([
    ['watch later', 'WL'],
    ['liked videos', 'LL'],
    ['a mix', 'RDdQw4w9WgXcQ'],
    ['a music mix', 'RDMM']
  ])('rejects %s, which depends on an account or on the moment', (_name, list) => {
    expect(codeOf(() => ytDlp.validateTarget(`https://www.youtube.com/playlist?list=${list}`))).toBe('TARGET_UNSUPPORTED');
  });
});

describe('YouTube channels', () => {
  it.each([
    ['https://www.youtube.com/@owntestchannel', '@owntestchannel', 'https://www.youtube.com/@owntestchannel/videos', '@owntestchannel/videos'],
    ['https://www.youtube.com/@owntestchannel/videos?view=0&sort=dd', '@owntestchannel', 'https://www.youtube.com/@owntestchannel/videos', '@owntestchannel/videos'],
    ['https://m.youtube.com/@owntestchannel/shorts', '@owntestchannel', 'https://www.youtube.com/@owntestchannel/shorts', '@owntestchannel/shorts'],
    ['https://www.youtube.com/@owntestchannel/streams?si=x', '@owntestchannel', 'https://www.youtube.com/@owntestchannel/streams', '@owntestchannel/streams'],
    ['https://www.youtube.com/@%E5%90%8D%E5%89%8D', '@名前', 'https://www.youtube.com/@%E5%90%8D%E5%89%8D/videos', '@名前/videos'],
    [`https://www.youtube.com/channel/${CHANNEL}`, CHANNEL, `https://www.youtube.com/channel/${CHANNEL}/videos`, `${CHANNEL}/videos`],
    [`https://www.youtube.com/channel/${CHANNEL}/shorts`, CHANNEL, `https://www.youtube.com/channel/${CHANNEL}/shorts`, `${CHANNEL}/shorts`],
    ['https://www.youtube.com/c/OwnName', 'c/OwnName', 'https://www.youtube.com/c/OwnName/videos', 'custom/OwnName/videos'],
    ['https://www.youtube.com/c/OwnName/streams', 'c/OwnName', 'https://www.youtube.com/c/OwnName/streams', 'custom/OwnName/streams'],
    ['https://www.youtube.com/user/ownname', 'user/ownname', 'https://www.youtube.com/user/ownname/videos', 'user/ownname/videos'],
    ['https://www.youtube.com/user/ownname/videos', 'user/ownname', 'https://www.youtube.com/user/ownname/videos', 'user/ownname/videos']
  ])('%s is a channel feed', (url, _label, canonicalUrl, platformId) => {
    expect(ytDlp.validateTarget(url)).toEqual({ adapterId: 'yt-dlp', sourceType: 'youtube', kind: 'creator_feed', canonicalUrl, platformId });
  });

  it('always names exactly one tab, because a bare channel address makes yt-dlp read every tab as nested playlists', () => {
    const target = ytDlp.validateTarget('https://www.youtube.com/@owntestchannel');
    expect(new URL(target.canonicalUrl).pathname).toBe('/@owntestchannel/videos');
  });

  it.each([
    ['the playlists tab', 'https://www.youtube.com/@owntestchannel/playlists'],
    ['the community tab', 'https://www.youtube.com/@owntestchannel/community'],
    ['the about page', 'https://www.youtube.com/@owntestchannel/about'],
    ['the featured tab', 'https://www.youtube.com/@owntestchannel/featured'],
    ['an unknown sub-page', 'https://www.youtube.com/@owntestchannel/whatever'],
    ['extra path segments after the tab', 'https://www.youtube.com/@owntestchannel/videos/extra']
  ])('rejects %s as unsupported with a German explanation', (_name, url) => {
    try {
      ytDlp.validateTarget(url);
      throw new Error('expected a rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(AdapterError);
      expect((error as AdapterError).code).toBe('TARGET_UNSUPPORTED');
      expect((error as AdapterError).userMessage).toMatch(/zurzeit nicht unterstützt|zusätzliche Pfadteile/);
    }
  });
});

describe('YouTube rejections and option injection', () => {
  it.each([
    ['an id with an option', `https://www.youtube.com/watch?v=--exec=id`],
    ['an id with a shell separator', `https://www.youtube.com/watch?v=abc;rm%20-rf`],
    ['an id that is too short', 'https://www.youtube.com/watch?v=short'],
    ['an id that is too long', 'https://www.youtube.com/watch?v=dQw4w9WgXcQdQw4w9'],
    ['a watch address without any id', 'https://www.youtube.com/watch'],
    ['a short with an option as id', 'https://www.youtube.com/shorts/--netrc-cmd=id'],
    ['a playlist id that is too short', 'https://www.youtube.com/playlist?list=PL123'],
    ['a playlist address without a list', 'https://www.youtube.com/playlist'],
    ['a playlist id with an option', 'https://www.youtube.com/playlist?list=PL--exec=touch%20x'],
    ['a channel id of the wrong length', 'https://www.youtube.com/channel/UC123'],
    ['a channel id with an option', 'https://www.youtube.com/channel/--exec=id'],
    ['a handle with a space', 'https://www.youtube.com/@own%20test'],
    ['a handle with a slash', 'https://www.youtube.com/@own%2Ftest'],
    ['a handle with an option', 'https://www.youtube.com/@--exec=id'],
    ['a handle with broken percent encoding', 'https://www.youtube.com/@%E0%A4%A'],
    ['a newline injection', `https://www.youtube.com/watch?v=${ID}\n--exec=id`],
    ['an option after the address', `https://www.youtube.com/watch?v=${ID} --exec=id`],
    ['a leading dash', '-o /etc/passwd'],
    ['http', `http://www.youtube.com/watch?v=${ID}`],
    ['credentials', `https://user:secret@www.youtube.com/watch?v=${ID}`]
  ])('rejects %s as invalid', (_name, url) => {
    expect(codeOf(() => ytDlp.validateTarget(url))).toBe('TARGET_INVALID');
  });

  it.each([
    ['the home page', 'https://www.youtube.com/'],
    ['the subscriptions feed', 'https://www.youtube.com/feed/subscriptions'],
    ['a search', 'https://www.youtube.com/results?search_query=x'],
    ['a hashtag', 'https://www.youtube.com/hashtag/own'],
    ['an embed address', `https://www.youtube.com/embed/${ID}`],
    ['a clip', 'https://www.youtube.com/clip/UgkxOwnClip'],
    ['a look-alike host', `https://www.youtube.com.evil.example.test/watch?v=${ID}`],
    ['YouTube Music', `https://music.youtube.com/watch?v=${ID}`],
    ['youtu.be with extra segments', `https://youtu.be/${ID}/extra`],
    ['the URL inside another URL', `https://evil.example.test/?u=https://www.youtube.com/watch?v=${ID}`]
  ])('rejects %s as unsupported', (_name, url) => {
    expect(codeOf(() => ytDlp.validateTarget(url))).toBe('TARGET_UNSUPPORTED');
  });
});

describe('Pornhub', () => {
  const KEY = 'ph5aaaaaaaaaaa1';

  it.each([
    [`https://www.pornhub.com/view_video.php?viewkey=${KEY}`],
    [`https://pornhub.com/view_video.php?viewkey=${KEY}&pkey=12&utm_source=x#top`],
    [`https://de.pornhub.com/view_video.php?viewkey=${KEY}`],
    ['https://www.pornhub.com/view_video.php?viewkey=648719015']
  ])('%s is a single video on the normal site', (url) => {
    const target = ytDlp.validateTarget(url);
    expect(target).toMatchObject({ adapterId: 'yt-dlp', sourceType: 'pornhub', kind: 'post' });
    expect(target.canonicalUrl).toMatch(/^https:\/\/www\.pornhub\.com\/view_video\.php\?viewkey=[0-9a-z]+$/);
    expect(target.platformId).toMatch(/^[0-9a-z]+$/);
  });

  it.each([
    ['https://www.pornhub.com/model/owntestmodel', 'https://www.pornhub.com/model/owntestmodel/videos', 'model/owntestmodel/all'],
    ['https://www.pornhub.com/model/owntestmodel/videos?o=cm', 'https://www.pornhub.com/model/owntestmodel/videos', 'model/owntestmodel/all'],
    ['https://www.pornhub.com/pornstar/own-star/videos', 'https://www.pornhub.com/pornstar/own-star/videos', 'pornstar/own-star/all'],
    ['https://www.pornhub.com/channels/own-channel', 'https://www.pornhub.com/channels/own-channel/videos', 'channels/own-channel/all'],
    ['https://www.pornhub.com/users/own_user/videos/upload', 'https://www.pornhub.com/users/own_user/videos/upload', 'users/own_user/upload'],
    ['https://www.pornhub.com/model/owntestmodel/videos/upload', 'https://www.pornhub.com/model/owntestmodel/videos/upload', 'model/owntestmodel/upload'],
    ['https://www.pornhub.com/playlist/44121572?page=2', 'https://www.pornhub.com/playlist/44121572', 'playlist/44121572']
  ])('%s is a video list', (url, canonicalUrl, platformId) => {
    expect(ytDlp.validateTarget(url)).toEqual({ adapterId: 'yt-dlp', sourceType: 'pornhub', kind: 'creator_feed', canonicalUrl, platformId });
  });

  it('treats photo albums as gallery-dl business and leaves them to it', () => {
    const url = 'https://www.pornhub.com/album/4242?x=1';
    expect(codeOf(() => ytDlp.validateTarget(url))).toBe('TARGET_UNSUPPORTED');
    expect(galleryDl.validateTarget(url)).toEqual({
      adapterId: 'gallery-dl', sourceType: 'pornhub', kind: 'post', canonicalUrl: 'https://www.pornhub.com/album/4242', platformId: '4242'
    });
    // ... and the other way round: gallery-dl does not take videos or video lists.
    expect(codeOf(() => galleryDl.validateTarget(`https://www.pornhub.com/view_video.php?viewkey=${KEY}`))).toBe('TARGET_UNSUPPORTED');
    expect(codeOf(() => galleryDl.validateTarget('https://www.pornhub.com/model/owntestmodel'))).toBe('TARGET_UNSUPPORTED');
  });

  it.each([
    ['premium', `https://www.pornhubpremium.com/view_video.php?viewkey=${KEY}`],
    ['another top-level domain', `https://www.pornhub.org/view_video.php?viewkey=${KEY}`],
    ['the home page', 'https://www.pornhub.com/'],
    ['a category', 'https://www.pornhub.com/categories/amateur'],
    ['a search', 'https://www.pornhub.com/video/search?search=x'],
    ['a single photo', 'https://www.pornhub.com/photo/12345'],
    ['a single gif', 'https://www.pornhub.com/gif/12345'],
    ['the photos of a model', 'https://www.pornhub.com/model/owntestmodel/photos'],
    ['the gifs of a model', 'https://www.pornhub.com/model/owntestmodel/gifs'],
    ['a sub-page of a model', 'https://www.pornhub.com/model/owntestmodel/about'],
    ['a deeper video list', 'https://www.pornhub.com/model/owntestmodel/videos/best']
  ])('rejects %s as unsupported, in both adapters', (_name, url) => {
    expect(codeOf(() => ytDlp.validateTarget(url))).toBe('TARGET_UNSUPPORTED');
    expect(codeOf(() => galleryDl.validateTarget(url))).toBe('TARGET_UNSUPPORTED');
  });

  it.each([
    ['a viewkey with an option', 'https://www.pornhub.com/view_video.php?viewkey=--exec=id'],
    ['a viewkey in capital letters', 'https://www.pornhub.com/view_video.php?viewkey=PH5AAAAAAAAAAA1'],
    ['a viewkey that is too short', 'https://www.pornhub.com/view_video.php?viewkey=abc'],
    ['a missing viewkey', 'https://www.pornhub.com/view_video.php'],
    ['a name with a shell separator', 'https://www.pornhub.com/model/own;rm'],
    ['a name with an option', 'https://www.pornhub.com/model/--exec=id'],
    ['a playlist id that is no number', 'https://www.pornhub.com/playlist/abc'],
    ['an album id that is no number', 'https://www.pornhub.com/album/abc'],
    ['a newline injection', `https://www.pornhub.com/view_video.php?viewkey=${KEY}\n--exec=id`]
  ])('rejects %s as invalid', (_name, url) => {
    expect(codeOf(() => ytDlp.validateTarget(url))).toBe('TARGET_INVALID');
  });
});

describe('routing to the right adapter (the recognizer the API and the worker use)', () => {
  const recognizer = createTargetRecognizer();
  const route = (url: string) => {
    const { adapter, target } = selectSource(recognizer, url);
    return [adapter.capabilities().adapterId, target.sourceType, target.kind] as const;
  };

  it.each([
    [`https://www.youtube.com/watch?v=${ID}`, ['yt-dlp', 'youtube', 'post']],
    [`https://www.youtube.com/playlist?list=${PLAYLIST}`, ['yt-dlp', 'youtube', 'creator_feed']],
    ['https://www.youtube.com/@owntestchannel', ['yt-dlp', 'youtube', 'creator_feed']],
    ['https://www.pornhub.com/view_video.php?viewkey=ph5aaaaaaaaaaa1', ['yt-dlp', 'pornhub', 'post']],
    ['https://www.pornhub.com/model/owntestmodel', ['yt-dlp', 'pornhub', 'creator_feed']],
    ['https://www.pornhub.com/playlist/44121572', ['yt-dlp', 'pornhub', 'creator_feed']],
    ['https://www.pornhub.com/album/4242', ['gallery-dl', 'pornhub', 'post']],
    ['https://www.instagram.com/p/Cabc12345/', ['gallery-dl', 'instagram', 'post']],
    ['https://www.patreon.com/owntestcreator', ['gallery-dl', 'patreon', 'creator_feed']],
    ['https://www.pixiv.net/users/4242', ['gallery-dl', 'pixiv', 'creator_feed']],
    ['https://media.example.test/files/pic.jpg', ['direct-url', 'direct_media', 'post']]
  ] as const)('%s goes to %j', (url, expected) => {
    expect(route(url)).toEqual(expected);
  });

  it('never hands a rejected address of a known platform to the direct URL adapter', () => {
    for (const url of ['https://www.youtube.com/feed/subscriptions', 'https://www.pornhub.com/categories', 'https://www.pornhub.com/photo/12345']) {
      expect(codeOf(() => selectSource(recognizer, url))).toBe('TARGET_UNSUPPORTED');
    }
  });

  it('shows the German reason of the adapter that recognised the address', () => {
    try {
      selectSource(recognizer, 'https://www.pornhub.com/model/owntestmodel/photos');
      throw new Error('expected a rejection');
    } catch (error) {
      expect((error as AdapterError).userMessage).toMatch(/Foto-Alben und GIFs eines Models/);
    }
  });

  it('declares the capabilities per source type for the adapter overview', () => {
    const adapters = new Map(recognizer.listCapabilities().map((entry) => [entry.adapterId, entry]));
    const at = (adapterId: string, sourceType: Parameters<typeof capabilitiesForSourceType>[1]) =>
      capabilitiesForSourceType(adapters.get(adapterId)!, sourceType);
    expect(at('yt-dlp', 'youtube')).toMatchObject({ single_post: true, creator_feed: true, pagination: true, videos: true, images: false, auth_kind: 'cookies' });
    expect(at('yt-dlp', 'pornhub')).toMatchObject({ single_post: true, creator_feed: true, pagination: true, videos: true, images: false, auth_kind: 'none' });
    expect(at('gallery-dl', 'pornhub')).toMatchObject({ single_post: true, creator_feed: false, images: true, videos: false, auth_kind: 'none' });
  });
});
