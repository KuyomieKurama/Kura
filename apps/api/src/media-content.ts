/**
 * Pure helpers for serving stored media: which types a browser may render inline, byte ranges, conditional
 * requests and a safe Content-Disposition. Kept free of Fastify so each rule can be tested on its own.
 */

/**
 * Types that browsers render without executing anything. Everything else, including image/svg+xml, text/html and
 * any XML or script type, is only ever sent as an attachment. This is an exact list on purpose: a prefix match
 * on image/* would let SVG through.
 */
const INLINE_MIME_TYPES: ReadonlySet<string> = new Set([
  'image/jpeg',
  'image/png',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'video/mp4',
  'video/webm',
  'video/ogg',
  'video/quicktime',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
  'audio/webm',
  'audio/flac',
  'audio/wav',
  'audio/aac'
]);

const MIME_PATTERN = /^[a-z0-9][a-z0-9!#$&^_.+-]*\/[a-z0-9][a-z0-9!#$&^_.+-]*$/;

export function isInlineMime(mimeType: string): boolean {
  return INLINE_MIME_TYPES.has(mimeType.toLowerCase());
}

/** The stored type for inline-capable media, application/octet-stream for everything else. */
export function contentTypeFor(mimeType: string): string {
  const normalized = mimeType.toLowerCase();
  return MIME_PATTERN.test(normalized) && INLINE_MIME_TYPES.has(normalized) ? normalized : 'application/octet-stream';
}

export type MediaKind = 'image' | 'video' | 'audio' | 'other';

export function mediaKindOf(mimeType: string): MediaKind {
  if (mimeType.startsWith('image/')) return 'image';
  if (mimeType.startsWith('video/')) return 'video';
  if (mimeType.startsWith('audio/')) return 'audio';
  return 'other';
}

export type RangeDecision =
  | { kind: 'full' }
  | { kind: 'partial'; start: number; end: number }
  | { kind: 'unsatisfiable' };

/**
 * Evaluates a Range header for an object of `size` bytes (RFC 9110, section 14).
 * - no header, a unit other than bytes, or several ranges: the whole object is sent (allowed by the RFC)
 * - a malformed, reversed or out-of-bounds single range: 416
 */
export function parseRange(header: string | undefined, size: number): RangeDecision {
  if (header === undefined) return { kind: 'full' };
  const match = /^\s*bytes\s*=\s*(.*)$/i.exec(header);
  if (!match) return { kind: 'full' };
  const specification = match[1]!.trim();
  if (specification.includes(',')) return { kind: 'full' };

  const parts = /^(\d*)-(\d*)$/.exec(specification);
  if (!parts || (parts[1] === '' && parts[2] === '')) return { kind: 'unsatisfiable' };
  if (size === 0) return { kind: 'unsatisfiable' };

  if (parts[1] === '') {
    const suffixLength = Number(parts[2]);
    if (suffixLength === 0) return { kind: 'unsatisfiable' };
    return { kind: 'partial', start: Math.max(size - suffixLength, 0), end: size - 1 };
  }
  const start = Number(parts[1]);
  if (start >= size) return { kind: 'unsatisfiable' };
  if (parts[2] === '') return { kind: 'partial', start, end: size - 1 };
  const requestedEnd = Number(parts[2]);
  if (requestedEnd < start) return { kind: 'unsatisfiable' };
  return { kind: 'partial', start, end: Math.min(requestedEnd, size - 1) };
}

/** If-None-Match with the weak comparison of RFC 9110, section 13.1.2. */
export function etagMatches(header: string | undefined, etag: string): boolean {
  if (header === undefined) return false;
  if (header.trim() === '*') return true;
  const strip = (value: string) => value.trim().replace(/^W\//, '');
  return header.split(',').some((candidate) => strip(candidate) === etag);
}

/** If-Range only allows a partial answer while the validator still matches (strong comparison). */
export function ifRangeAllowsPartial(header: string | undefined, etag: string): boolean {
  return header === undefined || header.trim() === etag;
}

/**
 * Content-Disposition with an ASCII fallback and the full name as RFC 8187 filename*. The name comes from the
 * source platform and is untrusted: control characters (header injection), quotes, path separators and anything
 * outside the fallback alphabet never reach the header unescaped.
 */
export function contentDisposition(disposition: 'inline' | 'attachment', originalName: string): string {
  const withoutControl = [...originalName.normalize('NFC')]
    .filter((character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127)
    .join('');
  const trimmed = withoutControl.replace(/[/\\]/g, '_').trim().slice(0, 200);
  const name = trimmed === '' || /^\.+$/.test(trimmed) ? 'download' : trimmed;
  const fallback = name.replace(/[^A-Za-z0-9._ -]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

/** Headers that every response of the content route carries, whatever the status. */
export const CONTENT_SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Content-Security-Policy': "default-src 'none'; sandbox",
  'Cross-Origin-Resource-Policy': 'same-origin',
  'Cache-Control': 'private, no-cache',
  Vary: 'Cookie'
} as const;
