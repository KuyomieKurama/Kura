import { randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Pool } from 'pg';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../../apps/api/src/app.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';

const key = randomBytes(32).toString('base64');
const password = 'correct horse battery staple';
const config = {
  databaseUrl: 'not-logged',
  host: '127.0.0.1',
  port: 8080,
  trustProxy: false,
  cookieSecure: false,
  secretKey: Buffer.from(key, 'base64'),
  storage: { backend: 'database' as const, root: './unused', quotaBytes: 1024 * 1024, layout: 'cas' as const }
};

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Login = { cookie: string; csrf: string };

class FakeImmich {
  uploads = 0;
  readonly bytes = Buffer.from('test file original bytes');
  private readonly assets = new Map<string, Buffer>();
  private readonly server = createServer((request, response) => { void this.route(request, response); });

  constructor(private readonly uncertainUpload = false) {}

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    const address = this.server.address();
    if (!address || typeof address === 'string') throw new Error('Fake Immich did not bind');
    return `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve()));
  }

  private send(response: ServerResponse, status: number, body: unknown): void {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify(body));
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://fake').pathname;
    if (path === '/api/server/ping') return this.send(response, 200, { ping: 'pong' });
    if (path === '/api/server/version') return this.send(response, 200, { major: 3, minor: 2, patch: 1, prerelease: null });
    if (path === '/api/users/me') return this.send(response, 200, { id: 'fake-account' });
    if (path === '/api/assets/bulk-upload-check') return this.send(response, 200, { results: [] });
    if (path === '/api/assets' && request.method === 'POST') {
      this.uploads += 1;
      if (this.uncertainUpload) {
        request.once('data', () => request.socket.destroy());
        return;
      }
      for await (const chunk of request) { void chunk; }
      this.assets.set('fake-asset', this.bytes);
      return this.send(response, 201, { id: 'fake-asset', status: 'created' });
    }
    const match = /^\/api\/assets\/([^/]+)(?:\/(original))?$/.exec(path);
    if (match) {
      const asset = this.assets.get(match[1]!);
      if (!asset) return this.send(response, 404, {});
      if (match[2] === 'original') {
        response.writeHead(200, { 'content-type': 'application/octet-stream' });
        response.end(asset);
        return;
      }
      return this.send(response, 200, { id: match[1], ownerId: 'fake-account' });
    }
    return this.send(response, 404, {});
  }
}

async function fixture(uncertainUpload = false) {
  const database = await createTestDatabase();
  const migrations = await createMigrationsCopy();
  await runMigrations(database.pool, migrations.directory);
  const fake = new FakeImmich(uncertainUpload);
  const serverUrl = await fake.start();
  const app = buildApp(config, new Pool({ connectionString: database.databaseUrl }));
  return { app, database, migrations, fake, serverUrl };
}

async function setup(subject: Fixture, username = 'admin'): Promise<Login> {
  const response = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/setup', payload: { username, displayName: username, password } });
  return { cookie: response.headers['set-cookie'] as string, csrf: response.json().csrfToken as string };
}

function headers(login: Login) {
  return { cookie: login.cookie, 'x-kura-csrf': login.csrf, origin: 'http://localhost', host: 'localhost' };
}

async function saveConnection(subject: Fixture, login: Login) {
  const response = await subject.app.inject({
    method: 'PUT',
    url: '/api/v1/immich/connection',
    headers: headers(login),
    payload: { serverUrl: subject.serverUrl, apiKey: 'test-api-key-not-to-log' }
  });
  expect(response.statusCode).toBe(204);
}

describe('W2 Immich test transfer wiring', () => {
  const fixtures: Fixture[] = [];
  afterEach(async () => {
    await Promise.all(fixtures.splice(0).map(async (subject) => {
      await subject.app.close();
      await subject.fake.stop();
      await subject.migrations.cleanup();
      await subject.database.cleanup();
    }));
  });

  it('transfers a test file against fake Immich, persists evidence, and retains the local original', async () => {
    const subject = await fixture();
    fixtures.push(subject);
    const admin = await setup(subject);
    await saveConnection(subject, admin);

    const response = await subject.app.inject({
      method: 'POST',
      url: '/api/v1/immich/test-transfer',
      headers: headers(admin),
      payload: { fileName: 'test.jpg', contentBase64: subject.fake.bytes.toString('base64') }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().transfer).toMatchObject({ status: 'verified', localOriginalRetained: true });
    const transferId = response.json().transfer.id as string;
    const status = await subject.app.inject({ url: `/api/v1/immich/transfers/${transferId}`, headers: { cookie: admin.cookie } });
    expect(status.json().transfer).toMatchObject({ status: 'verified', localOriginalRetained: true, evidence: { serverVersion: '3.2.1', byteLength: subject.fake.bytes.length, album: 'none' } });
    expect(subject.fake.uploads).toBe(1);
    expect((await subject.database.pool.query('SELECT count(*)::int AS count FROM blobstore_objects')).rows[0].count).toBe(1);

    const created = await subject.app.inject({ method: 'POST', url: '/api/v1/users', headers: headers(admin), payload: { username: 'alice', displayName: 'Alice', initialPassword: 'a sufficiently long password', role: 'user' } });
    expect(created.statusCode).toBe(201);
    const login = await subject.app.inject({ method: 'POST', url: '/api/v1/auth/login', payload: { username: 'alice', password: 'a sufficiently long password' } });
    const alice = { cookie: login.headers['set-cookie'] as string, csrf: login.json().csrfToken as string };
    await subject.app.inject({ method: 'POST', url: '/api/v1/auth/change-password', headers: headers(alice), payload: { currentPassword: 'a sufficiently long password', newPassword: 'another sufficiently long password' } });
    const foreignStatus = await subject.app.inject({ url: `/api/v1/immich/transfers/${transferId}`, headers: { cookie: alice.cookie } });
    expect(foreignStatus.statusCode).toBe(404);
  });

  it('keeps the transfer reconciling after an uncertain upload and does not delete its local original', async () => {
    const subject = await fixture(true);
    fixtures.push(subject);
    const admin = await setup(subject);
    await saveConnection(subject, admin);

    const response = await subject.app.inject({
      method: 'POST',
      url: '/api/v1/immich/test-transfer',
      headers: headers(admin),
      payload: { fileName: 'uncertain.jpg', contentBase64: subject.fake.bytes.toString('base64') }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().transfer).toMatchObject({ status: 'reconciling', localOriginalRetained: true });
    expect((await subject.database.pool.query('SELECT count(*)::int AS count FROM blobstore_objects')).rows[0].count).toBe(1);
  });
});
