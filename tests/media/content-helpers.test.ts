import { describe, expect, it } from 'vitest';
import {
  contentDisposition,
  contentTypeFor,
  etagMatches,
  ifRangeAllowsPartial,
  isInlineMime,
  mediaKindOf,
  parseRange
} from '../../apps/api/src/media-content.js';

describe('inline allowlist', () => {
  it.each(['image/jpeg', 'image/png', 'image/gif', 'image/webp', 'video/mp4', 'video/webm', 'audio/mpeg', 'IMAGE/PNG'])('serves %s inline', (mime) => {
    expect(isInlineMime(mime)).toBe(true);
  });

  it.each([
    'image/svg+xml', 'text/html', 'application/xhtml+xml', 'text/xml', 'application/xml', 'application/javascript',
    'text/javascript', 'application/pdf', 'application/zip', 'video/x-matroska', 'image/svg', 'image/x-icon', ''
  ])('never serves %s inline', (mime) => {
    expect(isInlineMime(mime)).toBe(false);
  });

  it('sends anything outside the list as an opaque download type', () => {
    expect(contentTypeFor('image/png')).toBe('image/png');
    expect(contentTypeFor('image/svg+xml')).toBe('application/octet-stream');
    expect(contentTypeFor('text/html; charset=utf-8')).toBe('application/octet-stream');
    expect(contentTypeFor('not a type')).toBe('application/octet-stream');
  });

  it('derives the media kind from the type', () => {
    expect(mediaKindOf('image/png')).toBe('image');
    expect(mediaKindOf('video/mp4')).toBe('video');
    expect(mediaKindOf('audio/mpeg')).toBe('audio');
    expect(mediaKindOf('application/zip')).toBe('other');
  });
});

describe('parseRange', () => {
  it('sends everything without a usable Range header', () => {
    expect(parseRange(undefined, 100)).toEqual({ kind: 'full' });
    expect(parseRange('items=0-5', 100)).toEqual({ kind: 'full' });
    expect(parseRange('bytes=0-1,5-6', 100)).toEqual({ kind: 'full' });
  });

  it('resolves the three forms of a single range', () => {
    expect(parseRange('bytes=10-19', 100)).toEqual({ kind: 'partial', start: 10, end: 19 });
    expect(parseRange('bytes=90-', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseRange('bytes=-10', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
  });

  it('clamps the end and a suffix that is longer than the object', () => {
    expect(parseRange('bytes=90-500', 100)).toEqual({ kind: 'partial', start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ kind: 'partial', start: 0, end: 99 });
  });

  it.each(['bytes=100-', 'bytes=500-600', 'bytes=5-2', 'bytes=-0', 'bytes=abc', 'bytes=-', 'bytes=1-2-3', 'bytes=99999999999999999999-'])('rejects %s with 416', (header) => {
    expect(parseRange(header, 100)).toEqual({ kind: 'unsatisfiable' });
  });

  it('has no satisfiable range in an empty object', () => {
    expect(parseRange('bytes=0-', 0)).toEqual({ kind: 'unsatisfiable' });
  });
});

describe('conditional requests', () => {
  const etag = '"abc"';
  it('matches If-None-Match with the weak comparison', () => {
    expect(etagMatches('"abc"', etag)).toBe(true);
    expect(etagMatches('W/"abc"', etag)).toBe(true);
    expect(etagMatches('"x", "abc"', etag)).toBe(true);
    expect(etagMatches('*', etag)).toBe(true);
    expect(etagMatches('"other"', etag)).toBe(false);
    expect(etagMatches(undefined, etag)).toBe(false);
  });

  it('allows a partial answer for If-Range only with a matching strong validator', () => {
    expect(ifRangeAllowsPartial(undefined, etag)).toBe(true);
    expect(ifRangeAllowsPartial('"abc"', etag)).toBe(true);
    expect(ifRangeAllowsPartial('"other"', etag)).toBe(false);
    expect(ifRangeAllowsPartial('Wed, 21 Oct 2026 07:28:00 GMT', etag)).toBe(false);
  });
});

describe('contentDisposition', () => {
  it('quotes a plain name and repeats it as filename*', () => {
    expect(contentDisposition('inline', 'photo 1.jpg')).toBe("inline; filename=\"photo 1.jpg\"; filename*=UTF-8''photo%201.jpg");
  });

  it('encodes non-ASCII names and keeps an ASCII fallback', () => {
    const header = contentDisposition('attachment', 'Übergrößé ☃.png');
    expect(header).toBe("attachment; filename=\"_bergr___ _.png\"; filename*=UTF-8''%C3%9Cbergr%C3%B6%C3%9F%C3%A9%20%E2%98%83.png");
    expect(header).toMatch(/^[\x20-\x7e]+$/);
  });

  it('cannot be used for header injection or to break out of the quotes', () => {
    const header = contentDisposition('attachment', 'a";\r\nSet-Cookie: x=1\r\n\r\n<script>.png');
    expect(header).not.toMatch(/[\r\n]/);
    expect(header.match(/filename="([^"]*)"/)?.[1]).toBe('a__Set-Cookie_ x_1_script_.png');
    expect(header.startsWith('attachment; filename="')).toBe(true);
  });

  it('removes path separators and replaces empty names', () => {
    expect(contentDisposition('attachment', '../../etc/passwd')).toContain('filename=".._.._etc_passwd"');
    expect(contentDisposition('attachment', '..')).toContain('filename="download"');
    expect(contentDisposition('attachment', '')).toContain('filename="download"');
    expect(contentDisposition('attachment', "it's (1)*.png")).toContain("filename*=UTF-8''it%27s%20%281%29%2A.png");
  });
});
