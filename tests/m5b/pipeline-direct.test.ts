import { createHash } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import type { OwnedObjectRef } from '../../packages/blobstore/src/index.js';
import { createPipelineFixture, jpeg, type PipelineFixture } from './fixture.js';

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

async function readBlob(subject: PipelineFixture, ownerUserId: string, objectId: string): Promise<Buffer> {
  const parts: Uint8Array[] = [];
  for await (const chunk of subject.blobstore.openRead({ id: objectId, ownerUserId } as OwnedObjectRef)) parts.push(chunk);
  return Buffer.concat(parts);
}

describe('download pipeline with the direct URL adapter (real PostgreSQL, local test server, fake Immich)', () => {
  const open: PipelineFixture[] = [];
  const start = async (...args: Parameters<typeof createPipelineFixture>) => {
    const subject = await createPipelineFixture(...args);
    open.push(subject);
    return subject;
  };
  afterEach(async () => {
    await Promise.all(open.splice(0).map((subject) => subject.cleanup()));
  });

  it('downloads, stores, records history and hands the file to Immich while keeping the local original', async () => {
    const subject = await start();
    const bytes = jpeg('first');
    subject.files.serve('/pics/cat.jpg', { body: bytes, contentType: 'image/jpeg', etag: '"v1"' });
    const userId = await subject.newUser('Alice');
    await subject.connectImmich(userId);
    const subscription = await subject.subscribe(userId, subject.files.url('/pics/cat.jpg?token=secret-signature'), 'Cats');

    const { lease, outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome).toEqual({ result: 'stored' });
    // The blob is in the store, owned by the user, with exactly the served bytes.
    const [asset] = await subject.rows<{ id: string; state: string; sha256: string; byte_size: string; blob_object_id: string; handover_state: string; transfer_id: string; original_name: string; media_type: string }>(
      'SELECT * FROM download_assets'
    );
    expect(asset).toMatchObject({ state: 'stored', sha256: sha256(bytes), media_type: 'image/jpeg', original_name: 'cat.jpg', handover_state: 'verified' });
    expect(Number(asset!.byte_size)).toBe(bytes.length);
    expect(await readBlob(subject, userId, asset!.blob_object_id)).toEqual(bytes);

    // History: run, post, asset. The signed query of the URL did not reach it.
    const [run] = await subject.rows<Record<string, unknown>>('SELECT * FROM download_runs');
    expect(run).toMatchObject({
      user_id: userId, job_run_id: lease.runId, lease_generation: 1, subscription_name: 'Cats', trigger_kind: 'manual',
      platform: 'direct_media', adapter_id: 'direct-url', state: 'stored', posts_found: 1, posts_skipped: 0, assets_stored: 1, assets_failed: 0
    });
    expect(run!.source_url).toBe(subject.files.url('/pics/cat.jpg'));
    expect(JSON.stringify(await subject.rows('SELECT * FROM download_posts'))).not.toContain('secret-signature');
    const [post] = await subject.rows<Record<string, unknown>>('SELECT * FROM download_posts');
    expect(post).toMatchObject({ state: 'stored', discovery_complete: true, platform: 'direct_media', adapter_id: 'direct-url' });

    // Immich got the same bytes through the existing transfer service, with a verified proof.
    expect(subject.immich.uploads).toBe(1);
    expect([...subject.immich.assets.values()][0]).toEqual(bytes);
    const [transfer] = await subject.rows<Record<string, unknown>>('SELECT * FROM immich_transfers');
    expect(transfer).toMatchObject({ id: asset!.transfer_id, status: 'verified', object_id: asset!.blob_object_id, own_sha256: sha256(bytes), user_id: userId });
    expect(Number(transfer!.verified_byte_size)).toBe(bytes.length);

    // The local original is still there; the queue run is finished; the target was validated.
    expect(await readBlob(subject, userId, asset!.blob_object_id)).toEqual(bytes);
    expect((await subject.rows('SELECT state FROM job_runs'))[0]).toEqual({ state: 'succeeded' });
    expect((await subject.subscriptions.getSubscription(userId, subscription.id)).targetState).toBe('valid');
    const [sync] = await subject.rows<Record<string, unknown>>('SELECT * FROM subscription_sync_state');
    expect(sync).toMatchObject({ subscription_id: subscription.id, last_seen_revision_key: expect.stringMatching(/^h-/) });
    expect(sync!.checked_through).not.toBeNull();
  });

  it('keeps the history when the subscription and its queue runs are deleted', async () => {
    const subject = await start();
    subject.files.serve('/pics/keep.jpg', { body: jpeg('keep'), contentType: 'image/jpeg' });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, subject.files.url('/pics/keep.jpg'));
    await subject.runOnce(userId, subscription.id);

    await subject.subscriptions.deleteSubscription(userId, subscription.id);

    expect((await subject.rows('SELECT 1 FROM job_runs')).length).toBe(0);
    expect((await subject.rows('SELECT 1 FROM subscriptions')).length).toBe(0);
    expect((await subject.rows('SELECT 1 FROM download_runs')).length).toBe(1);
    expect((await subject.rows('SELECT 1 FROM download_posts WHERE state = $1', ['stored'])).length).toBe(1);
    expect((await subject.rows('SELECT 1 FROM download_assets WHERE state = $1', ['stored'])).length).toBe(1);
    // The blob is untouched as well.
    expect((await subject.rows('SELECT 1 FROM blobstore_objects')).length).toBe(1);
  });

  it('does not download an unchanged, archived post again, but archives a changed revision as a new version', async () => {
    const subject = await start();
    const userId = await subject.newUser();
    await subject.connectImmich(userId);
    subject.files.serve('/pics/a.jpg', { body: jpeg('v1'), contentType: 'image/jpeg', etag: '"v1"' });
    const subscription = await subject.subscribe(userId, subject.files.url('/pics/a.jpg'));

    await subject.runOnce(userId, subscription.id);
    const [before] = await subject.rows<{ stored_at: Date; attempts: number }>('SELECT stored_at, attempts FROM download_assets');

    subject.advance(3600);
    const second = await subject.runOnce(userId, subscription.id);
    expect(second.outcome).toEqual({ result: 'stored' });
    const [secondRun] = await subject.rows<Record<string, unknown>>('SELECT * FROM download_runs ORDER BY started_at DESC, id LIMIT 1');
    expect(secondRun).toMatchObject({ posts_found: 1, posts_skipped: 1, assets_stored: 0, state: 'stored' });
    const [after] = await subject.rows<{ stored_at: Date; attempts: number }>('SELECT stored_at, attempts FROM download_assets');
    expect(after).toEqual(before);
    expect(subject.immich.uploads).toBe(1);

    // The source changes: a new revision is a new version; the old row and checksum stay.
    subject.files.serve('/pics/a.jpg', { body: jpeg('v2'), contentType: 'image/jpeg', etag: '"v2"' });
    subject.advance(3600);
    await subject.runOnce(userId, subscription.id);
    const assets = await subject.rows<{ sha256: string }>('SELECT sha256 FROM download_assets ORDER BY stored_at');
    expect(assets.map((asset) => asset.sha256)).toEqual([sha256(jpeg('v1')), sha256(jpeg('v2'))]);
    expect((await subject.rows('SELECT 1 FROM download_posts')).length).toBe(2);
    expect(subject.immich.uploads).toBe(2);
  });

  it('records a user without an Immich connection as such and still stores the file', async () => {
    const subject = await start();
    subject.files.serve('/pics/b.jpg', { body: jpeg('b'), contentType: 'image/jpeg' });
    const userId = await subject.newUser();
    const subscription = await subject.subscribe(userId, subject.files.url('/pics/b.jpg'));

    const { outcome } = await subject.runOnce(userId, subscription.id);

    expect(outcome.result).toBe('stored');
    expect(await subject.rows('SELECT state, handover_state, transfer_id FROM download_assets')).toEqual([
      { state: 'stored', handover_state: 'no_connection', transfer_id: null }
    ]);
    expect(subject.immich.uploads).toBe(0);
  });

  it('leaves an uncertain Immich upload uncertain and keeps the local original', async () => {
    const subject = await start({ immichMode: 'uncertain' });
    subject.files.serve('/pics/c.jpg', { body: jpeg('c'), contentType: 'image/jpeg' });
    const userId = await subject.newUser();
    await subject.connectImmich(userId);
    const subscription = await subject.subscribe(userId, subject.files.url('/pics/c.jpg'));

    const { outcome } = await subject.runOnce(userId, subscription.id);

    // The download succeeded; only the handover is uncertain.
    expect(outcome.result).toBe('stored');
    const [asset] = await subject.rows<{ state: string; handover_state: string; blob_object_id: string }>('SELECT * FROM download_assets');
    expect(asset).toMatchObject({ state: 'stored', handover_state: 'reconciling' });
    expect((await subject.rows('SELECT status FROM immich_transfers'))).toEqual([{ status: 'reconciling' }]);
    expect((await readBlob(subject, userId, asset!.blob_object_id)).length).toBeGreaterThan(0);
  });

  it('never calls an Immich readback mismatch a success', async () => {
    const subject = await start({ immichMode: 'corrupt' });
    subject.files.serve('/pics/d.jpg', { body: jpeg('d'), contentType: 'image/jpeg' });
    const userId = await subject.newUser();
    await subject.connectImmich(userId);
    const subscription = await subject.subscribe(userId, subject.files.url('/pics/d.jpg'));

    await subject.runOnce(userId, subscription.id);

    expect(await subject.rows('SELECT handover_state FROM download_assets')).toEqual([{ handover_state: 'mismatch' }]);
    expect(await subject.rows('SELECT status FROM immich_transfers')).toEqual([{ status: 'mismatch' }]);
    expect((await subject.rows('SELECT 1 FROM blobstore_objects')).length).toBe(1);
  });

  it('retries an earlier uncertain handover on the next run without uploading a second time when it is already there', async () => {
    const subject = await start({ immichMode: 'uncertain' });
    subject.files.serve('/pics/e.jpg', { body: jpeg('e'), contentType: 'image/jpeg', etag: '"e1"' });
    const userId = await subject.newUser();
    await subject.connectImmich(userId);
    const subscription = await subject.subscribe(userId, subject.files.url('/pics/e.jpg'));
    await subject.runOnce(userId, subscription.id);
    expect(await subject.rows('SELECT handover_state FROM download_assets')).toEqual([{ handover_state: 'reconciling' }]);

    subject.immich.mode = 'normal';
    subject.advance(3600);
    await subject.runOnce(userId, subscription.id);

    expect(await subject.rows('SELECT handover_state FROM download_assets')).toEqual([{ handover_state: 'verified' }]);
    expect(await subject.rows('SELECT status FROM immich_transfers')).toEqual([{ status: 'verified' }]);
  });
});
