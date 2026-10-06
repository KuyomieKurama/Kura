import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';

const config = { databaseUrl: 'not-logged', host: '127.0.0.1', port: 8080, trustProxy: false, cookieSecure: false };
const adminPassword = 'correct horse battery staple';

type Fixture = Awaited<ReturnType<typeof fixture>>;
async function fixture(configOverride: Partial<typeof config> = {}) {
  const database = await createTestDatabase();
  const migrations = await createMigrationsCopy();
  await runMigrations(database.pool, migrations.directory);
  let now = new Date('2026-10-06T12:00:00.000Z');
  const app = buildApp({ ...config, ...configOverride }, new Pool({ connectionString: database.databaseUrl }), undefined, { now: () => now });
  return { database, migrations, app, advance: (milliseconds: number) => { now = new Date(now.getTime() + milliseconds); return now; } };
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
    const storedHash = (await subject.database.pool.query('SELECT password_hash FROM local_credentials')).rows[0].password_hash as string;
    expect(storedHash).toMatch(/^scrypt\$32768\$8\$1\$/);
    expect(`${first.body}${second.body}`).not.toContain(storedHash);
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
    expect((await subject.app.inject({ url: '/api/v1/users', headers: { cookie: aliceCookie } })).statusCode).toBe(403);
    expect((await subject.app.inject({ method: 'POST', url: '/api/v1/users', headers: headers(aliceCookie, aliceCsrf), payload: { username: 'bypass', displayName: 'Bypass', initialPassword: adminPassword } })).json().error.code).toBe('PASSWORD_CHANGE_REQUIRED');
    expect((await subject.app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: headers(aliceCookie, aliceCsrf), payload: { currentPassword: 'a long enough password', newPassword: 'different long enough password' } })).statusCode).toBe(204);
    const users = await subject.app.inject({ url: '/api/v1/users', headers: { cookie: aliceCookie } });
    expect(users.json().users.map((user: { id: string }) => user.id)).toEqual([aliceId]);
    const audit = await subject.database.pool.query('SELECT action, details FROM audit_events ORDER BY occurred_at');
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining(['auth.setup', 'user.create', 'auth.login', 'auth.change_password']));
    expect(JSON.stringify(audit.rows.map((row) => row.details))).not.toContain('different long enough password');
  });

  it('requires the configured setup token, applies secure cookies, and rejects an invalid CSRF origin', async () => {
    const subject = await fixture({ setupToken: 'test-setup-token', cookieSecure: true }); fixtures.push(subject);
    const denied = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'admin', displayName: 'Admin', password: adminPassword } });
    expect(denied.statusCode).toBe(403);
    const response = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'admin', displayName: 'Admin', password: adminPassword, setupToken: 'test-setup-token' } });
    expect(response.statusCode).toBe(201);
    const admin = { cookie: response.headers['set-cookie'] as string, csrf: response.json().csrfToken as string };
    expect(admin.cookie).toContain('Secure');
    expect((await subject.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { ...headers(admin.cookie, admin.csrf), origin: 'https://attacker.example' } })).statusCode).toBe(403);
  });

  it('honors absolute expiry, audits rejected logins, revokes another blocked user, and denies cross-user lookup', async () => {
    const subject = await fixture(); fixtures.push(subject);
    const admin = await setup(subject);
    const created = await subject.app.inject({ method: 'POST', url: '/api/v1/users', headers: headers(admin.cookie, admin.csrf), payload: { username: 'alice', displayName: 'Alice', initialPassword: 'a long enough password', role: 'user' } });
    const aliceId = created.json().user.id as string;
    const bob = await subject.app.inject({ method: 'POST', url: '/api/v1/users', headers: headers(admin.cookie, admin.csrf), payload: { username: 'bobby', displayName: 'Bob', initialPassword: 'another long password', role: 'user' } });
    const bobId = bob.json().user.id as string;
    const aliceLogin = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: 'a long enough password' } });
    const aliceCookie = aliceLogin.headers['set-cookie'] as string; const aliceCsrf = aliceLogin.json().csrfToken as string;
    await subject.app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: headers(aliceCookie, aliceCsrf), payload: { currentPassword: 'a long enough password', newPassword: 'different long enough password' } });
    expect((await subject.app.inject({ url: `/api/v1/users/${bobId}`, headers: { cookie: aliceCookie } })).statusCode).toBe(403);
    const bobLogin = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'bobby', password: 'another long password' } });
    const bobCookie = bobLogin.headers['set-cookie'] as string;
    expect((await subject.app.inject({ method: 'PATCH', url: `/api/v1/users/${bobId}`, headers: headers(admin.cookie, admin.csrf), payload: { status: 'blocked' } })).statusCode).toBe(204);
    expect((await subject.app.inject({ url: '/api/v1/users', headers: { cookie: bobCookie } })).statusCode).toBe(401);
    for (let hour = 0; hour < 6; hour += 1) { subject.advance(2 * 60 * 60 * 1000 - 1); expect((await subject.app.inject({ url: '/api/v1/users', headers: { cookie: admin.cookie } })).statusCode).toBe(200); }
    subject.advance(7);
    expect((await subject.app.inject({ url: '/api/v1/users', headers: { cookie: admin.cookie } })).statusCode).toBe(401);
    const rejected = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'nobody', password: adminPassword } });
    expect(rejected.statusCode).toBe(401);
    const audit = await subject.database.pool.query("SELECT action,outcome,target_id,details FROM audit_events WHERE action='auth.login_failed'");
    expect(audit.rows).toHaveLength(1);
    expect(JSON.stringify(audit.rows)).not.toContain(adminPassword);
    expect(JSON.stringify(audit.rows)).not.toContain('kura_session');
    expect(aliceId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('covers state, user administration error paths, and stable local account identity across T29/T30 logins', async () => {
    const subject = await fixture(); fixtures.push(subject);
    expect((await subject.app.inject({ url: '/api/v1/auth/state' })).json()).toMatchObject({ configured: false, authenticated: false });
    const admin = await setup(subject);
    expect((await subject.app.inject({ url: '/api/v1/auth/state', headers: { cookie: admin.cookie } })).json()).toMatchObject({ configured: true, authenticated: true, role: 'admin', csrfToken: admin.csrf });
    const first = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: adminPassword } });
    const second = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: adminPassword } });
    const firstHash = (await subject.database.pool.query('SELECT user_id FROM sessions WHERE csrf_token=$1', [first.json().csrfToken])).rows[0].user_id;
    const secondHash = (await subject.database.pool.query('SELECT user_id FROM sessions WHERE csrf_token=$1', [second.json().csrfToken])).rows[0].user_id;
    expect(firstHash).toBe(secondHash);
    const created = await subject.app.inject({ method: 'POST', url: '/api/v1/users', headers: headers(admin.cookie, admin.csrf), payload: { username: 'alice', displayName: 'Alice', initialPassword: 'a long enough password', role: 'user' } });
    const aliceId = created.json().user.id as string;
    expect((await subject.app.inject({ method: 'POST', url: '/api/v1/users', headers: headers(admin.cookie, admin.csrf), payload: { username: 'alice', displayName: 'Again', initialPassword: 'a long enough password' } })).statusCode).toBe(409);
    expect((await subject.app.inject({ method: 'PATCH', url: `/api/v1/users/${aliceId}`, headers: headers(admin.cookie, admin.csrf), payload: {} })).statusCode).toBe(400);
    expect((await subject.app.inject({ method: 'PATCH', url: '/api/v1/users/00000000-0000-0000-0000-000000000000', headers: headers(admin.cookie, admin.csrf), payload: { status: 'blocked' } })).statusCode).toBe(404);
    expect((await subject.app.inject({ method: 'PATCH', url: `/api/v1/users/${admin.id}`, headers: headers(admin.cookie, admin.csrf), payload: { role: 'user' } })).statusCode).toBe(409);
    const aliceLogin = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: 'a long enough password' } });
    const aliceCookie = aliceLogin.headers['set-cookie'] as string; const aliceCsrf = aliceLogin.json().csrfToken as string;
    await subject.app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: headers(aliceCookie, aliceCsrf), payload: { currentPassword: 'a long enough password', newPassword: 'different long enough password' } });
    expect((await subject.app.inject({ method: 'PATCH', url: `/api/v1/users/${aliceId}`, headers: headers(aliceCookie, aliceCsrf), payload: { status: 'blocked' } })).statusCode).toBe(403);
  });

  it('revokes other sessions after a password change while preserving the current session', async () => {
    const subject = await fixture(); fixtures.push(subject);
    const admin = await setup(subject);
    const created = await subject.app.inject({ method: 'POST', url: '/api/v1/users', headers: headers(admin.cookie, admin.csrf), payload: { username: 'alice', displayName: 'Alice', initialPassword: 'a long enough password', role: 'user' } });
    expect(created.statusCode).toBe(201);
    const initial = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: 'a long enough password' } });
    await subject.app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: headers(initial.headers['set-cookie'] as string, initial.json().csrfToken as string), payload: { currentPassword: 'a long enough password', newPassword: 'different long enough password' } });
    const current = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: 'different long enough password' } });
    const other = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: 'different long enough password' } });
    expect((await subject.app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: headers(current.headers['set-cookie'] as string, current.json().csrfToken as string), payload: { currentPassword: 'different long enough password', newPassword: 'a third long password value' } })).statusCode).toBe(204);
    expect((await subject.app.inject({ url: '/api/v1/users', headers: { cookie: current.headers['set-cookie'] as string } })).statusCode).toBe(200);
    expect((await subject.app.inject({ url: '/api/v1/users', headers: { cookie: other.headers['set-cookie'] as string } })).statusCode).toBe(401);
  });

  it('throttles username and source buckets independently with clock-controlled increasing windows', async () => {
    const subject = await fixture({ trustProxy: true }); fixtures.push(subject);
    await setup(subject, 'alice');
    const login = (username: string, password: string, source: string) => subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', headers: { 'x-forwarded-for': source }, payload: { username, password } });
    for (let index = 0; index < 5; index += 1) await login('alice', 'wrong password value', `203.0.113.${index + 1}`);
    const usernameLock = (await subject.database.pool.query("SELECT locked_until FROM login_attempts WHERE subject='alice' AND source_address='*'")).rows[0].locked_until as Date;
    expect(usernameLock.getTime()).toBe(new Date('2026-10-06T12:00:30.000Z').getTime());
    expect((await login('alice', adminPassword, '203.0.113.99')).statusCode).toBe(401);
    subject.advance(30_001);
    expect((await login('alice', adminPassword, '203.0.113.99')).statusCode).toBe(200);
    for (let index = 0; index < 5; index += 1) await login(`source${index}`, 'wrong password value', '198.51.100.9');
    for (const seconds of [30, 60, 120, 240, 480, 900]) {
      const locked = (await subject.database.pool.query("SELECT locked_until FROM login_attempts WHERE subject='*' AND source_address='198.51.100.9'")).rows[0].locked_until as Date;
      const now = subject.advance(0);
      expect(locked.getTime()).toBe(now.getTime() + seconds * 1000);
      subject.advance(seconds * 1000 + 1);
      await login(`more${seconds}`, 'wrong password value', '198.51.100.9');
    }
  });

  it('audits successful and rejected state changes without recording credentials or sessions', async () => {
    const subject = await fixture(); fixtures.push(subject);
    const admin = await setup(subject);
    expect((await subject.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: { cookie: admin.cookie } })).statusCode).toBe(403);
    expect((await subject.app.inject({ method: 'POST', url: '/api/v1/auth/logout', headers: headers(admin.cookie, admin.csrf) })).statusCode).toBe(204);
    const login = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'admin', password: adminPassword } });
    const current = { cookie: login.headers['set-cookie'] as string, csrf: login.json().csrfToken as string };
    expect((await subject.app.inject({ method: 'POST', url: '/api/v1/users', headers: headers(current.cookie, current.csrf), payload: {} })).statusCode).toBe(400);
    const created = await subject.app.inject({ method: 'POST', url: '/api/v1/users', headers: headers(current.cookie, current.csrf), payload: { username: 'alice', displayName: 'Alice', initialPassword: 'a long enough password' } });
    expect((await subject.app.inject({ method: 'PATCH', url: `/api/v1/users/${created.json().user.id as string}`, headers: headers(current.cookie, current.csrf), payload: { status: 'blocked' } })).statusCode).toBe(204);
    expect((await subject.app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: headers(current.cookie, current.csrf), payload: { currentPassword: 'wrong password value', newPassword: 'a third long password value' } })).statusCode).toBe(401);
    const audit = await subject.database.pool.query('SELECT actor_user_id,action,target_id,outcome,occurred_at,details FROM audit_events ORDER BY occurred_at');
    expect(audit.rows.map((row) => row.action)).toEqual(expect.arrayContaining(['auth.logout', 'user.update', 'post.rejected']));
    expect(audit.rows.every((row) => row.outcome && row.occurred_at && row.details.sourceAddress)).toBe(true);
    expect(JSON.stringify(audit.rows)).not.toContain('wrong password value');
    expect(JSON.stringify(audit.rows)).not.toContain('kura_session');
  });
});
