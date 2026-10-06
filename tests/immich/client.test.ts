import { createHash, randomUUID } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { ImmichClient, TransferRepository, TransferService, decideLocalDeletion, type LocalObject, type SecretResolver } from '../../packages/immich-client/src/index.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';

const bytes = new TextEncoder().encode('original test bytes');
const sha256 = createHash('sha256').update(bytes).digest('hex');
const sha1 = createHash('sha1').update(bytes).digest('hex');
const local = (): LocalObject => ({ bytes: (async function* () { yield bytes; })(), sha256, sha1, byteLength: bytes.length, fileName: 'original.jpg', createdAt: new Date('2026-01-01T00:00:00Z'), modifiedAt: new Date('2026-01-01T00:00:00Z') });
const resolver: SecretResolver = { resolve: async () => 'not-a-real-key' };

class FakeImmich {
  readonly assets = new Map<string, { ownerId: string; bytes: Uint8Array; sha1: string }>();
  uploads = 0; mode: 'ok' | 'timeout' | 'mismatch' | 'wrong-account' | 'five-hundred' = 'ok';
  private server = createServer((request, response) => { void this.route(request, response); });
  async start(): Promise<string> { await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve)); const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('fake server did not bind'); return `http://127.0.0.1:${address.port}`; }
  async stop(): Promise<void> { await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve())); }
  private send(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void { response.writeHead(status, { 'content-type': 'application/json', ...headers }); response.end(JSON.stringify(body)); }
  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://fake').pathname;
    if (path === '/api/server/ping') return this.send(response, 200, { ping: 'pong' });
    if (path === '/api/server/version') return this.send(response, 200, { version: 'unverified-fake' });
    if (path === '/api/users/me') return this.send(response, 200, { id: 'account-a' });
    if (path === '/api/assets' && request.method === 'POST') {
      this.uploads += 1; if (this.mode === 'five-hundred') return this.send(response, 500, { error: 'internal' });
      const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      const assetId = 'asset-1'; this.assets.set(assetId, { ownerId: this.mode === 'wrong-account' ? 'account-b' : 'account-a', bytes, sha1 });
      if (this.mode === 'timeout') return request.socket.destroy();
      return this.send(response, 201, { id: assetId, duplicate: false });
    }
    if (path === '/api/assets/bulk-upload-check') { const id = [...this.assets.keys()][0]; return this.send(response, 200, id ? [{ id }] : []); }
    const match = /^\/api\/assets\/([^/]+)(?:\/(original))?$/.exec(path);
    if (match) { const asset = this.assets.get(match[1]!); if (!asset) return this.send(response, 404, {}); if (match[2] === 'original') { const body = this.mode === 'mismatch' ? new TextEncoder().encode('changed') : asset.bytes; response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(body); return; } return this.send(response, 200, { id: match[1], ownerId: asset.ownerId }); }
    return this.send(response, 404, {});
  }
}

async function setup() { const fake = new FakeImmich(); const baseUrl = await fake.start(); const database = await createTestDatabase(); const migrations = await createMigrationsCopy(); await runMigrations(database.pool, migrations.directory); const userId = randomUUID(); await database.pool.query('INSERT INTO users (id,display_name) VALUES ($1,$2)', [userId, 'Transfer User']); const repository = new TransferRepository(database.pool); const client = new ImmichClient(baseUrl, 'secret://immich/test', resolver); return { fake, database, migrations, userId, repository, client, service: new TransferService(repository, client) }; }

describe('Immich transfer contract fake', () => {
  const fixtures: Array<Awaited<ReturnType<typeof setup>>> = [];
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(async (fixture) => { await fixture.fake.stop(); await fixture.migrations.cleanup(); await fixture.database.cleanup(); })); });
  it('verifies byte readback and persists the verified state', async () => { const fixture = await setup(); fixtures.push(fixture); expect(await fixture.client.connectionTest()).toEqual({ version: 'unverified-fake', userId: 'account-a' }); const transfer = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-a', targetId: 'target-a', sha256 }); const result = await fixture.service.run(transfer.id, local(), 'account-a', 'kura'); expect(result.status).toBe('verified'); expect(result.verifiedAt).toBeInstanceOf(Date); expect(fixture.fake.uploads).toBe(1); });
  it('never authorizes mismatch or wrong account', async () => { const fixture = await setup(); fixtures.push(fixture); fixture.fake.mode = 'mismatch'; const first = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-b', targetId: 'target-a', sha256 }); expect((await fixture.service.run(first.id, local(), 'account-a', 'kura')).status).toBe('mismatch'); fixture.fake.mode = 'wrong-account'; const second = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-c', targetId: 'target-a', sha256 }); expect((await fixture.service.run(second.id, local(), 'account-a', 'kura')).status).toBe('mismatch'); });
  it('reconciles a lost upload response through duplicate lookup without uploading twice', async () => { const fixture = await setup(); fixtures.push(fixture); fixture.fake.mode = 'timeout'; const transfer = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-d', targetId: 'target-a', sha256 }); expect((await fixture.service.run(transfer.id, local(), 'account-a', 'kura')).status).toBe('verified'); expect(fixture.fake.uploads).toBe(1); fixture.fake.mode = 'ok'; expect((await fixture.service.run(transfer.id, local(), 'account-a', 'kura')).status).toBe('verified'); expect(fixture.fake.uploads).toBe(1); });
  it('denies local deletion for each unmet condition', () => { const valid = { verified: true, correctAccount: true, historyCommitted: true, validApproval: true, graceElapsed: true, noReference: true, configGenerationMatches: true, albumComplete: true }; expect(decideLocalDeletion(valid)).toEqual({ allowed: true, reasons: [] }); for (const key of Object.keys(valid) as Array<keyof typeof valid>) { expect(decideLocalDeletion({ ...valid, [key]: false }).allowed).toBe(false); } });
  it('does not expose secret references in upload errors', async () => { const fixture = await setup(); fixtures.push(fixture); fixture.fake.mode = 'five-hundred'; const transfer = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-e', targetId: 'target-a', sha256 }); const result = await fixture.service.run(transfer.id, local(), 'account-a', 'kura'); expect(result.error).not.toContain('not-a-real-key'); expect(result.error).not.toContain('secret://immich/test'); });
});
