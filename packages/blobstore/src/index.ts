import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, realpath, rename, rm, stat as fileStat, lstat, readdir } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Pool } from 'pg';

// Kept structurally identical to packages/storage/src/ports.ts so this package
// implements the established storage contract without changing its owner lane.
export interface WriteContext { ownerUserId: string; }
export interface WriteSession { id: string; }
export interface Digest { algorithm: 'sha256'; value: Uint8Array; }
export interface ObjectRef { id: string; }
export interface ObjectStat { size: number; }
export interface DeletionPermit { id: string; }
export interface StoredObject { id: string; }
export interface RemovalResult { removed: boolean; }
export interface StorageBackend {
  beginWrite(context: WriteContext): Promise<WriteSession>;
  append(session: WriteSession, chunk: Uint8Array): Promise<void>;
  finalize(session: WriteSession, digest: Digest): Promise<StoredObject>;
  openRead(object: ObjectRef): AsyncIterable<Uint8Array>;
  stat(object: ObjectRef): Promise<ObjectStat>;
  remove(object: ObjectRef, permit: DeletionPermit): Promise<RemovalResult>;
  abort(session: WriteSession): Promise<void>;
}

export type StorageLayout = 'cas' | 'template';
export interface OwnedObjectRef extends ObjectRef { ownerUserId: string; }
export interface OwnedStoredObject extends StoredObject { ownerUserId: string; digest: Digest; size: number; }
export interface BlobstoreWriteSession extends WriteSession { ownerUserId: string; }
export interface StorageMigrationPort { migrate(source: StorageBackend, target: StorageBackend): Promise<void>; }
export interface DirectHttpFetchPort { fetch(url: URL, signal?: AbortSignal): Promise<AsyncIterable<Uint8Array>>; }
export interface BlobstoreOptions { quotaBytes: number; chunkSize?: number; stagingTtlMs?: number; }

const hex = (digest: Uint8Array) => Buffer.from(digest).toString('hex');
const digestBytes = (value: Buffer) => new Uint8Array(value);
const sha256 = (value: Uint8Array) => createHash('sha256').update(value).digest();
const assertDigest = (digest: Digest): void => {
  if (digest.algorithm !== 'sha256' || digest.value.length !== 32) throw new Error('Only 32-byte SHA-256 digests are accepted');
};
const assertChunk = (chunk: Uint8Array, chunkSize: number): void => {
  if (chunk.length === 0 || chunk.length > chunkSize) throw new Error(`Chunk must be between 1 and ${chunkSize} bytes`);
};

/** Rejects unsafe path segments before they ever reach the filesystem. */
export function sanitizePathSegment(value: string): string {
  const normalized = value.normalize('NFC').trim();
  const containsControl = [...normalized].some((character) => character.charCodeAt(0) < 32);
  if (!normalized || normalized === '.' || normalized === '..' || containsControl || normalized.includes('/') || normalized.includes('\\') || isAbsolute(normalized) || /^[a-zA-Z]:/.test(normalized)) throw new Error('Unsafe storage path segment');
  const clean = normalized.replace(/[<>:"|?*]/g, '_').replace(/[. ]+$/g, '');
  if (!clean || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(clean)) throw new Error('Unsafe Windows-reserved storage path segment');
  return clean.slice(0, 120);
}

interface FsWrite { ownerUserId: string; path: string; hash: ReturnType<typeof createHash>; size: number; }
interface FsObject { ownerUserId: string; path: string; size: number; digest: string; leases: number; refs: number; deletePending: boolean; }

/** Filesystem backend with per-owner CAS or sanitized template paths. */
export class FilesystemBlobStore implements StorageBackend {
  private readonly writes = new Map<string, FsWrite>();
  private readonly objects = new Map<string, FsObject>();
  private readonly usedBytes = new Map<string, number>();
  private readonly chunkSize: number;
  private readonly stagingTtlMs: number;
  private initialized = false;

  constructor(private readonly root: string, private readonly layout: StorageLayout, private readonly options: BlobstoreOptions) {
    this.chunkSize = options.chunkSize ?? 4 * 1024 * 1024;
    this.stagingTtlMs = options.stagingTtlMs ?? 60 * 60 * 1000;
  }

  private async init(): Promise<void> {
    if (this.initialized) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const actualRoot = await realpath(this.root);
    if (actualRoot !== resolve(this.root)) throw new Error('Storage root must not be a symlink');
    await mkdir(join(this.root, '.staging'), { recursive: true, mode: 0o700 });
    this.initialized = true;
  }

  private async safePath(path: string): Promise<string> {
    const absolute = resolve(path);
    if (relative(resolve(this.root), absolute).startsWith(`..${sep}`) || relative(resolve(this.root), absolute) === '..') throw new Error('Storage path escapes root');
    let current = resolve(this.root);
    for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
      current = join(current, part);
      try { if ((await lstat(current)).isSymbolicLink()) throw new Error('Storage path contains symlink'); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
    return absolute;
  }

  async beginWrite(context: WriteContext): Promise<BlobstoreWriteSession> {
    await this.init();
    const ownerUserId = sanitizePathSegment(context.ownerUserId);
    const id = randomUUID();
    const path = await this.safePath(join(this.root, '.staging', `${id}.part`));
    await (await open(path, 'wx', 0o600)).close();
    this.writes.set(id, { ownerUserId, path, hash: createHash('sha256'), size: 0 });
    return { id, ownerUserId };
  }

  async append(session: WriteSession, chunk: Uint8Array): Promise<void> {
    const write = this.writes.get(session.id); if (!write) throw new Error('Unknown or finalized write session');
    assertChunk(chunk, this.chunkSize);
    const activeBytes = [...this.writes.values()].filter((candidate) => candidate.ownerUserId === write.ownerUserId).reduce((total, candidate) => total + candidate.size, 0);
    if ((this.usedBytes.get(write.ownerUserId) ?? 0) + activeBytes + chunk.length > this.options.quotaBytes) throw new Error('Owner quota exceeded');
    const handle = await open(write.path, 'a', 0o600); try { await handle.write(chunk); } finally { await handle.close(); }
    write.hash.update(chunk); write.size += chunk.length;
  }

  async finalize(session: WriteSession, digest: Digest): Promise<OwnedStoredObject> {
    assertDigest(digest); const write = this.writes.get(session.id); if (!write) throw new Error('Unknown or finalized write session');
    const actual = write.hash.digest(); if (!actual.equals(Buffer.from(digest.value))) { await this.abort(session); throw new Error('Digest mismatch'); }
    const hash = hex(digest.value); const existing = [...this.objects.entries()].find(([, object]) => object.ownerUserId === write.ownerUserId && object.digest === hash && !object.deletePending);
    if (existing) { await rm(write.path, { force: true }); this.writes.delete(session.id); existing[1].refs++; return { id: existing[0], ownerUserId: write.ownerUserId, digest, size: existing[1].size }; }
    const id = randomUUID(); const target = this.layout === 'cas'
      ? join(this.root, 'owners', write.ownerUserId, 'objects', hash.slice(0, 2), hash.slice(2, 4), hash)
      : join(this.root, 'owners', write.ownerUserId, 'template', `${hash}-${id}`);
    const safeTarget = await this.safePath(target); await mkdir(dirname(safeTarget), { recursive: true, mode: 0o700 }); await rename(write.path, safeTarget);
    this.writes.delete(session.id); this.objects.set(id, { ownerUserId: write.ownerUserId, path: safeTarget, size: write.size, digest: hash, leases: 0, refs: 1, deletePending: false }); this.usedBytes.set(write.ownerUserId, (this.usedBytes.get(write.ownerUserId) ?? 0) + write.size);
    return { id, ownerUserId: write.ownerUserId, digest, size: write.size };
  }

  async *openRead(object: ObjectRef): AsyncIterable<Uint8Array> {
    const owned = object as OwnedObjectRef; const entry = this.objects.get(owned.id);
    if (!entry || entry.ownerUserId !== owned.ownerUserId || entry.deletePending) throw new Error('Object not found');
    entry.leases++; const handle = await open(entry.path, 'r');
    try { const buffer = Buffer.allocUnsafe(this.chunkSize); let position = 0; for (;;) { const { bytesRead } = await handle.read(buffer, 0, buffer.length, position); if (!bytesRead) break; position += bytesRead; yield new Uint8Array(buffer.subarray(0, bytesRead)); } }
    finally { await handle.close(); entry.leases--; }
  }

  async stat(object: ObjectRef): Promise<ObjectStat> { const owned = object as OwnedObjectRef; const entry = this.objects.get(owned.id); if (!entry || entry.ownerUserId !== owned.ownerUserId || entry.deletePending) throw new Error('Object not found'); return { size: entry.size }; }
  async remove(object: ObjectRef, permit: DeletionPermit): Promise<RemovalResult> { const owned = object as OwnedObjectRef; const entry = this.objects.get(owned.id); if (!entry || entry.ownerUserId !== owned.ownerUserId || !permit.id) throw new Error('Object not found'); entry.deletePending = true; if (entry.leases || entry.refs > 1) return { removed: false }; await rm(entry.path, { force: false }); this.objects.delete(owned.id); this.usedBytes.set(entry.ownerUserId, (this.usedBytes.get(entry.ownerUserId) ?? 0) - entry.size); return { removed: true }; }
  async abort(session: WriteSession): Promise<void> { const write = this.writes.get(session.id); if (!write) return; await rm(write.path, { force: true }); this.writes.delete(session.id); }
  async cleanupStaging(): Promise<number> { await this.init(); let removed = 0; const now = Date.now(); for (const name of await readdir(join(this.root, '.staging'))) { const path = join(this.root, '.staging', basename(name)); if (now - (await fileStat(path)).mtimeMs > this.stagingTtlMs) { await rm(path, { force: true }); removed++; } } return removed; }
}

/** PostgreSQL chunk backend. Tables are created by migration 0020_blobstore.sql. */
export class DatabaseBlobStore implements StorageBackend {
  private readonly chunkSize: number;
  constructor(private readonly pool: Pool, private readonly options: BlobstoreOptions) { this.chunkSize = options.chunkSize ?? 4 * 1024 * 1024; }
  async beginWrite(context: WriteContext): Promise<BlobstoreWriteSession> { const id = randomUUID(); await this.pool.query('INSERT INTO blobstore_writes (id, owner_id, quota_bytes) VALUES ($1, $2, $3)', [id, context.ownerUserId, this.options.quotaBytes]); return { id, ownerUserId: context.ownerUserId }; }
  async append(session: WriteSession, chunk: Uint8Array): Promise<void> { assertChunk(chunk, this.chunkSize); const client = await this.pool.connect(); try { await client.query('BEGIN'); const write = await client.query<{owner_id:string; quota_bytes:string; state:string}>('SELECT owner_id, quota_bytes, state FROM blobstore_writes WHERE id=$1 FOR UPDATE', [session.id]); if (!write.rowCount || write.rows[0].state !== 'writing') throw new Error('Unknown or finalized write session'); const row = write.rows[0]; await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1::text, 0))', [row.owner_id]); const usage = await client.query<{used:string}>("SELECT COALESCE((SELECT SUM(bytes_written) FROM blobstore_writes WHERE owner_id=$1), 0) + COALESCE((SELECT SUM(byte_size) FROM blobstore_objects WHERE owner_id=$1 AND state='available'), 0) AS used", [row.owner_id]); if (BigInt(usage.rows[0].used) + BigInt(chunk.length) > BigInt(row.quota_bytes)) throw new Error('Owner quota exceeded'); const seq = await client.query<{sequence_no:string}>('SELECT COALESCE(MAX(sequence_no), -1) + 1 AS sequence_no FROM blobstore_chunks WHERE write_id=$1', [session.id]); await client.query('INSERT INTO blobstore_chunks (write_id, sequence_no, payload, chunk_sha256) VALUES ($1,$2,$3,$4)', [session.id, seq.rows[0].sequence_no, Buffer.from(chunk), sha256(chunk)]); await client.query('UPDATE blobstore_writes SET bytes_written=bytes_written+$2 WHERE id=$1', [session.id, chunk.length]); await client.query('COMMIT'); } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async finalize(session: WriteSession, digest: Digest): Promise<OwnedStoredObject> { assertDigest(digest); const client = await this.pool.connect(); try { await client.query('BEGIN'); const write = await client.query<{owner_id:string;bytes_written:string;state:string}>('SELECT owner_id, bytes_written, state FROM blobstore_writes WHERE id=$1 FOR UPDATE', [session.id]); if (!write.rowCount || write.rows[0].state !== 'writing') throw new Error('Unknown or finalized write session'); const hash = createHash('sha256'); let sequence = -1; for (;;) { const chunk = await client.query<{sequence_no:string;payload:Buffer}>('SELECT sequence_no, payload FROM blobstore_chunks WHERE write_id=$1 AND sequence_no>$2 ORDER BY sequence_no LIMIT 1', [session.id, sequence]); if (!chunk.rowCount) break; sequence = Number(chunk.rows[0].sequence_no); hash.update(chunk.rows[0].payload); } if (!hash.digest().equals(Buffer.from(digest.value))) throw new Error('Digest mismatch'); const existing = await client.query<{id:string;byte_size:string}>('SELECT id, byte_size FROM blobstore_objects WHERE owner_id=$1 AND sha256=$2 AND state=$3 FOR UPDATE', [write.rows[0].owner_id, Buffer.from(digest.value), 'available']); if (existing.rowCount) { await client.query('UPDATE blobstore_objects SET reference_count=reference_count+1 WHERE id=$1', [existing.rows[0].id]); await client.query('DELETE FROM blobstore_writes WHERE id=$1', [session.id]); await client.query('COMMIT'); return { id: existing.rows[0].id, ownerUserId: write.rows[0].owner_id, digest, size: Number(existing.rows[0].byte_size) }; } const id = randomUUID(); await client.query('INSERT INTO blobstore_objects (id, owner_id, sha256, byte_size, state, reference_count) VALUES ($1,$2,$3,$4,$5,1)', [id, write.rows[0].owner_id, Buffer.from(digest.value), write.rows[0].bytes_written, 'available']); await client.query('INSERT INTO blobstore_object_chunks (object_id, sequence_no, payload, chunk_sha256) SELECT $1, sequence_no, payload, chunk_sha256 FROM blobstore_chunks WHERE write_id=$2 ORDER BY sequence_no', [id, session.id]); await client.query('DELETE FROM blobstore_writes WHERE id=$1', [session.id]); await client.query('COMMIT'); return { id, ownerUserId: write.rows[0].owner_id, digest, size: Number(write.rows[0].bytes_written) }; } catch (error) { await client.query('ROLLBACK'); throw error; } finally { client.release(); } }
  async *openRead(object: ObjectRef): AsyncIterable<Uint8Array> { const owned = object as OwnedObjectRef; const acquired = await this.pool.query('UPDATE blobstore_objects SET leases=leases+1 WHERE id=$1 AND owner_id=$2 AND state=$3 RETURNING id', [owned.id, owned.ownerUserId, 'available']); if (!acquired.rowCount) throw new Error('Object not found'); try { let sequence = -1; for (;;) { const result = await this.pool.query<{sequence_no:string;payload:Buffer}>('SELECT sequence_no, payload FROM blobstore_object_chunks WHERE object_id=$1 AND sequence_no>$2 ORDER BY sequence_no LIMIT 1', [owned.id, sequence]); if (!result.rowCount) break; sequence = Number(result.rows[0].sequence_no); yield new Uint8Array(result.rows[0].payload); } } finally { await this.pool.query('UPDATE blobstore_objects SET leases=GREATEST(leases-1,0) WHERE id=$1', [owned.id]); } }
  async stat(object: ObjectRef): Promise<ObjectStat> { const owned = object as OwnedObjectRef; const result = await this.pool.query<{byte_size:string}>('SELECT byte_size FROM blobstore_objects WHERE id=$1 AND owner_id=$2 AND state=$3', [owned.id, owned.ownerUserId, 'available']); if (!result.rowCount) throw new Error('Object not found'); return { size: Number(result.rows[0].byte_size) }; }
  async remove(object: ObjectRef, permit: DeletionPermit): Promise<RemovalResult> { const owned = object as OwnedObjectRef; if (!permit.id) throw new Error('Deletion permit required'); const result = await this.pool.query<{leases:string;reference_count:string}>('UPDATE blobstore_objects SET state=$3 WHERE id=$1 AND owner_id=$2 AND state IN ($4,$3) RETURNING leases,reference_count', [owned.id, owned.ownerUserId, 'delete_pending', 'available']); if (!result.rowCount || Number(result.rows[0].leases) || Number(result.rows[0].reference_count) > 1) return { removed: false }; await this.pool.query('DELETE FROM blobstore_objects WHERE id=$1 AND owner_id=$2 AND state=$3', [owned.id, owned.ownerUserId, 'delete_pending']); return { removed: true }; }
  async abort(session: WriteSession): Promise<void> { await this.pool.query('DELETE FROM blobstore_writes WHERE id=$1', [session.id]); }
  async cleanupStaging(): Promise<number> { const result = await this.pool.query('DELETE FROM blobstore_writes WHERE expires_at < now()'); return result.rowCount ?? 0; }
}

export function sha256Digest(value: Uint8Array): Digest { return { algorithm: 'sha256', value: digestBytes(sha256(value)) }; }
