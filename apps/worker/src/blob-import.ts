import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat } from 'node:fs/promises';
import type { StorageBackend } from '@kura/blobstore';
import type { StagedFile } from '@kura/adapters';

/** Largest chunk the blob store accepts (migration 0020: 4 MiB). */
const CHUNK_BYTES = 4 * 1024 * 1024;

export interface ImportedBlob {
  objectId: string;
  sha256: string;
  sha1: string;
  byteSize: number;
}

/** The owner's quota in the blob store is used up. The run must stop safely, not try another place. */
export class QuotaExceededError extends Error {
  constructor() {
    super('Owner quota exceeded');
    this.name = 'QuotaExceededError';
  }
}

/** The staged file is not what the adapter reported. Plan 04, section 6: quarantine, never "done". */
export class ImportRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ImportRejectedError';
  }
}

/**
 * The trusted import step (docs/planning/04, section 7): the adapter's report is not believed. The file is
 * checked again (regular file, announced size), streamed into the blob store in chunks while the SHA-256
 * is computed on exactly the bytes that are written, and compared with what the adapter staged. The blob
 * store finalizes only if the digest matches the bytes it received. Memory use is one chunk.
 */
export async function importStagedFile(input: {
  blobstore: StorageBackend;
  ownerUserId: string;
  staged: StagedFile;
  signal?: AbortSignal;
}): Promise<ImportedBlob> {
  const { blobstore, ownerUserId, staged, signal } = input;
  const info = await lstat(staged.absolutePath);
  if (!info.isFile() || info.isSymbolicLink()) throw new ImportRejectedError('Staged file is not a regular file');
  if (info.size !== staged.byteLength) throw new ImportRejectedError('Staged file size differs from the reported size');

  const session = await blobstore.beginWrite({ ownerUserId });
  try {
    const sha256 = createHash('sha256');
    const sha1 = createHash('sha1');
    let byteSize = 0;
    for await (const chunk of createReadStream(staged.absolutePath, { highWaterMark: CHUNK_BYTES, signal })) {
      const bytes = chunk as Buffer;
      sha256.update(bytes);
      sha1.update(bytes);
      byteSize += bytes.length;
      await blobstore.append(session, bytes);
    }
    const digest = sha256.digest();
    if (byteSize !== staged.byteLength || digest.toString('hex') !== staged.sha256) {
      throw new ImportRejectedError('Content differs from what the adapter reported');
    }
    const stored = await blobstore.finalize(session, { algorithm: 'sha256', value: new Uint8Array(digest) });
    return { objectId: stored.id, sha256: digest.toString('hex'), sha1: sha1.digest('hex'), byteSize };
  } catch (error) {
    await blobstore.abort(session).catch(() => undefined);
    if (error instanceof Error && /quota exceeded/i.test(error.message)) throw new QuotaExceededError();
    throw error;
  }
}
