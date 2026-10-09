/**
 * Validation of the logins a user uploads (IG-B, P1): a Netscape cookies.txt per platform or a Pixiv refresh token.
 *
 * Only cookies of the platform's own domains survive. Everything else in the file, such as cookies of other sites
 * exported by a browser extension, is dropped here and never stored. The stored text is rebuilt from the kept
 * cookies, so nothing of the original file (comments, foreign lines) is kept.
 *
 * The required cookie of each platform is the one the tool really checks (see the P1 report, section
 * "gallery-dl und yt-dlp: Belege"): Instagram `sessionid`, Patreon `session_id`, YouTube `LOGIN_INFO` plus one of the
 * `*APISID` cookies.
 */
import type { CredentialPlatform } from '@kura/adapters';

/** Upload size cap in bytes. */
export const MAX_COOKIE_FILE_BYTES = 256 * 1024;
/** A refresh token is about 43 characters; one kilobyte leaves room for a pasted line break or two. */
export const MAX_TOKEN_BYTES = 1024;

const NETSCAPE_HEADER = '# Netscape HTTP Cookie File';
const HTTP_ONLY_PREFIX = '#HttpOnly_';

export type CookieFileProblem =
  | 'EMPTY'
  | 'NOT_NETSCAPE'
  | 'NO_PLATFORM_COOKIES'
  | 'NO_SESSION_COOKIE'
  | 'SESSION_COOKIE_EXPIRED'
  | 'TOKEN_FORMAT';

/** The upload cannot be used. `userMessage` is a fixed German sentence without any uploaded content. */
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

/** What a platform needs in its cookie file. */
interface CookieRules {
  /** Name in the German messages. */
  label: string;
  /** Written as in the message "Die Datei enthält keine Cookies für <siteText>." */
  siteText: string;
  /** Domains whose cookies (and those of their real subdomains) are kept. */
  domains: readonly string[];
  /** The cookie names that make the session, and the host rule they must satisfy. */
  session: SessionRule;
  /** Optional rewrite of a kept cookie, for a spelling the tool would not recognise. */
  normalize?: (cookie: CookieLine) => CookieLine;
}

interface SessionRule {
  /** Every group must be satisfied by at least one non-empty cookie: [names that count, host rule]. */
  groups: readonly { names: readonly string[]; host: (host: string) => boolean; label: string }[];
  missingMessage: string;
  expiredMessage: string;
}

function hostIsOrUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

const COOKIE_RULES: Readonly<Record<Exclude<CredentialPlatform, 'pixiv'>, CookieRules>> = {
  instagram: {
    label: 'Instagram',
    siteText: 'instagram.com',
    domains: ['instagram.com'],
    session: {
      // gallery-dl checks `sessionid` (extractor/instagram.py); the cookie must be set for instagram.com itself.
      groups: [{ names: ['sessionid'], host: (host) => host === 'instagram.com', label: 'sessionid' }],
      missingMessage: 'Die Datei enthält kein Cookie "sessionid" für instagram.com. Melde dich im Browser bei Instagram an und exportiere die Cookies danach erneut.',
      expiredMessage: 'Das Cookie "sessionid" in der Datei ist bereits abgelaufen. Melde dich im Browser neu an und exportiere die Cookies erneut.'
    }
  },
  patreon: {
    label: 'Patreon',
    siteText: 'patreon.com',
    domains: ['patreon.com'],
    session: {
      // gallery-dl checks `session_id` for the domain ".patreon.com" or a subdomain (extractor/patreon.py _init).
      groups: [{ names: ['session_id'], host: (host) => hostIsOrUnder(host, 'patreon.com'), label: 'session_id' }],
      missingMessage: 'Die Datei enthält kein Cookie "session_id" für patreon.com. Melde dich im Browser bei Patreon an und exportiere die Cookies danach erneut.',
      expiredMessage: 'Das Cookie "session_id" in der Datei ist bereits abgelaufen. Melde dich im Browser neu bei Patreon an und exportiere die Cookies erneut.'
    },
    // gallery-dl compares the cookie's domain with ".patreon.com" or a name ending in ".patreon.com"; a cookie
    // written for the bare "patreon.com" is not recognised. It is stored for ".patreon.com" instead.
    normalize: (cookie) => cookie.name === 'session_id' && cookie.domain === 'patreon.com'
      ? { ...cookie, domain: '.patreon.com', host: 'patreon.com', includeSubdomains: 'TRUE' }
      : cookie
  },
  youtube: {
    label: 'YouTube',
    siteText: 'youtube.com oder google.com',
    domains: ['youtube.com', 'google.com'],
    session: {
      // yt-dlp counts the account as logged in with LOGIN_INFO plus one of the APISID cookies
      // (extractor/youtube/_base.py _has_auth_cookies), read for www.youtube.com.
      groups: [
        { names: ['LOGIN_INFO'], host: (host) => hostIsOrUnder(host, 'youtube.com'), label: 'LOGIN_INFO' },
        { names: ['SAPISID', '__Secure-1PAPISID', '__Secure-3PAPISID'], host: (host) => hostIsOrUnder(host, 'youtube.com'), label: 'SAPISID' }
      ],
      missingMessage: 'Die Datei enthält nicht die Anmelde-Cookies von youtube.com (LOGIN_INFO und SAPISID). Melde dich im Browser bei YouTube an und exportiere die Cookies danach erneut.',
      expiredMessage: 'Die Anmelde-Cookies von YouTube in der Datei sind bereits abgelaufen. Melde dich im Browser neu an und exportiere die Cookies erneut.'
    }
  }
};

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

/** Reads a cookies.txt for one platform and keeps what that platform's tool needs. Throws CookieFileError. */
export function parseCookieFile(platform: Exclude<CredentialPlatform, 'pixiv'>, content: string, now: Date): ParsedCookies {
  const rules = COOKIE_RULES[platform];
  if (content.trim() === '') throw new CookieFileError('EMPTY', 'Die Datei ist leer.');
  if (content.includes('\u0000')) throw notNetscape('enthält Binärdaten');

  const cookies: CookieLine[] = [];
  content.split('\n').forEach((raw, index) => {
    const parsed = parseLine(raw, index + 1);
    if (parsed) cookies.push(parsed);
  });
  if (cookies.length === 0) throw notNetscape('keine Cookie-Zeilen gefunden');

  const kept = cookies
    .filter((cookie) => rules.domains.some((domain) => hostIsOrUnder(cookie.host, domain)))
    .map((cookie) => rules.normalize?.(cookie) ?? cookie);
  if (kept.length === 0) {
    throw new CookieFileError('NO_PLATFORM_COOKIES', `Die Datei enthält keine Cookies für ${rules.siteText}.`);
  }

  const nowSeconds = Math.floor(now.getTime() / 1000);
  let expiredGroup = false;
  for (const group of rules.session.groups) {
    const candidates = kept.filter((cookie) => group.names.includes(cookie.name) && group.host(cookie.host) && cookie.value !== '');
    if (candidates.length === 0) throw new CookieFileError('NO_SESSION_COOKIE', rules.session.missingMessage);
    if (candidates.every((cookie) => cookie.expires !== 0 && cookie.expires <= nowSeconds)) expiredGroup = true;
  }
  if (expiredGroup) throw new CookieFileError('SESSION_COOKIE_EXPIRED', rules.session.expiredMessage);

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

/**
 * The Pixiv refresh token as `gallery-dl oauth:pixiv` prints it: a single word of letters, digits, "-" and "_"
 * (about 43 characters). Surrounding white space is removed. Anything else, in particular a pasted configuration
 * line, a quoted value or several words, is refused, so that only the secret itself ends up in the config file.
 */
export function parseRefreshToken(content: string): string {
  const token = content.trim();
  if (token === '') throw new CookieFileError('EMPTY', 'Das Feld ist leer.');
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
    throw new CookieFileError(
      'TOKEN_FORMAT',
      'Das ist kein Pixiv-Token. Erwartet wird nur der Wert, den "gallery-dl oauth:pixiv" nach "Your \'refresh-token\' is" ausgibt: ein Wort aus Buchstaben, Ziffern, Bindestrich und Unterstrich, ohne Anführungszeichen und ohne "refresh-token".'
    );
  }
  return token;
}
