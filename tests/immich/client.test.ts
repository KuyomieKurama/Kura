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
  uploads = 0; mode: 'ok' | 'timeout' | 'mismatch' | 'wrong-account' | 'five-hundred' | 'duplicate' | 'truncated' | 'slow' = 'ok';
  private receivedFirstChunkResolve: (() => void) | undefined;
  readonly receivedFirstChunk = new Promise<void>((resolve) => { this.receivedFirstChunkResolve = resolve; });
  private server = createServer((request, response) => { void this.route(request, response); });
  async start(): Promise<string> { await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve)); const address = this.server.address(); if (!address || typeof address === 'string') throw new Error('fake server did not bind'); return `http://127.0.0.1:${address.port}`; }
  async stop(): Promise<void> { await new Promise<void>((resolve, reject) => this.server.close((error) => error ? reject(error) : resolve())); }
  private send(response: ServerResponse, status: number, body: unknown): void { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(body)); }
  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    const path = new URL(request.url ?? '/', 'http://fake').pathname;
    if (path === '/api/server/ping') return this.send(response, 200, { ping: 'pong' });
    if (path === '/api/server/version') return this.send(response, 200, { major: 3, minor: 2, patch: 1, prerelease: null });
    if (path === '/api/users/me') return this.send(response, 200, { id: 'account-a' });
    if (path === '/api/assets' && request.method === 'POST') {
      this.uploads += 1; if (this.mode === 'five-hundred') return this.send(response, 500, { error: 'internal' });
      if (this.mode === 'truncated') { request.once('data', () => { this.receivedFirstChunkResolve?.(); request.socket.destroy(); }); return; }
      const chunks: Buffer[] = []; for await (const chunk of request) { this.receivedFirstChunkResolve?.(); chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)); }
      const assetId = 'asset-1'; this.assets.set(assetId, { ownerId: this.mode === 'wrong-account' ? 'account-b' : 'account-a', bytes, sha1 });
      if (this.mode === 'timeout') return request.socket.destroy();
      if (this.mode === 'slow') await new Promise((resolve) => setTimeout(resolve, 30));
      return this.send(response, 201, { id: assetId, duplicate: this.mode === 'duplicate' });
    }
    if (path === '/api/assets/bulk-upload-check') { const id = [...this.assets.keys()][0]; return this.send(response, 200, { results: id ? [{ assetId: id }] : [] }); }
    const match = /^\/api\/assets\/([^/]+)(?:\/(original))?$/.exec(path);
    if (match) { const asset = this.assets.get(match[1]!); if (!asset) return this.send(response, 404, {}); if (match[2] === 'original') { const body = this.mode === 'mismatch' ? new TextEncoder().encode('changed') : asset.bytes; response.writeHead(200, { 'content-type': 'application/octet-stream' }); response.end(body); return; } return this.send(response, 200, { id: match[1], ownerId: asset.ownerId }); }
    return this.send(response, 404, {});
  }
}

async function setup() { const fake = new FakeImmich(); const baseUrl = await fake.start(); const database = await createTestDatabase(); const migrations = await createMigrationsCopy(); await runMigrations(database.pool, migrations.directory); const userId = randomUUID(); await database.pool.query('INSERT INTO users (id,display_name) VALUES ($1,$2)', [userId, 'Transfer User']); const repository = new TransferRepository(database.pool); const client = new ImmichClient(baseUrl, 'secret://immich/test', resolver); return { fake, database, migrations, userId, repository, client, service: new TransferService(repository, client) }; }
const run = (fixture: Awaited<ReturnType<typeof setup>>, id: string, object = local()) => fixture.service.run(id, object, 'account-a', 'kura', 7);

describe('Immich transfer contract fake', () => {
  const fixtures: Array<Awaited<ReturnType<typeof setup>>> = [];
  afterEach(async () => { await Promise.all(fixtures.splice(0).map(async (fixture) => { await fixture.fake.stop(); await fixture.migrations.cleanup(); await fixture.database.cleanup(); })); });
  it('streams multipart input instead of consuming it before the server receives bytes', async () => { const fixture = await setup(); fixtures.push(fixture); let released = false; const gated: LocalObject = { ...local(), bytes: (async function* () { yield new Uint8Array([1]); await fixture.fake.receivedFirstChunk; released = true; yield new Uint8Array([2]); })() }; await fixture.client.upload(gated, 'kura', 'stream-test'); expect(released).toBe(true); });
  it('verifies byte readback and atomically persists account, version, and generation evidence', async () => { const fixture = await setup(); fixtures.push(fixture); expect(await fixture.client.connectionTest()).toEqual({ version: '3.2.1', userId: 'account-a' }); const transfer = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-a', targetId: 'target-a', sha256 }); const result = await run(fixture, transfer.id); expect(result).toMatchObject({ status: 'verified', verifiedServerVersion: '3.2.1', verifiedTargetAccountId: 'account-a', verifiedConnectionGeneration: 7 }); expect(result.verifiedAt).toBeInstanceOf(Date); });
  it('never authorizes mismatch, wrong account, or a changed connection generation', async () => { const fixture = await setup(); fixtures.push(fixture); fixture.fake.mode = 'mismatch'; const first = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-b', targetId: 'target-a', sha256 }); expect((await run(fixture, first.id)).status).toBe('mismatch'); fixture.fake.mode = 'wrong-account'; const second = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-c', targetId: 'target-a', sha256 }); expect((await run(fixture, second.id)).status).toBe('mismatch'); expect(decideLocalDeletion({ verified: true, correctAccount: true, historyCommitted: true, validApproval: true, graceElapsed: true, noReference: true, configGenerationMatches: false, albumComplete: true }).allowed).toBe(false); });
  it('reconciles a lost response using the duplicate check without a second upload', async () => { const fixture = await setup(); fixtures.push(fixture); fixture.fake.mode = 'timeout'; const transfer = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-d', targetId: 'target-a', sha256 }); expect((await run(fixture, transfer.id)).status).toBe('verified'); expect(fixture.fake.uploads).toBe(1); fixture.fake.mode = 'ok'; expect((await run(fixture, transfer.id)).status).toBe('verified'); expect(fixture.fake.uploads).toBe(1); });
  it('handles an explicit duplicate without a second upload', async () => { const fixture = await setup(); fixtures.push(fixture); fixture.fake.mode = 'duplicate'; const transfer = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-duplicate', targetId: 'target-a', sha256 }); expect((await run(fixture, transfer.id)).status).toBe('verified'); expect((await run(fixture, transfer.id)).status).toBe('verified'); expect(fixture.fake.uploads).toBe(1); });
  it('keeps a truncated upload reconciling and accepts a slow response safely', async () => { const fixture = await setup(); fixtures.push(fixture); fixture.fake.mode = 'truncated'; const cut = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-cut', targetId: 'target-a', sha256 }); expect((await run(fixture, cut.id)).status).toBe('reconciling'); fixture.fake.mode = 'slow'; const slow = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-slow', targetId: 'target-a', sha256 }); expect((await run(fixture, slow.id)).status).toBe('verified'); });
  it('denies local deletion for every unmet condition and never exposes a secret', async () => { const valid = { verified: true, correctAccount: true, historyCommitted: true, validApproval: true, graceElapsed: true, noReference: true, configGenerationMatches: true, albumComplete: true }; expect(decideLocalDeletion(valid)).toEqual({ allowed: true, reasons: [] }); for (const key of Object.keys(valid) as Array<keyof typeof valid>) expect(decideLocalDeletion({ ...valid, [key]: false }).allowed).toBe(false); const fixture = await setup(); fixtures.push(fixture); fixture.fake.mode = 'five-hundred'; const transfer = await fixture.repository.create({ userId: fixture.userId, objectId: 'object-e', targetId: 'target-a', sha256 }); const result = await run(fixture, transfer.id); expect(result.error).not.toContain('not-a-real-key'); expect(result.error).not.toContain('secret://immich/test'); });
});
