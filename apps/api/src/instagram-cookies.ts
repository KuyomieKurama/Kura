/**
 * Validation of an uploaded Netscape-format cookies.txt for Instagram (IG-B).
 *
 * Only cookies for instagram.com and its subdomains survive. Everything else in the file, such as cookies of other
 * sites exported by a browser extension, is dropped here and never stored. The stored text is rebuilt from the
 * kept cookies, so nothing of the original file (comments, foreign lines) is kept.
 */

/** Upload size cap in bytes. */
export const MAX_COOKIE_FILE_BYTES = 256 * 1024;

const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';
const HTTP_ONLY_PREFIX = '#HttpOnly_';

export type CookieFileProblem =
  | 'EMPTY'
  | 'NOT_NETSCAPE'
  | 'NO_INSTAGRAM_COOKIES'
  | 'NO_SESSIONID'
  | 'SESSIONID_EXPIRED';

export class CookieFileError extends Error {
  constructor(readonly problem: CookieFileProblem, readonly userMessage: string) {
    super(problem);
    this.name = 'CookieFileError';
  }
}

export interface ParsedCookies {
  /** Netscape text of the kept cookies, ready to be encrypted. */
  text: string;
  keptCount: number;
  droppedCount: number;
  /** Earliest expiry among kept cookies that expire; null when all are session cookies. */
  earliestExpiry: Date | null;
}

interface CookieLine {
  domain: string;
  /** Domain without the HttpOnly marker, a leading dot and case. */
  host: string;
  httpOnly: boolean;
  includeSubdomains: string;
  path: string;
  secure: string;
  /** Seconds since the epoch; 0 = session cookie. */
  expires: number;
  name: string;
  value: string;
}

function notNetscape(detail: string): CookieFileError {
  return new CookieFileError(
    'NOT_NETSCAPE',
    `Die Datei ist keine gültige cookies.txt im Netscape-Format (${detail}). Jede Zeile braucht sieben durch Tabulatoren getrennte Felder.`
  );
}

function hasControlCharacter(text: string): boolean {
  for (const character of text) {
    const code = character.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

function parseLine(raw: string, lineNumber: number): CookieLine | undefined {
  const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
  if (line.trim() === '') return undefined;

  const httpOnly = line.startsWith(HTTP_ONLY_PREFIX);
  if (line.startsWith('#') && !httpOnly) return undefined; // comment, including the header line

  const fields = (httpOnly ? line.slice(HTTP_ONLY_PREFIX.length) : line).split('\t');
  if (fields.length !== 7) throw notNetscape(`Zeile ${lineNumber}`);
  const [domain, includeSubdomains, path, secure, expiresText, name, value] = fields as [string, string, string, string, string, string, string];

  if (domain === '' || name === '' || !path.startsWith('/')) throw notNetscape(`Zeile ${lineNumber}`);
  if (!['TRUE', 'FALSE'].includes(includeSubdomains.toUpperCase()) || !['TRUE', 'FALSE'].includes(secure.toUpperCase())) {
    throw notNetscape(`Zeile ${lineNumber}`);
  }
  if (!/^\d{1,15}$/.test(expiresText)) throw notNetscape(`Zeile ${lineNumber}`);
  if ([domain, path, name, value].some(hasControlCharacter)) throw notNetscape(`Zeile ${lineNumber}`);

  return {
    domain,
    host: domain.replace(/^\./, '').toLowerCase(),
    httpOnly,
    includeSubdomains: includeSubdomains.toUpperCase(),
    path,
    secure: secure.toUpperCase(),
    expires: Number(expiresText),
    name,
    value
  };
}

/** instagram.com and its real subdomains. Look-alikes such as notinstagram.com or instagram.com.example.org do not match. */
export function isInstagramHost(host: string): boolean {
  return host === 'instagram.com' || host.endsWith('.instagram.com');
}

export function parseInstagramCookies(content: string, now: Date): ParsedCookies {
  if (content.trim() === '') throw new CookieFileError('EMPTY', 'Die Datei ist leer.');
  if (content.includes('\u0000')) throw notNetscape('enthält Binärdaten');

  const cookies: CookieLine[] = [];
  content.split('\n').forEach((raw, index) => {
    const parsed = parseLine(raw, index + 1);
    if (parsed) cookies.push(parsed);
  });
  if (cookies.length === 0) throw notNetscape('keine Cookie-Zeilen gefunden');

  const kept = cookies.filter((cookie) => isInstagramHost(cookie.host));
  if (kept.length === 0) {
    throw new CookieFileError('NO_INSTAGRAM_COOKIES', 'Die Datei enthält keine Cookies für instagram.com.');
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  const sessionCookies = kept.filter((cookie) => cookie.host === 'instagram.com' && cookie.name === 'sessionid' && cookie.value !== '');
  if (sessionCookies.length === 0) {
    throw new CookieFileError(
      'NO_SESSIONID',
      'Die Datei enthält kein Cookie "sessionid" für instagram.com. Melde dich im Browser bei Instagram an und exportiere die Cookies danach erneut.'
    );
  }
  if (sessionCookies.every((cookie) => cookie.expires !== 0 && cookie.expires <= nowSeconds)) {
    throw new CookieFileError(
      'SESSIONID_EXPIRED',
      'Das Cookie "sessionid" in der Datei ist bereits abgelaufen. Melde dich im Browser neu an und exportiere die Cookies erneut.'
    );
  }

  const expiring = kept.filter((cookie) => cookie.expires !== 0).map((cookie) => cookie.expires);
  const lines = kept.map((cookie) => [
    `${cookie.httpOnly ? HTTP_ONLY_PREFIX : ''}${cookie.domain}`,
    cookie.includeSubdomains,
    cookie.path,
    cookie.secure,
    String(cookie.expires),
    cookie.name,
    cookie.value
  ].join('\t'));

  return {
    text: `${NETSCAPE_HEADER}\n${lines.join('\n')}\n`,
    keptCount: kept.length,
    droppedCount: cookies.length - kept.length,
    earliestExpiry: expiring.length === 0 ? null : new Date(Math.min(...expiring) * 1000)
  };
}
