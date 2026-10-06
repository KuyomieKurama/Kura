import { createServer } from 'node:http';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { DatabaseBlobStore, FilesystemBlobStore, sanitizePathSegment, sha256Digest, type DirectHttpFetchPort } from '../../packages/blobstore/src/index.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createTestDatabase } from '../helpers/database.js';

const ownerA = randomUUID();
const ownerB = randomUUID();
const collect = async (stream: AsyncIterable<Uint8Array>): Promise<Buffer> => {
  const chunks: Uint8Array[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return Buffer.concat(chunks);
};

function bytes(size: number): Uint8Array {
  const result = new Uint8Array(size);
  for (let index = 0; index < size; index++) result[index] = index % 251;
  return result;
}

const smallLargeFileBytes = 256 * 1024 * 1024;
const largeChunkBytes = 1024 * 1024;
function repeatedDigest(total: number, chunkSize: number): { algorithm: 'sha256'; value: Uint8Array } {
  const hash = createHash('sha256'); const chunk = bytes(chunkSize);
  for (let written = 0; written < total; written += chunk.length) hash.update(chunk);
  return { algorithm: 'sha256', value: new Uint8Array(hash.digest()) };
}
async function writeAndHashLarge(store: FilesystemBlobStore | DatabaseBlobStore, ownerUserId: string, total = smallLargeFileBytes): Promise<void> {
  const write = await store.beginWrite({ ownerUserId }); const chunk = bytes(largeChunkBytes); const digest = repeatedDigest(total, largeChunkBytes);
  for (let written = 0; written < total; written += chunk.length) await store.append(write, chunk);
  const stored = await store.finalize(write, digest); const hash = createHash('sha256'); let received = 0;
  for await (const part of store.openRead(stored)) { hash.update(part); received += part.length; }
  expect(received).toBe(total); expect(new Uint8Array(hash.digest())).toEqual(digest.value);
  expect(process.memoryUsage().heapUsed).toBeLessThan(128 * 1024 * 1024);
}

describe('filesystem blobstore', () => {
  const roots: string[] = [];
  afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

  it('streams CAS bytes, deduplicates per owner, protects reads, and aborts invisibly', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kura-blobstore-')); roots.push(root);
    const store = new FilesystemBlobStore(root, 'cas', { quotaBytes: 1024, chunkSize: 16 });
    const source = bytes(32); const digest = sha256Digest(source);
    const first = await store.beginWrite({ ownerUserId: ownerA });
    await store.append(first, source.subarray(0, 16)); await store.append(first, source.subarray(16));
    const stored = await store.finalize(first, digest);
    expect(await collect(store.openRead(stored))).toEqual(Buffer.from(source));
    await expect(collect(store.openRead({ id: stored.id, ownerUserId: ownerB }))).rejects.toThrow('Object not found');
    const duplicate = await store.beginWrite({ ownerUserId: ownerA });
    await store.append(duplicate, source.subarray(0, 16)); await store.append(duplicate, source.subarray(16));
    expect((await store.finalize(duplicate, digest)).id).toBe(stored.id);
    const aborted = await store.beginWrite({ ownerUserId: ownerA }); await store.append(aborted, bytes(8)); await store.abort(aborted);
    await expect(store.stat({ id: aborted.id, ownerUserId: ownerA })).rejects.toThrow('Object not found');
  });

  it('rejects hostile paths and enforces quota before committing data', async () => {
    for (const path of ['../escape', '/absolute', 'NUL', 'a/b', 'C:drive', 'x\0y']) expect(() => sanitizePathSegment(path)).toThrow();
    const root = await mkdtemp(join(tmpdir(), 'kura-blobstore-')); roots.push(root);
    const store = new FilesystemBlobStore(root, 'template', { quotaBytes: 8, chunkSize: 8 });
    const write = await store.beginWrite({ ownerUserId: ownerA });
    await store.append(write, bytes(8));
    await expect(store.append(write, bytes(1))).rejects.toThrow('Owner quota exceeded');
    await store.abort(write);
  });

  it('marks deletion pending while a reader lease is active and completes it afterwards', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kura-blobstore-')); roots.push(root);
    const store = new FilesystemBlobStore(root, 'cas', { quotaBytes: 64, chunkSize: 16 });
    const source = bytes(16); const write = await store.beginWrite({ ownerUserId: ownerA });
    await store.append(write, source); const stored = await store.finalize(write, sha256Digest(source));
    const reader = store.openRead(stored)[Symbol.asyncIterator](); await reader.next();
    expect(await store.remove(stored, { id: 'permit' })).toEqual({ removed: false });
    await reader.return?.();
    expect(await store.remove(stored, { id: 'permit' })).toEqual({ removed: true });
  });

  it('refuses a target path that is redirected through a symlink', async () => {
    const root = await mkdtemp(join(tmpdir(), 'kura-blobstore-')); roots.push(root);
    const store = new FilesystemBlobStore(root, 'cas', { quotaBytes: 64, chunkSize: 16 });
    const write = await store.beginWrite({ ownerUserId: ownerA }); await store.append(write, bytes(16));
    await mkdir(join(root, 'owners'), { recursive: true }); await symlink('/tmp', join(root, 'owners', ownerA));
    await expect(store.finalize(write, sha256Digest(bytes(16)))).rejects.toThrow('Storage path contains symlink');
    await store.abort(write);
  });

  it('roundtrips a 256 MiB generated stream below the heap ceiling', async () => {
    const root = await mkdtemp(join(process.cwd(), '.blobstore-test-')); roots.push(root);
    await writeAndHashLarge(new FilesystemBlobStore(root, 'cas', { quotaBytes: smallLargeFileBytes + largeChunkBytes, chunkSize: largeChunkBytes }), ownerA);
  }, 120_000);
});

describe('database blobstore', () => {
  it('keeps chunks invisible until finalization, enforces owner isolation, and roundtrips streamed bytes', async () => {
    const database = await createTestDatabase();
    try {
      await runMigrations(database.pool, join(process.cwd(), 'migrations'));
      await database.pool.query('INSERT INTO users (id, display_name) VALUES ($1, $2), ($3, $4)', [ownerA, 'A', ownerB, 'B']);
      const store = new DatabaseBlobStore(database.pool, { quotaBytes: 1024, chunkSize: 16 });
      const source = bytes(48); const write = await store.beginWrite({ ownerUserId: ownerA });
      for (let index = 0; index < source.length; index += 16) await store.append(write, source.subarray(index, index + 16));
      expect(await database.pool.query('SELECT count(*)::int AS count FROM blobstore_objects')).toMatchObject({ rows: [{ count: 0 }] });
      const stored = await store.finalize(write, sha256Digest(source));
      expect(await collect(store.openRead(stored))).toEqual(Buffer.from(source));
      await expect(collect(store.openRead({ id: stored.id, ownerUserId: ownerB }))).rejects.toThrow('Object not found');
      const wrong = await store.beginWrite({ ownerUserId: ownerA }); await store.append(wrong, bytes(16));
      await expect(store.finalize(wrong, sha256Digest(bytes(15)))).rejects.toThrow('Digest mismatch');
      await store.abort(wrong);
    } finally { await database.cleanup(); }
  });

  it('serializes quota use and completes pending deletion after a leased reader closes', async () => {
    const database = await createTestDatabase();
    try {
      await runMigrations(database.pool, join(process.cwd(), 'migrations'));
      await database.pool.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [ownerA, 'A']);
      const store = new DatabaseBlobStore(database.pool, { quotaBytes: 16, chunkSize: 16 });
      const first = await store.beginWrite({ ownerUserId: ownerA }); const second = await store.beginWrite({ ownerUserId: ownerA });
      await store.append(first, bytes(16)); await expect(store.append(second, bytes(1))).rejects.toThrow('Owner quota exceeded'); await store.abort(second);
      const stored = await store.finalize(first, sha256Digest(bytes(16)));
      const reader = store.openRead(stored)[Symbol.asyncIterator](); await reader.next();
      expect(await store.remove(stored, { id: 'permit' })).toEqual({ removed: false });
      await reader.return?.();
      expect(await store.remove(stored, { id: 'permit' })).toEqual({ removed: true });
    } finally { await database.cleanup(); }
  });

  it('roundtrips a 256 MiB generated database stream below the heap ceiling', async () => {
    const database = await createTestDatabase();
    try {
      await runMigrations(database.pool, join(process.cwd(), 'migrations'));
      await database.pool.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [ownerA, 'A']);
      await writeAndHashLarge(new DatabaseBlobStore(database.pool, { quotaBytes: smallLargeFileBytes + largeChunkBytes, chunkSize: largeChunkBytes }), ownerA);
    } finally { await database.cleanup(); }
  }, 120_000);

  it.skipIf(!process.env.KURA_BIG_FILE_GIB)('runs the optional GiB-scale stream when KURA_BIG_FILE_GIB is set', async () => {
    const database = await createTestDatabase(); const gib = Number(process.env.KURA_BIG_FILE_GIB);
    try {
      await runMigrations(database.pool, join(process.cwd(), 'migrations'));
      await database.pool.query('INSERT INTO users (id, display_name) VALUES ($1, $2)', [ownerA, 'A']);
      await writeAndHashLarge(new DatabaseBlobStore(database.pool, { quotaBytes: gib * 1024 ** 3 + largeChunkBytes, chunkSize: largeChunkBytes }), ownerA, gib * 1024 ** 3);
    } finally { await database.cleanup(); }
  }, 1_800_000);
});

describe('direct HTTP fetch port', () => {
  it('accepts a local fake HTTP source while leaving egress policy to its caller', async () => {
    const server = createServer((_request, response) => { response.end('local-fake-body'); });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
    try {
      const address = server.address(); if (!address || typeof address === 'string') throw new Error('Local fake server did not bind');
      const port: DirectHttpFetchPort = { async fetch(url) { const response = await fetch(url); return (async function* () { yield new Uint8Array(await response.arrayBuffer()); })(); } };
      expect(await collect(await port.fetch(new URL(`http://127.0.0.1:${address.port}/blob`)))).toEqual(Buffer.from('local-fake-body'));
    } finally { await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())); }
  });
});
