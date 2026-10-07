export type Base64Result =
  | { ok: true; bytes: Buffer }
  | { ok: false; reason: 'invalid' | 'empty' | 'too-large' };

/**
 * Decodes canonical, padded base64. Buffer.from(..., 'base64') never throws and
 * silently skips invalid characters, so the input is validated before decoding
 * and the round trip must reproduce the input exactly.
 */
export function decodeStrictBase64(encoded: string, maxDecodedBytes: number): Base64Result {
  if (encoded.length === 0) return { ok: false, reason: 'empty' };
  if (encoded.length % 4 !== 0) return { ok: false, reason: 'invalid' };
  const maxEncodedLength = Math.ceil(maxDecodedBytes / 3) * 4;
  if (encoded.length > maxEncodedLength) return { ok: false, reason: 'too-large' };
  // A group-based regex overflows the stack on multi-megabyte input; this one is linear.
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) return { ok: false, reason: 'invalid' };
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) return { ok: false, reason: 'invalid' };
  if (bytes.length === 0) return { ok: false, reason: 'empty' };
  if (bytes.length > maxDecodedBytes) return { ok: false, reason: 'too-large' };
  return { ok: true, bytes };
}
