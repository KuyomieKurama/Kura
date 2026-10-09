import { afterEach, describe, expect, it } from 'vitest';
import { decryptSecret } from '../../apps/api/src/immich-routes.js';
import { credentialAad } from '../../apps/api/src/instagram-routes.js';
import { MAX_COOKIE_FILE_BYTES } from '../../apps/api/src/instagram-cookies.js';
import {
  FAKE_CSRF_VALUE, FAKE_FOREIGN_VALUE, FAKE_SESSION_VALUE, cookieFile, cookieLine, validCookieFile
} from './cookie-samples.js';
import { TEST_SECRET_KEY, createCredentialFixture, type CredentialFixture } from './credentials-fixture.js';

const URL = '/api/v1/credentials/instagram';
const SECRET_VALUES = [FAKE_SESSION_VALUE, FAKE_CSRF_VALUE];

describe('Instagram cookies per user (API on real PostgreSQL)', () => {
  const open: CredentialFixture[] = [];
  afterEach(async () => {
    await Promise.all(open.splice(0).map((fixture) => fixture.cleanup()));
  });
  async function start(options?: { secretKey?: Buffer }): Promise<CredentialFixture> {
    const fixture = await createCredentialFixture(options);
    open.push(fixture);
    return fixture;
  }

  describe('upload and status', () => {
    it('keeps only Instagram cookies, reports count and earliest expiry, and never returns content', async () => {
      const api = await start();
      const alice = await api.addUser('alice');

      const upload = await api.putText(alice, validCookieFile());
      expect(upload.statusCode).toBe(200);
      expect(upload.json()).toEqual({ present: true, cookieCount: 3, droppedCount: 3, earliestExpiry: new Date(1_850_000_000 * 1000).toISOString() });

      const status = await api.call(alice, 'GET', URL);
      expect(status.json()).toMatchObject({
        present: true, secretKeyConfigured: true, cookieCount: 3, expired: false, lastUsedAt: null, lastResult: 'unknown',
        earliestExpiry: new Date(1_850_000_000 * 1000).toISOString()
      });
      for (const response of [upload, status]) {
        for (const secret of SECRET_VALUES) expect(response.body).not.toContain(secret);
        expect(response.body).not.toMatch(/sessionid/i);
      }
    });

    it('reports no expiry when every kept cookie is a session cookie', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const upload = await api.putText(alice, cookieFile(cookieLine('.instagram.com', 'sessionid', FAKE_SESSION_VALUE, 0)));
      expect(upload.statusCode).toBe(200);
      expect(upload.json()).toMatchObject({ cookieCount: 1, earliestExpiry: null });
    });

    it('says "not present" before an upload', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      expect((await api.call(alice, 'GET', URL)).json()).toEqual({ present: false, secretKeyConfigured: true });
    });

    it('accepts a file at exactly 256 KiB and refuses one byte more', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const base = validCookieFile();
      const padding = (size: number) => `# ${'x'.repeat(size - 3)}\n`;
      const exactly = base + padding(MAX_COOKIE_FILE_BYTES - Buffer.byteLength(base));
      expect(Buffer.byteLength(exactly)).toBe(MAX_COOKIE_FILE_BYTES);
      expect((await api.putText(alice, exactly)).statusCode).toBe(200);

      const tooLarge = exactly + '#';
      const refused = await api.putText(alice, tooLarge);
      expect(refused.statusCode).toBe(413);
      expect(refused.json().error.code).toBe('FILE_TOO_LARGE');
    });
  });

  describe('validation', () => {
    /** One database per test (the helper creates one per module); several refusals share the same user. */
    async function refusing() {
      const api = await start();
      const alice = await api.addUser('alice');
      return async (content: string, expectedStatus = 400) => {
        const response = await api.putText(alice, content);
        expect(response.statusCode).toBe(expectedStatus);
        const rows = await api.pool.query('SELECT 1 FROM platform_credentials');
        expect(rows.rowCount).toBe(0);
        for (const secret of [...SECRET_VALUES, FAKE_FOREIGN_VALUE]) expect(response.body).not.toContain(secret);
        return response.json().error as { code: string; message: string };
      };
    }

    it('refuses an empty file', async () => {
      const refusedWith = await refusing();
      expect((await refusedWith('  \n')).code).toBe('COOKIES_INVALID');
    });

    it('refuses text that is not in Netscape format', async () => {
      const refusedWith = await refusing();
      const error = await refusedWith('sessionid=abc; csrftoken=def\n');
      expect(error.message).toMatch(/Netscape-Format/);
    });

    it('refuses JSON exported by an extension', async () => {
      const refusedWith = await refusing();
      const error = await refusedWith(JSON.stringify([{ domain: '.instagram.com', name: 'sessionid', value: FAKE_SESSION_VALUE }]));
      expect(error.message).toMatch(/Netscape-Format/);
    });

    it('refuses a line with spaces instead of tabs, a bad flag or a bad expiry', async () => {
      const refusedWith = await refusing();
      await refusedWith(cookieFile('.instagram.com sessionid x'));
      await refusedWith(cookieFile('.instagram.com\tMAYBE\t/\tTRUE\t1900000000\tsessionid\tx'));
      await refusedWith(cookieFile('.instagram.com\tTRUE\t/\tTRUE\tsoon\tsessionid\tx'));
    });

    it('refuses binary content', async () => {
      const refusedWith = await refusing();
      await refusedWith(`${validCookieFile()}\u0000`);
    });

    it('refuses a file without any Instagram cookie', async () => {
      const refusedWith = await refusing();
      const error = await refusedWith(cookieFile(cookieLine('.example.org', 'sessionid', FAKE_FOREIGN_VALUE)));
      expect(error.message).toMatch(/keine Cookies für instagram.com/);
    });

    it('refuses Instagram cookies without a sessionid for instagram.com', async () => {
      const refusedWith = await refusing();
      const error = await refusedWith(cookieFile(
        cookieLine('.instagram.com', 'csrftoken', FAKE_CSRF_VALUE),
        cookieLine('.example.org', 'sessionid', FAKE_FOREIGN_VALUE),
        cookieLine('.notinstagram.com', 'sessionid', FAKE_FOREIGN_VALUE)
      ));
      expect(error.message).toMatch(/"sessionid"/);
    });

    it('refuses an empty sessionid and an expired sessionid', async () => {
      const refusedWith = await refusing();
      await refusedWith(cookieFile(cookieLine('.instagram.com', 'sessionid', '')));
      const error = await refusedWith(cookieFile(cookieLine('.instagram.com', 'sessionid', FAKE_SESSION_VALUE, 1_700_000_000)));
      expect(error.message).toMatch(/abgelaufen/);
    });

    it('refuses a body that is not plain text', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const response = await api.putText(alice, JSON.stringify({ content: validCookieFile() }), 'application/json');
      expect(response.statusCode).toBe(400);
      expect((await api.pool.query('SELECT 1 FROM platform_credentials')).rowCount).toBe(0);
    });

    it('does not keep cookies of look-alike domains and keeps subdomains of instagram.com', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const file = cookieFile(
        cookieLine('.instagram.com', 'sessionid', FAKE_SESSION_VALUE),
        cookieLine('www.instagram.com', 'ig_sub', 'FAKE-SUB'),
        cookieLine('.NotInstagram.com', 'lookalike', FAKE_FOREIGN_VALUE),
        cookieLine('instagram.com.example.org', 'lookalike2', FAKE_FOREIGN_VALUE),
        cookieLine('.example.org', 'othersite', FAKE_FOREIGN_VALUE)
      );
      expect((await api.putText(alice, file)).json()).toMatchObject({ cookieCount: 2, droppedCount: 3 });
      const stored = await api.pool.query('SELECT cookies_ciphertext, cookies_nonce FROM platform_credentials');
      const plain = decryptSecret(TEST_SECRET_KEY, stored.rows[0].cookies_ciphertext, stored.rows[0].cookies_nonce, credentialAad(alice.userId));
      expect(plain).toContain('ig_sub');
      expect(plain).not.toContain(FAKE_FOREIGN_VALUE);
      expect(plain).not.toContain('othersite');
    });
  });

  describe('encryption at rest', () => {
    it('stores only ciphertext that decrypts to the kept cookies for the owner and for nobody else', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const bob = await api.addUser('bob');
      await api.putText(alice, validCookieFile());

      const columns = await api.pool.query('SELECT column_name FROM information_schema.columns WHERE table_name = $1', ['platform_credentials']);
      expect(columns.rows.map((row) => row.column_name)).not.toEqual(expect.arrayContaining(['cookies', 'cookie_text']));

      const stored = await api.pool.query('SELECT * FROM platform_credentials');
      expect(stored.rowCount).toBe(1);
      const row = stored.rows[0];
      const everything = Buffer.concat([row.cookies_ciphertext, row.cookies_nonce]);
      for (const needle of ['sessionid', 'csrftoken', 'instagram', 'Netscape', ...SECRET_VALUES]) {
        expect(everything.includes(Buffer.from(needle))).toBe(false);
      }
      // No other column carries content either.
      expect(JSON.stringify({ ...row, cookies_ciphertext: undefined, cookies_nonce: undefined })).not.toMatch(/sessionid|FAKE/);
      expect(row.cookies_nonce.length).toBe(12);

      const plain = decryptSecret(TEST_SECRET_KEY, row.cookies_ciphertext, row.cookies_nonce, credentialAad(alice.userId));
      expect(plain).toContain(`sessionid\t${FAKE_SESSION_VALUE}`);
      expect(plain.startsWith('# Netscape HTTP Cookie File')).toBe(true);
      // The blob is bound to its owner: copied into another user's row it does not open.
      expect(() => decryptSecret(TEST_SECRET_KEY, row.cookies_ciphertext, row.cookies_nonce, credentialAad(bob.userId))).toThrow();
      expect(() => decryptSecret(Buffer.alloc(32, 9), row.cookies_ciphertext, row.cookies_nonce, credentialAad(alice.userId))).toThrow();
    });

    it('uses a fresh nonce for every upload and replaces the stored blob', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      await api.putText(alice, validCookieFile());
      const first = (await api.pool.query('SELECT cookies_nonce, created_at FROM platform_credentials')).rows[0];
      await api.putText(alice, validCookieFile());
      const rows = await api.pool.query('SELECT cookies_nonce, created_at FROM platform_credentials');
      expect(rows.rowCount).toBe(1);
      expect(Buffer.compare(rows.rows[0].cookies_nonce, first.cookies_nonce)).not.toBe(0);
      expect(rows.rows[0].created_at).toEqual(first.created_at);
    });

    it('resets the last result to unknown when new cookies are uploaded', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      await api.putText(alice, validCookieFile());
      await api.pool.query("UPDATE platform_credentials SET last_result = 'auth_required'");
      expect((await api.call(alice, 'GET', URL)).json().lastResult).toBe('auth_required');
      await api.putText(alice, validCookieFile());
      expect((await api.call(alice, 'GET', URL)).json().lastResult).toBe('unknown');
    });
  });

  describe('ownership and authentication', () => {
    it('keeps two users apart', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      const bob = await api.addUser('bob');
      await api.putText(alice, validCookieFile());

      expect((await api.call(bob, 'GET', URL)).json()).toEqual({ present: false, secretKeyConfigured: true });
      expect((await api.call(bob, 'DELETE', URL)).statusCode).toBe(204);
      expect((await api.call(alice, 'GET', URL)).json().present).toBe(true);

      await api.putText(bob, cookieFile(cookieLine('.instagram.com', 'sessionid', 'FAKE-BOB-SESSION', 1_800_000_000)));
      expect((await api.call(bob, 'GET', URL)).json()).toMatchObject({ cookieCount: 1, earliestExpiry: new Date(1_800_000_000 * 1000).toISOString() });
      expect((await api.call(alice, 'GET', URL)).json()).toMatchObject({ cookieCount: 3 });
      expect((await api.pool.query('SELECT user_id FROM platform_credentials ORDER BY user_id')).rowCount).toBe(2);
    });

    it('is not available without a session and an upload needs the CSRF token', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      expect((await api.call(null, 'GET', URL)).statusCode).toBe(401);
      expect((await api.putText(null, validCookieFile())).statusCode).toBe(403);
      expect((await api.call(null, 'DELETE', URL)).statusCode).toBe(403);
      const withoutCsrf = await api.app.inject({
        method: 'PUT', url: URL, payload: validCookieFile(),
        headers: { cookie: alice.cookie, origin: 'http://localhost', host: 'localhost', 'content-type': 'text/plain' }
      });
      expect(withoutCsrf.statusCode).toBe(403);
      expect((await api.pool.query('SELECT 1 FROM platform_credentials')).rowCount).toBe(0);
    });
  });

  describe('delete', () => {
    it('removes the row', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      await api.putText(alice, validCookieFile());
      expect((await api.call(alice, 'DELETE', URL)).statusCode).toBe(204);
      expect((await api.pool.query('SELECT 1 FROM platform_credentials')).rowCount).toBe(0);
      expect((await api.call(alice, 'GET', URL)).json().present).toBe(false);
    });
  });

  describe('secret key', () => {
    it('refuses an upload without KURA_SECRET_KEY and stores nothing', async () => {
      const api = await start({});
      const alice = await api.addUser('alice');
      const response = await api.putText(alice, validCookieFile());
      expect(response.statusCode).toBe(503);
      expect(response.json().error.code).toBe('SECRET_KEY_REQUIRED');
      expect((await api.pool.query('SELECT 1 FROM platform_credentials')).rowCount).toBe(0);
      expect((await api.call(alice, 'GET', URL)).json()).toEqual({ present: false, secretKeyConfigured: false });
    });
  });

  describe('audit and logs', () => {
    it('records save and delete without content, and no log line contains cookie content', async () => {
      const api = await start();
      const alice = await api.addUser('alice');
      await api.putText(alice, validCookieFile());
      await api.call(alice, 'GET', URL);
      await api.putText(alice, 'not a cookie file with FAKE-SECRET-IN-REJECTED-UPLOAD');
      await api.call(alice, 'DELETE', URL);

      const events = await api.pool.query("SELECT action, target_id, outcome, details FROM audit_events WHERE action LIKE 'credential.%' OR action = 'put.rejected' ORDER BY occurred_at, id");
      const actions = events.rows.map((row) => row.action);
      expect(actions).toEqual(expect.arrayContaining(['credential.instagram_save', 'credential.instagram_delete', 'put.rejected']));
      const auditText = JSON.stringify(events.rows);
      for (const needle of [...SECRET_VALUES, FAKE_FOREIGN_VALUE, 'FAKE-SECRET-IN-REJECTED-UPLOAD', 'sessionid']) expect(auditText).not.toContain(needle);

      const logs = api.logs();
      expect(logs.length).toBeGreaterThan(0);
      for (const needle of [...SECRET_VALUES, FAKE_FOREIGN_VALUE, 'FAKE-SECRET-IN-REJECTED-UPLOAD', 'sessionid', 'Netscape']) expect(logs).not.toContain(needle);
    });
  });
});
