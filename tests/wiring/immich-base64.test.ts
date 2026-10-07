import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeStrictBase64 } from '../../apps/api/src/base64.js';
import { buildApp } from '../../apps/api/src/app.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';

const MAX_BYTES = 4 * 1024 * 1024;
const config = {
  databaseUrl: 'not-logged',
  host: '127.0.0.1',
  port: 8080,
  trustProxy: false,
  cookieSecure: false,
  secretKey: Buffer.alloc(32, 7),
  storage: { backend: 'database' as const, root: './unused', quotaBytes: 8 * 1024 * 1024, layout: 'cas' as const }
};

describe('strict base64 decoding', () => {
  it('accepts canonical padded base64 and returns the decoded bytes', () => {
    const result = decodeStrictBase64(Buffer.from('hello world').toString('base64'), MAX_BYTES);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.bytes.toString('utf8')).toBe('hello world');
  });

  it.each(['A', 'AAA', 'AA=A', 'AB==', 'not base64!', '@@@@', 'AAAA\nAAAA', 'AAAA AAAA', 'AAA===', 'a-b_'])(
    'rejects invalid input %j',
    (input) => {
      expect(decodeStrictBase64(input, MAX_BYTES)).toEqual({ ok: false, reason: 'invalid' });
    }
  );

  it.each(['', '===='])('rejects input that decodes to nothing: %j', (input) => {
    const result = decodeStrictBase64(input, MAX_BYTES);
    expect(result.ok).toBe(false);
  });

  it('keeps the size cap on the decoded length', () => {
    const atLimit = Buffer.alloc(MAX_BYTES, 1).toString('base64');
    const overLimit = Buffer.alloc(MAX_BYTES + 1, 1).toString('base64');
    expect(decodeStrictBase64(atLimit, MAX_BYTES).ok).toBe(true);
    expect(decodeStrictBase64(overLimit, MAX_BYTES)).toEqual({ ok: false, reason: 'too-large' });
  });
});

describe('POST /api/v1/immich/test-transfer input validation', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0)) await cleanup();
  });

  async function loggedInApp() {
    const database = await createTestDatabase();
    const migrations = await createMigrationsCopy();
    await runMigrations(database.pool, migrations.directory);
    const app = buildApp(config, new Pool({ connectionString: database.databaseUrl }));
    cleanups.push(async () => {
      await app.close();
      await migrations.cleanup();
      await database.cleanup();
    });
    const setup = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/setup',
      payload: { username: 'admin', displayName: 'Admin', password: 'correct horse battery staple' }
    });
    const headers = {
      cookie: setup.headers['set-cookie'] as string,
      'x-kura-csrf': setup.json().csrfToken as string,
      origin: 'http://localhost',
      host: 'localhost'
    };
    return { app, headers, database };
  }

  it('rejects non-empty invalid base64 and base64 that decodes to zero bytes, and stores nothing', async () => {
    const { app, headers, database } = await loggedInApp();
    for (const contentBase64 of ['!!!!', '====', 'AAA', 'AAAA!AAA', '']) {
      const response = await app.inject({
        method: 'POST',
        url: '/api/v1/immich/test-transfer',
        headers,
        payload: { fileName: 'x.bin', contentBase64 }
      });
      expect(response.statusCode, `input ${JSON.stringify(contentBase64)}`).toBe(400);
    }
    const stored = await database.pool.query('SELECT count(*)::int AS count FROM blobstore_objects');
    expect(stored.rows[0].count).toBe(0);
  });

  it('lets valid base64 pass validation (it then needs a saved connection)', async () => {
    const { app, headers } = await loggedInApp();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/immich/test-transfer',
      headers,
      payload: { fileName: 'x.bin', contentBase64: Buffer.from('payload').toString('base64') }
    });
    expect(response.statusCode).toBe(404);
    expect(response.json().error.code).toBe('NOT_FOUND');
  });
});
