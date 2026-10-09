import { AdapterError } from './errors.js';

/**
 * The address grammar of YouTube targets for the yt-dlp adapter. Only host and path (and, where YouTube puts the
 * id there, the `v` or `list` parameter) matter: every other query parameter (`si`, `feature`, `pp`, `t`,
 * `utm_*` ...) and the fragment are dropped, and the canonical URL is rebuilt from parsed parts, never from the raw
 * input.
 *
 * What yt-dlp 2026.8.19 accepts (extractor/youtube/_video.py `YoutubeIE._VALID_URL`, `_tab.py`
 * `YoutubeTabIE._VALID_URL`), and what Kura accepts of it:
 *
 *   /watch?v=<id>             single video (also with `list=...`: the video wins, see below)
 *   youtu.be/<id>             single video
 *   /shorts/<id>  /live/<id>  single video (a /live/ address is the video page of a stream)
 *   /playlist?list=<id>       playlist
 *   /watch?list=<id>          playlist (no video id given; yt-dlp itself falls back to the playlist then)
 *   /@handle  /channel/UC...  /c/<name>  /user/<name>   channel, tab "videos"
 *   ... plus /videos  /shorts  /streams                 channel, that tab
 *
 * A bare channel address without a tab makes yt-dlp read ALL tabs (uploads, streams and shorts as nested
 * playlists, `_tab.py`: "Downloading all uploads of the channel"). Kura always names exactly one tab, "videos" if
 * none was given, so a channel feed is one flat list.
 *
 * Not accepted: Music, Kids and embed hosts, /embed/ and /v/ addresses, the channel tabs playlists / community /
 * featured / about, search, feeds and hashtags, and playlists that depend on an account or on the moment
 * (watch later WL, liked LL, mixes RD...).
 */
export type YoutubeChannelReference =
  | { readonly type: 'handle'; readonly handle: string }
  | { readonly type: 'channel'; readonly channelId: string }
  | { readonly type: 'custom'; readonly name: string }
  | { readonly type: 'user'; readonly name: string };

export type YoutubeChannelTab = 'videos' | 'shorts' | 'streams';

export type YoutubeTarget =
  | { readonly kind: 'video'; readonly videoId: string }
  | { readonly kind: 'playlist'; readonly playlistId: string }
  | { readonly kind: 'channel'; readonly channel: YoutubeChannelReference; readonly tab: YoutubeChannelTab };

const YOUTUBE_ROOT = 'https://www.youtube.com';
export const YOUTUBE_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const CHANNEL_ID = /^UC[A-Za-z0-9_-]{22}$/;
/** Playlists that exist independently of an account: user playlists (PL), uploads (UU), favourites (FL), albums (OLAK5uy_). */
const PLAYLIST_ID = /^(?:PL|UU|FL|OLAK5uy_)[A-Za-z0-9_-]{10,60}$/;
const HANDLE = /^[\p{L}\p{N}._-]{1,100}$/u;
const LEGACY_NAME = /^[\p{L}\p{N}._ -]{1,100}$/u;
const TABS: ReadonlySet<string> = new Set(['videos', 'shorts', 'streams']);
const SUBPAGES_THAT_ARE_NOT_FEEDS: ReadonlySet<string> = new Set([
  'featured', 'playlists', 'community', 'posts', 'about', 'channels', 'store', 'search', 'membership', 'courses', 'podcasts', 'releases', 'live'
]);
const OTHER_PAGES: ReadonlySet<string> = new Set([
  'feed', 'hashtag', 'results', 'search', 'trending', 'explore', 'embed', 'v', 'e', 'clip', 'movies', 'shared', 'oembed',
  'account', 'signin', 'logout', 'upload', 'about', 'browse', 'premium', 'gaming', 'kids', 'music', 'tv', 'howyoutubeworks'
]);

const NOT_SUPPORTED = 'zurzeit nicht unterstützt';
const TEXT = {
  other: `Diese YouTube-Adresse ist ${NOT_SUPPORTED}. Unterstützt sind einzelne Videos (watch?v=, youtu.be/, /shorts/, /live/), Playlists (playlist?list=) und Kanäle (/@name, /channel/, /c/, /user/ sowie die Reiter Videos, Shorts und Livestreams).`,
  channelSubpage: `Dieser Reiter eines YouTube-Kanals ist ${NOT_SUPPORTED}. Unterstützt sind die Reiter Videos, Shorts und Livestreams (zum Beispiel youtube.com/@name/videos).`,
  accountPlaylist: `Diese Playlist hängt von einem Konto oder vom Moment ab (Später ansehen, Videos mit "Gefällt mir", Mix) und ist ${NOT_SUPPORTED}. Unterstützt sind eigene und öffentliche Playlists mit einer Kennung, die mit PL, UU, FL oder OLAK5uy_ beginnt.`,
  invalidVideo: 'Die Kennung des YouTube-Videos ist ungültig. Sie besteht aus genau 11 Zeichen (Buchstaben, Ziffern, Bindestrich, Unterstrich).',
  invalidPlaylist: 'Die Kennung der YouTube-Playlist ist ungültig. Sie beginnt mit PL, UU, FL oder OLAK5uy_ und ist mindestens 12 Zeichen lang.',
  invalidChannel: 'Der Name oder die Kennung des YouTube-Kanals ist ungültig. Erlaubt sind /@name, /channel/UC... (24 Zeichen), /c/name und /user/name.',
  deeperPath: 'Diese YouTube-Adresse hat zusätzliche Pfadteile, die Kura nicht kennt. Verwenden Sie zum Beispiel youtube.com/@name/videos für einen Kanal.'
} as const;

function unsupported(detail: string, userMessage: string): AdapterError {
  return new AdapterError('TARGET_UNSUPPORTED', detail, undefined, userMessage);
}

function invalid(detail: string, userMessage: string): AdapterError {
  return new AdapterError('TARGET_INVALID', detail, undefined, userMessage);
}

function checkedVideo(videoId: string | null | undefined): YoutubeTarget {
  if (!videoId || !YOUTUBE_VIDEO_ID.test(videoId)) throw invalid('YouTube video id has an unexpected format', TEXT.invalidVideo);
  return { kind: 'video', videoId };
}

function checkedPlaylist(playlistId: string): YoutubeTarget {
  if (/^(?:RD|WL|LL|LM|TL|UL|PU|EC)/.test(playlistId)) {
    throw unsupported('This kind of YouTube playlist depends on an account or on the moment', TEXT.accountPlaylist);
  }
  if (!PLAYLIST_ID.test(playlistId)) throw invalid('YouTube playlist id has an unexpected format', TEXT.invalidPlaylist);
  return { kind: 'playlist', playlistId };
}

function decoded(segment: string): string | undefined {
  try {
    return decodeURIComponent(segment);
  } catch {
    return undefined;
  }
}

function channelTab(rest: readonly string[]): YoutubeChannelTab {
  if (rest.length === 0) return 'videos';
  const tab = rest[0]!.toLowerCase();
  if (rest.length > 1) throw unsupported('YouTube channel address has extra path segments', TEXT.deeperPath);
  if (TABS.has(tab)) return tab as YoutubeChannelTab;
  if (SUBPAGES_THAT_ARE_NOT_FEEDS.has(tab)) throw unsupported('This YouTube channel tab is not supported', TEXT.channelSubpage);
  throw unsupported('Unknown YouTube channel sub-page', TEXT.channelSubpage);
}

/**
 * Classifies a youtube.com / youtu.be address. `host` is the lower-case host name; `segments` are the non-empty path
 * segments (still percent-encoded); `query` is the parsed query string.
 */
export function parseYoutubeUrl(host: string, segments: readonly string[], query: URLSearchParams): YoutubeTarget {
  const [first, second, ...rest] = segments;

  if (host === 'youtu.be') {
    if (segments.length !== 1) throw unsupported('youtu.be address has extra path segments', TEXT.other);
    return checkedVideo(first);
  }

  if (first === undefined) throw unsupported('The YouTube home page is not a target', TEXT.other);

  if (first === 'watch') {
    if (segments.length !== 1) throw unsupported('watch address has extra path segments', TEXT.deeperPath);
    // A watch address with both v= and list= is the video: playlists are chosen explicitly with playlist?list=.
    if (query.has('v')) return checkedVideo(query.get('v'));
    const listId = query.get('list');
    if (listId) return checkedPlaylist(listId);
    throw invalid('watch address without v or list', TEXT.invalidVideo);
  }
  if (first === 'shorts' || first === 'live') {
    if (segments.length !== 2) throw unsupported(`${first} address has extra path segments`, TEXT.deeperPath);
    return checkedVideo(second);
  }
  if (first === 'playlist') {
    if (segments.length !== 1) throw unsupported('playlist address has extra path segments', TEXT.deeperPath);
    const listId = query.get('list');
    if (!listId) throw invalid('playlist address without list', TEXT.invalidPlaylist);
    return checkedPlaylist(listId);
  }

  if (first === 'channel') {
    if (second === undefined || !CHANNEL_ID.test(second)) throw invalid('YouTube channel id has an unexpected format', TEXT.invalidChannel);
    return { kind: 'channel', channel: { type: 'channel', channelId: second }, tab: channelTab(rest) };
  }
  if (first === 'c' || first === 'user') {
    const name = second === undefined ? undefined : decoded(second);
    if (name === undefined || !LEGACY_NAME.test(name) || name.startsWith(' ') || name.endsWith(' ')) {
      throw invalid('YouTube channel name has an unexpected format', TEXT.invalidChannel);
    }
    return { kind: 'channel', channel: { type: first === 'c' ? 'custom' : 'user', name }, tab: channelTab(rest) };
  }
  if (first.startsWith('@') || first.toLowerCase().startsWith('%40')) {
    const handle = decoded(first)?.slice(1);
    if (handle === undefined || !HANDLE.test(handle)) throw invalid('YouTube handle has an unexpected format', TEXT.invalidChannel);
    return { kind: 'channel', channel: { type: 'handle', handle }, tab: channelTab(segments.slice(1)) };
  }
  if (OTHER_PAGES.has(first.toLowerCase())) throw unsupported('This YouTube page is not a video, playlist or channel', TEXT.other);
  throw unsupported('This YouTube address is not recognised', TEXT.other);
}

/** The URL Kura stores, shows and hands to the tool for a target. */
export function canonicalYoutubeUrl(target: YoutubeTarget): string {
  switch (target.kind) {
    case 'video':
      return `${YOUTUBE_ROOT}/watch?v=${target.videoId}`;
    case 'playlist':
      return `${YOUTUBE_ROOT}/playlist?list=${target.playlistId}`;
    case 'channel': {
      const { channel } = target;
      const base = channel.type === 'handle' ? `@${encodeURIComponent(channel.handle)}`
        : channel.type === 'channel' ? `channel/${channel.channelId}`
          : channel.type === 'custom' ? `c/${encodeURIComponent(channel.name)}`
            : `user/${encodeURIComponent(channel.name)}`;
      return `${YOUTUBE_ROOT}/${base}/${target.tab}`;
    }
  }
}

/** The platform id Kura stores for a target: the video id, the playlist id, or the channel reference with its tab. */
export function youtubePlatformId(target: YoutubeTarget): string {
  switch (target.kind) {
    case 'video':
      return target.videoId;
    case 'playlist':
      return target.playlistId;
    case 'channel': {
      const { channel } = target;
      const name = channel.type === 'handle' ? `@${channel.handle}` : channel.type === 'channel' ? channel.channelId : `${channel.type}/${channel.name}`;
      return `${name}/${target.tab}`;
    }
  }
}
