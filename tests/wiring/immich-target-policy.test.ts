import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';

const config = {
  databaseUrl: 'not-logged',
  host: '127.0.0.1',
  port: 8080,
  trustProxy: false,
  cookieSecure: false,
  secretKey: randomBytes(32),
  storage: { backend: 'database' as const, root: './unused', quotaBytes: 1024 * 1024, layout: 'cas' as const }
};
const approvalsUrl = '/api/v1/admin/immich/endpoint-approvals';
const userPassword = 'another sufficiently long password';

type Login = { cookie: string; csrf: string };
type Responder = (request: IncomingMessage, response: ServerResponse) => void;

class Listener {
  hits = 0;
  private readonly server = createServer((request, response) => {
    this.hits += 1;
    this.respond(request, response);
  });
  constructor(private readonly respond: Responder) {}

  async start(): Promise<number> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('listener did not bind');
    return address.port;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }
}

const fakeImmich: Responder = (request, response) => {
  const path = new URL(request.url ?? '/', 'http://fake').pathname;
  const bodies: Record<string, unknown> = {
    '/api/server/ping': { ping: 'pong' },
    '/api/server/version': { major: 3, minor: 2, patch: 1, prerelease: null },
    '/api/users/me': { id: 'fake-account' }
  };
  response.writeHead(bodies[path] ? 200 : 404, { 'content-type': 'application/json' });
  response.end(JSON.stringify(bodies[path] ?? {}));
};

describe('Immich target policy through the API', () => {
  const cleanups: Array<() => Promise<void>> = [];
  afterEach(async () => {
    for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  });

  async function listen(respond: Responder = fakeImmich) {
    const listener = new Listener(respond);
    const port = await listener.start();
    cleanups.push(() => listener.stop());
    return { listener, port };
  }

  async function startApp(resolveImmichHost?: (host: string) => Promise<string[]>) {
    const database = await createTestDatabase();
    const migrations = await createMigrationsCopy();
    await runMigrations(database.pool, migrations.directory);
    const app = buildApp(config, new Pool({ connectionString: database.databaseUrl }), undefined, undefined, { resolveImmichHost });
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
    const admin: Login = { cookie: setup.headers['set-cookie'] as string, csrf: setup.json().csrfToken as string };
    return { app, database, admin };
  }

  const headers = (login: Login) => ({ cookie: login.cookie, 'x-kura-csrf': login.csrf, origin: 'http://localhost', host: 'localhost' });
  type Subject = Awaited<ReturnType<typeof startApp>>;

  async function createUser(subject: Subject): Promise<Login> {
    await subject.app.inject({
      method: 'POST', url: '/api/v1/users', headers: headers(subject.admin),
      payload: { username: 'alice', displayName: 'Alice', initialPassword: 'a sufficiently long password', role: 'user' }
    });
    const login = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: 'a sufficiently long password' } });
    const alice: Login = { cookie: login.headers['set-cookie'] as string, csrf: login.json().csrfToken as string };
    await subject.app.inject({
      method: 'POST', url: '/api/v1/auth/change-password', headers: headers(alice),
      payload: { currentPassword: 'a sufficiently long password', newPassword: userPassword }
    });
    return alice;
  }

  async function saveConnection(subject: Subject, login: Login, serverUrl: string) {
    return subject.app.inject({ method: 'PUT', url: '/api/v1/immich/connection', headers: headers(login), payload: { serverUrl, apiKey: 'test-key' } });
  }

  const testConnection = (subject: Subject, login: Login) =>
    subject.app.inject({ method: 'POST', url: '/api/v1/immich/connection/test', headers: headers(login) });

  const approve = (subject: Subject, login: Login, host: string, port: number) =>
    subject.app.inject({ method: 'POST', url: approvalsUrl, headers: headers(login), payload: { host, port } });

  it('blocks a loopback Immich endpoint by default for the connection test and the test transfer', async () => {
    const subject = await startApp();
    const { listener, port } = await listen();
    expect((await saveConnection(subject, subject.admin, `http://127.0.0.1:${port}`)).statusCode).toBe(204);

    const test = (await testConnection(subject, subject.admin)).json();
    expect(test).toMatchObject({ version: 'unbekannt', error: { code: 'IMMICH_TARGET_NOT_APPROVED' }, target: { host: '127.0.0.1', port } });

    const transfer = await subject.app.inject({
      method: 'POST', url: '/api/v1/immich/test-transfer', headers: headers(subject.admin),
      payload: { fileName: 'a.bin', contentBase64: Buffer.from('bytes').toString('base64') }
    });
    expect(transfer.statusCode).toBe(403);
    expect(transfer.json().error.code).toBe('IMMICH_TARGET_NOT_APPROVED');
    expect(listener.hits).toBe(0);
    const stored = await subject.database.pool.query('SELECT count(*)::int AS count FROM blobstore_objects');
    expect(stored.rows[0].count).toBe(0);
  });

  it('allows exactly the endpoint an administrator approved, and blocks it again after revocation', async () => {
    const subject = await startApp();
    const { listener, port } = await listen();
    const other = await listen();
    await saveConnection(subject, subject.admin, `http://127.0.0.1:${port}`);

    const approved = await approve(subject, subject.admin, '127.0.0.1', port);
    expect(approved.statusCode).toBe(201);
    expect((await testConnection(subject, subject.admin)).json()).toMatchObject({ version: '3.2.1' });
    expect(listener.hits).toBeGreaterThan(0);

    const listed = await subject.app.inject({ url: approvalsUrl, headers: { cookie: subject.admin.cookie } });
    expect(listed.json().approvals).toMatchObject([{ host: '127.0.0.1', port }]);

    await saveConnection(subject, subject.admin, `http://127.0.0.1:${other.port}`);
    expect((await testConnection(subject, subject.admin)).json()).toMatchObject({ error: { code: 'IMMICH_TARGET_NOT_APPROVED' } });
    expect(other.listener.hits).toBe(0);

    await saveConnection(subject, subject.admin, `http://127.0.0.1:${port}`);
    const revoked = await subject.app.inject({ method: 'DELETE', url: `${approvalsUrl}/127.0.0.1/${port}`, headers: headers(subject.admin) });
    expect(revoked.statusCode).toBe(204);
    expect((await testConnection(subject, subject.admin)).json()).toMatchObject({ error: { code: 'IMMICH_TARGET_NOT_APPROVED' } });
  });

  it('does not let a non-admin user approve or list endpoints', async () => {
    const subject = await startApp();
    const alice = await createUser(subject);
    const { listener, port } = await listen();

    const attempt = await approve(subject, alice, '127.0.0.1', port);
    expect(attempt.statusCode).toBe(403);
    expect((await subject.app.inject({ url: approvalsUrl, headers: { cookie: alice.cookie } })).statusCode).toBe(403);
    expect((await subject.app.inject({ method: 'DELETE', url: `${approvalsUrl}/127.0.0.1/${port}`, headers: headers(alice) })).statusCode).toBe(403);
    expect((await subject.database.pool.query('SELECT 1 FROM immich_endpoint_approvals')).rowCount).toBe(0);

    await saveConnection(subject, alice, `http://127.0.0.1:${port}`);
    expect((await testConnection(subject, alice)).json()).toMatchObject({ error: { code: 'IMMICH_TARGET_NOT_APPROVED' } });
    expect(listener.hits).toBe(0);

    // An approval by the administrator applies to the endpoint, so alice may use it afterwards.
    expect((await approve(subject, subject.admin, '127.0.0.1', port)).statusCode).toBe(201);
    expect((await testConnection(subject, alice)).json()).toMatchObject({ version: '3.2.1' });
  });

  it('always blocks link-local and metadata targets, even for administrators', async () => {
    const resolved: Record<string, string[]> = { 'metadata.test': ['169.254.169.254'], 'v6.test': ['fe80::1'] };
    const subject = await startApp(async (host) => resolved[host] ?? []);

    expect((await saveConnection(subject, subject.admin, 'http://169.254.169.254/')).statusCode).toBe(400);
    expect((await saveConnection(subject, subject.admin, 'http://[fe80::1]:2283')).statusCode).toBe(400);
    expect((await saveConnection(subject, subject.admin, 'http://[::ffff:169.254.169.254]/')).statusCode).toBe(400);
    expect((await approve(subject, subject.admin, '169.254.169.254', 80)).statusCode).toBe(400);
    expect((await approve(subject, subject.admin, 'fe80::1', 2283)).statusCode).toBe(400);

    // A host name that resolves to a metadata address is blocked even when the name itself is approved.
    expect((await approve(subject, subject.admin, 'metadata.test', 2283)).statusCode).toBe(201);
    await saveConnection(subject, subject.admin, 'http://metadata.test:2283');
    expect((await testConnection(subject, subject.admin)).json()).toMatchObject({ error: { code: 'IMMICH_TARGET_BLOCKED' } });
    await saveConnection(subject, subject.admin, 'http://v6.test:2283');
    await approve(subject, subject.admin, 'v6.test', 2283);
    expect((await testConnection(subject, subject.admin)).json()).toMatchObject({ error: { code: 'IMMICH_TARGET_BLOCKED' } });
  });

  it('rejects invalid approval requests and URLs with credentials', async () => {
    const subject = await startApp();
    for (const payload of [{}, { host: '', port: 80 }, { host: 'a/b', port: 80 }, { host: 'immich.lan', port: 0 }, { host: 'immich.lan', port: '80' }]) {
      const response = await subject.app.inject({ method: 'POST', url: approvalsUrl, headers: headers(subject.admin), payload });
      expect(response.statusCode, JSON.stringify(payload)).toBe(400);
    }
    expect((await saveConnection(subject, subject.admin, 'https://user:secret@immich.example')).statusCode).toBe(400);
    expect((await saveConnection(subject, subject.admin, 'ftp://immich.example')).statusCode).toBe(400);
  });

  it('does not follow a redirect from an approved Immich endpoint to another private address', async () => {
    const subject = await startApp();
    const target = await listen();
    const redirecting = await listen((_request, response) => {
      response.writeHead(302, { location: `http://127.0.0.1:${target.port}/api/server/ping` });
      response.end();
    });
    await approve(subject, subject.admin, '127.0.0.1', redirecting.port);
    await approve(subject, subject.admin, '127.0.0.1', target.port);
    await saveConnection(subject, subject.admin, `http://127.0.0.1:${redirecting.port}`);

    const result = (await testConnection(subject, subject.admin)).json();
    expect(result).toEqual({ version: 'unbekannt', supported: false });
    expect(redirecting.listener.hits).toBeGreaterThan(0);
    expect(target.listener.hits).toBe(0);
  });
});
