/**
 * Allowlisted media types and a magic-number sniffer. Names and headers that
 * come from the network or from a tool are only hints; the bytes decide.
 */

type ContainerFamily = 'jpeg' | 'png' | 'gif' | 'webp' | 'isobmff' | 'ebml' | 'zip' | 'pdf' | 'mp3' | 'ogg' | 'flac' | 'wav';

const MEDIA_TYPE_FAMILIES: Readonly<Record<string, ContainerFamily>> = {
  'image/jpeg': 'jpeg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'isobmff',
  'video/mp4': 'isobmff',
  'video/quicktime': 'isobmff',
  'audio/mp4': 'isobmff',
  'video/webm': 'ebml',
  'video/x-matroska': 'ebml',
  'audio/webm': 'ebml',
  'audio/mpeg': 'mp3',
  'audio/ogg': 'ogg',
  'audio/flac': 'flac',
  'audio/wav': 'wav',
  'application/zip': 'zip',
  'application/pdf': 'pdf'
};

const EXTENSION_MEDIA_TYPES: Readonly<Record<string, string>> = {
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  mp4: 'video/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  m4a: 'audio/mp4',
  webm: 'video/webm',
  mkv: 'video/x-matroska',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  flac: 'audio/flac',
  wav: 'audio/wav',
  // Pixiv ugoira originals are delivered as a zip of frames.
  zip: 'application/zip',
  pdf: 'application/pdf'
};

/** Media type -> preferred file extension (first entry of EXTENSION_MEDIA_TYPES wins). */
const MEDIA_TYPE_EXTENSIONS: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(EXTENSION_MEDIA_TYPES).reverse().map(([extension, mediaType]) => [mediaType, extension])
);

export function isAllowedMediaType(mediaType: string): boolean {
  return Object.hasOwn(MEDIA_TYPE_FAMILIES, mediaType);
}

/** Parses a Content-Type header value and returns the bare lowercase type, or undefined. */
export function parseContentType(header: string | null): string | undefined {
  if (!header) return undefined;
  const bare = header.split(';')[0]!.trim().toLowerCase();
  return /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(bare) ? bare : undefined;
}

export function mediaTypeForExtension(extension: string): string | undefined {
  const key = extension.toLowerCase();
  return Object.hasOwn(EXTENSION_MEDIA_TYPES, key) ? EXTENSION_MEDIA_TYPES[key] : undefined;
}

export function extensionForMediaType(mediaType: string): string | undefined {
  return Object.hasOwn(MEDIA_TYPE_EXTENSIONS, mediaType) ? MEDIA_TYPE_EXTENSIONS[mediaType] : undefined;
}

/** Number of leading bytes sniffMediaFamily() needs. */
export const SNIFF_BYTES = 16;

function startsWith(bytes: Uint8Array, signature: readonly number[], offset = 0): boolean {
  return signature.every((value, index) => bytes[offset + index] === value);
}

function ascii(bytes: Uint8Array, offset: number, length: number): string {
  return String.fromCharCode(...bytes.subarray(offset, offset + length));
}

function sniffFamily(head: Uint8Array): ContainerFamily | undefined {
  if (startsWith(head, [0xff, 0xd8, 0xff])) return 'jpeg';
  if (startsWith(head, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (ascii(head, 0, 4) === 'GIF8') return 'gif';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WEBP') return 'webp';
  if (ascii(head, 0, 4) === 'RIFF' && ascii(head, 8, 4) === 'WAVE') return 'wav';
  if (ascii(head, 4, 4) === 'ftyp') return 'isobmff';
  if (startsWith(head, [0x1a, 0x45, 0xdf, 0xa3])) return 'ebml';
  if (startsWith(head, [0x50, 0x4b, 0x03, 0x04])) return 'zip';
  if (ascii(head, 0, 5) === '%PDF-') return 'pdf';
  if (ascii(head, 0, 3) === 'ID3' || (head[0] === 0xff && ((head[1] ?? 0) & 0xe0) === 0xe0)) return 'mp3';
  if (ascii(head, 0, 4) === 'OggS') return 'ogg';
  if (ascii(head, 0, 4) === 'fLaC') return 'flac';
  return undefined;
}

/** True if the leading bytes are consistent with the claimed media type. */
export function bytesMatchMediaType(head: Uint8Array, mediaType: string): boolean {
  if (!isAllowedMediaType(mediaType)) return false;
  const sniffed = sniffFamily(head);
  return sniffed !== undefined && sniffed === MEDIA_TYPE_FAMILIES[mediaType];
}
