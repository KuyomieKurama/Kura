import { randomBytes } from 'node:crypto';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';

const key = randomBytes(32).toString('base64');
const password = 'correct horse battery staple';
const config = { databaseUrl: 'not-logged', host: '127.0.0.1', port: 8080, trustProxy: false, cookieSecure: false, secretKey: Buffer.from(key, 'base64'), storage: { backend: 'database' as const, root: './unused', quotaBytes: 1024 * 1024, layout: 'cas' as const } };
type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() { const database = await createTestDatabase(); const migrations = await createMigrationsCopy(); await runMigrations(database.pool, migrations.directory); const app = buildApp(config, new Pool({ connectionString: database.databaseUrl })); return { app, database, migrations }; }
async function setup(subject: Fixture, username: string) { const response = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username, displayName: username, password } }); return { cookie: response.headers['set-cookie'] as string, csrf: response.json().csrfToken as string, id: response.json().user.id as string }; }
function headers(login: { cookie: string; csrf: string }) { return { cookie: login.cookie, 'x-kura-csrf': login.csrf, origin: 'http://localhost', host: 'localhost' }; }

describe('W2 Immich wiring', () => {
  const fixtures: Fixture[] = [];
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(async (item) => { await item.app.close(); await item.migrations.cleanup(); await item.database.cleanup(); })); });
  it('encrypts API keys, never returns them, and isolates each user connection', async () => {
    const subject = await fixture(); fixtures.push(subject); const admin = await setup(subject, 'admin');
    await subject.app.inject({ method: 'POST', url: '/api/v1/users', headers: headers(admin), payload: { username: 'alice', displayName: 'Alice', initialPassword: 'a sufficiently long password', role: 'user' } });
    const aliceLogin = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: 'a sufficiently long password' } });
    const alice = { cookie: aliceLogin.headers['set-cookie'] as string, csrf: aliceLogin.json().csrfToken as string };
    await subject.app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: headers(alice), payload: { currentPassword: 'a sufficiently long password', newPassword: 'another sufficiently long password' } });
    const secret = 'api-key-must-never-leak';
    const saved = await subject.app.inject({ method: 'PUT', url: '/api/v1/immich/connection', headers: headers(alice), payload: { serverUrl: 'http://127.0.0.1:39999', apiKey: secret } });
    expect(saved.statusCode).toBe(204); expect(saved.body).not.toContain(secret);
    const stored = await subject.database.pool.query('SELECT api_key_ciphertext FROM immich_connections'); expect(Buffer.from(stored.rows[0].api_key_ciphertext).toString('utf8')).not.toContain(secret);
    const own = await subject.app.inject({ url: '/api/v1/immich/connection', headers: { cookie: alice.cookie } }); expect(own.body).not.toContain(secret); expect(own.json().connection.serverUrl).toBe('http://127.0.0.1:39999');
    const other = await subject.app.inject({ url: '/api/v1/immich/connection', headers: { cookie: admin.cookie } }); expect(other.json().connection).toBeNull();
    const unknown = await subject.app.inject({ method: 'POST', url: '/api/v1/immich/connection/test', headers: headers(alice) }); expect(unknown.json()).toMatchObject({ version: 'unbekannt', supported: false });
  });
});
