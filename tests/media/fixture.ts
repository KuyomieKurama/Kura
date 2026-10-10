import { createHash, randomUUID } from 'node:crypto';
import { deflateSync } from 'node:zlib';
import type { ManifestAsset } from '../../packages/adapters/src/index.js';
import { DatabaseBlobStore, sha256Digest } from '../../packages/blobstore/src/index.js';
import { HistoryRepository } from '../../apps/worker/src/history.js';
import { createApiFixture, type ApiFixture, type TestLogin } from '../m4b/api-fixture.js';

/** Small chunks, so that even a few hundred KiB are stored as many chunks in PostgreSQL. */
export const TEST_CHUNK_SIZE = 64 * 1024;

export interface SeedAsset {
  name: string;
  mime: string;
  bytes: Buffer;
  /** Defaults to 'stored'. Other states leave the asset without a blob, like the worker does until the file is imported. */
  state?: 'pending' | 'downloading' | 'verifying' | 'stored' | 'failed';
  postKey?: string;
  postTitle?: string | null;
  postUrl?: string;
}

export interface SeededAsset {
  assetId: string;
  postId: string;
  blobObjectId: string | null;
  sha256: string;
}

export interface MediaFixture {
  api: ApiFixture;
  blobs: DatabaseBlobStore;
  history: HistoryRepository;
  createSubscription: (login: TestLogin, name: string) => Promise<string>;
  /** Starts a history run for the subscription, as the worker does when it claims a queued run. */
  startRun: (login: TestLogin, subscriptionId: string, options?: { jobRunId?: string; finished?: boolean }) => Promise<string>;
  seedAsset: (login: TestLogin, subscriptionId: string, runId: string, asset: SeedAsset) => Promise<SeededAsset>;
  get: (login: TestLogin | null, url: string, headers?: Record<string, string>) => ReturnType<ApiFixture['app']['inject']>;
  cleanup: () => Promise<void>;
}

export async function createMediaFixture(): Promise<MediaFixture> {
  const api = await createApiFixture();
  const blobs = new DatabaseBlobStore(api.pool, { quotaBytes: 256 * 1024 * 1024, chunkSize: TEST_CHUNK_SIZE });
  const history = new HistoryRepository(api.pool);

  const createSubscription: MediaFixture['createSubscription'] = async (login, name) => {
    const created = await api.call(login, 'POST', '/api/v1/subscriptions', { name, targetUrl: `https://example.com/${randomUUID()}` });
    if (created.statusCode !== 201) throw new Error(`subscription not created: ${created.body}`);
    return created.json().subscription.id as string;
  };

  const startRun: MediaFixture['startRun'] = async (login, subscriptionId, options = {}) => {
    const runId = await history.startRun({
      userId: login.userId,
      jobRunId: options.jobRunId ?? randomUUID(),
      leaseGeneration: 1,
      subscriptionId,
      subscriptionName: 'Test',
      sourceUrl: 'https://example.com/profile',
      triggerKind: 'manual'
    });
    await history.updateRun(runId, { state: options.finished ? 'stored' : 'downloading', platform: 'direct_media', adapterId: 'direct-url', adapterVersion: '1', finished: options.finished });
    return runId;
  };

  const seedAsset: MediaFixture['seedAsset'] = async (login, subscriptionId, runId, asset) => {
    const postKey = asset.postKey ?? randomUUID();
    const post = await history.upsertPost({
      userId: login.userId,
      runId,
      subscriptionId,
      platform: 'direct_media',
      adapterId: 'direct-url',
      adapterVersion: '1',
      creatorPlatformId: 'creator-1',
      creatorName: 'Creator Eins',
      platformPostId: `${postKey}-${login.userId}`,
      revisionKey: '1',
      title: asset.postTitle === undefined ? `Beitrag ${postKey}` : asset.postTitle,
      sourceUrl: asset.postUrl ?? `https://example.com/post/${postKey}?signature=secret`,
      publishedAt: null
    });
    const manifestAsset: ManifestAsset = {
      assetIndex: nextAssetIndex(postKey, login.userId),
      sourceAssetId: `src-${randomUUID()}`,
      originalName: asset.name,
      mediaType: asset.mime,
      role: 'original',
      variant: 'original',
      quality: { preset: 'BEST_AVAILABLE', width: null, height: null, container: null },
      declaredBytes: null,
      completeness: 'complete'
    };
    const records = await history.upsertAssets(post.id, login.userId, [manifestAsset]);
    const record = records.find((candidate) => candidate.sourceAssetId === manifestAsset.sourceAssetId);

    const sha256 = createHash('sha256').update(asset.bytes).digest('hex');
    const state = asset.state ?? 'stored';
    if (state === 'stored') {
      const session = await blobs.beginWrite({ ownerUserId: login.userId });
      for (let offset = 0; offset < asset.bytes.length; offset += TEST_CHUNK_SIZE) {
        await blobs.append(session, asset.bytes.subarray(offset, offset + TEST_CHUNK_SIZE));
      }
      const stored = await blobs.finalize(session, sha256Digest(asset.bytes));
      await history.markAssetStored(record!.id, {
        sha256, sha1: createHash('sha1').update(asset.bytes).digest('hex'), byteSize: asset.bytes.length, blobObjectId: stored.id
      });
      return { assetId: record!.id, postId: post.id, blobObjectId: stored.id, sha256 };
    }
    if (state === 'downloading') await history.startAsset(record!.id);
    if (state === 'verifying') await history.markAssetVerifying(record!.id);
    if (state === 'failed') await history.markAssetFailed(record!.id, 'DOWNLOAD_FAILED', 'Die Datei konnte nicht geladen werden.');
    return { assetId: record!.id, postId: post.id, blobObjectId: null, sha256 };
  };

  // Asset indexes are unique per post; count what the post already has.
  const indexes = new Map<string, number>();
  function nextAssetIndex(postKey: string, userId: string): number {
    const key = `${userId}:${postKey}`;
    const next = indexes.get(key) ?? 0;
    indexes.set(key, next + 1);
    return next;
  }

  return {
    api,
    blobs,
    history,
    createSubscription,
    startRun,
    seedAsset,
    get: (login, url, headers = {}) => api.app.inject({
      method: 'GET',
      url,
      headers: { host: 'localhost', ...(login ? { cookie: login.cookie } : {}), ...headers }
    }),
    cleanup: () => api.cleanup()
  };
}

/** A tiny but real PNG (1x1 pixel), unique per `seed` through a text chunk so each file has its own checksum. */
export function tinyPng(seed: string): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    return c >>> 0;
  });
  const crc = (buffer: Buffer) => {
    let c = 0xffffffff;
    for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff]! ^ (c >>> 8);
    return (c ^ 0xffffffff) >>> 0;
  };
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const checksum = Buffer.alloc(4);
    checksum.writeUInt32BE(crc(body));
    return Buffer.concat([length, body, checksum]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(1, 0);
  header.writeUInt32BE(1, 4);
  header.set([8, 2, 0, 0, 0], 8);
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('tEXt', Buffer.from(`Comment\0${seed}`, 'latin1')),
    chunk('IDAT', deflateSync(Buffer.from([0, 120, 80, 200]))),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** Deterministic pseudo-random bytes, so a range of the file can be compared exactly. */
export function patternBytes(length: number): Buffer {
  const buffer = Buffer.alloc(length);
  for (let index = 0; index < length; index += 1) buffer[index] = (index * 31 + (index >> 8)) & 0xff;
  return buffer;
}
