import { afterEach, describe, expect, it } from 'vitest';
import { credentialAad } from '../../packages/adapters/src/index.js';
import { decryptSecret } from '../../apps/api/src/immich-routes.js';
import { cookieFile, cookieLine } from '../instagram/cookie-samples.js';
import { TEST_SECRET_KEY, createCredentialFixture, type CredentialFixture } from '../instagram/credentials-fixture.js';
import {
  FAKE_FOREIGN, FAKE_PATREON_OTHER, FAKE_PATREON_SESSION, FAKE_PIXIV_TOKEN, FAKE_YOUTUBE_LOGIN, FAKE_YOUTUBE_SAPISID,
  callCredential, patreonCookieFile, putCredential, youtubeCookieFile
} from './credential-samples.js';

describe('credentials of Patreon, Pixiv and YouTube per user (API on real PostgreSQL)', () => {
  const open: CredentialFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((fixture) => fixture.cleanup()));
  });
  async function start(options?: { secretKey?: Buffer }): Promise<CredentialFixture> {
    const fixture = await createCredentialFixture(options);
    open.push(fixture);
    return fixture;
  }

  async function storedPlaintext(api: CredentialFixture, userId: string, platform: string): Promise<string> {
    const row = (await api.pool.query('SELECT cookies_ciphertext, cookies_nonce FROM platform_credentials WHERE user_id = $1 AND platform = $2', [userId, platform])).rows[0];
    return decryptSecret(TEST_SECRET_KEY, row.cookies_ciphertext, row.cookies_nonce, credentialAad(platform as 'patreon', userId));
  }

  describe('Patreon cookies', () => {
    it('keeps only patreon.com cookies, requires session_id and never returns content', async () => {
      const api = await start();
      const alice = await api.addUser('alice');

      const upload = await putCredential(api.app, alice, 'patreon', patreonCookieFile());
      expect(upload.statusCode).toBe(200);
      expect(upload.json()).toEqual({ present: true, cookieCount: 2, droppedCount: 3, earliestExpiry: new Date(1_850_000_000 * 1000).toISOString() });
      expect(upload.body).not.toContain(FAKE_PATREON_SESSION);

      const status = await callCredential(api.app, alice, 'GET', '/api/v1/credentials/patreon');
      expect(status.json()).toMatchObject({ present: true, secretKeyConfigured: true, cookieCount: 2, expired: false, lastResult: 'unknown' });
      expect(status.body).not.toContain(FAKE_PATREON_SESSION);

      const plain = await storedPlaintext(api, alice.userId, 'patreon');
      expect(plain).toContain(`session_id\t${FAKE_PATREON_SESSION}`);
      expect(plain).toContain(FAKE_PATREON_OTHER);
      expect(plain).not.toContain(FAKE_FOREIGN);
      expect(plain).not.toContain('othersite');
    });

    it('refuses a file without session_id, with an empty or expired session_id and without any patreon.com cookie', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const refused = async (text: string) => {
        const response = await putCredential(api.app, alice, 'patreon', text);
        expect(response.statusCode).toBe(400);
        expect(response.json().error.code).toBe('COOKIES_INVALID');
        return response.json().error.message as string;
      };

      expect(await refused(cookieFile(cookieLine('.patreon.com', 'device_id', 'x')))).toMatch(/"session_id"/);
      expect(await refused(cookieFile(cookieLine('.patreon.com', 'session_id', '')))).toMatch(/"session_id"/);
      expect(await refused(cookieFile(cookieLine('.patreon.com', 'session_id', FAKE_PATREON_SESSION, 1_700_000_000)))).toMatch(/abgelaufen/);
      expect(await refused(cookieFile(cookieLine('.example.org', 'session_id', FAKE_FOREIGN)))).toMatch(/keine Cookies für patreon.com/);
      expect(await refused(cookieFile(cookieLine('.notpatreon.com', 'session_id', FAKE_FOREIGN)))).toMatch(/keine Cookies für patreon.com/);
      // A session_id that is only set for another platform's domain does not count.
      expect(await refused(cookieFile(cookieLine('.patreon.com', 'device_id', 'x'), cookieLine('.instagram.com', 'session_id', FAKE_FOREIGN)))).toMatch(/"session_id"/);
      expect((await api.pool.query('SELECT 1 FROM platform_credentials')).rowCount).toBe(0);
    });

    it('accepts a session_id of a subdomain and rewrites one of the bare domain so that gallery-dl recognises it', async () => {
      const api = await start();
      const alice = await api.addUser('alice');

      await putCredential(api.app, alice, 'patreon', cookieFile(cookieLine('www.patreon.com', 'session_id', FAKE_PATREON_SESSION)));
      expect(await storedPlaintext(api, alice.userId, 'patreon')).toContain(`www.patreon.com\tFALSE\t/\tTRUE\t1900000000\tsession_id\t${FAKE_PATREON_SESSION}`);

      await putCredential(api.app, alice, 'patreon', cookieFile(cookieLine('patreon.com', 'session_id', FAKE_PATREON_SESSION)));
      // gallery-dl's check is `cookie.domain == ".patreon.com"` or a name ending in ".patreon.com".
      expect(await storedPlaintext(api, alice.userId, 'patreon')).toContain(`.patreon.com\tTRUE\t/\tTRUE\t1900000000\tsession_id\t${FAKE_PATREON_SESSION}`);
    });
  });

  describe('Pixiv token', () => {
    it('stores the refresh token encrypted, bound to user and platform, and never returns it', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const bob = await api.addUser('bob');

      const upload = await putCredential(api.app, alice, 'pixiv', `  ${FAKE_PIXIV_TOKEN}\n`);
      expect(upload.statusCode).toBe(200);
      expect(upload.json()).toEqual({ present: true, cookieCount: 1, droppedCount: 0, earliestExpiry: null });
      expect(upload.body).not.toContain(FAKE_PIXIV_TOKEN);

      const status = await callCredential(api.app, alice, 'GET', '/api/v1/credentials/pixiv');
      expect(status.json()).toMatchObject({ present: true, cookieCount: 1, earliestExpiry: null, expired: false, lastResult: 'unknown' });
      expect(status.body).not.toContain(FAKE_PIXIV_TOKEN);

      const row = (await api.pool.query('SELECT * FROM platform_credentials')).rows[0];
      expect(row.kind).toBe('token');
      expect(Buffer.concat([row.cookies_ciphertext, row.cookies_nonce]).includes(Buffer.from(FAKE_PIXIV_TOKEN))).toBe(false);
      expect(JSON.stringify({ ...row, cookies_ciphertext: undefined, cookies_nonce: undefined })).not.toContain('FAKE');

      expect(decryptSecret(TEST_SECRET_KEY, row.cookies_ciphertext, row.cookies_nonce, credentialAad('pixiv', alice.userId))).toBe(FAKE_PIXIV_TOKEN);
      // Bound to the owner and to the platform.
      expect(() => decryptSecret(TEST_SECRET_KEY, row.cookies_ciphertext, row.cookies_nonce, credentialAad('pixiv', bob.userId))).toThrow();
      expect(() => decryptSecret(TEST_SECRET_KEY, row.cookies_ciphertext, row.cookies_nonce, credentialAad('patreon', alice.userId))).toThrow();
    });

    it('refuses everything that is not the bare token', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const refused = async (text: string) => {
        const response = await putCredential(api.app, alice, 'pixiv', text);
        expect(response.statusCode).toBe(400);
        return response.json().error as { code: string; message: string };
      };

      expect((await refused('   \n')).code).toBe('COOKIES_INVALID');
      await refused('short');
      await refused(`refresh-token = ${FAKE_PIXIV_TOKEN}`);
      await refused(`"${FAKE_PIXIV_TOKEN}"`);
      await refused(`${FAKE_PIXIV_TOKEN}\nsecond-line-with-another-word-long-enough`);
      await refused(JSON.stringify({ extractor: { pixiv: { 'refresh-token': FAKE_PIXIV_TOKEN } } }));
      await refused(`${FAKE_PIXIV_TOKEN}\u0000`);
      const error = await refused('this is not a token but long enough to pass a length check');
      expect(error.message).toMatch(/gallery-dl oauth:pixiv/);
      expect(error.message).not.toContain('this is not');
      expect((await api.pool.query('SELECT 1 FROM platform_credentials')).rowCount).toBe(0);
    });

    it('refuses a value above 1 KiB with its own error and a cookies file as a token', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const tooLarge = await putCredential(api.app, alice, 'pixiv', 'A'.repeat(1025));
      expect(tooLarge.statusCode).toBe(413);
      expect(tooLarge.json().error.code).toBe('FILE_TOO_LARGE');
      expect((await putCredential(api.app, alice, 'pixiv', patreonCookieFile())).statusCode).toBe(400);
    });

    it('lets the database refuse a token row that does not look like one', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const insert = (platform: string, kind: string, count: number) => api.pool.query(
        `INSERT INTO platform_credentials (id, user_id, platform, kind, cookies_ciphertext, cookies_nonce, cookie_count)
         VALUES (gen_random_uuid(), $1, $2, $3, '\\x00'::bytea, '\\x000000000000000000000000'::bytea, $4)`,
        [alice.userId, platform, kind, count]
      );
      await expect(insert('pixiv', 'cookies', 1)).rejects.toThrow(/pixiv_token_check/);
      await expect(insert('patreon', 'token', 1)).rejects.toThrow(/pixiv_token_check/);
      await expect(insert('pixiv', 'token', 3)).rejects.toThrow(/token_shape_check/);
      await expect(insert('tiktok', 'cookies', 1)).rejects.toThrow(/platform_check/);
      await insert('pixiv', 'token', 1);
    });
  });

  describe('YouTube cookies (optional login)', () => {
    it('keeps youtube.com and google.com cookies and needs LOGIN_INFO plus a SAPISID cookie', async () => {
      const api = await start();
      const alice = await api.addUser('alice');

      const upload = await putCredential(api.app, alice, 'youtube', youtubeCookieFile());
      expect(upload.json()).toEqual({ present: true, cookieCount: 3, droppedCount: 1, earliestExpiry: new Date(1_800_000_000 * 1000).toISOString() });
      const plain = await storedPlaintext(api, alice.userId, 'youtube');
      expect(plain).toContain(FAKE_YOUTUBE_LOGIN);
      expect(plain).not.toContain(FAKE_FOREIGN);

      const refused = async (text: string) => (await putCredential(api.app, alice, 'youtube', text)).json().error.message as string;
      expect(await refused(cookieFile(cookieLine('.youtube.com', 'SAPISID', FAKE_YOUTUBE_SAPISID)))).toMatch(/LOGIN_INFO/);
      expect(await refused(cookieFile(cookieLine('.youtube.com', 'LOGIN_INFO', FAKE_YOUTUBE_LOGIN)))).toMatch(/SAPISID/);
      // The auth cookies must be set for youtube.com, not for google.com.
      expect(await refused(cookieFile(cookieLine('.google.com', 'LOGIN_INFO', FAKE_YOUTUBE_LOGIN), cookieLine('.google.com', 'SAPISID', FAKE_YOUTUBE_SAPISID)))).toMatch(/LOGIN_INFO/);
      expect(await refused(cookieFile(cookieLine('.youtube.com', 'LOGIN_INFO', FAKE_YOUTUBE_LOGIN, 1_700_000_000), cookieLine('.youtube.com', 'SAPISID', FAKE_YOUTUBE_SAPISID)))).toMatch(/abgelaufen/);
      expect(await refused(cookieFile(cookieLine('.example.org', 'LOGIN_INFO', FAKE_FOREIGN)))).toMatch(/youtube.com oder google.com/);
    });

    it('accepts __Secure-3PAPISID in place of SAPISID', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const upload = await putCredential(api.app, alice, 'youtube', cookieFile(
        cookieLine('.youtube.com', 'LOGIN_INFO', FAKE_YOUTUBE_LOGIN),
        cookieLine('.youtube.com', '__Secure-3PAPISID', FAKE_YOUTUBE_SAPISID)
      ));
      expect(upload.statusCode).toBe(200);
    });
  });

  describe('status of all platforms, isolation, deletion and unknown platforms', () => {
    it('lists one entry per platform and keeps two users apart', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const bob = await api.addUser('bob');
      await putCredential(api.app, alice, 'patreon', patreonCookieFile());
      await putCredential(api.app, alice, 'pixiv', FAKE_PIXIV_TOKEN);
      await putCredential(api.app, bob, 'youtube', youtubeCookieFile());

      const summary = (await callCredential(api.app, alice, 'GET', '/api/v1/credentials')).json();
      expect(summary.secretKeyConfigured).toBe(true);
      expect(summary.credentials.map((entry: { platform: string; kind: string; present: boolean }) => [entry.platform, entry.kind, entry.present])).toEqual([
        ['instagram', 'cookies', false], ['patreon', 'cookies', true], ['pixiv', 'token', true], ['youtube', 'cookies', false]
      ]);
      const bobSummary = (await callCredential(api.app, bob, 'GET', '/api/v1/credentials')).json();
      expect(bobSummary.credentials.filter((entry: { present: boolean }) => entry.present).map((entry: { platform: string }) => entry.platform)).toEqual(['youtube']);
      expect(JSON.stringify(summary)).not.toContain(FAKE_PIXIV_TOKEN);

      // Bob deletes his Pixiv entry: there is none, and Alice keeps hers.
      expect((await callCredential(api.app, bob, 'DELETE', '/api/v1/credentials/pixiv')).statusCode).toBe(204);
      expect((await callCredential(api.app, alice, 'GET', '/api/v1/credentials/pixiv')).json().present).toBe(true);
      expect((await callCredential(api.app, alice, 'DELETE', '/api/v1/credentials/pixiv')).statusCode).toBe(204);
      expect((await api.pool.query("SELECT platform FROM platform_credentials WHERE user_id = $1 ORDER BY platform", [alice.userId])).rows).toEqual([{ platform: 'patreon' }]);
    });

    it('needs a session and the CSRF token for every platform, and refuses unknown platforms', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      for (const platform of ['patreon', 'pixiv', 'youtube']) {
        expect((await callCredential(api.app, null, 'GET', `/api/v1/credentials/${platform}`)).statusCode).toBe(401);
        expect((await putCredential(api.app, null, platform, 'x')).statusCode).toBe(403);
        expect((await callCredential(api.app, null, 'DELETE', `/api/v1/credentials/${platform}`)).statusCode).toBe(403);
      }
      expect((await callCredential(api.app, null, 'GET', '/api/v1/credentials')).statusCode).toBe(401);
      const withoutCsrf = await api.app.inject({
        method: 'PUT', url: '/api/v1/credentials/pixiv',
        headers: { cookie: alice.cookie, origin: 'http://localhost', host: 'localhost', 'content-type': 'text/plain' }, payload: FAKE_PIXIV_TOKEN
      });
      expect(withoutCsrf.statusCode).toBe(403);
      expect((await callCredential(api.app, alice, 'GET', '/api/v1/credentials/tiktok')).statusCode).toBe(404);
      expect((await putCredential(api.app, alice, 'tiktok', FAKE_PIXIV_TOKEN)).statusCode).toBe(404);
      expect((await putCredential(api.app, alice, '__proto__', FAKE_PIXIV_TOKEN)).statusCode).toBe(404);
      expect((await api.pool.query('SELECT 1 FROM platform_credentials')).rowCount).toBe(0);
    });

    it('refuses an upload without KURA_SECRET_KEY with a sentence for each platform', async () => {
      const api = await start({});
      const alice = await api.addUser('alice');
      const pixiv = await putCredential(api.app, alice, 'pixiv', FAKE_PIXIV_TOKEN);
      expect(pixiv.statusCode).toBe(503);
      expect(pixiv.json().error).toMatchObject({ code: 'SECRET_KEY_REQUIRED', message: expect.stringMatching(/Pixiv-Token kann/) });
      expect((await putCredential(api.app, alice, 'patreon', patreonCookieFile())).json().error.message).toMatch(/Patreon-Cookies/);
      expect((await api.pool.query('SELECT 1 FROM platform_credentials')).rowCount).toBe(0);
    });

    it('writes audit entries without content and no log line contains a secret', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      await putCredential(api.app, alice, 'pixiv', FAKE_PIXIV_TOKEN);
      await putCredential(api.app, alice, 'pixiv', 'refresh-token: rejected-but-must-not-be-logged-either');
      await putCredential(api.app, alice, 'patreon', patreonCookieFile());
      await callCredential(api.app, alice, 'DELETE', '/api/v1/credentials/pixiv');

      const events = await api.pool.query("SELECT action, details FROM audit_events WHERE action LIKE 'credential.%'");
      expect(events.rows.map((row) => row.action)).toEqual(expect.arrayContaining(['credential.pixiv_save', 'credential.pixiv_delete', 'credential.patreon_save']));
      const everything = JSON.stringify(events.rows) + api.logs();
      for (const secret of [FAKE_PIXIV_TOKEN, FAKE_PATREON_SESSION, FAKE_PATREON_OTHER, 'rejected-but-must-not-be-logged-either']) {
        expect(everything).not.toContain(secret);
      }
    });
  });
});
