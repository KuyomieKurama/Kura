import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';

const config = { databaseUrl: 'not-logged', host: '127.0.0.1', port: 8080, trustProxy: false, cookieSecure: false };
const adminPassword = 'correct horse battery staple';

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture() {
  const database = await createTestDatabase();
  const migrations = await createMigrationsCopy();
  await runMigrations(database.pool, migrations.directory);
  let now = new Date('2026-10-06T12:00:00.000Z');
  const app = buildApp(config, new Pool({ connectionString: database.databaseUrl }), undefined, { now: () => now });
  return { database, migrations, app, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); } };
}
async function setup(subject: Fixture, username = 'admin') {
  const response = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username, displayName: 'Admin', password: adminPassword } });
  expect(response.statusCode).toBe(201);
  return { response, cookie: response.headers['set-cookie'] as string, csrf: response.json().csrfToken as string, id: response.json().user.id as string };
}
function headers(cookie: string, csrf: string) { return { cookie, 'x-kura-csrf': csrf, origin: 'http://localhost', host: 'localhost' }; }

describe('local authentication API', () => {
  const fixtures: Fixture[] = [];
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(async (subject) => { await subject.app.close(); await subject.migrations.cleanup(); await subject.database.cleanup(); })); });

  it('permits setup once atomically and never exposes password hashes', async () => {
    const subject = await fixture(); fixtures.push(subject);
    const payload = { username: 'admin', displayName: 'Admin', password: adminPassword };
    const [first, second] = await Promise.all([subject.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload }), subject.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload })]);
    expect([first.statusCode, second.statusCode].sort()).toEqual([201, 409]);
    expect(await subject.database.pool.query('SELECT * FROM users')).toHaveProperty('rowCount', 1);
    expect(`${first.body}${second.body}`).not.toContain('password_hash');
    expect((await subject.database.pool.query('SELECT password_hash FROM local_credentials')).rows[0].password_hash).toMatch(/^scrypt\$32768\$8\$1\$/);
  });

  it('rejects weak passwords and has identical login failures while ignoring forwarded headers without trust proxy', async () => {
    const subject = await fixture(); fixtures.push(subject);
    const weak = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'admin', displayName: 'Admin', password: 'passwordpassword' } });
    expect(weak.statusCode).toBe(400);
    await setup(subject);
    const unknown = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-for': '203.0.113.1' }, payload: { username: 'missing', password: adminPassword } });
    const wrong = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-for': '198.51.100.1' }, payload: { username: 'admin', password: 'wrong password value' } });
    expect([unknown.statusCode, unknown.body]).toEqual([wrong.statusCode, wrong.body]);
    expect((await subject.database.pool.query("SELECT count(*)::int AS count FROM login_attempts WHERE source_address='127.0.0.1'")).rows).toEqual([{ count: 1 }]);
    await Promise.all(Array.from({ length: 3 }, (_, index) => subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: `other${index}`, password: adminPassword } })));
    expect((await subject.database.pool.query("SELECT locked_until FROM login_attempts WHERE subject='*' AND source_address='127.0.0.1' ")).rows[0].locked_until).not.toBeNull();
  });

  it('uses strict cookie sessions, CSRF, injected idle expiry, logout, and blocking revocation', async () => {
    const subject = await fixture(); fixtures.push(subject);
    const admin = await setup(subject);
    expect(admin.cookie).toContain('HttpOnly'); expect(admin.cookie).toContain('SameSite=Strict'); expect(admin.cookie).toContain('Path=/'); expect(admin.cookie).not.toContain('Secure');
    const denied = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: admin.cookie } });
    expect(denied.statusCode).toBe(403);
    subject.advance(2 * 60 * 60 * 1000 + 1);
    expect((await subject.app.inject({ url: '/api/v1/users', headers: { cookie: admin.cookie } })).statusCode).toBe(401);
    const login = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: adminPassword } });
    const cookie = login.headers['set-cookie'] as string; const csrf = login.json().csrfToken as string;
    expect((await subject.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(cookie, csrf) })).statusCode).toBe(204);
    expect((await subject.app.inject({ url: '/api/v1/users', headers: { cookie } })).statusCode).toBe(401);
    const again = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: adminPassword } });
    const activeCookie = again.headers['set-cookie'] as string; const activeCsrf = again.json().csrfToken as string;
    expect((await subject.app.inject({ method: 'PATCH', url: `/api/v1/users/${admin.id}`, headers: headers(activeCookie, activeCsrf), payload: { status: 'blocked' } })).statusCode).toBe(409);
  });

  it('covers user administration, owner filtering, forced initial password change, and audit events', async () => {
    const subject = await fixture(); fixtures.push(subject);
    const admin = await setup(subject);
    const create = await subject.app.inject({ method: 'POST', url: '/api/v1/users', headers: headers(admin.cookie, admin.csrf), payload: { username: 'alice', displayName: 'Alice', initialPassword: 'a long enough password', role: 'user' } });
    expect(create.statusCode).toBe(201); const aliceId = create.json().user.id as string;
    const aliceLogin = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: 'a long enough password' } });
    expect(aliceLogin.json().passwordChangeRequired).toBe(true);
    const aliceCookie = aliceLogin.headers['set-cookie'] as string; const aliceCsrf = aliceLogin.json().csrfToken as string;
    const users = await subject.app.inject({ url: '/api/v1/users', headers: { cookie: aliceCookie } });
    expect(users.json().users.map((user: { id: string }) => user.id)).toEqual([aliceId]);
    expect((await subject.app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: headers(aliceCookie, aliceCsrf), payload: { currentPassword: 'a long enough password', newPassword: 'different long enough password' } })).statusCode).toBe(204);
    const audit = await subject.database.pool.query('SELECT action, details FROM audit_events ORDER BY occurred_at');
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining(['auth.setup', 'user.create', 'auth.login', 'auth.change_password']));
    expect(JSON.stringify(audit.rows.map((row) => row.details))).not.toContain('different long enough password');
  });
});
