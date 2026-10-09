import { AdapterError } from './errors.js';

/**
 * The address grammar of Instagram targets for the gallery-dl adapter. Only the host and the path matter:
 * query strings (igsh, utm_*, img_index ...) and fragments are dropped, and the canonical URL is rebuilt
 * from the parsed parts, never from the raw input.
 *
 *   /<username>/                    profile (posts and reels in the main grid)
 *   /<username>/reels/              profile, "reels" tab only
 *   /p/<shortcode>/                 single post (photo or carousel)
 *   /reel/<shortcode>/              single reel
 *   /reels/<shortcode>/             single reel (alternative path)
 *   /<username>/p/<shortcode>/      single post, canonicalised without the username
 *   /<username>/reel/<shortcode>/   single reel, canonicalised without the username
 */
export type InstagramTarget =
  | { readonly kind: 'profile'; readonly username: string; readonly scope: 'all' | 'reels' }
  | { readonly kind: 'post'; readonly shortcode: string; readonly postType: 'p' | 'reel' };

const INSTAGRAM_ROOT = 'https://www.instagram.com';
const USERNAME = /^[A-Za-z0-9._]{1,30}$/;
/**
 * Real shortcodes are 11 characters. gallery-dl cuts everything beyond 28 characters off a shortcode
 * (InstagramAPI.media), so a longer one would come back as a different post: not accepted.
 */
export const INSTAGRAM_SHORTCODE = /^[A-Za-z0-9_-]{5,28}$/;

/**
 * First path segments that are Instagram pages and never a username. A request for one of them is refused
 * with its own message instead of being sent to the tool as a "profile" of that name.
 */
export const INSTAGRAM_RESERVED_PATHS: ReadonlySet<string> = new Set([
  'p', 'reel', 'reels', 'tv', 'explore', 'accounts', 'stories', 'direct', 'about', 'legal', 'developer', 'developers',
  'web', 'api', 'graphql', 'challenge', 'emails', 'privacy', 'terms', 'directory', 'session', 'oauth', 'static',
  'lite', 'help', 'press', 'business', 'creators', 'download', 'nametag', 'ar', 'archive', 'fragments', 'reality',
  'your_activity', 'settings', 'login', 'logout', 'signup', 'share', 'locations', 'topics'
]);

// Fixed German sentences. They are shown to the user by the API, so they contain nothing from the input.
const NOT_SUPPORTED_YET = 'zurzeit nicht unterstützt';
const UNSUPPORTED_TEXT = {
  home: 'Die Startseite von Instagram ist kein Ziel. Verwenden Sie die Adresse eines Profils (instagram.com/benutzername), eines Beitrags (/p/…) oder eines Reels (/reel/…).',
  stories: `Instagram-Stories sind ${NOT_SUPPORTED_YET}. Unterstützt sind Profile, einzelne Beiträge (Fotos, Karussells) und einzelne Reels.`,
  highlights: `Instagram-Highlights sind ${NOT_SUPPORTED_YET}. Unterstützt sind Profile, einzelne Beiträge (Fotos, Karussells) und einzelne Reels.`,
  tagged: `Markierte Beiträge eines Profils sind ${NOT_SUPPORTED_YET}. Unterstützt sind Profile, einzelne Beiträge (Fotos, Karussells) und einzelne Reels.`,
  igtv: `IGTV-Adressen (/tv/…) sind ${NOT_SUPPORTED_YET}. Verwenden Sie die Beitrags- oder Reel-Adresse (/p/… oder /reel/…).`,
  reelsFeed: `Der allgemeine Reels-Feed ist ${NOT_SUPPORTED_YET}. Verwenden Sie die Adresse eines Profils oder eines einzelnen Reels (/reel/…).`,
  reserved: 'Diese Instagram-Adresse ist kein Profil, kein Beitrag und kein Reel. Unterstützt sind Profile (instagram.com/benutzername), einzelne Beiträge (/p/…) und einzelne Reels (/reel/…).',
  profileSubpage: `Diese Unterseite eines Instagram-Profils ist ${NOT_SUPPORTED_YET}. Unterstützt sind das Profil selbst (instagram.com/benutzername), die Reels des Profils (/reels/) sowie einzelne Beiträge und Reels.`,
  deeperPath: 'Diese Instagram-Adresse hat zusätzliche Pfadteile, die Kura nicht kennt. Verwenden Sie die Adresse in der Form instagram.com/p/…/ oder instagram.com/reel/…/.'
} as const;

const INVALID_USERNAME_TEXT = 'Der Instagram-Benutzername ist ungültig. Erlaubt sind 1 bis 30 Zeichen: Buchstaben, Ziffern, Punkt und Unterstrich.';
const INVALID_SHORTCODE_TEXT = 'Die Kennung des Instagram-Beitrags ist ungültig. Erlaubt sind 5 bis 28 Zeichen: Buchstaben, Ziffern, Bindestrich und Unterstrich.';

function unsupported(reason: keyof typeof UNSUPPORTED_TEXT, detail: string): AdapterError {
  return new AdapterError('TARGET_UNSUPPORTED', detail, undefined, UNSUPPORTED_TEXT[reason]);
}

function invalid(detail: string, userMessage: string): AdapterError {
  return new AdapterError('TARGET_INVALID', detail, undefined, userMessage);
}

function checkedShortcode(value: string): string {
  if (!INSTAGRAM_SHORTCODE.test(value)) throw invalid('Instagram post id has an unexpected format', INVALID_SHORTCODE_TEXT);
  return value;
}

function checkedUsername(value: string): string {
  // A name made only of dots would be normalised away by the URL parser ("/../"), so it never reaches a tool.
  if (!USERNAME.test(value) || !/[A-Za-z0-9_]/.test(value)) {
    throw invalid('Instagram username has an unexpected format', INVALID_USERNAME_TEXT);
  }
  return value.toLowerCase();
}

/** Classifies the path segments of an instagram.com URL; throws TARGET_UNSUPPORTED or TARGET_INVALID. */
export function parseInstagramPath(segments: readonly string[]): InstagramTarget {
  const [first, second, third] = segments;
  if (first === undefined) throw unsupported('home', 'Instagram home page is not a target');

  if ((first === 'p' || first === 'reel' || first === 'reels') && second !== undefined) {
    if (segments.length !== 2) throw unsupported('deeperPath', 'Instagram post URL has extra path segments');
    return { kind: 'post', shortcode: checkedShortcode(second), postType: first === 'p' ? 'p' : 'reel' };
  }
  if (first === 'reels') throw unsupported('reelsFeed', 'The Instagram reels feed is not a target');
  if (first === 'tv') throw unsupported('igtv', 'IGTV URLs are not supported');
  if (first === 'stories') {
    throw unsupported(second === 'highlights' ? 'highlights' : 'stories', 'Instagram stories are not supported');
  }
  if (INSTAGRAM_RESERVED_PATHS.has(first.toLowerCase())) throw unsupported('reserved', 'This Instagram path is not a profile');

  const username = checkedUsername(first);
  if (second === undefined) return { kind: 'profile', username, scope: 'all' };

  if ((second === 'p' || second === 'reel') && third !== undefined) {
    if (segments.length !== 3) throw unsupported('deeperPath', 'Instagram post URL has extra path segments');
    return { kind: 'post', shortcode: checkedShortcode(third), postType: second };
  }
  if (second === 'reels' && segments.length === 2) return { kind: 'profile', username, scope: 'reels' };
  if (second === 'stories') throw unsupported('stories', 'Instagram stories are not supported');
  if (second === 'highlights') throw unsupported('highlights', 'Instagram highlights are not supported');
  if (second === 'tagged') throw unsupported('tagged', 'Tagged posts are not supported');
  throw unsupported('profileSubpage', 'This Instagram profile sub-page is not supported');
}

/** The URL Kura stores and shows for a target. */
export function canonicalInstagramUrl(target: InstagramTarget): string {
  if (target.kind === 'post') return `${INSTAGRAM_ROOT}/${target.postType}/${target.shortcode}/`;
  return target.scope === 'reels' ? `${INSTAGRAM_ROOT}/${target.username}/reels/` : `${INSTAGRAM_ROOT}/${target.username}/`;
}

/**
 * The URL handed to gallery-dl. For a whole profile this is the explicit /posts/ page: the bare profile URL
 * is a dispatcher that, depending on the user's configuration, would also fetch info, avatar, stories and
 * highlights (extractor.instagram.include, source: gallery_dl/extractor/instagram.py).
 */
export function instagramToolUrl(target: InstagramTarget): string {
  if (target.kind === 'profile' && target.scope === 'all') return `${INSTAGRAM_ROOT}/${target.username}/posts/`;
  return canonicalInstagramUrl(target);
}
