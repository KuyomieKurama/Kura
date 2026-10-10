import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Pool } from 'pg';
import { DatabaseBlobStore, FilesystemBlobStore, sha256Digest, type RangeReadBackend } from '../../packages/blobstore/src/index.js';
import { runMigrations } from '../../packages/storage/src/migrator.js';
import { createMigrationsCopy, createTestDatabase } from '../helpers/database.js';
import { patternBytes } from './fixture.js';

const CHUNK = 1024;
const SIZE = 10 * CHUNK + 300;

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<{ bytes: Buffer; chunks: number[] }> {
  const parts: Buffer[] = [];
  for await (const part of iterable) parts.push(Buffer.from(part));
  return { bytes: Buffer.concat(parts), chunks: parts.map((part) => part.length) };
}

describe('range reads of the blob store', () => {
  let pool: Pool;
  let cleanupDatabase: () => Promise<void>;
  let cleanupMigrations: () => Promise<void>;
  let directory: string;
  let userId: string;
  const content = patternBytes(SIZE);
  const backends: Record<string, { store: RangeReadBackend; objectId: string }> = {};

  beforeAll(async () => {
    const database = await createTestDatabase();
    const migrations = await createMigrationsCopy();
    pool = database.pool;
    cleanupDatabase = database.cleanup;
    cleanupMigrations = migrations.cleanup;
    await runMigrations(pool, migrations.directory);
    userId = randomUUID();
    await pool.query("INSERT INTO users (id, display_name, role, status) VALUES ($1, 'U', 'user', 'active')", [userId]);
    directory = await mkdtemp(join(tmpdir(), 'kura-range-'));

    const stores: Record<string, RangeReadBackend> = {
      database: new DatabaseBlobStore(pool, { quotaBytes: 1024 * 1024, chunkSize: CHUNK }),
      filesystem: new FilesystemBlobStore(directory, 'cas', { quotaBytes: 1024 * 1024, chunkSize: CHUNK })
    };
    for (const [name, store] of Object.entries(stores)) {
      const session = await store.beginWrite({ ownerUserId: userId });
      for (let offset = 0; offset < SIZE; offset += CHUNK) await store.append(session, content.subarray(offset, offset + CHUNK));
      const stored = await store.finalize(session, sha256Digest(content));
      backends[name] = { store, objectId: stored.id };
    }
  });

  afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
    await cleanupMigrations();
    await cleanupDatabase();
  });

  describe.each(['database', 'filesystem'])('%s backend', (name) => {
    const reference = () => ({ id: backends[name]!.objectId, ownerUserId: userId });
    const read = (start: number, end: number) => collect(backends[name]!.store.openReadRange(reference(), start, end));

    it('returns exactly the requested bytes inside one chunk', async () => {
      const { bytes } = await read(5, 99);
      expect(bytes.equals(content.subarray(5, 100))).toBe(true);
    });

    it('returns exactly the requested bytes across chunk boundaries, in pieces no larger than a chunk', async () => {
      const { bytes, chunks } = await read(CHUNK - 10, 3 * CHUNK + 20);
      expect(bytes.equals(content.subarray(CHUNK - 10, 3 * CHUNK + 21))).toBe(true);
      expect(chunks.length).toBeGreaterThan(2);
      expect(Math.max(...chunks)).toBeLessThanOrEqual(CHUNK);
    });

    it('reads the end of the object and a single byte', async () => {
      expect((await read(SIZE - 1, SIZE - 1)).bytes.equals(content.subarray(SIZE - 1))).toBe(true);
      expect((await read(SIZE - 300, SIZE + 5000)).bytes.equals(content.subarray(SIZE - 300))).toBe(true);
    });

    it('reads the whole object', async () => {
      expect((await read(0, SIZE - 1)).bytes.equals(content)).toBe(true);
    });

    it('rejects an invalid range and a foreign owner', async () => {
      await expect(read(5, 2)).rejects.toThrow('Invalid byte range');
      await expect(read(-1, 2)).rejects.toThrow('Invalid byte range');
      await expect(collect(backends[name]!.store.openReadRange({ id: backends[name]!.objectId, ownerUserId: randomUUID() } as never, 0, 9))).rejects.toThrow('Object not found');
    });

    it('does not read the chunks before the range', async () => {
      if (name !== 'database') return;
      const statements: string[] = [];
      const original = pool.query.bind(pool) as (...args: unknown[]) => unknown;
      (pool as unknown as { query: unknown }).query = (...args: unknown[]) => {
        statements.push(String(typeof args[0] === 'string' ? args[0] : (args[0] as { text: string }).text));
        return original(...args);
      };
      try {
        await read(9 * CHUNK + 1, 9 * CHUNK + 50);
      } finally {
        (pool as unknown as { query: unknown }).query = original;
      }
      // One lookup of the chunk sizes, one payload read, plus the lease up and down.
      expect(statements.filter((sql) => sql.includes('SELECT payload'))).toHaveLength(1);
    });
  });

  it('releases the reader lease when the reader stops early', async () => {
    const { store, objectId } = backends.database!;
    const iterator = store.openReadRange({ id: objectId, ownerUserId: userId } as never, 0, SIZE - 1)[Symbol.asyncIterator]();
    await iterator.next();
    const during = await pool.query('SELECT leases FROM blobstore_objects WHERE id=$1', [objectId]);
    expect(during.rows[0].leases).toBe(1);
    await iterator.return?.();
    const after = await pool.query('SELECT leases FROM blobstore_objects WHERE id=$1', [objectId]);
    expect(after.rows[0].leases).toBe(0);
  });
});
