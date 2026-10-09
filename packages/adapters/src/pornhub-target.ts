import { AdapterError } from './errors.js';

/**
 * The address grammar of Pornhub targets. Videos and video lists go to yt-dlp, photo albums to gallery-dl (the two
 * adapters each accept only their own address types, see yt-dlp-adapter.ts and gallery-dl-adapter.ts). Only host and
 * path (and the `viewkey` of a video page) matter; every other query parameter and the fragment are dropped, and
 * the canonical URL is rebuilt from parsed parts.
 *
 * What yt-dlp 2026.8.19 accepts (extractor/pornhub.py: PornHubIE, PornHubUserIE, PornHubPagedVideoListIE,
 * PornHubUserVideosUploadIE, PornHubPlaylistIE) and what gallery-dl 1.32.16 accepts (extractor/pornhub.py:
 * PornhubGalleryExtractor), and what Kura accepts of both:
 *
 *   /view_video.php?viewkey=<key>              single video                      (yt-dlp)
 *   /model/<name>  /pornstar/<name>            videos of a performer             (yt-dlp, list "videos")
 *   /channels/<name>  /users/<name>            videos of a channel or a user     (yt-dlp, list "videos")
 *   ... plus /videos or /videos/upload         the same, or only the uploads     (yt-dlp)
 *   /playlist/<number>                         a public playlist                 (yt-dlp)
 *   /album/<number>                            one photo album                   (gallery-dl, single post)
 *
 * Not accepted although a tool would run them: categories, searches and the home page; /photo/<id> (gallery-dl has
 * no extractor for single photos); /gif/<id> and the gif and photo lists of a user (the tools accept them, Kura has no
 * rules for them yet); pornhubpremium.com (needs a paid account Kura does not store); the .onion address; the
 * domains .net and .org (yt-dlp knows them, they are not the site this feature was released for).
 */
export type PornhubTarget =
  | { readonly kind: 'video'; readonly viewKey: string }
  | { readonly kind: 'videos'; readonly owner: PornhubOwnerType; readonly name: string; readonly scope: 'all' | 'upload' }
  | { readonly kind: 'playlist'; readonly playlistId: string }
  | { readonly kind: 'album'; readonly albumId: string };

export type PornhubOwnerType = 'model' | 'pornstar' | 'channels' | 'users';

const PORNHUB_ROOT = 'https://www.pornhub.com';
/** Old numeric keys ("648719015") and newer ones ("ph5e4acdae54a82"); lower case letters and digits only. */
export const PORNHUB_VIEW_KEY = /^[0-9a-z]{6,32}$/;
const OWNER_NAME = /^[\p{L}\p{N}._-]{1,100}$/u;
const NUMERIC_ID = /^\d{1,12}$/;
const OWNER_TYPES: ReadonlySet<string> = new Set(['model', 'pornstar', 'channels', 'users']);

const NOT_SUPPORTED = 'zurzeit nicht unterstützt';
const TEXT = {
  other: `Diese Pornhub-Adresse ist ${NOT_SUPPORTED}. Unterstützt sind einzelne Videos (view_video.php?viewkey=), Videolisten von Models, Pornstars, Kanälen und Benutzern, öffentliche Playlists (/playlist/Zahl) und einzelne Fotoalben (/album/Zahl).`,
  premium: `Pornhub Premium ist ${NOT_SUPPORTED}: Kura speichert keine Zugangsdaten dafür. Unterstützt ist pornhub.com ohne Anmeldung.`,
  host: `Diese Pornhub-Domain ist ${NOT_SUPPORTED}. Unterstützt ist pornhub.com.`,
  photo: `Einzelne Fotos (/photo/...) sind ${NOT_SUPPORTED}, weil gallery-dl dafür keinen Abruf hat. Verwenden Sie die Adresse des ganzen Albums (/album/Zahl).`,
  photoList: `Die Foto-Alben und GIFs eines Models oder Benutzers sind ${NOT_SUPPORTED}. Verwenden Sie die Adresse eines einzelnen Albums (/album/Zahl).`,
  gif: `Einzelne GIFs (/gif/...) sind ${NOT_SUPPORTED}. Unterstützt sind Videos und Fotoalben.`,
  invalidKey: 'Die Kennung (viewkey) des Pornhub-Videos ist ungültig. Erlaubt sind Kleinbuchstaben und Ziffern.',
  invalidName: 'Der Name in der Pornhub-Adresse ist ungültig. Erlaubt sind Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.',
  invalidNumber: 'Die Nummer in der Pornhub-Adresse ist ungültig. Sie besteht nur aus Ziffern.',
  deeperPath: 'Diese Pornhub-Adresse hat zusätzliche Pfadteile, die Kura nicht kennt. Verwenden Sie zum Beispiel pornhub.com/model/name/videos.'
} as const;

function unsupported(detail: string, userMessage: string): AdapterError {
  return new AdapterError('TARGET_UNSUPPORTED', detail, undefined, userMessage);
}

function invalid(detail: string, userMessage: string): AdapterError {
  return new AdapterError('TARGET_INVALID', detail, undefined, userMessage);
}

/** True for pornhub.com and its country sub-domains ("de.pornhub.com"); they all show the same site. */
export function isPornhubHost(host: string): boolean {
  return host === 'pornhub.com' || /^(?:www|[a-z]{2})\.pornhub\.com$/.test(host);
}

/**
 * Whether this is a host of the site, in any spelling that Kura knows about, including the ones it refuses (so that
 * the refusal can explain itself).
 */
export function isPornhubFamilyHost(host: string): boolean {
  return /(^|\.)pornhub(?:premium)?\.(?:com|net|org)$/.test(host) || /(^|\.)pornhub[a-z0-9]{20,}\.onion$/.test(host);
}

/** Classifies a Pornhub address; throws TARGET_UNSUPPORTED or TARGET_INVALID. `segments` are the non-empty path segments. */
export function parsePornhubUrl(host: string, segments: readonly string[], query: URLSearchParams): PornhubTarget {
  if (/pornhubpremium\./.test(host)) throw unsupported('Pornhub Premium is not supported', TEXT.premium);
  if (!isPornhubHost(host)) throw unsupported('This Pornhub domain is not supported', TEXT.host);

  const [first, second, third, fourth] = segments;
  if (first === undefined) throw unsupported('The Pornhub home page is not a target', TEXT.other);

  if (first === 'view_video.php') {
    if (segments.length !== 1) throw unsupported('view_video.php address has extra path segments', TEXT.deeperPath);
    const viewKey = query.get('viewkey');
    if (!viewKey || !PORNHUB_VIEW_KEY.test(viewKey)) throw invalid('Pornhub viewkey has an unexpected format', TEXT.invalidKey);
    return { kind: 'video', viewKey };
  }
  if (first === 'playlist') {
    if (second === undefined || segments.length !== 2 || !NUMERIC_ID.test(second)) throw invalid('Pornhub playlist id has an unexpected format', TEXT.invalidNumber);
    return { kind: 'playlist', playlistId: second };
  }
  if (first === 'album') {
    if (second === undefined || segments.length !== 2 || !NUMERIC_ID.test(second)) throw invalid('Pornhub album id has an unexpected format', TEXT.invalidNumber);
    return { kind: 'album', albumId: second };
  }
  if (first === 'photo') throw unsupported('Single Pornhub photos are not supported', TEXT.photo);
  if (first === 'gif') throw unsupported('Single Pornhub gifs are not supported', TEXT.gif);

  if (OWNER_TYPES.has(first)) {
    if (second === undefined || !OWNER_NAME.test(second)) throw invalid('Pornhub name has an unexpected format', TEXT.invalidName);
    const owner = first as PornhubOwnerType;
    if (third === undefined) return { kind: 'videos', owner, name: second, scope: 'all' };
    if (third === 'videos') {
      if (fourth === undefined && segments.length === 3) return { kind: 'videos', owner, name: second, scope: 'all' };
      if (fourth === 'upload' && segments.length === 4) return { kind: 'videos', owner, name: second, scope: 'upload' };
      throw unsupported('This Pornhub video list is not supported', TEXT.deeperPath);
    }
    if (third === 'photos' || third === 'gifs') throw unsupported('Photo and gif lists of a Pornhub user are not supported', TEXT.photoList);
    throw unsupported('This Pornhub sub-page is not supported', TEXT.deeperPath);
  }
  throw unsupported('This Pornhub page is not a video, a video list or an album', TEXT.other);
}

/** The URL Kura stores, shows and hands to the tool for a target. */
export function canonicalPornhubUrl(target: PornhubTarget): string {
  switch (target.kind) {
    case 'video':
      return `${PORNHUB_ROOT}/view_video.php?viewkey=${target.viewKey}`;
    case 'videos':
      return `${PORNHUB_ROOT}/${target.owner}/${encodeURIComponent(target.name)}/videos${target.scope === 'upload' ? '/upload' : ''}`;
    case 'playlist':
      return `${PORNHUB_ROOT}/playlist/${target.playlistId}`;
    case 'album':
      return `${PORNHUB_ROOT}/album/${target.albumId}`;
  }
}

/** The platform id Kura stores for a target. */
export function pornhubPlatformId(target: PornhubTarget): string {
  switch (target.kind) {
    case 'video':
      return target.viewKey;
    case 'videos':
      return `${target.owner}/${target.name}/${target.scope}`;
    case 'playlist':
      return `playlist/${target.playlistId}`;
    case 'album':
      return target.albumId;
  }
}
