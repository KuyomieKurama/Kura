import { AdapterError } from './errors.js';

/**
 * The address grammar of Patreon targets for the gallery-dl adapter. Only the host and the path matter: query
 * strings (`?filters[...]`, `?sort=`, `?u=`) and fragments are dropped, and the canonical URL is rebuilt from the
 * parsed parts, never from the raw input.
 *
 * What gallery-dl 1.32.16 accepts (extractor/patreon.py), and what Kura accepts of it:
 *
 *   /<creator>                      creator, newest posts   (PatreonCreatorExtractor)
 *   /<creator>/posts                same
 *   /c/<creator>  /c/<creator>/posts     same
 *   /cw/<creator> /cw/<creator>/posts    same ("cw?/" in the pattern)
 *   /posts/<slug>-<id>  /posts/<id>      single post   (PatreonPostExtractor)
 *   /<creator>/posts/<slug>-<id>         single post, canonicalised without the creator
 *
 * Not accepted although gallery-dl would run them: /home (the user's whole feed), /collection/<id>,
 * /profile/creators?u=<id> and /user?u=<id> (need the query), /id:<campaign> (a campaign id instead of a name),
 * and /c/<creator>/posts/<id>: for that address gallery-dl's creator pattern matches the prefix and would read the
 * whole creator instead of the one post.
 */
export type PatreonTarget =
  | { readonly kind: 'creator'; readonly slug: string }
  | { readonly kind: 'post'; readonly slugAndId: string; readonly postId: string };

const PATREON_ROOT = 'https://www.patreon.com';
/** Vanity names are letters, digits, underscore, hyphen; a dot is allowed by Patreon for older pages. */
const CREATOR_SLUG = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;
const POST_SLUG = /^(?:[A-Za-z0-9_-]{0,120}-)?(\d{1,12})$/;

/**
 * First path segments that are Patreon pages and never a creator. The first seven are the ones gallery-dl's own
 * creator pattern excludes; the rest are pages of patreon.com that cannot be a creator name.
 */
export const PATREON_RESERVED_PATHS: ReadonlySet<string> = new Set([
  'home', 'create', 'login', 'signup', 'search', 'posts', 'messages',
  'settings', 'about', 'pricing', 'explore', 'policy', 'legal', 'apps', 'jobs', 'press', 'product', 'user', 'profile',
  'collection', 'c', 'cw', 'api', 'oauth2', 'bePatron', 'become-a-patron', 'checkout', 'notifications', 'help', 'blog',
  'creators', 'learn', 'careers', 'store', 'shop', 'membership', 'download', 'community-guidelines', 'brand', 'faq'
]);

const NOT_SUPPORTED_YET = 'zurzeit nicht unterstützt';
const UNSUPPORTED_TEXT = {
  home: `Die Startseite von Patreon und die Übersicht aller unterstützten Creator sind ${NOT_SUPPORTED_YET}. Verwenden Sie die Adresse eines Creators (patreon.com/name) oder eines einzelnen Beitrags (patreon.com/posts/...).`,
  collection: `Patreon-Sammlungen sind ${NOT_SUPPORTED_YET}. Unterstützt sind die Beiträge eines Creators (patreon.com/name) und einzelne Beiträge (patreon.com/posts/...).`,
  reserved: 'Diese Patreon-Adresse ist kein Creator und kein Beitrag. Unterstützt sind Creator (patreon.com/name) und einzelne Beiträge (patreon.com/posts/...).',
  creatorSubpage: `Diese Unterseite eines Patreon-Creators ist ${NOT_SUPPORTED_YET}. Unterstützt sind alle Beiträge eines Creators (patreon.com/name) und einzelne Beiträge (patreon.com/posts/...).`,
  deeperPath: 'Diese Patreon-Adresse hat zusätzliche Pfadteile, die Kura nicht kennt. Verwenden Sie die Adresse in der Form patreon.com/posts/titel-123456 für einen einzelnen Beitrag oder patreon.com/name für einen Creator.',
  campaignId: 'Patreon-Adressen mit einer Kampagnen-Kennung (id:...) werden nicht angenommen. Verwenden Sie die Adresse mit dem Namen des Creators (patreon.com/name).'
} as const;
const INVALID_CREATOR_TEXT = 'Der Patreon-Name ist ungültig. Erlaubt sind 1 bis 64 Zeichen: Buchstaben, Ziffern, Punkt, Bindestrich und Unterstrich.';
const INVALID_POST_TEXT = 'Die Kennung des Patreon-Beitrags ist ungültig. Die Adresse muss auf eine Zahl enden, zum Beispiel patreon.com/posts/titel-123456.';

function unsupported(reason: keyof typeof UNSUPPORTED_TEXT, detail: string): AdapterError {
  return new AdapterError('TARGET_UNSUPPORTED', detail, undefined, UNSUPPORTED_TEXT[reason]);
}

function invalid(detail: string, userMessage: string): AdapterError {
  return new AdapterError('TARGET_INVALID', detail, undefined, userMessage);
}

function checkedPost(slugAndId: string): PatreonTarget {
  const match = POST_SLUG.exec(slugAndId);
  if (!match) throw invalid('Patreon post slug has an unexpected format', INVALID_POST_TEXT);
  return { kind: 'post', slugAndId, postId: match[1]! };
}

function checkedCreator(slug: string): PatreonTarget {
  if (slug.startsWith('id:')) throw unsupported('campaignId', 'Patreon campaign ids are not accepted');
  if (!CREATOR_SLUG.test(slug)) throw invalid('Patreon creator name has an unexpected format', INVALID_CREATOR_TEXT);
  return { kind: 'creator', slug };
}

/** Classifies the path segments of a patreon.com URL; throws TARGET_UNSUPPORTED or TARGET_INVALID. */
export function parsePatreonPath(segments: readonly string[]): PatreonTarget {
  const [first, second, third] = segments;
  if (first === undefined) throw unsupported('home', 'The Patreon home page is not a target');

  if (first === 'posts') {
    if (second === undefined || segments.length !== 2) throw unsupported('deeperPath', 'Patreon post URL has extra path segments');
    return checkedPost(second);
  }
  if (first === 'home') throw unsupported('home', 'The Patreon feed is not a target');
  if (first === 'collection') throw unsupported('collection', 'Patreon collections are not supported');

  // /c/<creator>[/posts] and /cw/<creator>[/posts]
  if (first === 'c' || first === 'cw') {
    if (second === undefined) throw unsupported('reserved', 'This Patreon path is not a creator');
    if (segments.length === 2 || (segments.length === 3 && third === 'posts')) return checkedCreator(second);
    if (third === 'posts') throw unsupported('deeperPath', 'Patreon post URL under /c/ has extra path segments');
    throw unsupported('creatorSubpage', 'This Patreon creator sub-page is not supported');
  }

  if (PATREON_RESERVED_PATHS.has(first) || PATREON_RESERVED_PATHS.has(first.toLowerCase())) {
    throw unsupported('reserved', 'This Patreon path is not a creator');
  }

  const creator = checkedCreator(first);
  if (second === undefined) return creator;
  if (second === 'posts') {
    if (third === undefined) return creator;
    if (segments.length === 3) return checkedPost(third);
    throw unsupported('deeperPath', 'Patreon post URL has extra path segments');
  }
  throw unsupported('creatorSubpage', 'This Patreon creator sub-page is not supported');
}

/** The URL Kura stores and shows for a target (also the one handed to the tool). */
export function canonicalPatreonUrl(target: PatreonTarget): string {
  return target.kind === 'post'
    ? `${PATREON_ROOT}/posts/${target.slugAndId}`
    : `${PATREON_ROOT}/c/${target.slug}/posts`;
}
