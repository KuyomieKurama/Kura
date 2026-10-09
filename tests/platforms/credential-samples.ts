import type { FastifyInstance } from 'fastify';
import { cookieFile, cookieLine } from '../instagram/cookie-samples.js';
import type { CredentialLogin } from '../instagram/credentials-fixture.js';

/** Obviously made-up values for the P1 credential tests. No real cookie or token appears anywhere in the repository. */
export const FAKE_PATREON_SESSION = 'FAKE-PATREON-SESSION-ID-for-tests-only';
export const FAKE_PATREON_OTHER = 'FAKE-PATREON-DEVICE-ID-for-tests-only';
export const FAKE_YOUTUBE_LOGIN = 'FAKE-YOUTUBE-LOGIN-INFO-for-tests-only';
export const FAKE_YOUTUBE_SAPISID = 'FAKE-YOUTUBE-SAPISID-for-tests-only';
export const FAKE_GOOGLE_VALUE = 'FAKE-GOOGLE-COOKIE-for-tests-only';
/** 43 characters from the alphabet of a real refresh token, but made up. */
export const FAKE_PIXIV_TOKEN = 'FAKE-pixiv_refresh-token-for-tests-ONLY-0123';
export const FAKE_FOREIGN = 'FAKE-FOREIGN-SITE-VALUE-must-be-dropped';

export function patreonCookieFile(): string {
  return cookieFile(
    cookieLine('.patreon.com', 'session_id', FAKE_PATREON_SESSION, 1_900_000_000, { httpOnly: true }),
    cookieLine('.patreon.com', 'device_id', FAKE_PATREON_OTHER, 1_850_000_000),
    cookieLine('.example.org', 'othersite', FAKE_FOREIGN),
    cookieLine('.notpatreon.com', 'lookalike', FAKE_FOREIGN),
    cookieLine('patreon.com.example.org', 'lookalike2', FAKE_FOREIGN)
  );
}

export function youtubeCookieFile(): string {
  return cookieFile(
    cookieLine('.youtube.com', 'LOGIN_INFO', FAKE_YOUTUBE_LOGIN, 1_900_000_000, { httpOnly: true }),
    cookieLine('.youtube.com', 'SAPISID', FAKE_YOUTUBE_SAPISID, 1_900_000_000),
    cookieLine('.google.com', 'NID', FAKE_GOOGLE_VALUE, 1_800_000_000),
    cookieLine('.example.org', 'othersite', FAKE_FOREIGN)
  );
}

/** PUT of a text body to the credential route of one platform. */
export function putCredential(
  app: FastifyInstance,
  login: CredentialLogin | null,
  platform: string,
  text: string,
  contentType = 'text/plain; charset=utf-8'
) {
  return app.inject({
    method: 'PUT',
    url: `/api/v1/credentials/${platform}`,
    headers: { ...credentialHeaders(login), 'content-type': contentType },
    payload: text
  });
}

export function callCredential(app: FastifyInstance, login: CredentialLogin | null, method: 'GET' | 'DELETE', url: string) {
  return app.inject({ method, url, headers: credentialHeaders(login) });
}

function credentialHeaders(login: CredentialLogin | null): Record<string, string> {
  return login
    ? { cookie: login.cookie, 'x-kura-csrf': login.csrf, origin: 'http://localhost', host: 'localhost' }
    : { origin: 'http://localhost', host: 'localhost' };
}
