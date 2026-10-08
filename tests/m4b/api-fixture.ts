import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { ManualClock } from '../../packages/scheduler/src/index.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';

const config = {
  databaseUrl: 'not-logged',
  host: '127.0.0.1',
  port: 8080,
  trustProxy: false,
  cookieSecure: false,
  storage: { backend: 'database' as const, root: './unused', quotaBytes: 1024 * 1024, layout: 'cas' as const }
};

const INITIAL_PASSWORD = 'an initial password for tests';
const PASSWORD = 'a long password for the test user';

export interface TestLogin {
  cookie: string;
  csrf: string;
  userId: string;
}

export interface ApiFixture {
  app: FastifyInstance;
  pool: Pool;
  clock: ManualClock;
  admin: TestLogin;
  /** Creates a normal user through the admin API and returns a ready session (password already changed). */
  addUser: (username: string) => Promise<TestLogin>;
  /** Sends an authenticated JSON request. */
  call: (login: TestLogin | null, method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE', url: string, payload?: unknown) => ReturnType<FastifyInstance['inject']>;
  cleanup: () => Promise<void>;
}

export async function createApiFixture(start = '2026-06-01T10:00:00Z'): Promise<ApiFixture> {
  const database = await createTestDatabase();
  const migrations = await createMigrationsCopy();
  await runMigrations(database.pool, migrations.directory);

  const clock = new ManualClock(start);
  // The app owns this pool and closes it with the app; the database helper closes its own.
  const appPool = new Pool({ connectionString: database.databaseUrl });
  const app = buildApp(config, appPool, undefined, clock);

  const call: ApiFixture['call'] = (login, method, url, payload) =>
    app.inject({
      method,
      url,
      headers: login
        ? { cookie: login.cookie, 'x-kura-csrf': login.csrf, origin: 'http://localhost', host: 'localhost' }
        : { origin: 'http://localhost', host: 'localhost' },
      ...(payload === undefined ? {} : { payload: payload as object })
    });

  const setupResponse = await app.inject({
    method: 'POST',
    url: '/api/v1/auth/setup',
    payload: { username: 'admin', displayName: 'Admin', password: PASSWORD }
  });
  const admin: TestLogin = {
    cookie: String(setupResponse.headers['set-cookie']),
    csrf: setupResponse.json().csrfToken,
    userId: setupResponse.json().user.id
  };

  const addUser = async (username: string): Promise<TestLogin> => {
    const created = await call(admin, 'POST', '/api/v1/users', {
      username, displayName: username, initialPassword: INITIAL_PASSWORD, role: 'user'
    });
    const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: INITIAL_PASSWORD } });
    const session: TestLogin = {
      cookie: String(login.headers['set-cookie']),
      csrf: login.json().csrfToken,
      userId: created.json().user.id
    };
    await call(session, 'POST', '/api/v1/auth/change-password', { currentPassword: INITIAL_PASSWORD, newPassword: PASSWORD });
    return session;
  };

  return {
    app,
    pool: database.pool,
    clock,
    admin,
    addUser,
    call,
    cleanup: async () => {
      await app.close();
      await migrations.cleanup();
      await database.cleanup();
    }
  };
}
