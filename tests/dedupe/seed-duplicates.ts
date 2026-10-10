import { createHash, randomUUID } from 'node:crypto';
import type { ManifestAsset } from '../../packages/adapters/src/index.js';
import { sha256Digest } from '../../packages/blobstore/src/index.js';
import type { TestLogin } from '../m4b/api-fixture.js';
import { TEST_CHUNK_SIZE, type MediaFixture } from '../media/fixture.js';

/** A file of a seeded post revision. `sourceAssetId` is the stable id of the file in its post. */
export interface SeedFile {
  sourceAssetId: string;
  name: string;
  mime: string;
  bytes: Buffer;
}

export interface SeedRevision {
  platformPostId: string;
  revisionKey: string;
  title: string;
  /** When the revision was discovered; the newest revision wins in the media list. */
  discoveredAt: string;
  files: SeedFile[];
}

/**
 * Writes one revision of a post with stored files into the history, the way the worker did before D3: the file is
 * imported into the blob store (which keeps one object per owner and checksum and counts the references) and the asset
 * row is marked stored. Calling it twice for the same post with different revision keys gives the duplicate rows of the
 * test VM.
 */
export async function seedRevision(fixture: MediaFixture, login: TestLogin, subscriptionId: string, runId: string, revision: SeedRevision): Promise<{ postId: string; assetIds: string[] }> {
  const { history, blobs, api } = fixture;
  const post = await history.upsertPost({
    userId: login.userId, runId, subscriptionId, platform: 'instagram', adapterId: 'gallery-dl', adapterVersion: '1.32.16',
    creatorPlatformId: 'creator-1', creatorName: 'Creator Eins', platformPostId: revision.platformPostId, revisionKey: revision.revisionKey,
    title: revision.title, sourceUrl: `https://www.instagram.com/p/${revision.platformPostId}/`, publishedAt: null
  });
  await api.pool.query('UPDATE download_posts SET discovered_at = $2 WHERE id = $1', [post.id, revision.discoveredAt]);
  const manifest: ManifestAsset[] = revision.files.map((file, index) => ({
    assetIndex: index, sourceAssetId: file.sourceAssetId, originalName: file.name, mediaType: file.mime, role: 'original', variant: 'original',
    quality: { preset: 'BEST_AVAILABLE', width: null, height: null, container: null }, declaredBytes: null, completeness: 'complete'
  }));
  const records = await history.upsertAssets(post.id, login.userId, manifest);
  const assetIds: string[] = [];
  for (const file of revision.files) {
    const record = records.find((candidate) => candidate.sourceAssetId === file.sourceAssetId)!;
    const session = await blobs.beginWrite({ ownerUserId: login.userId });
    for (let offset = 0; offset < file.bytes.length; offset += TEST_CHUNK_SIZE) await blobs.append(session, file.bytes.subarray(offset, offset + TEST_CHUNK_SIZE));
    const stored = await blobs.finalize(session, sha256Digest(file.bytes));
    await history.markAssetStored(record.id, {
      sha256: createHash('sha256').update(file.bytes).digest('hex'), sha1: createHash('sha1').update(file.bytes).digest('hex'),
      byteSize: file.bytes.length, blobObjectId: stored.id
    });
    assetIds.push(record.id);
  }
  await history.setPostState(post.id, 'stored', true);
  return { postId: post.id, assetIds };
}

export const newRevisionKey = (): string => `l-${randomUUID().replaceAll('-', '').slice(0, 24)}`;
