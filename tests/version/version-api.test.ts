import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import type { ApiConfig } from '../../apps/api/src/config.js';
import { PostgresUpdateCheckStore, UpdateChecker } from '../../apps/api/src/update-check.js';
import { ManualClock } from '../../packages/scheduler/src/index.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';
import { FakeGithub } from './fake-github.js';

const TAGS = '/repos/o/r/tags';
const LATEST = '/repos/o/r/releases/latest';
const PASSWORD = 'a long password for the test user';
const INITIAL = 'an initial password for tests';

interface Login { cookie: string; csrf: string; userId: string }

let github: FakeGithub;
let app: FastifyInstance;
let pool: Pool;
let cleanup: () => Promise<void>;
let admin: Login;
let user: Login;
let disabledApp: FastifyInstance;
let disabledPool: Pool;

function baseConfig(update: ApiConfig['update']): ApiConfig {
  return {
    databaseUrl: 'not-logged', host: '127.0.0.1', port: 8080, trustProxy: false, cookieSecure: false,
    storage: { backend: 'database', root: './unused', quotaBytes: 1024 * 1024, layout: 'cas' },
    build: { version: '0.2.0', commit: 'abcdef1' }, update
  };
}

function call(login: Login | null, method: 'GET' | 'POST', url: string, payload?: unknown, target: FastifyInstance = app) {
  return target.inject({
    method, url,
    headers: login ? { cookie: login.cookie, 'x-kura-csrf': login.csrf, origin: 'http://localhost', host: 'localhost' } : { origin: 'http://localhost', host: 'localhost' },
    ...(payload === undefined ? {} : { payload: payload as object })
  });
}

async function setupAdmin(target: FastifyInstance): Promise<Login> {
  const response = await target.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'admin', displayName: 'Admin', password: PASSWORD } });
  return { cookie: String(response.headers['set-cookie']), csrf: response.json().csrfToken, userId: response.json().user.id };
}

beforeAll(async () => {
  github = new FakeGithub();
  github.json(TAGS, [{ name: 'v0.3.0' }, { name: 'v0.2.0' }, { name: 'm5' }], 200, { etag: '"t1"' });
  github.json(LATEST, { tag_name: 'v0.3.0', body: 'Neu: <script>alert(1)</script>' });
  await github.start();

  const database = await createTestDatabase();
  const migrations = await createMigrationsCopy();
  await runMigrations(database.pool, migrations.directory);
  const clock = new ManualClock('2026-10-11T12:00:00Z');
  pool = new Pool({ connectionString: database.databaseUrl });
  const update = { enabled: true, repository: 'o/r', apiBase: github.apiBase, channel: 'stable' as const };
  const checker = new UpdateChecker({ build: { version: '0.2.0', commit: 'abcdef1' }, settings: update, store: new PostgresUpdateCheckStore(pool), clock });
  app = buildApp(baseConfig(update), pool, undefined, clock, { updateChecker: checker });
  admin = await setupAdmin(app);
  const created = await call(admin, 'POST', '/api/v1/users', { username: 'alice', displayName: 'Alice', initialPassword: INITIAL, role: 'user' });
  const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: INITIAL } });
  user = { cookie: String(login.headers['set-cookie']), csrf: login.json().csrfToken, userId: created.json().user.id };
  await call(user, 'POST', '/api/v1/auth/change-password', { currentPassword: INITIAL, newPassword: PASSWORD });

  // A second app on the same database with the check switched off: the sessions are shared.
  disabledPool = new Pool({ connectionString: database.databaseUrl });
  disabledApp = buildApp(baseConfig({ ...update, enabled: false }), disabledPool, undefined, clock);

  cleanup = async () => {
    await app.close();
    await disabledApp.close();
    await migrations.cleanup();
    await database.cleanup();
    await github.stop();
  };
});

afterAll(async () => { await cleanup(); });

describe('GET /api/v1/status', () => {
  it('returns the real version instead of a fixed string, and keeps the commit for signed-in users', async () => {
    const response = await call(null, 'GET', '/api/v1/status');
    expect(response.json()).toMatchObject({ version: '0.2.0', database: 'ok' });
    expect(response.json()).not.toHaveProperty('commit');
  });
});

describe('GET /api/v1/version', () => {
  it('requires a session', async () => {
    expect((await call(null, 'GET', '/api/v1/version')).statusCode).toBe(401);
  });

  it('answers before the first check with the running version and status unknown, without a request to GitHub', async () => {
    const response = await call(user, 'GET', '/api/v1/version');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ version: '0.2.0', commit: 'abcdef1', status: 'unknown', latestVersion: null, checkEnabled: true, noticeDismissed: false });
    expect(github.requests).toHaveLength(0);
  });
});

describe('POST /api/v1/version/check', () => {
  it('is for administrators only', async () => {
    expect((await call(null, 'POST', '/api/v1/version/check')).statusCode).toBe(403);
    expect((await call(user, 'POST', '/api/v1/version/check')).statusCode).toBe(403);
    expect(github.requests).toHaveLength(0);
  });

  it('checks now, answers with the result, persists it and writes an audit entry', async () => {
    const response = await call(admin, 'POST', '/api/v1/version/check');
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      status: 'outdated', version: '0.2.0', latestVersion: '0.3.0', latestTag: 'v0.3.0', hasRelease: true,
      releaseUrl: 'https://github.com/o/r/releases/tag/v0.3.0', releaseNotes: 'Neu: <script>alert(1)</script>', channel: 'stable', repository: 'o/r'
    });
    const stored = await pool.query('SELECT latest_version, tags_etag FROM update_check_state');
    expect(stored.rows).toEqual([{ latest_version: '0.3.0', tags_etag: '"t1"' }]);
    const audit = await pool.query("SELECT actor_user_id FROM audit_events WHERE action = 'version.check'");
    expect(audit.rows).toEqual([{ actor_user_id: admin.userId }]);
    expect(github.requestsTo(TAGS)[0]?.headers['user-agent']).toBe('Kura/0.2.0 (+https://github.com/o/r)');
  });

  it('shows the result to every signed-in user afterwards, as plain data', async () => {
    const response = await call(user, 'GET', '/api/v1/version');
    expect(response.json()).toMatchObject({ status: 'outdated', latestVersion: '0.3.0' });
    expect(String(response.headers['content-type'])).toContain('application/json');
  });
});

describe('dismissing the notice', () => {
  it('is for administrators only and validates the version', async () => {
    expect((await call(user, 'POST', '/api/v1/version/dismiss', { version: '0.3.0' })).statusCode).toBe(403);
    expect((await call(admin, 'POST', '/api/v1/version/dismiss', { version: 'neu' })).statusCode).toBe(400);
    expect((await call(admin, 'POST', '/api/v1/version/dismiss', {})).statusCode).toBe(400);
  });

  it('is remembered per user and per offered version', async () => {
    expect((await call(admin, 'GET', '/api/v1/version')).json().noticeDismissed).toBe(false);
    expect((await call(admin, 'POST', '/api/v1/version/dismiss', { version: 'v0.3.0' })).statusCode).toBe(204);
    expect((await call(admin, 'GET', '/api/v1/version')).json().noticeDismissed).toBe(true);
    // Another user is not affected, and a user who is not an administrator never has a dismissal.
    expect((await call(user, 'GET', '/api/v1/version')).json().noticeDismissed).toBe(false);
    // A newer offered version shows the notice again.
    github.json(TAGS, [{ name: 'v0.4.0' }, { name: 'v0.3.0' }], 200, { etag: '"t2"' });
    const response = await call(admin, 'POST', '/api/v1/version/check');
    expect(response.json()).toMatchObject({ latestVersion: '0.4.0', noticeDismissed: false });
    expect((await call(admin, 'GET', '/api/v1/version')).json().noticeDismissed).toBe(false);
  });
});

describe('with the check switched off', () => {
  it('reports disabled, refuses an on-demand check and sends nothing', async () => {
    const before = github.requests.length;
    const view = await call(admin, 'GET', '/api/v1/version', undefined, disabledApp);
    expect(view.json()).toMatchObject({ status: 'disabled', checkEnabled: false, version: '0.2.0' });
    const check = await call(admin, 'POST', '/api/v1/version/check', undefined, disabledApp);
    expect(check.statusCode).toBe(409);
    expect(check.json().error.code).toBe('UPDATE_CHECK_DISABLED');
    expect(github.requests.length).toBe(before);
  });
});

describe('no route can update the host', () => {
  it('has no route that installs or deploys anything', async () => {
    for (const url of ['/api/v1/version/update', '/api/v1/version/upgrade', '/api/v1/version/install', '/api/v1/update']) {
      const response = await call(admin, 'POST', url);
      expect(response.statusCode, url).toBe(404);
    }
  });
});
