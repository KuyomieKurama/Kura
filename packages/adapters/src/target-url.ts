import { AdapterError } from './errors.js';

const MAX_URL_LENGTH = 2_048;

/**
 * Parses user input into a URL object. Whitespace, control characters (so
 * also newlines), backslashes and over-long input are refused before parsing,
 * and only plain https URLs without credentials pass.
 */
export function parseHttpsTarget(input: string): URL {
  // eslint-disable-next-line no-control-regex
  if (typeof input !== 'string' || input.length === 0 || input.length > MAX_URL_LENGTH || /[\u0000-\u0020\u007f\\]/.test(input)) {
    throw new AdapterError('TARGET_INVALID', 'URL is empty, too long or contains whitespace, control characters or backslashes');
  }
  let parsed: URL;
  try {
    parsed = new URL(input);
  } catch {
    throw new AdapterError('TARGET_INVALID', 'URL cannot be parsed');
  }
  assertPlainHttps(parsed);
  parsed.hash = '';
  return parsed;
}

export function assertPlainHttps(url: URL): void {
  if (url.protocol !== 'https:') throw new AdapterError('TARGET_INVALID', 'Only https URLs are supported');
  if (url.username || url.password) throw new AdapterError('TARGET_INVALID', 'URLs with credentials are not supported');
  if (!url.hostname) throw new AdapterError('TARGET_INVALID', 'URL has no host');
}
