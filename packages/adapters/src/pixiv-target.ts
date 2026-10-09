import { AdapterError } from './errors.js';

/**
 * The address grammar of Pixiv targets for the gallery-dl adapter. Only the host and the path matter: query
 * strings and fragments are dropped, a language prefix (`/en/`, `/ja/`, `/zh_tw/` ...) is dropped, and the
 * canonical URL is rebuilt from the parsed parts, never from the raw input.
 *
 *   /artworks/<id>                      single work (illustration, manga or ugoira)
 *   /users/<id>                         all works of an artist (same as /artworks)
 *   /users/<id>/artworks                all works of an artist
 *   /users/<id>/illustrations           illustrations and ugoira of an artist
 *   /users/<id>/manga                   manga of an artist
 *
 * gallery-dl 1.32.16 (extractor/pixiv.py) runs all three user pages with one extractor, PixivArtworksExtractor: it
 * always lists every work type. "illustrations" and "manga" are therefore a filter that Kura adds (see
 * pixivScopeFilter) and a subscription of its own, with its own sync state.
 */
export type PixivScope = 'artworks' | 'illustrations' | 'manga';
export type PixivTarget =
  | { readonly kind: 'user'; readonly userId: string; readonly scope: PixivScope }
  | { readonly kind: 'artwork'; readonly artworkId: string };

const PIXIV_ROOT = 'https://www.pixiv.net';
const NUMERIC_ID = /^\d{1,12}$/;
const LANGUAGE_PREFIX = /^[a-z]{2}([_-][a-z]{2})?$/;

const NOT_SUPPORTED_YET = 'zurzeit nicht unterstützt';
const UNSUPPORTED_TEXT = {
  home: 'Die Startseite von Pixiv ist kein Ziel. Verwenden Sie die Adresse eines Künstlers (pixiv.net/users/12345) oder eines einzelnen Werks (pixiv.net/artworks/12345).',
  tag: `Ein Schlagwort-Filter in der Adresse ist ${NOT_SUPPORTED_YET}. Verwenden Sie die Adresse des Künstlers ohne Schlagwort (pixiv.net/users/12345).`,
  userSubpage: `Diese Unterseite eines Pixiv-Künstlers (zum Beispiel Lesezeichen, Romane oder Follower) ist ${NOT_SUPPORTED_YET}. Unterstützt sind alle Werke eines Künstlers (/users/12345), seine Illustrationen (/illustrations) und sein Manga (/manga) sowie einzelne Werke (/artworks/12345).`,
  other: `Diese Pixiv-Adresse ist ${NOT_SUPPORTED_YET}. Unterstützt sind Künstler (pixiv.net/users/12345) und einzelne Werke (pixiv.net/artworks/12345).`,
  deeperPath: 'Diese Pixiv-Adresse hat zusätzliche Pfadteile, die Kura nicht kennt. Verwenden Sie die Adresse in der Form pixiv.net/artworks/12345.'
} as const;
const INVALID_ID_TEXT = 'Die Kennung in der Pixiv-Adresse ist ungültig. Erwartet wird eine Zahl mit bis zu 12 Stellen.';

function unsupported(reason: keyof typeof UNSUPPORTED_TEXT, detail: string): AdapterError {
  return new AdapterError('TARGET_UNSUPPORTED', detail, undefined, UNSUPPORTED_TEXT[reason]);
}

function checkedId(value: string): string {
  if (!NUMERIC_ID.test(value)) throw new AdapterError('TARGET_INVALID', 'Pixiv id has an unexpected format', undefined, INVALID_ID_TEXT);
  return value;
}

/** Classifies the path segments of a pixiv.net URL; throws TARGET_UNSUPPORTED or TARGET_INVALID. */
export function parsePixivPath(allSegments: readonly string[]): PixivTarget {
  // A language prefix only counts in front of a known first segment, so "/artworks/1" is never read as a language.
  const hasLanguage = allSegments.length > 1 && LANGUAGE_PREFIX.test(allSegments[0]!) && ['artworks', 'users'].includes(allSegments[1]!);
  const segments = hasLanguage ? allSegments.slice(1) : allSegments;
  const [first, second, third, fourth] = segments;
  if (first === undefined) throw unsupported('home', 'The Pixiv home page is not a target');

  if (first === 'artworks') {
    if (second === undefined) throw unsupported('other', 'This Pixiv path is not a work');
    if (second === 'unlisted') throw unsupported('other', 'Unlisted Pixiv works are not supported');
    if (segments.length !== 2) throw unsupported('deeperPath', 'Pixiv artwork URL has extra path segments');
    return { kind: 'artwork', artworkId: checkedId(second) };
  }
  if (first === 'users') {
    if (second === undefined) throw unsupported('other', 'This Pixiv path is not an artist');
    const userId = checkedId(second);
    if (third === undefined) return { kind: 'user', userId, scope: 'artworks' };
    if (third === 'artworks' || third === 'illustrations' || third === 'manga') {
      if (fourth !== undefined) throw unsupported('tag', 'Pixiv tag filters are not supported');
      return { kind: 'user', userId, scope: third };
    }
    throw unsupported('userSubpage', 'This Pixiv artist sub-page is not supported');
  }
  throw unsupported('other', 'This Pixiv path is not supported');
}

/** The URL Kura stores and shows for a target. */
export function canonicalPixivUrl(target: PixivTarget): string {
  return target.kind === 'artwork'
    ? `${PIXIV_ROOT}/artworks/${target.artworkId}`
    : `${PIXIV_ROOT}/users/${target.userId}/${target.scope}`;
}

/**
 * The URL handed to gallery-dl. All three user pages are the same extractor there, so the plain /artworks page is
 * used for every scope; the scope is applied with pixivScopeFilter.
 */
export function pixivToolUrl(target: PixivTarget): string {
  return target.kind === 'artwork' ? canonicalPixivUrl(target) : `${PIXIV_ROOT}/users/${target.userId}/artworks`;
}

/**
 * Value of gallery-dl's `--post-filter` for a scope, or undefined for all works. A fixed string written here: it is
 * evaluated by gallery-dl against the metadata of each work (field `type`: illust, manga or ugoira), and because
 * gallery-dl applies the filter before `--post-range`, the per-run cap counts only the works of the scope.
 */
export function pixivScopeFilter(scope: PixivScope): string | undefined {
  if (scope === 'illustrations') return "type in ('illust', 'ugoira')";
  if (scope === 'manga') return "type == 'manga'";
  return undefined;
}
