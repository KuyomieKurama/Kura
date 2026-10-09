import { Writable } from 'node:stream';
import { Pool } from 'pg';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../apps/api/src/app.js';
import { ManualClock } from '../../packages/scheduler/src/index.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';

/** Obviously fake 32-byte key for tests only. */
export const TEST_SECRET_KEY = Buffer.alloc(32, 7);

const INITIAL_PASSWORD = 'an initial password for tests';
const PASSWORD = 'a long password for the test user';

export interface CredentialLogin {
  cookie: string;
  csrf: string;
  userId: string;
}

export interface CredentialFixture {
  app: FastifyInstance;
  pool: Pool;
  clock: ManualClock;
  /** Everything the API wrote to its log. */
  logs: () => string;
  addUser: (username: string) => Promise<CredentialLogin>;
  /** Sends the text as the body of a request (cookies.txt upload). */
  putText: (login: CredentialLogin | null, text: string, contentType?: string) => ReturnType<FastifyInstance['inject']>;
  call: (login: CredentialLogin | null, method: 'GET' | 'POST' | 'DELETE', url: string) => ReturnType<FastifyInstance['inject']>;
  cleanup: () => Promise<void>;
}

/** The API on a real PostgreSQL database with Instagram credential routes; the secret key is optional. */
export async function createCredentialFixture(options: { secretKey?: Buffer } = { secretKey: TEST_SECRET_KEY }): Promise<CredentialFixture> {
  const database = await createTestDatabase();
  const migrations = await createMigrationsCopy();
  await runMigrations(database.pool, migrations.directory);

  let logText = '';
  const logStream = new Writable({
    write(chunk, _encoding, done) {
      logText += chunk.toString();
      done();
    }
  });

  const clock = new ManualClock('2026-06-01T10:00:00Z');
  const appPool = new Pool({ connectionString: database.databaseUrl });
  const app = buildApp({
    databaseUrl: 'not-logged',
    host: '127.0.0.1',
    port: 8080,
    trustProxy: false,
    cookieSecure: false,
    storage: { backend: 'database', root: './unused', quotaBytes: 1024 * 1024, layout: 'cas' },
    ...(options.secretKey ? { secretKey: options.secretKey } : {})
  }, appPool, undefined, clock, { logStream });

  const headers = (login: CredentialLogin | null) => login
    ? { cookie: login.cookie, 'x-kura-csrf': login.csrf, origin: 'http://localhost', host: 'localhost' }
    : { origin: 'http://localhost', host: 'localhost' };

  const setup = await app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username: 'admin', displayName: 'Admin', password: PASSWORD } });
  const admin: CredentialLogin = { cookie: String(setup.headers['set-cookie']), csrf: setup.json().csrfToken, userId: setup.json().user.id };

  return {
    app,
    pool: database.pool,
    clock,
    logs: () => logText,
    addUser: async (username) => {
      const created = await app.inject({
        method: 'POST', url: '/api/v1/users', headers: headers(admin),
        payload: { username, displayName: username, initialPassword: INITIAL_PASSWORD, role: 'user' }
      });
      const login = await app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username, password: INITIAL_PASSWORD } });
      const session: CredentialLogin = { cookie: String(login.headers['set-cookie']), csrf: login.json().csrfToken, userId: created.json().user.id };
      await app.inject({
        method: 'POST', url: '/api/v1/auth/change-password', headers: headers(session),
        payload: { currentPassword: INITIAL_PASSWORD, newPassword: PASSWORD }
      });
      return session;
    },
    putText: (login, text, contentType = 'text/plain; charset=utf-8') => app.inject({
      method: 'PUT', url: '/api/v1/credentials/instagram', headers: { ...headers(login), 'content-type': contentType }, payload: text
    }),
    call: (login, method, url) => app.inject({ method, url, headers: headers(login) }),
    cleanup: async () => {
      await app.close();
      await migrations.cleanup();
      await database.cleanup();
    }
  };
}
